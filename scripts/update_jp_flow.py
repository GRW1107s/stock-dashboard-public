"""Large-player (大口) data for the Nikkei options tab.

Two free JPX publications, both fetched best-effort:

- Weekly open interest by transaction participant (取引参加者別建玉残高,
  Nikkei 225 options): for the front monthly series, per strike and side,
  the top net-short / net-long participants. Converted to signed net
  positions for the eight firms the front-end panel tracks.
  -> options.json jp.participants: [{date, expiry, strike, side, firm, net}]
  The dated files stay on the JPX site for years, so missing weeks are
  backfilled from the yearly index (the last 12 publication dates kept).

- Daily trading volume by participant (取引参加者別取引高, day session +
  night session files summed = 日通し): per contract the top participants.
  -> options.json jp.flow: {date, rows: [{expiry, strike, side, firm, vol}]}
  Only the eight tracked firms are kept, matching the panel's columns.

Run from update_sector_leaders.py after update_options.
"""

import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from update_options import _fetch, _num, _read_json, _second_friday, _sheet_rows

JPX = "https://www.jpx.co.jp"
OI_INDEX_URL = JPX + "/automation/markets/derivatives/open-interest/json/open_interest_{year}.json"
PV_URL = (JPX + "/automation/markets/derivatives/participant-volume/files/"
          "daily/{ym}/{ymd}_volume_by_participant_{kind}.xlsx")

# Participant code -> short label used by the front-end panel.
FIRM_BY_CODE = {
    "11560": "GS",    # ゴールドマン証券
    "11714": "JPM",   # ＪＰモルガン証券
    "11746": "UBS",   # ＵＢＳ証券
    "12428": "BNP",   # ＢＮＰパリバ証券
    "12800": "MS",    # モルガンＭＵＦＧ証券
    "11788": "SG",    # ソシエテＧ証券
    "12479": "ABN",   # ＡＢＮクリアリン証券
    "12400": "野村",  # 野村証券
}
KEEP_WEEKS = 12

PV_CONTRACT = re.compile(r"^NIKKEI 225 OOP ([CP])(\d{4})-(\d+)$")
OI_DATE = re.compile(r"(\d{4})年(\d{1,2})月(\d{1,2})日現在")
OI_EXPIRY = re.compile(r"(\d{4})年(\d{1,2})月限月")


def _sq_iso(yymm):
    year, month = 2000 + int(yymm[:2]), int(yymm[2:])
    return _second_friday(year, month).isoformat()


# ---------------------------------------------------------------- weekly OI

def parse_oi_tp(xlsx_bytes):
    """One weekly participant-OI workbook -> (date, expiry, net rows)."""
    rows = _sheet_rows(xlsx_bytes, "BO_DD0122")
    asof = expiry = None
    for row in rows:
        for value in row.values():
            if not isinstance(value, str):
                continue
            m = OI_DATE.search(value)
            if m:
                asof = date(int(m.group(1)), int(m.group(2)),
                            int(m.group(3))).isoformat()
            m = OI_EXPIRY.search(value)
            if m and expiry is None:
                expiry = _second_friday(int(m.group(1)),
                                        int(m.group(2))).isoformat()
    if not asof or not expiry:
        return None
    net = {}

    def add(strike, side, code, qty, sign):
        firm = FIRM_BY_CODE.get(str(code).strip())
        if not firm or not qty:
            return
        key = (strike, side, firm)
        net[key] = net.get(key, 0) + sign * int(qty)

    for row in rows:
        rank = row.get(0)
        if not isinstance(rank, str) or not rank.strip().isdigit():
            continue
        # Put block: strike col 1, sell 2/4, buy 5/7. Call block: +10.
        for base, side in ((0, "P"), (10, "C")):
            strike = _num(row.get(base + 1))
            if not strike:
                continue
            add(int(strike), side, row.get(base + 2),
                _num(row.get(base + 4)), -1)
            add(int(strike), side, row.get(base + 5),
                _num(row.get(base + 7)), +1)
    out = [{"date": asof, "expiry": expiry, "strike": strike, "side": side,
            "firm": firm, "net": value}
           for (strike, side, firm), value in sorted(net.items()) if value]
    return asof, expiry, out


def refresh_participants(stored_rows):
    """Backfill any missing publication weeks from the JPX yearly index."""
    rows = list(stored_rows or [])
    have = {r["date"] for r in rows}
    today = datetime.now(ZoneInfo("Asia/Tokyo")).date()
    entries = []
    for year in (today.year, today.year - 1):
        try:
            doc = json.loads(_fetch(OI_INDEX_URL.format(year=year),
                                    timeout=30).decode("utf-8"))
        except Exception:
            continue
        for item in doc.get("TableDatas") or []:
            ymd = str(item.get("TradeDate") or "")
            path = item.get("IndexOptions")
            if len(ymd) == 8 and path:
                entries.append((ymd, path))
    entries.sort()
    keep = {ymd for ymd, _ in entries[-KEEP_WEEKS:]}
    changed = False
    for ymd, path in entries:
        iso = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}"
        if ymd not in keep or iso in have:
            continue
        try:
            parsed = parse_oi_tp(_fetch(JPX + path, timeout=30))
        except Exception:
            parsed = None
        if parsed:
            rows.extend(parsed[2])
            have.add(iso)
            changed = True
    rows = [r for r in rows
            if f"{r['date'][:4]}{r['date'][5:7]}{r['date'][8:]}" in keep]
    rows.sort(key=lambda r: (r["date"], r["strike"], r["side"], r["firm"]))
    return rows, changed or len(rows) != len(stored_rows or [])


# ------------------------------------------------------------- daily volume

def parse_pv(xlsx_bytes, acc):
    rows = _sheet_rows(xlsx_bytes, "手口上位一覧")
    for row in rows:
        if row.get(0) != "NK225E":
            continue
        m = PV_CONTRACT.match(str(row.get(2) or "").strip())
        code = str(row.get(4) or "").strip()
        vol = _num(row.get(7))
        if not m or code not in FIRM_BY_CODE or not vol:
            continue
        side, yymm, strike = m.group(1), m.group(2), int(m.group(3))
        key = (_sq_iso(yymm), strike, side, FIRM_BY_CODE[code])
        acc[key] = acc.get(key, 0) + int(vol)
    return acc


def refresh_flow(stored):
    """Latest session's participant volume (day + night sessions summed)."""
    today = datetime.now(ZoneInfo("Asia/Tokyo")).date()
    for back in range(0, 7):
        day = today - timedelta(days=back)
        iso = day.isoformat()
        if stored and stored.get("date") == iso:
            return stored, False
        acc = {}
        try:
            for kind in ("whole_day", "night"):
                raw = _fetch(PV_URL.format(ym=day.strftime("%Y%m"),
                                           ymd=day.strftime("%Y%m%d"),
                                           kind=kind), timeout=30)
                parse_pv(raw, acc)
        except Exception:
            continue
        if not acc:
            continue
        rows = [{"expiry": expiry, "strike": strike, "side": side,
                 "firm": firm, "vol": vol}
                for (expiry, strike, side, firm), vol in sorted(acc.items())]
        return {"date": iso, "rows": rows}, True
    return stored, False


# ------------------------------------------------------------------- driver

def run(root):
    root = Path(root)
    out_path = root / "options.json"
    doc = _read_json(out_path) or {}
    jp = doc.get("jp")
    if not jp:
        return doc
    changed = False
    try:
        participants, p_changed = refresh_participants(jp.get("participants"))
        if p_changed:
            jp["participants"] = participants
            changed = True
        print("FLOW_PARTICIPANTS", len(jp.get("participants") or []),
              flush=True)
    except Exception as err:
        print("FLOW_PARTICIPANTS_ERROR", str(err)[:150], flush=True)
    try:
        flow, f_changed = refresh_flow(jp.get("flow"))
        if f_changed:
            jp["flow"] = flow
            changed = True
        print("FLOW_VOLUME", (jp.get("flow") or {}).get("date"), flush=True)
    except Exception as err:
        print("FLOW_VOLUME_ERROR", str(err)[:150], flush=True)
    if changed:
        doc["updated_at"] = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat(
            timespec="seconds")
        out_path.write_text(json.dumps(doc, ensure_ascii=False),
                            encoding="utf-8")
        print("FLOW_WROTE", out_path.name, flush=True)
    return doc


if __name__ == "__main__":
    run(Path(__file__).resolve().parent.parent)
