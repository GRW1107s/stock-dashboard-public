/* Multiple checked strategies, one interval per comparison, no fabricated market bars. */
(()=>{
'use strict';
const E=globalThis.__STOCK_STRATEGY_ENGINE__;
const $=id=>document.getElementById(id);
const fmt=(v,d=2)=>Number.isFinite(v)?v.toFixed(d):'—';
const pc=v=>Number.isFinite(v)?(v>0?'+':'')+fmt(v,3)+'%':'—';
const hue=v=>v>0?'pos':v<0?'neg':'';
const names={'1m':'1分足','5m':'5分足','15m':'15分足','1h':'1時間足','1d':'日足'};
const dataCache=new Map();
const groupOptions=(side,defaultIds)=>E.STRATEGIES.map(strategy=>
 '<label title="'+strategy.detail.replace(/"/g,'&quot;')+'"><input type="checkbox" value="'+strategy.id+'" '+
 (defaultIds.includes(strategy.id)?'checked':'')+'><span class="strategy-title">'+strategy.name+'</span></label>'
 ).join('');
$('buyChecks').innerHTML=groupOptions('buy',['ma25-revert']);
$('sellChecks').innerHTML=groupOptions('sell',['ma25-revert']);
let loadIndex=0;
async function getData(interval){
 if(dataCache.has(interval))return dataCache.get(interval);
 const r=await fetch('./data/taiyo-yuden-'+interval+'.json?update='+Date.now(),{cache:'no-store'});
 if(!r.ok)throw Error('HTTP '+r.status);
 const j=await r.json();
 if(j.interval!==interval||j.symbol!=='6976.T'||!Array.isArray(j.bars))throw Error('不正な市場データ形式');
 if(!j.bars.length)throw Error('この時間足はまだ実データが取得できていません');
 dataCache.set(interval,j);return j;
}
function renderResults(interval,j,cost,combo,settings){
 const d=E.analyze(j.bars,interval,[],cost,combo,settings);
 $('barCount').textContent=d.bars.toLocaleString('ja-JP')+'本';
 $('dayCount').textContent=d.days.toLocaleString('ja-JP')+'日';
 $('dateRange').textContent=(d.first||'—')+'〜'+(d.last||'—');
 $('selectedInterval').textContent=names[interval];
 $('resultRows').innerHTML=d.results.map(result=>{
  const f=result.full,h=result.holdout;
  const cell=(value,cls='')=>'<td'+(cls?' class="'+cls+'"':'')+'>'+value+'</td>';
  return '<tr'+(result.id==='combined'?' class="combined-result"':'')+'>'+cell(result.name)+cell(f.count)+
    cell(f.longCount+'／'+f.shortCount)+cell(f.overnightCount)+
    cell(f.winRate==null?'—':fmt(f.winRate,1)+'%')+
    cell(pc(f.total),hue(f.total))+cell(pc(f.avg),hue(f.avg))+
    cell(pc(f.drawdown),hue(f.drawdown))+cell(h?h.count:'—')+
    cell(h?pc(h.total):'—',h?hue(h.total):'')+
    cell(h&&h.winRate!==null?fmt(h.winRate,1)+'%':'—')+'</tr>';
 }).join('');
 const comboRow=d.results.find(x=>x.id==='combined');
 if(comboRow){
  const full=comboRow.full,held=comboRow.holdout;
  $('comboSummary').className='message'+(full.count<5?' warn':'');
  $('comboSummary').textContent='買い：'+combo.buyIds.map(id=>E.STRATEGIES.find(x=>x.id===id)?.name).join(' AND ')+
   '／売り：'+combo.sellIds.map(id=>E.STRATEGIES.find(x=>x.id===id)?.name).join(' AND ')+
   '。全期間 '+full.count+'取引（買い建て'+full.longCount+'、空売り'+full.shortCount+'、翌日持ち越し'+full.overnightCount+'）、損益 '+pc(full.total)+
   (held?'、後半期間 '+held.count+'取引・損益 '+pc(held.total):'')+
   (full.count<5?'。取引が少なく評価には不十分です。':'。');
  $('comboTrades').innerHTML=full.trades.length?full.trades.slice(-20).reverse().map(tr=>
   '<tr><td>'+(tr.side==='short'?'空売り':'買い建て')+'</td><td>'+tr.date+'</td>'+
   '<td>'+tr.entry.slice(11,16)+'</td><td>'+fmt(tr.entryPrice,2)+'</td>'+
   '<td>'+tr.exit.replace('T',' ')+'</td><td>'+fmt(tr.exitPrice,2)+'</td>'+
   '<td>'+tr.reason+'</td><td class="'+hue(tr.net)+'">'+pc(tr.net)+'</td></tr>').join(''):
   '<tr><td colspan="8" style="text-align:left">この条件では売買が成立しませんでした。</td></tr>';
 }else{
  $('comboSummary').className='message warn';
  $('comboSummary').textContent='買い条件と売り条件をそれぞれ1つ以上選択してください。';
  $('comboTrades').innerHTML='<tr><td colspan="8">組み合わせ未設定</td></tr>';
 }
 const terms=d.testDays?('後半'+d.testDays+'取引日についても比較しています。'):'取引日が5日未満のため後半期間の比較は保留です。';
 $('status').className='message'+(d.days<5?' warn':'');
 $('status').textContent=names[interval]+'の実足'+d.bars.toLocaleString('ja-JP')+
  '本・'+d.days+'取引日を使用。チェックした売買条件（すべてAND）、'+
  (settings.allowShort?'空売り可':'買い建てのみ')+'・'+
  (settings.holdOvernight?'持ち越し可':'当日手仕舞い')+'で検証しました。'+terms+
  (j.updated_at?'（データ更新 '+j.updated_at.slice(0,16)+'）':'');
}
async function refresh(recompute=true){
 const id=++loadIndex,interval=$('interval').value;
 const combo={buyIds:[...document.querySelectorAll('#buyChecks input:checked')].map(x=>x.value),
  sellIds:[...document.querySelectorAll('#sellChecks input:checked')].map(x=>x.value)};
 const settings={allowShort:$('allowShort').checked,holdOvernight:$('holdOvernight').checked};
 const hasCombo=combo.buyIds.length>0&&combo.sellIds.length>0;
 $('selectedInterval').textContent=names[interval];
 $('run').disabled=true;$('status').className='message';
 $('status').textContent=names[interval]+'のデータを読み込んでいます…';
 if(!hasCombo){$('status').className='message warn';$('status').textContent='買い条件と売り条件をそれぞれ1つ以上選んでください。';$('resultRows').innerHTML='<tr><td colspan="11">戦略未選択</td></tr>';$('comboSummary').textContent='買い条件と売り条件を設定してください。';$('comboTrades').innerHTML='<tr><td colspan="8">未設定</td></tr>';$('run').disabled=false;return;}
 const cost=Number($('cost').value);
 if(!Number.isFinite(cost)||cost<0||cost>2){$('status').className='message warn';$('status').textContent='往復コストは0〜2%で入力してください。';return;}
 try{
  const data=await getData(interval);if(id!==loadIndex)return;
  renderResults(interval,data,cost,combo,settings);
 }catch(e){
  if(id!==loadIndex)return;
  $('barCount').textContent='—';$('dayCount').textContent='—';$('dateRange').textContent='—';
  $('status').className='message warn';$('status').textContent=names[interval]+'の検証は実行できません：'+e.message;
  $('resultRows').innerHTML='<tr><td colspan="11" style="text-align:left">実データ未取得のため、この時間足の成績は表示しません。</td></tr>';
 }finally{if(id===loadIndex)$('run').disabled=false;}
}
$('interval').addEventListener('change',()=>refresh());
$('run').addEventListener('click',()=>refresh());
$('buyChecks').addEventListener('change',()=>refresh());
$('sellChecks').addEventListener('change',()=>refresh());
$('cost').addEventListener('change',()=>refresh());
$('allowShort').addEventListener('change',()=>refresh());
$('holdOvernight').addEventListener('change',()=>refresh());
refresh();
})();
