/* Score-only search over a transparent two-parameter buy/sell rule.
 * Buy: at next candle's open when close crosses x% below highest high of
 * the previous/current 30 completed 1-minute candles in the same session.
 * Sell: resting take-profit y% above entry, with fixed -0.8% protective stop,
 * maximum 25-minute hold or session end. No lookahead, no fabricated bars.
 */
(function(root){
'use strict';
const WINDOW=30, X_MIN=0.15, X_MAX=3.00, Y_MIN=0.10, Y_MAX=3.50;
const STOP_PCT=0.80, HOLD_MINUTES=25, COST_DEFAULT=0.10;
const minute=t=>Number(t.slice(11,13))*60+Number(t.slice(14,16));
const segment=t=>{const n=minute(t);return n>=540&&n<690?'am':n>=750&&n<930?'pm':null;};
const adjacent=(a,b)=>!!a&&!!b&&a.t.slice(0,10)===b.t.slice(0,10)&&minute(b.t)-minute(a.t)===1;
const clamp=(n,lo,hi)=>Math.min(hi,Math.max(lo,n));
function normalizeBars(raw){
  const seen=new Map();
  for(const b of raw||[]){
    if(!Array.isArray(b)||b.length<6||typeof b[0]!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(b[0])||!segment(b[0]))continue;
    const nums=b.slice(1,6).map(Number),[o,h,l,c,v]=nums;
    if(!nums.every(Number.isFinite)||o<=0||l<=0||v<0||h<Math.max(o,c)||l>Math.min(o,c))continue;
    seen.set(b[0],{t:b[0],o,h,l,c,v});
  }
  return [...seen.values()].sort((a,b)=>a.t.localeCompare(b.t));
}
function groupSessions(raw){
  const groups=new Map();
  for(const b of normalizeBars(raw)){
    const date=b.t.slice(0,10);
    if(!groups.has(date))groups.set(date,{date,am:[],pm:[]});
    groups.get(date)[segment(b.t)].push(b);
  }
  return [...groups.values()].sort((a,b)=>a.date.localeCompare(b.date))
    .filter(day=>Math.max(day.am.length,day.pm.length)>=60);
}
function validateParams(params){
  if(!params||!Number.isFinite(params.x)||!Number.isFinite(params.y)||
      params.x<X_MIN||params.x>X_MAX||params.y<Y_MIN||params.y>Y_MAX)
      throw Error('x、yは定めた範囲にしてください。');
}
function dropSignal(session,i,x){
  if(i<WINDOW||i>=session.length)return false;
  for(let j=i-WINDOW+1;j<=i;j++)if(!adjacent(session[j-1],session[j]))return false;
  const current=session.slice(i-WINDOW+1,i+1),previous=session.slice(i-WINDOW,i);
  const highNow=Math.max(...current.map(b=>b.h));
  const highPrev=Math.max(...previous.map(b=>b.h));
  const dropNow=(1-session[i].c/highNow)*100;
  const dropPrev=(1-session[i-1].c/highPrev)*100;
  return dropPrev<x&&dropNow>=x;
}
function replay(params,days,costPct=COST_DEFAULT,withTrades=false){
  validateParams(params);
  if(!Number.isFinite(costPct)||costPct<0||costPct>2)throw Error('売買コストは0〜2%');
  const trades=[];let capital=0,peak=0,minDD=0,wins=0;
  for(const day of days){
    let entries=0;
    for(const session of [day.am,day.pm]){
      let position=null,cooldown=-1;
      function close(j,price,reason){
        const net=(price/position.price-1)*100-costPct;
        capital+=net;peak=Math.max(peak,capital);minDD=Math.min(minDD,capital-peak);
        if(net>0)wins++;
        trades.push({date:day.date,entry:position.time,exit:session[j].t,
          entryPrice:position.price,exitPrice:price,reason,net});
        position=null;cooldown=j+2;
      }
      for(let i=0;i<session.length;i++){
        const bar=session[i];
        if(position){
          if(i>position.index&&!adjacent(session[i-1],bar)){
            close(i,bar.o,'データ欠損・成行決済');continue;
          }
          // End before next-session carry; no order placement at the final candle.
          if(i===session.length-1||i-position.index>=HOLD_MINUTES){
            close(i,bar.o,i===session.length-1?'場末決済':'25分経過');continue;
          }
          // Conservative OHLCV ordering: stop first if both barriers reached.
          const stop=position.price*(1-STOP_PCT/100);
          const target=position.price*(1+params.y/100);
          if(bar.o<=stop||bar.l<=stop){close(i,Math.min(bar.o,stop),'固定損切り');continue;}
          if(bar.o>=target||bar.h>=target){close(i,target,'y%利確');continue;}
          continue;
        }
        if(entries>=3||i>=session.length-2||i<=cooldown)continue;
        if(!adjacent(bar,session[i+1]))continue;
        if(dropSignal(session,i,params.x)){
          position={index:i+1,time:session[i+1].t,price:session[i+1].o};
          entries++;
        }
      }
    }
  }
  const n=trades.length;
  const fitness=n?capital-0.5*Math.abs(minDD):-0.9;
  const out={score:fitness,total:capital,drawdown:minDD,n,wins,winRate:n?100*wins/n:null,
    mean:n?capital/n:null};
  if(withTrades)out.trades=trades;
  return out;
}
function random(seed){
  let a=seed>>>0;return ()=>{a=(a+0x6D2B79F5)>>>0;
    let t=Math.imul(a^(a>>>15),1|a);t^=t+Math.imul(t^(t>>>7),61|t);
    return ((t^(t>>>14))>>>0)/4294967296;};
}
function normal(rng){
  return Math.sqrt(-2*Math.log(Math.max(1e-12,rng())))*Math.cos(2*Math.PI*rng());
}
function mutate(base,rng,sigma){
  return {x:Math.round(clamp(base.x+normal(rng)*sigma,X_MIN,X_MAX)*1000)/1000,
    y:Math.round(clamp(base.y+normal(rng)*sigma*0.65,Y_MIN,Y_MAX)*1000)/1000};
}
function train(days,previous,rounds=30,population=12,costPct=COST_DEFAULT,initial={x:0.60,y:0.50}){
  if(!Array.isArray(days)||!days.length||days.length>3)throw Error('1〜3取引日で実行してください。');
  if(!Number.isInteger(rounds)||rounds<1||rounds>200||!Number.isInteger(population)||population<2||population>40)
    throw Error('繰り返し回数が範囲外です。');
  validateParams(initial);
  let best=previous?.params?{...previous.params}:{...initial};
  validateParams(best);
  const prior=previous?.rounds||0;
  const rng=random(6976+prior*1000003+(previous?.seed||0));
  let winning=replay(best,days,costPct),progress=[];
  for(let g=0;g<rounds;g++){
    const sigma=0.30*Math.pow(0.993,prior+g)+0.06;
    let avg=0,top=-Infinity,improved=false;
    for(let k=0;k<population;k++){
      const p=(k===population-1&&(g+prior)%7===6)?
        {x:Math.round((X_MIN+rng()*(X_MAX-X_MIN))*1000)/1000,
         y:Math.round((Y_MIN+rng()*(Y_MAX-Y_MIN))*1000)/1000}:
        mutate(best,rng,sigma);
      const score=replay(p,days,costPct);
      avg+=score.score;top=Math.max(top,score.score);
      if(score.score>winning.score+1e-9){
        best=p;winning=score;improved=true;
      }
    }
    progress.push({round:prior+g+1,best:winning.score,average:avg/population,
      top,profit:winning.total,drawdown:winning.drawdown,trades:winning.n,
      x:best.x,y:best.y,improved});
  }
  return {params:best,score:winning.score,rounds:prior+rounds,
    history:[...(previous?.history||[]),...progress].slice(-200),summary:winning};
}
const api={WINDOW,STOP_PCT,HOLD_MINUTES,X_MIN,X_MAX,Y_MIN,Y_MAX,
  normalizeBars,groupSessions,dropSignal,replay,train,random};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
root.__THRESHOLD_ENGINE__=api;
})(typeof globalThis!=='undefined'?globalThis:this);
