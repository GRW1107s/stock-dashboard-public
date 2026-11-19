"""Daily history persistence for the public screener.

Two stores, both plain JSON so the workflow's `git add -A -- '*.json'`
commit step picks them up without any workflow change:

- ohlcv/<market>/<ticker>.json — per-stock daily OHLCV rows
  [date, open, high, low, close, volume]. Every pipeline run merges the
  series it fetched (each fetch carries ~455 days, so the store fills
  to a full year as the rotation reaches each ticker) and trims rows
  older than 365 days. This is the backtest data foundation.
- screener-archive/YYYY-MM-DD.json — one slim columnar snapshot of the
  screener rows per day (the day's last run wins), pruned to 365 days.

Both writers are best-effort: callers wrap them so a storage failure can
never block the price pipeline.
"""
from __future__ import annotations

from datetime import date, timedelta
import json
from pathlib import Path
import re

RETENTION_DAYS = 365

# Fields kept in a daily screener snapshot: identity/classification plus
# every metric the screener displays or filters on. Bookkeeping fields
# (fetch stamps, sample counts, cursors) are deliberately excluded.
SNAPSHOT_FIELDS = [
    "ticker", "name", "sector", "sector_name", "industry_name",
    "gics_industry", "gics_sub_industry",
    "industry_fine_en", "industry_fine_ja", "market", "asof", "close",
    "change_1d", "return_3d", "return_10d", "return_25d", "return_60d",
    "return_252d", "rs_universe_pct", "rs_weighted_return_pct",
    "rs_sp500_delta_pp", "beta_252d", "sharpe_252d",
    "high52_distance_pct", "low52_rise_pct", "ma20_position",
    "ma50_position", "ma150", "ma200", "ma200_prev", "rvol20",
    "market_cap", "sector_rank", "eps_q_latest_yoy_pct",
    "eps_q_latest_qoq_pct", "eps_annual_yoy_pct", "eps_annual_3y_cagr_pct",
    "sales_q_latest_yoy_pct", "roe_pct", "short_ratio", "short_d_ratio",
    "margin_buy_pct", "margin_sell_pct", "margin_ratio",
]


def _safe_name(ticker):
    name = re.sub(r"[^A-Za-z0-9\-]", "-", str(ticker or "")).strip("-")
    return name or "unknown"


def update_ohlcv(root, market, series_by_ticker, *, today=None):
    """Merge fetched daily series into per-ticker files; returns writes."""
    today = today or date.today()
    cutoff = (today - timedelta(days=RETENTION_DAYS)).isoformat()
    folder = Path(root) / "ohlcv" / market
    folder.mkdir(parents=True, exist_ok=True)
    written = 0
    for ticker, series in series_by_ticker.items():
        if not series:
            continue
        path = folder / (_safe_name(ticker) + ".json")
        merged = {}
        if path.exists():
            try:
                old = json.loads(path.read_text(encoding="utf-8"))
                for row in old.get("rows") or []:
                    merged[row[0]] = row
            except Exception:
                pass
        for row in series:
            merged[row[0]] = list(row)
        rows = [merged[day] for day in sorted(merged) if day >= cutoff]
        if not rows:
            continue
        text = json.dumps({"ticker": ticker, "market": market, "rows": rows},
                          ensure_ascii=False, separators=(",", ":"))
        if not path.exists() or path.read_text(encoding="utf-8") != text:
            path.write_text(text, encoding="utf-8")
            written += 1
    return written


def slim_snapshot(output, day):
    """Columnar snapshot: field names once, one value array per stock."""
    def pack(rows):
        return [[row.get(field) for field in SNAPSHOT_FIELDS]
                for row in rows or []]
    return {"date": day, "fields": SNAPSHOT_FIELDS,
            "jp": pack(output.get("jp")), "us": pack(output.get("us"))}


def write_snapshot(root, output, *, today=None):
    """Write today's snapshot and prune ones past the retention window."""
    today = today or date.today()
    folder = Path(root) / "screener-archive"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (today.isoformat() + ".json")
    path.write_text(
        json.dumps(slim_snapshot(output, today.isoformat()),
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    cutoff = (today - timedelta(days=RETENTION_DAYS)).isoformat()
    pruned = 0
    for old in folder.glob("*.json"):
        if old.name != "index.json" and old.stem < cutoff:
            old.unlink()
            pruned += 1
    _write_index(folder, today.isoformat())
    return path.name, pruned


def _write_index(folder, updated_at):
    """Rewrite screener-archive/index.json from the files present."""
    dates = sorted(
        (item.stem for item in folder.glob("*.json")
         if re.fullmatch(r"\d{4}-\d{2}-\d{2}", item.stem)),
        reverse=True)
    (folder / "index.json").write_text(
        json.dumps({"dates": dates, "updated_at": updated_at},
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")


def write_snapshot_rows(root, day_iso, jp_rows, us_rows):
    """Write one day's snapshot from prepared row dicts (backfill path).

    Uses the same slim columnar format as write_snapshot so the
    dashboard reads backfilled and live snapshots identically.
    """
    folder = Path(root) / "screener-archive"
    folder.mkdir(parents=True, exist_ok=True)
    payload = slim_snapshot({"jp": jp_rows, "us": us_rows}, day_iso)
    (folder / f"{day_iso}.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    _write_index(folder, day_iso)
    return f"{day_iso}.json"
