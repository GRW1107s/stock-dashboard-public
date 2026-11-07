/* Fujikura 5-minute morning shape classifier.
   Uses ONLY the 09:05-10:00 window; forward returns start at 10:05.
   Six mutually exclusive chart shapes, no look-ahead or synthetic candles. */
(function(){
"use strict";
const panel=document.getElementById("fujiShapeStudy");
if(!panel)return;
const $=id=>document.getElementById(id);
const names=["上昇トレンド","下落トレンド","V字反発","逆V字失速","W・M型","レンジ・複雑型"];
const colors=["#087f5b","#c2414a","#147d8c","#9c4f99","#ad6d22","#64748b"];
const vals=[], all=[];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pct=n=>Number.isFinite(n)?(n>0?"+":"")+n.toFixed(2)+"%":"—";
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const norm=a=>{const lo=Math.min(...a),hi=Math.max(...a),rg=hi-lo;return rg? a.map(v=>(v-lo)/rg):a.map(()=>.5)};
function shape(a){
 const v=norm(a),n=v.length,first=v[0],last=v[n-1];
 const left=avg(v.slice(0,3)),middle=avg(v.slice(4,8)),right=avg(v.slice(-3));
 const span=Math.max(...a)-Math.min(...a),rel=span/a[0]*100;
 if(rel<.40)return 5; // low volatility: range regardless of micro wiggles
 if(middle<Math.min(left,right)-.25 && right>middle+.30)return 2;
 if(middle>Math.max(left,right)+.25 && right<middle-.30)return 3;
 const diff=last-first;
 const segments=[avg(v.slice(0,2)),avg(v.slice(2,4)),avg(v.slice(4,6)),avg(v.slice(6,8)),avg(v.slice(8,10)),avg(v.slice(10,12))];
 const slopes=segments.slice(1).map((x,i)=>Math.sign(x-segments[i]));
 const changes=slopes.slice(1).filter((x,i)=>x&&slopes[i]&&x!==slopes[i]).length;
 if(changes>=3 && Math.abs(diff)<.6)return 4;
 if(diff>.45 && right>left+.32)return 0;
 if(diff<-.45 && right<left-.32)return 1;
 return 5;
}
function svg(a,color,width=160,height=72){
 const y=norm(a),pad=7,pts=y.map((v,i)=>(pad+i*(width-2*pad)/(y.length-1)).toFixed(1)+","+(height-pad-v*(height-2*pad)).toFixed(1)).join(" ");
 return '<svg viewBox="0 0 '+width+' '+height+'" width="100%" height="'+height+'" role="img" aria-label="9時05分〜10時00分の実際の価格推移"><path d="M7 '+(height/2)+' H'+(width-7)+'" stroke="#e2e8f0" stroke-dasharray="4 3"/><polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}
function parse(bars){
 const groups=new Map();
 for(const b of bars){
  if(!Array.isArray(b)||b.length<6||!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(b[0]))continue;
  const day=b[0].slice(0,10),time=b[0].slice(11);
  if(!groups.has(day))groups.set(day,new Map());
  groups.get(day).set(time,b);
 }
 const hhmm=m=>String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0");
 for(const [date,series] of groups){
  // Require every bar in a consistent 55-min observation window.
  const window=Array.from({length:12},(_,i)=>series.get(hhmm(545+i*5)));
  // Future: entry at 10:05 open, exit at 10:35 close.
  const future=Array.from({length:7},(_,i)=>series.get(hhmm(605+i*5)));
  if(window.some(x=>!x)||future.some(x=>!x))continue;
  const closes=window.map(x=>Number(x[4]));
  if(closes.some(x=>!Number.isFinite(x)||x<=0))continue;
  const entry=Number(future[0][1]),out=Number(future[6][4]);
  if(!(entry>0&&out>0))continue;
  const type=shape(closes),r=(out/entry-1)*100;
  all.push({date,type,closes,r,change:(closes.at(-1)/closes[0]-1)*100});
 }
 all.sort((a,b)=>b.date.localeCompare(a.date));
}
function render(){
 const n=Number($("fujiShapeRange").value);
 const data=n?all.slice(0,n):all;
 $("fujiShapeTable").innerHTML=names.map((name,k)=>{
  const a=data.filter(x=>x.type===k),v=a.map(x=>x.r),win=v.filter(x=>x>0).length;
  const lead=a[0],mean=avg(v);
  return '<tr><td style="text-align:left;white-space:normal"><b>'+name+'</b></td><td>'+a.length+'</td><td>'+(v.length?(100*win/v.length).toFixed(1)+'%':'—')+'</td><td style="color:'+(mean>0?"#047857":mean<0?"#be3540":"inherit")+'">'+pct(mean)+'</td><td style="min-width:95px">'+(lead?svg(lead.closes,colors[k],110,52):"—")+'</td></tr>';
 }).join("");
 $("fujiShapeExamples").innerHTML=names.map((name,k)=>{
  const a=data.filter(x=>x.type===k),lead=a[0];
  return '<div style="border:1px solid #e1e7ef;padding:10px;border-radius:6px;background:#fff"><b>'+name+'</b><div style="height:80px">'+(lead?svg(lead.closes,colors[k]):'<p class="muted">該当なし</p>')+'</div><div class="muted small">'+(lead?lead.date+"（実測） / その後30分 "+pct(lead.r):"該当日なし")+'</div></div>';
 }).join("");
 $("fujiShapeStatus").textContent="該当 "+data.length+"営業日 / 全 "+all.length+"営業日｜9:05〜10:00の12本で分類→10:05始値から10:35終値までの30分騰落率。上昇確率は30分リターンがプラスだった割合。";
}
$("fujiShapeRange").addEventListener("change",render);
fetch("./fujikura-5m.json?t="+Date.now(),{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("HTTP "+r.status);return r.json()}).then(d=>{
 if(!Array.isArray(d.bars))throw Error("5分足がありません");
 parse(d.bars);
 render();
 $("fujiShapeSource").textContent="保存5分足 "+d.bars.length+"本 / 最終更新 "+(d.updated_at||"不明")+"。判定は各区間の終値を正規化した形状による簡易ルールです。";
}).catch(e=>{
 $("fujiShapeTable").innerHTML='<tr><td colspan="5">データ取得に失敗：'+esc(e.message)+'</td></tr>';
 $("fujiShapeStatus").textContent="実測データが取得できるまで分類しません。";
});
})();