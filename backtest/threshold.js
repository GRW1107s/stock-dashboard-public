/* Controls the 3-day score-only search of x% dip entries and y% profit exits. */
(()=>{
'use strict';
const E=globalThis.__THRESHOLD_ENGINE__,$=id=>document.getElementById(id);
const KEY='taiyo-xy-three-day-v2';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,d=3)=>Number.isFinite(n)?n.toFixed(d):'—';
const pct=(n,d=3)=>Number.isFinite(n)?((n>0?'+':'')+n.toFixed(d)+'%'):'—';
let sourceDays=[],days=[],state=null,busy=false,cost=0.10,example=null;
function load(){
  try{
    const p=JSON.parse(localStorage.getItem(KEY)||'null');
    return p?.params&&Number.isFinite(p.params.x)&&Number.isFinite(p.params.y)?p:null;
  }catch(_){return null;}
}
function save(){try{state?localStorage.setItem(KEY,JSON.stringify(state)):localStorage.removeItem(KEY);}catch(_){}}
function key(ds){return ds.map(d=>d.date+':'+d.am.length+':'+d.pm.length+':'+(d.pm.at(-1)||d.am.at(-1))?.t).join('/');}
function setButtons(){
  const ready=days.length>0;
  $('start').disabled=busy||!ready;
  $('continue').disabled=busy||!ready||!state;
  $('reset').disabled=busy||!state;
  $('export').disabled=busy||!state;
  for(const id of ['initialX','initialY','rounds','population','cost'])$(id).disabled=busy;
}
function lineChart(rows){
  const svg=$('scoreChart');
  if(!rows?.length){svg.innerHTML='<text x="20" y="36" fill="#64748b">学習記録はまだありません</text>';return;}
  const values=rows.map(x=>x.best),mn=Math.min(...values),mx=Math.max(...values),span=mx-mn||1;
  const points=values.map((v,i)=>[40+i/Math.max(1,values.length-1)*572,208-(v-mn)/span*170]
    .map(n=>n.toFixed(2)).join(',')).join(' ');
  svg.innerHTML='<line x1="40" y1="208" x2="612" y2="208" stroke="#d1daea"/>'+
    '<polyline points="'+points+'" fill="none" stroke="#245bc7" stroke-width="2.5" stroke-linejoin="round"/>'+
    '<text x="18" y="19" font-size="12" fill="#64748b">最高 '+fmt(mx,2)+'点</text>'+
    '<text x="18" y="243" font-size="12" fill="#64748b">最低 '+fmt(mn,2)+'点</text>';
}
function present(){
  setButtons();
  if(!state||!days.length){
    for(const id of ['bestX','bestY','bestScore','total','wins','trades','dd'])$(id).textContent='—';
    $('historyRows').innerHTML='<tr><td colspan="8" style="text-align:left">未学習</td></tr>';
    $('tradeRows').innerHTML='<tr><td colspan="7" style="text-align:left">未学習</td></tr>';
    lineChart([]);
    return;
  }
  try{
    const r=E.replay(state.params,days,cost,true);
    $('bestX').textContent=fmt(state.params.x,3)+'%';
    $('bestY').textContent=fmt(state.params.y,3)+'%';
    $('bestScore').textContent=fmt(r.score,3);
    $('total').textContent=pct(r.total);
    $('wins').textContent=r.winRate===null?'—':fmt(r.winRate,1)+'%';
    $('trades').textContent=String(r.n);
    $('dd').textContent=pct(r.drawdown);
    const history=state.windowKey===key(days)&&state.cost===cost?state.history||[]:[];
    $('historyRows').innerHTML=history.length?history.slice(-35).reverse().map(z=>
      '<tr><td>'+z.round+'</td><td>'+fmt(z.best)+'</td><td>'+fmt(z.average)+'</td><td>'+
      fmt(z.x)+'</td><td>'+fmt(z.y)+'</td><td class="'+(z.profit>=0?'pos':'neg')+'">'+pct(z.profit)+
      '</td><td>'+z.trades+'</td><td>'+(z.improved?'更新':'—')+'</td></tr>').join(''):
      '<tr><td colspan="8" style="text-align:left">この期間の学習履歴はありません</td></tr>';
    $('tradeRows').innerHTML=r.trades.length?r.trades.map(t=>
      '<tr><td>'+esc(t.date)+'</td><td>'+esc(t.entry.slice(11,16))+'</td><td>'+
      fmt(t.entryPrice,1)+'</td><td>'+esc(t.exit.slice(11,16))+'</td><td>'+
      fmt(t.exitPrice,1)+'</td><td>'+esc(t.reason)+'</td><td class="'+(t.net>=0?'pos':'neg')+
      '">'+pct(t.net)+'</td></tr>').join(''):
      '<tr><td colspan="7" style="text-align:left">売買はありません</td></tr>';
    lineChart(history);
  }catch(e){
    $('progress').className='message warn';$('progress').textContent='表示エラー：'+e.message;
  }
}
function holdout(){
  if(!state||!sourceDays.length){$('holdout').textContent='学習した3日より新しい取引日が追加されると、未学習日の結果を表示します。';return;}
  const newDays=state.trainedThrough?sourceDays.filter(d=>d.date>state.trainedThrough):[];
  if(newDays.length){
    const r=E.replay(state.params,newDays,state.cost);
    $('holdout').className='message warn';
    $('holdout').textContent='学習未使用日 '+newDays[0].date+'〜'+newDays.at(-1).date+
      '（'+newDays.length+'取引日）で x='+fmt(state.params.x)+'%、y='+fmt(state.params.y)+
      '%を固定した結果：損益 '+pct(r.total)+'、得点 '+fmt(r.score)+'、取引 '+r.n+
      '回、勝率 '+(r.winRate===null?'—':fmt(r.winRate,1)+'%')+'。追加学習前の評価値です。';
  }else if(state.holdouts?.length){
    const x=state.holdouts.at(-1);
    $('holdout').className='message';
    $('holdout').textContent='前回記録した初見検証：'+x.from+'〜'+x.to+
      '、x='+fmt(x.params.x)+'%、y='+fmt(x.params.y)+'%、損益 '+pct(x.total)+'、取引 '+x.n+'回。';
  }else{
    $('holdout').className='message warn';
    $('holdout').textContent='まだ新しい未使用日はありません。同じ3日での得点上昇は期間内最適化です。';
  }
}
function capture(){
  if(!state?.trainedThrough)return;
  const newDays=sourceDays.filter(d=>d.date>state.trainedThrough);
  if(!newDays.length)return;
  const r=E.replay(state.params,newDays,state.cost);
  state.holdouts=[...(state.holdouts||[]),{from:newDays[0].date,to:newDays.at(-1).date,
    params:{...state.params},total:r.total,score:r.score,n:r.n,drawdown:r.drawdown,
    winRate:r.winRate}].slice(-40);
}
async function learn(restart){
  if(busy||!days.length)return;
  const c=Number($('cost').value),rounds=Number($('rounds').value),
    population=Number($('population').value);
  const initial={x:Number($('initialX').value),y:Number($('initialY').value)};
  if(!(c>=0&&c<=2)||!Number.isFinite(c)||!(initial.x>=E.X_MIN&&initial.x<=E.X_MAX)||
     !(initial.y>=E.Y_MIN&&initial.y<=E.Y_MAX)||!Number.isFinite(initial.x)||!Number.isFinite(initial.y)){
    $('progress').className='message warn';
    $('progress').textContent='xは0.15〜3%、yは0.10〜3.5%、往復コストは0〜2%で指定してください。';return;
  }
  if(restart){state=null;save();}
  else capture();
  cost=c;const current=key(days);
  if(state&&(state.windowKey!==current||state.cost!==cost)){
    state={params:{...state.params},rounds:0,history:[],attempts:state.attempts||0,
      holdouts:state.holdouts||[],windowKey:current,cost,seed:0};
  }
  busy=true;setButtons();$('progress').className='message';
  try{
    for(let n=0;n<rounds;n++){
      const old=state;
      const result=E.train(days,old,1,population,cost,initial);
      state={...result,windowKey:current,cost,attempts:(old?.attempts||0)+population,
        trainedThrough:days.at(-1).date,holdouts:old?.holdouts||[],seed:0};
      save();
      if(n%2===0||n===rounds-1){
        $('progress').textContent=(n+1)+'/'+rounds+'回、得点 '+fmt(state.score)+
          '。現在の x='+fmt(state.params.x)+'%、y='+fmt(state.params.y)+'%。';
        present();
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
    $('progress').className='message warn';
    $('progress').textContent='学習完了：累計'+state.attempts+'候補を試行。最良 x='+
      fmt(state.params.x)+'%、y='+fmt(state.params.y)+'%、得点 '+fmt(state.score)+
      '。同じ期間の学習成績であり、未使用日での勝率はまだ不明です。';
    holdout();
  }catch(e){
    $('progress').className='message warn';$('progress').textContent='学習エラー：'+e.message;
  }finally{busy=false;present();setButtons();}
}
function showExample(){
  if(!example||!sourceDays.length)return;
  const dates=sourceDays.slice(-3).map(x=>x.date);
  if(dates.join('/')!==example.dates.map(x=>x.date).join('/')){
    $('previewMessage').className='message warn';
    $('previewMessage').textContent='公開済みの学習例は現在の最新3日と日付が違うため、比較できません。';
    return;
  }
  $('previewMessage').className='message warn';
  $('previewMessage').textContent='実データでの学習例（'+example.rounds+'回・'+example.candidates+
    '候補、期間内のみ）：初期 x='+fmt(example.initial.x)+'%／y='+fmt(example.initial.y)+
    '%、得点 '+fmt(example.initial.score)+' → 学習後 x='+fmt(example.final.x)+
    '%／y='+fmt(example.final.y)+'%、得点 '+fmt(example.final.score)+
    '、合計損益 '+pct(example.final.total)+'、取引 '+example.final.n+
    '回。未知の取引日での検証ではありません。';
}
$('start').addEventListener('click',()=>learn(true));
$('continue').addEventListener('click',()=>learn(false));
$('reset').addEventListener('click',()=>{
  if(busy)return;state=null;save();present();holdout();
  $('progress').className='message';$('progress').textContent='学習結果を初期化しました。';
});
$('cost').addEventListener('change',()=>{
  const c=Number($('cost').value);if(!Number.isFinite(c)||c<0||c>2)return;
  cost=c;present();holdout();
});
$('export').addEventListener('click',()=>{
  if(!state)return;
  const payload={symbol:'6976.T',strategy:'x-percent-30m-drop-buy-y-percent-profit-sell',
    exportedAt:new Date().toISOString(),trainedThrough:state.trainedThrough,
    params:state.params,score:state.score,rounds:state.rounds,attempts:state.attempts,
    cost:state.cost,history:state.history,holdouts:state.holdouts||[]};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download='taiyo-6976-xy-episode.json';a.click();URL.revokeObjectURL(a.href);
});
state=load();
fetch('./data/threshold-preview.json?rev='+Date.now(),{cache:'no-store'})
  .then(r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.json();})
  .then(x=>{example=x;showExample();}).catch(()=>{
    $('previewMessage').className='message warn';
    $('previewMessage').textContent='自動学習の公開例は準備中です。手動での学習は使用できます。';
  });
fetch('./data/taiyo-yuden-1m.json?rev='+Date.now(),{cache:'no-store'})
  .then(r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.json();})
  .then(data=>{
    if(data.symbol!=='6976.T'||data.interval!=='1m'||!Array.isArray(data.bars))throw Error('保存データが不正です。');
    sourceDays=E.groupSessions(data.bars);days=sourceDays.slice(-3);
    $('dayCount').textContent=days.length+'日';
    $('barCount').textContent=days.reduce((n,d)=>n+d.am.length+d.pm.length,0).toLocaleString('ja-JP');
    const partial=days.filter(d=>d.am.length<143||d.pm.length<172);
    $('dataMessage').className='message '+(partial.length||days.length<3?'warn':'');
    $('dataMessage').textContent=days.length?
      '対象：'+days.map(d=>d.date+'（'+(d.am.length+d.pm.length)+'本）').join('、')+
      '。部分データ '+partial.length+'日。'+(days.length<3?'3日未満の暫定学習です。':'最新3取引日を繰り返し再生します。'):
      '検証できる1分足が足りません（同一場内で60本以上必要）。';
    if(state&&Number.isFinite(state.cost)){$('cost').value=state.cost;cost=state.cost;}
    present();holdout();showExample();
  }).catch(e=>{
    $('dataMessage').className='message warn';$('dataMessage').textContent='実データの読み込みに失敗：'+e.message;
    setButtons();
  });
})();
