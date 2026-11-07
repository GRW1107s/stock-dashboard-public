"""Collect free-float shares for Japanese listed stocks (for index weights).

Stores jp-float-shares.json: {ticker: {float_shares, shares_outstanding,
asof}}. Float shares change slowly (shareholder composition, buybacks,
splits), so entries refresh on a 30-day cycle and each run only takes a
bounded batch of the stalest tickers. Source: Yahoo Finance via
yfinance (floatShares / sharesOutstanding). Missing values stay
missing; the industry index builder falls back to shares outstanding
and then excludes the stock from the weighted index.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "jp-float-shares.json"
SOURCE = "Yahoo Finance via yfinance (floatShares)"


def _load():
    try:
        data = json.loads(ARCHIVE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _fetch_one(yf, ticker):
    try:
        info = yf.Ticker(ticker).info or {}
    except Exception:
        return ticker, None
    def pos(key):
        value = info.get(key)
        return float(value) if isinstance(value, (int, float)) and value > 0 else None
    float_shares = pos("floatShares")
    shares = pos("sharesOutstanding")
    if float_shares is None and shares is None:
        return ticker, None
    return ticker, {
        "float_shares": float_shares,
        "shares_outstanding": shares,
        "asof": date.today().isoformat(),
    }


def enrich_float_shares(tickers, limit, *, workers=4, refresh_days=30):
    """Refresh up to `limit` stalest tickers in jp-float-shares.json."""
    try:
        import yfinance as yf
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "yfinance>=0.2.54"])
        import yfinance as yf
    store = _load()
    cutoff = (date.today() - timedelta(days=refresh_days)).isoformat()
    def stale(ticker):
        entry = store.get(ticker)
        return entry is None or str(entry.get("asof") or "") < cutoff
    queue = sorted({t for t in tickers if t and stale(t)},
                   key=lambda t: str((store.get(t) or {}).get("asof") or ""))
    queue = queue[:max(1, limit)]
    updated = failed = 0
    with ThreadPoolExecutor(max_workers=max(1, min(6, workers))) as pool:
        futures = [pool.submit(_fetch_one, yf, t) for t in queue]
        for future in as_completed(futures):
            ticker, entry = future.result()
            if entry:
                store[ticker] = entry
                updated += 1
            else:
                failed += 1
    ARCHIVE.write_text(json.dumps(store, ensure_ascii=False, separators=(",", ":")) + "\n",
                       encoding="utf-8")
    coverage = {
        "source": SOURCE,
        "stored": len(store),
        "with_float_shares": sum(1 for e in store.values() if e.get("float_shares")),
        "refreshed_this_run": updated,
        "failed_this_run": failed,
    }
    print("JP_FLOAT_SHARES", json.dumps(coverage, ensure_ascii=False), flush=True)
    return store


def weights_from_store(store=None):
    """Return {ticker: float_shares or shares_outstanding} for index weighting."""
    store = _load() if store is None else store
    weights = {}
    for ticker, entry in store.items():
        value = entry.get("float_shares") or entry.get("shares_outstanding")
        if isinstance(value, (int, float)) and value > 0:
            weights[ticker] = float(value)
    return weights


def main():
    tickers = []
    try:
        industries = json.loads((ROOT / "jp-industries.json").read_text(encoding="utf-8"))
        tickers = sorted({t for members in (industries.get("membership") or {}).values()
                          for t in members})
    except Exception:
        tickers = []
    if not tickers:
        leaders = json.loads((ROOT / "sector-leaders.json").read_text(encoding="utf-8"))
        tickers = [row.get("ticker") for row in leaders.get("jp") or []]
    if os.getenv("JP_FLOAT_FULL") == "1":
        limit = max(1, len(tickers))
    else:
        limit = int(os.getenv("JP_FLOAT_BATCH", "600"))
    enrich_float_shares(tickers, limit,
                        workers=int(os.getenv("JP_FLOAT_WORKERS", "4")))


if __name__ == "__main__":
    main()
