/* Column-level filtering and sorting for the Japan/US industry analysis table. */
(function(root){
"use strict";
const numeric=v=>typeof v==="number"&&Number.isFinite(v);
const present=v=>v!==null&&v!==undefined&&v!=="";
const nameFor=g=>g.sector+"::"+g.name;
const columns=[
 {id:"rank",label:"順位",kind:"number",get:g=>g.rank,unit:"位"},
 {id:"sector",label:"セクター",kind:"multi",get:g=>g.sector},
 {id:"industry",label:"業種",kind:"multi",get:nameFor},
 {id:"size",label:"当日集計 / 登録銘柄",kind:"pair",get:g=>g.sample,getAlt:g=>g.universe},
 {id:"return",label:"期間平均騰落率",kind:"number",get:g=>g.avgReturn,unit:"%"},
 {id:"up",label:"値上がり比率（当日）",kind:"number",get:g=>g.upRate,unit:"%"},
 {id:"buy",label:"買い優勢率（当日）",kind:"number",get:g=>g.buyRate,unit:"%"},
 {id:"volume",label:"平均出来高倍率",kind:"number",get:g=>g.avgRvol,unit:"倍"},
 {id:"leaders",label:"期間上位銘柄",kind:"text",
  get:g=>(g.leaders||[]).map(x=>[x.ticker,x.name].filter(Boolean).join(" ")).join(" ")}
];
function matches(row,filters){
 for(const [id,rule] of filters){
  const def=columns.find(x=>x.id===id);
  if(!def)continue;
  const v=def.get(row);
  if(def.kind==="number"||def.kind==="pair"){
   if(rule.presence==="missing"){
    if(numeric(v)&&(def.kind!=="pair"||numeric(def.getAlt(row))))return false;
    continue;
   }
   if(rule.presence==="has"&&!numeric(v))return false;
   if((present(rule.min)||present(rule.max))&&!numeric(v))return false;
   if(numeric(v)&&((present(rule.min)&&v<rule.min)||(present(rule.max)&&v>rule.max)))return false;
   if(def.kind==="pair"){
    const alt=def.getAlt(row);
    if(rule.presence==="has"&&!numeric(alt))return false;
    if((present(rule.altMin)||present(rule.altMax))&&!numeric(alt))return false;
    if(numeric(alt)&&((present(rule.altMin)&&alt<rule.altMin)||(present(rule.altMax)&&alt>rule.altMax)))return false;
   }
  }else if(def.kind==="multi"){
   if(rule.choices&&rule.choices.length&&!rule.choices.includes(v))return false;
  }else if(def.kind==="text"){
   if(!String(v||"").toLocaleLowerCase().includes(String(rule.text||"").toLocaleLowerCase()))return false;
  }
 }
 return true;
}
function compare(def,a,b,direction){
 const av=def.get(a),bv=def.get(b);
 const valid=v=>def.kind==="number"||def.kind==="pair"?numeric(v):present(v);
 if(!valid(av)&&!valid(bv))return 0;
 if(!valid(av))return 1;
 if(!valid(bv))return -1;
 const delta=def.kind==="number"||def.kind==="pair"?av-bv:
  String(av).localeCompare(String(bv),"ja",{numeric:true});
 return (direction==="asc"?delta:-delta);
}
function apply(rows,filters,sort){
 const chosen=(rows||[]).filter(r=>matches(r,filters));
 if(sort){
  const def=columns.find(x=>x.id===sort.id);
  if(def)chosen.sort((a,b)=>compare(def,a,b,sort.direction));
 }
 return chosen;
}
root.IndustryColumnFiltersCore={columns,matches,compare,apply};
root.createIndustryColumnFilters=function({panel,getRows,displayIndustry,escapeHtml,onChange}){
 const h=escapeHtml,filters=new Map();
 let sorting=null,active=null,anchor=null;
 const header=Array.from(panel.querySelectorAll(".ia-table thead th"));
 if(header.length!==columns.length)throw Error("業種分析列の定義と見出しの数が一致しません");
 const buttons=new Map();
 const toolbar=document.createElement("div");
 toolbar.className="ia-filter-toolbar";
 toolbar.innerHTML='<span>見出しの ▾ から各列を絞り込み・並び替えできます。複数の条件はANDです。</span>'+
  '<button class="ia-reset" type="button">列フィルターをすべて解除</button>'+
  '<div class="ia-filter-chips" aria-live="polite"></div>';
 const scroll=panel.querySelector(".ia-scroll");
 panel.insertBefore(toolbar,scroll);
 const popup=document.createElement("div");
 popup.className="ia-col-popup";
 popup.hidden=true;
 popup.setAttribute("role","dialog");
 popup.setAttribute("aria-label","業種分析の列フィルター");
 panel.appendChild(popup);
 function close(){
  popup.hidden=true;active=null;anchor=null;
  buttons.forEach(b=>b.setAttribute("aria-expanded","false"));
 }
 function currentOptions(def){
  const map=new Map();
  for(const row of getRows()||[]){
   const raw=def.get(row);
   if(!raw)continue;
   const label=def.id==="industry"?displayIndustry(row.name):String(raw);
   const old=map.get(raw);
   map.set(raw,{value:String(raw),label,count:old?old.count+1:1,sector:row.sector});
  }
  const arr=[...map.values()];
  const byLabel=new Map();
  for(const item of arr)byLabel.set(item.label,(byLabel.get(item.label)||0)+1);
  return arr.map(x=>({...x,label:x.label+(byLabel.get(x.label)>1?"（"+x.sector+"）":"")}))
   .sort((a,b)=>a.label.localeCompare(b.label,"ja"));
 }
 function rangeInput(field,title,unit,val){
  return '<label>'+h(title)+(unit?"（"+h(unit)+"）":"")+
   '<input type="number" step="any" data-field="'+field+'" value="'+h(present(val)?val:"")+'" placeholder="指定なし"></label>';
 }
 function renderPopup(def){
  const saved=filters.get(def.id)||{};
  let body="";
  if(def.kind==="number"||def.kind==="pair"){
   body='<div class="ia-filter-ranges">'+rangeInput("min",def.kind==="pair"?"当日集計 最小":"最小値",def.kind==="pair"?"銘柄":def.unit,saved.min)+
    rangeInput("max",def.kind==="pair"?"当日集計 最大":"最大値",def.kind==="pair"?"銘柄":def.unit,saved.max);
   if(def.kind==="pair")body+=rangeInput("altMin","登録銘柄 最小","銘柄",saved.altMin)+rangeInput("altMax","登録銘柄 最大","銘柄",saved.altMax);
   body+='</div><label>データの有無<select data-field="presence">'+
    ["all","has","missing"].map((v,i)=>'<option value="'+v+'"'+(saved.presence===v?" selected":"")+'>'+["すべて","取得済み","未取得"][i]+'</option>').join("")+'</select></label>';
  }else if(def.kind==="multi"){
   const options=currentOptions(def);
   const picked=new Set(saved.choices||[]);
   body='<label>候補を検索<input type="search" data-field="search" placeholder="名称を検索（日本語・英語）"></label>'+
    '<div class="ia-option-list" role="group" aria-label="'+h(def.label)+'">';
   body+=options.map(item=>'<label class="ia-filter-option" data-search="'+h(item.label+" "+item.value)+'">'+
     '<input type="checkbox" data-field="multi" value="'+h(item.value)+'"'+(picked.has(item.value)?" checked":"")+'>'+
     '<span title="'+h(item.value)+'">'+h(item.label)+'</span><small>'+item.count+'件</small></label>').join("");
   body+='</div>';
  }else{
   body='<label>この文字を含む<input type="search" data-field="text" value="'+h(saved.text||"")+'" placeholder="ティッカー・銘柄名"></label>';
  }
  popup.innerHTML='<div class="ia-popup-head"><strong>'+h(def.label)+'</strong><button type="button" data-action="close" aria-label="閉じる">×</button></div>'+
   body+'<p class="ia-popup-error" role="alert"></p>'+
   '<div class="ia-popup-sort"><button type="button" data-action="asc">▲ 昇順</button><button type="button" data-action="desc">▼ 降順</button></div>'+
   '<div class="ia-popup-actions"><button type="button" data-action="clear">この列を解除</button><button type="button" data-action="apply">適用</button></div>';
  popup.hidden=false;
  const rect=anchor.getBoundingClientRect();
  const w=popup.offsetWidth,ht=popup.offsetHeight;
  popup.style.left=Math.max(8,Math.min(rect.left,innerWidth-w-8))+"px";
  popup.style.top=(rect.bottom+ht+8>innerHeight?Math.max(8,rect.top-ht-6):rect.bottom+6)+"px";
  const input=popup.querySelector('input[type="search"],input[type="number"],select');
  if(input)input.focus({preventScroll:true});
 }
 function meaningful(def,val){
  if(!val)return false;
  if(def.kind==="multi")return val.choices&&val.choices.length>0;
  if(def.kind==="text")return Boolean(val.text);
  return ["min","max","altMin","altMax"].some(k=>present(val[k]))||["has","missing"].includes(val.presence);
 }
 function draft(def){
  if(def.kind==="multi")return {choices:[...popup.querySelectorAll('input[data-field="multi"]:checked')].map(x=>x.value)};
  if(def.kind==="text")return {text:popup.querySelector('[data-field="text"]').value.trim()};
  const r={presence:popup.querySelector('[data-field="presence"]').value};
  for(const name of def.kind==="pair"?["min","max","altMin","altMax"]:["min","max"]){
   const str=popup.querySelector('[data-field="'+name+'"]').value;
   r[name]=str===""?null:Number(str);
   if(r[name]!==null&&!numeric(r[name]))throw Error("数値を入力してください");
  }
  if(r.min!==null&&r.max!==null&&r.min>r.max)throw Error("最小値は最大値以下にしてください");
  if(def.kind==="pair"&&r.altMin!==null&&r.altMax!==null&&r.altMin>r.altMax)throw Error("登録銘柄数の最小値は最大値以下にしてください");
  return r;
 }
 function refresh(){
  buttons.forEach((button,id)=>{
   const set=filters.has(id)||sorting&&sorting.id===id;
   button.classList.toggle("ia-filter-active",Boolean(set));
   button.setAttribute("aria-pressed",String(Boolean(set)));
   button.textContent=sorting&&sorting.id===id?(sorting.direction==="asc"?"▲":"▼"):"▾";
  });
  const chips=toolbar.querySelector(".ia-filter-chips");
  chips.innerHTML=[...filters].map(([id,value])=>{
   const def=columns.find(d=>d.id===id);
   const label=def.label;
   let suffix="";
   if(def.kind==="multi")suffix=value.choices.length+"件選択";
   else if(def.kind==="text")suffix="「"+value.text+"」";
   else suffix=[present(value.min)?value.min+"以上":null,present(value.max)?value.max+"以下":null,
    present(value.altMin)?"登録"+value.altMin+"以上":null,
    present(value.altMax)?"登録"+value.altMax+"以下":null,
    value.presence==="missing"?"未取得":value.presence==="has"?"取得済み":null].filter(Boolean).join("・");
   return '<button type="button" data-remove="'+h(id)+'">'+h(label+"： "+suffix)+' ×</button>';
  }).join("")+(sorting?'<button type="button" data-remove-sort="1">'+h("並び順： "+columns.find(x=>x.id===sorting.id).label)+" ×</button>":"");
 }
 columns.forEach((def,i)=>{
  const button=document.createElement("button");
  button.type="button";button.className="ia-col-toggle";button.textContent="▾";
  button.setAttribute("aria-label",def.label+" の絞り込み・並び替え");
  button.setAttribute("aria-expanded","false");
  button.addEventListener("click",()=>{
   if(active===def.id&&!popup.hidden){close();return;}
   active=def.id;anchor=button;
   buttons.forEach(b=>b.setAttribute("aria-expanded","false"));
   button.setAttribute("aria-expanded","true");
   renderPopup(def);
  });
  header[i].appendChild(button);
  buttons.set(def.id,button);
 });
 popup.addEventListener("input",e=>{
  if(!e.target.matches('[data-field="search"]'))return;
  const word=e.target.value.trim().toLocaleLowerCase();
  popup.querySelectorAll(".ia-filter-option").forEach(el=>{el.hidden=!(el.dataset.search||"").toLocaleLowerCase().includes(word);});
 });
 popup.addEventListener("click",e=>{
  const button=e.target.closest("button[data-action]");
  if(!button)return;
  const action=button.dataset.action;
  if(action==="close"){close();return;}
  const def=columns.find(x=>x.id===active);
  if(!def)return;
  if(action==="clear"){filters.delete(def.id);if(sorting?.id===def.id)sorting=null;close();refresh();onChange();return;}
  try{
   const val=draft(def);
   if(meaningful(def,val))filters.set(def.id,val);else filters.delete(def.id);
   if(action==="asc"||action==="desc")sorting={id:def.id,direction:action};
   close();refresh();onChange();
  }catch(err){popup.querySelector(".ia-popup-error").textContent=err.message;}
 });
 popup.addEventListener("keydown",e=>{
  if(e.key==="Escape"){close();return;}
  if(e.key==="Enter"&&e.target.matches("input")){e.preventDefault();popup.querySelector('[data-action="apply"]').click();}
 });
 toolbar.querySelector(".ia-reset").addEventListener("click",()=>{filters.clear();sorting=null;close();refresh();onChange();});
 toolbar.querySelector(".ia-filter-chips").addEventListener("click",e=>{
  const btn=e.target.closest("button");
  if(!btn)return;
  if(btn.dataset.remove)filters.delete(btn.dataset.remove);
  if(btn.dataset.removeSort)sorting=null;
  refresh();onChange();
 });
 document.addEventListener("pointerdown",e=>{
  if(!popup.hidden&&!popup.contains(e.target)&&!e.target.closest(".ia-col-toggle"))close();
 });
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!popup.hidden)close();});
 refresh();
 return {
  apply:rows=>apply(rows,filters,sorting),
  clearSort(){sorting=null;refresh();},
  activeCount:()=>filters.size+(sorting?1:0)
 };
};
})(typeof window!=="undefined"?window:globalThis);
