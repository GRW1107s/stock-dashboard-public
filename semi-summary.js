/* Kabutan AI/semiconductor morning/afternoon summaries. Source text is escaped. */
(function(){
"use strict";
const body=document.getElementById("semiSummaryRows");
const status=document.getElementById("semiSummaryStatus");
if(!body||!status)return;
const escape=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const sigmaValue=(values,index)=>{const hist=values.slice(Math.max(0,index-19),index+1).filter(Number.isFinite);if(hist.length<10)return null;const mean=hist.reduce((a,b)=>a+b,0)/hist.length;const sd=Math.sqrt(hist.reduce((a,b)=>a+(b-mean)**2,0)/hist.length);return sd>0?(values[index]-mean)/sd:null;};
const sigmaFmt=n=>Number.isFinite(n)?(n>0?"+":"")+n.toFixed(2)+"σ":"—";
const pct=n=>typeof n==="number"&&Number.isFinite(n)?(n>0?"+":"")+n.toFixed(2)+"%":"—";
let rows=[],limit=25;
function detail(label,summary,link){
 const content=typeof summary==="string"&&summary.trim()?escape(summary.slice(0,120)):(link?"該当記述なし":"記事未登録");
 let cite="";
 if(summary && link){
  try{
   const url=new URL(link);
   const allowed=["s.kabutan.jp","us.kabutan.jp","minkabu.jp","s.minkabu.jp","news.livedoor.com","hirose-fx.co.jp","www.oanda.jp"];
   if(url.protocol==="https:"&&allowed.includes(url.hostname)){
    const kabutan=/^(?:s|us)\.kabutan\.jp$/.test(url.hostname);
    const labelText=kabutan?"株探記事":"参考記事";
    cite='<a href="'+escape(url.href)+'" target="_blank" rel="noopener noreferrer" style="font-size:10px;white-space:nowrap;margin-left:7px">'+labelText+'</a>';
   }
  }catch(e){}
 }
 return '<div class="semi-summary-line"><strong>'+label+'：</strong><span>'+content+'</span>'+cite+'</div>';
}
// Separate directly described market moves from causal explanations.
// Historical entries without structured fields are classified conservatively:
// we never invent a cause not already stated in the source summary.
function splitLegacy(text){
 const sentences=String(text||"").match(/[^。！？]+[。！？]?/g)||[];
 const facts=[],interpretations=[];
 const causal=/(を受け|を背景に|追い風|重荷|嫌気|好感|懸念|警戒|期待|材料|支え|波及|みられ|観測|心理|ため|影響)/;
 const move=/(上昇|下落|急落|反発|続伸|続落|買い|売り|上げ|下げ|切り返|持ち直|伸び悩|引け|失速|軟調|堅調|縮小|拡大)/;
 for(const sentence of sentences){
  const value=sentence.trim();
  if(!value)continue;
  if(causal.test(value)){
   interpretations.push(value);
   // The observable part following a reported factor remains a fact,
   // while the whole article's cause/effect account is an interpretation.
   const clauses=value.split("、");
   const observed=clauses.slice(1).find(x=>move.test(x)&&!/追い風|重荷|影響|警戒|懸念|期待|背景/.test(x));
   if(observed)facts.push(observed.replace(/[。！？]$/,"")+"。");
  }else{
   facts.push(value);
  }
 }
 // 120 Japanese characters maximum per session across both columns.
 let fact=facts.filter((v,i,a)=>a.indexOf(v)===i).join("").slice(0,65);
 let interpretation=interpretations.filter((v,i,a)=>a.indexOf(v)===i).join("").slice(0,120-fact.length);
 return {fact,interpretation};
}
function render(){
 const view=limit?rows.slice(0,limit):rows;
 body.innerHTML=view.map(r=>{
  const s=r.sox||{};
  const am=(r.am_fact!==undefined||r.am_interpretation!==undefined)?
    {fact:r.am_fact||"",interpretation:r.am_interpretation||""}:splitLegacy(r.am_summary);
  const pm=(r.pm_fact!==undefined||r.pm_interpretation!==undefined)?
    {fact:r.pm_fact||"",interpretation:r.pm_interpretation||""}:splitLegacy(r.pm_summary);
  // A single TR per market session ensures fact and interpretation heights
  // match exactly, even when texts have different lengths or only one is present.
  const textCell=(label,value,article)=>'<td class="semi-summary-text">'+detail(label,value,article)+'</td>';
  return '<tr class="semi-summary-am">'+
   '<td rowspan="2" class="semi-summary-merged">'+escape(r.date)+'</td>'+
   '<td rowspan="2" class="semi-summary-merged"><strong style="color:'+(s.change>=0?"#047857":"#be3540")+'">'+pct(s.change)+'</strong><div>'+sigmaFmt(r.sox_sigma)+'</div></td>'+
   '<td rowspan="2" class="semi-summary-merged"><strong style="color:'+(r.nikkei_change_pct>=0?"#047857":"#be3540")+'">'+pct(r.nikkei_change_pct)+'</strong><div>'+sigmaFmt(r.nikkei_sigma)+'</div></td>'+
   textCell("前場",am.fact,r.am_article_url)+
   textCell("前場",am.interpretation,r.am_article_url)+'</tr>'+
   '<tr class="semi-summary-pm">'+
   textCell("後場",pm.fact,r.pm_article_url)+
   textCell("後場",pm.interpretation,r.pm_article_url)+'</tr>';
 }).join("")||'<tr><td colspan="5">記事・指数データを確認できません</td></tr>';
 const count=rows.filter(r=>r.am_summary||r.pm_summary||r.am_fact||r.pm_fact||r.am_interpretation||r.pm_interpretation).length;
 status.textContent="サマリー登録済み "+count+"取引日。前場・後場の事実と解釈を同じ行に表示。背景・因果関係の説明は記事の見方として扱います。";
}
document.querySelectorAll("#summaryRange button").forEach(b=>b.addEventListener("click",()=>{
 limit=Number(b.dataset.days);document.querySelectorAll("#summaryRange button").forEach(x=>x.classList.toggle("active",x===b));render();
}));
Promise.all([
 fetch("./semi-summary.json?t="+Date.now(),{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("サマリー HTTP "+r.status);return r.json()}),
 fetch("./sox-swing.json?t="+Date.now(),{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("SOXデータ HTTP "+r.status);return r.json()})
]).then(([jp,us])=>{
 const sox=us.sox||{},dates=Object.keys(sox).sort();
 rows=(jp.days||[]).map(d=>{
  const prior=dates.findLast(x=>x<d.date);
  const index=prior?dates.indexOf(prior):-1;
  const candle=index>=0?sox[prior]:null;
  const prev=index>0?sox[dates[index-1]]:null;
  const close=Array.isArray(candle)?Number(candle[3]):null;
  const last=Array.isArray(prev)?Number(prev[3]):null;
  return {...d,sox:prior?{close,change:last>0?(close/last-1)*100:null}:null};
 }).sort((a,b)=>a.date.localeCompare(b.date));
 const jpReturns=rows.map(r=>typeof r.nikkei_change_pct==="number"?r.nikkei_change_pct:NaN);
 const usReturns=dates.map((d,i)=>i>0&&Array.isArray(sox[d])&&Array.isArray(sox[dates[i-1]])?100*(Number(sox[d][3])/Number(sox[dates[i-1]][3])-1):NaN);
 rows.forEach((r,i)=>{const u=dates.findLastIndex(d=>d<r.date);r.sox_sigma=u>=0?sigmaValue(usReturns,u):null;r.nikkei_sigma=Number.isFinite(jpReturns[i])?sigmaValue(jpReturns,i):null;});
 rows.reverse();
 render();
}).catch(e=>{body.innerHTML='<tr><td colspan="5">データ取得に失敗しました</td></tr>';status.textContent=String(e.message||e)});
})();
