"""Generate jp-industries.json: TOPIX-33 industry analysis in the same
format as jp-sectors.json (TOPIX-17 ETF sectors).

Industry membership comes from Kabubusho (kabubusho.com) per-industry
stock lists. Prices come from Yahoo Finance's unofficial chart API.
Each industry index is an equal-weight chain of its member stocks'
daily returns; industry volume is the sum of member volumes. This is
a reference aggregate, NOT an official TSE industry index, and no
missing value is manufactured.
"""
import datetime as dt
import json
import pathlib
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from update_jp_sectors import BENCHMARK, download, enrich

ROOT = pathlib.Path(__file__).resolve().parents[1]
KABUBUSHO = "https://kabubusho.com"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                         "AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/126.0 Safari/537.36"}
PUBLISH = 200
# Canonical JPX order for the 33 industries (display order).
ORDER = ["水産・農林業", "鉱業", "建設業", "食料品", "繊維製品", "パルプ・紙",
         "化学", "石油・石炭製品", "ゴム製品", "ガラス・土石製品", "鉄鋼",
         "非鉄金属", "金属製品", "機械", "電気機器", "輸送用機器", "精密機器",
         "その他製品", "電気・ガス業", "陸運業", "海運業", "空運業",
         "倉庫・運輸関連業", "情報・通信業", "卸売業", "小売業", "銀行業",
         "証券、商品先物取引業", "保険業", "その他金融業", "不動産業", "サービス業"]


def fetch(url):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=25) as response:
        return response.read(4_000_000).decode("utf-8", "replace")


def kabubusho_membership():
    """Return {industry: [ticker, ...]} scraped from Kabubusho sector pages."""
    top = fetch(f"{KABUBUSHO}/industry.html")
    names = []
    for encoded in re.findall(r'href="/sector/([^"]+)"', top):
        name = urllib.parse.unquote(encoded)
        if name and name not in names and "${" not in name:
            names.append(name)
    if len(names) < 30:
        raise RuntimeError(f"Kabubusho industry list looks wrong: {len(names)} industries")
    membership = {}
    for name in names:
        time.sleep(0.3)
        page = fetch(f"{KABUBUSHO}/sector/{urllib.parse.quote(name)}")
        codes = sorted(set(re.findall(r'href="/stock/([0-9A-Z]+)"', page)))
        if len(codes) < 3:
            raise RuntimeError(f"Kabubusho sector {name}: only {len(codes)} members")
        membership[name] = [f"{code}.T" for code in codes]
    return membership


def aggregate(member_series, calendar):
    """Chain equal-weight member returns into an industry price series."""
    series = {}
    level = None
    prev_day = None
    for day in calendar:
        volume = 0.0
        any_volume = False
        for prices in member_series:
            row = prices.get(day)
            if row and row.get("volume") is not None:
                volume += row["volume"]
                any_volume = True
        if level is None:
            if any(day in prices for prices in member_series):
                level = 1000.0
                series[day] = {"close": level, "low": level,
                               "volume": volume if any_volume else None}
                prev_day = day
            continue
        returns = []
        low_returns = []
        for prices in member_series:
            today_row = prices.get(day)
            prev_row = prices.get(prev_day) if prev_day else None
            if today_row and prev_row and prev_row["close"]:
                returns.append(today_row["close"] / prev_row["close"] - 1)
                if today_row.get("low") is not None:
                    low_returns.append(today_row["low"] / prev_row["close"] - 1)
        if returns:
            prev_level = level
            level *= 1 + sum(returns) / len(returns)
            low_level = prev_level * (1 + sum(low_returns) / len(low_returns)) if low_returns else level
            series[day] = {"close": level, "low": low_level,
                           "volume": volume if any_volume else None}
        prev_day = day
    return series


def main():
    membership = kabubusho_membership()
    total_members = sum(len(v) for v in membership.values())
    unique = sorted({t for tickers in membership.values() for t in tickers})
    print(f"KABUBUSHO_INDUSTRIES industries={len(membership)} memberships={total_members} "
          f"unique_tickers={len(unique)}", flush=True)

    raw = {}
    failures = {}
    try:
        raw[BENCHMARK] = download(BENCHMARK)
    except Exception as exc:
        raise RuntimeError(f"benchmark download failed: {exc}")
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(download, ticker): ticker for ticker in unique}
        done = 0
        for future in as_completed(futures):
            ticker = futures[future]
            try:
                raw[ticker] = future.result()
            except Exception as exc:
                failures[ticker] = str(exc)[:120]
            done += 1
            if done % 500 == 0:
                print(f"JP_INDUSTRIES_DOWNLOAD {done}/{len(unique)} ok={len(raw)-1} "
                      f"failed={len(failures)}", flush=True)
    print(f"JP_INDUSTRIES_DOWNLOADED ok={len(raw)-1} failed={len(failures)}", flush=True)
    if len(raw) < 1000:
        raise RuntimeError("Too few member histories; refusing to publish")

    calendar = sorted(raw[BENCHMARK])
    enriched = {BENCHMARK: enrich(raw[BENCHMARK])}
    member_counts = {}
    for name, tickers in membership.items():
        member_series = [raw[t] for t in tickers if t in raw]
        member_counts[name] = len(member_series)
        if len(member_series) < 3:
            print(f"WARNING: industry {name} has only {len(member_series)} usable members")
            continue
        enriched[name] = enrich(aggregate(member_series, calendar))

    industries = [n for n in ORDER if n in enriched]
    industries += [n for n in membership if n not in industries and n in enriched]
    dates = calendar[::-1][:PUBLISH]
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
        for rank, (name, _) in enumerate(sorted(ranking, key=lambda x: x[1], reverse=True), 1):
            values[name]["rank"] = rank
        rows.append({"date": day, "topix_change": topix_change, "sectors": values})

    result = {
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "names": {name: name for name in industries},
        "rows": rows,
        "source": "Industry membership: Kabubusho (kabubusho.com) industry stock lists; "
                  "prices: Yahoo Finance unofficial daily prices; index: equal-weight "
                  "chain of member stocks, volume: sum of member volumes",
        "benchmark": BENCHMARK,
        "member_counts": member_counts,
        "missing_symbols": failures,
        "note": "業種の所属銘柄は株武将の業種別銘柄一覧に基づきます。指数は構成銘柄の終値を"
                "等ウェイトで連鎖した参考値、出来高は構成銘柄の合計で、東証の公式業種別"
                "指数ではありません。判定はこの参考指数自身の値動きと出来高に基づく簡易指標です。",
    }
    (ROOT / "jp-industries.json").write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"WROTE jp-industries.json: {len(rows)} rows, {len(industries)} industries; "
          f"latest={rows[0]['date']}; failed tickers={len(failures)}")


if __name__ == "__main__":
    main()
