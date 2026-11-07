"""Yahoo Finance-hosted articles from Yahoo RSS only: one JP lead per US session.

Summaries are translations of the RSS title and optional short description,
NOT full-article summaries and NOT verified explanations for price action.
Only stock-related Yahoo Finance feeds are used as NEWS sources. MyMemory is
used only to translate the public RSS snippet to Japanese, with failure fallback.
"""
import datetime as dt
import email.utils
import html
import json
import math
import pathlib
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEST = ROOT / "soxx-news.json"
PRICE_DATA = ROOT / "us-semiconductors.json"
UTC = dt.timezone.utc
EASTERN = ZoneInfo("America/New_York")
RETENTION_DAYS = 60
SYMBOLS = ("SOXX", "INTC", "NVDA", "AVGO", "MU", "AMD", "TSM")
MAX_TRANSLATIONS_PER_RUN = 10
MAX_TRANSLATE_CHARS = 3300
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; PersonalSOXXNewsTracker/2.0)",
    "Accept": "application/rss+xml, application/xml, text/xml, application/json",
}

def clean(value, cap=500):
    text = re.sub(r"<[^>]*>", " ", html.unescape(value or ""))
    return re.sub(r"\s+", " ", text).strip()[:cap]

def timestamp(value):
    try:
        dt_value = email.utils.parsedate_to_datetime(value)
        if dt_value.tzinfo is None:
            dt_value = dt_value.replace(tzinfo=UTC)
        return dt_value.astimezone(UTC)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None

def valid_url(value):
    try:
        u = urllib.parse.urlsplit(value or "")
        return (value if u.scheme == "https" and u.hostname
                and not u.username and not u.password else None)
    except ValueError:
        return None

def yahoo_finance_url(value):
    """Do not show non-Yahoo syndicated links from a Yahoo Finance RSS feed."""
    url = valid_url(value)
    if not url:
        return None
    try:
        host = urllib.parse.urlsplit(url).hostname or ""
        return url if host == "finance.yahoo.com" or host.endswith(".finance.yahoo.com") else None
    except ValueError:
        return None

def fetch_feed(symbol, cutoff, now):
    url = "https://feeds.finance.yahoo.com/rss/2.0/headline?" + urllib.parse.urlencode({
        "s": symbol, "region": "US", "lang": "en-US",
    })
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=22) as response:
        root = ET.fromstring(response.read(1_500_000))
    result = []
    for item in root.findall(".//item"):
        title = clean(item.findtext("title"), 220)
        description = clean(item.findtext("description"), 430)
        link = yahoo_finance_url((item.findtext("link") or "").strip())
        published = timestamp(item.findtext("pubDate"))
        if not title or not link or not published:
            continue
        if not cutoff <= published <= now + dt.timedelta(minutes=10):
            continue
        result.append({
            "title": title,
            "description": description,
            "url": link,
            "source": "Yahoo Finance RSS",
            "feed_symbol": symbol,
            "published_at": published.isoformat(timespec="seconds"),
        })
    return result


SEARCH_QUERIES = (
    ("SOXX", "SOXX"),
    ("Nasdaq", "SOXX"),
    ("Intel", "INTC"),
    ("Nvidia", "NVDA"),
    ("Wall Street", "SOXX"),
    ("semiconductor stocks", "SOXX"),
    ("chip stocks", "SOXX"),
)

def fetch_yahoo_search(query, symbol, cutoff, now):
    """Optional Yahoo Finance search-news API, separate from ticker RSS.

    Yahoo may block or change this unauthenticated endpoint. Fail gracefully.
    Retain only finance.yahoo.com article links and published timestamps.
    """
    url = "https://query1.finance.yahoo.com/v1/finance/search?" + urllib.parse.urlencode({
        "q": query, "quotesCount": 0, "newsCount": 80,
        "listsCount": 0, "region": "US", "lang": "en-US",
    })
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=14) as response:
        payload = json.load(response)
    result = []
    for obj in payload.get("news", []):
        content = obj.get("content") or {}
        headline = clean(content.get("title") or obj.get("title"), 220)
        description = clean(content.get("summary") or obj.get("summary"), 430)
        href_obj = content.get("canonicalUrl") or content.get("clickThroughUrl") or {}
        href = (href_obj.get("url") if isinstance(href_obj, dict) else href_obj) or obj.get("link")
        link = yahoo_finance_url(href)
        t = content.get("pubDate") or content.get("displayTime") or obj.get("providerPublishTime")
        try:
            if isinstance(t, (int, float)):
                published = dt.datetime.fromtimestamp(t, UTC)
            elif isinstance(t, str) and t.isdigit():
                published = dt.datetime.fromtimestamp(int(t), UTC)
            elif isinstance(t, str):
                published = dt.datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(UTC)
            else:
                published = None
        except (ValueError, TypeError, OverflowError):
            published = None
        if not headline or not link or not published or not cutoff <= published <= now + dt.timedelta(minutes=10):
            continue
        publisher = obj.get("publisher") or ((content.get("provider") or {}).get("displayName") if isinstance(content.get("provider"), dict) else "")
        result.append({
            "title": headline, "description": description,
            "url": link, "source": "Yahoo Finance Search",
            "publisher": clean(publisher, 80),
            "feed_symbol": symbol, "published_at": published.isoformat(timespec="seconds"),
        })
    return result

# Prioritize concrete, contemporaneous catalysts, not search popularity or
# incidental mentions of the SOXX ticker. Yahoo does not expose article PVs.
MECHANICAL_NEWS = re.compile(
    r"ishares phlx sox.*(buys?|sells?|adds?|holdings)"
    r"|\b(etfs? are (?:net )?(?:buyers|sellers|buying|selling)"
    r"|etfs? bought|[0-9]+ etfs? add|etfs? add to|net etf buying"
    r"|net etf selling|etf activity|etf inflows? this week)\b"
)
OPINION_NEWS = re.compile(
    r"\b(stocks? to buy|should you buy|best stocks? (?:for|to)"
    r"|perfect time to buy|if you invest|retirement|long.term investor"
    r"|prediction|price target for \d{4}|history says|watchlist"
    r"|these \d+ stocks|hold up best|etf fees|dividend yield)\b"
)
SECTOR_NEWS = re.compile(
    r"\b(chip stocks?|semiconductor stocks?|semiconductor sector"
    r"|chipmakers?|chip sector|semiconductor shares|semiconductor etf"
    r"|soxx|sox index|phlx semiconductor|memory chips?|hbm"
    r"|semiconductor demand|chip demand|chip supply)\b"
)
CHIP_COMPANIES = re.compile(
    r"\b(nvidia|micron|amd|intel|broadcom|tsmc|asml|marvell"
    r"|qualcomm|texas instruments|applied materials|kla"
    r"|sandisk|sk hynix|samsung|lam research|synopsys|arm holdings)\b"
)
EVENT_DRIVERS = [
    ("決算・業績", re.compile(
        r"earnings|quarterly|guidance|weak outlook|outlook cut|forecast"
        r"|revenue miss|profit miss|beats? estimates|misses? estimates"
        r"|profit warning|sales growth|results fall|results beat|demand forecast")),
    ("設備投資・需要", re.compile(
        r"\b(capex|capital spending|capital expenditure|data.centers?"
        r"|ai spending|orders?|shortage|demand|supply|capacity|hbm"
        r"|chip demand|wafer|foundry|memory market)\b")),
    ("政策・規制", re.compile(
        r"export (?:ban|curbs?|restriction|control)"
        r"|trade (?:war|deal)|tariffs?|sanctions?|china (?:ban|restrict)"
        r"|antitrust|government restriction|chip (?:act|ban)")),
    ("企業イベント", re.compile(
        r"acquisition|merger|agrees? to buy|partnership|signs? a deal"
        r"|launches?|new chip|new gpu|major customer|licensing agreement")),
    ("格付け・目標株価", re.compile(
        r"analyst upgrade|analyst downgrade|\bupgrade\b|\bdowngrade\b"
        r"|raised? price target|cut price target|price target")),
]
SECTOR_MOVE = re.compile(
    r"chip (?:rout|selloff|rally|slump)|semiconductor (?:rout|selloff|rally|slump)"
    r"|chip stocks? (?:plunge|surge|sink|fall|jump)"
)
MOVEMENT = re.compile(
    r"\b(rises?|gains?|jumps?|surges?|slides?|falls?|drops?|plunges?"
    r"|tumbles?|sinks?|declines?)\s+\d+(?:\.\d+)?%"
)


# Retrospective articles are more useful for explaining an index move than
# random topical headlines. Closing recaps published at 16:00-22:00 ET are
# linked to the session they discuss, not the next market session.
RECAP_NEWS = re.compile(
    r"wall street (?:closes?|ends?|finishes?|tumbles?|rallies?|slides?|sinks?)"
    r"|(?:stocks?|markets?|chip stocks?|semiconductor stocks?|nasdaq)"
    r" (?:end|ends|ended|close|closes|closed|finish|finishes|finished)"
    r"|markets? (?:wrap|recap)|closing bell|markets? today"
    r"|stock market today|market sell.off|tech sell.off"
    r"|chip stocks? (?:end|ends|finished)"
)
RECAP_CONTEXT = re.compile(
    r"\b(semiconductor|chips?|chipmakers?|nvidia|intel|micron|amd"
    r"|broadcom|soxx|sox|ai|technology|tech)\b"
)


def is_market_recap(item):
    title = item.get("title", "").lower()
    return bool(RECAP_NEWS.search(title) and RECAP_CONTEXT.search(
        title + " " + item.get("description", "").lower()
    ))


def classify_catalyst(item):
    """Label the concrete event, if any, without asserting causation."""
    headline = item["title"].lower()
    for label, pattern in EVENT_DRIVERS:
        if pattern.search(headline):
            return label
    if SECTOR_MOVE.search(headline):
        return "半導体市場"
    return None


def priority(item):
    headline = item["title"].lower()
    if MECHANICAL_NEWS.search(headline):
        return -1000
    if OPINION_NEWS.search(headline):
        return -1000

    broad = bool(SECTOR_NEWS.search(headline) or SECTOR_MOVE.search(headline))
    constituent = bool(CHIP_COMPANIES.search(headline))
    category = classify_catalyst(item)
    recap = is_market_recap(item)
    report_context = item.get("description", "").lower()
    recap_chip_coverage = bool(SECTOR_NEWS.search(report_context)
                               or CHIP_COMPANIES.search(report_context))

    # A generic Wall Street summary must actually mention chip stocks or
    # a chipmaker; proximity to the Nasdaq is not enough.
    if not (broad or constituent or (recap and recap_chip_coverage)):
        return -1000
    if not (category or SECTOR_MOVE.search(headline) or recap):
        return -1000

    score = 65 if broad else 30
    if recap and (broad or recap_chip_coverage):
        score += 185   # More complete contemporary market explanation
    if recap and (recap_chip_coverage and constituent):
        score += 25
    if category == "決算・業績":
        score += 125
    elif category in ("政策・規制", "設備投資・需要"):
        score += 112
    elif category == "企業イベント":
        score += 85
    elif category == "格付け・目標株価":
        score += 40
    if SECTOR_MOVE.search(headline):
        score += 90
    if MOVEMENT.search(headline):
        score += 25
    # A large one-stock move is a weaker market-wide explanation than
    # a multi-name industry-wide event.
    affected = len({word for word in CHIP_COMPANIES.findall(headline)})
    if affected >= 2:
        score += min(30, affected * 10)
    if item.get("feed_symbol") == "SOXX" and category:
        score += 5
    return score


def session_for_time(published, dates, item=None):
    """Post-close market recaps describe THAT trading day; other after-close
    earnings/news may affect the next session and stay mapped forward."""
    et = dt.datetime.fromisoformat(published).astimezone(EASTERN)
    published_day = et.date().isoformat()
    if ((16, 0) <= (et.hour, et.minute) <= (22, 0)
            and published_day in dates and item and is_market_recap(item)):
        return published_day
    is_preclose = (et.hour, et.minute) < (16, 0)
    for day in dates:
        if day > published_day or (day == published_day and is_preclose):
            return day
    return None

def translation_text(item):
    title = clean(item["title"], 220)
    desc = clean(item.get("description", ""), 340)
    # The RSS often repeats the headline or includes publisher boilerplate.
    if desc and len(desc) > 45 and title.lower() not in desc.lower():
        return (title + ". " + desc)[:420]
    return title

def japanese_summary(item):
    """Translate ONLY a short RSS headline/description via documented MyMemory GET."""
    primary = translation_text(item)
    # Retry the short headline alone if a longer RSS excerpt fails to translate.
    candidates = [primary]
    if primary != item["title"]:
        candidates.append(item["title"])
    last_error = None
    for q in candidates:
        while len(q.encode("utf-8")) > 470:
            q = q[:-1]
        try:
            params = urllib.parse.urlencode({"q": q, "langpair": "en|ja"})
            req = urllib.request.Request("https://api.mymemory.translated.net/get?" + params,
                                         headers={"User-Agent": HEADERS["User-Agent"], "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=16) as response:
                data = json.load(response)
            if int(data.get("responseStatus") or 0) != 200:
                raise ValueError(str(data.get("responseDetails") or "translation failed")[:120])
            translated = clean(data.get("responseData", {}).get("translatedText", ""), 320)
            if not re.search(r"[ぁ-んァ-ン一-龯]", translated):
                raise ValueError("not translated to Japanese")
            return translated
        except Exception as exc:
            last_error = exc
    raise RuntimeError(str(last_error) if last_error else "translation unavailable")

def main():
    now = dt.datetime.now(UTC)
    cutoff = now - dt.timedelta(days=RETENTION_DAYS)
    try:
        old = json.loads(DEST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        old = {}
    try:
        prices = json.loads(PRICE_DATA.read_text(encoding="utf-8"))
        session_days = sorted(prices["soxx"])
    except (OSError, ValueError, KeyError):
        session_days = []

    # Avoid carrying across Google News stories from older mixed-source archives.
    articles = []
    for a in old.get("articles", []):
        try:
            if a.get("source") not in ("Yahoo Finance RSS", "Yahoo Finance Search") and a.get("category") != "SOXX関連記事":
                continue
            published = dt.datetime.fromisoformat(a["published_at"]).astimezone(UTC)
            if cutoff <= published <= now and yahoo_finance_url(a.get("url")) and a.get("title"):
                a = dict(a)
                a["source"] = a.get("source") if a.get("source") in ("Yahoo Finance RSS", "Yahoo Finance Search") else "Yahoo Finance RSS"
                a.setdefault("feed_symbol", "SOXX")
                a.setdefault("description", "")
                articles.append(a)
        except (TypeError, ValueError, KeyError):
            pass

    feed_counts, feed_errors = {}, {}
    for symbol in SYMBOLS:
        try:
            fresh = fetch_feed(symbol, cutoff, now)
            articles.extend(fresh)
            feed_counts[symbol] = len(fresh)
            print("YAHOO", symbol, len(fresh), flush=True)
        except Exception as exc:
            feed_errors[symbol] = str(exc)[:180]
            print("WARN YAHOO", symbol, repr(exc), flush=True)


    # Yahoo Finance search-news can surface stories that ticker RSS has
    # already rotated out. Its failure must not block the scheduled update.
    for query, symbol in SEARCH_QUERIES:
        label = "検索:" + query
        try:
            fresh = fetch_yahoo_search(query, symbol, cutoff, now)
            articles.extend(fresh)
            feed_counts[label] = len(fresh)
            print("YAHOO SEARCH", query, len(fresh), flush=True)
        except Exception as exc:
            feed_errors[label] = str(exc)[:180]
            print("WARN YAHOO SEARCH", query, repr(exc), flush=True)

    # Dedup syndicated headlines across overlapping Yahoo ticker feeds.
    articles.sort(key=lambda a:a["published_at"], reverse=True)
    distinct, seen = [], set()
    for article in articles:
        k = re.sub(r"[^a-z0-9]+", "", article["title"].lower())[:130]
        if k in seen or not k:
            continue
        seen.add(k)
        distinct.append(article)
    distinct = distinct[:650]

    # Keep the same article selection and translations across daily reruns.
    earlier = old.get("daily") or {}
    daily, selected = {}, {}
    for item in distinct:
        day = session_for_time(item["published_at"], session_days, item)
        if not day or day < cutoff.date().isoformat():
            continue
        score = priority(item)
        if score < 100:  # Select concrete catalysts, not coincidental stock mentions.
            continue
        previous = selected.get(day)
        if previous is None or (score, item["published_at"]) > (priority(previous), previous["published_at"]):
            selected[day] = item

    for day, item in sorted(selected.items(), reverse=True):
        print("SELECTED", day, priority(item), item["title"][:125], flush=True)
        record = {
            "title": item["title"],
            "url": item["url"],
            "published_at": item["published_at"],
            "source": item["source"],
            "feed_symbol": item["feed_symbol"],
            "material_type": "引け後の相場解説" if is_market_recap(item) else (classify_catalyst(item) or "半導体市場"),
            "review_type": "引け後総括" if is_market_recap(item) else "関連報道",
            "summary_basis": "Yahoo Finance headline and optional description",
        }
        prior = earlier.get(day) or {}
        if (prior.get("url") == record["url"] and prior.get("summary_ja")
                and re.search(r"[ぁ-んァ-ン一-龯]", prior["summary_ja"])):
            record["summary_ja"] = prior["summary_ja"]
        daily[day] = record

    # Translate at most a few changed / new selected leads each run.
    # Keep within the official anonymous MyMemory allowance (5k chars/day).
    remaining, budget, translate_errors = MAX_TRANSLATIONS_PER_RUN, MAX_TRANSLATE_CHARS, {}
    for day in sorted(daily, reverse=True):
        article = daily[day]
        if article.get("summary_ja"):
            continue
        source = selected[day]
        usage = len(translation_text(source))
        if remaining <= 0 or budget < usage:
            break
        try:
            article["summary_ja"] = japanese_summary(source)
            remaining -= 1
            budget -= usage
            print("TRANSLATED", day, source["feed_symbol"], flush=True)
        except Exception as exc:
            translate_errors[day] = str(exc)[:150]
            print("WARN JP translation", day, repr(exc), flush=True)
            # A rate-limited endpoint should not be hammered this run.
            if "quota" in str(exc).lower() or "limit" in str(exc).lower() or "429" in str(exc):
                break

    result = {
        "version": 2, "updated_at": now.isoformat(timespec="seconds"),
        "source": "Yahoo Finance ticker RSS and Yahoo Finance search news only",
        "translation_source": "MyMemory en→ja machine translation of RSS title / short description",
        "coverage_note": "One Yahoo Finance retrospective market review preferred per US SOXX trading session; otherwise a concrete chip-news headline. Postclose reviews refer to same session. No verified causation or article PVs; summary only from source headline/description.",
        "retention_days": RETENTION_DAYS,
        "feed_counts": feed_counts, "feed_errors": feed_errors,
        "translation_errors": translate_errors,
        "articles": distinct,
        "daily": daily,
    }
    DEST.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    print("WROTE", DEST.name, len(distinct), "Yahoo headlines;",
          len(daily), "US sessions;", sum(bool(x.get("summary_ja")) for x in daily.values()),
          "JP summaries", flush=True)

if __name__ == "__main__":
    main()
