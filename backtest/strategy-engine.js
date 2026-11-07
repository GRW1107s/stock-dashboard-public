/* 6976 multiple-strategy historical simulation. All signals use closed candles.
 * Execution: NEXT candle open, stop loss first if both barriers touch in one bar.
 * No price interpolation and no borrowing from higher-resolution future bars.
 */
(function(root){
'use strict';
const STRATEGIES=[
 {id:'ma25-revert',name:'25MA下で買い・上で売り',detail:'終値が25MA未満なら買い、25MA超で売る'},
 {id:'ma5-revert',name:'5MA下で買い・上で売り',detail:'短期平均への回帰'},
 {id:'ma25-trend',name:'25MA上抜け買い・下抜け売り',detail:'25MAのクロスを追う'},
 {id:'ma-cross',name:'5MA/25MAゴールデンクロス',detail:'5MAが25MAを上抜け買い、下抜け売り'},
 {id:'rsi-revert',name:'RSI14逆張り',detail:'RSI30未満で買い、55超で売り'},
 {id:'bb-revert',name:'ボリンジャー逆張り',detail:'20本−2σを下抜け買い、中心線で売り'},
 {id:'dip-profit',name:'直近高値−1%買い・+1%利確',detail:'直近7本の高値から1%下落、買値+1%で売却'},
 {id:'pullback25',name:'上昇25MAへの押し目買い',detail:'25MA上昇中、終値が5MA下かつ25MA上で買い、5MA上で売る'},
 {id:'breakout20',name:'20本高値ブレイク',detail:'直近20本の高値を終値で突破して買い、5MA下で売る'},
 {id:'momentum3',name:'3本連続上昇モメンタム',detail:'終値3本連続上昇かつ25MA上で買い、5MA下で売る'},
 {id:'rsi-trend',name:'RSI14順張り',detail:'RSI55超・25MA上で買い、RSI45未満で売る'},
 {id:'volume-surge',name:'出来高急増・陽線',detail:'出来高が直前20本平均の1.8倍以上かつ陽線で買い、5MA下で売る'}
];
const OPTIONS={
 '1m':{step:1,kind:'intraday',stopPct:.8,hold:35},'5m':{step:5,kind:'intraday',stopPct:.8,hold:18},
 '15m':{step:15,kind:'intraday',stopPct:1.1,hold:10},'1h':{step:60,kind:'swing',stopPct:2,hold:18},
 '1d':{step:1440,kind:'swing',stopPct:5,hold:15}
};
const barMinute=t=>Number(t.slice(11,13))*60+Number(t.slice(14,16));
const day=t=>t.slice(0,10);
const venue=t=>{const m=barMinute(t);return (m>=540&&m<690)?'am':(m>=750&&m<930)?'pm':null};
const finite=Number.isFinite;
function normalize(raw,interval){
 if(!OPTIONS[interval])throw Error('Unsupported interval');
 const dedup=new Map();
 for(const a of raw||[]){
  if(!Array.isArray(a)||a.length<6||typeof a[0]!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(a[0]))continue;
  const [o,h,l,c,v]=a.slice(1,6).map(Number);
  if(![o,h,l,c,v].every(finite)||o<=0||l<=0||h<Math.max(o,c)||l>Math.min(o,c)||v<0)continue;
  if(interval!=='1d'&&!venue(a[0]))continue;
  dedup.set(a[0],{t:a[0],o,h,l,c,v});
 }
 return [...dedup.values()].sort((a,b)=>a.t.localeCompare(b.t));
}
function sma(a,i,n){if(i<n-1)return null;let sum=0;for(let j=i-n+1;j<=i;j++)sum+=a[j].c;return sum/n;}
function rsi(a,i,n=14){
 if(i<n)return null;let plus=0,minus=0;
 for(let j=i-n+1;j<=i;j++){const d=a[j].c-a[j-1].c;if(d>0)plus+=d;else minus-=d;}
 return minus===0?(plus===0?50:100):100-100/(1+plus/minus);
}
function bb(a,i,n=20){
 const mean=sma(a,i,n);if(mean===null)return null;
 let sum=0;for(let j=i-n+1;j<=i;j++)sum+=(a[j].c-mean)**2;
 return {mean,lower:mean-2*Math.sqrt(sum/n)};
}
function indicator(a,i,id){
 if(i<25)return {buy:false,sell:false};
 const c=a[i].c,p=a[i-1].c,m25=sma(a,i,25),m5=sma(a,i,5);
 switch(id){
 case 'ma25-revert':return {buy:c<m25,sell:c>m25};
 case 'ma5-revert':return {buy:c<m5,sell:c>m5};
 case 'ma25-trend':{
  const last=sma(a,i-1,25);return {buy:p<=last&&c>m25,sell:p>=last&&c<m25};
 }
 case 'ma-cross':{
  const prev5=sma(a,i-1,5),prev25=sma(a,i-1,25);
  return {buy:prev5<=prev25&&m5>m25,sell:prev5>=prev25&&m5<m25};
 }
 case 'rsi-revert':{
  const r=rsi(a,i,14);return {buy:r!==null&&r<30,sell:r!==null&&r>55};
 }
 case 'bb-revert':{
  const b=bb(a,i,20),prior=bb(a,i-1,20);
  return {buy:!!b&&!!prior&&p>=prior.lower&&c<b.lower,sell:!!b&&c>=b.mean};
 }
 case 'dip-profit':{
  const high=Math.max(...a.slice(i-6,i+1).map(b=>b.h));
  const prevHigh=Math.max(...a.slice(i-7,i).map(b=>b.h));
  return {buy:(1-p/prevHigh)<.01&&(1-c/high)>=.01,sell:false};
 }
 case 'pullback25':{
  const prev25=sma(a,i-1,25);
  return {buy:m25>prev25&&c<m5&&c>m25,sell:c>m5};
 }
 case 'breakout20':{
  const high=Math.max(...a.slice(i-20,i).map(x=>x.h));
  return {buy:c>high&&p<=Math.max(...a.slice(i-21,i-1).map(x=>x.h)),sell:c<m5};
 }
 case 'momentum3':{
  const rising=c>a[i-1].c&&a[i-1].c>a[i-2].c&&a[i-2].c>a[i-3].c;
  return {buy:rising&&c>m25,sell:c<m5};
 }
 case 'rsi-trend':{
  const r=rsi(a,i,14);
  return {buy:r!==null&&r>55&&c>m25,sell:r!==null&&r<45};
 }
 case 'volume-surge':{
  const mean=a.slice(i-20,i).reduce((sum,x)=>sum+x.v,0)/20;
  return {buy:mean>0&&a[i].v>=1.8*mean&&c>a[i].o,sell:c<m5};
 }
 default:throw Error('Unknown strategy');
 }
}
function adjacent(a,b,interval){
 if(!a||!b)return false;
 if(interval==='1d')return day(b.t)>day(a.t);
 if(interval==='1h')return day(b.t)>day(a.t)||barMinute(b.t)>barMinute(a.t);
 return day(a.t)===day(b.t)&&venue(a.t)===venue(b.t)&&barMinute(b.t)-barMinute(a.t)===OPTIONS[interval].step;
}
function endOfSession(a,i,interval){
 if(OPTIONS[interval].kind!=='intraday')return false;
 return i===a.length-1||day(a[i].t)!==day(a[i+1].t)||venue(a[i].t)!==venue(a[i+1].t);
}
function combineSignals(signals){
 return signals.length>0&&signals.every(Boolean);
}
function simulateRule(bars,rule,interval,costPct=.10,from=0,settings={}){
 const buyIds=rule.buyIds||[],sellIds=rule.sellIds||[];
 if(!OPTIONS[interval]||!buyIds.length||!sellIds.length||
    [...buyIds,...sellIds].some(id=>!STRATEGIES.some(x=>x.id===id)))throw Error('Invalid strategy combination');
 if(!finite(costPct)||costPct<0||costPct>2)throw Error('Invalid cost');
 const opts=OPTIONS[interval],allowShort=settings.allowShort===true;
 // Previous standalone swing strategies retain overnight holding by default.
 const holdOvernight=typeof settings.holdOvernight==='boolean'?settings.holdOvernight:opts.kind==='swing';
 // Overnight mode allows one full additional market session before time expiry.
 const extendedHolds={'1m':360,'5m':72,'15m':24,'1h':18,'1d':15};
 const maxHoldBars=holdOvernight?Math.max(opts.hold,extendedHolds[interval]):opts.hold;
 const trades=[];
 let position=null,pending=null,entries=0,lastDay=null,balance=0,peak=0,maxDD=0,win=0;
 const record=(j,price,reason)=>{
  if(!position)return;
  const isShort=position.side==='short';
  const net=(isShort?1-price/position.price:price/position.price-1)*100-costPct;
  const over=day(position.t)!==day(bars[j].t);
  trades.push({date:day(position.t),entry:position.t,exit:bars[j].t,
   side:position.side,entryPrice:position.price,exitPrice:price,
   // Retain prior field names for older consumers (both mean open/close fill).
   buy:position.price,sell:price,net,reason,overnight:over});
  balance+=net;peak=Math.max(balance,peak);maxDD=Math.min(maxDD,balance-peak);if(net>0)win++;
  position=null;
 };
 for(let i=Math.max(from,25);i<bars.length;i++){
  const bar=bars[i],d=day(bar.t);
  if(d!==lastDay){entries=0;lastDay=d;}
  // An order based on the previous completed bar fills at THIS bar's open.
  if(pending){
   if(pending.action==='exit'&&position)record(i,bar.o,'条件成立・次足始値');
   else if(!position&&entries<3&&['long','short'].includes(pending.action)){
    position={side:pending.action,price:bar.o,t:bar.t,index:i};entries++;
   }
   pending=null;
  }
  if(position){
   const short=position.side==='short';
   const stop=position.price*(1+(short?1:-1)*opts.stopPct/100);
   // Gap-through fills at the observed open, not the stop threshold.
   // Stop wins over a possible intrabar target when candle ordering is unknown.
   if(short&&(bar.o>=stop||bar.h>=stop))record(i,Math.max(stop,bar.o),'空売り損切り');
   else if(!short&&(bar.o<=stop||bar.l<=stop))record(i,Math.min(stop,bar.o),'買い損切り');
   else if(!short&&sellIds.length===1&&sellIds[0]==='dip-profit'&&
      (bar.o>=position.price*1.01||bar.h>=position.price*1.01)){
    record(i,Math.max(bar.o,position.price*1.01),'+1%利確');
   }else if(i-position.index>=maxHoldBars)record(i,bar.c,'保有上限・足終値');
  }
  const next=bars[i+1];
  const sessionEnd=!next||day(bar.t)!==day(next.t)||
   (opts.kind==='intraday'&&venue(bar.t)!==venue(next.t));
  // For overnight-off mode, flatten at the last observable candle close.
  if(!holdOvernight&&sessionEnd){
   if(position)record(i,bar.c,'場末・当日決済');
   pending=null;
   // A daily bar already represents the entire session; a signal after its
   // close may schedule a new entry for the following trading-day open.
   if(interval!=='1d')continue;
  }
  if(!next)continue;
  // Never place orders across missing bars inside a continuous session.
  // When overnight is permitted, a genuine lunch/overnight opening is valid.
  const crossSession=day(bar.t)!==day(next.t)||
    (opts.kind==='intraday'&&venue(bar.t)!==venue(next.t));
  if(!adjacent(bar,next,interval)&&!(holdOvernight&&crossSession))continue;
  const checkBuy=()=>combineSignals(buyIds.map(id=>indicator(bars,i,id).buy));
  const checkSell=()=>combineSignals(sellIds.map(id=>id==='dip-profit'?
   !!position&&bar.c>=position.price*1.01:indicator(bars,i,id).sell));
  if(position){
   // For a short position, the checked BUY conditions are the cover signal.
   if(position.side==='long'?checkSell():checkBuy())pending={action:'exit'};
  }else if(entries<3){
   const buying=checkBuy();
   // "dip-profit" has no independent sell-entry predicate: its +1% target
   // is only defined after a long entry and must not synthesize short orders.
   const selling=allowShort&&
    combineSignals(sellIds.map(id=>id!=='dip-profit'&&indicator(bars,i,id).sell));
   // If contradictory long and short entry signals coexist, do not guess.
   if(buying&&!selling)pending={action:'long'};
   else if(selling&&!buying)pending={action:'short'};
  }
 }
 if(position&&bars.length)record(bars.length-1,bars.at(-1).c,'データ末尾');
 const longCount=trades.filter(t=>t.side==='long').length;
 return {id:rule.id||'combined',interval,count:trades.length,wins:win,
  winRate:trades.length?win/trades.length*100:null,total:balance,
  avg:trades.length?balance/trades.length:null,drawdown:maxDD,
  longCount,shortCount:trades.length-longCount,
  overnightCount:trades.filter(t=>t.overnight).length,maxHoldBars,trades};
}
function simulate(bars,id,interval,costPct=.10,from=0,settings={}){
 return simulateRule(bars,{id,buyIds:[id],sellIds:[id]},interval,costPct,from,settings);
}
function simulateCombined(bars,buyIds,sellIds,interval,costPct=.10,from=0,settings={}){
 return simulateRule(bars,{id:'combined',buyIds,sellIds},interval,costPct,from,settings);
}
function analyze(raw,interval,ids,costPct=.10,combined=null,settings={}){
 const bars=normalize(raw,interval);
 const dates=[...new Set(bars.map(b=>day(b.t)))];
 const cutoff=dates[Math.floor(dates.length*.7)]||null;
 const start=cutoff?bars.findIndex(b=>day(b.t)===cutoff):bars.length;
 const results=ids.map(id=>{
  const full=simulate(bars,id,interval,costPct,0,settings);
  const holdout=dates.length>=5?simulate(bars,id,interval,costPct,start,settings):null;
  return {id,name:STRATEGIES.find(x=>x.id===id)?.name,full,holdout};
 });
 if(combined?.buyIds?.length&&combined?.sellIds?.length){
  const cfg=combined;
  results.unshift({
   id:'combined',name:'チェックした条件（AND）',
   full:simulateCombined(bars,cfg.buyIds,cfg.sellIds,interval,costPct,0,settings),
   holdout:dates.length>=5?simulateCombined(bars,cfg.buyIds,cfg.sellIds,interval,costPct,start,settings):null
  });
 }
 return {bars:bars.length,days:dates.length,first:dates[0]||null,last:dates.at(-1)||null,
  split:cutoff,trainDays:dates.length>=5?Math.floor(dates.length*.7):0,
  testDays:dates.length>=5?dates.length-Math.floor(dates.length*.7):0,results};
}
const api={STRATEGIES,OPTIONS,normalize,sma,rsi,bb,indicator,adjacent,endOfSession,combineSignals,simulate,simulateCombined,analyze};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
root.__STOCK_STRATEGY_ENGINE__=api;
})(typeof globalThis!=='undefined'?globalThis:this);
