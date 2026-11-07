"""Collect real five-minute extended-hours and same-day regular-session data
for multiple U.S. symbols. Keep existing SOXX archive maintained separately.

Archives are updated only with observed Yahoo OHLCV. No intraday resampling,
no invented candles. Intraday backfill is limited to roughly 60 calendar days.
"""
from __future__ import annotations
import datetime as dt
import json
import pathlib
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from zoneinfo import ZoneInfo

from update_soxx_premarket import session_record, positive

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "premarket-universe.json"
ET = ZoneInfo("America/New_York")
UTC = dt.timezone.utc
AGENTS = {"User-Agent": "Mozilla/5.0 (compatible; MarketHistoryResearch/1.0)",
          "Accept": "application/json"}
SYMBOLS = {
    "LLY": "イーライリリー",
    "NVDA": "エヌビディア",
    "AMD": "AMD",
    "AVGO": "ブロードコム",
    "MU": "マイクロン",
    "TSM": "TSMC ADR",
    "INTC": "インテル",
    "MSFT": "マイクロソフト",
    "GOOGL": "アルファベット",
    "AAPL": "アップル",
    "META": "メタ",
    "TSLA": "テスラ",
    "QQQ": "NASDAQ100 ETF",
    "SPY": "S&P500 ETF",
    "NBIS": "ネビウス",
    "AAOI": "アプライド・オプトエレクトロニクス",
    "LITE": "ルメンタム"
}
BACKFILL_DAYS = 56
KEEP_DAYS = 1000
HEADERS = list(("query1.finance.yahoo.com", "query2.finance.yahoo.com"))


def request_chart(symbol: str, interval: str, start: dt.datetime, end: dt.datetime):
    params = urllib.parse.urlencode({
        "period1": int(start.timestamp()),
        "period2": int(end.timestamp()),
        "interval": interval,
        "includePrePost": "true" if interval == "5m" else "false",
    })
    errors = []
    for host in HEADERS:
        url = f"https://{host}/v8/finance/chart/{urllib.parse.quote(symbol)}?{params}"
        try:
            req = urllib.request.Request(url, headers=AGENTS)
            with urllib.request.urlopen(req, timeout=24) as response:
                data = json.load(response)
            result = (data.get("chart", {}).get("result") or [None])[0]
            if not result:
                raise ValueError("empty chart result")
            return result
        except Exception as exc:
            errors.append(f"{host} {type(exc).__name__} {str(exc)[:105]}")
    raise RuntimeError(" | ".join(errors))


def daily_rows(symbol: str, start: dt.datetime, end: dt.datetime):
    result = request_chart(symbol, "1d", start, end)
    quote = (result.get("indicators", {}).get("quote") or [{}])[0]
    rows = {}
    for i, ts in enumerate(result.get("timestamp") or []):
        try:
            date = dt.datetime.fromtimestamp(int(ts), ET).date().isoformat()
            record = [positive((quote.get(k) or [])[i]) for k in ("open","high","low","close")]
            if all(record) and record[1] >= max(record[0], record[3]) and record[2] <= min(record[0], record[3]):
                rows[date] = record
        except (IndexError, TypeError, ValueError):
            continue
    if len(rows) < 3:
        raise ValueError(f"only {len(rows)} valid daily rows")
    return rows


def candles_5m(symbol: str, start: dt.datetime, end: dt.datetime):
    # Two requests, each comfortably within Yahoo's rolling 60-day 5m limit.
    middle = start + (end - start) / 2
    observations = {}
    errors = {}
    for left, right in [(start,middle),(middle,end)]:
        try:
            result = request_chart(symbol, "5m", left, right)
            quote = (result.get("indicators", {}).get("quote") or [{}])[0]
            for i, ts in enumerate(result.get("timestamp") or []):
                try:
                    timestamp = int(ts)
                    moment = dt.datetime.fromtimestamp(timestamp, ET)
                    close = positive((quote.get("close") or [])[i])
                    if not close:
                        continue
                    opening = positive((quote.get("open") or [])[i])
                    high = positive((quote.get("high") or [])[i])
                    low = positive((quote.get("low") or [])[i])
                    v = (quote.get("volume") or [])[i]
                    observations[timestamp] = {
                        "ts": timestamp, "time": moment,
                        "open": opening or close, "close": close,
                        "high": high or close, "low": low or close,
                        "has_high": high is not None, "has_low": low is not None,
                        "volume": int(v) if isinstance(v, (int,float)) and v >= 0 else None,
                    }
                except (ValueError, TypeError, IndexError, OverflowError):
                    continue
        except Exception as exc:
            errors[f"{left.date()}〜{right.date()}"] = str(exc)[:250]
    grouped = defaultdict(list)
    for row in observations.values():
        grouped[row["time"].date().isoformat()].append(row)
    return grouped, errors, len(observations)


def update_one(symbol: str, older: dict, now: dt.datetime):
    existing = {}
    retain = (now.date()-dt.timedelta(days=KEEP_DAYS)).isoformat()
    for date, row in (older.get("days") or {}).items():
        if date >= retain and isinstance(row, dict) and isinstance(row.get("regular_return"), (float,int)):
            existing[date] = row
    after = now.date()-dt.timedelta(days=BACKFILL_DAYS)
    start = dt.datetime.combine(after, dt.time(0), tzinfo=ET)
    end = now
    errors = {}
    new_count = 0
    records = 0
    diagnostics = {"daily_days": 0, "intraday_days": 0, "paired_days": 0, "rejected_samples": []}
    try:
        daily = daily_rows(symbol, start-dt.timedelta(days=8), end)
        grouped, fetch_errors, records = candles_5m(symbol, start, end)
        diagnostics["daily_days"] = len(daily)
        diagnostics["intraday_days"] = len(grouped)
        errors.update(fetch_errors)
        days = sorted(daily)
        for i, day in enumerate(days):
            if i == 0 or day < after.isoformat() or day > now.date().isoformat():
                continue
            if day == now.date().isoformat() and now.time() < dt.time(16,20):
                continue
            if day not in grouped:
                continue
            diagnostics["paired_days"] += 1
            # Some valid Yahoo tickers (LLY, TSM, SPY) stop observed 5m
            # premarket candles at 09:10 ET, not 09:15. Do not invent
            # the omitted 09:15 candle; use the actual latest observation.
            obj = session_record(day, grouped[day], daily, days[i-1],
                                 latest_required_pre_bar=dt.time(9,10))
            if obj:
                if day not in existing:
                    new_count += 1
                existing[day] = obj
            elif len(diagnostics["rejected_samples"]) < 3:
                pre = [r for r in grouped[day]
                       if dt.time(4) <= r["time"].time() < dt.time(9,30)]
                pre.sort(key=lambda r: r["ts"])
                diagnostics["rejected_samples"].append({
                    "day": day, "rows": len(grouped[day]), "pre_bars": len(pre),
                    "first": pre[0]["time"].strftime("%H:%M") if pre else None,
                    "last": pre[-1]["time"].strftime("%H:%M") if pre else None,
                })
    except Exception as exc:
        errors["symbol"] = str(exc)[:350]
    payload = {
        "version": 2, "symbol": symbol, "updated_at": now.astimezone(UTC).isoformat(timespec="seconds"),
        "source": "Yahoo Finance unadjusted 5m extended-hours + 1d regular OHLCV",
        "days": dict(sorted(existing.items())),
        "fetch_errors": errors,
        "last_fetch_candles": records,
        "diagnostics": diagnostics,
    }
    return payload, new_count, errors


def main():
    now=dt.datetime.now(ET)
    try:
        existing=json.loads(ARCHIVE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        existing={}
    old=existing.get("stocks") or {}
    stocks=dict(old)
    # Avoid hammering Yahoo Finance with all 17 simultaneous requests.
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures={pool.submit(update_one,symbol,old.get(symbol) or {},now):symbol for symbol in SYMBOLS}
        for future in as_completed(futures):
            symbol=futures[future]
            try:
                payload,added,errors=future.result()
                stocks[symbol]=payload
                print(symbol,"days",len(payload["days"]),"added",added,
                      "observed_bars",payload["last_fetch_candles"],
                      "errors",len(errors),flush=True)
            except Exception as exc:
                print("WARN",symbol,type(exc).__name__,str(exc)[:200],flush=True)
    # Keep data for any previous symbols that aren't currently in the default menu.
    output={
        "version": 1,
        "updated_at":now.astimezone(UTC).isoformat(timespec="seconds"),
        "symbols": {"SOXX":"半導体ETF",**SYMBOLS},
        "stocks": stocks,
        "methodology": "Same-date five-minute premarket and finalized daily OHLCV. No synthetic candles.",
        "sampling_limit": "Around 60 calendar days for newly requested five-minute history; archived daily."
    }
    ARCHIVE.write_text(json.dumps(output,ensure_ascii=False,separators=(",",":")),encoding="utf-8")
    print("WROTE",ARCHIVE.name,"tickers",len(stocks),
          "with_observations",sum(bool(s.get("days")) for s in stocks.values()),flush=True)

if __name__=="__main__":
    main()
