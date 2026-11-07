"""Fill missing JP quarterly EPS growth from Kabutan quarterly results.

Yahoo Finance statements for Japanese shares usually expose only the
latest interim quarter and its prior-year comparative, so the
previous-quarter YoY growth (eps_q_prev_yoy_pct) is almost always missing.
Kabutan's per-stock finance page publishes discrete-quarter EPS
(修正1株益) for roughly the last eight quarters, which is enough to compute
both quarterly YoY rates on the same rules as the Yahoo pipeline
(like-for-like quarter one year earlier, positive base required).

This collector only fills fields that are still empty; values already
computed from Yahoo statements are never overwritten. Requests are paced
and the sweep stops immediately if Kabutan rate-limits (HTTP 403/429).
"""
from __future__ import annotations

from calendar import monthrange
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
import json
import os
from pathlib import Path
import re
import threading
import time
import urllib.request
from urllib.error import HTTPError

from jp_fundamentals import _find_year_prior, _yoy, finite, normalize_jp_ticker
from update_data import SimpleTables

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "sector-leaders.json"
SOURCE = "Kabutan quarterly results (discrete quarter EPS YoY)"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                         "AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/126.0 Safari/537.36"}
PERIOD = re.compile(r"(\d{2})\.(\d{2})-(\d{2})")
MIN_INTERVAL = 0.3  # seconds between Kabutan requests, shared across workers

_pace_lock = threading.Lock()
_last_request = [0.0]
_stop = threading.Event()


def _pace():
    with _pace_lock:
        wait = MIN_INTERVAL - (time.monotonic() - _last_request[0])
        if wait > 0:
            time.sleep(wait)
        _last_request[0] = time.monotonic()


def fetch_html(code):
    _pace()
    url = f"https://kabutan.jp/stock/finance?code={code}"
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=25) as response:
        return response.read(3_000_000).decode("utf-8", "replace")


def _eps_value(text):
    cleaned = str(text).replace(",", "").replace("▲", "-").replace("－", "-").strip()
    return finite(cleaned)


def parse_quarterly_eps(html):
    """Return [(period_end_date, eps), ...] newest first, discrete quarters only."""
    parser = SimpleTables()
    parser.feed(html)
    found = {}
    for table in parser.tables:
        if not table:
            continue
        header = table[0]
        if "決算期" not in header[0]:
            continue
        eps_idx = next((i for i, cell in enumerate(header) if "修正1株益" in cell), None)
        if eps_idx is None:
            continue
        for row in table[1:]:
            if len(row) <= eps_idx:
                continue
            match = PERIOD.search(row[0])
            if not match:
                continue
            yy, start_month, end_month = map(int, match.groups())
            if (end_month - start_month) % 12 != 2:
                continue  # not a 3-month quarter (half-year / full-year row)
            eps = _eps_value(row[eps_idx])
            if eps is None:
                continue
            start_year = 2000 + yy
            end_year = start_year + 1 if end_month < start_month else start_year
            end = date(end_year, end_month, monthrange(end_year, end_month)[1])
            found.setdefault((end_year, end_month), (end, eps))
    return sorted(found.values(), reverse=True)


def kabutan_growth(rows):
    latest = rows[0] if rows else None
    previous = rows[1] if len(rows) > 1 else None
    return {
        "eps_q_latest_yoy_pct": _yoy(latest, _find_year_prior(rows, latest)) if latest else None,
        "eps_q_prev_yoy_pct": _yoy(previous, _find_year_prior(rows, previous)) if previous else None,
        "eps_q_latest_end": latest[0].isoformat() if latest else None,
        "eps_q_prev_end": previous[0].isoformat() if previous else None,
    }


def kabutan_fill(row, rows):
    """Decide which missing fields Kabutan may fill for one archive row.

    When a Yahoo latest quarter already exists, the Kabutan previous
    quarter is anchored to it: the discrete quarter ending right before
    the stored latest period end, so the pair never labels the same
    period as both latest and previous. Without a stored latest, both
    quarters come from Kabutan as a consistent pair.
    """
    fills = {}
    stored_latest_end = row.get("eps_q_latest_end")
    if row.get("eps_q_latest_yoy_pct") is None:
        growth = kabutan_growth(rows)
        if growth["eps_q_latest_yoy_pct"] is not None:
            fills["eps_q_latest_yoy_pct"] = growth["eps_q_latest_yoy_pct"]
            fills["eps_q_latest_end"] = growth["eps_q_latest_end"]
            stored_latest_end = growth["eps_q_latest_end"]
        if growth["eps_q_prev_yoy_pct"] is not None and row.get("eps_q_prev_yoy_pct") is None:
            fills["eps_q_prev_yoy_pct"] = growth["eps_q_prev_yoy_pct"]
            fills["eps_q_prev_end"] = growth["eps_q_prev_end"]
        return fills
    if row.get("eps_q_prev_yoy_pct") is not None or not stored_latest_end:
        return fills
    ends = [end.isoformat() for end, _ in rows]
    if stored_latest_end not in ends:
        return fills
    idx = ends.index(stored_latest_end)
    if idx + 1 >= len(rows):
        return fills
    previous = rows[idx + 1]
    value = _yoy(previous, _find_year_prior(rows, previous))
    if value is not None:
        fills["eps_q_prev_yoy_pct"] = value
        fills["eps_q_prev_end"] = previous[0].isoformat()
    return fills


def _fetch_and_fill(row):
    """Return (row, filled_count, error)."""
    if _stop.is_set():
        return row, 0, "stopped"
    ticker = normalize_jp_ticker(row.get("ticker"))
    if not ticker:
        return row, 0, "invalid ticker"
    code = ticker[:-2]
    try:
        html = fetch_html(code)
    except HTTPError as exc:
        if exc.code in (403, 429):
            _stop.set()
            return row, 0, f"{ticker}: rate-limited ({exc.code})"
        return row, 0, f"{ticker}: HTTP {exc.code}"
    except Exception as exc:
        return row, 0, f"{ticker}: {type(exc).__name__}"
    fills = kabutan_fill(row, parse_quarterly_eps(html))
    today = date.today().isoformat()
    row["eps_kabutan_attempted_at"] = today
    for key, value in fills.items():
        row[key] = value
    if fills:
        row["eps_fill_source"] = SOURCE
        row["eps_fill_fetched_at"] = today
        if not row.get("eps_source"):
            row["eps_source"] = SOURCE
            row["eps_fetched_at"] = today
    return row, len([k for k in fills if k.endswith("yoy_pct")]), None


def enrich_jp_kabutan_eps(data, limit, *, workers=3, refresh_days=45):
    """Fill missing quarterly EPS growth on data['jp'] entries in place."""
    stocks = data.get("jp") or []
    if not stocks:
        print("JP_KABUTAN_EPS_SKIPPED: Japanese ticker list unavailable", flush=True)
        return {}
    _stop.clear()
    today = date.today()
    cutoff = (today - timedelta(days=refresh_days)).isoformat()
    candidates = []
    for index, row in enumerate(stocks):
        if row.get("eps_q_prev_yoy_pct") is not None and row.get("eps_q_latest_yoy_pct") is not None:
            continue
        checked = row.get("eps_kabutan_attempted_at")
        if isinstance(checked, str) and checked >= cutoff:
            continue
        candidates.append((row.get("eps_q_prev_yoy_pct") is not None, index, row))
    candidates.sort(key=lambda item: (item[0], item[1]))
    attempt = [row for _, _, row in candidates[:max(1, limit)]]
    workers = max(1, min(4, workers))
    processed = filled_rows = filled_values = 0
    errors = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for offset in range(0, len(attempt), workers * 10):
            wave = attempt[offset:offset + workers * 10]
            futures = [pool.submit(_fetch_and_fill, row) for row in wave]
            for future in as_completed(futures):
                row, filled, error = future.result()
                processed += 1
                if error:
                    errors.append(error)
                if filled:
                    filled_rows += 1
                    filled_values += filled
                if processed % 200 == 0:
                    print(f"JP_KABUTAN_EPS_PROGRESS processed={processed}/{len(attempt)} "
                          f"filled_rows={filled_rows} errors={len(errors)}", flush=True)
            if _stop.is_set():
                print("JP_KABUTAN_EPS_RATE_LIMIT_STOP: remaining tickers deferred", flush=True)
                break
    data["jp_kabutan_eps_coverage"] = {
        "source": SOURCE,
        "universe": len(stocks),
        "batch_requested": len(attempt),
        "batch_size": processed,
        "filled_rows": filled_rows,
        "filled_values": filled_values,
        "failed_this_run": len(errors),
        "with_latest_yoy": sum(isinstance(r.get("eps_q_latest_yoy_pct"), (int, float)) for r in stocks),
        "with_previous_yoy": sum(isinstance(r.get("eps_q_prev_yoy_pct"), (int, float)) for r in stocks),
        "attempted_ever": sum(bool(r.get("eps_kabutan_attempted_at")) for r in stocks),
        "updated_at": datetime.now().isoformat(timespec="seconds"),
    }
    print("JP_KABUTAN_EPS_COVERAGE", json.dumps(data["jp_kabutan_eps_coverage"], ensure_ascii=False), flush=True)
    if errors:
        print("JP_KABUTAN_EPS_ERRORS", ", ".join(errors[:10]), flush=True)
    return data["jp_kabutan_eps_coverage"]


def main():
    data = json.loads(ARCHIVE.read_text(encoding="utf-8"))
    if os.getenv("JP_KABUTAN_FULL") == "1":
        limit = max(1, len(data.get("jp") or []))
    else:
        limit = int(os.getenv("JP_KABUTAN_BATCH", "400"))
    workers = int(os.getenv("JP_KABUTAN_WORKERS", "3"))
    enrich_jp_kabutan_eps(data, limit, workers=workers)
    ARCHIVE.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n",
                       encoding="utf-8")
    print("WROTE", ARCHIVE.name, flush=True)


if __name__ == "__main__":
    main()
