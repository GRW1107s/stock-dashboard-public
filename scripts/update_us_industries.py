"""Generate us-industries.json / us-industries-fine.json: GICS industry
analysis for the US universe in the same format as jp-industries.json.

Membership comes from sector-leaders.json, whose US rows carry GICS
Industry (level 1, 74 categories) and GICS Sub-Industry (level 2, 163
categories) for S&P 1500 constituents (see gics_us.py). Prices come from
Yahoo Finance's unofficial chart API. Each industry index is a
market-cap weighted chain of its member stocks (weights are share counts
implied by the latest market-cap snapshot, fixed between runs like a
real cap-weighted index); industry volume is the sum of member volumes.
The benchmark is the S&P 500 (^GSPC). This is a reference aggregate, NOT
an official GICS index, and no missing value is manufactured.

Dates are New York session dates. Groups with fewer than 3 usable
members are not published, matching the JP industry analysis.
"""
import datetime as dt
import json
import os
import pathlib
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from zoneinfo import ZoneInfo

from update_jp_sectors import enrich
from update_jp_industries import aggregate

ROOT = pathlib.Path(__file__).resolve().parents[1]
BENCHMARK = "^GSPC"
PUBLISH = 200
CALC = 250
NY = ZoneInfo("America/New_York")
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; PersonalUSSectorDashboard/1.0)",
           "Accept": "application/json"}


def _num(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def download_us(symbol):
    """Daily bars keyed by New York session date: {date: {close, low, volume}}."""
    end = int(time.time()) + 86400
    start = end - 420 * 86400
    query = urllib.parse.urlencode({"period1": start, "period2": end,
                                    "interval": "1d", "events": "history"})
    last = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        for attempt in range(2):
            try:
                url = (f"https://{host}/v8/finance/chart/"
                       f"{urllib.parse.quote(symbol)}?{query}")
                request = urllib.request.Request(url, headers=HEADERS)
                with urllib.request.urlopen(request, timeout=25) as response:
                    data = json.load(response)["chart"]["result"][0]
                quote = data["indicators"]["quote"][0]
                now = dt.datetime.now(NY)
                parsed = {}
                for stamp, close, low, vol in zip(data["timestamp"],
                                                  quote["close"],
                                                  quote["low"],
                                                  quote["volume"]):
                    close = _num(close)
                    if close is None or close <= 0:
                        continue
                    day = dt.datetime.fromtimestamp(stamp, NY).date()
                    # Drop the in-progress New York session.
                    if day == now.date() and now.time() < dt.time(16, 10):
                        continue
                    parsed[day.isoformat()] = {"close": close,
                                               "low": _num(low),
                                               "volume": _num(vol)}
                if len(parsed) < 35:
                    raise ValueError(f"too few sessions {len(parsed)}")
                dates = sorted(parsed)[-CALC:]
                return {d: parsed[d] for d in dates}
            except Exception as exc:
                last = exc
                time.sleep(attempt + 1)
    raise RuntimeError(f"{symbol}: {last}")


def load_membership():
    """Return (levels, weights) from the published screener data.

    levels: {"industry": {gics_industry: [ticker, ...]},
             "sub": {gics_sub_industry: [ticker, ...]}}
    weights: {ticker: shares} implied by market_cap / close.
    """
    leaders_path = pathlib.Path(os.getenv(
        "US_INDUSTRIES_LEADERS", str(ROOT / "sector-leaders.json")))
    data = json.loads(leaders_path.read_text(encoding="utf-8"))
    rows = list(data.get("us", []))
    max_tickers = int(os.getenv("US_INDUSTRIES_MAX_TICKERS", "0"))
    if max_tickers:
        rows = sorted(rows, key=lambda r: -(r.get("market_cap") or 0))[:max_tickers]
    levels = {"industry": {}, "sub": {}}
    weights = {}
    for row in rows:
        ticker = row.get("ticker")
        if not ticker:
            continue
        cap, close = _num(row.get("market_cap")), _num(row.get("close"))
        if cap and close and close > 0:
            weights[ticker] = cap / close
        if row.get("gics_industry"):
            levels["industry"].setdefault(row["gics_industry"], []).append(ticker)
        # Fine level mirrors the screener's 業種② column exactly: GICS
        # Sub-Industry where classified, otherwise the Nasdaq Industry.
        sub = row.get("gics_sub_industry") or row.get("industry_name")
        if sub:
            levels["sub"].setdefault(sub, []).append(ticker)
    for level in levels.values():
        for name in level:
            level[name] = sorted(set(level[name]))
    return levels, weights


def build_file(level_membership, raw, weights, calendar, benchmark_enriched,
               level_label):
    enriched = {}
    member_counts = {}
    weight_coverage = {}
    for name, tickers in level_membership.items():
        member_series = [raw[t] for t in tickers if t in raw]
        member_weights = [weights.get(t) for t in tickers if t in raw]
        member_counts[name] = len(member_series)
        weight_coverage[name] = sum(1 for w in member_weights if w)
        if len(member_series) < 3 or weight_coverage[name] < 3:
            continue
        enriched[name] = enrich(aggregate(member_series, member_weights, calendar))
    names = sorted(enriched)
    dates = calendar[::-1][:PUBLISH]
    covered = set()
    for name in names:
        covered.update(enriched.get(name, {}))
    if covered:
        dates = [d for d in dates if d <= max(covered)]
    rows = []
    for day in dates:
        values = {name: enriched.get(name, {}).get(day) for name in names}
        bench = benchmark_enriched.get(day)
        bench_change = bench["change"] if bench else None
        ranking = []
        for name, value in values.items():
            if value:
                value = {k: v for k, v in value.items() if k != "close"}
                if bench_change is not None and value["change"] is not None:
                    value["vs_benchmark"] = round(value["change"] - bench_change, 4)
                    ranking.append((name, value["vs_benchmark"]))
                values[name] = value
        for rank, (name, _) in enumerate(
                sorted(ranking, key=lambda x: x[1], reverse=True), 1):
            values[name]["rank"] = rank
        rows.append({"date": day, "benchmark_change": bench_change,
                     "sectors": values})
    return {
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "names": {name: name for name in names},
        "rows": rows,
        "source": "Industry membership: the US screener's classification "
                  "(GICS for S&P 1500 constituents via public lists, see "
                  "gics_us.py; Nasdaq Industry for the remaining listings); "
                  "prices: Yahoo Finance unofficial daily prices; "
                  "index: market-cap weighted chain of member stocks (share "
                  "weights implied by the latest market-cap snapshot), volume: "
                  "sum of member volumes",
        "benchmark": BENCHMARK,
        "membership_source": "sector-leaders.json GICS fields",
        "member_counts": member_counts,
        "weight_coverage": weight_coverage,
        "membership": {name: level_membership[name] for name in names},
        "note": f"業種の所属銘柄はGICS（世界産業分類基準）の{level_label}に基づきます。"
                "指数は構成銘柄を時価総額加重で計算した参考値、出来高は構成銘柄の合計で、"
                "公式のGICS指数ではありません。判定はこの参考指数自身の値動きと出来高に"
                "基づく簡易指標です。構成銘柄3未満の業種は掲載していません。",
    }


def main():
    levels, weights = load_membership()
    unique = sorted({t for level in levels.values()
                     for tickers in level.values() for t in tickers})
    print(f"US_INDUSTRIES industries={len(levels['industry'])} "
          f"subs={len(levels['sub'])} unique_tickers={len(unique)} "
          f"weighted={len(weights)}", flush=True)
    if len(unique) < 100:
        raise RuntimeError("Too few GICS members in sector-leaders.json; "
                           "refusing to publish")
    raw = {}
    failures = {}
    raw[BENCHMARK] = download_us(BENCHMARK)
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(download_us, t): t for t in unique}
        done = 0
        for future in as_completed(futures):
            ticker = futures[future]
            try:
                raw[ticker] = future.result()
            except Exception as exc:
                failures[ticker] = str(exc)[:120]
            done += 1
            if done % 500 == 0:
                print(f"US_INDUSTRIES_DOWNLOAD {done}/{len(unique)} "
                      f"ok={len(raw)-1} failed={len(failures)}", flush=True)
    print(f"US_INDUSTRIES_DOWNLOADED ok={len(raw)-1} failed={len(failures)}",
          flush=True)
    if len(raw) - 1 < max(100, len(unique) // 2):
        raise RuntimeError("Too few member histories; refusing to publish")
    calendar = sorted(raw[BENCHMARK])
    benchmark_enriched = enrich(raw[BENCHMARK])
    out_dir = pathlib.Path(os.getenv("US_INDUSTRIES_OUT_DIR", str(ROOT)))
    for key, filename, label in (
            ("industry", "us-industries.json", "Industry分類（74業種）"),
            ("sub", "us-industries-fine.json", "Sub-Industry分類（163業種）")):
        result = build_file(levels[key], raw, weights, calendar,
                            benchmark_enriched, label)
        result["missing_symbols"] = failures
        (out_dir / filename).write_text(
            json.dumps(result, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8")
        print(f"WROTE {filename}: {len(result['rows'])} rows, "
              f"{len(result['names'])} industries; "
              f"latest={result['rows'][0]['date']}", flush=True)


if __name__ == "__main__":
    main()
