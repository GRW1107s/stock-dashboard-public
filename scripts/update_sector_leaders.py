"""Refresh the full TSE ordinary-share universe and incremental chart screening.

Monthly JPX listed issues master defines sector memberships. Quote collection
rotates over thousands of symbols to avoid overwhelming unofficial feeds.
Data coverage and as-of dates are explicit; no missing financials are inferred.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, time as clock_time
from pathlib import Path
from zoneinfo import ZoneInfo
import csv
import io
import json
import os
import math
import re
import time
from urllib.error import HTTPError
from jpx_universe import latest_universe
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "sector-leaders.json"
UA = "Mozilla/5.0 (compatible; StockDashboard/1.0; personal investment research)"
HEADERS = {"User-Agent": UA, "Accept": "application/json"}
MAX_WORKERS = 7
JP_NEW_PER_RUN = 260
JP_REFRESH_PER_RUN = max(1, min(2500, int(os.getenv('JP_REFRESH_PER_RUN', '650'))))
JP_REFRESH_AFTER_DAYS = 4
US_NEW_PER_RUN = 220
US_REFRESH_PER_RUN = 100
US_REFRESH_AFTER_DAYS = 3
US_UNIVERSE_LIMIT = 1800

SP500_MASTER_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
US_LISTED_MASTER_URL = "https://raw.githubusercontent.com/zyhe16/top-us-stock-tickers/main/data/v2/tickers.csv"

US_GICS_SECTORS = {
    "Information Technology": ("XLK", "情報技術"),
    "Communication Services": ("XLC", "通信サービス"),
    "Consumer Discretionary": ("XLY", "一般消費財"),
    "Consumer Staples": ("XLP", "生活必需品"),
    "Energy": ("XLE", "エネルギー"),
    "Financials": ("XLF", "金融"),
    "Health Care": ("XLV", "ヘルスケア"),
    "Industrials": ("XLI", "資本財"),
    "Materials": ("XLB", "素材"),
    "Real Estate": ("XLRE", "不動産"),
    "Utilities": ("XLU", "公益"),
}
US_NASDAQ_SECTORS = {
    "Technology": "Information Technology",
    "Telecommunications": "Communication Services",
    "Communications": "Communication Services",
    "Consumer Discretionary": "Consumer Discretionary",
    "Consumer Staples": "Consumer Staples",
    "Energy": "Energy",
    "Finance": "Financials",
    "Financial Services": "Financials",
    "Health Care": "Health Care",
    "Healthcare": "Health Care",
    "Industrials": "Industrials",
    "Basic Materials": "Materials",
    "Real Estate": "Real Estate",
    "Utilities": "Utilities",
}
US_NON_EQUITY = re.compile(
    r"(?i)\b(?:warrant|warrants|rights|units|preferred|preference|"
    r"etf|etn|exchange traded fund|exchange-traded fund|closed.end fund|"
    r"mandatory convertible|depositary shares representing a fraction)\b"
)



def csv_table(url, minimum):
    request = Request(url, headers=HEADERS)
    with urlopen(request, timeout=35) as response:
        content = response.read(2_200_000).decode("utf-8-sig", errors="replace")
    rows = list(csv.DictReader(io.StringIO(content)))
    if len(rows) < minimum:
        raise ValueError(f"Insufficient listing rows ({len(rows)}) from {url}")
    return rows


def normalize_us_symbol(value):
    """Yahoo chart uses BRK-B, while Nasdaq listings sometimes use BRK/B."""
    symbol = str(value or "").strip().upper().replace("/", "-").replace(".", "-")
    return symbol if re.fullmatch(r"[A-Z]{1,5}(?:-[A-Z])?", symbol) else None


def clean_industry(value):
    """Keep the source's detailed industry without guessing from company names."""
    name = str(value or "").strip()
    return name if name and name.casefold() not in {"n/a", "na", "none", "null", "nan", "--"} else None


def recent_market_cap(row, *, today=None, refresh_days=60):
    """Keep a dated USD market-cap snapshot for a while; do not relabel it as new."""
    today = today or datetime.now(ZoneInfo("UTC")).date()
    if row.get("market_cap_currency") != "USD":
        return False
    cap = safe_num(row.get("market_cap"))
    if cap is None or cap <= 0:
        return False
    try:
        age = (today - datetime.fromisoformat(row["market_cap_asof"]).date()).days
    except (KeyError, TypeError, ValueError):
        return False
    return 0 <= age < refresh_days


def latest_us_universe(previous_stocks):
    """S&P500 membership plus major US-listed ordinary/ADR equity shares.

    Metadata comes from third-party public CSVs and is NOT market-price data.
    Live historical price/volume remains from independent daily chart reads.
    """
    old = {row["ticker"]: row for row in previous_stocks if isinstance(row, dict) and row.get("ticker")}
    master = {}
    provenance = {}
    try:
        sp_rows = csv_table(SP500_MASTER_URL, 470)
        for row in sp_rows:
            ticker = normalize_us_symbol(row.get("Symbol"))
            gics = row.get("GICS Sector")
            if ticker and gics in US_GICS_SECTORS:
                sector, name = US_GICS_SECTORS[gics]
                master[ticker] = {
                    "ticker": ticker, "name": row.get("Security") or ticker,
                    "sector": sector, "sector_name": name,
                    "gics_sector": gics, "universe_group": "S&P500",
                    "industry_name": clean_industry(row.get("GICS Sub-Industry")),
                    "industry_source": "S&P500 GICS Sub-Industry",
                    "cik": int(row["CIK"]) if str(row.get("CIK", "")).strip().isdigit() else None
                }
        provenance["sp500_rows"] = len(sp_rows)
        print("US_SP500_MASTER", len(sp_rows), "valid", len(master), flush=True)
    except Exception as err:
        provenance["sp500_error"] = str(err)[:170]
        print("US_SP500_MASTER_ERROR", err, flush=True)

    others = {}
    listed_caps = {}
    try:
        listed_rows = csv_table(US_LISTED_MASTER_URL, 3000)
        for row in listed_rows:
            ticker = normalize_us_symbol(row.get("symbol"))
            cap = safe_num(row.get("market_cap"))
            if ticker and cap is not None and cap > 0:
                # Snapshot supplied by Nasdaq-derived listing catalogue;
                # it is NOT a real-time market-cap quotation.
                listed_caps[ticker] = round(cap)
        for row in listed_rows:
            ticker = normalize_us_symbol(row.get("symbol"))
            if not ticker:
                continue
            gics = US_NASDAQ_SECTORS.get(row.get("sector", ""))
            if gics not in US_GICS_SECTORS:
                continue
            name = str(row.get("name") or ticker).strip()
            if US_NON_EQUITY.search(name):
                continue
            cap = safe_num(row.get("market_cap"))
            if cap is None or cap < 1_000_000_000:
                continue
            sector, sector_name = US_GICS_SECTORS[gics]
            others[ticker] = {
                "ticker": ticker, "name": name, "sector": sector,
                "sector_name": sector_name, "gics_sector": gics,
                "industry_name": clean_industry(row.get("industry")),
                "industry_source": "Nasdaq screener Industry",
                "universe_group": "US listed major equities",
                "_market_cap_for_selection": cap,
            }
        # Rank by source snapshot cap only for deciding what to cover.
        # Never present the snapshot cap as a current valuation.
        chosen = sorted(others.values(),
                        key=lambda row: (-row["_market_cap_for_selection"],row["ticker"]))
        for row in chosen:
            if len(master) >= US_UNIVERSE_LIMIT:
                break
            ticker = row["ticker"]
            if ticker in master:
                continue
            row.pop("_market_cap_for_selection", None)
            master[ticker] = row
        provenance["listed_rows"] = len(listed_rows)
        provenance["eligible_listed"] = len(others)
        provenance["market_cap_snapshot_downloaded_at"] = datetime.now(ZoneInfo("UTC")).date().isoformat()
        print("US_LISTED_MASTER",len(listed_rows),"eligible",len(others),"selected",len(master),flush=True)
    except Exception as err:
        provenance["listed_error"] = str(err)[:170]
        print("US_LISTED_MASTER_ERROR",err,flush=True)

    # Preserve the original hand-selected growth stocks, even outside top-cap coverage.
    # Also preserve previously enrolled rows if the listing feeds are down.
    for ticker, item in old.items():
        if ticker not in master and (len(old) <= 80 or not master or
                                     "listed_error" in provenance or "sp500_error" in provenance):
            master[ticker] = {
                "ticker": ticker, "name": item.get("name") or ticker,
                "sector": item.get("sector"), "sector_name": item.get("sector_name"),
                "industry_name": item.get("industry_name"), "industry_source": item.get("industry_source"),
                "universe_group": "original watchlist",
            }
    if len(master) < 100 and len(old) > 80:
        # On a temporary source outage retain the prior large universe.
        for ticker, item in old.items():
            master[ticker] = {
                "ticker": ticker,"name":item.get("name") or ticker,
                "sector": item.get("sector"),"sector_name": item.get("sector_name"),
                "industry_name": item.get("industry_name"),"industry_source": item.get("industry_source"),
                "universe_group": item.get("universe_group") or "previous listing"
            }
    snapshot_date = provenance.get("market_cap_snapshot_downloaded_at")
    provenance["market_cap_refresh_days"] = 60
    for ticker, meta in master.items():
        cap = listed_caps.get(ticker)
        old_cap = old.get(ticker) or {}
        if recent_market_cap(old_cap):
            # Other universe metadata still refreshes; valuation stays at the
            # original date until its 60-day cooldown expires.
            meta.update({
                k: old_cap[k] for k in (
                    "market_cap", "market_cap_currency",
                    "market_cap_asof", "market_cap_source"
                ) if k in old_cap
            })
        elif cap is not None and snapshot_date:
            meta["market_cap"] = cap
            meta["market_cap_currency"] = "USD"
            meta["market_cap_asof"] = snapshot_date
            meta["market_cap_source"] = "Nasdaq screener snapshot via top-us-stock-tickers"
        elif safe_num(old_cap.get("market_cap")) is not None:
            # If the feed is unavailable, keep older data and its true date.
            meta.update({
                k: old_cap[k] for k in (
                    "market_cap", "market_cap_currency",
                    "market_cap_asof", "market_cap_source"
                ) if k in old_cap
            })
    result = []
    for ticker, meta in master.items():
        if not meta.get("sector") or not meta.get("sector_name"):
            continue
        item = dict(old.get(ticker) or {})
        item.update(meta)
        result.append(item)
    provenance["universe"] = len(result)
    provenance["industry_coverage"] = sum(bool(row.get("industry_name")) for row in result)
    provenance["industry_note"] = "S&P500: GICS Sub-Industry; other US listings: Nasdaq Industry. Different taxonomies."
    provenance["price_data_source"] = "Yahoo Finance unofficial 1d chart API, rolling batch"
    provenance["listing_source"] = [SP500_MASTER_URL, US_LISTED_MASTER_URL]
    return result, provenance


def safe_num(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def pct(now, before):
    return round((now / before - 1) * 100, 3) if now and before and before > 0 else None


def ma_snapshot(prices, periods=(20, 50, 200)):
    """Position of the latest completed close relative to each simple MA."""
    result = {}
    for period in periods:
        recent = prices[-period:]
        name = f"ma{period}"
        if len(recent) != period or any(safe_num(v) is None or v <= 0 for v in recent):
            result[name] = None
            result[name + "_position"] = None
            continue
        average = sum(recent) / period
        close = recent[-1]
        result[name] = round(average, 4)
        result[name + "_position"] = (
            "above" if close > average else "below" if close < average else "equal"
        )
    return result


def ma20_snapshot(prices):
    """Compatibility wrapper for existing tests and 20MA consumers."""
    return ma_snapshot(prices, periods=(20,))



def risk_metrics(stock_returns, benchmark_returns=None, *, minimum=120):
    """Price-return beta and annualized Sharpe for the last 252 daily observations.

    Sharpe uses zero risk-free rate and sample standard deviation; a benchmark
    must have >=120 overlapping daily returns for beta to be meaningful.
    These metrics describe closing-price returns, not dividend-adjusted total returns.
    """
    series = sorted(stock_returns.items())[-252:]
    values = [float(value) for _, value in series if math.isfinite(value)]
    result = {
        "sharpe_252d": None, "beta_252d": None,
        "sharpe_samples": len(values), "beta_samples": 0,
    }
    if len(values) >= minimum:
        avg = sum(values) / len(values)
        variance = sum((value - avg) ** 2 for value in values) / (len(values) - 1)
        if variance > 0:
            result["sharpe_252d"] = round(avg / math.sqrt(variance) * math.sqrt(252), 3)
    if benchmark_returns:
        matched = [(stock_value, benchmark_returns[day]) for day, stock_value in series
                   if day in benchmark_returns and math.isfinite(benchmark_returns[day])]
        result["beta_samples"] = len(matched)
        if len(matched) >= minimum:
            xavg = sum(x for x, _ in matched) / len(matched)
            yavg = sum(y for _, y in matched) / len(matched)
            denominator = sum((y - yavg) ** 2 for _, y in matched)
            if denominator > 0:
                result["beta_252d"] = round(
                    sum((x - xavg) * (y - yavg) for x, y in matched) / denominator, 3
                )
    return result


def obtain(symbol, market):
    end = int(time.time()) + 86400
    start = end - 455 * 86400
    query = urlencode({"period1": start, "period2": end, "interval": "1d"})
    exchange_zone = ZoneInfo("Asia/Tokyo" if market == "jp" else "America/New_York")
    last_error = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        for attempt in range(2):
            try:
                url = f"https://{host}/v8/finance/chart/{quote(symbol, safe='')}?{query}"
                request = Request(url, headers=HEADERS)
                with urlopen(request, timeout=17) as response:
                    payload = json.loads(response.read(1_400_000))
                record = payload["chart"]["result"][0]
                quote_data = record["indicators"]["quote"][0]
                now = datetime.now(exchange_zone)
                days = []
                for timestamp, close, volume in zip(
                    record["timestamp"], quote_data["close"], quote_data["volume"]
                ):
                    close = safe_num(close)
                    if close is None or close <= 0:
                        continue
                    date = datetime.fromtimestamp(timestamp, exchange_zone).date()
                    if date == now.date():
                        cutoff = clock_time(15, 35) if market == "jp" else clock_time(16, 15)
                        if now.time() < cutoff:
                            continue
                    days.append((date.isoformat(), close, safe_num(volume)))
                days = sorted({day: (day, price, volume) for day, price, volume in days}.values())
                if len(days) < 63:
                    raise ValueError("Not enough completed market sessions")
                prices = [day[1] for day in days]
                volumes = [day[2] for day in days]
                close = prices[-1]
                previous_vols = [volume for volume in volumes[-21:-1] if volume is not None]
                mean_volume = sum(previous_vols) / len(previous_vols) if len(previous_vols) >= 15 else None
                rvol = round(volumes[-1] / mean_volume, 3) if volumes[-1] is not None and mean_volume and mean_volume > 0 else None
                ceiling = max(prices[-252:])
                daily_returns = {
                    days[i][0]: prices[i] / prices[i - 1] - 1
                    for i in range(1, len(days)) if prices[i - 1] > 0
                }
                return {
                    "_daily_returns": daily_returns,
                    "asof": days[-1][0],
                    "close": round(close, 3),
                    **ma_snapshot(prices),
                    "change_1d": pct(close, prices[-2]),
                    "return_3d": pct(close, prices[-4]) if len(prices) >= 4 else None,
                    "return_10d": pct(close, prices[-11]) if len(prices) >= 11 else None,
                    "return_20d": pct(close, prices[-21]) if len(prices) >= 21 else None,
                    "return_25d": pct(close, prices[-26]) if len(prices) >= 26 else None,
                    "return_60d": pct(close, prices[-61]),
                    "return_120d": pct(close, prices[-121]) if len(prices) >= 121 else None,
                    "return_63d": pct(close, prices[-64]) if len(prices) >= 64 else None,
                    "return_126d": pct(close, prices[-127]) if len(prices) >= 127 else None,
                    "return_189d": pct(close, prices[-190]) if len(prices) >= 190 else None,
                    "return_252d": pct(close, prices[-253]) if len(prices) >= 253 else None,
                    "high52_distance_pct": round(100 * (ceiling - close) / ceiling, 2) if ceiling else None,
                    "rvol20": rvol,
                    "observed_sessions": len(days),
                }
            except Exception as err:
                last_error = err
                time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"{symbol}: {str(last_error)[:110]}")


RS_PERIODS = (("return_63d", 0.4), ("return_126d", 0.2),
              ("return_189d", 0.2), ("return_252d", 0.2))


def rs_weighted_return(stock):
    """IBD-inspired publicly documented approximation; percent units.

    Not the proprietary IBD RS Rating. Four trailing horizons, with
    extra weight on the most recent 63 completed trading sessions.
    """
    values = [safe_num(stock.get(key)) for key, _ in RS_PERIODS]
    if any(v is None for v in values):
        return None
    return round(sum(v * weight for v, (_, weight) in zip(values, RS_PERIODS)), 4)


def quote_recent(stock, market):
    date = stock.get("asof")
    zone = ZoneInfo("Asia/Tokyo" if market == "jp" else "America/New_York")
    try:
        age = (datetime.now(zone).date() - datetime.fromisoformat(date).date()).days
        return 0 <= age <= 9
    except (ValueError, TypeError, AttributeError):
        return False


def enrich(stocks, market="us", benchmark=None):
    """Rank 1–99 by stock-to-stock performance; SP500 comparison is separate.

    The percentile is only among eligible recently priced members of this
    dashboard's universe; a score of 99 must NEVER be called 99% of the
    entire US equity market until full-universe coverage is obtained.
    """
    present = []
    benchmark_score = rs_weighted_return(benchmark or {})
    benchmark_recent = bool(benchmark and quote_recent(benchmark, "us"))
    for stock in stocks:
        score = rs_weighted_return(stock)
        valid = score is not None and quote_recent(stock, market)
        stock["rs_weighted_return_pct"] = score if valid else None
        stock["rs_sp500_delta_pp"] = (
            round(score - benchmark_score, 3)
            if valid and market == "us" and benchmark_recent
            and stock.get("asof") == benchmark.get("asof")
            and benchmark_score is not None else None
        )
        # Stale values from previous scoring methods must never linger.
        stock["rs_universe_pct"] = None
        stock["sector_rank"] = None
        stock["sector_count"] = None
        if valid:
            present.append(stock)

    present.sort(key=lambda stock: (stock["rs_weighted_return_pct"], stock["ticker"]))
    n = len(present)
    for rank, stock in enumerate(present):
        stock["rs_universe_pct"] = round(1 + 98 * rank / (n - 1)) if n > 1 else None

    valid_symbols = {stock["ticker"] for stock in present}
    groups = {}
    for stock in stocks:
        if stock["ticker"] in valid_symbols and safe_num(stock.get("return_60d")) is not None:
            groups.setdefault(stock["sector"], []).append(stock)
    for group in groups.values():
        group.sort(key=lambda stock: (-stock["return_60d"], stock["ticker"]))
        for rank, stock in enumerate(group, 1):
            stock["sector_rank"] = rank
            stock["sector_count"] = len(group)
    return n


def fair_missing_order(stocks):
    """Round-robin across sectors so a partial scan does not favor only the first industry."""
    grouped = {}
    for stock in stocks:
        if not stock.get("asof"):
            grouped.setdefault(stock["sector"], []).append(stock)
    for group in grouped.values():
        group.sort(key=lambda stock: stock["ticker"])
    result = []
    sectors = sorted(grouped)
    depth = 0
    while sectors:
        remaining = []
        for sector in sectors:
            group = grouped[sector]
            if len(group) > depth:
                result.append(group[depth])
            if len(group) > depth + 1:
                remaining.append(sector)
        sectors = remaining
        depth += 1
    return result


def issue_candidates(stocks, *, new_per_run=JP_NEW_PER_RUN,
                     refresh_per_run=JP_REFRESH_PER_RUN,
                     refresh_after_days=JP_REFRESH_AFTER_DAYS):
    """Collect unknown issues first; refresh the oldest quotes in remaining capacity."""
    missing = fair_missing_order(stocks)
    fresh = missing[:new_per_run]
    now = datetime.now(ZoneInfo("Asia/Tokyo")).date()
    stale = []
    for stock in stocks:
        if stock in fresh:
            continue
        date = stock.get("asof")
        if not date:
            continue
        try:
            days = (now - datetime.fromisoformat(date).date()).days
        except (ValueError, TypeError):
            days = 10000
        if days >= refresh_after_days:
            stale.append((days, stock))
    stale.sort(key=lambda item: (-item[0], item[1]["ticker"]))
    refresh_budget = refresh_per_run if missing else new_per_run + refresh_per_run
    selection = fresh + [item for _, item in stale[:refresh_budget]]
    # Existing 51 historical seed stocks retain their prior quote until scanned again.
    return selection, len(missing)


def fetch_charts(stocks, market, benchmark_returns=None, benchmark_symbol=None):
    success = 0
    failures = 0
    if not stocks:
        return success, failures
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        jobs = {pool.submit(obtain, stock["ticker"], market): stock for stock in stocks}
        for task in as_completed(jobs):
            stock = jobs[task]
            try:
                data = task.result()
                daily = data.pop("_daily_returns", {})
                data.update(risk_metrics(daily, benchmark_returns))
                data["risk_benchmark"] = benchmark_symbol if benchmark_returns else None
                stock.update(data)
                success += 1
            except Exception as error:
                failures += 1
                if failures <= 15:
                    print("QUOTE_MISSING", market, error, flush=True)
    return success, failures


def main():
    # Public edition: bootstrap an empty archive on the first run.
    previous = json.loads(ARCHIVE.read_text(encoding="utf-8")) if ARCHIVE.exists() else {}
    output = dict(previous)
    output["updated_at"] = datetime.now(ZoneInfo("UTC")).isoformat(timespec="seconds")
    output["source"] = "JPX monthly listed-issues catalogue (TSE sector/market) + Yahoo Finance unofficial daily close and volume"
    output["universe_note"] = (
        "JP uses JPX-listed domestic ordinary-share codes across Prime, Standard and Growth. "
        "US uses S&P 500 members plus largest sector-classified US-listed equities/ADRs, "
        "not the whole U.S. market. Screening quotes are collected in rolling daily "
        "batches. RS 1–99 ranks are provisional within fresh quoted stocks only, "
        "not necessarily all public companies."
    )
    output["method"] = {
        "high52_distance_pct": "Distance from highest available daily closing price of last up to 252 sessions",
        "rvol20": "Last completed volume divided by mean volume of prior 20 sessions",
        "market_cap": "Nasdaq-screener-derived market cap snapshots for US listings, USD, as-of collection date. Not a real-time valuation. For JP, only show if a verified capitalisation feed with date/currency is available.",
        "rs_universe_pct": "IBD-inspired proxy 1–99 percentile rank of 0.4*63d+0.2*126d+0.2*189d+0.2*252d price returns among fresh eligible stocks in the current market universe. Not IBD's proprietary rating, and not a percentile across all listed stocks.",
        "rs_weighted_return_pct": "Approximate weighted trailing returns, with horizons 63/126/189/252 completed sessions and weights 40/20/20/20 (%).",
        "rs_sp500_delta_pp": "US stocks only: weighted trailing price return minus S&P 500 (^GSPC) over the same horizons, percentage points, only with exactly matching last close dates.",
        "sector_rank": "60-session return rank only among recently priced same-sector stocks, not necessarily all listed names",
        "beta_252d": "Covariance of individual and benchmark daily closing-price returns divided by benchmark variance, last at most 252 returns and at least 120 matched observations. Japan benchmark TOPIX ETF 1306.T; US S&P500 ^GSPC.",
        "sharpe_252d": "Annualized mean daily close-to-close return divided by sample standard deviation times sqrt(252), risk-free rate assumed zero; last at most 252 returns, at least 120.",

    }

    # Keep previously verified quotes but always replace the stock identity,
    # market and official TOPIX-17 classification from JPX.
    previous_jp = {item["ticker"]: item for item in previous.get("jp", [])}
    sector_file = ROOT / "jp-sectors.json"
    sectors = json.loads(sector_file.read_text(encoding="utf-8")).get("names", {})
    master_available = False
    try:
        all_listed, meta = latest_universe(sectors)
        master_available = True
        current_jp = []
        for identity in all_listed:
            current = dict(previous_jp.get(identity["ticker"], {}))
            current.update(identity)
            current_jp.append(current)
        output["jp_master"] = meta
        print("JPX_UNIVERSE", len(current_jp), meta.get("market_counts"), flush=True)
    except Exception as error:
        print("JPX_MASTER_ERROR", error, "keeping prior universe", flush=True)
        current_jp = [dict(stock) for stock in previous.get("jp", [])]
        output["jp_master_error"] = str(error)[:200]
    if master_available:
        output.pop("jp_master_error", None)
    selected, unpriced = issue_candidates(current_jp)
    jp_benchmark_returns = None
    try:
        jp_benchmark = obtain("1306.T", "jp")
        jp_benchmark_returns = jp_benchmark.pop("_daily_returns")
        output["jp_risk_benchmark_asof"] = jp_benchmark.get("asof")
        output.pop("jp_risk_benchmark_error", None)
    except Exception as err:
        output["jp_risk_benchmark_error"] = str(err)[:180]
        print("JP_RISK_BENCHMARK_ERROR", err, flush=True)
    jp_ok, jp_fail = fetch_charts(selected, "jp", jp_benchmark_returns, "1306.T")
    jp_rs = enrich(current_jp, "jp")
    output["jp"] = current_jp
    priced = sum(1 for item in current_jp if item.get("asof"))
    output["jp_coverage"] = {
        "universe": len(current_jp),
        "priced": priced,
        "unpriced": len(current_jp) - priced,
        "fresh_rs": jp_rs,
        "with_beta": sum(item.get("beta_252d") is not None for item in current_jp),
        "with_sharpe": sum(item.get("sharpe_252d") is not None for item in current_jp),
        "rs_missing_short_history": sum(item.get("return_252d") is None for item in current_jp),
        "rs_missing_stale_quotes": sum(
            item.get("return_252d") is not None and not quote_recent(item, "jp")
            for item in current_jp
        ),
        "attempted_this_run": len(selected),
        "success_this_run": jp_ok,
        "failed_this_run": jp_fail,
        "complete": len(current_jp) > 3000 and priced / len(current_jp) >= 0.95,
    }
    print("JP_COVERAGE", output["jp_coverage"], flush=True)

    # JP fundamentals enrichment: EPS growth, ROE and JPY market cap from
    # Yahoo Finance statements (rolling batch, 60-day refresh). A failure
    # here must never block the price pipeline.
    try:
        from update_jp_fundamentals import enrich_jp_fundamentals
        enrich_jp_fundamentals(output, int(os.getenv("JP_FUND_BATCH", "4000")))
    except Exception as err:
        print("JP_FUNDAMENTALS_ERROR", str(err)[:180], flush=True)

    # Kabutan supplement: Yahoo statements rarely carry the previous
    # quarter, so fill still-missing quarterly EPS growth from Kabutan's
    # discrete-quarter results. Never overwrites Yahoo-derived values.
    try:
        from update_jp_kabutan_eps import enrich_jp_kabutan_eps
        enrich_jp_kabutan_eps(output, int(os.getenv("JP_KABUTAN_EPS_BATCH", "4000")))
    except Exception as err:
        print("JP_KABUTAN_EPS_ERROR", str(err)[:180], flush=True)

    # S&P 500 membership plus leading US-listed ordinary shares and ADRs.
    # A universe entry without Yahoo OHLCV remains explicitly unpriced.
    current_us, us_master = latest_us_universe(previous.get("us", []))
    us_selected, us_missing = issue_candidates(
        current_us, new_per_run=US_NEW_PER_RUN,
        refresh_per_run=US_REFRESH_PER_RUN,
        refresh_after_days=US_REFRESH_AFTER_DAYS)
    # S&P500 benchmark is fetched before the US ticker batch to calculate beta.
    sp500_benchmark = dict(previous.get("sp500_benchmark") or {})
    us_benchmark_returns = None
    try:
        sp500_benchmark = obtain("^GSPC", "us")
        us_benchmark_returns = sp500_benchmark.pop("_daily_returns")
        sp500_benchmark["symbol"] = "^GSPC"
        sp500_benchmark["rs_weighted_return_pct"] = rs_weighted_return(sp500_benchmark)
        output.pop("sp500_benchmark_error", None)
    except Exception as err:
        output["sp500_benchmark_error"] = str(err)[:180]
        print("SP500_RS_BENCHMARK_ERROR", err, flush=True)
    us_ok, us_fail = fetch_charts(us_selected, "us", us_benchmark_returns, "^GSPC")
    output["sp500_benchmark"] = sp500_benchmark
    # A dated USD/JPY quote is required to convert USD capitalization to JPY.
    # Preserve the previously verified rate when the quote endpoint is down.
    usd_jpy = dict(previous.get("usd_jpy") or {})
    try:
        fx_quote = obtain("JPY=X", "us")
        fx_quote.pop("_daily_returns", None)
        fx_rate = safe_num(fx_quote.get("close"))
        if fx_rate is None or not 50 < fx_rate < 300:
            raise ValueError("USD/JPY observation out of expected currency range")
        usd_jpy = {
            "rate": round(fx_rate, 4), "asof": fx_quote.get("asof"),
            "source": "Yahoo Finance JPY=X daily close (USD/JPY)",
        }
        output.pop("usd_jpy_error", None)
    except Exception as err:
        output["usd_jpy_error"] = str(err)[:150]
        print("USD_JPY_RATE_ERROR", err, flush=True)
    output["usd_jpy"] = usd_jpy
    print("USD_JPY_RATE", usd_jpy, flush=True)
    us_rs = enrich(current_us, "us", benchmark=sp500_benchmark)
    print("SP500_RS_BENCHMARK", sp500_benchmark.get("asof"),
          sp500_benchmark.get("rs_weighted_return_pct"), flush=True)
    output["us"] = current_us
    priced_us = sum(1 for stock in current_us if stock.get("asof"))
    output["us_master"] = us_master
    output["us_coverage"] = {
        "universe": len(current_us), "priced": priced_us,
        "unpriced": len(current_us)-priced_us, "fresh_rs": us_rs,
        "with_beta": sum(item.get("beta_252d") is not None for item in current_us),
        "with_sharpe": sum(item.get("sharpe_252d") is not None for item in current_us),
        "sp500_comparison_count": sum(stock.get("rs_sp500_delta_pp") is not None for stock in current_us),
        "attempted_this_run": len(us_selected),
        "success_this_run": us_ok, "failed_this_run": us_fail,
        "complete": len(current_us)>1000 and priced_us/max(1,len(current_us)) >= .95
    }
    print("US_COVERAGE", output["us_coverage"], flush=True)
    ARCHIVE.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("WROTE", ARCHIVE.name, flush=True)


if __name__ == "__main__":
    main()
