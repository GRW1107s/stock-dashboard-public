'use strict';
(async()=>{
const $=id=>document.getElementById(id);
const n=(v,d=2)=>Number.isFinite(v)?v.toFixed(d):'—';
const pct=v=>Number.isFinite(v)?(v>0?'+':'')+n(v,3)+'%':'—';
const klass=v=>v>0?'pos':v<0?'neg':'';
const td=(v,c='')=>'<td'+(c?' class="'+c+'"':'')+'>'+v+'</td>';
try{
 const response=await fetch('./data/taiyo-yuden-5m-report.json?rev='+Date.now(),{cache:'no-store'});
 if(!response.ok)throw Error('HTTP '+response.status);
 const r=await response.json();
 if(r.version!==1||r.interval!=='5m')throw Error('データ形式が一致しません');
 $('bars').textContent=r.candleCount.toLocaleString('ja-JP')+'本';
 $('days').textContent=r.completeDays+'日';
 $('trainDays').textContent=r.trainDays.length+'日';
 $('testDays').textContent=r.testDays.length+'日';
 $('range').textContent='取得範囲：'+(r.firstDate||'—')+'〜'+(r.lastDate||'—')+
   '／実データの取引日 '+r.availableDays+'日／候補 '+r.gridSize+'通り';
 if(r.status!=='ok'){
  $('status').textContent='5分足の確定データが不足しているため、まだ有効な期間外検証は計算できません。現在の状態：'+r.status;
  return;
 }
 $('status').textContent='5分足の実データから、古い'+r.trainDays.length+
  '取引日でx・yを選択し、新しい'+r.testDays.length+'取引日で固定検証しました。';
 const t=r.bestTraining,h=r.holdout;
 $('x').textContent=n(t.x)+'%';
 $('y').textContent=n(t.y)+'%';
 $('trainProfit').textContent=pct(t.profitPct);
 $('testProfit').textContent=pct(h.profitPct);
 $('testProfit').className=klass(h.profitPct);
 $('holdoutMessage').textContent='x='+n(t.x)+'%・y='+n(t.y)+'%を変更せずに、'+
  r.testDays[0]+'〜'+r.testDays.at(-1)+'で取引 '+h.trades+'回、勝率 '+
  (h.winRatePct===null?'—':n(h.winRatePct,1)+'%')+'、損益合計 '+pct(h.profitPct)+
  '。学習時の利益をそのまま評価に使っていません。';
 const w=r.oos;
 $('walkStatus').textContent='検証'+w.segments+'区間、各区間の取引回数の合計'+w.trades+
  '回、損益単純合計 '+pct(w.profitPct)+'、勝率 '+(w.winRatePct===null?'—':n(w.winRatePct,1)+'%')+
  '。学習期間を進める際にも未来の3日を使っていません。';
 $('walkRows').innerHTML=r.walkForward.map(x=>'<tr>'+td(x.test[0]+'〜'+x.test.at(-1))+
  td(x.selected?n(x.selected.x)+'%':'—')+td(x.selected?n(x.selected.y)+'%':'—')+
  td(x.testResult?pct(x.testResult.profitPct):'取引不足',klass(x.testResult?.profitPct))+
  td(x.testResult?.trades??'—')+td(x.testResult?.winRatePct==null?'—':n(x.testResult.winRatePct,1)+'%')+'</tr>').join('');
 $('topRows').innerHTML=(r.topTraining||[]).map((x,i)=>'<tr>'+td(i+1)+td(n(x.x)+'%')+
  td(n(x.y)+'%')+td(n(x.score,3))+td(pct(x.profitPct),klass(x.profitPct))+td(x.trades)+'</tr>').join('');
 $('costRows').innerHTML=(r.costSensitivity||[]).map(x=>'<tr>'+td(n(x.costPct,2)+'%')+
  td(pct(x.profitPct),klass(x.profitPct))+td(x.trades)+'</tr>').join('');
}catch(e){
 $('status').textContent='5分足の結果を読み込めません：'+e.message+'。データ取得と検証処理の状況を確認してください。';
}
})();
