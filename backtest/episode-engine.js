/* Episode-level black-box policy search for Taiyo Yuden 1-minute candles.
 * No per-trade labels, gradients, lookahead or fabricated prices.
 * One episode replays at most three observed trading days; only its scalar
 * fitness is used for candidate selection and parameter updates.
 */
(function(root){
  'use strict';
  const FEATURE_COUNT=13, POLICY_LENGTH=2*(FEATURE_COUNT+1);
  const clip=(x,lo=-3,hi=3)=>Math.max(lo,Math.min(hi,x));
  const minute=t=>Number(t.slice(11,13))*60+Number(t.slice(14,16));
  const contiguous=(a,b)=>a&&b&&a.t.slice(0,10)===b.t.slice(0,10)&&minute(b.t)-minute(a.t)===1;
  const part=t=>{const m=minute(t);return m>=540&&m<690?'am':m>=750&&m<930?'pm':null;};
  function normalizeBars(raw){
    const seen=new Map();
    for(const b of raw||[]){
      if(!Array.isArray(b)||b.length<6||typeof b[0]!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(b[0])||!part(b[0]))continue;
      const v=b.slice(1,6).map(Number),[o,h,l,c,volume]=v;
      if(!v.every(Number.isFinite)||o<=0||l<=0||volume<0||h<Math.max(o,c,l)||l>Math.min(o,c))continue;
      seen.set(b[0],{t:b[0],o,h,l,c,v:volume});
    }
    return [...seen.values()].sort((a,b)=>a.t.localeCompare(b.t));
  }
  function groupSessions(raw){
    const grouped=new Map();
    for(const b of normalizeBars(raw)){
      const date=b.t.slice(0,10);
      if(!grouped.has(date))grouped.set(date,{date,am:[],pm:[]});
      grouped.get(date)[part(b.t)].push(b);
    }
    return [...grouped.values()].filter(d=>Math.max(d.am.length,d.pm.length)>=60)
      .sort((a,b)=>a.date.localeCompare(b.date));
  }
  function features(session,i,pos){
    if(i<20)return null;
    for(let j=i-19;j<=i;j++)if(!contiguous(session[j-1],session[j]))return null;
    const b=session[i],pct=(a,c)=>100*(a/c-1);
    let pv=0,vol=0;
    for(let j=0;j<=i;j++){const a=session[j];pv+=(a.h+a.l+a.c)/3*a.v;vol+=a.v;}
    const vw=vol?pv/vol:b.c;
    const volumes=session.slice(i-12,i).map(x=>x.v).sort((a,b)=>a-b);
    const med=volumes[Math.floor(volumes.length/2)]||1;
    const range=Math.max(...session.slice(i-4,i+1).map(x=>x.h))-Math.min(...session.slice(i-4,i+1).map(x=>x.l));
    const positionInBar=b.h>b.l?2*(b.c-b.l)/(b.h-b.l)-1:0;
    const elapsed=Math.min(1,Math.max(0,(minute(b.t)-(part(b.t)==='am'?540:750))/(part(b.t)==='am'?150:180)));
    return [
      clip(pct(b.c,session[i-1].c)*10),
      clip(pct(b.c,session[i-3].c)*6),
      clip(pct(b.c,session[i-10].c)*3),
      clip(pct(b.c,session[i-20].c)*2),
      clip(pct(b.c,b.o)*12),
      clip(pct(b.c,vw)*4),
      clip(b.v/med-1),
      clip(range/b.c*100*3),
      clip(pct(b.c,session[0].o)*2),
      clip(positionInBar),
      2*elapsed-1,
      pos?clip(pct(b.c,pos.price)*7):0,
      pos?clip((i-pos.index)/15):0
    ];
  }
  function activation(weights,offset,f){
    let z=weights[offset+FEATURE_COUNT];
    for(let i=0;i<FEATURE_COUNT;i++)z+=weights[offset+i]*f[i];
    return Math.tanh(z);
  }
  function replay(weights,days,costPct=0.10,includeTrades=false){
    if(!Array.isArray(weights)||weights.length!==POLICY_LENGTH||!weights.every(Number.isFinite))throw Error('方策パラメータが不正です。');
    const trades=[];let capital=0,peak=0,minDD=0,wins=0;
    for(const d of days){
      let dayEntries=0;
      for(const s of [d.am,d.pm]){
        if(s.length<2)continue;
        let pos=null,cooldown=-1;
        const close=(i,price,reason)=>{
          if(!pos)return;
          const net=(price/pos.price-1)*100-costPct;
          capital+=net;peak=Math.max(peak,capital);minDD=Math.min(minDD,capital-peak);
          if(net>0)wins++;
          trades.push({date:d.date,entry:pos.time,exit:s[i].t,entryPrice:pos.price,exitPrice:price,reason,net});
          pos=null;cooldown=i+2;
        };
        for(let i=0;i<s.length;i++){
          const bar=s[i];
          if(pos){
            if(i>0&&!contiguous(s[i-1],bar)){close(i,bar.o,'欠損で決済');continue;}
            const age=i-pos.index;
            if(age>=25||i===s.length-1){close(i,bar.o,age>=25?'保有上限':'場末決済');continue;}
            if(bar.o<=pos.price*0.992||bar.l<=pos.price*0.992){
              close(i,Math.min(bar.o,pos.price*0.992),'損切り');continue;
            }
            if(bar.o>=pos.price*1.01||bar.h>=pos.price*1.01){
              close(i,pos.price*1.01,'利確');continue;
            }
          }
          if(i>=s.length-1||!contiguous(bar,s[i+1])||i<cooldown)continue;
          const f=features(s,i,pos);
          if(!f)continue;
          if(pos){
            if(activation(weights,FEATURE_COUNT+1,f)>0.25)close(i+1,s[i+1].o,'方策が売却');
          }else if(dayEntries<6&&activation(weights,0,f)>0.25){
            pos={index:i+1,time:s[i+1].t,price:s[i+1].o};
            dayEntries++;
          }
        }
      }
    }
    const n=trades.length;
    // A zero-trade policy is not a profitable discovery.
    const fitness=n?capital-0.5*Math.abs(minDD):-0.9;
    const out={fitness,total:capital,dd:minDD,n,wins,winRate:n?100*wins/n:null,mean:n?capital/n:null};
    if(includeTrades)out.trades=trades;
    return out;
  }
  function random(seed){
    let a=seed>>>0;
    return ()=>{a=(a+0x6D2B79F5)>>>0;let t=Math.imul(a^(a>>>15),1|a);
      t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296;};
  }
  function normal(rng){
    return Math.sqrt(-2*Math.log(Math.max(1e-12,rng())))*Math.cos(2*Math.PI*rng());
  }
  function fresh(rng){return Array.from({length:POLICY_LENGTH},()=>normal(rng)*0.42);}
  function perturb(w,rng,sigma){return w.map(x=>clip(x+normal(rng)*sigma,-5,5));}
  function train(days,previous,rounds=25,population=10,costPct=0.10,onRound){
    if(!Array.isArray(days)||days.length<1||days.length>3)throw Error('1〜3取引日の実データが必要です。');
    if(!Number.isInteger(rounds)||rounds<1||rounds>200||!Number.isInteger(population)||population<2||population>40)throw Error('試行回数が範囲外です。');
    const priorRounds=previous?.rounds||0;
    const rng=random((6976+priorRounds*1000003+(previous?.seed||0))>>>0);
    let best=previous?.weights?previous.weights.slice():fresh(rng);
    if(best.length!==POLICY_LENGTH)throw Error('保存された方策が不正です。');
    let bestResult=replay(best,days,costPct);
    const progress=[];
    for(let g=0;g<rounds;g++){
      const sigma=0.38*Math.pow(0.993,priorRounds+g)+0.06;
      let generationBest=-Infinity,scoreSum=0,improved=false;
      for(let k=0;k<population;k++){
        const candidate=(k===population-1&&(g+priorRounds)%8===7)?fresh(rng):perturb(best,rng,sigma);
        const result=replay(candidate,days,costPct);
        generationBest=Math.max(generationBest,result.fitness);
        scoreSum+=result.fitness;
        if(result.fitness>bestResult.fitness+1e-10){
          best=candidate;bestResult=result;improved=true;
        }
      }
      const row={round:priorRounds+g+1,best:bestResult.fitness,mean:scoreSum/population,
        generationBest,profit:bestResult.total,drawdown:bestResult.dd,trades:bestResult.n,improved};
      progress.push(row);
      if(typeof onRound==='function')onRound(row);
    }
    return {weights:best,score:bestResult.fitness,rounds:priorRounds+rounds,
      history:[...(previous?.history||[]),...progress].slice(-200),summary:bestResult};
  }
  const api={FEATURE_COUNT,POLICY_LENGTH,normalizeBars,groupSessions,features,replay,train,random,fresh};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.__EPISODE_ENGINE__=api;
})(typeof globalThis!=='undefined'?globalThis:this);
