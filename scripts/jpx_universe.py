"""Load the JPX month-end listed-issues Excel catalogue without extra packages.

Only domestic common-stock symbol codes (four alphanumeric characters) on
TSE Prime, Standard and Growth are included. ETFs, REITs, foreign shares,
TOKYO PRO Market and five-character preferred/subordinated shares are excluded.
TOPIX-17 sector codes are provided by JPX itself, so no heuristic mapping.
"""
from datetime import datetime
from io import BytesIO
import posixpath
import re
import time
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
from zipfile import ZipFile

URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx"
N = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PR = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def excel_col(cell_ref):
    letters = re.match(r"([A-Z]+)", cell_ref or "")
    index = 0
    for char in letters.group(1) if letters else "":
        index = index * 26 + ord(char) - 64
    return index - 1


def worksheet_rows(payload):
    with ZipFile(BytesIO(payload)) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = [
                "".join(node.text or "" for node in item.iter(N + "t"))
                for item in shared_root.findall(N + "si")
            ]
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        mapping = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels.findall(PR + "Relationship")}
        paths = []
        for sheet in workbook.findall(N + "sheets/" + N + "sheet"):
            target = mapping.get(sheet.attrib.get(R + "id"))
            if not target:
                continue
            if target.startswith("/"):
                paths.append(target.lstrip("/"))
            else:
                paths.append(posixpath.normpath(posixpath.join("xl", target)))
        for path in paths:
            if path not in archive.namelist():
                continue
            root = ET.fromstring(archive.read(path))
            rows = []
            for row in root.findall(".//" + N + "sheetData/" + N + "row"):
                cells = {}
                for cell in row.findall(N + "c"):
                    idx = excel_col(cell.attrib.get("r"))
                    if idx < 0:
                        continue
                    kind = cell.attrib.get("t")
                    if kind == "inlineStr":
                        data = "".join(t.text or "" for t in cell.iter(N + "t"))
                    else:
                        value = cell.find(N + "v")
                        data = value.text if value is not None and value.text else ""
                        if kind == "s" and data:
                            data = shared[int(data)]
                    cells[idx] = data.strip()
                if cells:
                    rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
            if any("コード" in row and "17業種コード" in row for row in rows[:8]):
                return rows
    raise ValueError("JPX worksheet did not contain the expected issue and industry columns")


def parse_catalogue(payload, sectors):
    rows = worksheet_rows(payload)
    headings = next(i for i, row in enumerate(rows[:8]) if "コード" in row and "17業種コード" in row)
    headers = {value: index for index, value in enumerate(rows[headings])}
    required = ["日付", "コード", "銘柄名", "市場・商品区分", "17業種コード", "17業種区分"]
    for key in required:
        if key not in headers:
            raise ValueError("Missing JPX column " + key)
    def column(row, key):
        i = headers[key]
        return row[i].strip() if len(row) > i else ""
    found = []
    counts = {"プライム": 0, "スタンダード": 0, "グロース": 0}
    reference = None
    excluded_types = 0
    for row in rows[headings + 1:]:
        group = column(row, "市場・商品区分")
        if "内国株式" not in group:
            continue
        market = next((name for name in counts if name in group), None)
        if market is None:
            continue
        code = column(row, "コード").upper()
        # 4-character alphanumeric stock codes include the newer 130A-style codes.
        if not re.fullmatch(r"[0-9]{3}[0-9A-Z]", code):
            excluded_types += 1
            continue
        raw_sector = column(row, "17業種コード")
        try:
            sector_id = int(float(raw_sector))
        except ValueError:
            continue
        sector = f"{1616 + sector_id}.T"
        if not (1 <= sector_id <= 17) or sector not in sectors:
            continue
        official_name = column(row, "17業種区分")
        industry_name = column(row, "33業種区分") if "33業種区分" in headers else ""
        stock_name = column(row, "銘柄名")
        if not stock_name:
            continue
        counts[market] += 1
        raw_date = column(row, "日付")
        if raw_date and not reference:
            reference = raw_date[:8]
        found.append({
            "ticker": code + ".T",
            "name": stock_name,
            "sector": sector,
            "sector_name": sectors[sector],
            "jpx_sector_name": official_name,
            "industry_name": industry_name or None,
            "industry_source": "JPX 33業種" if industry_name else None,
            "market": market,
        })
    seen = set()
    unique = []
    for item in found:
        if item["ticker"] not in seen:
            seen.add(item["ticker"])
            unique.append(item)
    if len(unique) < 3000 or len(counts) != 3:
        raise ValueError(f"JPX issue catalogue unexpectedly small: {len(unique)}")
    unique.sort(key=lambda item: item["ticker"])
    return unique, {"reference_date": reference, "market_counts": counts, "excluded_special_types": excluded_types,
                    "source": URL, "universe_size": len(unique)}


def latest_universe(sectors):
    last = None
    for attempt in range(3):
        try:
            request = Request(URL, headers={
                "User-Agent": "Mozilla/5.0 (compatible; StockDashboard/1.0; market-research)",
                "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
            })
            with urlopen(request, timeout=28) as response:
                data = response.read(2_500_000)
            if not data.startswith(b"PK"):
                raise ValueError("Expected XLSX ZIP file")
            return parse_catalogue(data, sectors)
        except Exception as error:
            last = error
            time.sleep(attempt + 1)
    raise RuntimeError(f"JPX current issues master unavailable: {last}")
