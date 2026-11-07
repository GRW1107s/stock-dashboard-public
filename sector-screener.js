/* Sector leader screener with automated financial data and optional private EPS overlay. */
(function(){
"use strict";
const panel=document.getElementById("leader-screener-panel");
if(!panel)return;
const market=document.body.dataset.leaderMarket || (location.pathname.includes("jp-sectors")?"jp":"us");
const label=market==="jp"?"日本株":"米国株";
const H=function(s){return String(s===null||s===undefined?"":s).replace(/[&<>"']/g,function(ch){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]})};
const finite=function(n){return typeof n==="number"&&Number.isFinite(n)};
const fmt=function(n,suffix,dec){return finite(n)?(n>0?"+":"")+n.toFixed(dec===undefined?1:dec)+(suffix||""):"—"};
const plain=function(n,suffix,dec){return finite(n)?n.toFixed(dec===undefined?1:dec)+(suffix||""):"—"};
const inputVal=function(id){return document.getElementById(id).value};
const numeric=function(v){if(v===null||v===undefined||String(v).trim()==="")return null;const n=Number(v);return Number.isFinite(n)?n:null};
let base=[],history=null,marketData=null,updatedAt=null,currentPage=0,universeMeta=null;
let usdJpy=null,usdJpyAsOf=null;
const privateEps=new Map();
function industryLabel(r){
 const original=String(r.industry_name||"");
 return market==="us"&&window.StockIndustryJA?window.StockIndustryJA.display(original):original;
}
const PAGE_SIZE=100;
const totalColumns=market==="us"?19:22;
let consistentSectorLeaders=new Set(),consistentSectorLaggards=new Set();
panel.innerHTML=
'<div class="ls-intro"><h2>セクター別 リーダー銘柄スクリーニング（試作版）</h2>'+
'<p>'+(market==="jp"?"JPXの東証プライム・スタンダード・グロース上場内国普通株式を対象にしています。上場銘柄一覧は月次更新、価格・出来高は負荷を分散して順次収集します。":"S&P500構成銘柄＋米国上場主要株・ADRを約1,800銘柄まで段階的に収録します。初期の監視銘柄も維持します。価格・出来高は日次バッチで順次取得します（全上場銘柄は網羅しません）。moomoo APIから企業名・時価総額・PER・直近年度EPSを一括取得し、EPS成長率・ROEは順次更新します。移動平均線・RS指数・ベータ等の履歴由来指標は既存の株価フィードを継続します。")+'価格面の候補とCAN-SLIM確認済みを混同せず、業績・機関保有は未確認のまま扱います。</p>'+
'<p class="ls-method">N：52週終値高値から15%以内 ／ S：上昇日かつ出来高が前20日平均の1.3倍以上 ／ L：RS指数レーティング80以上かつセクターETFを60日で上回る。C：直近EPS成長25%以上＋売上20%以上、A：3年EPS年平均成長20%以上、I：機関保有増加。Mは市場概況で別途判断。</p></div>'+
'<div class="ls-market" id="ls-market">M：市場全体の地合いは <a href="./index.html">市場概況</a> で確認。DD・FTDはIBD公式判定ではありません。</div>'+
'<fieldset class="ls-sector-fieldset"><legend>対象セクター（複数選択可）</legend><div class="ls-sector-toolbar">'+
'<button type="button" id="ls-sector-all">すべて選択</button><button type="button" id="ls-sector-none">すべて解除</button><span id="ls-sector-count" aria-live="polite">セクターを読み込み中...</span></div>'+
'<div class="ls-sector-options" id="ls-sector" role="group" aria-label="対象セクター"></div><p class="ls-sector-legend"><span><span class="ls-sector-leader-marker" aria-hidden="true"></span>上位3分の1を維持</span><span><span class="ls-sector-laggard-marker" aria-hidden="true"></span>下位3分の1を維持</span><span>※直近3・10・25取引日すべて</span></p></fieldset>'+

'<div class="ls-guidance-tiles" aria-label="EPS・ROEのスクリーニング参考基準">'+
'<div class="ls-guidance-tile ls-guidance-eps">年間のEPSの増加率が25～50％以上の銘柄を選ぶ<span>（大化け銘柄の株式の初期上昇段階における平均の年間EPSの増加は36％であった）</span></div>'+
'<div class="ls-guidance-tile ls-guidance-roe">過去50年で急成長を遂げたほぼ全銘柄が、最低でも17％のROEを示していた</div>'+
'<div class="ls-guidance-tile ls-guidance-slowdown">過去３年間のEPSの増加率が30％というすばらしい記録を持つ企業でも、直近の数四半期のEPSの増加率が10～15％ほどに減速している銘柄は、完全に成長が止まったバリュー株だと言える</div>'+
'<div class="ls-guidance-tile ls-guidance-industry-leader">業界内で上位２～３銘柄を狙う<span>上位企業は規模が最大であるとか、だれもが知っているブランドという意味ではない。最高の四半期EPS増加率、年間EPS増加を示し、ROEも最大で、利益率や売上増加率もずば抜けていて、株価の動きも活発な企業のことである</span></div>'+
'</div>'+
'<p class="ls-stat" id="ls-stat">データを読み込んでいます...</p>'+
'<div class="ls-table-wrap"><table class="ls-table"><thead><tr>'+
'<th>セクター</th>'+
'<th class="ls-industry-heading" title="'+(market==="us"?"S&P500はGICS Sub-Industry、それ以外はNasdaq Industryです。":"JPXの33業種分類を使用します。")+'">業種</th>'+
'<th class="ls-name-heading">候補銘柄</th><th title="時価総額は円換算。米国株はスナップショットの米ドル値に取得日付きのUSD/JPYレートを乗じた概算です。日本株はJPY建てデータのみ表示。">時価総額<br>（円）</th>'+(market==="jp"?'<th title="時価総額による規模分類。超大型＝1兆円以上、大型＝3,000億円以上1兆円未満、中型＝500億円以上3,000億円未満、小型＝100億円以上500億円未満、超小型＝100億円未満">規模</th><th title="JPXが日々公表する空売り残高報告（発行済株式数の0.5%以上を保有する報告者の合計）。発行済株式数に対する割合">大口空売り<br>残高</th><th title="大口空売り残高割合の前公表日からの増減（％ポイント）">空売り<br>増減</th><th title="信用取引の売残高の前日比増減率（JPX銘柄別信用取引残高表）">売残<br>増減率</th><th title="信用取引の買残高の前日比増減率（JPX銘柄別信用取引残高表）">買残<br>増減率</th><th title="信用倍率＝買残高÷売残高（JPX銘柄別信用取引残高表）">信用<br>倍率</th>':'')+'<th title="取得済み銘柄だけのIBD方式参考RS（1〜99）。99は全上場株の99%超えを保証しません">RS指数<br>1〜99</th>'+
'<th title="直近最大252取引日の日次株価騰落率で計算した市場ベータ。最低120日以上の比較対象が必要。米国株はS&amp;P500、日本株はTOPIX連動ETF（1306）。">ベータ値</th>'+
'<th title="直近最大252取引日の株価騰落率を年率換算したシャープレシオ。無リスク金利0%、最低120日。配当は含みません。">シャープレシオ</th>'+
(market==="us"?'<th title="63/126/189/252営業日の加重騰落率から、S&P500指数（^GSPC）の同期間の加重騰落率を引いた値。+ならS&P500より強い">S&amp;P500比<br>加重pp</th>':'')+
'<th>セクター内<br>60日順位</th>'+
'<th>60日騰落率</th><th>同ETF比<br>60日</th><th>52週高値<br>からの下落</th>'+

(market==="us"?'<th class="ls-ma-col" title="終値が50日単純移動平均より上なら○、下または同値なら✕。未算出は—。">50MA</th><th class="ls-ma-col" title="終値が200日単純移動平均より上なら○、下または同値なら✕。未算出は—。">200MA</th>':'')+
'<th>出来高<br>対20日平均</th>'+
'<th title="最新の発表済み四半期EPSの前年同期比増加率。公表済みの自動取得値または確認済みの手入力値を表示。">EPS増加率<br>直近四半期</th>'+
'<th title="最新から1つ前の四半期EPSの前年同期比増加率。公表済みの自動取得値または確認済みの手入力値を表示。">EPS増加率<br>1四半期前</th>'+
'<th title="過去3年間の年間EPS平均成長率（CAGR）。取得可能な年間EPSの3年CAGR。取得元の自動算出値または確認済みの手入力から表示。">年間EPS増加率<br>3年CAGR</th>'+
'<th title="最新の通期ROE。原則として親会社帰属年間純利益÷期首期末平均自己資本×100。取得できなければ—。">ROE<br>（%）</th>'+
'</tr></thead><tbody id="ls-body"><tr><td colspan="'+totalColumns+'">データを読み込んでいます...</td></tr></tbody></table></div>'+
'<div class="ls-pagination"><button type="button" id="ls-prev" disabled>前の100件</button><span id="ls-page-label" aria-live="polite"></span><button type="button" id="ls-next" disabled>次の100件</button></div>'+
'<p class="ls-foot">EPS増加率の直近2四半期は各四半期の前年同期比（YoY）で、直前四半期比（QoQ）ではありません。年間EPS増加率は過去3年のCAGRです。米国株のEPS成長率はyfinance由来の四半期・年間データから取得可能な範囲で段階的に自動算出します。生のEPS数値は表示せず、算出した成長率だけを掲載します。Yahoo Financeには個人利用・再配布に関する制限があり、公開掲載の許諾を保証するものではありません。取得できない数値は「—」です。日本株EPSもyfinanceの取得可能な四半期・年間データから段階的に自動算出します。未取得銘柄は「—」で表示します。時価総額は円表示です。米国株はNasdaq系のUSD建てスナップショットを取得日付きのUSD/JPYレートで換算する概算値です。日本株はJPY建ての取得可能な時価総額を段階的に表示します。為替や株価の時点が一致するとは限りません。ROEは直近通期の親会社帰属純利益／期首期末平均自己資本を基本とし、財務データがなければ「—」です。<br>指標の注意：ベータ値は市場との日次リターン共分散から計算し、シャープレシオは日次リターンの平均÷標準偏差×√252で算出します（無リスク金利0%、株価変動ベース、配当除外）。取得可能な直近最大252日・最低120日を使用し、日本株の比較市場は1306.T（TOPIX連動ETF）、米国株は^GSPC（S&P500）です。<br>RS指数（1〜99）は63・126・189・252営業日の騰落率を40%・20%・20%・20%で加重し、直近の株価取得済み銘柄の中で順位化するIBD参考方式です。公式IBD RS Ratingではなく、取得対象が全上場株を網羅していないため「99＝米国株全体の99%を上回る」とはまだ言えません。米国株の「S&amp;P500比」は同じ加重騰落率の差（％ポイント）です。セクター内順位も株価取得済み銘柄内だけです。高値は直近最大252取引日の終値を使用。ETFとの比較は約60取引日の参考値です。新製品・経営陣・ベース形成・投資家保有の質・市場トレンドの確認を省略して「合格」とはしません。</p>';
const get=function(id){return document.getElementById(id)};
// Use the same daily price-return ranking and completeness requirements as the observation tab.
function calculateConsistentSectorBands(data){
 const sectors=Object.keys(data?.names||{});
 const rows=Array.isArray(data?.rows)?data.rows.slice().sort((a,b)=>b.date.localeCompare(a.date)):[];
 const empty=()=>({leaders:new Set(),laggards:new Set()});
 if(!sectors.length)return empty();
 const ranks=[3,10,25].map(period=>{
  const recent=rows.slice(0,period);
  if(recent.length!==period)return [];
  return sectors.map(key=>{
   const changes=recent.map(day=>day.sectors?.[key]?.change);
   if(changes.some(value=>!finite(value)||value<=-100))return null;
   const value=(changes.reduce((p,change)=>p*(1+change/100),1)-1)*100;
   return {key,ret:value};
  }).filter(Boolean).sort((a,b)=>b.ret-a.ret||a.key.localeCompare(b.key));
 });
 if(ranks.some(rank=>rank.length!==sectors.length))return empty();
 const cutoff=Math.ceil(sectors.length/3);
 function intersection(group){
  const second=new Set(group(ranks[1]).map(item=>item.key));
  const third=new Set(group(ranks[2]).map(item=>item.key));
  return new Set(group(ranks[0]).map(item=>item.key).filter(key=>second.has(key)&&third.has(key)));
 }
 return {
  leaders:intersection(rank=>rank.slice(0,cutoff)),
  laggards:intersection(rank=>rank.slice(-cutoff))
 };
}
function sectorMarker(sector){
 if(consistentSectorLeaders.has(sector))
  return '<span class="ls-sector-leader-marker" role="img" aria-label="3・10・25取引日すべてで上位3分の1" title="3・10・25取引日すべてで上位3分の1"></span>';
 if(consistentSectorLaggards.has(sector))
  return '<span class="ls-sector-laggard-marker" role="img" aria-label="3・10・25取引日すべてで下位3分の1" title="3・10・25取引日すべてで下位3分の1"></span>';
 return '';
}
function marketSectorReturn(ticker){
 if(!history||!Array.isArray(history.rows))return null;
 const changes=history.rows.slice(0,60).map(function(item){return item.sectors&&item.sectors[ticker]&&item.sectors[ticker].change});
 if(changes.length!==60||changes.some(function(v){return !finite(v)}))return null;
 return (changes.reduce(function(pct,m){return pct*(1+m/100)},1)-1)*100;
}
function relative(r){const s=marketSectorReturn(r.sector);return finite(s)&&finite(r.return_60d)?r.return_60d-s:null}
function epsValue(r,key){
 const autoKey={eps:"eps_q_latest_yoy_pct",previous_eps:"eps_q_prev_yoy_pct",annual:"eps_annual_3y_cagr_pct"}[key];
 const local=privateEps.get(r.ticker);
 if(local&&finite(local[autoKey]))return local[autoKey];
 return finite(r[autoKey])?r[autoKey]:null;
}
function epsProvenance(r,key){
 const end={eps:"eps_q_latest_end",previous_eps:"eps_q_prev_end",annual:"eps_annual_end"}[key];
 const local=privateEps.get(r.ticker);
 const autoKey={eps:"eps_q_latest_yoy_pct",previous_eps:"eps_q_prev_yoy_pct",annual:"eps_annual_3y_cagr_pct"}[key];
 if(local&&finite(local[autoKey]))return "個人用SimFin（ローカル読込）｜決算期末 "+String(local[end]||"未確認")+"｜生成日 "+String(local.eps_fetched_at||"未確認");
 if(epsValue(r,key)!==null && (r[autoKey+"_source"]||r.eps_source)){
  return String(r[autoKey+"_source"]||r.eps_source)+"｜決算期末 "+String(r[end]||"未確認")+
   "｜取得日 "+String(r[autoKey+"_fetched_at"]||r.eps_fetched_at||"未確認");
 }
 return "未取得・計算不能";
}
function roeValue(r){return finite(r.roe_pct)?r.roe_pct:null}
function roeProvenance(r){
 if(!finite(r.roe_pct))return "ROE未取得";
 return String(r.roe_source||"決算書由来")+
  "｜対象期末 "+String(r.roe_period_end||"未確認")+
  "｜取得日 "+String(r.roe_fetched_at||r.eps_fetched_at||"未確認");
}
function marketCapJPY(r){
 const cap=finite(r.market_cap)&&r.market_cap>0?r.market_cap:null;
 if(cap===null||!r.market_cap_asof)return null;
 if(r.market_cap_currency==="JPY")return cap;
 if(r.market_cap_currency==="USD"&&finite(usdJpy)&&usdJpy>0)return cap*usdJpy;
 return null;
}
function capCell(r){
 const cap=marketCapJPY(r);
 if(cap===null)return "—";
 return cap>=1e12?(cap/1e12).toFixed(2)+"兆円":
  (cap/1e8).toLocaleString("ja-JP",{maximumFractionDigits:cap<1e9?1:0})+"億円";
}
function capTooltip(r){
 if(!r.market_cap_asof)return "時価総額は未取得";
 const fx=r.market_cap_currency==="USD"?
  (finite(usdJpy)?"｜USD/JPY "+usdJpy+"（為替基準日 "+String(usdJpyAsOf||"未確認")+"）":"｜USD/JPYのレート未取得のため換算不能"):"";
 return String(r.market_cap_source||"発行済株式数×株価")+
  "｜時価総額スナップショット "+String(r.market_cap_asof)+fx+
  "｜推計・時点差がありリアルタイム時価総額ではありません";
}
function isLeader(r){
 return finite(r.rs_universe_pct)&&r.rs_universe_pct>=80&&finite(r.high52_distance_pct)&&r.high52_distance_pct<=15&&finite(relative(r))&&relative(r)>0;
}
const colFilters=window.createLeaderColumnFilters?window.createLeaderColumnFilters({
 panel,market,get,H,numeric,finite,relative,epsValue,roeValue,onChange:filterChanged,getRows:()=>base,marketCapJPY
}):null;
function selectedSectors(){return new Set(Array.from(get("ls-sector").querySelectorAll('input[type="checkbox"]:checked'),function(item){return item.value}))}
function values(){
 const sectors=selectedSectors(),search="";
 const rs=0,high=100,roeChoice="",roeMin=null,order="rs";
 const marketType="";
 let items=base.filter(function(r){
  if(!sectors.has(r.sector))return false;
  if(marketType&&r.market!==marketType)return false;
  if(search&&!((r.name+" "+r.ticker+" "+r.sector_name+" "+(r.industry_name||"")+" "+industryLabel(r)).toLowerCase().includes(search)))return false;
  if(rs>0&&(!finite(r.rs_universe_pct)||r.rs_universe_pct<rs))return false;
  if(high<100&&(!finite(r.high52_distance_pct)||r.high52_distance_pct>high))return false;
  if(roeChoice==="missing"){if(roeValue(r)!==null)return false;}
  else if(roeMin!==null&&(!finite(roeValue(r))||roeValue(r)<roeMin))return false;
  if(colFilters&&!colFilters.matches(r))return false;
  return true;
 });
 const nullLast=function(x){return finite(x)?x:Number.NEGATIVE_INFINITY};
 items.sort(function(a,b){
  if(order==="sector")return a.sector.localeCompare(b.sector)||nullLast(b.return_60d)-nullLast(a.return_60d);
  if(order==="return60")return nullLast(b.return_60d)-nullLast(a.return_60d);
  if(order==="cap")return nullLast(marketCapJPY(b))-nullLast(marketCapJPY(a));
  if(order==="volume")return nullLast(b.rvol20)-nullLast(a.rvol20);
  if(order==="distance")return (finite(a.high52_distance_pct)?a.high52_distance_pct:999)-(finite(b.high52_distance_pct)?b.high52_distance_pct:999);
  return nullLast(b.rs_universe_pct)-nullLast(a.rs_universe_pct)||nullLast(b.return_60d)-nullLast(a.return_60d);
 });
 if(colFilters&&colFilters.sortActive())items.sort(colFilters.compare);
 return items;
}
function cellStrong(n,suffix){return '<span class="'+(finite(n)?n>=0?"ls-positive":"ls-negative":"ls-muted")+'">'+H(fmt(n,suffix,1))+'</span>'}
function flowCell(n,suffix){if(!finite(n))return '<span class="ls-muted">—</span>';const c=n>0?"#dc2626":n<0?"#2563eb":"inherit";return '<span style="color:'+c+'">'+(n>0?"+":"")+n.toFixed(2)+suffix+'</span>'}
function sizeFromCap(r){
 const cap=marketCapJPY(r);
 if(!finite(cap))return "—";
 return cap>=1e12?"超大型":cap>=3e11?"大型":cap>=5e10?"中型":cap>=1e10?"小型":"超小型";
}
function shortCells(r){
 const title=finite(r.short_shares)?"大口空売り残高 "+Number(r.short_shares).toLocaleString("ja-JP")+"株｜報告者 "+(r.short_reporters??"—")+"件｜計算日 "+(r.short_asof||"—")+"（JPX公表）":"大口の空売り残高報告なし（0.5%以上の報告者なし、または未公表）";
 return '<td title="'+H(title)+'">'+H(plain(r.short_ratio,"%",2))+'</td><td>'+flowCell(r.short_d_ratio,"pt")+'</td>';
}
function marginCells(r){
 const title=(finite(r.margin_sell)||finite(r.margin_buy))?"売残 "+(finite(r.margin_sell)?Number(r.margin_sell).toLocaleString("ja-JP")+"株":"—")+"｜買残 "+(finite(r.margin_buy)?Number(r.margin_buy).toLocaleString("ja-JP")+"株":"—")+"｜基準日 "+(r.margin_asof||"—")+"（JPX銘柄別信用取引残高表）":"信用取引残高データなし";
 return '<td title="'+H(title)+'">'+flowCell(r.margin_sell_pct,"%")+'</td><td title="'+H(title)+'">'+flowCell(r.margin_buy_pct,"%")+'</td><td title="'+H(title)+'">'+H(plain(r.margin_ratio,"",2))+'</td>';
}
function maCell(r,period){
 const position=r["ma"+period+"_position"],value=r["ma"+period];
 const label=position==="above"?"○":position==="below"||position==="equal"?"✕":"—";
 const className=position==="above"?"ls-positive":position==="below"||position==="equal"?"ls-negative":"ls-muted";
 const detail=finite(value)&&finite(r.close)?
  "終値 "+r.close+" ／ "+period+"MA "+value+" ｜ "+(r.asof||"取得日不明")+
  "（最新"+period+"取引日の終値単純平均）":period+"MA未算出（株価データの再取得待ち、または履歴不足）";
 return '<td class="ls-ma-col" title="'+H(detail)+'"><span class="ls-ma-status '+className+'">'+label+'</span></td>';
}
function riskDetails(r,kind){
 const count=kind==="beta"?r.beta_samples:r.sharpe_samples;
 const bench=r.risk_benchmark==="1306.T"?"TOPIX連動ETF 1306.T":r.risk_benchmark==="^GSPC"?"S&P500指数 ^GSPC":"比較指数未取得";
 return (kind==="beta"?"ベータ値（比較："+bench+"）":"シャープレシオ（無リスク金利0%、配当を含まない）")+
  "｜直近最大252取引日、最低120日｜有効観測数 "+
  (Number.isInteger(count)?count:"未取得")+
  "｜株価基準日 "+String(r.asof||"未取得");
}
function tradingViewSymbol(r){
 const ticker=String(r.ticker||"").trim().toUpperCase();
 if(market==="jp")return "TSE:"+ticker.replace(/\.T$/,"");
 // Yahoo class-share symbols use "-" where TradingView uses "." (e.g. BRK-B).
 const usTicker=ticker.replace(/-([A-Z])$/,".$1");
 const exchanges={NMS:"NASDAQ",NGM:"NASDAQ",NCM:"NASDAQ",NASDAQ:"NASDAQ",NYQ:"NYSE",NYSE:"NYSE",ASE:"AMEX",AMEX:"AMEX"};
 const rawExchange=String(r.exchange||r.fullExchangeName||"").toUpperCase();
 const exchange=exchanges[rawExchange]||"";
 // When the listing venue is absent, do not guess NASDAQ vs NYSE.
 return exchange?exchange+":"+usTicker:usTicker;
}
function tradingViewUrl(r){return "https://jp.tradingview.com/chart/?symbol="+encodeURIComponent(tradingViewSymbol(r));}
function rowHtml(r){
 const rs=finite(r.rs_universe_pct)?String(r.rs_universe_pct):"—", v=relative(r);
 const epsLatest=epsValue(r,"eps"),epsPrevious=epsValue(r,"previous_eps");
 const annualEpsCagr=epsValue(r,"annual"),roe=roeValue(r);
 const mmQuote=market==="us"&&finite(r.moomoo_close)&&r.moomoo_quote_asof?" ｜ moomoo $"+r.moomoo_close.toFixed(2)+" ("+r.moomoo_quote_asof+")":"";
 return '<tr><td class="ls-sector-name">'+sectorMarker(r.sector)+H(r.sector_name)+'</td>'+
 '<td class="ls-industry-name" title="'+H([r.industry_name,r.industry_source].filter(Boolean).join(" ｜ ")||"業種データ未取得")+'">'+H(industryLabel(r)||'—')+'</td>'+
 '<td class="ls-name"><a target="_blank" rel="noopener noreferrer" href="'+H(tradingViewUrl(r))+'" title="TradingViewでチャートを開く">'+H(r.name)+'</a><small>'+H(r.ticker)+(r.market?' ｜ '+H(r.market):'')+(r.asof?' ｜ '+H(r.asof):' ｜ 履歴未取得')+H(mmQuote)+'</small></td>'+
 '<td title="'+H(capTooltip(r))+'">'+H(capCell(r))+'</td>'+
 (market==="jp"?'<td>'+H(sizeFromCap(r))+'</td>'+shortCells(r)+marginCells(r):'')+
 '<td><strong>'+rs+'</strong></td>'+
 '<td title="'+H(riskDetails(r,"beta"))+'">'+H(plain(r.beta_252d,"",2))+'</td>'+
 '<td title="'+H(riskDetails(r,"sharpe"))+'">'+H(plain(r.sharpe_252d,"",2))+'</td>'+
 (market==="us"?'<td title="S&P500指数（^GSPC）に対する加重騰落率の差">'+cellStrong(r.rs_sp500_delta_pp,"pp")+'</td>':'')+
 '<td>'+H(r.sector_rank||"—")+(r.sector_count?'/'+H(r.sector_count):"")+'</td>'+
 '<td>'+cellStrong(r.return_60d,"%")+'</td><td>'+cellStrong(v,"pp")+'</td>'+
 '<td>'+H(plain(r.high52_distance_pct,"%"))+'</td>'+(market==="us"?maCell(r,50)+maCell(r,200):"")+'<td>'+H(plain(r.rvol20,"倍",2))+'</td>'+
 '<td title="'+H(epsProvenance(r,"eps"))+'">'+cellStrong(epsLatest,"%")+'</td>'+
 '<td title="'+H(epsProvenance(r,"previous_eps"))+'">'+cellStrong(epsPrevious,"%")+'</td>'+
 '<td title="'+H(epsProvenance(r,"annual"))+'">'+cellStrong(annualEpsCagr,"%")+'</td>'+
 '<td title="'+H(roeProvenance(r))+'">'+cellStrong(roe,"%")+'</td>'+
 '</tr>';
}
function render(){
 const selected=selectedSectors(),items=values(),ready=base.filter(function(r){return Boolean(r.asof)}).length;
 const leaders=base.filter(isLeader).length,total=base.length;
 const sectorTotal=get("ls-sector").querySelectorAll('input[type="checkbox"]').length;
 get("ls-sector-count").textContent=selected.size+" / "+sectorTotal+" セクター選択中";
 const maxPage=Math.max(0,Math.ceil(items.length/PAGE_SIZE)-1);
 currentPage=Math.min(Math.max(0,currentPage),maxPage);
 const begin=currentPage*PAGE_SIZE;
 const portion=items.slice(begin,begin+PAGE_SIZE);
 const coverage=total?Math.round(ready/total*1000)/10:0;
 let stats="対象 "+selected.size+"セクター／"+label+" "+total.toLocaleString("ja-JP")+"銘柄／価格取得済み "+ready.toLocaleString("ja-JP")+"件（"+coverage+"%）";
 stats+="／未取得 "+(total-ready).toLocaleString("ja-JP")+"件／EPS成長率取得済み "+base.filter(r=>epsValue(r,"eps")!==null).length+"件／ROE取得済み "+base.filter(r=>roeValue(r)!==null).length+"件／時価総額取得済み "+base.filter(r=>marketCapJPY(r)!==null).length+"件／RS指数算出 "+base.filter(r=>finite(r.rs_universe_pct)).length+"件／暫定リーダー候補 "+leaders+"件／絞り込み "+items.length+"件";
 if(market==="jp"&&!universeMeta)stats+="／JPX全銘柄の初回取り込み待ち（暫定表示）";
 if(market==="jp"&&universeMeta?.reference_date){
  const stamp=universeMeta.reference_date;
  stats+="／JPX一覧 "+stamp.slice(0,4)+"/"+stamp.slice(4,6)+"/"+stamp.slice(6,8)+"時点";
 }
 if(market==="us"){
  const snapshotCount=base.filter(r=>r.moomoo_quote_asof&&Number.isFinite(r.moomoo_close)).length;
  const financialCount=base.filter(r=>r.moomoo_financial_checked_at).length;
  stats+="／moomoo最新株価 "+snapshotCount+"件／moomoo財務確認 "+financialCount+"件";
 }
 if(updatedAt)stats+="／取得処理 "+updatedAt;
 stats+="／業種取得済み "+base.filter(r=>Boolean(r.industry_name)).length+"件";
 get("ls-stat").textContent=stats;
 if(colFilters)colFilters.refresh();
 get("ls-body").innerHTML=portion.length?portion.map(rowHtml).join(""):'<tr><td colspan="'+totalColumns+'">該当する銘柄がありません。選択条件または株価取得状況をご確認ください。</td></tr>';
 if(colFilters&&colFilters.applyOrderToRows)colFilters.applyOrderToRows();
 get("ls-page-label").textContent=items.length?(begin+1)+"–"+(begin+portion.length)+" / "+items.length+" 件":"0 件";
 get("ls-prev").disabled=currentPage===0;
 get("ls-next").disabled=currentPage>=maxPage;
}
function filterChanged(){currentPage=0;render()}
// The authenticated private repo connector may replace browser-only EPS values.
// Nothing here sends financial values or API tokens to the public repository.
window.stockDashboardPrivateEPS={
 update(data){
  if(!data||data.schema_version!=="stock-dashboard-private-eps-v1"||data.market!=="us"||
     !data.us||typeof data.us!=="object"||Array.isArray(data.us))throw Error("非公開EPSのJSON形式が正しくありません");
  const next=new Map();
  for(const [ticker,entry] of Object.entries(data.us)){
   if(!/^[A-Z0-9.-]{1,15}$/.test(ticker)||!entry||typeof entry!=="object"||Array.isArray(entry))continue;
   const clean={};
   for(const key of ["eps_q_latest_yoy_pct","eps_q_prev_yoy_pct","eps_annual_3y_cagr_pct"])
    if(finite(entry[key]))clean[key]=entry[key];
   for(const key of ["eps_q_latest_end","eps_q_prev_end","eps_annual_end","eps_fetched_at"])
    if(typeof entry[key]==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(entry[key]))clean[key]=entry[key];
   if(Object.keys(clean).some(k=>k.endsWith("_pct")))next.set(ticker,clean);
  }
  if(!next.size)throw Error("非公開EPSに有効な成長率データがありません");
  privateEps.clear();
  next.forEach((row,ticker)=>privateEps.set(ticker,row));
  if(base.length)render();
  return next.size;
 },
 clear(){privateEps.clear();if(base.length)render();}
};
get("ls-sector").addEventListener("change",filterChanged);
get("ls-sector-all").addEventListener("click",function(){get("ls-sector").querySelectorAll('input[type="checkbox"]').forEach(function(input){input.checked=true});filterChanged()});
get("ls-sector-none").addEventListener("click",function(){get("ls-sector").querySelectorAll('input[type="checkbox"]').forEach(function(input){input.checked=false});filterChanged()});
get("ls-prev").addEventListener("click",function(){if(currentPage>0){currentPage--;render()}});
get("ls-next").addEventListener("click",function(){currentPage++;render()});
Promise.all([
 fetch("./sector-leaders.json?t="+Date.now(),{cache:"no-store"}).then(function(r){if(!r.ok)throw Error("HTTP "+r.status);return r.json()}),
 fetch(market==="jp"?"./jp-sectors.json":"./sectors.json",{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).catch(function(){return null}),
 fetch("./data.json",{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).catch(function(){return null})
]).then(function(all){
 const d=all[0];history=all[1];marketData=all[2];universeMeta=d.jp_master||null;
 usdJpy=finite(d.usd_jpy&&d.usd_jpy.rate)&&d.usd_jpy.rate>0?d.usd_jpy.rate:null;
 usdJpyAsOf=d.usd_jpy&&d.usd_jpy.asof||null;
 const strength=calculateConsistentSectorBands(history);
 consistentSectorLeaders=strength.leaders;
 consistentSectorLaggards=strength.laggards;
 base=(d[market]||[]).filter(function(r){return r&&r.ticker&&r.sector});
 updatedAt=d.updated_at?d.updated_at.slice(0,16).replace("T"," ")+" UTC":null;
 const sectors=new Map(base.map(function(r){return [r.sector,r.sector_name]}));
 Array.from(sectors.entries()).forEach(function(entry){
  const option=document.createElement("label");option.className="ls-sector-option";
  const checkbox=document.createElement("input");checkbox.type="checkbox";checkbox.value=entry[0];checkbox.checked=true;
  const text=document.createElement("span");text.textContent=entry[1];
  option.appendChild(checkbox);
  if(consistentSectorLeaders.has(entry[0])||consistentSectorLaggards.has(entry[0])){
   const strong=consistentSectorLeaders.has(entry[0]);
   const detail="3・10・25取引日すべてで"+(strong?"上位":"下位")+"3分の1";
   const dot=document.createElement("span");
   dot.className=strong?"ls-sector-leader-marker":"ls-sector-laggard-marker";
   dot.setAttribute("role","img");dot.setAttribute("aria-label",detail);
   dot.title=detail;
   option.appendChild(dot);
  }
  option.appendChild(text);get("ls-sector").appendChild(option);
 });
 if(marketData){
  let count=null;
  if(market==="us")count=marketData.rows&&marketData.rows[0]&&marketData.rows[0].sp500&&marketData.rows[0].sp500.dd_count;
  else{const ts=marketData.tse_rows||[];const latest=ts.slice().sort(function(a,b){return String(b.date||"").localeCompare(String(a.date||""))})[0];count=latest&&latest.prime&&latest.prime.dd_count}
  if(finite(count))get("ls-market").innerHTML="M：市場概況で確認するDD参考値 "+count+"件。<a href='./index.html'>市場概況へ</a>。DD・FTDは簡易判定で、トレンド確定を意味しません。";
 }
 render();
}).catch(function(e){get("ls-stat").textContent="候補データを読み込めません："+String(e);get("ls-body").innerHTML='<tr><td colspan="'+totalColumns+'">スクリーニングデータは未配信です。</td></tr>'});
})();
