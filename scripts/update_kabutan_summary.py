"""Archive Kabutan pre-close and close articles; summarize AI/semiconductor context.

Licensed/personal-use project. Source records retain article URLs, not full articles.
Summaries are deliberately conservative, deterministic extracts of reported drivers.
"""
import datetime as dt
import html
import json
import os
import pathlib
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEST = ROOT / "semi-summary.json"
JST = ZoneInfo("Asia/Tokyo")
USER_AGENT = "Mozilla/5.0 (compatible; PersonalKabutanSummary/1.0)"
PHASES = {"am": "東京株式（前引け）", "pm": "東京株式（大引け）"}
NEWS_LINK = re.compile(r"/news/n(\d{12})/?(?:[?#].*)?$")
TOPIC = re.compile(r"ＡＩ|AI|半導体|製造装置|ＳＯＸ|SOX", re.I)
CATALYST = re.compile(r"決算|業績|上方修正|下方修正|ガイダンス|受注|増益|減益")
DIRECTION = re.compile(r"下落|急落|売ら|売り|安い|安とな|上昇|高騰|買われ|買い戻|大幅高|大幅安")
COMPANIES = ("キオクシア", "東京エレクトロン", "アドバンテスト", "レーザーテック",
             "ディスコ", "ＳＣＲＥＥＮ", "SCREEN", "太陽誘電", "フジクラ",
             "ソフトバンクグループ", "イビデン", "ルネサス")


def fetch_text(url, timeout=13):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read(2_000_000)
        encoding = res.headers.get_content_charset() or "utf-8"
    return raw.decode(encoding, "replace")


class PageParser(HTMLParser):
    """Extract text blocks and news anchors without extra dependencies."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.anchors, self.open_anchor = [], [], None
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "svg", "noscript"):
            self.skip += 1
        if self.skip:
            return
        if tag in ("p", "h1", "h2", "h3", "br", "div", "article", "li", "time"):
            self.parts.append("\n")
        if tag == "a":
            self.open_anchor = [dict(attrs).get("href", ""), []]

    def handle_endtag(self, tag):
        if tag in ("script", "style", "svg", "noscript"):
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag == "a" and self.open_anchor is not None:
            self.anchors.append((self.open_anchor[0], "".join(self.open_anchor[1]).strip()))
            self.open_anchor = None
        if tag in ("p", "h1", "h2", "h3", "div", "li", "article"):
            self.parts.append("\n")

    def handle_data(self, data):
        if self.skip:
            return
        if self.open_anchor is not None:
            self.open_anchor[1].append(data)
        self.parts.append(data)


def parse_page(raw):
    p = PageParser()
    p.feed(raw)
    return p


def discover(date):
    """Match both the article date embedded in the URL and the full headline.
    Any pagination/date-filter failure leaves the date missing; never substitute
    a different day's article.
    """
    day = date.replace("-", "")
    urls = (
        f"https://s.kabutan.jp/market_news/?date={date}",
        f"https://s.kabutan.jp/market_news/?date={day}",
        f"https://kabutan.jp/news/marketnews/?date={day}",
    )
    result = {}
    for base in urls:
        for page in range(1, 3):
            separator = "&" if "?" in base else "?"
            url = base + ("" if page == 1 else f"{separator}page={page}")
            try:
                parsed = parse_page(fetch_text(url))
            except Exception as exc:
                print("LIST ERROR", url, str(exc)[:120], flush=True)
                break
            found_links = 0
            for href, label in parsed.anchors:
                absolute = urllib.parse.urljoin(url, href)
                host = urllib.parse.urlsplit(absolute).hostname
                if host not in ("s.kabutan.jp", "kabutan.jp"):
                    continue
                match = NEWS_LINK.search(urllib.parse.urlsplit(absolute).path)
                if not match or match.group(1)[:8] != day:
                    continue
                found_links += 1
                for phase, prefix in PHASES.items():
                    if prefix in label:
                        result.setdefault(phase, f"https://s.kabutan.jp/news/n{match.group(1)}/")
            if len(result) == 2:
                return result
            if page > 1 and found_links == 0:
                break
    return result


def read_article(url, expected_date, phase):
    parsed = parse_page(fetch_text(url))
    lines = [re.sub(r"\s+", " ", x).strip() for x in "\n".join(parsed.parts).splitlines()]
    lines = [x for x in lines if x]
    start = next((i for i, x in enumerate(lines) if x.startswith(PHASES[phase])), None)
    if start is None:
        raise ValueError("headline or session not matched")
    date_header = f"{int(expected_date[:4])}年{int(expected_date[5:7])}月{int(expected_date[8:10])}日"
    date_pos = next((i for i in range(start + 1, min(start + 14, len(lines))) if date_header in lines[i]), None)
    if date_pos is None:
        raise ValueError("article publication date not matched")
    end = next((i for i in range(date_pos + 1, len(lines)) if lines[i].startswith("出所：") or lines[i] == "関連記事"), None)
    if end is None:
        raise ValueError("article body has no source terminator")
    main = lines[date_pos + 1:end]
    body = " ".join(main)
    if not (60 <= len(body) <= 15000):
        raise ValueError("article text failed size validation")
    return body


def summarize(body, phase):
    """Only report factors explicitly supported by narrative, not stock lists."""
    main = body.split("個別では")[0].split("半面、")[0]
    if not TOPIC.search(main):
        return "記事本文にAI・半導体関連の具体的な材料の記載なし。"
    sentences = re.split(r"(?<=[。！？])", main)
    findings = []
    sector_sentences = [s for s in sentences if TOPIC.search(s)]
    us_down = any(("米国" in s or "米株" in s or "前週末" in s)
                  and re.search(r"半導体|ＳＯＸ|SOX", s)
                  and re.search(r"下落|売り|急落|軟調|波乱含みの下げ", s)
                  for s in sector_sentences)
    us_up = any(("米国" in s or "米株" in s) and re.search(r"半導体|ＳＯＸ|SOX", s)
                and re.search(r"反発|上昇|買い|切り返", s)
                for s in sector_sentences)
    if us_down:
        findings.append("米半導体株安を受け、国内AI・半導体関連にも売りが波及。")
    elif us_up:
        findings.append("米半導体株高を背景に、国内AI・半導体関連にも買いが入った。")
    elif any(re.search(r"半導体", s) and re.search(r"売り|下落|軟調|弱含み", s) for s in sector_sentences):
        findings.append("AI・半導体関連は売り優勢。")
    elif any(re.search(r"半導体", s) and re.search(r"買い|上昇|反発|堅調", s) for s in sector_sentences):
        findings.append("AI・半導体関連は買い優勢。")

    for sentence in sentences:
        if not (CATALYST.search(sentence) and DIRECTION.search(sentence)):
            continue
        for company in COMPANIES:
            if company not in sentence:
                continue
            # A named stock requires BOTH a named catalyst and a price move
            # explicitly linked within the same narrative sentence.
            if "決算発表を受けて" in sentence and re.search(r"下落|急落|安", sentence):
                findings.append(company + "は決算発表を受けて下落。")
            elif re.search(r"好決算|業績上方修正|上方修正", sentence) and re.search(r"買い|上昇|高", sentence):
                findings.append(company + "は好業績を材料に買われた。")
            break

    if re.search(r"半導体製造装置|半導体関連の一角|半導体製造装置関連", main) and re.search(r"好決算|決算", main) and re.search(r"買われ|買い戻|買いが|買われた", main):
        findings.append("好決算の半導体製造装置関連には買いが入った。")
    if re.search(r"先物.*(買い|上昇)|インデックス買い", main) and re.search(r"下げ渋|切り返|プラス圏", main):
        findings.append("先物の買いを支えに下げ渋った。")
    if phase == "pm" and re.search(r"大引け|引け|着地", main) and re.search(r"下落|続落|マイナス|安くなった", main):
        findings.append("大引けは上値の重い展開となった。")
    if not findings:
        return "AI・半導体関連の具体的な方向感は記事から判定できず。"
    output = ""
    for sentence in dict.fromkeys(findings):
        if len(output) + len(sentence) > 120:
            break
        output += sentence
    return output[:120] or "記事に基づく要約を作成できず。"



def split_facts_and_interpretation(summary):
    """Split a sourced summary: observed movement vs reported explanation.

    This is a conservative text classification, not independent fact-checking.
    Do not create price events not already present in the archived summary.
    """
    sentences = re.findall(r"[^。！？]+[。！？]?", summary or "")
    causal = re.compile(r"を受け|を背景に|追い風|重荷|嫌気|好感|懸念|警戒|期待|材料|支え|波及|みられ|観測|心理|ため|影響")
    move = re.compile(r"上昇|下落|急落|反発|続伸|続落|買い|売り|上げ|下げ|切り返|持ち直|伸び悩|引け|失速|軟調|堅調|縮小|拡大")
    facts, interpretations = [], []
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if causal.search(sentence):
            interpretations.append(sentence)
            for candidate in sentence.split("、")[1:]:
                if move.search(candidate) and not re.search(r"追い風|重荷|影響|警戒|懸念|期待|背景", candidate):
                    facts.append(candidate.rstrip("。！？") + "。")
                    break
        else:
            facts.append(sentence)
    facts = list(dict.fromkeys(facts))
    interpretations = list(dict.fromkeys(interpretations))
    fact = "".join(facts)[:65]
    interpretation = "".join(interpretations)[:120-len(fact)]
    return fact, interpretation

def main():
    now = dt.datetime.now(JST)
    # Public edition: bootstrap an empty archive on the first run.
    if DEST.exists():
        data = json.loads(DEST.read_text(encoding="utf-8"))
    else:
        data = {"days": []}
    rows = {x["date"]: x for x in data.get("days", []) if isinstance(x, dict) and x.get("date")}
    if os.getenv("KABUTAN_BACKFILL") == "1":
        # Exactly the 25 completed JP sessions already archived in the dashboard.
        recent = sorted(rows, reverse=True)[:25]
    else:
        # Automatic daily refresh: today's unfinished and the past few sessions.
        recent = [now.date().isoformat()] + [day for day in rows if
                  0 < (now.date() - dt.date.fromisoformat(day)).days <= 5]
    changed = 0
    for day in sorted(recent, reverse=True):
        if day > now.date().isoformat():
            continue
        row = rows.get(day, {"date": day})
        # Preserve previously verified summaries, while also storing
        # separately classified factual movements and article interpretations.
        for phase in PHASES:
            existing = row.get(phase + "_summary")
            if existing and (phase + "_fact" not in row or phase + "_interpretation" not in row):
                row[phase + "_fact"], row[phase + "_interpretation"] = split_facts_and_interpretation(existing)
                changed += 1
        missing = [p for p in PHASES if not row.get(p + "_summary")]
        if not missing:
            rows[day] = row
            continue
        links = {p: row.get(p + "_article_url") for p in missing if row.get(p + "_article_url")}
        if len(links) < len(missing):
            discovered = discover(day)
            links.update({p: discovered[p] for p in missing if p in discovered})
        for phase in missing:
            url = links.get(phase)
            if not url:
                continue
            try:
                body = read_article(url, day, phase)
                summary = summarize(body, phase)
                row[phase + "_summary"] = summary
                row[phase + "_fact"], row[phase + "_interpretation"] = split_facts_and_interpretation(summary)
                row[phase + "_article_url"] = url
                print(day, phase, summary, flush=True)
                changed += 1
            except Exception as exc:
                print("ARTICLE ERROR", day, phase, str(exc)[:170], flush=True)
        if row.get("am_summary") or row.get("pm_summary"):
            rows[day] = row

    if changed:
        data["days"] = sorted(rows.values(), key=lambda x: x["date"], reverse=True)
        data["updated_at"] = now.isoformat(timespec="seconds")
        data["note"] = "株探「東京株式（前引け）」「東京株式（大引け）」からAI・半導体関連の要約を生成。観測された値動きと記事に基づく要因説明を事実・解釈に区別。前場・後場とも合計120字以内。"
        DEST.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Kabutan summary:", changed, "new summaries; existing records retained.", flush=True)


if __name__ == "__main__":
    main()
