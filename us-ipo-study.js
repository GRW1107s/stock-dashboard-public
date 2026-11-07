/* Major US IPO event study: observed market movements, no causal attribution. */
(function(){
"use strict";
const root=document.getElementById("ipoStudyPanel");
if(!root)return;
const EVENTS=[
 {id:"SPCX_REPORT",name:"SpaceX（大型IPO報道）",date:"2025-12-09",bn:null,type:"announcement",tag:"大型IPO計画の報道",desc:"12月5日にもIPO観測報道があったが、12月9日にBloombergが調達額300億ドル超・評価額約1.5兆ドルの大型IPO計画を大きく報道した。NASDAQ上場は2026年6月12日。報道前20取引日からの相場を観測する基準日。",url:"https://www.bloomberg.com/news/articles/2025-12-09/spacex-said-to-pursue-2026-ipo-raising-far-above-30-billion"},
 {id:"SPCX",name:"SpaceX",date:"2026-06-12",bn:75.00,type:"ipo",tag:"過去最大の米国IPO",desc:"6月11日に公募価格決定。6月12日にNASDAQ上場。公募時750億ドル、追加割当を含む最終調達額は約857億ドル。",url:"https://ir.spacex.com/updates/releases-details/2026/Space-Exploration-Technologies-Corp--Announces-Closing-of-Initial-Public-Offering-Including-Full-Exercise-of-Underwriters-Option-to-Purchase-Additional-Shares-2026-RgoR-Y1Vwh/"},
 {id:"SKHY",name:"SK hynix（米国ADR）",date:"2026-07-10",bn:26.51,type:"adr",tag:"米国ADR新規上場（別枠）",desc:"既存の韓国上場企業が米国でADRを新規上場。通常の未公開企業IPOとは性質が異なるため、IPO平均には含めない。",url:"https://www.nasdaqtrader.com/TraderNews.aspx?id=DTN2026-11"},
 {id:"CBRS",name:"Cerebras",date:"2026-05-14",bn:5.55,type:"ipo",tag:"AI半導体",desc:"AI半導体企業のNASDAQ新規上場。金額は追加割当前の公募調達額。",url:"https://investors.cerebras.ai/news-releases/news-release-details/cerebras-systems-announces-pricing-initial-public-offering"},
 {id:"ARM",name:"Arm",date:"2023-09-14",bn:4.87,type:"ipo",tag:"半導体設計",desc:"半導体IP企業のNASDAQ上場。既存株主による売出し中心。",url:"https://investors.arm.com/node/7051/html"},
 {id:"RIVN",name:"Rivian",date:"2021-11-10",bn:11.93,type:"ipo",tag:"電気自動車",desc:"2021年の大型自動車メーカーIPO。",url:"https://www.axios.com/2021/11/10/rivian-completes-largest-ipo-since-alibaba"},
 {id:"DIDI",name:"DiDi Global",date:"2021-06-30",bn:4.44,type:"ipo",tag:"配車サービス",desc:"中国系配車企業の米国上場。地政学・規制リスクの影響を含む時期。",url:"https://www.renaissancecapital.com/IPO-Center/Stats/Largest-US-IPOs"},
 {id:"CPNG",name:"Coupang",date:"2021-03-11",bn:4.55,type:"ipo",tag:"電子商取引",desc:"韓国系電子商取引企業のNYSE上場。",url:"https://www.renaissancecapital.com/IPO-Center/Stats/Largest-US-IPOs"},
 {id:"UBER",name:"Uber",date:"2019-05-10",bn:8.10,type:"ipo",tag:"配車サービス",desc:"2019年の大型配車企業IPO。米中貿易摩擦と重なった時期。",url:"https://investor.uber.com/news-events/news/press-release-details/2019/Uber-Announces-Pricing-of-Initial-Public-Offering/default.aspx"},
 {id:"BABA",name:"Alibaba",date:"2014-09-19",bn:21.77,type:"ipo",tag:"電子商取引",desc:"2014年当時、世界最大規模のIPO。",url:"https://www.alibabagroup.com/en-US/document-1490841477796855808"},
 {id:"META",name:"Facebook（現Meta）",date:"2012-05-18",bn:16.01,type:"ipo",tag:"SNS",desc:"2012年の大型テクノロジーIPO。",url:"https://about.fb.com/news/2012/05/facebook-announces-pricing-of-initial-public-offering/"},
 {id:"GM",name:"General Motors",date:"2010-11-18",bn:15.77,type:"ipo",tag:"自動車",desc:"GMの再上場。事業再生・金融危機後の市場環境と重なる。",url:"https://www.sec.gov/Archives/edgar/data/1467858/000154315120000010/fy2019q410kfinancialst.htm"},
 {id:"V",name:"Visa",date:"2008-03-19",bn:17.86,type:"ipo",tag:"決済",desc:"世界金融危機の期間中に実施された大型IPO。",url:"https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.7636.html"}
];
const KEYS=["NDX","SPX","SOX"];
const COLORS={NDX:"#2563eb",SPX:"#0d9488",SOX:"#db6b35"};
let archive=null,selected="SPCX_REPORT",range=20;
const $=id=>document.getElementById(id);
const valid=x=>typeof x==="number"&&Number.isFinite(x);
const pct=n=>valid(n)?(n>0?"+":"")+n.toFixed(2)+"%":"—";
const signed=n=>valid(n)?(n>0?"+":"")+n.toFixed(2):"—";
const shortDate=s=>s.replaceAll("-","/");
const bfmt=n=>valid(n)?"$"+n.toFixed(2)+"B":"—";
const INDEX={};
function snapshot(event,key){
 if(!archive||!archive.series||!archive.series[key])return null;
 const dates=Object.keys(archive.series[key]).sort(),t=dates.indexOf(event.date);
 if(t<21||t>=dates.length)return null;
 const base=archive.series[key][dates[t-1]];
 if(!(base>0))return null;
 const values={};
 for(let d=-20;d<=60;d++){
  const ix=t+d;
  const p=ix>=0&&ix<dates.length?archive.series[key][dates[ix]]:null;
  values[d]=p>0?100*(p/base-1):null;
 }
 const before=archive.series[key][dates[t-21]];
 return {values,prior20:before>0?100*(base/before-1):null,marketDate:dates[t],sessionCount:dates.length};
}
function eventData(event){
 const result={};for(const key of KEYS)result[key]=snapshot(event,key);
 return result;
}
function seriesPoint(ev,key,d){const s=snapshot(ev,key);return s?s.values[d]:null}
function aggregate(){
 const list=EVENTS.filter(e=>e.type==="ipo");
 const out={};
 for(const k of KEYS){
  const studies=list.map(e=>snapshot(e,k)).filter(Boolean);
  const values={};
  for(let d=-20;d<=60;d++){
   const observations=studies.map(s=>s.values[d]).filter(valid);
   values[d]=observations.length?observations.reduce((a,b)=>a+b,0)/observations.length:null;
  }
  const prior=studies.map(s=>s.prior20).filter(valid);
  out[k]={values,prior20:prior.length?prior.reduce((a,b)=>a+b,0)/prior.length:null,n:studies.length};
 }
 return out;
}
function chart(studies){
 const originLabel=selected==="SPCX_REPORT"?"大型報道日":"上場日";
 const start=range===10?-10:-20,finish=range===60?60:range;
 const W=1060,H=345,L=59,R=25,T=24,B=50;
 const all=[];
 for(const key of KEYS){const s=studies[key];if(!s)continue;for(let d=start;d<=finish;d++)if(valid(s.values[d]))all.push(s.values[d]);}
 const min=Math.min(-1,...all),max=Math.max(1,...all),extra=Math.max(0.8,(max-min)*0.12);
 const y0=min-extra,y1=max+extra;
 const x=d=>L+(d-start)/(finish-start)*(W-L-R);
 const y=v=>T+(y1-v)/(y1-y0)*(H-T-B);
 let markup='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="IPO前後のNASDAQ100、S&P500、SOXの累積騰落率比較">';
 for(let i=0;i<=5;i++){
  const v=y0+(y1-y0)*i/5,yy=y(v);
  markup+='<line x1="'+L+'" y1="'+yy+'" x2="'+(W-R)+'" y2="'+yy+'" stroke="'+(Math.abs(v)<0.01?"#9ca3af":"#e2e8f0")+'"/>'+
  '<text x="'+(L-8)+'" y="'+(yy+4)+'" text-anchor="end" font-size="11" fill="#64748b">'+v.toFixed(1)+'%</text>';
 }
 markup+='<line x1="'+x(0)+'" y1="'+T+'" x2="'+x(0)+'" y2="'+(H-B)+'" stroke="#475569" stroke-width="1.5" stroke-dasharray="5 4"/>'+
 '<text x="'+(x(0)+5)+'" y="'+(T+12)+'" font-size="11" fill="#334155">'+originLabel+'</text>';
 const step=finish===60?10:5;
 for(let d=start;d<=finish;d+=step){
  markup+='<text x="'+x(d)+'" y="'+(H-23)+'" text-anchor="middle" font-size="11" fill="#64748b">'+(d>0?"+":"")+d+'</text>';
 }
 markup+='<text x="'+(W/2)+'" y="'+(H-4)+'" text-anchor="middle" font-size="12" fill="#475569">IPO日からの取引日数（t=0が上場日）</text>';
 for(const key of KEYS){
  const s=studies[key];if(!s)continue;
  let segment=[];
  function emit(){if(segment.length>1)markup+='<polyline points="'+segment.map(p=>x(p[0])+','+y(p[1])).join(' ')+'" fill="none" stroke="'+COLORS[key]+'" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';segment=[];}
  for(let d=start;d<=finish+1;d++){
   const n=s.values[d];
   if(!valid(n)){emit();continue}
   segment.push([d,n]);
  }
  emit();
  for(const d of [0,5,20,60]){
   if(d>finish)continue;
   const n=s.values[d];
   if(!valid(n))continue;
   markup+='<circle cx="'+x(d)+'" cy="'+y(n)+'" r="3.5" fill="'+COLORS[key]+'"><title>'+key+' t'+(d>=0?"+":"")+d+'：'+pct(n)+'</title></circle>';
  }
 }
 markup+='</svg>';
 return markup;
}
function statCard(title,value,note){
 return '<div class="ipo-stat"><span>'+title+'</span><strong class="'+(typeof value==="number"?(value>=0?"ipo-pos":"ipo-neg"):"")+'">'+(typeof value==="number"?pct(value):value)+'</strong><small>'+note+'</small></div>';
}
function compareText(key,study,eventLabel){
 if(!study||!valid(study.values[20]))return key+"：20取引日のデータが不足しています。";
 return key+"："+eventLabel+"前20取引日 "+pct(study.prior20)+"／"+eventLabel+"当日 "+pct(study.values[0])+"／"+eventLabel+"後20取引日 "+pct(study.values[20])+"。";
}
function renderSelected(){
 const event=EVENTS.find(e=>e.id===selected);
 const studies=selected==="average"?aggregate():eventData(event);
 const title=event?event.name+"（"+shortDate(event.date)+"）":"大型IPOの単純平均";
 const eventLabel=event?.type==="announcement"?"報道":event?.type==="adr"?"ADR上場":"上場";
 const count=EVENTS.filter(e=>e.type==="ipo").length;
 const notice=event?event.desc:"通常のIPOのみ"+count+"件を平均。SpaceXの報道日とSK hynixの米国ADR上場は集計から除外。指数別に有効な日次データがあるイベントだけを集計。";
 $("ipoTitle").textContent=title;
 $("ipoDescription").textContent=notice;
 $("ipoSources").innerHTML=event?'<a href="'+event.url+'" target="_blank" rel="noopener noreferrer">出典・基準日の確認</a> ｜ <a href="https://www.renaissancecapital.com/IPO-Center/Stats/Largest-US-IPOs" target="_blank" rel="noopener noreferrer">大型IPO一覧（調達額比較）</a>':'<a href="https://www.renaissancecapital.com/IPO-Center/Stats/Largest-US-IPOs" target="_blank" rel="noopener noreferrer">大型IPOの出典</a>';
 const ndx=studies.NDX,spx=studies.SPX,sox=studies.SOX;
 const label=selected==="average"?"単純平均（通常IPO）":"終値ベース";
 $("ipoCards").innerHTML=statCard("NDX｜"+eventLabel+"当日",ndx?.values[0]??null,label)+statCard("NDX｜"+eventLabel+"後5日",ndx?.values[5]??null,label)+statCard("NDX｜"+eventLabel+"後20日",ndx?.values[20]??null,label)+statCard("SPX｜"+eventLabel+"後20日",spx?.values[20]??null,label)+statCard("SOX｜"+eventLabel+"後20日",sox?.values[20]??null,label);
 $("ipoChart").innerHTML=chart(studies);
 const spread=valid(ndx?.values[20])&&valid(spx?.values[20])?ndx.values[20]-spx.values[20]:null;
 const line1=compareText("NDX",ndx,eventLabel),line2=compareText("SPX",spx,eventLabel),line3=compareText("SOX",sox,eventLabel);
 let diff=spread===null?"指数間の比較には十分なデータがありません。":eventLabel+"後20取引日のNDXとSPXの差は "+(spread>=0?"+":"")+spread.toFixed(2)+"ポイント（"+(spread>0?"NDXが相対優位":spread<0?"SPXが相対優位":"同水準")+"）。";
 $("ipoReport").innerHTML='<h3>市場への影響を検証するための観測結果</h3>'+
 '<p>'+line1+'</p><p>'+line2+'</p><p>'+line3+'</p><p>'+diff+'</p>'+
 '<p class="ipo-caution">これはIPOの前後に実際に起きた指数変動の記述であり、「IPOが原因で相場が上がった・下がった」という因果関係や資金流出入は示していません。同時期の金融政策、決算、地政学要因、市場トレンドに注意してください。</p>';
}
function table(){
 const row=e=>{
  const data=eventData(e),ndx=data.NDX,spx=data.SPX,sox=data.SOX;
  return '<tr><td class="ipo-name"><button type="button" data-ipo="'+e.id+'" title="このイベントの詳細を見る">'+e.name+'</button><small>'+shortDate(e.date)+'</small></td>'+
  '<td>'+bfmt(e.bn)+'</td>'+
  '<td>'+pct(ndx?.prior20)+'</td><td>'+pct(ndx?.values[0])+'</td><td>'+pct(ndx?.values[5])+'</td>'+
  '<td>'+pct(ndx?.values[20])+'</td><td>'+pct(spx?.values[20])+'</td><td>'+pct(sox?.values[20])+'</td>'+
  '<td>'+pct(ndx?.values[60])+'</td><td>'+(e.type==="adr"?"ADR・参考":e.type==="announcement"?"大型報道・参考":"IPO")+'</td></tr>';
 };
 $("ipoTable").innerHTML=EVENTS.map(row).join("");
}
function render(){
 if(!archive)return;
 renderSelected();
 table();
 const all=EVENTS.filter(e=>e.type==="ipo");
 const with20=all.filter(e=>valid(snapshot(e,"NDX")?.values[20]));
 const win=with20.filter(e=>snapshot(e,"NDX").values[20]>0).length;
 const median=arr=>{const sorted=arr.slice().sort((a,b)=>a-b);if(!sorted.length)return null;return sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;};
 const med=median(with20.map(e=>snapshot(e,"NDX").values[20]));
 $("ipoSummary").innerHTML='<div><strong>'+with20.length+'</strong><span>分析可能な大型IPO件数</span></div>'+
 '<div><strong>'+pct(med)+'</strong><span>NDX 20日後中央値</span></div>'+
 '<div><strong>'+win+' / '+with20.length+'</strong><span>NDX 20日後プラス件数</span></div>'+
 '<div><strong>SpaceX</strong><span>2026年6月12日・最多調達額</span></div>';
 $("ipoStatus").textContent="株価指数データ最終更新："+(archive.updated_at||"—")+"（UTC）／報道日・上場日・調達額は公開資料に基づく。";
}
root.innerHTML='<div class="ipo-intro"><h2>巨大IPOの市場影響｜イベントスタディ</h2>'+
 '<p>大型IPOの報道・上場日前後に、NASDAQ100（NDX）・S&amp;P500（SPX）・半導体指数（SOX）がどう動いたかを比較。SpaceXは2025年12月9日の大型報道と2026年6月12日の上場日を別々に調査できます。</p>'+
 '<p class="ipo-caution">選択した基準日（SpaceX報道日または上場日）の前営業日終値を0%として、当日・後5・20・60取引日の累積騰落率を算出。基準日前20日リターンは「基準日の20取引日前→前営業日」の変化です。事前の値動きだけでインサイダー取引とは判断できません。</p></div>'+
 '<div id="ipoSummary" class="ipo-summary"></div>'+
 '<div class="ipo-toolbar"><label>比較するIPO<select id="ipoSelect"></select></label>'+
 '<label>表示期間<select id="ipoWindow"><option value="10">前10〜後10取引日</option><option value="20" selected>前20〜後20取引日</option><option value="60">前20〜後60取引日</option></select></label></div>'+
 '<div class="ipo-detail"><h3 id="ipoTitle">読み込み中...</h3><p id="ipoDescription"></p><p id="ipoSources"></p></div>'+
 '<div class="ipo-cards" id="ipoCards"></div>'+
 '<div class="ipo-chart-card"><div class="ipo-legend"><span><i style="background:#2563eb"></i>NDX</span><span><i style="background:#0d9488"></i>SPX</span><span><i style="background:#db6b35"></i>SOX</span><span>基準日前営業日＝0%</span></div>'+
 '<div class="ipo-chart" id="ipoChart">指数データを読み込み中...</div></div>'+
 '<section class="ipo-report" id="ipoReport"><h3>観測レポート</h3><p>指数データを読み込み中...</p></section>'+
 '<section class="ipo-compare"><h3>大型IPO別・市場変化一覧</h3><div class="ipo-scroll"><table><thead><tr>'+
 '<th>銘柄／基準日</th><th>調達額</th><th>NDX<br>基準日前20日</th><th>NDX<br>当日</th><th>NDX<br>後5日</th><th>NDX<br>後20日</th><th>SPX<br>後20日</th><th>SOX<br>後20日</th><th>NDX<br>後60日</th><th>分類</th>'+
 '</tr></thead><tbody id="ipoTable"></tbody></table></div></section>'+
 '<p id="ipoStatus" class="ipo-status">データの読み込み中...</p>'+
 '<div class="ipo-bottom-note"><strong>読み方と限界</strong>：対象は代表的な大型IPOであり無作為抽出ではありません。比較は市場指数の終値で、上場銘柄自身のリターンではありません。IPO規模は概ね追加割当前の名目公募額（十億ドル）で、インフレ補正なし。SpaceX最終調達額のみ別途記載。SpaceX報道時点の調達額は未確定のため「—」表示。報道イベントとADR上場は通常IPO平均から除外。先行・同時の経済指標や政策・企業決算による影響を分離していないため、IPOの株式供給による資金吸収や先行相場との因果を直接証明しません。指数の日次データはYahoo Finance非公式API経由。</div>';
$("ipoSelect").innerHTML=EVENTS.map(e=>'<option value="'+e.id+'">'+e.name+'（'+e.date+'）'+(e.type==="adr"?" ※ADR":e.type==="announcement"?" ※報道日":"")+'</option>').join("")+
 '<option value="average">大型IPOの単純平均（通常IPOのみ）</option>';
$("ipoSelect").value=selected;
$("ipoSelect").addEventListener("change",function(){selected=this.value;renderSelected();});
$("ipoWindow").addEventListener("change",function(){range=Number(this.value);renderSelected();});
$("ipoTable").addEventListener("click",function(e){const button=e.target.closest("button[data-ipo]");if(!button)return;selected=button.dataset.ipo;$("ipoSelect").value=selected;renderSelected();root.scrollIntoView({behavior:"smooth",block:"start"})});
fetch("./us-anomalies.json?ipo="+Date.now(),{cache:"no-store"})
 .then(r=>{if(!r.ok)throw Error("HTTP "+r.status);return r.json()})
 .then(d=>{if(!d.series||KEYS.some(k=>!d.series[k]))throw Error("必要な3指数データがありません");archive=d;render()})
 .catch(e=>{$("ipoStatus").textContent="市場データの取得に失敗："+String(e.message||e);$("ipoChart").textContent="指数データを読み込めません。";$("ipoReport").textContent="公開済みのus-anomalies.jsonを確認してください。"});
})();
