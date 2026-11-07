"""Archive twenty rolling years of US index closes for election-cycle seasonality."""
import datetime as dt
import json
import math
import pathlib
import time
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ROOT=pathlib.Path(__file__).resolve().parents[1]
DEST=ROOT/"us-anomalies.json"
ET=ZoneInfo("America/New_York")
SYMBOLS={"NDX":"^NDX","SPX":"^GSPC","SOX":"^SOX"}
HEADERS={"User-Agent":"Mozilla/5.0 (compatible; PersonalSeasonalityDashboard/1.0)","Accept":"application/json"}

def years_ago(date,n):
    try:return date.replace(year=date.year-n)
    except ValueError:return date.replace(year=date.year-n,day=28)

def fetch(symbol,start,now):
    params=urllib.parse.urlencode({"period1":int(dt.datetime.combine(start,dt.time(0),tzinfo=ET).timestamp()),"period2":int(time.time())+86400,"interval":"1d","events":"history"})
    last=None
    for host in ("query1.finance.yahoo.com","query2.finance.yahoo.com"):
        for attempt in range(2):
            try:
                url=f"https://{host}/v8/finance/chart/{urllib.parse.quote(symbol)}?{params}"
                req=urllib.request.Request(url,headers=HEADERS)
                with urllib.request.urlopen(req,timeout=40) as response:
                    source=json.load(response)["chart"]["result"][0]
                q=source["indicators"]["quote"][0]
                rows={}
                for ts,close in zip(source.get("timestamp") or [],q.get("close") or []):
                    try: close=float(close)
                    except (ValueError,TypeError):continue
                    if not math.isfinite(close) or close<=0:continue
                    session=dt.datetime.fromtimestamp(ts,ET).date()
                    if session==now.date() and now.time()<dt.time(16,20):continue
                    if session<start:continue
                    rows[session.isoformat()]=round(close,6)
                if len(rows)<4000:raise ValueError(f"only {len(rows)} sessions, expected about 20 years")
                print("FETCH",symbol,len(rows),flush=True)
                return rows
            except Exception as exc:
                last=exc
                time.sleep(attempt+1)
    raise RuntimeError(f"{symbol}: {last}")

def keep_existing(existing,start):
    out={}
    for day,close in (existing or {}).items():
        if not isinstance(day,str) or day<start.isoformat():continue
        try:
            close=float(close)
            if math.isfinite(close) and close>0:out[day]=close
        except (TypeError,ValueError):continue
    return out

def main():
    now=dt.datetime.now(ET)
    cutoff=years_ago(now.date(),20)
    start=cutoff-dt.timedelta(days=16)
    try: previous=json.loads(DEST.read_text(encoding="utf-8"))
    except (OSError,ValueError):previous={}
    series={};errors={}
    for name,symbol in SYMBOLS.items():
        old=keep_existing((previous.get("series") or {}).get(name),start)
        try:old.update(fetch(symbol,start,now))
        except Exception as exc:
            errors[name]=str(exc)
            print("WARN",name,exc,flush=True)
        series[name]=dict(sorted(old.items()))
    if any(len(rows)<4000 or min(rows)>(cutoff-dt.timedelta(days=7)).isoformat() for rows in series.values()):
        raise RuntimeError("Incomplete twenty-year index coverage. Existing archive unchanged.")
    output={
        "version":2,
        "updated_at":dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "window_start":cutoff.isoformat(),"baseline_start":start.isoformat(),
        "source":"Yahoo Finance Chart API (unofficial), daily unadjusted index closes",
        "symbols":SYMBOLS,
        "method":"Close to prior US session (daily); previous ISO week's final close to current week's final close (weekly). Excludes incomplete US sessions and partial weeks in chart analysis.",
        "series":series,"errors":errors
    }
    DEST.write_text(json.dumps(output,ensure_ascii=False,separators=(",",":")),encoding="utf-8")
    print("WROTE",DEST.name,{s:len(x) for s,x in series.items()},flush=True)

if __name__=="__main__":
    main()
