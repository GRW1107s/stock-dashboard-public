"""Generate jp-industries.json: TOPIX-33 industry analysis in the same
format as jp-sectors.json (TOPIX-17 ETF sectors).

Industry membership comes from JPX's official TSE listed-company list
(data_j.xlsx, published monthly by Japan Exchange Group), whose
33-industry classification (33業種区分) is the official TOPIX-33
assignment for every listed common stock. If that file cannot be
fetched, the previous run's membership (stored in jp-industries.json)
is reused, and Kabubusho (kabubusho.com) sector lists are the last
resort. Prices come from Yahoo Finance's unofficial chart API.
Each industry index is a free-float market-cap weighted chain of its
member stocks (float shares from Yahoo Finance via yfinance, refreshed
on a 30-day cycle), the same weighting scheme as TOPIX; industry
volume is the sum of member volumes. This is a reference aggregate,
NOT an official TSE industry index, and no missing value is
manufactured.
"""
import datetime as dt
import io
import json
import os
import pathlib
import re
import time
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed

from update_jp_sectors import BENCHMARK, download, enrich

ROOT = pathlib.Path(__file__).resolve().parents[1]
KABUBUSHO = "https://kabubusho.com"
JPX_LIST_URL = ("https://www.jpx.co.jp/markets/statistics-equities/misc/"
                "tvdivq0000001vg2-att/data_j.xlsx")
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                         "AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/126.0 Safari/537.36"}
PUBLISH = 200
# Canonical JPX order for the 33 industries (display order).
ORDER = ["水産・農林業", "鉱業", "建設業", "食料品", "繊維製品", "パルプ・紙",
         "化学", "医薬品", "石油・石炭製品", "ゴム製品", "ガラス・土石製品", "鉄鋼",
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


_XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def jpx_membership():
    """Return {industry: [ticker, ...]} from JPX's official listed list.

    data_j.xlsx is parsed with the standard library only (it is a zip of
    XML). Column 2 is the securities code, column 6 the official
    33-industry name (33業種区分); ETFs/REITs carry "-" there and drop
    out. Preferred shares (5-digit codes) are not separate industries'
    members — the issuer is counted via its common stock — so only
    4-character common-stock codes are kept.
    """
    request = urllib.request.Request(JPX_LIST_URL, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        blob = response.read(4_000_000)
    archive = zipfile.ZipFile(io.BytesIO(blob))
    shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    strings = ["".join(t.text or "" for t in si.iter(_XLSX_NS + "t"))
               for si in shared_root]
    sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))

    def column_index(ref):
        letters = re.match(r"[A-Z]+", ref).group(0)
        idx = 0
        for ch in letters:
            idx = idx * 26 + (ord(ch) - 64)
        return idx - 1

    membership = {}
    for row in sheet.iter(_XLSX_NS + "row"):
        cells = {}
        for cell in row.findall(_XLSX_NS + "c"):
            value = cell.find(_XLSX_NS + "v")
            if value is None or value.text is None:
                continue
            cells[column_index(cell.get("r"))] = (
                strings[int(value.text)] if cell.get("t") == "s" else value.text)
        code = (cells.get(1) or "").strip()
        industry = (cells.get(5) or "").strip()
        if industry in ("", "-", "33業種区分"):
            continue
        if not re.fullmatch(r"[0-9][0-9A-Z]{3}", code):
            continue
        membership.setdefault(industry, []).append(f"{code}.T")
    membership = {name: sorted(set(tickers))
                  for name, tickers in membership.items()}
    unknown = [n for n in membership if n not in ORDER]
    if len(membership) < 30 or unknown:
        raise RuntimeError(f"JPX list looks wrong: {len(membership)} industries, "
                           f"unknown={unknown}")
    return membership


def load_membership():
    """Official JPX membership first; then the stored one; then Kabubusho."""
    try:
        return jpx_membership(), "jpx"
    except Exception as exc:
        print("JPX_MEMBERSHIP_ERROR", str(exc)[:160], flush=True)
    try:
        stored = json.loads((ROOT / "jp-industries.json").read_text(encoding="utf-8"))
        membership = stored.get("membership") or {}
        if len(membership) >= 30:
            return membership, "stored"
    except Exception as exc:
        print("STORED_MEMBERSHIP_ERROR", str(exc)[:160], flush=True)
    return kabubusho_membership(), "kabubusho"


def aggregate(member_series, weights, calendar):
    """Chain free-float market-cap weighted member returns into an index.

    Weights are float shares (falling back to shares outstanding), fixed
    between refreshes like a real cap-weighted index: each day's return
    is sum(w * close_t) / sum(w * close_{t-1}) - 1 over the members that
    traded on both days. Volume is the plain sum of member volumes.
    """
    weighted = [(prices, weights[i]) for i, prices in enumerate(member_series)
                if weights[i]]
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
            if any(day in prices for prices, _ in weighted):
                level = 1000.0
                series[day] = {"close": level, "low": level,
                               "volume": volume if any_volume else None}
                prev_day = day
            continue
        num = den = low_num = low_den = 0.0
        for prices, weight in weighted:
            today_row = prices.get(day)
            prev_row = prices.get(prev_day) if prev_day else None
            if today_row and prev_row and prev_row["close"]:
                num += weight * today_row["close"]
                den += weight * prev_row["close"]
                if today_row.get("low") is not None:
                    low_num += weight * today_row["low"]
                    low_den += weight * prev_row["close"]
        if den:
            prev_level = level
            level *= num / den
            low_level = prev_level * (low_num / low_den) if low_den else level
            series[day] = {"close": level, "low": low_level,
                           "volume": volume if any_volume else None}
        prev_day = day
    return series


def main():
    membership, membership_source = load_membership()
    total_members = sum(len(v) for v in membership.values())
    unique = sorted({t for tickers in membership.values() for t in tickers})
    print(f"JP_INDUSTRIES membership_source={membership_source} "
          f"industries={len(membership)} memberships={total_members} "
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

    # Stash every member's latest close so the screener's market-cap
    # fallback (close x shares, in update_jp_fundamentals) can price the
    # full universe, not just the leaders' rotating quote batch.
    try:
        closes = {}
        for ticker, history in raw.items():
            if ticker == BENCHMARK or not history:
                continue
            last_day = max(history)
            closes[ticker] = [history[last_day]["close"], last_day]
        (ROOT / "jp-closes.json").write_text(json.dumps(
            {"updated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
             "closes": closes}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8")
        print(f"JP_CLOSES_STASHED {len(closes)}", flush=True)
    except Exception as exc:
        print("JP_CLOSES_STASH_ERROR", str(exc)[:120], flush=True)

    # Free-float weights for the cap-weighted indices. A bounded batch of
    # the stalest tickers refreshes each run (30-day cycle); failures keep
    # the previously stored weights.
    weights = {}
    try:
        from update_jp_float_shares import enrich_float_shares, weights_from_store
        enrich_float_shares(unique, int(os.getenv("JP_FLOAT_BATCH", "600")))
        weights = weights_from_store()
    except Exception as exc:
        print("JP_FLOAT_SHARES_ERROR", str(exc)[:160], flush=True)
        try:
            from update_jp_float_shares import weights_from_store
            weights = weights_from_store()
        except Exception:
            weights = {}
    print(f"JP_INDUSTRIES_WEIGHTS tickers_with_weights={len(weights)}", flush=True)

    calendar = sorted(raw[BENCHMARK])
    enriched = {BENCHMARK: enrich(raw[BENCHMARK])}
    member_counts = {}
    weight_coverage = {}
    for name, tickers in membership.items():
        member_series = [raw[t] for t in tickers if t in raw]
        member_weights = [weights.get(t) for t in tickers if t in raw]
        member_counts[name] = len(member_series)
        weight_coverage[name] = sum(1 for w in member_weights if w)
        if len(member_series) < 3 or weight_coverage[name] < 3:
            print(f"WARNING: industry {name} has only {len(member_series)} usable members "
                  f"({weight_coverage[name]} weighted)")
            continue
        enriched[name] = enrich(aggregate(member_series, member_weights, calendar))

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
        "source": "Industry membership: JPX (Japan Exchange Group) official TSE "
                  "listed-company list (data_j.xlsx), 33-industry classification; "
                  "prices: Yahoo Finance unofficial daily prices; index: free-float "
                  "market-cap weighted chain of member stocks (float shares via "
                  "yfinance), volume: sum of member volumes",
        "benchmark": BENCHMARK,
        "membership_source": membership_source,
        "member_counts": member_counts,
        "weight_coverage": weight_coverage,
        "membership": membership,
        "missing_symbols": failures,
        "note": "業種の所属銘柄はJPX（日本取引所グループ）公式の東証上場銘柄一覧の"
                "33業種区分に基づきます。指数は構成銘柄を"
                "浮動株時価総額加重で計算した参考値、出来高は構成銘柄の合計で、東証の"
                "公式業種別指数ではありません。判定はこの参考指数自身の値動きと出来高に"
                "基づく簡易指標です。",
    }
    (ROOT / "jp-industries.json").write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"WROTE jp-industries.json: {len(rows)} rows, {len(industries)} industries; "
          f"latest={rows[0]['date']}; failed tickers={len(failures)}")


if __name__ == "__main__":
    main()
