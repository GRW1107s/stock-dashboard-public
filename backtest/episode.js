/* Browser controller for score-only 3-day episode policy learning. */
(()=>{
  'use strict';
  const E=globalThis.__EPISODE_ENGINE__, $=id=>document.getElementById(id);
  const STORAGE='taiyo-episode-learning-v1';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number=(n,d=2)=>Number.isFinite(n)?n.toFixed(d):'—';
  const pct=(n,d=3)=>Number.isFinite(n)?((n>0?'+':'')+n.toFixed(d)+'%'):'—';
  let sourceDays=[],days=[],state=null,busy=false,cost=0.10;
  function load(){
    try{
      const old=JSON.parse(localStorage.getItem(STORAGE)||'null');
      return Array.isArray(old?.weights)&&old.weights.length===E.POLICY_LENGTH
        &&old.weights.every(Number.isFinite)?old:null;
    }catch(_){return null;}
  }
  function persist(){try{state?localStorage.setItem(STORAGE,JSON.stringify(state)):localStorage.removeItem(STORAGE);}catch(_){}}
  function windowKey(ds){return ds.map(d=>d.date+':'+d.am.length+':'+d.pm.length+':'+(d.pm.at(-1)||d.am.at(-1))?.t).join('/');}
  function buttons(){
    const available=days.length>0;
    $('start').disabled=busy||!available;
    $('continue').disabled=busy||!available||!state;
    $('reset').disabled=busy||!state;
    $('export').disabled=busy||!state;
    for(const id of ['rounds','population','cost'])$(id).disabled=busy;
  }
  function preview(stateToShow){
    if(!stateToShow||!days.length){
      for(const id of ['profit','winrate','trades','dd','fitness'])$(id).textContent='—';
      $('episodes').textContent='0';
      $('historyRows').innerHTML='<tr><td colspan="8" style="text-align:left">未学習</td></tr>';
      $('tradeRows').innerHTML='<tr><td colspan="7" style="text-align:left">未学習</td></tr>';
      $('scoreChart').innerHTML='<text x="20" y="38" fill="#64748b">学習後に表示</text>';
      buttons();return;
    }
    const st=E.replay(stateToShow.weights,days,cost,true);
    $('fitness').textContent=number(st.fitness,3);
    $('profit').textContent=pct(st.total);
    $('winrate').textContent=st.winRate===null?'—':number(st.winRate,1)+'%';
    $('trades').textContent=String(st.n);
    $('dd').textContent=pct(st.dd);
    $('episodes').textContent=String(stateToShow.attempts||0);
    const hist=stateToShow.windowKey===windowKey(days)?stateToShow.history||[]:[];
    $('historyRows').innerHTML=hist.length?hist.slice(-25).reverse().map(x=>'<tr>'+
      '<td>'+x.round+'</td><td>'+number(x.best,3)+'</td><td>'+number(x.mean,3)+'</td><td>'+number(x.generationBest,3)+'</td>'+
      '<td class="'+(x.profit>=0?'pos':'neg')+'">'+pct(x.profit)+'</td>'+
      '<td>'+pct(x.drawdown)+'</td><td>'+x.trades+'</td><td>'+(x.improved?'更新':'—')+'</td></tr>').join(''):
      '<tr><td colspan="8" style="text-align:left">この3日間の学習記録はありません</td></tr>';
    $('tradeRows').innerHTML=st.trades.length?st.trades.map(t=>'<tr><td>'+esc(t.date)+'</td><td>'+esc(t.entry.slice(11,16))+'</td><td>'+
      number(t.entryPrice,1)+'</td><td>'+esc(t.exit.slice(11,16))+'</td><td>'+number(t.exitPrice,1)+'</td><td>'+esc(t.reason)+'</td>'+
      '<td class="'+(t.net>=0?'pos':'neg')+'">'+pct(t.net)+'</td></tr>').join(''):
      '<tr><td colspan="7" style="text-align:left">取引がありません</td></tr>';
    drawScores(hist);
    buttons();
  }
  function drawScores(hist){
    const svg=$('scoreChart');
    if(!hist.length){svg.innerHTML='<text x="20" y="38" fill="#64748b">この3日間の学習履歴はありません</text>';return;}
    const values=hist.map(x=>x.best),min=Math.min(...values),max=Math.max(...values),span=(max-min)||1;
    const xy=(n,i)=>[49+i/Math.max(1,values.length-1)*568,215-(n-min)/span*170];
    const pts=values.map((v,i)=>xy(v,i).map(n=>n.toFixed(2)).join(',')).join(' ');
    svg.innerHTML='<line x1="49" y1="215" x2="617" y2="215" stroke="#cbd5e1"/>'+
      '<polyline points="'+pts+'" fill="none" stroke="#245bc7" stroke-width="2.5" stroke-linejoin="round"/>'+
      '<text x="16" y="22" font-size="12" fill="#64748b">最高 '+number(max,2)+' 点</text>'+
      '<text x="16" y="240" font-size="12" fill="#64748b">最低 '+number(min,2)+' 点</text>'+
      '<text x="485" y="251" font-size="11" fill="#64748b">'+hist.length+'回の改善履歴</text>';
  }
  function updateHoldout(){
    if(!state||!sourceDays.length){$('holdout').textContent='学習した方策を保存した後、新しい取引日の実データが加われば初見検証できます。';return;}
    const knownThrough=state.trainedThrough;
    const unseen=knownThrough?sourceDays.filter(d=>d.date>knownThrough):[];
    const rows=[...(state.holdouts||[])];
    if(unseen.length){
      const result=E.replay(state.weights,unseen,Number.isFinite(state.cost)?state.cost:cost);
      $('holdout').className='message';
      $('holdout').textContent='未使用の'+unseen.length+'取引日（'+unseen[0].date+'〜'+unseen.at(-1).date+'）：学習済み方策を固定した初見損益 '+pct(result.total)+'／得点 '+number(result.fitness,3)+'／取引 '+result.n+'件／勝率 '+(result.winRate===null?'—':number(result.winRate,1)+'%')+'。この値は追加学習の前に計算しています。';
    }else if(rows.length){
      const x=rows.at(-1);
      $('holdout').className='message';
      $('holdout').textContent='直近の記録：'+x.from+'〜'+x.to+' の初見損益 '+pct(x.profit)+'／得点 '+number(x.score,3)+'／取引 '+x.trades+'件。';
    }else{
      $('holdout').className='message warn';
      $('holdout').textContent='まだ新しい未使用取引日がありません。同じ3日を繰り返す結果はすべて学習期間内成績です。';
    }
  }
  function captureHoldout(){
    if(!state||!state.trainedThrough)return;
    const newDays=sourceDays.filter(d=>d.date>state.trainedThrough);
    if(!newDays.length)return;
    const result=E.replay(state.weights,newDays,Number.isFinite(state.cost)?state.cost:cost);
    state.holdouts=[...(state.holdouts||[]),{from:newDays[0].date,to:newDays.at(-1).date,
      profit:result.total,score:result.fitness,drawdown:result.dd,trades:result.n,winRate:result.winRate}].slice(-50);
  }
  async function learn(fromScratch){
    if(busy||!days.length)return;
    const total=Number($('rounds').value),population=Number($('population').value),requestedCost=Number($('cost').value);
    if(!Number.isFinite(requestedCost)||requestedCost<0||requestedCost>2){
      $('progress').className='message warn';$('progress').textContent='往復コストは0〜2%に設定してください。';return;
    }
    cost=requestedCost;
    if(fromScratch){state=null;persist();}
    else captureHoldout();
    const key=windowKey(days);
    // Preserve only the learned weights and lifetime attempts across windows.
    // Do not graph scores from different price windows/cost settings together.
    if(state&&(state.windowKey!==key||state.cost!==cost)){
      state={weights:state.weights,rounds:0,history:[],attempts:state.attempts||0,
        holdouts:state.holdouts||[],cost,seed:state.seed||0,windowKey:key};
    }
    busy=true;buttons();
    $('progress').className='message';
    try{
      for(let n=0;n<total;n++){
        const prior=state;
        const next=E.train(days,prior,1,population,cost);
        state={...next,seed:prior?.seed||0,attempts:(prior?.attempts||0)+population,
          windowKey:key,trainedThrough:days.at(-1).date,cost,
          holdouts:prior?.holdouts||[]};
        persist();
        if(n===total-1||n%2===0){
          $('progress').textContent=(n+1)+' / '+total+'回を終了。候補の累計評価 '+state.attempts+'回、最高得点 '+number(state.score,3)+'。最終得点だけで次の方策を選択しています。';
          preview(state);
          await new Promise(resolve=>setTimeout(resolve,0));
        }
      }
      $('progress').className='message warn';
      $('progress').textContent='学習完了：'+state.rounds+'回、候補の累計評価 '+state.attempts+'回。最高得点 '+number(state.score,3)+'。これらは同一3日間の学習成績であり、利益の再現性は未検証です。';
      updateHoldout();
    }catch(e){
      $('progress').className='message warn';$('progress').textContent='学習処理でエラー：'+e.message;
    }finally{busy=false;preview(state);buttons();}
  }
  $('start').addEventListener('click',()=>learn(true));
  $('continue').addEventListener('click',()=>learn(false));
  $('reset').addEventListener('click',()=>{
    if(busy)return;state=null;persist();preview(null);updateHoldout();
    $('progress').className='message';$('progress').textContent='学習結果を初期化しました。';
  });
  $('cost').addEventListener('change',()=>{
    const c=Number($('cost').value);if(!Number.isFinite(c)||c<0||c>2)return;
    cost=c;preview(state);updateHoldout();
  });
  $('export').addEventListener('click',()=>{
    if(!state)return;
    const body=JSON.stringify({symbol:'6976.T',kind:'score-only-episode-policy',savedAt:new Date().toISOString(),
      learnedThrough:state.trainedThrough,window:state.windowKey,policy:state.weights,
      totalEpisodes:state.attempts,score:state.score,cost:state.cost,holdouts:state.holdouts||[]},null,2);
    const blob=new Blob([body],{type:'application/json;charset=utf-8'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);
    a.download='taiyo-6976-episode-policy.json';a.click();URL.revokeObjectURL(a.href);
  });
  function showExample(p){
    if(!p||!Array.isArray(p.dates)||!sourceDays.length)return;
    const actual=sourceDays.slice(-3).map(d=>d.date);
    if(actual.join('/')!==p.dates.map(d=>d.date).join('/')){
      $('examplePreview').className='message warn';
      $('examplePreview').textContent='公開済みの30回試行例は現在のデータと日付が異なるため、比較対象外です。';
      return;
    }
    $('examplePreview').className='message warn';
    $('examplePreview').textContent='実データでの試行例（'+p.generations+'回 × '+p.population+'候補、初見検証ではありません）：'+
      '初期得点 '+number(p.initial.score,3)+' → 学習後 '+number(p.final.score,3)+
      '（改善 '+number(p.improvement,3)+'点）。学習期間内の合計損益 '+pct(p.final.totalPct)+
      '／売買 '+p.final.tradeCount+'回。繰り返し得点が上がっても、将来の成績を示すものではありません。';
  }
  let example=null;
  fetch('./data/episode-preview.json?rev='+Date.now(),{cache:'no-store'}).then(r=>{
    if(!r.ok)throw Error('HTTP '+r.status);
    return r.json();
  }).then(p=>{example=p;showExample(p);}).catch(e=>{
    $('examplePreview').className='message warn';
    $('examplePreview').textContent='自動試行例を取得できません。手動での学習は利用できます。';
  });
  state=load();
  fetch('./data/taiyo-yuden-1m.json?rev='+Date.now(),{cache:'no-store'}).then(r=>{
    if(!r.ok)throw Error('HTTP '+r.status);return r.json();
  }).then(p=>{
    if(p.symbol!=='6976.T'||p.interval!=='1m'||!Array.isArray(p.bars))throw Error('1分足データ形式が不正です。');
    sourceDays=E.groupSessions(p.bars);days=sourceDays.slice(-3);
    $('days').textContent=String(days.length)+'日';
    $('bars').textContent=String(days.reduce((n,d)=>n+d.am.length+d.pm.length,0));
    $('range').textContent=days.length?days[0].date+'〜'+days.at(-1).date:'—';
    const partial=days.filter(d=>d.am.length<143||d.pm.length<172);
    $('dataMessage').className='message '+(days.length<3||partial.length?'warn':'');
    $('dataMessage').textContent=days.length?
      '学習対象 '+days.map(d=>d.date+'（'+(d.am.length+d.pm.length)+'本）').join('、')+'。部分データ '+partial.length+'日。'+
      (days.length<3?'現状は3日未満での暫定実験です。':'同じ3取引日を繰り返し再生します。'):
      '1分足が足りません。1場60本以上の実データが必要です。';
    if(state&&Number.isFinite(state.cost)){$('cost').value=state.cost;cost=state.cost;}
    preview(state);updateHoldout();showExample(example);buttons();
  }).catch(e=>{
    $('dataMessage').className='message warn';
    $('dataMessage').textContent='データの読込に失敗しました：'+e.message;
    buttons();
  });
})();