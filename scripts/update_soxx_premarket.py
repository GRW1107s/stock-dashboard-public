"""Archive SOXX US premarket 5-minute candles versus SAME-DAY regular session.

Source: Yahoo Finance unofficial chart endpoint, interval=5m, includePrePost=true.
Premarket: America/New_York 04:00–09:30. Regular: DAILY OHLC 09:30–16:00.
For completed sessions only; do not invent missing premarket candles or data.
The archive accumulates beyond the provider's ~60-day intraday lookback.

All percent returns are unadjusted close/open price returns, not dividends.
Premarket peak-to-trough drawdown uses observed 5-minute bar closes and the
first observed bar OPEN (not unknowable high/low temporal order within a bar).
"""

import datetime as dt
import json
import math
import pathlib
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEST = ROOT / "soxx-premarket.json"
DAILY = ROOT / "us-semiconductors.json"
ET = ZoneInfo("America/New_York")
UTC = dt.timezone.utc
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; PersonalSOXXPremarketResearch/1.0)",
    "Accept": "application/json",
}
BACKFILL_DAYS = 56
CHUNK_DAYS = 13
ARCHIVE_DAYS = 1000
MIN_PRE_BARS = 4
EARLIEST_ALLOWED_START = dt.time(8, 30)
LATEST_REQUIRED_PRE_BAR = dt.time(9, 15)


def positive(value):
    try:
        value = float(value)
        return value if math.isfinite(value) and value > 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def valid_number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError, OverflowError):
        return None


def pct(after, before):
    return round((after / before - 1.0) * 100, 5)


def fetch_window(start, end):
    params = urllib.parse.urlencode({
        "period1": int(start.timestamp()),
        "period2": int(end.timestamp()),
        "interval": "5m",
        "includePrePost": "true",
        "events": "history",
    })
    errors = []
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        url = f"https://{host}/v8/finance/chart/SOXX?{params}"
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, headers=HEADERS)
                with urllib.request.urlopen(req, timeout=24) as response:
                    obj = json.load(response)
                results = obj.get("chart", {}).get("result") or []
                if not results:
                    raise ValueError("Yahoo returned no chart result")
                result = results[0]
                times = result.get("timestamp") or []
                quotes = (result.get("indicators", {}).get("quote") or [{}])[0]
                rows = []
                for i, ts in enumerate(times):
                    def value(key):
                        arr = quotes.get(key) or []
                        return arr[i] if i < len(arr) else None
                    if not isinstance(ts, (float, int)):
                        continue
                    moment = dt.datetime.fromtimestamp(ts, ET)
                    opening = positive(value("open"))
                    closing = positive(value("close"))
                    if not closing:
                        continue
                    high = positive(value("high"))
                    low = positive(value("low"))
                    volume = valid_number(value("volume"))
                    rows.append({
                        "ts": int(ts), "time": moment,
                        "open": opening or closing, "close": closing,
                        "high": high or closing, "low": low or closing,
                        "has_high": high is not None, "has_low": low is not None,
                        "volume": int(volume) if volume is not None and volume >= 0 else None,
                    })
                return rows
            except Exception as exc:
                errors.append(f"{host}: {type(exc).__name__}: {str(exc)[:130]}")
                if attempt == 0:
                    time.sleep(1)
    raise RuntimeError(" | ".join(errors[-4:]))


def session_record(day, candles, daily_rows, prev_date, latest_required_pre_bar=LATEST_REQUIRED_PRE_BAR):
    """Use *same day* regular open/close from daily data, paired with that day's pre."""
    bar = daily_rows.get(day)
    prev_bar = daily_rows.get(prev_date)
    if not isinstance(bar, list) or len(bar) < 4:
        return None
    if not isinstance(prev_bar, list) or len(prev_bar) < 4:
        return None
    regular_open, regular_close, previous_close = (
        positive(bar[0]), positive(bar[3]), positive(prev_bar[3])
    )
    if not all((regular_open, regular_close, previous_close)):
        return None

    pre = [x for x in candles if dt.time(4) <= x["time"].time() < dt.time(9, 30)]
    if len(pre) < MIN_PRE_BARS:
        return None
    pre.sort(key=lambda x: x["ts"])
    start_time, last_time = pre[0]["time"].time(), pre[-1]["time"].time()
    if start_time > EARLIEST_ALLOWED_START or last_time < latest_required_pre_bar:
        return None

    opens = [x["open"] for x in pre]
    closes = [x["close"] for x in pre]
    first_open, last_close = opens[0], closes[-1]
    peak = first_open
    worst_dd = 0.0
    for closing in closes:
        worst_dd = min(worst_dd, (closing / peak - 1) * 100)
        peak = max(peak, closing)

    all_highs = [x["high"] for x in pre]
    all_lows = [x["low"] for x in pre]
    valid_volumes = [x["volume"] for x in pre if x["volume"] is not None and x["volume"] > 0]

    # Compact per-day time series for intraday time-of-day studies.
    # Each point: [minute of ET day, percentage from first observed premarket open].
    # Persist these rows: Yahoo's short 5m lookback would otherwise erase history.
    pre_5m = [
        [x["time"].hour * 60 + x["time"].minute, round(pct(x["close"], first_open), 5)]
        for x in pre
    ]
    # True 5m high/low values, not an imputed close. Time is the 5m BAR START,
    # not the exact trade time of that intrabar peak/trough.
    highs = [x for x in pre if x.get("has_high") and positive(x["high"])]
    lows = [x for x in pre if x.get("has_low") and positive(x["low"])]
    peak_bar = max(highs, key=lambda x: x["high"]) if highs else None
    trough_bar = min(lows, key=lambda x: x["low"]) if lows else None

    return {
        "date": day,
        "pre_start": start_time.strftime("%H:%M"),
        "pre_end": last_time.strftime("%H:%M"),
        "pre_bars": len(pre),
        "pre_early_coverage": start_time <= dt.time(5, 0),
        "pre_5m": pre_5m,
        "pre_high_time": peak_bar["time"].strftime("%H:%M") if peak_bar else None,
        "pre_low_time": trough_bar["time"].strftime("%H:%M") if trough_bar else None,
        "pre_high_relative": pct(peak_bar["high"], first_open) if peak_bar else None,
        "pre_low_relative": pct(trough_bar["low"], first_open) if trough_bar else None,
        "pre_first_open": round(first_open, 5),
        "pre_last_close": round(last_close, 5),
        "pre_return": pct(last_close, first_open),
        "pre_gap": pct(last_close, previous_close),
        "pre_dd": round(worst_dd, 5),
        "pre_range": round((max(all_highs) / min(all_lows) - 1) * 100, 5),
        "pre_volume": sum(valid_volumes) if valid_volumes else None,
        "regular_open": round(regular_open, 5),
        "regular_close": round(regular_close, 5),
        "regular_return": pct(regular_close, regular_open),
        "regular_gap": pct(regular_open, previous_close),
        "close_to_close": pct(regular_close, previous_close),
        "previous_close": round(previous_close, 5),
        "source": "Yahoo Finance 5m extended-hours OHLCV + finalized Yahoo daily OHLC",
    }


def main():
    now = dt.datetime.now(ET)
    try:
        prices = json.loads(DAILY.read_text(encoding="utf-8"))
        daily = prices.get("soxx") or {}
        session_days = sorted(daily)
        if len(session_days) < 2:
            raise ValueError("Missing SOXX daily OHLCV")
    except (OSError, ValueError) as exc:
        raise RuntimeError("Cannot pair premarket with regular sessions: " + str(exc))

    try:
        older = json.loads(DEST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        older = {}

    archived = {}
    retain_from = (now.date() - dt.timedelta(days=ARCHIVE_DAYS)).isoformat()
    for day, obj in (older.get("days") or {}).items():
        if (isinstance(day, str) and day >= retain_from
                and isinstance(obj, dict) and isinstance(obj.get("pre_return"), (int, float))
                and isinstance(obj.get("regular_return"), (int, float))):
            archived[day] = obj

    start_day = now.date() - dt.timedelta(days=BACKFILL_DAYS)
    starting = dt.datetime.combine(start_day, dt.time(0), tzinfo=ET)
    end = min(now, dt.datetime.combine(now.date() + dt.timedelta(days=1), dt.time(0), tzinfo=ET))
    candles_by_ts = {}
    errors = {}
    window = starting
    while window < end:
        next_window = min(window + dt.timedelta(days=CHUNK_DAYS), end)
        key = window.date().isoformat() + "〜" + next_window.date().isoformat()
        try:
            candles = fetch_window(window, next_window)
            for candle in candles:
                candles_by_ts[candle["ts"]] = candle
            print("SOXX 5m", key, "candles", len(candles), flush=True)
        except Exception as exc:
            errors[key] = str(exc)[:360]
            print("WARN SOXX 5m", key, str(exc)[:360], flush=True)
        window = next_window
    grouped = defaultdict(list)
    for candle in candles_by_ts.values():
        grouped[candle["time"].date().isoformat()].append(candle)

    added, replaced, skipped = 0, 0, 0
    for i, day in enumerate(session_days):
        if i == 0 or day < start_day.isoformat() or day > now.date().isoformat():
            continue
        if day == now.date().isoformat() and now.time() < dt.time(16, 20):
            continue
        session_candles = grouped.get(day, [])
        if not session_candles:
            skipped += 1
            continue
        obj = session_record(day, session_candles, daily, session_days[i - 1])
        if obj is None:
            skipped += 1
            continue
        if day in archived:
            replaced += 1
        else:
            added += 1
        archived[day] = obj

    output = {
        "version": 2,
        "symbol": "SOXX",
        "updated_at": dt.datetime.now(UTC).isoformat(timespec="seconds"),
        "source": "Yahoo Finance 5-minute chart includePrePost (unofficial), paired with SOXX daily OHLCV",
        "methodology": {
            "premarket_et": "04:00–09:30 America/New_York (observed 5m bars)",
            "regular_et": "09:30–16:00 America/New_York (same-day daily open/close)",
            "pre_return": "last available premarket 5m close / first available premarket 5m open - 1",
            "pre_dd": "minimum observed 5m close / prior max of first open and observed 5m closes - 1",
            "pre_gap": "last available premarket 5m close / previous regular daily close - 1",
            "pre_range": "max premarket 5m high / min premarket 5m low - 1",
            "pre_5m": "[Eastern minute since midnight, observed 5m close / first premarket open - 1 in percent]; available prices only",
            "pre_high_time": "Eastern 5m bar start timestamp with highest observed valid 5m high (first if tied)",
            "pre_low_time": "Eastern 5m bar start timestamp with lowest observed valid 5m low (first if tied)",
            "intraday_time_research": "Only sessions with observed <=04:05 and >=09:20 and >=48 five-minute bars are eligible for high/low time-of-day frequency and normalized mean intraday profile.",
            "regular_return": "regular daily close / same-day regular daily open - 1",
            "sampling": "Only complete regular days with >=4 premarket bars; first bar <=08:30, last bar >=09:15 ET.",
            "limit": "Extended-hours 5m history is limited (~60 days); archive starts with what the provider returns. Sparse trades and price feeds can omit bars.",
        },
        "days": dict(sorted(archived.items())),
        "fetch_errors": errors,
        "last_fetch_candles": len(candles_by_ts),
        "last_fetch_matching_days": len(grouped),
        "last_fetch_added_days": added,
        "last_fetch_skipped_days": skipped,
    }
    DEST.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("WROTE", DEST.name, "archived", len(archived), "added", added,
          "updated", replaced, "skipped", skipped, "last_fetch_candles", len(candles_by_ts),
          "errors", len(errors), flush=True)
    if not candles_by_ts:
        print("WARN No intraday SOXX data obtained. Existing archive preserved.", flush=True)


if __name__ == "__main__":
    main()
