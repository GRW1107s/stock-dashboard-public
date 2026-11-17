"""Incremental EPS-growth / sales-growth / ROE collector for US-listed shares.

US counterpart of update_jp_fundamentals.py: the same Yahoo Finance
statement pipeline (jp_fundamentals) computes quarterly EPS YoY, latest
annual EPS YoY, 3-year annual EPS CAGR, latest-quarter sales YoY and ROE
for the US universe. Only derived percentages and fiscal period ends are
persisted; market-cap snapshots are NOT touched here (the US screener's
caps come from the Nasdaq snapshot pipeline in update_sector_leaders.py).

Runs standalone (one-shot backfills) or as a phase of
update_sector_leaders.py (rolling batch on every scheduled run).
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from jp_fundamentals import (GROWTH, NET_INCOME_LABELS, EQUITY_LABELS, SOURCE,
                             SALES_SOURCE,
                             annual_roe, calculate_growth, calculate_sales_growth,
                             eps_rows, finite, pick_rows, quote_metrics,
                             revenue_rows, select_batch, _norm)

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "sector-leaders.json"

US_SYMBOL = re.compile(r"^[A-Z][A-Z0-9\-]{0,11}$")


def normalize_us_ticker(value):
    """Map a stored US ticker to its Yahoo symbol (BRK.B -> BRK-B)."""
    raw = str(value or "").strip().upper().replace(".", "-")
    return raw if US_SYMBOL.fullmatch(raw) else None


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
        print("US_FUNDAMENTALS_SKIPPED: yfinance unavailable:", exc, flush=True)
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
    """Return (row, values, metrics, error, had_data); same contract as the JP collector."""
    ticker = normalize_us_ticker(row.get("ticker"))
    if not ticker:
        return row, None, None, "invalid ticker", False
    for retry in range(2):
        try:
            asset = yf.Ticker(ticker)
            quarterly = _label_map(asset.get_income_stmt(freq="quarterly"))
            annual = _label_map(asset.get_income_stmt(freq="yearly"))
            values = calculate_growth(eps_rows(quarterly), eps_rows(annual))
            values.update(calculate_sales_growth(revenue_rows(quarterly)))
            had_data = bool(quarterly) or bool(annual)
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
            if not roe_calc or not fast.get("currency"):
                try:
                    info = asset.get_info()
                except Exception:
                    pass
            had_data = had_data or bool(fast.get("currency")) \
                or finite(fast.get("market_cap")) is not None or bool(info)
            # quote_metrics adds a market cap only for JPY quotes, so for US
            # rows this contributes just the trailing-ROE fallback; the
            # calculated FY ROE takes precedence.
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


def enrich_us_fundamentals(data, limit, *, workers=4, refresh_days=60, yf=None):
    """Enrich data['us'] entries in place; returns a stats dict."""
    stocks = data.get("us") or []
    if not stocks:
        print("US_FUNDAMENTALS_SKIPPED: US ticker list unavailable", flush=True)
        return {}
    if yf is None:
        yf = import_yfinance()
    if yf is None:
        return {}
    workers = max(1, min(6, workers))
    limit = max(1, min(len(stocks), limit))
    cursor = int(data.get("us_eps_yfinance_cursor", 0))
    attempt = select_batch(stocks, cursor, limit, refresh_days=refresh_days)
    today = date.today().isoformat()
    complete = updated = processed = rate_limited = fin_updated = empty = 0
    sales_updated = 0
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
                    row["sales_attempted_at"] = today
                else:
                    streak = int(row.get("eps_yfinance_empty_attempts") or 0) + 1
                    row["eps_yfinance_empty_attempts"] = streak
                    if streak >= 3:
                        row["eps_yfinance_attempted_at"] = today
                        row["sales_attempted_at"] = today
                    empty += 1
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
                if values.get("sales_q_latest_yoy_pct") is not None:
                    row["sales_q_latest_yoy_pct"] = values["sales_q_latest_yoy_pct"]
                    if values.get("sales_q_latest_end"):
                        row["sales_q_latest_end"] = values["sales_q_latest_end"]
                    row["sales_source"] = SALES_SOURCE
                    sales_updated += 1
                if processed % 200 == 0:
                    print(f"US_FUNDAMENTALS_PROGRESS processed={processed}/{len(attempt)} "
                          f"with_growth={complete} errors={len(errors)}", flush=True)
            if rate_limited >= workers:
                print("US_FUNDAMENTALS_RATE_LIMIT_STOP: remaining tickers deferred", flush=True)
                break
    data["us_eps_yfinance_cursor"] = (cursor + processed) % max(1, len(stocks))
    data["us_eps_coverage"] = {
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
        "with_annual_yoy": sum(isinstance(r.get("eps_annual_yoy_pct"), (int, float)) for r in stocks),
        "with_sales_yoy": sum(isinstance(r.get("sales_q_latest_yoy_pct"), (int, float)) for r in stocks),
        "sales_updated_this_run": sales_updated,
        "with_roe": sum(finite(r.get("roe_pct")) is not None for r in stocks),
        "attempted_ever": sum(bool(r.get("eps_yfinance_attempted_at")) for r in stocks),
        "refresh_days": refresh_days,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "note": "Coverage depends on available US quarterly and annual statements; Yahoo terms apply.",
    }
    print("US_EPS_COVERAGE", json.dumps(data["us_eps_coverage"], ensure_ascii=False), flush=True)
    if errors:
        print("US_FUNDAMENTALS_ERRORS", ", ".join(errors[:12]), flush=True)
    return data["us_eps_coverage"]


def main():
    data = json.loads(ARCHIVE.read_text(encoding="utf-8"))
    stocks = data.get("us") or []
    if os.getenv("US_FUND_FULL") == "1":
        limit = max(1, len(stocks))
    else:
        limit = int(os.getenv("US_FUND_BATCH", "300"))
    workers = int(os.getenv("US_FUND_WORKERS", "4"))
    refresh_days = max(1, min(365, int(os.getenv("US_FUND_REFRESH_DAYS", "60"))))
    enrich_us_fundamentals(data, limit, workers=workers, refresh_days=refresh_days)
    ARCHIVE.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n",
                       encoding="utf-8")
    print("WROTE", ARCHIVE.name, flush=True)


if __name__ == "__main__":
    main()
