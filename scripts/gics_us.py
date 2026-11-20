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


# Nasdaq screener industry -> GICS sub-industry, for US names that are
# not in any S&P index list (no published GICS classification). The
# industry level is derived from the GICS structure table at runtime,
# so industry/sub pairs are always consistent. Values were validated
# against the live GICS structure (all targets exist).
NASDAQ_GICS_CROSSWALK = {
    'Accident &Health Insurance': 'Life & Health Insurance',
    'Advertising': 'Advertising',
    'Aerospace': 'Aerospace & Defense',
    'Agricultural Chemicals': 'Fertilizers & Agricultural Chemicals',
    'Air Freight/Delivery Services': 'Air Freight & Logistics',
    'Apparel': 'Apparel, Accessories & Luxury Goods',
    'Auto Manufacturing': 'Automobile Manufacturers',
    'Auto Parts:O.E.M.': 'Automotive Parts & Equipment',
    'Beverages (Production/Distribution)': 'Soft Drinks & Non-alcoholic Beverages',
    'Biotechnology: Biological Products (No Diagnostic Substances)': 'Biotechnology',
    'Biotechnology: Commercial Physical & Biological Resarch': 'Life Sciences Tools & Services',
    'Biotechnology: Electromedical & Electrotherapeutic Apparatus': 'Health Care Equipment',
    'Biotechnology: In Vitro & In Vivo Diagnostic Substances': 'Life Sciences Tools & Services',
    'Biotechnology: Laboratory Analytical Instruments': 'Life Sciences Tools & Services',
    'Biotechnology: Pharmaceutical Preparations': 'Pharmaceuticals',
    'Books': 'Publishing',
    'Broadcasting': 'Broadcasting',
    'Building Materials': 'Building Products',
    'Building operators': 'Real Estate Operating Companies',
    'Business Services': 'Diversified Support Services',
    'Cable & Other Pay Television Services': 'Cable & Satellite',
    'Catalog/Specialty Distribution': 'Broadline Retail',
    'Coal Mining': 'Coal & Consumable Fuels',
    'Commercial Banks': 'Regional Banks',
    'Computer Software: Prepackaged Software': 'Application Software',
    'Computer Software: Programming Data Processing': 'IT Consulting & Other Services',
    'Computer peripheral equipment': 'Technology Hardware, Storage & Peripherals',
    'Consumer Electronics/Appliances': 'Consumer Electronics',
    'Department/Specialty Retail Stores': 'Broadline Retail',
    'Diversified Commercial Services': 'Diversified Support Services',
    'Diversified Financial Services': 'Diversified Financial Services',
    'EDP Services': 'Data Processing & Outsourced Services',
    'Electric Utilities: Central': 'Electric Utilities',
    'Electrical Products': 'Electrical Components & Equipment',
    'Electronic Components': 'Electronic Components',
    'Engineering & Construction': 'Construction & Engineering',
    'Environmental Services': 'Environmental & Facilities Services',
    'Farming/Seeds/Milling': 'Agricultural Products & Services',
    'Finance Companies': 'Consumer Finance',
    'Finance/Investors Services': 'Asset Management & Custody Banks',
    'Finance: Consumer Services': 'Consumer Finance',
    'Food Chains': 'Consumer Staples Merchandise Retail',
    'Forest Products': 'Forest Products',
    'Homebuilding': 'Homebuilding',
    'Hospital/Nursing Management': 'Health Care Facilities',
    'Hotels/Resorts': 'Hotels, Resorts & Cruise Lines',
    'Industrial Machinery/Components': 'Industrial Machinery & Supplies & Components',
    'Industrial Specialties': 'Specialty Chemicals',
    'Integrated oil Companies': 'Integrated Oil & Gas',
    'Investment Bankers/Brokers/Service': 'Investment Banking & Brokerage',
    'Investment Managers': 'Asset Management & Custody Banks',
    'Life Insurance': 'Life & Health Insurance',
    'Major Banks': 'Diversified Banks',
    'Major Chemicals': 'Diversified Chemicals',
    'Marine Transportation': 'Marine Transportation',
    'Meat/Poultry/Fish': 'Packaged Foods & Meats',
    'Medical Electronics': 'Health Care Equipment',
    'Medical Specialities': 'Health Care Equipment',
    'Medical/Dental Instruments': 'Health Care Equipment',
    'Medical/Nursing Services': 'Health Care Facilities',
    'Medicinal Chemicals and Botanical Products': 'Pharmaceuticals',
    'Metal Fabrications': 'Industrial Machinery & Supplies & Components',
    'Metal Mining': 'Diversified Metals & Mining',
    'Military/Government/Technical': 'Aerospace & Defense',
    'Mining & Quarrying of Nonmetallic Minerals (No Fuels)': 'Construction Materials',
    'Misc Corporate Leasing Services': 'Specialized Finance',
    'Misc Health and Biotechnology Services': 'Health Care Services',
    'Movies/Entertainment': 'Movies & Entertainment',
    'Natural Gas Distribution': 'Gas Utilities',
    'Oil & Gas Production': 'Oil & Gas Exploration & Production',
    'Oil/Gas Transmission': 'Oil & Gas Storage & Transportation',
    'Oilfield Services/Equipment': 'Oil & Gas Equipment & Services',
    'Ophthalmic Goods': 'Health Care Supplies',
    'Other Consumer Services': 'Specialized Consumer Services',
    'Other Metals and Minerals': 'Diversified Metals & Mining',
    'Other Specialty Stores': 'Other Specialty Retail',
    'Package Goods/Cosmetics': 'Personal Care Products',
    'Packaged Foods': 'Packaged Foods & Meats',
    'Paper': 'Paper Products',
    'Pollution Control Equipment': 'Environmental & Facilities Services',
    'Power Generation': 'Independent Power Producers & Energy Traders',
    'Precious Metals': 'Precious Metals & Minerals',
    'Professional Services': 'Research & Consulting Services',
    'Professional and commerical equipment': 'Trading Companies & Distributors',
    'Property-Casualty Insurers': 'Property & Casualty Insurance',
    'Publishing': 'Publishing',
    'RETAIL: Building Materials': 'Home Improvement Retail',
    'Radio And Television Broadcasting And Communications Equipment': 'Communications Equipment',
    'Railroads': 'Rail Transportation',
    'Real Estate': 'Real Estate Operating Companies',
    'Real Estate Investment Trusts': 'Diversified REITs',
    'Rental/Leasing Companies': 'Trading Companies & Distributors',
    'Restaurants': 'Restaurants',
    'Retail-Auto Dealers and Gas Stations': 'Automotive Retail',
    'Retail-Drug Stores and Proprietary Stores': 'Drug Retail',
    'Retail: Computer Software & Peripheral Equipment': 'Computer & Electronics Retail',
    'Savings Institutions': 'Regional Banks',
    'Semiconductors': 'Semiconductors',
    'Services-Misc. Amusement & Recreation': 'Leisure Facilities',
    'Shoe Manufacturing': 'Footwear',
    'Specialty Foods': 'Packaged Foods & Meats',
    'Specialty Insurers': 'Property & Casualty Insurance',
    'Steel/Iron Ore': 'Steel',
    'Telecommunications Equipment': 'Communications Equipment',
    'Transportation Services': 'Air Freight & Logistics',
    'Trucking Freight/Courier Services': 'Cargo Ground Transportation',
    'Trusts Except Educational Religious and Charitable': 'Diversified REITs',
    'Water Supply': 'Water Utilities',
}
