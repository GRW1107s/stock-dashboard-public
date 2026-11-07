"""Collect JPX's daily per-stock margin trading balances (all issues).

JPX publishes the 銘柄別信用取引残高表 (mtall) every business day as a
fixed-layout PDF: for every marginable issue, the total short margin
balance (売残高), total long margin balance (買残高) and their daily
changes. This collector extracts the share-count rows with pdftotext
-layout and tokenises them (the printed code is the 5-digit unified
code; the screener uses its first four characters). Derived fields
follow the usual presentation: change rates are versus the previous
day's balance, and 信用倍率 is buy / sell.

Output: jp-margin-balances.json
  {updated_at, asof, source,
   balances: {ticker: {sell, sell_d, sell_pct,
                       buy, buy_d, buy_pct, ratio}}}

Parsing is validated (stock count and a non-negative-balance check);
any failure keeps the previously stored file untouched.
"""
import datetime as dt
import json
import pathlib
import re
import subprocess
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "jp-margin-balances.json"
PAGE_URL = "https://www.jpx.co.jp/markets/statistics-equities/margin/01.html"
BASE = "https://www.jpx.co.jp"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                         "AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/126.0 Safari/537.36"}
NUM = re.compile(r"^▲?[0-9][0-9,]*$")
PCT = re.compile(r"^(▲?[0-9][0-9,]*(\.[0-9]+)?%|\*|-)$")
CODE5 = re.compile(r"(?<![0-9A-Z])([0-9][0-9A-Z]{3}[0-9])(?![0-9A-Z])")
CODE4 = re.compile(r"[0-9][0-9A-Z]{3}")


def fetch(url, binary=False):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read(16_000_000)
    return data if binary else data.decode("utf-8", "replace")


def latest_pdf():
    html = fetch(PAGE_URL)
    found = {}
    for href in re.findall(r'href="([^"]+_mtall\.pdf)"', html):
        m = re.search(r"(\d{8})_mtall\.pdf", href)
        if m:
            found[m.group(1)] = BASE + href if href.startswith("/") else href
    if not found:
        raise RuntimeError("no mtall PDF linked from JPX margin page")
    date = max(found)
    return date, found[date]


def to_int(token):
    token = token.replace(",", "")
    if token.startswith("▲"):
        return -int(token[1:])
    return int(token)


def parse_balances(text):
    balances = {}
    for line in text.splitlines():
        if "株数" not in line:
            continue
        m = CODE5.search(line)
        if not m:
            continue
        code = m.group(1)[:4]
        if not CODE4.fullmatch(code):
            continue
        rest = line[m.end():]
        raw = rest.split()
        merged = []
        for i, t in enumerate(raw):
            if t == "▲" and i + 1 < len(raw) and NUM.match(raw[i + 1]):
                merged.append("▲" + raw[i + 1])
            elif i > 0 and raw[i - 1] == "▲" and NUM.match(t):
                continue  # already merged into the previous token
            else:
                merged.append(t)
        tokens = [t for t in merged if NUM.match(t) or PCT.match(t)]
        # Expected: sell, sell_d, sell_ratio%, buy, buy_d, buy_ratio%, ...
        if len(tokens) < 6:
            continue
        try:
            sell = to_int(tokens[0])
            sell_d = to_int(tokens[1])
            buy = to_int(tokens[3])
            buy_d = to_int(tokens[4])
        except ValueError:
            continue
        if sell < 0 or buy < 0:
            continue
        sell_prev = sell - sell_d
        buy_prev = buy - buy_d
        balances[f"{code}.T"] = {
            "sell": sell, "sell_d": sell_d,
            "sell_pct": round(sell_d / sell_prev * 100, 2) if sell_prev > 0 else None,
            "buy": buy, "buy_d": buy_d,
            "buy_pct": round(buy_d / buy_prev * 100, 2) if buy_prev > 0 else None,
            "ratio": round(buy / sell, 2) if sell > 0 else None,
        }
    if len(balances) < 2000:
        raise RuntimeError(f"margin parse looks wrong: only {len(balances)} stocks")
    return balances


def collect():
    date, url = latest_pdf()
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        pdf = pathlib.Path(tmp) / "mtall.pdf"
        pdf.write_bytes(fetch(url, binary=True))
        result = subprocess.run(["pdftotext", "-layout", str(pdf), "-"],
                                check=True, timeout=300, capture_output=True)
        text = result.stdout.decode("utf-8", "replace")
    balances = parse_balances(text)
    payload = {
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "asof": f"{date[:4]}-{date[4:6]}-{date[6:]}",
        "source": "JPX daily outstanding margin trading by issue (mtall PDF)",
        "balances": balances,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"MARGIN_BALANCES_DONE stocks={len(balances)} asof={payload['asof']}",
          flush=True)
    return payload


def load_balances():
    try:
        data = json.loads(OUT.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def main():
    collect()


if __name__ == "__main__":
    main()
