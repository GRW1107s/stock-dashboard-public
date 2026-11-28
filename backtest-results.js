/* Research archive. Append reports to backtest-results.json; do not overwrite old studies. */
(function(){
"use strict";
const root=document.getElementById("backtest-results-panel");if(!root)return;
const list=root.querySelector("#br-list"),detail=root.querySelector("#br-detail"),query=root.querySelector("#br-query"),category=root.querySelector("#br-category"),count=root.querySelector("#br-count");
let reports=[],selected=null;
function el(tag,value,cls){const n=document.createElement(tag);if(value!=null)n.textContent=String(value);if(cls)n.className=cls;return n}
function fmt(v,type){if(v==null)return "—";if(typeof v!=="number")return String(v);return type==="pct"?v.toFixed(2)+"%":type==="ratio"?v.toFixed(3):type==="int"?String(v):String(v)}
function bullets(title,items){if(!items||!items.length)return;detail.append(el("h4",title));const ul=el("ul");items.forEach(v=>ul.append(el("li",v)));detail.append(ul)}
function renderDetail(r){detail.replaceChildren();if(!r){detail.append(el("p","該当する検証結果がありません。"));return}
detail.append(el("h3",r.title),el("div",[r.date,r.ticker,r.period,r.status].join(" ｜ "),"br-meta"),el("p",r.summary,"br-summary"));bullets("検証条件",r.conditions);
(r.tables||[]).forEach(t=>{detail.append(el("h4",t.title));const wrap=el("div",null,"br-scroll"),table=el("table"),thead=el("thead"),tr=el("tr");t.columns.forEach(v=>{const th=el("th",v);th.scope="col";tr.append(th)});thead.append(tr);table.append(thead);const tbody=el("tbody");t.rows.forEach(row=>{const tr=el("tr");row.forEach((v,i)=>tr.append(el("td",fmt(v,t.formats&&t.formats[i]))));tbody.append(tr)});table.append(tbody);wrap.append(table);detail.append(wrap)});
bullets("注意点・未検証事項",r.notes);if(r.next)detail.append(el("h4","次の検証"),el("p",r.next))}
function render(){const q=query.value.trim().toLocaleLowerCase(),c=category.value;const shown=reports.filter(r=>(!c||r.category===c)&&(!q||JSON.stringify(r).toLocaleLowerCase().includes(q)));count.textContent=shown.length+"件";if(!shown.some(r=>r.id===selected))selected=shown[0]?.id||null;list.replaceChildren();shown.forEach(r=>{const b=el("button",null,"br-entry");b.type="button";b.setAttribute("aria-pressed",String(r.id===selected));b.append(el("strong",r.title),el("small",[r.date,r.ticker,r.category].join(" ｜ ")));b.addEventListener("click",()=>{selected=r.id;render()});list.append(b)});renderDetail(shown.find(r=>r.id===selected))}
query.addEventListener("input",render);category.addEventListener("change",render);
fetch("./backtest-results.json",{cache:"no-cache"}).then(r=>{if(!r.ok)throw Error(r.status);return r.json()}).then(d=>{if(!Array.isArray(d.reports))throw Error("invalid reports");reports=d.reports.slice().sort((a,b)=>b.date.localeCompare(a.date));[...new Set(reports.map(r=>r.category))].sort().forEach(c=>{const o=el("option",c);o.value=c;category.append(o)});render()}).catch(()=>{detail.textContent="検証結果を読み込めませんでした。ページを再読み込みしてください。"});
})();
