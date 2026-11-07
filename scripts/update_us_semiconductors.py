"""Archive finalized US SOX, SOXX and semiconductor-related stock daily OHLCV."""
import datetime as dt
import json
import math
import pathlib
import time
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ROOT=pathlib.Path(__file__).resolve().parents[1]
DEST=ROOT/"us-semiconductors.json"
ET=ZoneInfo("America/New_York")
SYMBOLS={
 "MU":"Micron","SNDK":"Sandisk","SKHY":"SK hynix",
 "NBIS":"Nebius","LITE":"Lumentum","AEHR":"Aehr Test Systems",
 "AAOI":"Applied Optoelectronics","TSM":"TSMC","NVDA":"NVIDIA",
 "AMD":"AMD","AVGO":"Broadcom","COHR":"Coherent",
 "CRDO":"Credo Technology","MRVL":"Marvell","AMAT":"Applied Materials"
}
HEADERS={"User-Agent":"Mozilla/5.0 (compatible; PersonalSemiconductorDashboard/1.0)","Accept":"application/json"}
LOOKBACK=1130

def positive(x):
 try:
    n=float(x)
    return n if math.isfinite(n) and n>0 else None
 except (TypeError,ValueError):return None

def fetch(symbol,cutoff,now):
 params=urllib.parse.urlencode({"period1":int((now-dt.timedelta(days=LOOKBACK)).timestamp()),"period2":int(time.time())+86400,"interval":"1d","events":"history"})
 last=None
 for host in ("query1.finance.yahoo.com","query2.finance.yahoo.com"):
  for attempt in range(2):
   try:
    url=f"https://{host}/v8/finance/chart/{urllib.parse.quote(symbol)}?{params}"
    req=urllib.request.Request(url,headers=HEADERS)
    with urllib.request.urlopen(req,timeout=30) as r: data=json.load(r)["chart"]["result"][0]
    q=data["indicators"]["quote"][0]
    rows={}
    for ts,o,h,l,c,v in zip(data.get("timestamp") or [],q["open"],q["high"],q["low"],q["close"],q["volume"]):
     day=dt.datetime.fromtimestamp(ts,ET).date()
     if day<cutoff or (day==now.date() and now.time()<dt.time(16,20)):continue
     bar=[positive(x) for x in (o,h,l,c)]
     if any(x is None for x in bar):continue
     vol=None
     try:
      value=float(v)
      if math.isfinite(value) and value>=0:vol=int(value)
     except (TypeError,ValueError,OverflowError):pass
     rows[day.isoformat()]=bar+[vol]
    if len(rows)<5:raise ValueError(f"only {len(rows)} sessions")
    print("FETCH",symbol,len(rows),flush=True)
    return rows
   except Exception as exc:
    last=exc
    time.sleep(attempt+1)
 raise RuntimeError(f"{symbol}: {last}")

def retain(existing,cutoff):
 output={}
 if not isinstance(existing,dict):return output
 for date,row in existing.items():
  if date<cutoff.isoformat() or not isinstance(row,list) or len(row)!=5:continue
  if all(positive(v) for v in row[:4]):output[date]=row
 return output

def main():
 now=dt.datetime.now(ET)
 cutoff=now.date()-dt.timedelta(days=LOOKBACK)
 try:existing=json.loads(DEST.read_text(encoding="utf-8"))
 except (OSError,ValueError):existing={}
 result={};errors={};success=0
 for symbol in ("^SOX","SOXX",*SYMBOLS):
  key="sox" if symbol=="^SOX" else "soxx" if symbol=="SOXX" else symbol
  prev=existing.get(key) if symbol in ("^SOX","SOXX") else (existing.get("stocks") or {}).get(symbol)
  history=retain(prev,cutoff)
  try:
   history.update(fetch(symbol,cutoff,now));success+=1
  except Exception as exc:
   errors[symbol]=str(exc)
   print("WARN",symbol,exc,flush=True)
  result[key]=dict(sorted(history.items()))
 stocks={symbol:result[symbol] for symbol in SYMBOLS}
 if not result["sox"] or not any(stocks.values()):raise RuntimeError("No US market data; keeping existing file")
 output={
  "version":1,"updated_at":dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
  "symbols":SYMBOLS,"source":"Yahoo Finance Chart API (unofficial), finalized daily OHLCV",
  "note":"US day D: same-day SOX close and stock close; SOXX trading volume replaces missing SOX index volume. Newly listed symbols have shorter histories.",
  "sox":result["sox"],"soxx":result["soxx"],"stocks":stocks,"errors":errors
 }
 DEST.write_text(json.dumps(output,ensure_ascii=False,separators=(",",":")),encoding="utf-8")
 print("WROTE",DEST.name,"success",success,"errors",errors,flush=True)

if __name__=="__main__":
 main()
