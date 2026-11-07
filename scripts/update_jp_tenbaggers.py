"""Incrementally scan split-adjusted daily closing prices of current Japanese listed stocks.

Source universe is the monthly JPX current-listed domestic common-stock master; archived
price checks deliberately remain distinct from a full historical-survivorship cohort.
"""
from __future__ import annotations
import datetime as dt
import io
import json
import math
import os
import pathlib
import random
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from zoneinfo import ZoneInfo

ROOT=pathlib.Path(__file__).resolve().parents[1]
DEST=ROOT/'jp-tenbaggers.json'
JST=ZoneInfo('Asia/Tokyo')
MASTER='https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx'
BATCH=int(os.getenv('TENBAGGER_BATCH','145'))
PRIORITY='''6857 5803 6532 6146 6920 3350 6323 2471 7735 3778 4369 1407 2158 2929 3769 2726 3038 4062 7936 3825 5631 6264 6871 8136 5801 8002 8111 9104 7013 8015 9107 2586 3103 2930 3697 3962 4568 4588 5805 6050 6269 6736 6777 9519 3989 6590 6707 7014 7095 7187 8058 8360 9418 9766 1514 2323 2334 3936 4203 4816 6338 6629 6834 6941 6966 7685 7974 1518 2986 3179 3397 3563 4004 4506 4579 6619 7806 285A 278A 6055 7717 7832 6400 6627 7859 6544 6574 7189 8341 8368 9889 5535 4477 6098 6368 6613 6862 7012 7033 7692 6200 6632 6701 7610 2154 5253 9252 3498 3983 3923 4180 4894 4488 4485 6027 4935 6085 6072 6240 6235 7063 9517 4011 6580 9552 5032 7352 9246 4165 4051 4443 3856 3436 3288 2222 9435 1434 6367 4768 4684 7272 7564 9086 6579 3565 3793 2980 7085 4385 4480 4194 4880 5038 7128 5892 9236'''.split()
NS={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

def get(url,accept='application/json'):
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 (compatible; PersonalJapaneseStockStudy/1.0)','Accept':accept})
    with urllib.request.urlopen(req,timeout=32) as response:return response.read()

def column(ref):
    i=0
    for letter in re.match('[A-Z]+',ref).group():i=i*26+ord(letter)-64
    return i-1

def load_master(content):
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        strings=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            xml=ET.fromstring(z.read('xl/sharedStrings.xml'))
            for item in xml.findall('m:si',NS):
                strings.append(''.join(el.text or '' for el in item.iter('{%s}t'%NS['m'])))
        xml=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
        rows=[]
        for row in xml.findall('.//m:sheetData/m:row',NS):
            values={}
            for c in row.findall('m:c',NS):
                ref=c.attrib.get('r','')
                if not re.match('[A-Z]+',ref):continue
                val=c.find('m:v',NS)
                inline=c.find('m:is',NS)
                if val is not None:
                    x=val.text or ''
                    if c.attrib.get('t')=='s':x=strings[int(x)]
                elif inline is not None:
                    x=''.join(el.text or '' for el in inline.iter('{%s}t'%NS['m']))
                else:continue
                values[column(ref)]=str(x).strip()
            if values:rows.append(values)
    header=next((r for r in rows if 'コード' in r.values() and '銘柄名' in r.values()),None)
    if not header:raise ValueError('JPX header not found')
    col={name:i for i,name in header.items()}
    catalog={}
    for r in rows:
        code=r.get(col['コード'],'').upper()
        name=r.get(col['銘柄名'],'')
        market=r.get(col.get('市場・商品区分',-1),'')
        if not re.fullmatch(r'[0-9]{4}|[0-9]{3}[A-Z]|[0-9]{4}[A-Z]',code):continue
        if not name or '内国株式' not in market or not any(k in market for k in ('プライム','スタンダード','グロース')):continue
        catalog[code]={'name':name,'sector':r.get(col.get('33業種区分',-1),''),'market':market}
    if len(catalog)<3000:raise ValueError('Too few JPX domestic stocks '+str(len(catalog)))
    return catalog

def minus_years(d,amount):
    try:return d.replace(year=d.year-amount)
    except ValueError:return d.replace(year=d.year-amount,day=28)

def prices(code,cutoff,now):
    start=int(dt.datetime.combine(cutoff,dt.time.min,JST).timestamp())
    params=urllib.parse.urlencode({'period1':start,'period2':int(time.time())+86400,'interval':'1d','events':'history'})
    error=None
    for host in ('query1.finance.yahoo.com','query2.finance.yahoo.com'):
        for attempt in range(2):
            try:
                url='https://'+host+'/v8/finance/chart/'+urllib.parse.quote(code+'.T')+'?'+params
                chart=json.loads(get(url))['chart']['result'][0]
                result={}
                for stamp,price in zip(chart.get('timestamp') or [],chart['indicators']['quote'][0]['close']):
                    if price is None:continue
                    close=float(price)
                    if not math.isfinite(close) or close<=0:continue
                    d=dt.datetime.fromtimestamp(stamp,JST)
                    if d.date()==now.date() and now.time()<dt.time(15,45):continue
                    day=d.date().isoformat()
                    if day>=cutoff.isoformat():result[day]=round(close,5)
                if len(result)<18:raise ValueError('Too few daily closes: '+str(len(result)))
                return sorted(result.items())
            except Exception as exc:
                error=exc
                time.sleep(.35*(attempt+1))
    raise ValueError(str(error)[:150])

def calc(rows,cutoff):
    x=[(d,c) for d,c in rows if d>=cutoff]
    if len(x)<18:return None
    lowday,low=x[0]
    a,ap=x[0]
    b,bp=x[0]
    best=1.
    for day,close in x[1:]:
        z=close/low
        if z>best:best=z;a,ap=lowday,low;b,bp=day,close
        if close<low:lowday,low=day,close
    last,lastprice=x[-1]
    return {'multiple':round(best,3),'low_date':a,'low_close':ap,
            'peak_date':b,'peak_close':bp,'start_date':x[0][0],
            'start_close':x[0][1],'last_date':last,'last_close':lastprice,
            'from_start_multiple':round(lastprice/x[0][1],3),
            'from_peak_percent':round((lastprice/bp-1)*100,2),'sessions':len(x)}

def main():
    now=dt.datetime.now(JST)
    prev={}
    if DEST.exists():
        try:prev=json.loads(DEST.read_text(encoding='utf-8'))
        except (OSError,ValueError):pass
    results=prev.get('results') or {}
    try:
        catalog=load_master(get(MASTER,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
        print('JPX universe:',len(catalog),flush=True)
    except Exception as exc:
        catalog=prev.get('catalog') or {}
        if len(catalog)<3000:raise RuntimeError('No JPX master data available') from exc
        print('Using cached JPX master:',exc,flush=True)
    preferred=[code for code in dict.fromkeys(PRIORITY) if code in catalog]
    codes=preferred+[code for code in sorted(catalog) if code not in preferred]
    pending=[c for c in codes if c not in results]
    stale=[c for c in codes if c in results and (now.date()-dt.date.fromisoformat(results[c]['checked'])).days>=14]
    stale.sort(key=lambda c:(-((results[c].get('metrics') or {}).get('10') or {}).get('multiple',1),results[c]['checked']))
    selected=(pending+stale)[:BATCH]
    cutoffs={str(i):minus_years(now.date(),i).isoformat() for i in (3,5,10)}
    begin=minus_years(now.date(),10)
    errors={}
    success=0
    for i,code in enumerate(selected,1):
        try:
            daily=prices(code,begin,now)
            found={year:calc(daily,cutoff) for year,cutoff in cutoffs.items()}
            if not found['10']:raise ValueError('Insufficient 10y data')
            results[code]={'checked':now.date().isoformat(),'metrics':found}
            success+=1
            if i<10 or i%25==0:print(f'{i}/{len(selected)} {code} {catalog[code]["name"]} x{found["10"]["multiple"]}',flush=True)
        except Exception as exc:
            errors[code]=str(exc)[:120]
            if i<10 or i%25==0:print('WARN',code,str(exc)[:100],flush=True)
        time.sleep(.12+random.uniform(0,.12))
    if not results:raise RuntimeError('No valid price histories; preserving existing publication')
    output={'version':1,'generated_at':now.isoformat(timespec='seconds'),'since':begin.isoformat(),
            'source':'JPX listed domestic shares + Yahoo Finance unofficial chart split-adjusted daily CLOSE (no dividends)',
            'catalog_source':MASTER,'historical_source':'https://finance.yahoo.com',
            'method':'Best later daily close divided by an earlier daily close within rolling 3, 5 or 10 years, not executable trade returns.',
            'universe_count':len(catalog),
            'scanned_count':sum(1 for c in catalog if c in results),'results':results,
            'catalog':catalog,'attempted_this_run':len(selected),'succeeded_this_run':success,
            'errors_this_run':errors,
            'caveat':'Current listings only; delisted/merged firms may be excluded. Scanning incremental; Yahoo historical prices and split adjustments are unofficial.'}
    DEST.write_text(json.dumps(output,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    print('WROTE jp-tenbaggers.json: scanned',output['scanned_count'],'/',len(catalog),'new',success,'errors',len(errors),flush=True)

if __name__=='__main__':main()
