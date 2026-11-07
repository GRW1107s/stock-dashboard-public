/* 5-minute OHLCV-only dip-entry, profit-taking and strict walk-forward evaluation.
 * Signal = completed candle closing x% below its trailing 30-minute high.
 * Fill = NEXT 5m candle open. Barriers are conservative if same 5m candle hits both.
 */
(function(root){
  'use strict';
  const BAR=5,LOOKBACK=6,HOLD=5,STOP_PCT=.8,MAX_ENTRIES=3;
  const minute=t=>+t.slice(11,13)*60+(+t.slice(14,16));
  const period=t=>{const m=minute(t);return m>=540&&m<690?'am':m>=750&&m<925?'pm':null};
  const continuous=(a,b)=>!!a&&!!b&&a.t.slice(0,10)===b.t.slice(0,10)&&minute(b.t)-minute(a.t)===BAR;
  function normalize(rows){
    const map=new Map();
    for(const r of rows||[]){
      if(!Array.isArray(r)||r.length!==6||typeof r[0]!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(r[0])||!period(r[0]))continue;
      const [o,h,l,c,v]=r.slice(1).map(Number);
      if(![o,h,l,c,v].every(Number.isFinite)||o<=0||l<=0||h<Math.max(o,c)||l>Math.min(o,c)||v<0||minute(r[0])%5!==0)continue;
      map.set(r[0],{t:r[0],o,h,l,c,v});
    }
    return [...map.values()].sort((a,b)=>a.t.localeCompare(b.t));
  }
  function group(rows){
    const map=new Map();
    for(const r of normalize(rows)){
      const date=r.t.slice(0,10);
      if(!map.has(date))map.set(date,{date,am:[],pm:[]});
      map.get(date)[period(r.t)].push(r);
    }
    return [...map.values()].sort((a,b)=>a.date.localeCompare(b.date));
  }
  // A session is usable with minor missing 5-minute bars. Signals will not
  // bridge a missing interval. Require broad morning and afternoon coverage,
  // but do not insist on an isolated exact-timestamp print.
  function completed(day){
    return day.am.length>=26&&day.pm.length>=29&&
      day.am[0].t.slice(11,16)<='09:10'&&
      day.am.at(-1).t.slice(11,16)>='11:15'&&
      day.pm[0].t.slice(11,16)<='12:40'&&
      day.pm.at(-1).t.slice(11,16)>='15:10';
  }
  function dropSignal(s,i,x){
    if(i<LOOKBACK)return false;
    for(let j=i-LOOKBACK+1;j<=i;j++)if(!continuous(s[j-1],s[j]))return false;
    const high=Math.max(...s.slice(i-LOOKBACK+1,i+1).map(r=>r.h));
    const priorHigh=Math.max(...s.slice(i-LOOKBACK,i).map(r=>r.h));
    return (1-s[i-1].c/priorHigh)*100<x&&(1-s[i].c/high)*100>=x;
  }
  function replay(days,params,costPct=.10,withTrades=false){
    if(!params||!(params.x>0&&params.x<=5)||!(params.y>0&&params.y<=5)||
      !Number.isFinite(params.x)||!Number.isFinite(params.y)||!Number.isFinite(costPct)||costPct<0||costPct>2)
      throw Error('Invalid x, y, or trading cost');
    const trades=[];let total=0,peak=0,dd=0,wins=0;
    for(const day of days){
      let entries=0;
      for(const s of [day.am,day.pm]){
        let pos=null,cooldown=-1;
        const close=(index,price,reason)=>{
          const net=100*(price/pos.price-1)-costPct;
          total+=net;peak=Math.max(peak,total);dd=Math.min(dd,total-peak);
          if(net>0)wins++;
          trades.push({date:day.date,entry:pos.t,exit:s[index].t,buy:pos.price,sell:price,net,reason});
          pos=null;cooldown=index+1;
        };
        for(let i=0;i<s.length;i++){
          const b=s[i];
          if(pos){
            if(i>pos.index&&!continuous(s[i-1],b)){close(i,b.o,'欠損後手仕舞い');continue;}
            if(i-pos.index>=HOLD||i===s.length-1){close(i,b.o,'保有期限・引け');continue;}
            const stop=pos.price*(1-STOP_PCT/100),target=pos.price*(1+params.y/100);
            if(b.o<=stop||b.l<=stop){close(i,Math.min(b.o,stop),'損切り');continue;}
            if(b.o>=target||b.h>=target){close(i,target,'利確');continue;}
            continue;
          }
          if(entries>=MAX_ENTRIES||i<LOOKBACK||i>=s.length-2||i<=cooldown||!continuous(b,s[i+1]))continue;
          if(dropSignal(s,i,params.x)){
            pos={t:s[i+1].t,price:s[i+1].o,index:i+1};
            entries++;
          }
        }
      }
    }
    const result={score:trades.length?total-.5*Math.abs(dd):-0.9,total,drawdown:dd,
      trades:trades.length,wins,winRate:trades.length?100*wins/trades.length:null,
      average:trades.length?total/trades.length:null};
    if(withTrades)result.log=trades;
    return result;
  }
  const api={BAR,LOOKBACK,HOLD,STOP_PCT,MAX_ENTRIES,normalize,group,completed,dropSignal,replay};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.__FIVE_MIN_ENGINE__=api;
})(typeof globalThis!=='undefined'?globalThis:this);
