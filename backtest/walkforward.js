'use strict';
(async()=>{
const $=id=>document.getElementById(id);
const n=(x,d=3)=>Number.isFinite(x)?x.toFixed(d):'—';
const p=x=>Number.isFinite(x)?(x>0?'+':'')+n(x)+'%':'—';
const sign=x=>x>0?'pos':x<0?'neg':'';
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const td=x=>'<td>'+x+'</td>';
try{
  const r=await fetch('./data/walkforward-state.json?rev='+Date.now(),{cache:'no-store'});
  if(!r.ok)throw Error('HTTP '+r.status);
  const s=await r.json();if(s.version!==1||!s.baseline||!Array.isArray(s.evaluations))throw Error('結果の形式が不正です');
  $('baseline').textContent=s.baseline.dates.map(x=>x.slice(5)).join(' / ');
  $('days').textContent=s.oosSummary.days+'日';
  $('profit').textContent=p(s.oosSummary.profitPct);
  $('profit').className='val '+sign(s.oosSummary.profitPct);
  $('winrate').textContent=n(s.oosSummary.winRatePct,1)+'%';
  $('status').textContent='初期学習：'+s.baseline.dates[0]+'〜'+s.baseline.dates.at(-1)+
    '（'+s.baseline.trades+'取引）／学習時の損益 '+p(s.baseline.profitPct)+'。'+
    '未学習日 '+s.oosSummary.days+'日を評価済み。'+
    (s.sourceRevisionWarnings?.length?'過去データ改訂の警告：'+s.sourceRevisionWarnings.join('、'):'');
  $('costRows').innerHTML=(s.oosCostSensitivity||[]).map(x=>'<tr>'+td(n(x.costPct,2)+'%')+
    '<td class="'+sign(x.profitPct)+'">'+p(x.profitPct)+'</td>'+td(x.trades)+'</tr>').join('');
  $('dayRows').innerHTML=s.evaluations.map(x=>'<tr>'+td(safe(x.date))+td(safe(x.modelTrainedThrough))+
    td(x.trades)+td(x.winRatePct==null?'—':n(x.winRatePct,1)+'%')+
    '<td class="'+sign(x.profitPct)+'">'+p(x.profitPct)+'</td>'+td(n(x.score))+'</tr>').join('')||'<tr><td colspan="6">未実施</td></tr>';
  const trades=s.evaluations.flatMap(x=>(x.tradeLog||[]).map(t=>({...t,date:x.date})));
  $('tradeRows').innerHTML=trades.map(t=>'<tr>'+td(safe(t.date))+td(safe(t.entry.slice(11)))+
    td(n(t.entryPrice,2))+td(safe(t.exit.slice(11)))+td(n(t.exitPrice,2))+
    td(safe(t.reason))+'<td class="'+sign(t.netPct)+'">'+p(t.netPct)+'</td></tr>').join('')||
    '<tr><td colspan="7">記録された売買はありません</td></tr>';
  $('pending').textContent='次の再学習まで '+Math.max(0,3-s.pendingDates.length)+'取引日。'+
    (s.pendingDates.length?'現在の保留日：'+s.pendingDates.join('、'):'初見検証済みの保留日はありません。')+
    ' 現在の学習済み最終日：'+s.trainedThrough;
  $('retrainRows').innerHTML=(s.retrainings||[]).map(x=>'<tr>'+td(safe(x.dates.join('・')))+
    td(n(x.score))+'<td class="'+sign(x.profitPct)+'">'+p(x.profitPct)+'</td>'+td(x.trades)+'</tr>').join('')||
    '<tr><td colspan="4">次の3取引日が揃うまで再学習は行いません。</td></tr>';
}catch(e){$('status').textContent='結果の読込に失敗しました：'+e.message;}
})();