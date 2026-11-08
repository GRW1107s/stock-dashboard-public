"""Incremental EPS-growth / ROE / market-cap collector for JPX-listed shares.

Public edition of the private dashboard's yfinance pipeline. Values are
computed by jp_fundamentals from Yahoo Finance statements; only derived
growth percentages, ROE, JPY market-cap snapshots and fiscal period ends
are persisted. Runs standalone (one-shot backfills) or as a phase of
update_sector_leaders.py (small rolling batch on every scheduled run).

yfinance is the only third-party dependency. GitHub Actions runners do not
have it preinstalled, so it is installed on demand; if that fails the phase
is skipped and the price pipeline is unaffected.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from jp_fundamentals import (GROWTH, NET_INCOME_LABELS, EQUITY_LABELS, SOURCE,
                             annual_roe, calculate_growth, eps_rows, finite,
                             normalize_jp_ticker, pick_rows, quote_metrics,
                             select_jp_batch, _norm)

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "sector-leaders.json"


def import_yfinance():
    try:
        import yfinance as yf
        return yf
    except ImportError:
        pass
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--quiet", "yfinance"],
            timeout=600)
        import yfinance as yf
        return yf
    except Exception as exc:
        print("JP_FUNDAMENTALS_SKIPPED: yfinance unavailable:", exc, flush=True)
        return None


def _label_map(frame):
    """Convert a yfinance statement frame to {normalized label: [(date, value)]}."""
    out = {}
    if frame is None or getattr(frame, "empty", True):
        return out
    today = date.today()
    for label in frame.index:
        try:
            series = frame.loc[label]
            items = series.items() if hasattr(series, "items") else []
        except Exception:
            continue
        rows = []
        for stamp, raw in items:
            value = finite(raw)
            if value is None:
                continue
            try:
                period = stamp.date() if isinstance(stamp, datetime) else date.fromisoformat(str(stamp)[:10])
            except (TypeError, ValueError):
                continue
            if period <= today:
                rows.append((period, value))
        if rows:
            out[_norm(label)] = sorted(rows, reverse=True)
    return out


def _is_rate_limit(exc):
    name = type(exc).__name__.lower()
    message = str(exc).lower()
    return ("ratelimit" in name or "rate limit" in message
            or "too many requests" in message or "429" in message)


def fetch_one(yf, row):
    """Return (row, values, metrics, error, had_data); error is a short string or None.

    had_data is False when Yahoo returned no statements and no quote at all
    (e.g. an empty response from a datacenter IP). That is not an exception,
    so without this flag an empty fetch looks like a successful attempt and
    the ticker would be skipped for 60 days with no values.
    """
    ticker = normalize_jp_ticker(row.get("ticker"))
    if not ticker:
        return row, None, None, "invalid ticker", False
    for retry in range(2):
        try:
            asset = yf.Ticker(ticker)
            quarterly = _label_map(asset.get_income_stmt(freq="quarterly"))
            annual = _label_map(asset.get_income_stmt(freq="yearly"))
            values = calculate_growth(eps_rows(quarterly), eps_rows(annual))
            had_data = bool(quarterly) or bool(annual)
            # Failure in a secondary statement must not discard EPS data.
            roe_calc = {}
            try:
                balance = _label_map(asset.get_balance_sheet(freq="yearly"))
                had_data = had_data or bool(balance)
                roe_calc = annual_roe(pick_rows(annual, NET_INCOME_LABELS),
                                       pick_rows(balance, EQUITY_LABELS))
            except Exception:
                pass
            fast = {}
            try:
                quick = asset.fast_info
                fast = {"currency": quick.get("currency"),
                        "market_cap": quick.get("market_cap")}
            except Exception:
                pass
            info = {}
            if finite(fast.get("market_cap")) is None or not roe_calc or not fast.get("currency"):
                try:
                    info = asset.get_info()
                except Exception:
                    pass
            had_data = had_data or bool(fast.get("currency")) \
                or finite(fast.get("market_cap")) is not None or bool(info)
            # Snapshot/summary fallback, but calculated FY ROE takes precedence.
            metrics = quote_metrics(info, fast)
            metrics.update(roe_calc)
            return row, values, metrics, None, had_data
        except Exception as exc:
            if _is_rate_limit(exc):
                return row, None, None, ticker + ": rate-limited", False
            if retry == 0:
                time.sleep(2)
            last = type(exc).__name__
    return row, None, None, ticker + ": " + last, False


def apply_market_cap_fallback(stocks, today):
    """Fill missing JPY market caps as close x shares outstanding.

    Shares come from the committed jp-float-shares.json store; the close is
    the row's own chart-API price. This works even where Yahoo's statement
    and quote endpoints return nothing (e.g. datacenter IPs)."""
    try:
        from update_jp_float_shares import _load as load_float_store
        store = load_float_store()
    except Exception:
        return 0
    closes = {}
    try:
        stash = json.loads((ROOT / "jp-closes.json").read_text(encoding="utf-8"))
        closes = stash.get("closes") or {}
    except Exception:
        pass
    filled = 0
    for row in stocks:
        if finite(row.get("market_cap")) is not None and row.get("market_cap_currency") == "JPY":
            continue
        ticker = normalize_jp_ticker(row.get("ticker")) or ""
        entry = store.get(ticker) or {}
        shares = entry.get("shares_outstanding") or entry.get("float_shares")
        close = finite(row.get("close"))
        if close is None and ticker in closes:
            close = finite(closes[ticker][0])
        if isinstance(shares, (int, float)) and shares > 0 and close:
            row["market_cap"] = round(close * shares)
            row["market_cap_currency"] = "JPY"
            row["market_cap_asof"] = today
            row["market_cap_source"] = "close x shares (jp-float-shares.json)"
            filled += 1
    return filled


def enrich_jp_fundamentals(data, limit, *, workers=4, force_missing=False,
                           refresh_days=60, yf=None):
    """Enrich data['jp'] entries in place; returns a stats dict."""
    stocks = data.get("jp") or []
    if not stocks:
        print("JP_FUNDAMENTALS_SKIPPED: Japanese ticker list unavailable", flush=True)
        return {}
    if yf is None:
        yf = import_yfinance()
    if yf is None:
        return {}
    workers = max(1, min(6, workers))
    limit = max(1, min(len(stocks), limit))
    cursor = int(data.get("jp_eps_yfinance_cursor", 0))
    attempt = select_jp_batch(stocks, limit, cursor=cursor,
                              force_missing=force_missing,
                              refresh_days=refresh_days)
    today = date.today().isoformat()
    complete = updated = processed = rate_limited = fin_updated = empty = 0
    errors = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for offset in range(0, len(attempt), workers * 5):
            wave = attempt[offset:offset + workers * 5]
            tasks = [pool.submit(fetch_one, yf, row) for row in wave]
            for future in as_completed(tasks):
                row, values, metrics, error, had_data = future.result()
                processed += 1
                if error:
                    errors.append(error)
                    if "rate-limited" in error:
                        rate_limited += 1
                    continue
                if had_data:
                    row["eps_yfinance_attempted_at"] = today
                    row["eps_yfinance_empty_attempts"] = 0
                else:
                    # Yahoo returned nothing at all: do not mark the ticker
                    # attempted, so the next run retries it. After three
                    # consecutive empty responses, stamp it to back off for
                    # the refresh window instead of retrying forever.
                    streak = int(row.get("eps_yfinance_empty_attempts") or 0) + 1
                    row["eps_yfinance_empty_attempts"] = streak
                    if streak >= 3:
                        row["eps_yfinance_attempted_at"] = today
                    empty += 1
                row["jp_financials_attempted_at"] = today
                if metrics:
                    row.update(metrics)
                    fin_updated += len(metrics)
                count = sum(values[k] is not None for k in GROWTH)
                if count:
                    for key in GROWTH:
                        if values[key] is not None:
                            row[key] = values[key]
                    for key in ("eps_q_latest_end", "eps_q_prev_end", "eps_annual_end"):
                        if values[key]:
                            row[key] = values[key]
                    row["eps_fetched_at"] = today
                    row["eps_source"] = SOURCE
                    row["eps_basis"] = "diluted if available; otherwise basic"
                    complete += 1
                    updated += count
                if processed % 200 == 0:
                    print(f"JP_FUNDAMENTALS_PROGRESS processed={processed}/{len(attempt)} "
                          f"with_growth={complete} errors={len(errors)}", flush=True)
            if rate_limited >= workers:
                print("JP_FUNDAMENTALS_RATE_LIMIT_STOP: remaining tickers deferred", flush=True)
                break
    cap_fallback = apply_market_cap_fallback(stocks, today)
    data["jp_eps_yfinance_cursor"] = (cursor + processed) % max(1, len(stocks))
    data["jp_eps_coverage"] = {
        "source": SOURCE,
        "universe": len(stocks),
        "batch_requested": len(attempt),
        "batch_size": processed,
        "batch_with_growth": complete,
        "metrics_updated": updated,
        "failed_this_run": len(errors),
        "empty_this_run": empty,
        "rate_limited_this_run": rate_limited,
        "with_latest_yoy": sum(isinstance(r.get(GROWTH[0]), (int, float)) for r in stocks),
        "with_previous_yoy": sum(isinstance(r.get(GROWTH[1]), (int, float)) for r in stocks),
        "with_annual_cagr": sum(isinstance(r.get(GROWTH[2]), (int, float)) for r in stocks),
        "with_roe": sum(finite(r.get("roe_pct")) is not None for r in stocks),
        "with_market_cap": sum(finite(r.get("market_cap")) is not None and r.get("market_cap_currency") == "JPY" for r in stocks),
        "with_market_cap_fallback": cap_fallback,
        "financial_fields_updated": fin_updated,
        "attempted_ever": sum(bool(r.get("eps_yfinance_attempted_at")) for r in stocks),
        "refresh_days": refresh_days,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "note": "Coverage depends on available Japanese quarterly and annual statements; Yahoo terms apply.",
    }
    print("JP_EPS_COVERAGE", json.dumps(data["jp_eps_coverage"], ensure_ascii=False), flush=True)
    if errors:
        print("JP_FUNDAMENTALS_ERRORS", ", ".join(errors[:12]), flush=True)
    return data["jp_eps_coverage"]


def main():
    data = json.loads(ARCHIVE.read_text(encoding="utf-8"))
    stocks = data.get("jp") or []
    if os.getenv("JP_FUND_FULL") == "1":
        limit = max(1, len(stocks))
    else:
        limit = int(os.getenv("JP_FUND_BATCH", "300"))
    workers = int(os.getenv("JP_FUND_WORKERS", "4"))
    force_missing = os.getenv("JP_FUND_FORCE_MISSING") == "1"
    refresh_days = max(1, min(365, int(os.getenv("JP_FUND_REFRESH_DAYS", "60"))))
    enrich_jp_fundamentals(data, limit, workers=workers,
                           force_missing=force_missing, refresh_days=refresh_days)
    ARCHIVE.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n",
                       encoding="utf-8")
    print("WROTE", ARCHIVE.name, flush=True)


if __name__ == "__main__":
    main()
