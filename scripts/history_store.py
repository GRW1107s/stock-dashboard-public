"""Daily history persistence for the public screener.

Two stores, both plain JSON so the workflow's `git add -A -- '*.json'`
commit step picks them up without any workflow change:

- ohlcv/<market>/<ticker>.json — per-stock daily OHLCV rows
  [date, open, high, low, close, volume]. Every pipeline run merges the
  series it fetched (each fetch carries ~455 days) and trims rows
  older than the retention window. Retention is ten years (GRW,
  2026-11-20): backfill_ohlcv10y.py deepens every ticker's file to a
  full decade once, and daily merges keep it topped up. This is the
  backtest data foundation.
- screener-archive/YYYY-MM-DD.json — one slim columnar snapshot of the
  screener rows per day (the day's last run wins), pruned to 365 days.

Both writers are best-effort: callers wrap them so a storage failure can
never block the price pipeline.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
import json
import math
from pathlib import Path
import re
import time
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

RETENTION_DAYS = 3660
# Screener snapshots are kept for three years (GRW, 2026-11-19); the
# OHLCV store above keeps ten years (GRW, 2026-11-20).
SNAPSHOT_RETENTION_DAYS = 3700

# Fields kept in a daily screener snapshot: identity/classification plus
# every metric the screener displays or filters on. Bookkeeping fields
# (fetch stamps, sample counts, cursors) are deliberately excluded.
SNAPSHOT_FIELDS = [
    "ticker", "name", "sector", "sector_name", "industry_name",
    "gics_industry", "gics_sub_industry",
    "industry_fine_en", "industry_fine_ja", "market", "asof", "close",
    "change_1d", "return_3d", "return_10d", "return_25d", "return_60d",
    "return_252d", "rs_universe_pct", "rs_weighted_return_pct",
    "rs_sp500_delta_pp", "beta_252d", "sharpe_252d",
    "high52_distance_pct", "low52_rise_pct", "ma20_position",
    "ma50_position", "ma150", "ma200", "ma200_prev", "rvol20",
    "market_cap", "sector_rank", "eps_q_latest_yoy_pct",
    "eps_q_latest_qoq_pct", "eps_annual_yoy_pct", "eps_annual_3y_cagr_pct",
    "sales_q_latest_yoy_pct", "roe_pct", "short_ratio", "short_d_ratio",
    "margin_buy_pct", "margin_sell_pct", "margin_ratio",
]


def _safe_name(ticker):
    name = re.sub(r"[^A-Za-z0-9\-]", "-", str(ticker or "")).strip("-")
    return name or "unknown"


def _fix_decimal_glitches(rows):
    """Repair Yahoo decimal-shift glitch rows (a close at almost exactly
    1/100, 1/10, 10x or 100x of the previous close). Such rows appear in
    the raw chart series for some tickers (e.g. 1321.T on 2026-10-05/06
    at 1/100 scale with 100x volume). Genuine moves never land within
    3% of an exact decimal multiple, so rescaling is safe."""
    prev_close = None
    for row in rows:
        close = row[4]
        if prev_close and close:
            ratio = close / prev_close
            for factor in (0.01, 0.1, 10.0, 100.0):
                if abs(ratio / factor - 1) < 0.03:
                    mult = 1.0 / factor
                    for i in (1, 2, 3, 4):
                        if isinstance(row[i], (int, float)):
                            row[i] = round(row[i] * mult, 3)
                    if isinstance(row[5], (int, float)):
                        row[5] = int(round(row[5] * factor))
                    close = row[4]
                    break
        if close:
            prev_close = close
    return rows


# Tickers whose full history is kept (no retention trim): QQQ goes back to
# its 1999 listing and GRW verifies index-linked strategies over ~30 years.
# The sector ETFs (GRW, 2026-11-25) feed the backtest panel's sector
# rotation tab, which ranks sectors over their whole listed history.
SECTOR_ETFS_JP = [f"{code}.T" for code in range(1617, 1634)]
SECTOR_ETFS_US = ["XLC", "XLY", "XLP", "XLE", "XLF", "XLV", "XLI", "XLB",
                  "XLRE", "XLK", "XLU"]
FULL_HISTORY_TICKERS = ({"QQQ", "QLD", "TQQQ", "SOXX", "SOXL"}
                        | set(SECTOR_ETFS_JP) | set(SECTOR_ETFS_US))


def ohlcv_file(root, market, ticker):
    return Path(root) / "ohlcv" / market / (_safe_name(ticker) + ".json")


def _num(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def fetch_full_history(symbol, market, headers=None):
    """Whole listed history as OHLCV rows [date, o, h, l, c, v].

    Mirrors update_sector_leaders.obtain()'s parsing, but with a
    period1=0 window (obtain's ~455 days would leave a new sector
    ETF file too shallow for the rotation statistics). Used once per
    ticker, when its OHLCV file does not exist yet.
    """
    headers = headers or {"User-Agent": "Mozilla/5.0 (sector-etf-seed)",
                          "Accept": "application/json"}
    query = urlencode({"period1": 0, "period2": int(time.time()) + 86400,
                       "interval": "1d"})
    zone = ZoneInfo("Asia/Tokyo" if market == "jp" else "America/New_York")
    last_error = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        for _attempt in range(2):
            try:
                url = (f"https://{host}/v8/finance/chart/"
                       f"{quote(symbol, safe='')}?{query}")
                request = Request(url, headers=headers)
                with urlopen(request, timeout=30) as response:
                    payload = json.loads(response.read(16_000_000))
                record = payload["chart"]["result"][0]
                quote_data = record["indicators"]["quote"][0]
                opens = quote_data.get("open") or []
                highs = quote_data.get("high") or []
                lows = quote_data.get("low") or []

                def _r4(v):
                    return round(v, 4) if isinstance(v, float) else v

                by_date = {}
                for idx, (timestamp, close, volume) in enumerate(zip(
                        record["timestamp"], quote_data["close"],
                        quote_data["volume"])):
                    close = _num(close)
                    if close is None or close <= 0:
                        continue
                    day = datetime.fromtimestamp(
                        timestamp, zone).date().isoformat()
                    vol = _num(volume)
                    if isinstance(vol, float) and vol.is_integer():
                        vol = int(vol)
                    by_date[day] = [
                        day,
                        _r4(_num(opens[idx])) if idx < len(opens) else None,
                        _r4(_num(highs[idx])) if idx < len(highs) else None,
                        _r4(_num(lows[idx])) if idx < len(lows) else None,
                        _r4(close), vol,
                    ]
                rows = [by_date[day] for day in sorted(by_date)]
                if rows:
                    return rows
            except Exception as err:  # noqa: BLE001 - retry on next host
                last_error = err
    raise RuntimeError(f"full history fetch failed for {symbol}: {last_error}")


def update_ohlcv(root, market, series_by_ticker, *, today=None):
    """Merge fetched daily series into per-ticker files; returns writes."""
    today = today or date.today()
    cutoff = (today - timedelta(days=RETENTION_DAYS)).isoformat()
    folder = Path(root) / "ohlcv" / market
    folder.mkdir(parents=True, exist_ok=True)
    written = 0
    for ticker, series in series_by_ticker.items():
        if not series:
            continue
        path = folder / (_safe_name(ticker) + ".json")
        merged = {}
        if path.exists():
            try:
                old = json.loads(path.read_text(encoding="utf-8"))
                for row in old.get("rows") or []:
                    merged[row[0]] = row
            except Exception:
                pass
        for row in series:
            merged[row[0]] = list(row)
        keep = (sorted(merged) if ticker in FULL_HISTORY_TICKERS
                else [day for day in sorted(merged) if day >= cutoff])
        rows = _fix_decimal_glitches([merged[day] for day in keep])
        if not rows:
            continue
        text = json.dumps({"ticker": ticker, "market": market, "rows": rows},
                          ensure_ascii=False, separators=(",", ":"))
        if not path.exists() or path.read_text(encoding="utf-8") != text:
            path.write_text(text, encoding="utf-8")
            written += 1
    return written


def slim_snapshot(output, day):
    """Columnar snapshot: field names once, one value array per stock."""
    def pack(rows):
        return [[row.get(field) for field in SNAPSHOT_FIELDS]
                for row in rows or []]
    return {"date": day, "fields": SNAPSHOT_FIELDS,
            "jp": pack(output.get("jp")), "us": pack(output.get("us"))}


def write_snapshot(root, output, *, today=None):
    """Write today's snapshot and prune ones past the retention window."""
    today = today or date.today()
    folder = Path(root) / "screener-archive"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (today.isoformat() + ".json")
    path.write_text(
        json.dumps(slim_snapshot(output, today.isoformat()),
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    cutoff = (today - timedelta(days=SNAPSHOT_RETENTION_DAYS)).isoformat()
    pruned = 0
    for old in folder.glob("*.json"):
        if old.name != "index.json" and old.stem < cutoff:
            old.unlink()
            pruned += 1
    _write_index(folder, today.isoformat())
    return path.name, pruned


def _write_index(folder, updated_at):
    """Rewrite screener-archive/index.json from the files present."""
    dates = sorted(
        (item.stem for item in folder.glob("*.json")
         if re.fullmatch(r"\d{4}-\d{2}-\d{2}", item.stem)),
        reverse=True)
    (folder / "index.json").write_text(
        json.dumps({"dates": dates, "updated_at": updated_at},
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")


def write_snapshot_rows(root, day_iso, jp_rows, us_rows):
    """Write one day's snapshot from prepared row dicts (backfill path).

    Uses the same slim columnar format as write_snapshot so the
    dashboard reads backfilled and live snapshots identically.
    """
    folder = Path(root) / "screener-archive"
    folder.mkdir(parents=True, exist_ok=True)
    payload = slim_snapshot({"jp": jp_rows, "us": us_rows}, day_iso)
    (folder / f"{day_iso}.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    _write_index(folder, day_iso)
    return f"{day_iso}.json"
