"""Archive SOX (^SOX) and Japanese equity daily OHLCV for overnight mean-reversion tests.

Japanese date D close (15:30 JST) is followed by US SOX D close (16:00 ET),
then the next Japanese session D2 open. An event is valid only when SOX D is
the *last* US session before Japanese D2; never reuse an obsolete US session.

Yahoo Finance Chart is unofficial. Skip incomplete current-day candles.
On transient failure, preserve existing stored records without fabricating prices.
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
DEST = ROOT / "sox-swing.json"
JST, ET = ZoneInfo("Asia/Tokyo"), ZoneInfo("America/New_York")
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
    "User-Agent": "Mozilla/5.0 (compatible; PersonalSOXSwingStudy/1.0)",
    "Accept": "application/json",
}
LOOKBACK_DAYS = 1130  # About three years, including margin for previous-close calculations.


def number(v):
    try:
        f = float(v)
        return f if math.isfinite(f) and f > 0 else None
    except (TypeError, ValueError):
        return None


def download(symbol):
    zone = ET if symbol in ("^SOX", "SOXX") else JST
    now = dt.datetime.now(zone)
    start = int(time.time()) - LOOKBACK_DAYS * 86400
    params = urllib.parse.urlencode({
        "period1": start, "period2": int(time.time()) + 86400,
        "interval": "1d", "includePrePost": "false", "events": "splits"
    })
    last_exc = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        for attempt in range(2):
            try:
                url = f"https://{host}/v8/finance/chart/{urllib.parse.quote(symbol)}?{params}"
                req = urllib.request.Request(url, headers=HEADERS)
                with urllib.request.urlopen(req, timeout=30) as response:
                    source = json.load(response)["chart"]["result"][0]
                q = source["indicators"]["quote"][0]
                result = {}
                for ts, op, hi, lo, cl, vol in zip(
                    source.get("timestamp") or [], q["open"], q["high"], q["low"], q["close"], q["volume"]
                ):
                    candle_at = dt.datetime.fromtimestamp(ts, zone)
                    # Current session may be changing in Yahoo. Do not publish it.
                    if candle_at.date() == now.date() and now.time() < (
                        dt.time(16, 20) if symbol in ("^SOX", "SOXX") else dt.time(15, 50)
                    ):
                        continue
                    values = [number(v) for v in (op, hi, lo, cl)]
                    if any(x is None for x in values):
                        continue
                    if values[1] < max(values[0], values[3]) or values[2] > min(values[0], values[3]):
                        continue
                    # Volume can be missing for an index; never invent it.
                    volume = None
                    try:
                        v = float(vol)
                        if math.isfinite(v) and v >= 0:
                            volume = int(v)
                    except (TypeError, ValueError, OverflowError):
                        pass
                    result[candle_at.date().isoformat()] = values + [volume]
                if len(result) < 12:
                    raise RuntimeError(f"not enough valid candles: {len(result)}")
                print(f"FETCH {symbol} {len(result)} daily candles", flush=True)
                return result
            except Exception as exc:
                last_exc = exc
                time.sleep(attempt + 1)
    raise RuntimeError(f"{symbol}: {last_exc}")


def keep_existing(value, cutoff):
    if not isinstance(value, dict):
        return {}
    result = {}
    for date, row in value.items():
        if (isinstance(date, str) and len(date) == 10 and date >= cutoff and
                isinstance(row, list) and len(row) in (4, 5) and
                all(number(v) is not None for v in row[:4]) and
                (len(row) == 4 or row[4] is None or
                 (isinstance(row[4], (int, float)) and math.isfinite(row[4]) and row[4] >= 0))):
            result[date] = row
    return result


def main():
    now = dt.datetime.now(JST)
    cutoff = (now.date() - dt.timedelta(days=LOOKBACK_DAYS)).isoformat()
    try:
        previous = json.loads(DEST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = {}
    sox = keep_existing(previous.get("sox"), cutoff)
    soxx = keep_existing(previous.get("soxx"), cutoff)
    stocks = previous.get("stocks") or {}
    errors, success = {}, 0
    try:
        sox.update(download("^SOX"))
        success += 1
    except Exception as exc:
        errors["^SOX"] = str(exc)
        print("WARN", errors["^SOX"])
    try:
        soxx.update(download("SOXX"))
        success += 1
    except Exception as exc:
        errors["SOXX"] = str(exc)
        print("WARN", errors["SOXX"])
    for symbol in SYMBOLS:
        old = keep_existing(stocks.get(symbol), cutoff)
        try:
            old.update(download(symbol))
            success += 1
        except Exception as exc:
            errors[symbol] = str(exc)
            print("WARN", errors[symbol])
        stocks[symbol] = dict(sorted(old.items()))
        time.sleep(0.15)
    if not sox or not any(stocks.values()):
        raise RuntimeError("No valid SOX/JP daily candles. Existing data is untouched.")
    result = {
        "version": 1,
        "updated_at": now.isoformat(timespec="seconds"),
        "source": "Yahoo Finance unofficial chart API; 1d interval",
        "sox_symbol": "^SOX",
        "soxx_symbol": "SOXX",
        "volume_proxy_note": "SOX index returns are from ^SOX; US trading volume shown alongside SOX is SOXX ETF traded shares, NOT volume of the index or all semiconductor stocks.",
        "note": "Japanese D close -> SOX D US close -> next Japanese open. Only date-aligned, finalized candles; skips missing US sessions. Close-to-next-close is diagnostic and NOT a tradable return after SOX is known.",
        "symbols": SYMBOLS,
        "sox": dict(sorted(sox.items())),
        "soxx": dict(sorted(soxx.items())),
        "stocks": stocks,
        "errors": errors,
    }
    DEST.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("WROTE", DEST.name, "success", success, "errors", len(errors),
          "SOX sessions", len(sox), "SOXX sessions", len(soxx),
          "JP minimum", min((len(d) for d in stocks.values()), default=0), flush=True)


if __name__ == "__main__":
    main()
