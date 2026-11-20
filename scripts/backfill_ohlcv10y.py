"""Deepen every stored OHLCV series to ten years of daily bars.

The regular pipeline fetches ~455 days per ticker, so stored files used
to hold about a year. For the backtest GRW asked for ten years
(2026-11-20). This step runs at the end of update_sector_leaders.py:
each run takes the next batch of tickers whose file does not yet reach
back ten years (or that were never deepened), fetches the 10-year chart
from Yahoo, and merges it through history_store.update_ohlcv (which
also repairs decimal-shift glitch rows). A small state file remembers
tickers already deepened once, so young listings (whose history is
shorter than ten years by nature) are not refetched forever. Once every
ticker is done this is a cheap no-op scan.

Best-effort like the other stores: any failure is logged and skipped,
never blocking the price pipeline.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, time as clock_time, timedelta
import json
import os
from pathlib import Path
import time
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

MAX_PER_RUN = int(os.environ.get("BACKFILL10Y_MAX", "500"))
DEPTH_DAYS = 3650
STATE_NAME = "backfill10y-state.json"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0 Safari/537.36",
    "Accept": "application/json",
}


def _safe_num(value):
    try:
        if value is None:
            return None
        out = float(value)
        return out if out == out else None
    except (TypeError, ValueError):
        return None


def fetch_long(symbol, market):
    """Ten years of daily rows [date, open, high, low, close, volume],
    built exactly like update_sector_leaders.obtain (exchange-local
    dates, the still-incomplete current session skipped)."""
    end = int(time.time()) + 86400
    start = end - (DEPTH_DAYS + 45) * 86400
    query = urlencode({"period1": start, "period2": end, "interval": "1d"})
    zone = ZoneInfo("Asia/Tokyo" if market == "jp" else "America/New_York")
    last_error = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        for _attempt in range(2):
            try:
                url = f"https://{host}/v8/finance/chart/{quote(symbol, safe='')}?{query}"
                request = Request(url, headers=HEADERS)
                with urlopen(request, timeout=25) as response:
                    payload = json.loads(response.read(8_000_000))
                record = payload["chart"]["result"][0]
                quote_data = record["indicators"]["quote"][0]
                opens = quote_data.get("open") or []
                highs = quote_data.get("high") or []
                lows = quote_data.get("low") or []
                now = datetime.now(zone)
                by_date = {}
                for idx, (timestamp, close, volume) in enumerate(zip(
                        record["timestamp"], quote_data["close"],
                        quote_data["volume"])):
                    close = _safe_num(close)
                    if close is None or close <= 0:
                        continue
                    day = datetime.fromtimestamp(timestamp, zone).date()
                    if day == now.date():
                        cutoff = clock_time(15, 35) if market == "jp" else clock_time(16, 15)
                        if now.time() < cutoff:
                            continue
                    vol = _safe_num(volume)
                    if isinstance(vol, float) and vol.is_integer():
                        vol = int(vol)

                    def _r4(v):
                        return round(v, 4) if isinstance(v, float) else v

                    by_date[day.isoformat()] = [
                        day.isoformat(),
                        _r4(_safe_num(opens[idx])) if idx < len(opens) else None,
                        _r4(_safe_num(highs[idx])) if idx < len(highs) else None,
                        _r4(_safe_num(lows[idx])) if idx < len(lows) else None,
                        _r4(close), vol,
                    ]
                rows = [by_date[day] for day in sorted(by_date)]
                if len(rows) < 63:
                    raise ValueError("Not enough completed market sessions")
                return rows
            except Exception as err:  # noqa: BLE001 - retry on next host
                last_error = err
    raise RuntimeError(str(last_error)[:150])


def _file_oldest(path):
    try:
        rows = json.loads(path.read_text(encoding="utf-8")).get("rows") or []
        return rows[0][0] if rows else None
    except Exception:
        return None


def run(root, jp_tickers, us_tickers, *, today=None):
    from history_store import _safe_name, update_ohlcv

    root = Path(root)
    today = today or date.today()
    threshold = (today - timedelta(days=DEPTH_DAYS)).isoformat()
    state_path = root / "ohlcv" / STATE_NAME
    state = {"jp": [], "us": []}
    if state_path.exists():
        try:
            loaded = json.loads(state_path.read_text(encoding="utf-8"))
            state = {"jp": list(loaded.get("jp") or []),
                     "us": list(loaded.get("us") or [])}
        except Exception:
            pass
    done = {"jp": set(state["jp"]), "us": set(state["us"])}

    candidates = []  # (market, ticker)
    for market, tickers in (("jp", jp_tickers), ("us", us_tickers)):
        folder = root / "ohlcv" / market
        for ticker in tickers:
            if ticker in done[market]:
                continue
            oldest = _file_oldest(folder / (_safe_name(ticker) + ".json"))
            if oldest is not None and oldest <= threshold:
                done[market].add(ticker)
                continue
            candidates.append((market, ticker))
    candidates = candidates[:MAX_PER_RUN]
    if not candidates:
        print("OHLCV10Y complete: all tickers reach ten years", flush=True)
        _save_state(state_path, done, today)
        return 0

    fetched = {}

    def _job(item):
        market, ticker = item
        return item, fetch_long(ticker, market)

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(_job, item): item for item in candidates}
        for future in as_completed(futures):
            item = futures[future]
            try:
                _, rows = future.result()
                fetched[item] = rows
            except Exception as err:  # noqa: BLE001 - retried next run
                print("OHLCV10Y_FETCH_ERROR", item[0], item[1],
                      str(err)[:120], flush=True)

    written = 0
    for (market, ticker), rows in fetched.items():
        written += update_ohlcv(root, market, {ticker: rows}, today=today)
        done[market].add(ticker)
    _save_state(state_path, done, today)
    print("OHLCV10Y deepened", len(fetched), "tickers this run;",
          "jp done", len(done["jp"]), "; us done", len(done["us"]),
          "; files written", written, flush=True)
    return len(fetched)


def _save_state(state_path, done, today):
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(
            {"jp": sorted(done["jp"]), "us": sorted(done["us"]),
             "updated_at": today.isoformat()},
            ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    except Exception as err:  # noqa: BLE001
        print("OHLCV10Y_STATE_ERROR", str(err)[:120], flush=True)
