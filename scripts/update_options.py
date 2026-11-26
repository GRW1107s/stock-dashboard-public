"""Options positioning data for the public dashboard (index options only).

JP: Nikkei 225 options open interest by strike, from the JPX daily
open-interest Excel (free; published about 20:00 JST on trading days).
US: SPX options chain (SPX / SPXW / SPXO roots) from the CBOE delayed
quotes JSON (free; delayed data).

Writes options.json at the repository root:

    {"updated_at": ..., "jp": {...} | null, "us": {...} | null}

Each market block:
    {"date": "YYYY-MM-DD", "spot": float | null, "iv30": float | null,
     "expiries": [{"expiry": "YYYY-MM-DD", "label": "...", "monthly": bool,
                   "call_oi": int, "put_oi": int, "call_vol": int,
                   "put_vol": int, "pc_oi": float | null,
                   "pc_vol": float | null, "max_pain": float | null,
                   "atm_iv": float | null,
                   "strikes": [[strike, call_oi, put_oi, call_vol, put_vol],
                               ...]}, ...]}

The two markets refresh independently: a failure on one side keeps the
stored block for that side. Called from update_sector_leaders.py on
every pipeline run (best-effort, like the other stores).
"""

import io
import json
import re
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
import xml.etree.ElementTree as ET

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
JPX_OI_URL = ("https://www.jpx.co.jp/markets/derivatives/trading-volume/"
              "t13vrt0000026aes-att/{ymd}open_interest.xlsx")
CBOE_SPX_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json"
MAX_EXPIRIES = 3
MAX_STRIKES = 81
SHEET_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
            "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
NK_CODE = re.compile(r"^NIKKEI 225 ([CP])(\d{4})-(\d+)$")
OCC_CODE = re.compile(r"^(SPXW|SPXO|SPX)(\d{6})([CP])(\d{8})$")


def _fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def _num(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _max_pain(strikes):
    """Strike minimising the total intrinsic payout at expiry."""
    pts = sorted({s for s, coi, poi, _, _ in strikes if coi or poi})
    if not pts:
        return None
    best, best_pay = None, None
    for k in pts:
        pay = 0.0
        for s, coi, poi, _, _ in strikes:
            if k > s:
                pay += coi * (k - s)
            elif s > k:
                pay += poi * (s - k)
        if best_pay is None or pay < best_pay:
            best, best_pay = k, pay
    return best


def _trim_strikes(strikes, spot):
    """Keep at most MAX_STRIKES strikes nearest the spot (all if no spot)."""
    rows = [list(s) for s in strikes if s[1] or s[2] or s[3] or s[4]]
    rows.sort(key=lambda s: s[0])
    if spot and len(rows) > MAX_STRIKES:
        rows.sort(key=lambda s: abs(s[0] - spot))
        rows = sorted(rows[:MAX_STRIKES], key=lambda s: s[0])
    elif len(rows) > MAX_STRIKES:
        rows.sort(key=lambda s: -(s[1] + s[2]))
        rows = sorted(rows[:MAX_STRIKES], key=lambda s: s[0])
    return rows


def _expiry_block(expiry, label, monthly, all_strikes, spot, atm_iv=None):
    """Totals and max pain use every strike; the stored strike list is
    trimmed to the ones nearest the spot for display."""
    call_oi = sum(s[1] for s in all_strikes)
    put_oi = sum(s[2] for s in all_strikes)
    call_vol = sum(s[3] for s in all_strikes)
    put_vol = sum(s[4] for s in all_strikes)
    return {
        "expiry": expiry, "label": label, "monthly": monthly,
        "call_oi": call_oi, "put_oi": put_oi,
        "call_vol": call_vol, "put_vol": put_vol,
        "pc_oi": round(put_oi / call_oi, 3) if call_oi else None,
        "pc_vol": round(put_vol / call_vol, 3) if call_vol else None,
        "max_pain": _max_pain(all_strikes),
        "atm_iv": atm_iv,
        "strikes": _trim_strikes(all_strikes, spot),
    }


# ---------------------------------------------------------------- JP (JPX)

def _col_index(ref):
    m = re.match(r"([A-Z]+)", ref or "")
    n = 0
    for ch in (m.group(1) if m else ""):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _sheet_rows(xlsx_bytes, sheet_name):
    """Rows of one sheet as {column_index: value} dicts (stdlib xlsx)."""
    with zipfile.ZipFile(io.BytesIO(xlsx_bytes)) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", SHEET_NS):
                shared.append("".join(
                    t.text or "" for t in si.iter(
                        "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")))
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        targets = {rel.get("Id"): rel.get("Target") for rel in rels}
        path = None
        for sheet in wb.iter(
                "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheet"):
            if sheet.get("name") == sheet_name:
                target = targets[sheet.get(
                    "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")]
                path = "xl/" + target.lstrip("/").replace("xl/", "", 1) \
                    if target.startswith("/") else "xl/" + target \
                    if not target.startswith("xl/") else target
        if path is None:
            raise ValueError(f"sheet not found: {sheet_name}")
        root = ET.fromstring(z.read(path))
    rows = []
    for row in root.iter(
            "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row"):
        cells = {}
        for c in row.findall("m:c", SHEET_NS):
            v = c.find("m:v", SHEET_NS)
            if c.get("t") == "s" and v is not None:
                val = shared[int(v.text)]
            elif v is not None:
                val = v.text
            else:
                continue
            cells[_col_index(c.get("r"))] = val
        rows.append(cells)
    return rows


def _second_friday(year, month):
    d = date(year, month, 1)
    first_friday = d + timedelta(days=(4 - d.weekday()) % 7)
    return first_friday + timedelta(days=7)


def parse_jp_oi(xlsx_bytes, spot):
    """Nikkei 225 (large) options from the JPX open-interest workbook."""
    rows = _sheet_rows(xlsx_bytes, "別紙1")
    by_expiry = {}
    for row in rows:
        for base, side in ((0, "P"), (6, "C")):
            code = row.get(base)
            if not isinstance(code, str):
                continue
            m = NK_CODE.match(code.strip())
            if not m or m.group(1) != side:
                continue
            yymm, strike = m.group(2), int(m.group(3))
            vol, oi = _num(row.get(base + 1)), _num(row.get(base + 2))
            entry = by_expiry.setdefault(yymm, {}).setdefault(
                strike, [strike, 0, 0, 0, 0])
            if side == "C":
                entry[1], entry[3] = oi, vol
            else:
                entry[2], entry[4] = oi, vol
    expiries = []
    for yymm in sorted(by_expiry)[:MAX_EXPIRIES]:
        year, month = 2000 + int(yymm[:2]), int(yymm[2:])
        sq = _second_friday(year, month)
        expiries.append(_expiry_block(
            sq.isoformat(), f"{year}年{month}月限", True,
            list(by_expiry[yymm].values()), spot))
    return expiries


def refresh_jp(root, stored, today_jst):
    """Fetch the newest JPX file; skip when the stored date is current."""
    data_json = _read_json(root / "data.json") or {}
    spot = None
    tse_rows = data_json.get("tse_rows") or []
    if tse_rows:
        spot = (tse_rows[0].get("nikkei") or {}).get("close")
    for back in range(0, 7):
        day = today_jst - timedelta(days=back)
        if stored and stored.get("date") == day.isoformat():
            return stored, False
        try:
            raw = _fetch(JPX_OI_URL.format(ymd=day.strftime("%Y%m%d")),
                         timeout=30)
        except Exception:
            continue
        expiries = parse_jp_oi(raw, spot)
        if not expiries:
            continue
        block = {"date": day.isoformat(), "spot": spot, "iv30": None,
                 "expiries": expiries}
        # Keep prior daily snapshots for like-for-like strike comparisons.
        history = list((stored or {}).get("history") or [])
        if stored and stored.get("date") != block["date"]:
            history.append({k: stored[k] for k in ("date", "expiries") if k in stored})
        block["history"] = sorted(
            {h["date"]: h for h in history if h.get("date") and h["date"] < block["date"]}.values(),
            key=lambda h: h["date"])[-30:]
        return block, True
    return stored, False


# ---------------------------------------------------------------- US (CBOE)

def parse_spx(payload, spot_hint=None, session_date=None):
    data = payload.get("data") or {}
    spot = data.get("current_price") or spot_hint
    iv30 = data.get("iv30")
    by_expiry = {}
    monthly = {}
    atm = {}
    for opt in data.get("options") or []:
        m = OCC_CODE.match(str(opt.get("option") or ""))
        if not m:
            continue
        root, ymd, side, strike_raw = m.groups()
        try:
            expiry = datetime.strptime(ymd, "%y%m%d").date()
        except ValueError:
            continue
        strike = int(strike_raw) / 1000.0
        oi = _num(opt.get("open_interest"))
        vol = _num(opt.get("volume"))
        entry = by_expiry.setdefault(expiry, {}).setdefault(
            strike, [strike, 0, 0, 0, 0])
        if side == "C":
            entry[1], entry[3] = oi, vol
        else:
            entry[2], entry[4] = oi, vol
        if expiry.weekday() == 4 and 15 <= expiry.day <= 21:
            monthly[expiry] = True  # third Friday = standard monthly
        iv = opt.get("iv") or 0
        if spot and 0.02 < iv < 1.5 and abs(strike - spot) <= 25:
            atm.setdefault(expiry, []).append((abs(strike - spot), iv))
    if not by_expiry:
        return None
    all_expiries = sorted(by_expiry)
    chosen = [all_expiries[0]]
    for exp in all_expiries:
        if len(chosen) >= MAX_EXPIRIES:
            break
        if monthly.get(exp) and exp not in chosen:
            chosen.append(exp)
    for exp in all_expiries:
        if len(chosen) >= MAX_EXPIRIES:
            break
        if exp not in chosen:
            chosen.append(exp)
    expiries = []
    for exp in sorted(chosen):
        ivs = sorted(iv for _, iv in sorted(atm.get(exp, []))[:4])
        atm_iv = round(ivs[len(ivs) // 2] * 100, 1) if ivs else None
        if session_date:
            try:
                days_left = (exp - date.fromisoformat(session_date)).days
            except ValueError:
                days_left = 99
            if days_left < 2:
                atm_iv = None  # same/next-day IV is not meaningful
        label = f"{exp.month}月{exp.day}日限"
        expiries.append(_expiry_block(
            exp.isoformat(), label, bool(monthly.get(exp)),
            list(by_expiry[exp].values()), spot, atm_iv=atm_iv))
    return {"date": session_date, "spot": spot,
            "iv30": round(float(iv30), 1) if iv30 else None,
            "expiries": expiries}


def refresh_us(root, stored):
    data_json = _read_json(root / "data.json") or {}
    rows = data_json.get("rows") or []
    spot_hint, session_date = None, None
    if rows:
        spot_hint = (rows[0].get("sp500") or {}).get("close")
        session_date = rows[0].get("date")
    raw = _fetch(CBOE_SPX_URL, timeout=90)
    block = parse_spx(json.loads(raw), spot_hint, session_date)
    if not block:
        return stored, False
    return block, True


# ---------------------------------------------------------------- driver

def _read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return None


def run(root):
    root = Path(root)
    out_path = root / "options.json"
    doc = _read_json(out_path) or {}
    today_jst = datetime.now(ZoneInfo("Asia/Tokyo")).date()
    changed = False
    try:
        jp, jp_changed = refresh_jp(root, doc.get("jp"), today_jst)
        if jp_changed:
            doc["jp"] = jp
            changed = True
        print("OPTIONS_JP", (jp or {}).get("date"), flush=True)
    except Exception as err:
        print("OPTIONS_JP_ERROR", str(err)[:150], flush=True)
    try:
        us, us_changed = refresh_us(root, doc.get("us"))
        if us_changed:
            doc["us"] = us
            changed = True
        print("OPTIONS_US", (us or {}).get("date"), flush=True)
    except Exception as err:
        print("OPTIONS_US_ERROR", str(err)[:150], flush=True)
    if changed:
        doc["updated_at"] = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat(
            timespec="seconds")
        out_path.write_text(json.dumps(doc, ensure_ascii=False),
                            encoding="utf-8")
        print("OPTIONS_WROTE", out_path.name, flush=True)
    return doc


if __name__ == "__main__":
    run(Path(__file__).resolve().parent.parent)
