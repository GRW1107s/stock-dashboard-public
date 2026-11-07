"""Collect JPX's published large short-selling positions per stock.

JPX publishes, every business day, one Excel file (legacy .xls) listing
every reported short position whose ratio to shares outstanding reached
the disclosure threshold (0.5%; positions keep being published while
reported). Rows are per reporter, so this collector aggregates them per
stock: total ratio (%), total shares and reporter count. The change
columns diff the latest file against the previous publication day's
file, so a stock whose reporters all dropped out shows its full
decrease instead of vanishing silently.

Output: jp-short-positions.json
  {updated_at, asof, prev_asof, source,
   positions: {ticker: {ratio, shares, reporters,
                        ratio_prev, shares_prev, d_ratio, d_shares}}}

The .xls is parsed with xlrd when available, else by converting it to
.xlsx with LibreOffice headless (soffice) and reading the XML with the
standard library, else by pip-installing xlrd as a last resort. Any
failure keeps the previously stored file untouched.
"""
import datetime as dt
import json
import pathlib
import re
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "jp-short-positions.json"
INDEX_URL = "https://www.jpx.co.jp/markets/public/short-selling/index.html"
BASE = "https://www.jpx.co.jp"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                         "AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/126.0 Safari/537.36"}


def fetch(url, binary=False):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(8_000_000)
    return data if binary else data.decode("utf-8", "replace")


def latest_files(limit=2):
    """Return [(yyyymmdd, url), ...] newest first from the JPX index page."""
    html = fetch(INDEX_URL)
    found = {}
    for href in re.findall(r'href="([^"]+_Short_Positions\.xls)"', html):
        m = re.search(r"(\d{8})_Short_Positions\.xls", href)
        if m:
            found[m.group(1)] = BASE + href if href.startswith("/") else href
    dates = sorted(found, reverse=True)
    if not dates:
        raise RuntimeError("no Short_Positions files linked from JPX index")
    return [(d, found[d]) for d in dates[:limit]]


def _rows_via_xlrd(blob):
    import io
    import xlrd
    book = xlrd.open_workbook(file_contents=blob)
    sheet = book.sheet_by_index(0)
    return [[sheet.cell_value(r, c) for c in range(sheet.ncols)]
            for r in range(sheet.nrows)]


def _rows_via_soffice(blob, tag):
    import tempfile
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    from jpx_universe import worksheet_rows  # generic xlsx -> rows helper
    with tempfile.TemporaryDirectory() as tmp:
        src = pathlib.Path(tmp) / f"sp-{tag}.xls"
        src.write_bytes(blob)
        subprocess.run(["soffice", "--headless", "--convert-to", "xlsx",
                        "--outdir", tmp, str(src)],
                       check=True, timeout=180, capture_output=True)
        converted = pathlib.Path(tmp) / f"sp-{tag}.xlsx"
        # worksheet_rows picks the sheet with the catalogue headers; fall
        # back to manual parsing when it does not match this file.
        try:
            return worksheet_rows(converted.read_bytes())
        except Exception:
            pass
        import io as _io
        import xml.etree.ElementTree as ET
        from zipfile import ZipFile
        ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
        with ZipFile(_io.BytesIO(converted.read_bytes())) as archive:
            shared = []
            if "xl/sharedStrings.xml" in archive.namelist():
                root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
                shared = ["".join(t.text or "" for t in si.iter(ns + "t"))
                          for si in root.findall(ns + "si")]
            sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
            rows = []
            for row in sheet.iter(ns + "row"):
                cells = {}
                for cell in row.findall(ns + "c"):
                    value = cell.find(ns + "v")
                    if value is None or value.text is None:
                        continue
                    letters = re.match(r"[A-Z]+", cell.get("r") or "")
                    idx = 0
                    for ch in (letters.group(0) if letters else ""):
                        idx = idx * 26 + (ord(ch) - 64)
                    cells[idx - 1] = (shared[int(value.text)]
                                      if cell.get("t") == "s" else value.text)
                if cells:
                    rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
            return rows


def read_rows(blob, tag):
    try:
        return _rows_via_xlrd(blob)
    except ImportError:
        pass
    try:
        return _rows_via_soffice(blob, tag)
    except Exception as exc:
        print("SHORT_POS_SOFFICE_ERROR", str(exc)[:140], flush=True)
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "xlrd"],
                   timeout=300, capture_output=True)
    return _rows_via_xlrd(blob)


def aggregate(rows):
    """Aggregate per-reporter rows into {code: {ratio, shares, reporters}}."""
    header_at = None
    for i, row in enumerate(rows[:12]):
        joined = [str(c) for c in row]
        if "銘柄コード" in joined and any("空売り残高割合" == str(c).strip()
                                        for c in row):
            header_at = i
            break
    if header_at is None:
        raise RuntimeError("short positions header row not found")
    out = {}
    for row in rows[header_at + 2:]:  # skip the English header row
        if len(row) <= 11:
            continue
        code_raw = row[2]
        if isinstance(code_raw, float) and code_raw == int(code_raw):
            code = str(int(code_raw))
        else:
            code = str(code_raw).strip()
        if not re.fullmatch(r"[0-9][0-9A-Z]{3}", code):
            continue
        try:
            ratio = float(row[10]) * 100.0  # stored as a fraction
            shares = float(row[11])
        except (TypeError, ValueError):
            continue
        entry = out.setdefault(code, {"ratio": 0.0, "shares": 0.0, "reporters": 0})
        entry["ratio"] += ratio
        entry["shares"] += shares
        entry["reporters"] += 1
    if len(out) < 100:
        raise RuntimeError(f"short positions look wrong: only {len(out)} stocks")
    return out


def collect():
    files = latest_files(2)
    per_day = []
    for date, url in files:
        blob = fetch(url, binary=True)
        agg = aggregate(read_rows(blob, date))
        per_day.append((date, agg))
        print(f"SHORT_POS {date} stocks={len(agg)}", flush=True)
    (date_new, new), *rest = per_day
    old = rest[0][1] if rest else {}
    date_old = rest[0][0] if rest else None
    positions = {}
    for code in sorted(set(new) | set(old)):
        cur = new.get(code)
        prev = old.get(code)
        ratio = round(cur["ratio"], 4) if cur else 0.0
        ratio_prev = round(prev["ratio"], 4) if prev else 0.0
        shares = int(cur["shares"]) if cur else 0
        shares_prev = int(prev["shares"]) if prev else 0
        positions[f"{code}.T"] = {
            "ratio": ratio if cur else None,
            "shares": shares if cur else None,
            "reporters": cur["reporters"] if cur else 0,
            "ratio_prev": ratio_prev if prev else None,
            "shares_prev": shares_prev if prev else None,
            "d_ratio": round(ratio - ratio_prev, 4),
            "d_shares": shares - shares_prev,
        }
    payload = {
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "asof": f"{date_new[:4]}-{date_new[4:6]}-{date_new[6:]}",
        "prev_asof": (f"{date_old[:4]}-{date_old[4:6]}-{date_old[6:]}"
                      if date_old else None),
        "source": "JPX official daily publication of reportable short "
                  "positions (Short_Positions.xls), aggregated per stock",
        "positions": positions,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"SHORT_POSITIONS_DONE stocks_with_positions="
          f"{sum(1 for p in positions.values() if p['ratio'] is not None)} "
          f"asof={payload['asof']} prev={payload['prev_asof']}", flush=True)
    return payload


def load_positions():
    """Stored positions dict, or {} when unavailable."""
    try:
        data = json.loads(OUT.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def main():
    collect()


if __name__ == "__main__":
    main()
