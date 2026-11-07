/* Sector subtab: industry strength proxy, not measured fund inflows. */
(function(root){
"use strict";
const PERIODS={"1":"change_1d","3":"return_3d","10":"return_10d","20":"return_20d","25":"return_25d","60":"return_60d"};
function num(n){return typeof n==="number"&&Number.isFinite(n);}
function avg(a){return a.length?a.reduce((sum,n)=>sum+n,0)/a.length:null;}
function percent(n,d){return d?100*n/d:null;}
function summarize(stocks,period){
 const key=PERIODS[String(period)]||PERIODS["1"];
 const entries=(Array.isArray(stocks)?stocks:[]).filter(r=>r&&r.ticker);
 const dated=entries.map(r=>r.asof).filter(x=>typeof x==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(x));
 const date=dated.length?dated.sort().at(-1):null;
 const groups=new Map();
 for(const stock of entries){
  const industry=String(stock.industry_name||"").trim();
  if(!industry)continue;
  const sector=String(stock.sector_name||stock.sector||"").trim();
  const id=sector+"\u0001"+industry;
  if(!groups.has(id))groups.set(id,{name:industry,sector,universe:0,sample:0,periodCount:0,
   avgReturn:null,upRate:null,buyRate:null,avgRvol:null,leaders:[],source:String(stock.industry_source||"")});
  const g=groups.get(id);
  g.universe++;
  if(stock.asof!==date)continue;
  g.sample++;
  if(!g.members)g.members=[];
  g.members.push(stock);
 }
 for(const g of groups.values()){
  const current=g.members||[];
  const periodRows=current.filter(r=>num(r[key]));
  const dayRows=current.filter(r=>num(r.change_1d));
  const moneyRows=current.filter(r=>num(r.change_1d)&&num(r.rvol20));
  const vols=current.map(r=>r.rvol20).filter(num);
  g.periodCount=periodRows.length;
  g.avgReturn=avg(periodRows.map(r=>r[key]));
  g.upRate=percent(dayRows.filter(r=>r.change_1d>0).length,dayRows.length);
  g.buyRate=percent(moneyRows.filter(r=>r.change_1d>0&&r.rvol20>1).length,moneyRows.length);
  g.avgRvol=avg(vols);
  g.leaders=periodRows.slice().sort((a,b)=>b[key]-a[key]||String(a.ticker).localeCompare(String(b.ticker)))
   .slice(0,3).map(r=>({ticker:r.ticker,name:r.name||r.ticker,value:r[key]}));
  delete g.members;
 }
 return {date,universe:entries.length,datedCount:entries.filter(r=>r.asof===date).length,
  classifiedCount:entries.filter(r=>String(r.industry_name||"").trim()).length,
  groups:[...groups.values()]};
}
root.IndustryAnalysisCore={summarize,PERIODS};
if(typeof document==="undefined")return;
const panel=document.getElementById("industry-analysis-panel");
if(!panel)return;
const market=document.body.dataset.leaderMarket||(location.pathname.includes("jp-sectors")?"jp":"us");
const h=v=>String(v===null||v===undefined?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=(v,unit,dec=2)=>num(v)?(v>0?"+":"")+v.toFixed(dec)+(unit||""):"—";
const cl=v=>num(v)?v>0?"ia-pos":v<0?"ia-neg":"":"ia-muted";
const industryLabel=name=>market==="us"&&root.StockIndustryJA?root.StockIndustryJA.display(name):name;
panel.innerHTML='<h2>業種分析｜'+(market==="jp"?"日本株（JPX 33業種）":"米国株（GICS / Nasdaq Industry）")+'</h2>'+
 '<p class="ia-description">業種ごとの株価の強さ、値上がり銘柄比率、上昇と出来高増加が重なる銘柄の割合を比較します。純資金流入額ではなく、買いの集中を探す参考指標です。</p>'+
 '<div class="ia-controls">'+
 '<label>騰落率の期間<select data-filter="period"><option value="1">1取引日</option><option value="3">3取引日</option><option value="10">10取引日</option><option value="20">20取引日</option><option value="25">25取引日</option><option value="60">60取引日</option></select></label>'+
 '<label>セクター<select data-filter="sector"><option value="">全セクター</option></select></label>'+
 '<label>業種<select data-filter="industry"><option value="">全業種</option></select></label>'+
 '<label>並び順<select data-filter="sort"><option value="return">平均騰落率の高い順</option><option value="buy">買い優勢率の高い順</option><option value="up">値上がり比率の高い順</option><option value="volume">平均出来高倍率の高い順</option><option value="size">対象銘柄数の多い順</option></select></label>'+
 '<label>最小サンプル<select data-filter="min"><option value="1">1銘柄以上</option><option value="3">3銘柄以上</option><option value="5">5銘柄以上</option><option value="10">10銘柄以上</option></select></label>'+
 '<label>業種名を検索<input data-filter="search" type="search" placeholder="業種名を入力"></label></div>'+
 '<p id="ia-status" class="ia-status" role="status">業種別データを読み込み中...</p>'+
 '<div class="ia-scroll"><table class="ia-table"><thead><tr>'+
 '<th>順位</th><th>セクター</th><th>業種</th><th>当日集計 / 登録銘柄</th><th>期間平均騰落率</th>'+
 '<th>値上がり比率<br>（当日）</th><th>買い優勢率<br>（当日）</th><th>平均出来高倍率</th><th>期間上位銘柄</th>'+
 '</tr></thead><tbody id="ia-body"><tr><td colspan="9">読み込み中...</td></tr></tbody></table></div>'+
 '<p class="ia-notes">買い優勢率＝当日上昇かつ出来高が前20取引日平均を上回る銘柄の割合（両指標が取得できた銘柄が分母）。業種平均騰落率は等ウェイトの単純平均。市場全体の売買代金の純流入・純流出を直接測ったものではありません。直近同一取引日の株価取得済み銘柄だけを集計し、全上場銘柄を網羅した値ではありません。少数サンプルは偏りが大きくなります。'+
 (market==="jp"?"分類元はJPX月次銘柄一覧の33業種。":"S&P500はGICS Sub-Industry、その他はNasdaq Industryで、分類体系は統一されていません。業種名は日本語の表示名で、元の英語名称はツールチップに保持します。")+'</p>';
let data=null,summaryCache=null;
const controls=Object.fromEntries(["period","sector","industry","sort","min","search"].map(x=>[x,panel.querySelector('[data-filter="'+x+'"]')]));
const status=panel.querySelector("#ia-status"),tbody=panel.querySelector("#ia-body");
const columnFilters=root.createIndustryColumnFilters?
 root.createIndustryColumnFilters({
  panel,
  getRows:()=>summaryCache?summaryCache.groups:[],
  displayIndustry:industryLabel,
  escapeHtml:h,
  onChange:()=>render()
 }):null;
function render(){
 if(!data)return;
 const summary=summarize(data[market]||[],controls.period.value);
 summaryCache=summary;
 const sectors=[...new Set(summary.groups.map(g=>g.sector).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"ja"));
 const old=controls.sector.value;
 controls.sector.innerHTML='<option value="">全セクター</option>'+sectors.map(x=>'<option value="'+h(x)+'">'+h(x)+'</option>').join("");
 controls.sector.value=sectors.includes(old)?old:"";
 const industryGroups=summary.groups.filter(g=>!controls.sector.value||g.sector===controls.sector.value);
 const oldIndustry=controls.industry.value;
 const industryOptions=industryGroups.map(g=>({
  value:g.sector+"::"+g.name,
  label:industryLabel(g.name),sector:g.sector
 })).sort((a,b)=>a.label.localeCompare(b.label,"ja")||a.sector.localeCompare(b.sector,"ja"));
 const labelCounts=new Map();
 for(const item of industryOptions)labelCounts.set(item.label,(labelCounts.get(item.label)||0)+1);
 controls.industry.innerHTML='<option value="">全業種</option>'+industryOptions.map(item=>
  '<option value="'+h(item.value)+'">'+h(item.label+(labelCounts.get(item.label)>1?'（'+item.sector+'）':''))+'</option>').join("");
 controls.industry.value=industryOptions.some(item=>item.value===oldIndustry)?oldIndustry:"";
 const matchName=controls.search.value.trim().toLocaleLowerCase(),min=Number(controls.min.value);
 const groups=summary.groups.filter(g=>g.sample>=min&&
  (!controls.sector.value||g.sector===controls.sector.value)&&
  (!controls.industry.value||g.sector+"::"+g.name===controls.industry.value)&&
  (!matchName||(g.name+" "+industryLabel(g.name)).toLocaleLowerCase().includes(matchName)));
 const prop={return:"avgReturn",buy:"buyRate",up:"upRate",volume:"avgRvol",size:"sample"}[controls.sort.value]||"avgReturn";
 groups.sort((a,b)=>{
  const av=a[prop],bv=b[prop];
  if(!num(av))return num(bv)?1:a.name.localeCompare(b.name,"ja");
  if(!num(bv))return -1;
  return bv-av||a.name.localeCompare(b.name,"ja");
 });
 groups.forEach((g,i)=>{g.rank=i+1;});
 const visible=columnFilters?columnFilters.apply(groups):groups;
 status.textContent='基準日 '+(summary.date||"未取得")+' ｜ 対象 '+summary.universe+'銘柄 ｜ 業種分類済み '+summary.classifiedCount+
  '銘柄 ｜ 同一日付で株価取得済み '+summary.datedCount+'銘柄 ｜ 表示 '+visible.length+'/'+summary.groups.length+'業種'+
 (columnFilters&&columnFilters.activeCount()?'（列フィルター '+columnFilters.activeCount()+'条件）':'');
 tbody.innerHTML=visible.length?visible.map((g,i)=>{
  const leads=g.leaders.map(r=>'<a target="_blank" rel="noopener noreferrer" href="https://finance.yahoo.com/quote/'+encodeURIComponent(r.ticker)+'" title="'+h(r.name)+'">'+h(r.ticker)+'</a> <span class="'+cl(r.value)+'">'+fmt(r.value,"%")+'</span>').join(' / ')||'—';
  return '<tr><td>'+(i+1)+'</td><td class="ia-sector">'+h(g.sector)+'</td>'+
   '<td class="ia-industry" title="'+h(g.name+" ｜ "+g.source)+'">'+h(industryLabel(g.name))+'</td>'+
   '<td>'+g.sample+' / '+g.universe+'</td>'+
   '<td class="'+cl(g.avgReturn)+'">'+fmt(g.avgReturn,"%")+' <small>('+g.periodCount+'件)</small></td>'+
   '<td>'+fmt(g.upRate,"%")+'</td>'+
   '<td>'+fmt(g.buyRate,"%")+'</td>'+
   '<td>'+fmt(g.avgRvol,"倍",2)+'</td>'+
   '<td class="ia-leaders">'+leads+'</td></tr>';
 }).join(""):'<tr><td colspan="9">該当する業種がありません。銘柄の業種分類・取得日、またはフィルター条件を確認してください。</td></tr>';
}
panel.addEventListener("change",e=>{
 if(!e.target.closest("[data-filter]"))return;
 if(e.target===controls.sort&&columnFilters)columnFilters.clearSort();
 render();
});
controls.search.addEventListener("input",render);
fetch("./sector-leaders.json?t="+Date.now(),{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("HTTP "+r.status);return r.json();})
.then(json=>{data=json;render();})
.catch(e=>{status.textContent="データ読み込み失敗: "+String(e.message||e);tbody.innerHTML='<tr><td colspan="9">再読み込みしてください</td></tr>';});
})(typeof window!=="undefined"?window:globalThis);