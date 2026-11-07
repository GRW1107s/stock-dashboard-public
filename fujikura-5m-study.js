/* Fujikura 5-minute pattern study. All trades execute at the NEXT candle open.
   Exit after three completed 5-minute candles at that candle's close. */
(function(){
"use strict";
const $=id=>document.getElementById(id);
if(!$("fuji5Table"))return;
const label={
 openingFade:"寄り付き急騰→失速（売り）",
 openingBounce:"寄り付き急落→反発（買い）",
 breakout:"午前高値ブレイク（買い）",
 vwap:"VWAP回復（買い）"
};
const round=n=>Number.isFinite(n)?n.toFixed(2):"—";
const sign=n=>Number.isFinite(n)?(n>0?"+":"")+round(n)+"%":"—";
let trades=[],dailyCount=0,dataEnd="";
function identify(bars){
 const results=[];
 const dayGroups=new Map();
 bars.forEach(a=>{
  if(!Array.isArray(a)||a.length<6)return;
  const t=String(a[0]),d=t.slice(0,10),hh=t.slice(11,16);
  const x={t,hh,o:+a[1],h:+a[2],l:+a[3],c:+a[4],v:+a[5]};
  if(![x.o,x.h,x.l,x.c,x.v].every(Number.isFinite)||x.o<=0||x.l<=0)return;
  if(!dayGroups.has(d))dayGroups.set(d,[]);
  dayGroups.get(d).push(x);
 });
 let complete=0;
 for(const [date,unsorted] of dayGroups){
   const b=unsorted.sort((x,y)=>x.t.localeCompare(y.t));
   const times=new Set(b.map(x=>x.hh));
   if(!["09:00","09:05","09:10","09:15","09:20","09:25","09:30","10:00","11:25","12:30","15:25"].every(x=>times.has(x)))continue;
   complete++;
   let sumPv=0,sumV=0;
   const vwap=b.map(x=>{sumPv+=(x.h+x.l+x.c)/3*x.v;sumV+=x.v;return sumV>0?sumPv/sumV:null});
   const push=(kind,i,side)=>{
     if(i+4>=b.length)return;
     const entry=b[i+1],exit=b[i+4];
     // Protect against lunch or missing timestamps: require 4 contiguous 5-minute intervals.
     const minute=t=>Number(t.hh.slice(0,2))*60+Number(t.hh.slice(3,5));
     if(minute(exit)-minute(entry)!==15)return;
     const gross=side*(exit.c/entry.o-1)*100;
     results.push({date,kind,side,entry:entry.t,exit:exit.t,gross});
   };
   // Evaluate the first three bars, then require a reversal confirmation at 09:10.
   const first=b.slice(0,3);
   if(first.map(x=>x.hh).join(",")==="09:00,09:05,09:10"){
     const ret=(first[2].c/first[0].o-1)*100;
     if(ret>=1&&first[2].c<first[2].o)push("openingFade",2,-1);
     if(ret<=-1&&first[2].c>first[2].o)push("openingBounce",2,1);
   }
   const morning=b.filter(x=>x.hh>="09:00"&&x.hh<="09:25");
   if(morning.length===6){
     const high=Math.max(...morning.map(x=>x.h));
     for(let i=6;i<b.length;i++){
       if(b[i].hh<"09:30"||b[i].hh>"11:00")continue;
       const trailing=b.slice(Math.max(0,i-12),i).map(x=>x.v).sort((a,z)=>a-z);
       if(trailing.length<6)continue;
       const median=trailing[Math.floor(trailing.length/2)];
       if(b[i].c>high&&b[i-1].c<=high&&b[i].v>1.5*median){push("breakout",i,1);break;}
     }
   }
   for(let i=6;i<b.length;i++){
     if(b[i].hh<"09:30"||b[i].hh>"14:55")continue;
     if(vwap[i-1]===null||vwap[i]===null)continue;
     if(b[i-1].c<vwap[i-1]&&b[i].c>vwap[i]&&b[i].v>b[i-1].v){push("vwap",i,1);break;}
   }
 }
 dailyCount=complete;
 return results;
}
function draw(){
 const cost=Number($("fuji5Cost").value);
 const selected=Number($("fuji5Days").value);
 const cutoff=selected?new Date(dataEnd+"T00:00:00+09:00").getTime()-selected*86400000:-Infinity;
 const filtered=trades.filter(t=>Date.parse(t.date+"T00:00:00+09:00")>=cutoff);
 $("fuji5Table").innerHTML=Object.keys(label).map(kind=>{
   const a=filtered.filter(x=>x.kind===kind),n=a.length;
   const rets=a.map(x=>x.gross-cost);
   const mean=n?rets.reduce((sum,x)=>sum+x,0)/n:NaN;
   const win=n?100*rets.filter(x=>x>0).length/n:NaN;
   return '<tr><td style="text-align:left">'+label[kind]+'</td><td>'+n+'</td><td>'+(n?round(win)+"%":"—")+'</td><td style="color:'+(mean>=0?"#047857":"#be3540")+'">'+sign(mean)+'</td><td>'+(n?sign(Math.min(...rets)):"—")+'</td></tr>';
 }).join("");
 $("fuji5Status").textContent="完全な5分足の日数："+dailyCount+"日／最終データ日："+(dataEnd||"—")+"／約定：シグナル次足始値→3本後の終値（15分保有）／往復コスト："+cost.toFixed(2)+"%／同一パターン1日最大1回";
}
["fuji5Cost","fuji5Days"].forEach(id=>$(id).addEventListener("change",draw));
fetch("./fujikura-5m.json?t="+Date.now(),{cache:"no-store"}).then(r=>{
 if(!r.ok)throw Error("5分足データ未作成（HTTP "+r.status+"）。GitHub Actionsの初回実行待ち");
 return r.json();
}).then(data=>{
 if(data.symbol!=="5803.T"||!Array.isArray(data.bars))throw Error("データ形式が一致しません");
 const days=[...new Set(data.bars.map(x=>x[0].slice(0,10)))].sort();
 dataEnd=days.at(-1)||"";
 trades=identify(data.bars);
 draw();
 $("fuji5Source").textContent="データ最終更新："+(data.updated_at||"—")+"／5分足："+data.bars.length+"本、取得対象期間："+(days[0]||"—")+"〜"+(days.at(-1)||"—")+(data.fetch_errors?.length?"／一部取得失敗あり":"");
}).catch(err=>{
 $("fuji5Table").innerHTML='<tr><td colspan="5" style="text-align:left">未検証：'+String(err.message).replace(/[<>]/g,"")+'</td></tr>';
 $("fuji5Status").textContent="5分足の実測値が揃うまでは勝率・期待値を表示しません。";
});
})();