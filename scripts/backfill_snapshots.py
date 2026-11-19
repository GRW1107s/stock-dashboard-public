"""Backfill daily screener snapshots back to 2023-11-20 (three years).

The live pipeline writes one snapshot per day going forward. This
module reconstructs the missing past days. Recent days come from the
OHLCV series the current run already fetched (COLLECTED_OHLCV, ~455
days); older days come from a deep price cache (deep-series-jp.json /
deep-series-us.json at the repo root) that this module builds once
from Yahoo's chart API with a ~1500-day window and then reuses. It is
a no-op once every date exists.

How each field class is handled for a past date D:
- Static (ticker, name, sector / industry classification, market
  segment): taken from the current screener rows. The universe is the
  current one; listings that changed inside the window are not
  reconstructed.
- Daily (prices, returns, moving averages, RS, beta / Sharpe, 52-week
  distances, volume ratio, sector rank): recomputed exactly, from the
  series truncated at D, with the same formulas the live pipeline
  uses (ma_snapshot / pct / risk_metrics definitions mirrored).
- Earnings-driven (EPS / sales growth, ROE) and short / margin data:
  left empty. Their past values cannot be known from today's data,
  and the 2026-10-01 window sits inside earnings season, so carrying
  today's values back would misstate many stocks. Live snapshots
  capture them exactly from the day they are written.
- Market cap: the current value scaled by close(D) / close(now),
  which holds the share count fixed.
"""
from __future__ import annotations

import bisect
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import math
import os
from datetime import date, datetime
from pathlib import Path
import time
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

START = "2023-11-20"
# The hollow-snapshot rebuild check only covers the window the buggy
# first backfill wrote; deep files are written by the fixed code path
# and re-reading ~700 files every run just to recount closes would
# dominate the run.
HOLLOW_CHECK_FROM = "2026-09-01"
MAX_DATES = int(os.environ.get("BACKFILL_MAX_DATES", "80"))
DEEP_DAYS = 1500
DEEP_CACHE_FILES = {"jp": "deep-series-jp.json", "us": "deep-series-us.json"}
BENCH_SYMBOLS = {"jp": "1306.T", "us": "^GSPC"}

STATIC_FIELDS = [
    "ticker", "name", "sector", "sector_name", "industry_name",
    "gics_industry", "gics_sub_industry", "industry_fine_en",
    "industry_fine_ja", "market",
]
EMPTY_FIELDS = [
    "eps_q_latest_yoy_pct", "eps_q_latest_qoq_pct", "eps_annual_yoy_pct",
    "eps_annual_3y_cagr_pct",
    "sales_q_latest_yoy_pct", "roe_pct", "short_ratio", "short_d_ratio",
    "margin_buy_pct", "margin_sell_pct", "margin_ratio",
]


def _metrics_at(dates, closes, vols, i, bench_rets):
    """Price-derived fields as of index i, mirroring obtain()'s math."""
    from update_sector_leaders import ma_snapshot, pct

    close = closes[i]

    def ret(n, guard):
        return pct(close, closes[i - n]) if i >= guard else None

    ma = ma_snapshot(closes[: i + 1])
    ceiling = max(closes[max(0, i - 251): i + 1])
    floor = min(closes[max(0, i - 251): i + 1])
    prev_vols = [v for v in vols[max(0, i - 20): i] if v is not None]
    mean_vol = sum(prev_vols) / len(prev_vols) if len(prev_vols) >= 15 else None
    rvol = (round(vols[i] / mean_vol, 3)
            if vols[i] is not None and mean_vol and mean_vol > 0 else None)

    # Beta / Sharpe over the last 252 daily returns, mirroring
    # risk_metrics() (sample variance, >=120 samples, date-matched beta).
    js = range(max(1, i - 251), i + 1)
    rets = [(dates[j], closes[j] / closes[j - 1] - 1) for j in js
            if closes[j - 1] > 0]
    values = [v for _, v in rets]
    sharpe = None
    if len(values) >= 120:
        avg = sum(values) / len(values)
        var = sum((v - avg) ** 2 for v in values) / (len(values) - 1)
        if var > 0:
            sharpe = round(avg / math.sqrt(var) * math.sqrt(252), 3)
    beta = None
    if bench_rets:
        matched = [(x, bench_rets[d]) for d, x in rets
                   if d in bench_rets and math.isfinite(bench_rets[d])]
        if len(matched) >= 120:
            xavg = sum(x for x, _ in matched) / len(matched)
            yavg = sum(y for _, y in matched) / len(matched)
            denom = sum((y - yavg) ** 2 for _, y in matched)
            if denom > 0:
                beta = round(
                    sum((x - xavg) * (y - yavg) for x, y in matched) / denom, 3)

    return {
        "asof": dates[i],
        "close": round(close, 3),
        "change_1d": pct(close, closes[i - 1]) if i >= 1 else None,
        "return_3d": ret(3, 3),
        "return_10d": ret(10, 10),
        "return_25d": ret(25, 25),
        "return_60d": ret(60, 60),
        "return_252d": ret(252, 252),
        "return_63d": ret(63, 63),
        "return_126d": ret(126, 126),
        "return_189d": ret(189, 189),
        "high52_distance_pct": (
            round(100 * (ceiling - close) / ceiling, 2) if ceiling else None),
        "low52_rise_pct": (
            round(100 * (close - floor) / floor, 2) if floor else None),
        "ma20_position": ma.get("ma20_position"),
        "ma50_position": ma.get("ma50_position"),
        "ma150": ma.get("ma150"),
        "ma200": ma.get("ma200"),
        "ma200_prev": ma.get("ma200_prev"),
        "rvol20": rvol,
        "beta_252d": beta,
        "sharpe_252d": sharpe,
    }


def _rank_date(rows, market, day, bench_score, bench_asof):
    """RS percentile + sector rank for one date, mirroring enrich()."""
    from update_sector_leaders import rs_weighted_return, safe_num

    present = []
    for stock in rows:
        score = rs_weighted_return(stock)
        asof = stock.get("asof")
        valid = False
        if score is not None and asof:
            try:
                age = (day - date.fromisoformat(asof)).days
                valid = 0 <= age <= 9
            except ValueError:
                valid = False
        stock["rs_weighted_return_pct"] = score if valid else None
        stock["rs_sp500_delta_pp"] = (
            round(score - bench_score, 3)
            if valid and market == "us" and bench_score is not None
            and bench_asof and asof == bench_asof else None)
        stock["rs_universe_pct"] = None
        stock["sector_rank"] = None
        if valid:
            present.append(stock)
    present.sort(key=lambda s: (s["rs_weighted_return_pct"], s["ticker"]))
    n = len(present)
    for rank, stock in enumerate(present):
        stock["rs_universe_pct"] = (
            round(1 + 98 * rank / (n - 1)) if n > 1 else None)
    valid_ids = {id(stock) for stock in present}
    groups = {}
    for stock in rows:
        if id(stock) in valid_ids and safe_num(stock.get("return_60d")) is not None:
            groups.setdefault(stock["sector"], []).append(stock)
    for group in groups.values():
        group.sort(key=lambda s: (-s["return_60d"], s["ticker"]))
        for rank, stock in enumerate(group, 1):
            stock["sector_rank"] = rank
    return len(present)


def _build_market(rows_now, series_by_ticker, bench, market, targets):
    """Snapshot rows per target date for one market."""
    from update_sector_leaders import rs_weighted_return

    bench_dates = [r[0] for r in bench["series"]]
    bench_closes = [r[4] for r in bench["series"]]
    bench_vols = [r[5] for r in bench["series"]]
    bench_rets = bench["daily_returns"]
    out = {d: [] for d in targets}
    bench_at = {}
    for d in targets:
        bi = bisect.bisect_right(bench_dates, d) - 1
        if bi >= 0:
            m = _metrics_at(bench_dates, bench_closes, bench_vols, bi, None)
            bench_at[d] = (rs_weighted_return(m), bench_dates[bi])
        else:
            bench_at[d] = (None, None)

    for row in rows_now:
        static = {f: row.get(f) for f in STATIC_FIELDS}
        for f in EMPTY_FIELDS:
            static[f] = None
        series = series_by_ticker.get(row.get("ticker"))
        if not series:
            for d in targets:
                out[d].append(dict(static, asof=None))
            continue
        dates = [r[0] for r in series]
        closes = [r[4] for r in series]
        vols = [r[5] for r in series]
        cap_now = row.get("market_cap")
        close_now = row.get("close")
        for d in targets:
            i = bisect.bisect_right(dates, d) - 1
            if i < 0:
                out[d].append(dict(static, asof=None))
                continue
            m = _metrics_at(dates, closes, vols, i, bench_rets)
            m["market_cap"] = (
                round(cap_now * m["close"] / close_now, 2)
                if isinstance(cap_now, (int, float))
                and isinstance(close_now, (int, float)) and close_now > 0
                else None)
            out[d].append(dict(static, **m))
    for d in targets:
        day = date.fromisoformat(d)
        score, bench_asof = bench_at[d]
        _rank_date(out[d], market, day, score, bench_asof)
    return out


def _snapshot_hollow(path):
    """True when a snapshot file carries no price data.

    The first backfill (2026-11-19) wrote static-only snapshots for
    every past date: run() imported COLLECTED_OHLCV from the
    update_sector_leaders module, but the pipeline executes that file
    as __main__, so the import built a second, empty module instance
    and every series lookup missed. Such hollow files count as
    missing here so a later run rebuilds them with real data.
    """
    try:
        snap = json.loads(path.read_text(encoding="utf-8"))
        fields = snap.get("fields") or []
        rows = snap.get("jp") or []
        if not rows or "close" not in fields:
            return True
        idx = fields.index("close")
        filled = sum(1 for row in rows if row[idx] is not None)
        return filled < len(rows) * 0.5
    except Exception:
        return True


def _fetch_deep_series(symbol, market):
    """(date, close, volume) rows for ~DEEP_DAYS, mirroring obtain().

    Same endpoint, headers and close/volume parsing as
    update_sector_leaders.obtain(), but with a multi-year window and
    no minimum-session requirement (recent listings are short).
    """
    from update_sector_leaders import HEADERS, safe_num

    end = int(time.time()) + 86400
    start = end - DEEP_DAYS * 86400
    query = urlencode({"period1": start, "period2": end, "interval": "1d"})
    zone = ZoneInfo("Asia/Tokyo" if market == "jp" else "America/New_York")
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        for attempt in range(2):
            try:
                url = (f"https://{host}/v8/finance/chart/"
                       f"{quote(symbol, safe='')}?{query}")
                request = Request(url, headers=HEADERS)
                with urlopen(request, timeout=20) as response:
                    payload = json.loads(response.read(4_000_000))
                record = payload["chart"]["result"][0]
                quote_data = record["indicators"]["quote"][0]
                rows = {}
                for timestamp, close, volume in zip(
                        record["timestamp"], quote_data["close"],
                        quote_data["volume"]):
                    close = safe_num(close)
                    if close is None or close <= 0:
                        continue
                    day = datetime.fromtimestamp(timestamp, zone).date()
                    vol = safe_num(volume)
                    if isinstance(vol, float) and vol.is_integer():
                        vol = int(vol)
                    rows[day.isoformat()] = [day.isoformat(), close, vol]
                return [rows[day] for day in sorted(rows)]
            except Exception:
                time.sleep(0.5 * (attempt + 1))
    return []


def _load_or_build_cache(root, market, tickers):
    """Deep (date, close, volume) series per ticker, from disk or Yahoo.

    The cache file is built once (one bulk fetch per market) and then
    reused by every later run; it is committed with the other data
    JSONs by the workflow. The benchmark symbol is always included:
    its dates are the market calendar and its returns drive beta.
    """
    path = Path(root) / DEEP_CACHE_FILES[market]
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return {ticker: [tuple(row) for row in rows]
                    for ticker, rows in (data.get("series") or {}).items()}
        except Exception:
            pass
    symbols = sorted(set(tickers) | {BENCH_SYMBOLS[market]})
    series = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(_fetch_deep_series, symbol, market): symbol
                   for symbol in symbols}
        done = 0
        for future in as_completed(futures):
            symbol = futures[future]
            try:
                series[symbol] = future.result()
            except Exception:
                series[symbol] = []
            done += 1
            if done % 500 == 0:
                print(f"BACKFILL_DEEP_FETCH {market} {done}/{len(symbols)}",
                      flush=True)
    payload = {"fetched_at": date.today().isoformat(),
               "series": {ticker: rows for ticker, rows in series.items()
                          if rows}}
    path.write_text(json.dumps(payload, ensure_ascii=False,
                               separators=(",", ":")),
                    encoding="utf-8")
    print(f"BACKFILL_DEEP_CACHE_BUILT {market} tickers={len(payload['series'])}",
          flush=True)
    return {ticker: [tuple(row) for row in rows]
            for ticker, rows in payload["series"].items()}


def _merge_series(cache_rows, collected_rows):
    """OHLCV-format rows: deep cache underneath, collected on top.

    Cache rows carry only close/volume, so open/high/low are None;
    the backfill math (_metrics_at) reads close and volume only.
    """
    merged = {}
    for day, close, vol in cache_rows or []:
        merged[day] = [day, None, None, None, close, vol]
    for row in collected_rows or []:
        merged[row[0]] = list(row)
    return [merged[day] for day in sorted(merged)]


def _bench_from_series(series):
    closes = {row[0]: row[4] for row in series}
    days = sorted(closes)
    daily = {days[i]: closes[days[i]] / closes[days[i - 1]] - 1
             for i in range(1, len(days)) if closes[days[i - 1]] > 0}
    return {"series": series, "daily_returns": daily}


def run(root, output, collected=None):
    """Fill missing snapshot dates in [START, today). Returns count.

    `collected` is the caller's COLLECTED_OHLCV dict, passed in
    explicitly: importing it here would read a fresh module instance
    (the pipeline runs update_sector_leaders.py as __main__), whose
    dict is always empty.
    """
    from update_sector_leaders import obtain
    from history_store import write_snapshot_rows

    collected = collected or {}
    archive = Path(root) / "screener-archive"
    existing = set()
    index_path = archive / "index.json"
    if index_path.exists():
        try:
            existing = set(json.loads(index_path.read_text(encoding="utf-8")).get("dates") or [])
        except Exception:
            existing = set()
    if not existing and archive.exists():
        existing = {p.stem for p in archive.glob("*.json")}
    # Hollow snapshots (see _snapshot_hollow) are rebuilt, not kept.
    existing = {d for d in existing
                if not (HOLLOW_CHECK_FROM <= d
                        and _snapshot_hollow(archive / f"{d}.json"))}

    jp_rows = output.get("jp") or []
    us_rows = output.get("us") or []
    jp_cache = _load_or_build_cache(
        root, "jp", [row.get("ticker") for row in jp_rows if row.get("ticker")])
    us_cache = _load_or_build_cache(
        root, "us", [row.get("ticker") for row in us_rows if row.get("ticker")])

    def bench(market, cache):
        rows = _merge_series(cache.get(BENCH_SYMBOLS[market]),
                             (collected.get(market) or {}).get(
                                 BENCH_SYMBOLS[market]))
        if rows:
            return _bench_from_series(rows)
        raw = obtain(BENCH_SYMBOLS[market], market)
        return {"series": raw["_ohlcv"],
                "daily_returns": raw["_daily_returns"]}

    jp_bench = bench("jp", jp_cache)
    us_bench = bench("us", us_cache)

    today_jst = datetime.now(ZoneInfo("Asia/Tokyo")).date().isoformat()
    calendar = [r[0] for r in jp_bench["series"] if START <= r[0] < today_jst]
    targets = [d for d in calendar if d not in existing][-MAX_DATES:]
    if not targets:
        print("BACKFILL_SNAPSHOTS none", flush=True)
        return 0

    def merged(market, cache):
        coll = collected.get(market) or {}
        return {ticker: _merge_series(cache.get(ticker), coll.get(ticker))
                for ticker in set(cache) | set(coll)}

    jp = _build_market(jp_rows, merged("jp", jp_cache), jp_bench, "jp", targets)
    us = _build_market(us_rows, merged("us", us_cache), us_bench, "us", targets)
    for d in targets:
        write_snapshot_rows(root, d, jp[d], us[d])
        print("BACKFILL_SNAPSHOT", d, len(jp[d]), len(us[d]), flush=True)
    print("BACKFILL_SNAPSHOTS_DONE", len(targets), flush=True)
    return len(targets)
