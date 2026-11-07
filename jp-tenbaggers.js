(function(){
'use strict';
const $=id=>document.getElementById(id);
let data=null,matched=[],limit=100;
const fmt=(v,p=1)=>Number.isFinite(Number(v))?Number(v).toLocaleString('ja-JP',{minimumFractionDigits:p,maximumFractionDigits:p}):'—';
const years=(a,b)=>(Date.parse(b+'T00:00:00')-Date.parse(a+'T00:00:00'))/(365.25*86400000);
function render(){
 if(!data)return;
 const term=$('tbYears').value,minimum=Number($('tbMin').value),sector=$('tbIndustry').value,search=$('tbSearch').value.toLowerCase(),order=$('tbSort').value;
 const rows=Object.entries(data.results||{}).map(([code,result])=>({code,...result,info:data.catalog[code]||{name:code,sector:'—'}})).filter(r=>{
   const m=r.metrics?.[term];
   return m&&m.multiple>=minimum&&(!sector||r.info.sector===sector)&&[r.code,r.info.name,r.info.sector].join(' ').toLowerCase().includes(search);
 });
 rows.sort((a,b)=>{
   const A=a.metrics[term],B=b.metrics[term];
   if(order==='date')return B.peak_date.localeCompare(A.peak_date)||B.multiple-A.multiple;
   if(order==='current')return B.from_start_multiple-A.from_start_multiple;
   if(order==='speed')return Math.log(B.multiple)/Math.max(.02,years(B.low_date,B.peak_date))-Math.log(A.multiple)/Math.max(.02,years(A.low_date,A.peak_date));
   return B.multiple-A.multiple;
 });
 matched=rows;
 const body=$('tbRows');body.replaceChildren();
 if(!rows.length){let tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=11;td.textContent='条件に合う銘柄はありません。期間や倍率を変更するか、調査範囲の更新を確認してください。';tr.appendChild(td);body.appendChild(tr);}
 rows.slice(0,limit).forEach((r,i)=>{
   const m=r.metrics[term],tr=document.createElement('tr');
   function td(value,css){let d=document.createElement('td');d.textContent=value;if(css)d.className=css;tr.appendChild(d);return d;}
   td(String(i+1));let name=td(''),anchor=document.createElement('a');anchor.href='https://finance.yahoo.com/quote/'+encodeURIComponent(r.code+'.T')+'/history/';anchor.target='_blank';anchor.rel='noopener noreferrer';anchor.textContent=r.code+' '+r.info.name;name.appendChild(anchor);
   td(r.info.sector||'—');td(fmt(m.multiple,2)+'倍','pos');td(m.low_date);td(fmt(m.low_close,2)+'円');td(m.peak_date);td(fmt(m.peak_close,2)+'円');td(fmt(years(m.low_date,m.peak_date),2)+'年');
   td(fmt(m.from_start_multiple,2)+'倍 / '+fmt(m.from_peak_percent,1)+'%');
   let action=td(''),b=document.createElement('button');b.textContent='研究台帳に転記';b.type='button';b.addEventListener('click',()=>transfer(r,m));action.appendChild(b);body.appendChild(tr);
 });
 const all=Object.values(data.results||{}).filter(r=>r.metrics?.[term]),count10=all.filter(r=>r.metrics[term].multiple>=10).length,count5=all.filter(r=>r.metrics[term].multiple>=5).length;
 $('tbTenCount').textContent=fmt(count10,0);$('tbFiveCount').textContent=fmt(count5,0);
 $('tbMatched').textContent=fmt(rows.length,0);$('tbDataCount').textContent=fmt(data.scanned_count,0)+' / '+fmt(data.universe_count,0);
 $('tbShown').textContent=fmt(rows.length,0)+'件一致・'+fmt(Math.min(rows.length,limit),0)+'件表示。株価の「前の安値→後の高値」の理論上の最大上昇倍率。';
 $('tbMore').hidden=limit>=rows.length;$('tbCsv').disabled=!rows.length;
 $('tbUpdated').textContent='更新：'+data.generated_at.replace('T',' ')+'（日本時間）／直近'+term+'年間で算出';
 $('tbStatus').textContent='調査済み'+fmt(data.scanned_count,0)+'銘柄／現行上場の調査対象'+fmt(data.universe_count,0)+'銘柄。未調査銘柄はランキングに含まれません。';
}
function transfer(r,m){
 const values={code:r.code,name:r.info.name,theme:r.info.sector,start:m.low_date,end:m.peak_date,p0:m.low_close,p1:m.peak_close,source:'https://finance.yahoo.com/quote/'+r.code+'.T'+'/history/',caseMemo:'過去'+$('tbYears').value+'年間の後知恵の安値→高値を転記。起点時点で観測できた情報は未検証。'};
 let b=document.querySelector('[data-tab="cases"]');if(b)b.click();
 for(const [key,value] of Object.entries(values)){let e=$(key);if(e)e.value=value;}
 $('caseInfo').textContent='過去の株価を入力しました。分割調整や時点情報を検証後、登録してください。';
 $('caseForm').scrollIntoView({behavior:'smooth',block:'start'});
}
function downloadCsv(){
 const keys=['code','name','sector','term','multiple','low_date','low_close','peak_date','peak_close','start_date','start_close','last_date','last_close','from_start_multiple','from_peak_percent','checked'];
 const esc=x=>'"'+String(x??'').replace(/"/g,'""')+'"',term=$('tbYears').value;
 let lines=[keys.map(esc).join(',')];
 matched.forEach(r=>{let m=r.metrics[term],row={code:r.code,name:r.info.name,sector:r.info.sector,term,...m,checked:r.checked};lines.push(keys.map(k=>esc(row[k])).join(','));});
 let url=URL.createObjectURL(new Blob(['\uFEFF'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'}));
 let a=document.createElement('a');a.href=url;a.download='jp-tenbaggers-'+term+'years.csv';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
['tbYears','tbMin','tbIndustry','tbSearch','tbSort'].forEach(id=>$(id).addEventListener('input',()=>{limit=100;render();}));
$('tbMore').addEventListener('click',()=>{limit+=100;render();});
$('tbCsv').addEventListener('click',downloadCsv);
fetch('./jp-tenbaggers.json?v='+Date.now(),{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.json();}).then(result=>{
 if(!result.results||!result.catalog)throw Error('データ形式が不正です');
 data=result;
 let sectors=[...new Set(Object.values(data.catalog).map(v=>v.sector).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ja'));
 sectors.forEach(sector=>{let opt=document.createElement('option');opt.textContent=sector;opt.value=sector;$('tbIndustry').appendChild(opt);});
 render();
}).catch(error=>{$('tbStatus').textContent='履歴データがまだ作成されていないか、取得に失敗しました：'+error.message+'。下の参照先でも一覧を確認できます。';});
})();