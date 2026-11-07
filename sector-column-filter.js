/* Client-side column filters for Japan and US leader screens.
 * Works over the full in-memory universe before pagination. */
(function(root){
"use strict";
function nonempty(v){return v!==null&&v!==undefined&&v!=="";}
function matches(defs,filters,row){
 for(const [id,c] of filters){
  const d=defs.find(x=>x.id===id);
  if(!d)continue;
  const v=d.get(row);
  if(d.kind==="number"){
   const valid=typeof v==="number"&&Number.isFinite(v);
   if(c.presence==="missing"){if(valid)return false;continue;}
   if(!valid){if(c.presence==="has"||nonempty(c.min)||nonempty(c.max))return false;continue;}
   if(nonempty(c.min)&&v<c.min)return false;
   if(nonempty(c.max)&&v>c.max)return false;
  }else if(d.kind==="text"){
   if(!String(v||"").toLocaleLowerCase().includes((c.text||"").toLocaleLowerCase()))return false;
  }else if(d.kind==="multi"){
   if(Array.isArray(c.choices)&&c.choices.length&&!c.choices.includes(v))return false;
  }else if(v!==c.choice)return false;
 }
 return true;
}
function compare(def,a,b,direction){
 const va=def.get(a),vb=def.get(b);
 const missing=v=>!nonempty(v)||(def.kind==="number"&&(!Number.isFinite(v)||typeof v!=="number"));
 if(missing(va)&&missing(vb))return 0;
 if(missing(va))return 1;
 if(missing(vb))return -1;
 const result=def.kind==="number"?va-vb:String(va).localeCompare(String(vb),"ja",{numeric:true});
 return direction==="asc"?result:-result;
}
function industryOptions(rows){
 const counts=new Map();
 for(const row of rows||[]){
  const name=typeof row.industry_name==="string"?row.industry_name.trim():"";
  if(name)counts.set(name,(counts.get(name)||0)+1);
 }
 return [...counts].map(([name,count])=>({name,count}))
  .sort((a,b)=>a.name.localeCompare(b.name,"ja",{numeric:true}));
}


/* Saved column order uses stable field IDs; existing saved widths stay field-specific. */
function normalizeColumnOrder(ids,saved){
 const allowed=new Set(ids),seen=new Set(),result=[];
 for(const id of Array.isArray(saved)?saved:[]){
  if(allowed.has(id)&&!seen.has(id)){seen.add(id);result.push(id);}
 }
 for(const id of ids)if(!seen.has(id))result.push(id);
 return result;
}
function moveColumnOrder(order,source,target,after){
 if(source===target||!order.includes(source)||!order.includes(target))return [...order];
 const result=order.filter(id=>id!==source);
 result.splice(result.indexOf(target)+(after?1:0),0,source);
 return result;
}
function setupColumnOrder(panel,market,headings,defs){
 const table=panel.querySelector("table.ls-table"),headrow=table&&table.querySelector("thead tr");
 if(!headrow||headings.length!==defs.length)return {applyRows(){}};
 const ids=defs.map(x=>x.id),headerById=new Map(ids.map((id,i)=>[id,headings[i]]));
 const key="stock-dashboard-screener-order-v1-"+market;
 let stored=null;try{stored=JSON.parse(localStorage.getItem(key)||"null");}catch(e){}
 let order=normalizeColumnOrder(ids,stored);
 const reset=document.createElement("button");reset.type="button";reset.id="ls-reset-column-order";reset.textContent="列順を初期化";
 panel.querySelector(".ls-column-toolbar-top").appendChild(reset);
 function arrange(){
  order.forEach(id=>headrow.appendChild(headerById.get(id)));
  const group=table.querySelector("colgroup");
  if(group){
   const cols=new Map([...group.children].map(col=>[col.dataset.lsColumnId,col]));
   for(const id of order){const col=cols.get(id);if(col)group.appendChild(col);}
   const addCol=cols.get("__add");if(addCol)group.appendChild(addCol);
  }
  reset.disabled=order.every((id,i)=>id===ids[i]);
 }
 function applyRows(){
  const body=table.tBodies[0];if(!body)return;
  for(const tr of body.rows){
   const cells=[...tr.cells];
   if(cells.length!==ids.length)continue;
   // Newly rendered rows are in their original, canonical field order.
   if(cells.some(td=>!td.dataset.lsColumnId))
    cells.forEach((td,i)=>{td.dataset.lsColumnId=ids[i];});
   const byId=new Map(cells.map(td=>[td.dataset.lsColumnId,td]));
   order.forEach(id=>{const td=byId.get(id);if(td)tr.appendChild(td);});
  }
 }
 function update(next){
  if(next.every((id,i)=>id===order[i]))return;
  order=next;
  try{localStorage.setItem(key,JSON.stringify(order));}catch(e){}
  arrange();applyRows();
 }
 reset.addEventListener("click",()=>update([...ids]));
 let drag=null,hover=null,after=false;
 function highlight(next,right){
  if(hover)hover.classList.remove("ls-drop-before","ls-drop-after");
  hover=next;after=right;
  if(hover)hover.classList.add(right?"ls-drop-after":"ls-drop-before");
 }
 function end(id,cancel){
  if(!drag||drag.id!==id)return;
  const d=drag,target=hover,right=after;
  drag=null;d.th.classList.remove("ls-column-dragging");highlight(null,false);
  if(d.th.hasPointerCapture&&d.th.hasPointerCapture(id))d.th.releasePointerCapture(id);
  if(!cancel&&d.active&&target)update(moveColumnOrder(order,d.th.dataset.lsColumnId,target.dataset.lsColumnId,right));
 }
 headings.forEach((th,i)=>{
  const id=ids[i];th.dataset.lsColumnId=id;th.classList.add("ls-column-reorderable");th.tabIndex=0;
  th.title=(th.title?th.title+" ｜ ":"")+"ドラッグで列順を変更（保存）。Alt＋左右キーでも移動可能。";
  th.addEventListener("pointerdown",e=>{
   if(e.button!==0||e.isPrimary===false||e.pointerType==="touch"||e.target.closest("button,.ls-column-resize-handle,a,input,select"))return;
   drag={th,id:e.pointerId,x:e.clientX,y:e.clientY,active:false};
   th.setPointerCapture(e.pointerId);e.preventDefault();
  });
  th.addEventListener("pointermove",e=>{
   if(!drag||drag.th!==th||drag.id!==e.pointerId)return;
   if(!drag.active){
    if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<6)return;
    drag.active=true;th.classList.add("ls-column-dragging");
   }
   const under=document.elementFromPoint(e.clientX,e.clientY);
   const target=under&&under.closest("thead th.ls-column-reorderable");
   const next=target&&target!==th&&table.contains(target)?target:null;
   const right=next?e.clientX>next.getBoundingClientRect().left+next.getBoundingClientRect().width/2:false;
   if(next!==hover||right!==after)highlight(next,right);
  });
  th.addEventListener("pointerup",e=>end(e.pointerId,false));
  th.addEventListener("pointercancel",e=>end(e.pointerId,true));
  th.addEventListener("lostpointercapture",e=>end(e.pointerId,true));
  th.addEventListener("keydown",e=>{
   if(e.target!==th||!e.altKey||e.ctrlKey||e.metaKey)return;
   const delta=e.key==="ArrowLeft"?-1:e.key==="ArrowRight"?1:0;
   if(!delta)return;
   e.preventDefault();
   const target=order.indexOf(id)+delta;
   if(target>=0&&target<order.length){update(moveColumnOrder(order,id,order[target],delta>0));th.focus();}
  });
 });
 arrange();
 return {applyRows};
}

/* Column widths are draggable and remembered in this browser for each market. */
function setupColumnResize(panel,market,headings){
 const table=panel.querySelector("table.ls-table");
 if(!table||!headings.length)return;
 const key="stock-dashboard-screener-widths-v1-"+market;
 let done=false;
 function init(){
  if(done||table.getBoundingClientRect().width<100)return false;
  done=true;
  const defaultWidths=Array.from(headings,th=>Math.ceil(th.getBoundingClientRect().width));
  const minimums=Array.from(headings,th=>th.classList.contains("ls-ma-col")?50:th.classList.contains("ls-name-heading")?135:58);
  let stored=null;
  try{stored=JSON.parse(localStorage.getItem(key)||"null");}catch(e){}
  const widths=defaultWidths.map((width,i)=>{
   const saved=Array.isArray(stored)&&stored.length===headings.length?stored[i]:null;
   return typeof saved==="number"&&Number.isFinite(saved)?Math.max(minimums[i],Math.min(650,saved)):Math.max(minimums[i],width);
  });
  const group=document.createElement("colgroup");
  const columns=widths.map((_,i)=>{const col=document.createElement("col");col.dataset.lsColumnId=headings[i].dataset.lsColumnId||String(i);group.appendChild(col);return col;});
  if(table.querySelector("thead th.ls-add-col")){
   const col=document.createElement("col");col.dataset.lsColumnId="__add";columns.push(col);widths.push(36);
  }
   const positions=[...table.querySelectorAll("thead th")].map(th=>th.dataset.lsColumnId);
   for(const id of positions){const col=columns.find(c=>c.dataset.lsColumnId===id);if(col)group.appendChild(col);}
  table.insertBefore(group,table.querySelector("thead"));
  table.style.tableLayout="fixed";
  function draw(){
   columns.forEach((col,i)=>col.style.width=widths[i]+"px");
   const total=widths.reduce((sum,v)=>sum+v,0)+"px";
   table.style.width=total;table.style.minWidth=total;
  }
  function persist(){try{localStorage.setItem(key,JSON.stringify(widths.slice(0,headings.length)));}catch(e){}}
  Array.from(headings).forEach((th,i)=>{
   th.classList.add("ls-resizable-heading");
   const grip=document.createElement("span");
   grip.className="ls-column-resize-handle";
   grip.setAttribute("role","separator");
   grip.setAttribute("aria-orientation","vertical");
   grip.setAttribute("aria-label",th.textContent.trim().replace(/▾/g,"")+" 列幅");
   grip.setAttribute("tabindex","0");
   grip.title="ドラッグで幅を調整・自動保存。ダブルクリックで元に戻す";
   th.appendChild(grip);
   let startX=null,oldWidth=0;
   grip.addEventListener("pointerdown",e=>{
    if(e.button!==0||!e.isPrimary)return;
    e.preventDefault();e.stopPropagation();
    startX=e.clientX;oldWidth=widths[i];grip.setPointerCapture(e.pointerId);
   });
   grip.addEventListener("pointermove",e=>{
    if(startX===null)return;
    widths[i]=Math.max(minimums[i],Math.min(650,oldWidth+Math.round(e.clientX-startX)));
    draw();
   });
   function finish(){if(startX!==null){startX=null;persist();}}
   grip.addEventListener("pointerup",finish);
   grip.addEventListener("pointercancel",finish);
   grip.addEventListener("lostpointercapture",finish);
   grip.addEventListener("dblclick",e=>{e.preventDefault();e.stopPropagation();widths[i]=Math.max(minimums[i],defaultWidths[i]);draw();persist();});
   grip.addEventListener("keydown",e=>{
    if(e.key!=="ArrowLeft"&&e.key!=="ArrowRight")return;
    e.preventDefault();widths[i]=Math.max(minimums[i],Math.min(650,widths[i]+(e.key==="ArrowRight"?10:-10)));draw();persist();
   });
  });
  draw();
  return true;
 }
 if(init())return;
 if(typeof ResizeObserver!=="undefined"){
  const observer=new ResizeObserver(()=>{if(init())observer.disconnect();});
  observer.observe(table);
 }else panel.addEventListener("pointerenter",init,{once:true});
}
root.LeaderColumnFiltersCore={matches,compare,industryOptions,normalizeColumnOrder,moveColumnOrder};
root.createLeaderColumnFilters=function(ctx){
 const {panel,market,get,H,numeric,finite,relative,epsValue,roeValue,reviewStatus,onChange,getRows,marketCapJPY}=ctx;
 const defs=[
  {id:"sector",label:"セクター",kind:"text",get:r=>r.sector_name||r.sector||""},
  {id:"industry",label:"業種",kind:"multi",get:r=>r.industry_name||""},
  {id:"name",label:"候補銘柄",kind:"text",get:r=>[r.name,r.ticker,r.market].filter(Boolean).join(" ")},
  {id:"cap",label:"時価総額",kind:"number",unit:"億円",
   get:r=>{const v=marketCapJPY(r);return finite(v)?v/1e8:null;}},
  ...(market==="jp"?[{id:"size",label:"規模",kind:"choice",
   get:r=>{const cap=marketCapJPY(r);return !finite(cap)?"—":cap>=1e12?"超大型":cap>=3e11?"大型":cap>=5e10?"中型":cap>=1e10?"小型":"超小型";},
   options:["超大型","大型","中型","小型","超小型","—"]}]:[]),
  ...(market==="jp"?[
   {id:"short",label:"大口空売り残高",kind:"number",unit:"%",get:r=>numeric(r.short_ratio)},
   {id:"shortChg",label:"空売り増減",kind:"number",unit:"pt",get:r=>numeric(r.short_d_ratio)},
   {id:"marginSell",label:"売残増減率",kind:"number",unit:"%",get:r=>numeric(r.margin_sell_pct)},
   {id:"marginBuy",label:"買残増減率",kind:"number",unit:"%",get:r=>numeric(r.margin_buy_pct)},
   {id:"marginRatio",label:"信用倍率",kind:"number",unit:"倍",get:r=>numeric(r.margin_ratio)}
  ]:[]),
  {id:"rs",label:"RS指数",kind:"number",get:r=>numeric(r.rs_universe_pct)},
  {id:"beta",label:"ベータ値",kind:"number",get:r=>numeric(r.beta_252d)},
  {id:"sharpe",label:"シャープレシオ",kind:"number",get:r=>numeric(r.sharpe_252d)},
  ...(market==="us"?[{id:"sp500",label:"S&P500比 加重",kind:"number",unit:"pp",get:r=>numeric(r.rs_sp500_delta_pp)}]:[]),
  {id:"rank",label:"セクター内60日順位",kind:"number",unit:"位",get:r=>numeric(r.sector_rank)},
  {id:"return60",label:"60日騰落率",kind:"number",unit:"%",get:r=>numeric(r.return_60d)},
  {id:"etf",label:"同ETF比60日",kind:"number",unit:"pp",get:r=>relative(r)},
  {id:"high",label:"52週高値からの距離",kind:"number",unit:"%",get:r=>numeric(r.high52_distance_pct)},
  ...(market==="us"?[50,200].map(period=>({
   id:"ma"+period,label:period+"MA",kind:"choice",
   get:r=>r["ma"+period+"_position"]==="above"?"○":
          r["ma"+period+"_position"]==="below"||r["ma"+period+"_position"]==="equal"?"✕":"—",
   options:["○","✕","—"]
  })):[]),
  {id:"volume",label:"出来高倍率",kind:"number",unit:"倍",get:r=>numeric(r.rvol20)},
  {id:"eps",label:"直近四半期EPS成長率",kind:"number",unit:"%",get:r=>epsValue(r,"eps")},
  {id:"epsPrev",label:"1四半期前EPS成長率",kind:"number",unit:"%",get:r=>epsValue(r,"previous_eps")},
  {id:"epsAnnual",label:"年間EPS成長率3年",kind:"number",unit:"%",get:r=>epsValue(r,"annual")},
  {id:"roe",label:"ROE",kind:"number",unit:"%",get:r=>roeValue(r)}
 ];
 const filters=new Map(),buttons=new Map();
 let sort=null,active=null;
 const toolbar=document.createElement("div");
 toolbar.className="ls-column-toolbar";
 toolbar.innerHTML='<div class="ls-column-toolbar-top"><span>列フィルター：見出しの <b>▾</b> で絞り込み。列幅は見出し右端をドラッグ、列順は見出しをドラッグ（どちらも自動保存）。見出しを右クリックで列を非表示、右端の <b>＋</b> で再表示。業種は複数選択でき、複数列はAND条件です。</span><button type="button" id="ls-reset-all">全条件を解除</button></div><div id="ls-filter-chips" class="ls-filter-chips" aria-live="polite"></div>';
 const toolbarAnchor=panel.querySelector(".ls-controls")||panel.querySelector(".ls-sector-fieldset");
 if(toolbarAnchor)toolbarAnchor.insertAdjacentElement("afterend",toolbar);
 else panel.insertBefore(toolbar,panel.querySelector(".ls-table-wrap"));
 const popup=document.createElement("div");
 popup.id="ls-column-popup";
 popup.className="ls-column-popup";
 popup.hidden=true;
 popup.setAttribute("role","dialog");
 popup.setAttribute("aria-label","列フィルターと並び替え");
 panel.appendChild(popup);
 const headings=panel.querySelectorAll("table.ls-table thead th");
 if(headings.length!==defs.length)console.warn("Leader column count mismatch",headings.length,defs.length);
 defs.forEach((def,i)=>{
  const th=headings[i];if(!th)return;
  const b=document.createElement("button");
  b.type="button";b.className="ls-column-toggle";
  b.textContent="▾";b.title=def.label+" の絞り込み・並び替え";
  b.setAttribute("aria-label",def.label+" の絞り込み・並び替え");
  b.setAttribute("aria-haspopup","dialog");b.setAttribute("aria-expanded","false");
  b.addEventListener("click",()=>{if(active===def.id&&!popup.hidden){close();return;}open(def,b);});
  th.appendChild(b);buttons.set(def.id,b);
 });
 setupColumnResize(panel,market,headings);
 const columnOrder=setupColumnOrder(panel,market,headings,defs);
 // Column visibility: right-click a heading to hide the column; the "+"
 // heading at the right end re-adds hidden columns. Persisted per market.
 const headrow=panel.querySelector("table.ls-table thead tr");
 const hiddenKey="stock-dashboard-screener-hidden-v1-"+market;
 let hidden=new Set();
 try{hidden=new Set((JSON.parse(localStorage.getItem(hiddenKey)||"[]")||[]).filter(id=>defs.some(d=>d.id===id)));}catch(e){}
 const visStyle=document.createElement("style");
 panel.appendChild(visStyle);
 const addTh=document.createElement("th");
 addTh.className="ls-add-col";addTh.dataset.lsColumnId="__add";
 const addButton=document.createElement("button");
 addButton.type="button";addButton.textContent="+";addButton.title="非表示の列を追加";
 addButton.setAttribute("aria-label","非表示の列を追加");addButton.setAttribute("aria-haspopup","dialog");
 addTh.appendChild(addButton);
 if(headrow)headrow.appendChild(addTh);
 // If the resize setup already built the colgroup, give the "+" column a
 // matching col so fixed layout stays aligned.
 const builtGroup=panel.querySelector("table.ls-table colgroup");
 if(builtGroup&&!builtGroup.querySelector('col[data-ls-column-id="__add"]')){
  const col=document.createElement("col");col.dataset.lsColumnId="__add";col.style.width="36px";
  builtGroup.appendChild(col);
  const t=panel.querySelector("table.ls-table"),w=parseInt(t.style.width||"0",10);
  if(w){t.style.width=(w+36)+"px";t.style.minWidth=(w+36)+"px";}
 }
 const addMenu=document.createElement("div");
 addMenu.className="ls-column-popup ls-col-menu";addMenu.hidden=true;
 addMenu.setAttribute("role","dialog");addMenu.setAttribute("aria-label","追加する列");
 panel.appendChild(addMenu);
 function applyHidden(){
  visStyle.textContent=[...hidden].map(id=>'th[data-ls-column-id="'+id+'"],td[data-ls-column-id="'+id+'"]{display:none!important}col[data-ls-column-id="'+id+'"]{visibility:collapse}').join("");
  try{localStorage.setItem(hiddenKey,JSON.stringify([...hidden]));}catch(e){}
  addButton.title=hidden.size?"非表示の列を追加（"+hidden.size+"列）":"非表示の列はありません";
 }
 function closeAddMenu(){addMenu.hidden=true;}
 function openAddMenu(){
  const items=defs.filter(d=>hidden.has(d.id));
  addMenu.innerHTML='<div class="ls-column-pophead"><strong>列を追加</strong><button type="button" data-close="1" aria-label="閉じる">×</button></div>'+
   (items.length?items.map(d=>'<button type="button" class="ls-col-menu-item" data-add="'+H(d.id)+'">'+H(d.label)+'</button>').join("")+
   (items.length>1?'<button type="button" class="ls-col-menu-item ls-col-menu-all" data-add="__all">すべて表示</button>':""):
   '<p class="ls-col-menu-empty">非表示の列はありません</p>');
  addMenu.hidden=false;
  const rect=addButton.getBoundingClientRect(),w=addMenu.offsetWidth;
  addMenu.style.left=Math.round(Math.max(8,Math.min(rect.right-w,window.innerWidth-w-8)))+"px";
  addMenu.style.top=Math.round(rect.bottom+6)+"px";
 }
 addButton.addEventListener("click",()=>{if(addMenu.hidden)openAddMenu();else closeAddMenu();});
 addMenu.addEventListener("click",e=>{
  if(e.target.closest("[data-close]")){closeAddMenu();return;}
  const b=e.target.closest("[data-add]");if(!b)return;
  if(b.dataset.add==="__all")hidden.clear();else hidden.delete(b.dataset.add);
  applyHidden();closeAddMenu();
 });
 document.addEventListener("pointerdown",e=>{
  if(!addMenu.hidden&&!addMenu.contains(e.target)&&e.target!==addButton&&!addButton.contains(e.target))closeAddMenu();
 });
 if(headrow)new MutationObserver(()=>{if(headrow.lastElementChild!==addTh)headrow.appendChild(addTh);}).observe(headrow,{childList:true});
 defs.forEach((def,i)=>{
  const th=headings[i];if(!th)return;
  th.addEventListener("contextmenu",e=>{
   e.preventDefault();
   if(defs.length-hidden.size<=1)return;
   hidden.add(def.id);
   if(active===def.id)close();
   closeAddMenu();
   applyHidden();
  });
 });
 applyHidden();
 function close(){popup.hidden=true;active=null;buttons.forEach(b=>b.setAttribute("aria-expanded","false"));}
 function open(def,b){
  active=def.id;
  const saved=filters.get(def.id)||{};
  let input;
  if(def.kind==="number"){
   const mode=saved.presence||"all";
   input='<div class="ls-column-range"><label>最小値'+(def.unit?"（"+H(def.unit)+"）":"")+'<input type="number" step="any" data-input="min" placeholder="指定なし" value="'+H(nonempty(saved.min)?saved.min:"")+'"></label>'+
    '<label>最大値'+(def.unit?"（"+H(def.unit)+"）":"")+'<input type="number" step="any" data-input="max" placeholder="指定なし" value="'+H(nonempty(saved.max)?saved.max:"")+'"></label></div>'+
    '<label>データの有無<select data-input="presence">'+
    ['all','has','missing'].map((v,i)=>'<option value="'+v+'"'+(mode===v?' selected':'')+'>'+['すべて','取得済みのみ','未取得のみ（数値範囲は無視）'][i]+'</option>').join('')+'</select></label>';
  }else if(def.kind==="text"){
   input='<label>この文字を含む<input type="search" data-input="text" placeholder="文字列を入力" value="'+H(saved.text||"")+'"></label>';
  }else if(def.kind==="multi"){
   const names=market==="us"&&root.StockIndustryJA;
   const show=name=>names?names.display(name):name;
   const options=industryOptions(typeof getRows==="function"?getRows():[])
    .sort((a,b)=>show(a.name).localeCompare(show(b.name),"ja",{numeric:true}));
   const chosen=new Set(saved.choices||[]);
   input='<div class="ls-industry-picker">'+
    '<label>業種名を検索<input type="search" data-input="option-search" placeholder="例: 半導体 / Semiconductor" autocomplete="off"></label>'+
    '<div class="ls-industry-count" data-role="option-count" aria-live="polite"></div>'+
    '<div class="ls-industry-options" role="group" aria-label="業種候補">'+
    (options.length?options.map(item=>'<label class="ls-industry-option" data-option="'+H(item.name+" "+show(item.name))+'">'+
     '<input type="checkbox" data-input="multi" value="'+H(item.name)+'"'+(chosen.has(item.name)?' checked':'')+'>'+
     '<span title="'+H(item.name)+'">'+H(show(item.name))+'</span><small>'+item.count+'件</small></label>').join(''):
     '<p class="ls-industry-empty">取得済みの業種候補がありません</p>')+
    '</div><p class="ls-industry-hint">複数選択可（選んだ業種のいずれかに一致）</p></div>';
  }else{
   input='<label>区分を選択<select data-input="choice"><option value="">すべて</option>'+
    def.options.map(v=>'<option value="'+H(v)+'"'+(saved.choice===v?' selected':'')+'>'+H(v)+'</option>').join('')+'</select></label>';
  }
  popup.innerHTML='<div class="ls-column-pophead"><strong>'+H(def.label)+'</strong><button type="button" data-action="close" aria-label="閉じる">×</button></div>'+
   input+'<div class="ls-column-error" id="ls-column-error" aria-live="polite"></div>'+
   '<div class="ls-column-sortactions"><button type="button" data-action="asc">▲ 昇順</button><button type="button" data-action="desc">▼ 降順</button></div>'+
   '<div class="ls-column-actions"><button type="button" data-action="clear">この列を解除</button><button type="button" data-action="apply" class="ls-column-apply">適用</button></div>';
  popup.hidden=false;
  buttons.forEach((btn,id)=>btn.setAttribute("aria-expanded",String(id===def.id)));
  const rect=b.getBoundingClientRect(),w=popup.offsetWidth,h=popup.offsetHeight;
  popup.style.left=Math.round(Math.max(8,Math.min(rect.left,window.innerWidth-w-8)))+"px";
  popup.style.top=Math.round(rect.bottom+6+h>window.innerHeight-8?Math.max(8,rect.top-h-6):rect.bottom+6)+"px";
  if(def.kind==="multi")refreshIndustryChoices();
  const first=popup.querySelector('input[data-input="option-search"], input:not([type="checkbox"]), select');
  if(first)first.focus({preventScroll:true});
 }
 function refreshIndustryChoices(){
  const search=popup.querySelector('[data-input="option-search"]');
  if(!search)return;
  const query=search.value.trim().toLocaleLowerCase();
  const options=[...popup.querySelectorAll(".ls-industry-option")];
  let shown=0;
  for(const option of options){
   const match=(option.dataset.option||"").toLocaleLowerCase().includes(query);
   option.classList.toggle("ls-industry-hidden",!match);
   if(match)shown++;
  }
  const selected=popup.querySelectorAll('[data-input="multi"]:checked').length;
  const count=popup.querySelector('[data-role="option-count"]');
  if(count)count.textContent="候補 "+shown+" / "+options.length+" 業種 ・ 選択中 "+selected+" 業種";
 }
 popup.addEventListener("input",e=>{
  if(e.target.matches('[data-input="option-search"]'))refreshIndustryChoices();
 });
 popup.addEventListener("change",e=>{
  if(e.target.matches('[data-input="multi"]'))refreshIndustryChoices();
 });
 function draft(def){
  if(def.kind==="number"){
   const min=numeric(popup.querySelector('[data-input="min"]').value);
   const max=numeric(popup.querySelector('[data-input="max"]').value);
   if(nonempty(min)&&nonempty(max)&&min>max)throw Error("最小値は最大値以下にしてください");
   return {min,max,presence:popup.querySelector('[data-input="presence"]').value};
  }
  if(def.kind==="text")return {text:popup.querySelector('[data-input="text"]').value.trim()};
  if(def.kind==="multi")return {choices:[...popup.querySelectorAll('[data-input="multi"]:checked')].map(x=>x.value)};
  return {choice:popup.querySelector('[data-input="choice"]').value};
 }
 function meaningful(def,c){
  if(!c)return false;
  if(def.kind==="number")return nonempty(c.min)||nonempty(c.max)||c.presence==="has"||c.presence==="missing";
  if(def.kind==="multi")return Array.isArray(c.choices)&&c.choices.length>0;
  return def.kind==="text"?Boolean(c.text):Boolean(c.choice);
 }
 function apply(action){
  const def=defs.find(d=>d.id===active);if(!def)return;
  try{
   const filter=draft(def);
   if(meaningful(def,filter))filters.set(def.id,filter);
   else filters.delete(def.id);
   if(action==="asc"||action==="desc"){sort={id:def.id,direction:action};}
   close();onChange();
  }catch(e){popup.querySelector("#ls-column-error").textContent=e.message;}
 }
 function remove(id){
  filters.delete(id);
  if(sort&&sort.id===id){sort=null;}
  onChange();
 }
 popup.addEventListener("click",e=>{
  const b=e.target.closest("button[data-action]");if(!b)return;
  if(b.dataset.action==="close"){close();return;}
  if(b.dataset.action==="clear"){const id=active;close();remove(id);return;}
  apply(b.dataset.action);
 });
 popup.addEventListener("keydown",e=>{
  if(e.key==="Escape"){e.preventDefault();close();}
  else if(e.key==="Enter"&&e.target.matches("input")){e.preventDefault();apply("apply");}
 });
 document.addEventListener("pointerdown",e=>{
  if(!popup.hidden&&!popup.contains(e.target)&&!e.target.closest(".ls-column-toggle"))close();
 });
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!popup.hidden)close();});
 window.addEventListener("scroll",event=>{if(!popup.hidden&&event.target!==popup&&!(event.target instanceof Node&&popup.contains(event.target)))close();},true);
 const sortSelect=get("ls-sort");
 if(sortSelect)sortSelect.addEventListener("change",()=>{
  if(sortSelect.value!=="column"){sort=null;refresh();}
 });
 get("ls-reset-all").addEventListener("click",()=>{
  filters.clear();sort=null;close();
  get("ls-sector").querySelectorAll('input[type="checkbox"]').forEach(x=>x.checked=true);
  onChange();
 });
 get("ls-filter-chips").addEventListener("click",e=>{
  const b=e.target.closest("button[data-remove]");if(b)remove(b.dataset.remove);
 });
 function describe(def,c){
  if(def.kind==="text")return def.label+": 「"+c.text+"」を含む";
  if(def.kind==="multi")return def.label+": "+(c.choices.length<=2?c.choices.join("・"):c.choices.length+"業種を選択");
  if(def.kind==="choice")return def.label+": "+c.choice;
  if(c.presence==="missing")return def.label+": 未取得のみ";
  const words=[];
  if(nonempty(c.min))words.push(c.min+"以上");
  if(nonempty(c.max))words.push(c.max+"以下");
  return def.label+": "+(words.length?words.join("・")+(def.unit?" "+def.unit:""):"取得済みのみ");
 }
 function refresh(){
  buttons.forEach((button,id)=>{
   const def=defs.find(d=>d.id===id);
   const set=meaningful(def,filters.get(id)),sorted=sort&&sort.id===id;
   button.classList.toggle("ls-column-active",!!(set||sorted));
   button.textContent=sorted?(sort.direction==="asc"?"▲":"▼"):"▾";
   button.setAttribute("aria-pressed",String(!!(set||sorted)));
  });
  const chips=Array.from(filters,([id,c])=>{
   const def=defs.find(d=>d.id===id);
   return '<button type="button" data-remove="'+H(id)+'" title="この列の条件を解除">'+H(describe(def,c))+' ×</button>';
  });
  if(sort){const def=defs.find(d=>d.id===sort.id);chips.push('<span>並び順: '+H(def.label)+' '+(sort.direction==="asc"?"昇順":"降順")+'</span>');}
  get("ls-filter-chips").innerHTML=chips.join("");
  const oldDefault=!get("ls-sector").querySelector('input[type="checkbox"]:not(:checked)');
  get("ls-reset-all").disabled=!chips.length&&oldDefault;
 }
 return {matches:r=>matches(defs,filters,r),sortActive:()=>!!sort,compare:(a,b)=>{
  const d=sort&&defs.find(x=>x.id===sort.id);return d?compare(d,a,b,sort.direction):0;
 },refresh,applyOrderToRows:columnOrder.applyRows};
};
})(typeof window!=="undefined"?window:globalThis);
