"""GICS classification for US listings from public Wikipedia tables.

The S&P 500 constituents CSV carries GICS Sub-Industry, but the broader
universe does not. Wikipedia's S&P MidCap 400 and SmallCap 600 lists use
the same GICS columns, and the GICS article publishes the full
Sub-Industry -> Industry structure. Parsing those tables lifts GICS
coverage from the S&P 500 (~500 names) to the S&P 1500 (~1,170 of this
dashboard's ~1,800-name universe). Everything here is best-effort: any
fetch or parse failure returns empty maps and the caller falls back to
the previous behaviour (Nasdaq screener industry labels).

Tables on those pages use rowspan/colspan heavily, so the parser expands
spans into a full grid before extracting columns.
"""
from __future__ import annotations

from html.parser import HTMLParser
import urllib.request

WIKI_SP400_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies"
WIKI_SP600_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_600_companies"
WIKI_GICS_URL = "https://en.wikipedia.org/wiki/Global_Industry_Classification_Standard"

_UA = {"User-Agent": "Mozilla/5.0 (compatible; stock-dashboard-public/1.0)"}


class _GridParser(HTMLParser):
    """Expand rowspan/colspan so every row is a complete list of cells."""

    def __init__(self):
        super().__init__()
        self.tables = []
        self._rows = None
        self._row = None
        self._cell = None
        self._span = (1, 1)
        self._carry = {}

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._rows = []
            self._carry = {}
        elif tag == "tr" and self._rows is not None:
            self._row = {}
            for col, (text, left) in list(self._carry.items()):
                if left > 0:
                    self._row[col] = text
                    self._carry[col] = (text, left - 1)
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
            attr = dict(attrs)
            try:
                self._span = (int(attr.get("rowspan", 1)),
                              int(attr.get("colspan", 1)))
            except (TypeError, ValueError):
                self._span = (1, 1)

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None:
            text = " ".join("".join(self._cell).split())
            col = 0
            while col in self._row:
                col += 1
            rowspan, colspan = self._span
            for k in range(colspan):
                self._row[col + k] = text
                if rowspan > 1:
                    self._carry[col + k] = (text, rowspan - 1)
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                width = max(self._row) + 1
                self._rows.append([self._row.get(i, "") for i in range(width)])
            self._row = None
        elif tag == "table" and self._rows is not None:
            self.tables.append(self._rows)
            self._rows = None


def _fetch_tables(url):
    request = urllib.request.Request(url, headers=_UA)
    html = urllib.request.urlopen(request, timeout=60).read().decode(
        "utf-8", "replace")
    parser = _GridParser()
    parser.feed(html)
    return parser.tables


def wikipedia_constituents(url):
    """{ticker: (gics_sector, gics_sub_industry)} from a constituents page."""
    for table in _fetch_tables(url):
        if not table:
            continue
        head = [cell.lower() for cell in table[0]]
        if "symbol" not in head:
            continue
        sub_cols = [i for i, c in enumerate(head)
                    if "gics" in c and "sub" in c]
        sector_cols = [i for i, c in enumerate(head)
                       if "gics" in c and "sector" in c]
        if not sub_cols or not sector_cols:
            continue
        si, gi, ii = head.index("symbol"), sector_cols[-1], sub_cols[-1]
        out = {}
        for row in table[1:]:
            if len(row) > max(si, gi, ii) and row[si]:
                ticker = row[si].replace(".", "-").strip().upper()
                if ticker:
                    out[ticker] = (row[gi], row[ii])
        if out:
            return out
    return {}


def gics_sub_to_industry():
    """{sub_industry: industry} from the GICS structure table (163 subs)."""
    for table in _fetch_tables(WIKI_GICS_URL):
        if not table:
            continue
        head = [cell.lower() for cell in table[0]]
        if "sub-industry" not in head or "industry" not in head:
            continue
        # The structure table pairs (code, name) columns per level, so
        # the name columns are the last occurrence of each header.
        si = len(head) - 1 - head[::-1].index("sub-industry")
        ii = len(head) - 1 - head[::-1].index("industry")
        out = {}
        for row in table[1:]:
            if len(row) > max(si, ii) and row[si] and row[ii]:
                out[row[si]] = row[ii]
        if len(out) > 100:
            return out
    return {}


def load_us_gics():
    """Return (extra, sub_to_industry, stats); never raises.

    extra: {ticker: {"gics_sector", "sub", "group"}} for S&P 400/600 names.
    """
    extra = {}
    stats = {}
    for group, url in (("S&P400", WIKI_SP400_URL), ("S&P600", WIKI_SP600_URL)):
        try:
            found = wikipedia_constituents(url)
            for ticker, (sector, sub) in found.items():
                extra.setdefault(ticker, {"gics_sector": sector,
                                          "sub": sub, "group": group})
            stats[group] = len(found)
        except Exception as err:
            stats[group + "_error"] = str(err)[:120]
    try:
        sub_to_industry = gics_sub_to_industry()
        stats["structure_subs"] = len(sub_to_industry)
    except Exception as err:
        sub_to_industry = {}
        stats["structure_error"] = str(err)[:120]
    return extra, sub_to_industry, stats
