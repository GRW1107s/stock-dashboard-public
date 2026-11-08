"""EPS growth, ROE and market-cap calculations for JPX-listed shares.

Ported from the private dashboard's yfinance pipeline so the public edition
computes the same fields with the same rules:

- EPS growth: latest and previous reported quarter vs the like-for-like
  quarter one year earlier (YoY), plus the 3-year annual EPS CAGR. Only
  derived percentages and fiscal period ends are persisted; raw EPS values
  are never written to the archive. Missing quarters and non-positive base
  EPS stay unknown instead of being guessed.
- ROE: latest fiscal-year parent net income divided by average parent
  shareholders' equity (opening/closing), with Yahoo's trailing quote ROE
  as a labelled fallback.
"""
from datetime import date, timedelta
import math
import re

GROWTH = ("eps_q_latest_yoy_pct", "eps_q_prev_yoy_pct", "eps_annual_3y_cagr_pct")
SOURCE = "Yahoo Finance via yfinance (calculated EPS growth)"
ROE_SOURCE = "Yahoo Finance annual income / average parent shareholders equity"
ROE_FALLBACK_SOURCE = "Yahoo Finance quote summary trailing ROE (not audited annual formula)"


def finite(value):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _norm(value):
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def pick_rows(label_map, labels):
    """First non-empty statement row set matching one of the labels.

    label_map maps normalized row labels to [(period_end, value), ...]
    sorted newest first.
    """
    for label in labels:
        rows = label_map.get(_norm(label))
        if rows:
            return rows
    return []


EPS_LABELS = (("Diluted EPS", "DilutedEPS"), ("Basic EPS", "BasicEPS"))
NET_INCOME_LABELS = (
    "Net Income Common Stockholders",
    "Net Income From Continuing And Discontinued Operation",
    "Net Income", "Net Income Continuous Operations")
EQUITY_LABELS = (
    "Stockholders Equity", "Common Stock Equity",
    "Total Stockholder Equity", "Total Equity Attributable To Parent")


def eps_rows(label_map):
    rows = pick_rows(label_map, EPS_LABELS[0])
    return rows if rows else pick_rows(label_map, EPS_LABELS[1])


def _find_year_prior(rows, current, years=1):
    """Match the closest like-for-like fiscal quarter/year, allowing 53-week years."""
    target_year = current[0].year - years
    options = [(abs(d.timetuple().tm_yday - current[0].timetuple().tm_yday), (d, eps))
               for d, eps in rows if d.year == target_year]
    if not options:
        return None
    drift, pair = min(options, key=lambda item: item[0])
    return pair if drift <= 45 else None


def _yoy(current, prior):
    if not current or not prior or prior[1] <= 0:
        return None
    return round((current[1] / prior[1] - 1) * 100, 2)


def calculate_growth(quarterly_eps, annual_eps):
    """quarterly_eps / annual_eps: [(period_end, eps), ...] newest first."""
    q, a = quarterly_eps, annual_eps
    latest = q[0] if q else None
    previous = q[1] if len(q) > 1 else None
    last_annual = a[0] if a else None
    old_annual = _find_year_prior(a, last_annual, years=3) if last_annual else None
    cagr = None
    if last_annual and old_annual and old_annual[1] > 0 and last_annual[1] > 0:
        cagr = round(((last_annual[1] / old_annual[1]) ** (1 / 3) - 1) * 100, 2)
    return {
        "eps_q_latest_yoy_pct": _yoy(latest, _find_year_prior(q, latest)) if latest else None,
        "eps_q_prev_yoy_pct": _yoy(previous, _find_year_prior(q, previous)) if previous else None,
        "eps_annual_3y_cagr_pct": cagr,
        "eps_q_latest_end": latest[0].isoformat() if latest else None,
        "eps_q_prev_end": previous[0].isoformat() if previous else None,
        "eps_annual_end": last_annual[0].isoformat() if last_annual else None,
    }


def annual_roe(annual_income_rows, annual_equity_rows):
    """Parent net income / average parent shareholders equity for matching FY.

    Missing or non-positive average equity yields no value.
    """
    earnings = annual_income_rows
    equity = annual_equity_rows
    for ending, profit in earnings:
        current = next(((d, n) for d, n in equity if abs((d - ending).days) <= 45), None)
        prev = next(((d, n) for d, n in equity
                     if d.year == ending.year - 1
                     and abs((d.month - ending.month) * 31 + (d.day - ending.day)) <= 45), None)
        if not current or not prev:
            continue
        mean = (current[1] + prev[1]) / 2
        if mean <= 0:
            continue
        return {"roe_pct": round(100 * profit / mean, 2),
                "roe_period_end": ending.isoformat(),
                "roe_source": ROE_SOURCE}
    return {}


def quote_metrics(quote, fast=None, *, today=None):
    """Market-cap snapshot (JPY only) and trailing-ROE fallback from a quote."""
    quote = quote if isinstance(quote, dict) else {}
    fast = fast if isinstance(fast, dict) else {}
    asof = today or date.today().isoformat()
    currency = str(quote.get("currency") or fast.get("currency") or "").upper()
    cap = finite(fast.get("market_cap"))
    cap_src = "Yahoo Finance fast_info market_cap"
    if cap is None or cap <= 0:
        cap = finite(quote.get("marketCap"))
        cap_src = "Yahoo Finance quote summary marketCap"
    result = {}
    if cap is not None and cap > 0 and currency == "JPY":
        result.update({"market_cap": round(cap), "market_cap_currency": "JPY",
                       "market_cap_asof": asof, "market_cap_source": cap_src})
    roe_ratio = finite(quote.get("returnOnEquity"))
    if roe_ratio is not None and abs(roe_ratio) <= 100:
        result["roe_pct"] = round(roe_ratio * 100, 2)
        result["roe_period_end"] = None
        result["roe_source"] = ROE_FALLBACK_SOURCE
    return result


def select_batch(stocks, cursor, limit, *, today=None, refresh_days=60):
    """Fill unseen tickers first, then refresh the oldest successfully checked.

    A ticker counts as checked only when its last attempt actually saw Yahoo
    data. The 2026-11-07 Actions run stamped every ticker as attempted even
    though Yahoo returned no statements for ~90% of them, so a stamp with no
    empty-attempt counter and still-missing Yahoo values is retried once;
    that retry records the counter, so the repair does not repeat.
    """
    if not stocks:
        return []
    today = today or date.today()
    cutoff = (today - timedelta(days=max(1, refresh_days))).isoformat()
    candidates = []
    for index, row in enumerate(stocks):
        checked = row.get("eps_yfinance_attempted_at")
        if not checked and row.get("eps_source") == SOURCE:
            checked = row.get("eps_fetched_at")
        checked = checked if isinstance(checked, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", checked) else ""
        if checked >= cutoff:
            missing_yahoo = (any(row.get(key) is None for key in GROWTH)
                             or row.get("roe_pct") is None)
            if missing_yahoo and not isinstance(row.get("eps_yfinance_empty_attempts"), int):
                pass  # legacy stamp from an empty Yahoo response: retry once
            else:
                continue
        candidates.append((bool(checked), checked, (index - cursor) % len(stocks), row))
    candidates.sort(key=lambda item: item[:3])
    return [item[3] for item in candidates[:limit]]


def select_missing_batch(stocks, limit):
    """Recheck incomplete symbols, prioritizing missing latest-quarter YoY."""
    items = [(i, row) for i, row in enumerate(stocks)
             if any(row.get(key) is None for key in GROWTH)]
    items.sort(key=lambda pair: (
        pair[1].get(GROWTH[0]) is not None,
        pair[1].get(GROWTH[2]) is not None,
        pair[1].get(GROWTH[1]) is not None,
        pair[0],
    ))
    return [row for _, row in items[:limit]]


JP_SYMBOL = re.compile(r"^[0-9]{3}[0-9A-Z]\.T$")


def normalize_jp_ticker(value):
    """JPX four-character common-share identifiers map directly to Yahoo .T."""
    raw = str(value or "").strip().upper()
    if re.fullmatch(r"[0-9]{3}[0-9A-Z]", raw):
        raw += ".T"
    return raw if JP_SYMBOL.fullmatch(raw) else None


def select_jp_batch(stocks, limit, *, cursor=0, force_missing=False,
                    refresh_days=60, today=None):
    """Prioritize unseen financials; prefer already priced issues on backfill."""
    allowed = [r for r in stocks if normalize_jp_ticker(r.get("ticker"))]
    if not allowed:
        return []
    if force_missing:
        return select_missing_batch(allowed, limit)
    priced = [r for r in allowed if r.get("asof")]
    unpriced = [r for r in allowed if not r.get("asof")]
    eligible = priced + unpriced
    return select_batch(eligible, cursor % len(eligible), limit,
                        today=today, refresh_days=refresh_days)
