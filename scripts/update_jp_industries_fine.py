"""Generate jp-industries-fine.json: a fine-grained industry analysis
(~150 industries) in the same format as jp-industries.json (TOPIX-33).

Membership comes from Yahoo Finance's own company classification: each
stock's profile "industry" (via yfinance), stored in the committed
jp-yahoo-industries.json so scheduled runs only fetch tickers that are
missing from the store (new listings, past failures) in a bounded batch.
The stock universe is the same JPX official listed-company list used by
update_jp_industries.py. Prices come from Yahoo Finance's unofficial
chart API; each industry index is a free-float market-cap weighted
chain of its member stocks, exactly like the 33-industry analysis, and
industry volume is the sum of member volumes. Yahoo's classification is
NOT an official exchange classification, industries with fewer than 3
usable weighted members are not published, and no missing value is
manufactured.
"""
import datetime as dt
import json
import os
import pathlib
from concurrent.futures import ThreadPoolExecutor, as_completed

from update_jp_industries import PUBLISH, aggregate, load_membership
from update_jp_sectors import BENCHMARK, download, enrich

ROOT = pathlib.Path(__file__).resolve().parents[1]
STORE = ROOT / "jp-yahoo-industries.json"
OUTPUT = ROOT / "jp-industries-fine.json"
MIN_MEMBERS = 3

try:
    from jp_yahoo_industry_ja import INDUSTRY_JA
except Exception:
    INDUSTRY_JA = {}


def load_store():
    try:
        data = json.loads(STORE.read_text(encoding="utf-8"))
        tickers = data.get("tickers") or {}
        return tickers if isinstance(tickers, dict) else {}
    except Exception:
        return {}


def save_store(tickers):
    STORE.write_text(json.dumps(
        {"updated_at": dt.date.today().isoformat(),
         "source": "Yahoo Finance company profile (sector/industry) via yfinance",
         "tickers": tickers}, ensure_ascii=False, indent=1), encoding="utf-8")


def refresh_store(universe, store, limit):
    """Fetch Yahoo profiles for universe tickers missing from the store."""
    missing = [t for t in universe if t not in store][:max(0, limit)]
    if not missing:
        return 0
    try:
        import yfinance as yf
    except Exception as exc:
        print("JP_FINE_YFINANCE_UNAVAILABLE", str(exc)[:120], flush=True)
        return 0

    def fetch(ticker):
        try:
            info = yf.Ticker(ticker).info or {}
            return ticker, info.get("industry"), info.get("sector")
        except Exception:
            return ticker, None, None

    added = 0
    with ThreadPoolExecutor(max_workers=3) as pool:
        for ticker, industry, sector in pool.map(fetch, missing):
            if industry:
                store[ticker] = {"industry": industry, "sector": sector}
                added += 1
    print(f"JP_FINE_STORE_REFRESH requested={len(missing)} added={added}",
          flush=True)
    if added:
        save_store(store)
    return added


def main():
    membership33, _source = load_membership()
    universe = sorted({t for tickers in membership33.values() for t in tickers})
    store = load_store()
    refresh_store(universe, store,
                  int(os.getenv("JP_FINE_BATCH", "600")))
    membership = {}
    for ticker in universe:
        entry = store.get(ticker)
        if entry and entry.get("industry"):
            membership.setdefault(entry["industry"], []).append(ticker)
    total_members = sum(len(v) for v in membership.values())
    print(f"JP_FINE_INDUSTRIES industries={len(membership)} "
          f"memberships={total_members} universe={len(universe)} "
          f"store={len(store)}", flush=True)
    if len(membership) < 50:
        raise RuntimeError("Too few Yahoo industries; refusing to publish")

    raw = {}
    failures = {}
    raw[BENCHMARK] = download(BENCHMARK)
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(download, ticker): ticker for ticker in universe}
        done = 0
        for future in as_completed(futures):
            ticker = futures[future]
            try:
                raw[ticker] = future.result()
            except Exception as exc:
                failures[ticker] = str(exc)[:120]
            done += 1
            if done % 500 == 0:
                print(f"JP_FINE_DOWNLOAD {done}/{len(universe)} "
                      f"ok={len(raw)-1} failed={len(failures)}", flush=True)
    print(f"JP_FINE_DOWNLOADED ok={len(raw)-1} failed={len(failures)}",
          flush=True)
    if len(raw) < 1000:
        raise RuntimeError("Too few member histories; refusing to publish")

    weights = {}
    try:
        from update_jp_float_shares import weights_from_store
        weights = weights_from_store()
    except Exception as exc:
        print("JP_FINE_WEIGHTS_ERROR", str(exc)[:160], flush=True)
    print(f"JP_FINE_WEIGHTS tickers_with_weights={len(weights)}", flush=True)

    calendar = sorted(raw[BENCHMARK])
    enriched = {BENCHMARK: enrich(raw[BENCHMARK])}
    member_counts = {}
    weight_coverage = {}
    for name, tickers in membership.items():
        member_series = [raw[t] for t in tickers if t in raw]
        member_weights = [weights.get(t) for t in tickers if t in raw]
        member_counts[name] = len(member_series)
        weight_coverage[name] = sum(1 for w in member_weights if w)
        if len(member_series) < MIN_MEMBERS or weight_coverage[name] < MIN_MEMBERS:
            continue
        enriched[name] = enrich(aggregate(member_series, member_weights, calendar))

    industries = sorted(n for n in membership if n in enriched)
    dates = calendar[::-1][:PUBLISH]
    # Never publish trailing sessions no industry could price (e.g. Yahoo
    # serving member bars late): an all-null latest row breaks the
    # front-end strength rankings. Lag one session instead.
    covered = set()
    for name in industries:
        covered.update(enriched.get(name, {}))
    if covered:
        dates = [d for d in dates if d <= max(covered)]
    rows = []
    for day in dates:
        values = {name: enriched.get(name, {}).get(day) for name in industries}
        topix = enriched[BENCHMARK].get(day)
        topix_change = topix["change"] if topix else None
        ranking = []
        for name, value in values.items():
            if value:
                value = {k: v for k, v in value.items() if k != "close"}
                if topix_change is not None and value["change"] is not None:
                    value["vs_topix"] = round(value["change"] - topix_change, 4)
                    ranking.append((name, value["vs_topix"]))
                values[name] = value
        for rank, (name, _) in enumerate(
                sorted(ranking, key=lambda x: x[1], reverse=True), 1):
            values[name]["rank"] = rank
        rows.append({"date": day, "topix_change": topix_change,
                     "sectors": values})

    result = {
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "names": {name: INDUSTRY_JA.get(name, name) for name in industries},
        "rows": rows,
        "source": "Industry membership: Yahoo Finance company profile "
                  "industry classification (via yfinance); prices: Yahoo "
                  "Finance unofficial daily prices; index: free-float "
                  "market-cap weighted chain of member stocks (float "
                  "shares via yfinance), volume: sum of member volumes",
        "benchmark": BENCHMARK,
        "membership_source": "yahoo",
        "member_counts": member_counts,
        "weight_coverage": weight_coverage,
        "membership": membership,
        "missing_symbols": failures,
        "note": "業種の所属はYahoo Financeの企業分類（業種）に基づきます。"
                "東証の公式分類ではありません。指数は構成銘柄を浮動株時価総額"
                "加重で計算した参考値、出来高は構成銘柄の合計です。構成銘柄が"
                "3未満の業種は掲載していません。ベンチマークは1306"
                "（TOPIX連動ETF）。約250取引日を計算用に取得し、最新200取引日"
                "を公開。最新日のデータは日本市場の引け後に反映されます。",
    }
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False,
                                 separators=(",", ":")), encoding="utf-8")
    print(f"WROTE jp-industries-fine.json: {len(rows)} rows, "
          f"{len(industries)} industries; latest={rows[0]['date']}; "
          f"failed tickers={len(failures)}", flush=True)


if __name__ == "__main__":
    main()
