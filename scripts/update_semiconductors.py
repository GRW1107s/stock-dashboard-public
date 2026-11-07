"""Japanese semiconductor 30-minute and 60-minute OHLCV snapshots.

Yahoo intraday limits: 15m (~60 calendar days) is aggregated into exchange-
session aligned 30m bars. 60m series goes back ~4 months. The 30m archive
accumulates in versioned semiconductors.json during scheduled GitHub Actions.
No historical bars are fabricated, interpolated, or forward-filled.
"""
import datetime as dt
import json
import math
import pathlib
import time
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEST = ROOT / "semiconductors.json"
JST = ZoneInfo("Asia/Tokyo")
SYMBOLS = {
    "285A.T": "キオクシアHD",
    "8035.T": "東京エレクトロン",
    "6857.T": "アドバンテスト",
    "6146.T": "ディスコ",
    "6920.T": "レーザーテック",
    "6723.T": "ルネサス",
    "7735.T": "SCREEN",
    "4063.T": "信越化学",
    "6525.T": "KOKUSAI ELECTRIC",
    "6963.T": "ローム",
    "5803.T": "フジクラ",
    "5801.T": "古河電工",
    "5802.T": "住友電工",
    "5016.T": "JX金属",
    "6976.T": "太陽誘電",
    "9984.T": "ソフトバンクグループ",
}
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; PersonalSemiconductorStudy/1.0)",
    "Accept": "application/json",
}


def good(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (ValueError, TypeError):
        return None


def fetch(symbol, interval, days):
    now = int(time.time())
    query = urllib.parse.urlencode({
        "period1": now - days * 86400, "period2": now + 86400,
        "interval": interval, "includePrePost": "false",
        "events": "splits",
    })
    last_error = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        for attempt in range(2):
            try:
                url = f"https://{host}/v8/finance/chart/{urllib.parse.quote(symbol)}?{query}"
                req = urllib.request.Request(url, headers=HEADERS)
                with urllib.request.urlopen(req, timeout=30) as res:
                    data = json.load(res)["chart"]["result"][0]
                q = data["indicators"]["quote"][0]
                output = []
                today = dt.datetime.now(JST)
                for ts, op, hi, lo, cl, vol in zip(
                    data.get("timestamp") or [], q["open"], q["high"],
                    q["low"], q["close"], q["volume"]
                ):
                    point = dt.datetime.fromtimestamp(ts, JST)
                    # Do not publish intraday incomplete/unstable current-session bars.
                    if point.date() == today.date() and today.time() < dt.time(15, 45):
                        continue
                    values = [good(v) for v in (op, hi, lo, cl)]
                    if any(v is None or v <= 0 for v in values):
                        continue
                    if values[1] < max(values[0], values[3]) or values[2] > min(values[0], values[3]):
                        continue
                    output.append([point.isoformat(timespec="minutes"), *values, int(vol or 0)])
                if not output:
                    raise ValueError("no valid bars")
                return sorted(output, key=lambda r: r[0])
            except Exception as exc:
                last_error = exc
                time.sleep(0.7 * (attempt + 1))
    raise RuntimeError(f"{symbol} {interval}: {last_error}")


def half_hour_bars(fifteen):
    groups = {}
    for r in fifteen:
        t = dt.datetime.fromisoformat(r[0])
        minutes = t.hour * 60 + t.minute
        if 540 <= minutes < 690:        # 09:00–11:30
            bucket = 540 + ((minutes - 540) // 30) * 30
        elif 750 <= minutes < 930:      # 12:30–15:30
            bucket = 750 + ((minutes - 750) // 30) * 30
        else:
            continue
        stamp = t.replace(hour=bucket // 60, minute=bucket % 60, second=0)
        groups.setdefault(stamp.isoformat(timespec="minutes"), []).append(r)
    result = []
    for key, items in sorted(groups.items()):
        # Both constituent 15m bars must exist: partial bars are excluded.
        if len(items) != 2:
            continue
        items.sort(key=lambda r: r[0])
        result.append([
            key, items[0][1], max(v[2] for v in items),
            min(v[3] for v in items), items[-1][4],
            sum(v[5] for v in items),
        ])
    return result


def keep_window(rows, min_date):
    return [r for r in rows if isinstance(r, list) and len(r) == 6
            and isinstance(r[0], str) and r[0][:10] >= min_date]


def merge(old, new, min_date):
    # Timestamp-based upsert, always using freshly fetched data in overlaps.
    by_time = {r[0]: r for r in keep_window(old, min_date)}
    by_time.update({r[0]: r for r in keep_window(new, min_date)})
    return [by_time[k] for k in sorted(by_time)]


def main():
    now = dt.datetime.now(JST)
    # 125 calendar days is approximately four months, not a fixed session count.
    cutoff = (now.date() - dt.timedelta(days=125)).isoformat()
    existing = {}
    if DEST.exists():
        try:
            existing = json.loads(DEST.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    old = existing.get("series") or {}
    series, errors, summary = {}, {}, {}
    successful = 0
    for symbol, name in SYMBOLS.items():
        prev = old.get(symbol) or {}
        result = {}
        try:
            fresh = half_hour_bars(fetch(symbol, "15m", 59))
            if not fresh:
                raise ValueError("15m to 30m resampling returned no complete bars")
            result["30m"] = merge(prev.get("30m") or [], fresh, cutoff)
            successful += 1
        except Exception as exc:
            errors[symbol + ":30m"] = str(exc)
            result["30m"] = keep_window(prev.get("30m") or [], cutoff)
        try:
            hour = fetch(symbol, "60m", 125)
            result["60m"] = merge([], hour, cutoff)
            successful += 1
        except Exception as exc:
            errors[symbol + ":60m"] = str(exc)
            result["60m"] = keep_window(prev.get("60m") or [], cutoff)
        series[symbol] = result
        summary[symbol] = {
            k: {"bars": len(result[k]),
                "first": result[k][0][0][:10] if result[k] else None,
                "last": result[k][-1][0][:10] if result[k] else None}
            for k in ("30m", "60m")
        }
        print(symbol, name, summary[symbol], flush=True)
        time.sleep(0.25)
    if successful == 0 and not any(v["30m"] or v["60m"] for v in series.values()):
        raise RuntimeError("No intraday data fetched; keeping previous publication.")
    output = {
        "version": 1, "updated_at": now.isoformat(timespec="seconds"),
        "start_target": cutoff, "source": "Yahoo Finance unofficial chart API",
        "note": "30m is session-aligned aggregation of two 15m bars. 60m is the original Yahoo series. Yahoo intraday 15m typically covers only 60 days; 30m history grows by daily archival. Data are indicative, not a licensed live feed.",
        "symbols": SYMBOLS, "summary": summary, "errors": errors, "series": series,
    }
    DEST.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("WROTE semiconductors.json:", successful, "successful feeds;", len(errors), "failures")


if __name__ == "__main__":
    main()
