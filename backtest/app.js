/* Taiyo Yuden 1m research / no-lookahead / chronological variable-length holdout.
 * No dataset is fabricated. Signal functions ONLY receive history through current close.
 * Orders are made on the next minute's open, or resting stop/target after entry.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const round = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : '—';
  const rate = n => Number.isFinite(n) ? (n>0?'+':'') + n.toFixed(3)+'%' : '—';
  const formatMoney = n => Number.isFinite(n) ? n.toLocaleString('ja-JP',{maximumFractionDigits:2}) : '—';
  const candleTime = ts => ts.slice(11,16);
  const minuteOf = ts => Number(ts.slice(11,13))*60+Number(ts.slice(14,16));
  const tokyoFmt = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  function jstString(time) {
    const parts = Object.fromEntries(tokyoFmt.formatToParts(time).map(o=>[o.type,o.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }
  function parseTime(raw) {
    const x=String(raw ?? '').trim();
    if(/^\d{10,13}$/.test(x)){
      const epoch=Number(x)*(x.length<=10?1000:1);
      const d=new Date(epoch);
      return Number.isFinite(d.getTime())?jstString(d):null;
    }
    if(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/.test(x))return x.replace(' ','T').slice(0,16);
    const d=new Date(x);
    return Number.isFinite(d.getTime())?jstString(d):null;
  }
  function sameSegment(a,b){
    return a.slice(0,10)===b.slice(0,10) && Math.abs(minuteOf(b)-minuteOf(a))===1;
  }
  function sessionName(t){const m=minuteOf(t);return (m>=540&&m<690)?'am':(m>=750&&m<930)?'pm':null;}
  function validBar(b){
    if(!Array.isArray(b)||b.length<6)return false;
    const [time,o,h,l,c,v]=b;
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(time) && sessionName(time)!==null
      && [o,h,l,c,v].every(Number.isFinite) && o>0 && h>=Math.max(o,c) && l<=Math.min(o,c)
      && l>0 && v>=0;
  }
  function normalizeBars(data){
    const map=new Map();
    for(const raw of data){
      if(!Array.isArray(raw)||raw.length<6)continue;
      const row=[parseTime(raw[0]),...[1,2,3,4,5].map(i=>Number(String(raw[i]).replace(/,/g,'')))];
      if(validBar(row))map.set(row[0],row);
    }
    return [...map.values()].sort((a,b)=>a[0].localeCompare(b[0]));
  }
  function csvMatrix(source){
    const lines=[];let row=[],cell='',inQuote=false;
    for(let i=0;i<source.length;i++){
      const ch=source[i];
      if(ch==='"'){if(inQuote&&source[i+1]==='"'){cell+='"';i++;}else inQuote=!inQuote;}
      else if(ch===','&&!inQuote){row.push(cell);cell='';}
      else if((ch==='\n'||ch==='\r')&&!inQuote){
        if(ch==='\r'&&source[i+1]==='\n')i++;
        row.push(cell);cell='';if(row.some(x=>x.trim()))lines.push(row);row=[];
      }else cell+=ch;
    }
    if(cell||row.length){row.push(cell);if(row.some(x=>x.trim()))lines.push(row);}
    return lines;
  }
  function fromCsv(csv){
    const table=csvMatrix(csv.replace(/^\uFEFF/,''));
    if(table.length<2)throw Error('CSVにデータがありません。');
    const header=table[0].map(x=>x.trim().toLowerCase());
    const col=(...names)=>header.findIndex(h=>names.includes(h));
    const dateIndex=col('date','日付'),timeIndex=col('time','時刻');
    const fullTime=col('timestamp','datetime','日時');
    const prices=[col('open','o','始値'),col('high','h','高値'),col('low','l','安値'),col('close','c','終値'),col('volume','vo','出来高')];
    const codeIndex=col('code','銘柄コード');
    if(prices.some(i=>i<0) || (fullTime<0 && dateIndex<0 && timeIndex<0)){
      throw Error('CSVに時刻と四本値・出来高が必要です。J-Quantsの Date,Time,Code,O,H,L,C,Vo 形式にも対応します。');
    }
    const mapped=table.slice(1).filter(r=>{
      if(codeIndex<0)return true;
      return ['6976','69760'].includes(String(r[codeIndex]??'').trim());
    }).map(r=>{
      let time=fullTime>=0?r[fullTime]:dateIndex>=0&&timeIndex>=0?
        String(r[dateIndex]??'').trim()+'T'+String(r[timeIndex]??'').trim():
        String(r[(timeIndex>=0?timeIndex:dateIndex)]??'').trim();
      return [time,...prices.map(i=>r[i])];
    });
    return normalizeBars(mapped);
  }
  function groupSessions(bars){
    const grouped=new Map();
    for(const row of bars){
      const day=row[0].slice(0,10),part=sessionName(row[0]),key=day+'/'+part;
      if(!grouped.has(key))grouped.set(key,[]);
      grouped.get(key).push({t:row[0],o:row[1],h:row[2],l:row[3],c:row[4],v:row[5]});
    }
    const days=new Map();
    for(const [key,rows] of grouped){
      const [date,part]=key.split('/');
      if(!days.has(date))days.set(date,{date,am:[],pm:[]});
      days.get(date)[part]=rows.sort((a,b)=>a.t.localeCompare(b.t));
    }
    return [...days.values()].sort((a,b)=>a.date.localeCompare(b.date));
  }
  // Strong coverage gate: both continuous Tokyo sessions, ~315+ real minutes.\n  // JPX's last continuous-trading minute is 15:24; 15:30 is a separate auction print.
  // Missing individual bars may exist but signals never cross missing minute gaps.
  function completed(day){
    const am=new Set(day.am.map(x=>candleTime(x.t))),pm=new Set(day.pm.map(x=>candleTime(x.t)));
    return day.am.length+day.pm.length>=315 && day.am.length>=143 && day.pm.length>=172
      && ['09:00','10:00','11:20'].every(t=>am.has(t))
      && ['12:30','14:30','15:24'].every(t=>pm.has(t));
  }
  const modes=[
    {id:'shock',label:'3分急落後の反発買い',thresholds:[0.35,0.60,0.90]},
    {id:'momentum',label:'5分上昇モメンタム',thresholds:[0.25,0.50,0.80]},
    {id:'breakout',label:'直近15分高値ブレイク',thresholds:[1.0,1.5,2.0]},
    {id:'opening',label:'開始15分レンジ突破',thresholds:[1.0,1.4,1.8]},
    {id:'vwapRevert',label:'VWAP下方乖離から反発',thresholds:[0.3,0.55,0.85]},
    {id:'vwapCross',label:'VWAP上抜けと出来高',thresholds:[1.0,1.4,1.8]},
  ];
  const exitVariants=[
    {tp:0.40,sl:0.30,hold:5},
    {tp:0.70,sl:0.40,hold:10},
    {tp:1.00,sl:0.60,hold:15},
  ];
  const candidates=modes.flatMap(m=>m.thresholds.flatMap(th=>exitVariants.map(ex=>({...ex,id:m.id,threshold:th,label:m.label}))));
  $('candidateCount').textContent=candidates.length+'通り';
  let allBars=[],readyDays=[],evaluation=null,cost=0.10;

  function vwap(hist){
    let pv=0,vol=0;
    for(const x of hist){const w=x.v;pv+=(x.h+x.l+x.c)/3*w;vol+=w;}
    return vol>0?pv/vol:null;
  }
  function medVolume(hist,num=12){
    const xs=hist.slice(-num).map(x=>x.v).sort((a,b)=>a-b);
    return xs.length?xs[Math.floor(xs.length/2)]:0;
  }
  function signal(history,mode){
    const i=history.length-1;
    if(i<20)return false;
    // Reject signals when any minute in the recent 15-minute lookback is absent.
    for(let j=i-14;j<=i;j++)if(!sameSegment(history[j-1].t,history[j].t))return false;
    const b=history[i],p=history[i-1],t=mode.threshold;
    // A signal at current close uses only historical candles <= i.
    if(mode.id==='shock'){
      const past=history[i-3];
      return (b.c/past.c-1)*100<=-t && b.c>b.o && b.c>p.c;
    }
    if(mode.id==='momentum'){
      const ret=(b.c/history[i-5].c-1)*100;
      return ret>=t && b.c>p.c && p.c>history[i-2].c && b.v>medVolume(history.slice(0,-1));
    }
    if(mode.id==='breakout'){
      const high=Math.max(...history.slice(i-15,i).map(x=>x.h));
      const avg=medVolume(history.slice(0,-1));
      return b.c>high && p.c<=high && avg>0 && b.v>=t*avg;
    }
    if(mode.id==='opening'){
      if(i>100)return false;
      const first=history.slice(0,15);
      if(first.length<15)return false;
      const high=Math.max(...first.map(x=>x.h));
      const avg=medVolume(history.slice(0,-1));
      return b.c>high && p.c<=high && avg>0 && b.v>=t*avg;
    }
    if(mode.id==='vwapRevert'){
      const vw=vwap(history);if(!vw)return false;
      return 100*(vw-b.c)/vw>=t && b.c>b.o && b.c>p.c;
    }
    if(mode.id==='vwapCross'){
      const vw=vwap(history),old=vwap(history.slice(0,-1));
      const avg=medVolume(history.slice(0,-1));
      return vw!==null && old!==null && avg>0 && p.c<=old && b.c>vw && b.v>=t*avg;
    }
    return false;
  }
  function exitTrade(session,entryIndex,mode,costPct){
    const entry=session[entryIndex],entryPrice=entry.o;
    const stop=entryPrice*(1-mode.sl/100),target=entryPrice*(1+mode.tp/100);
    const lastIndex=session.length-1;
    // Do not carry positions into lunch or the next trading session.
    for(let j=entryIndex;j<=lastIndex;j++){
      const bar=session[j];
      if(j>entryIndex && !sameSegment(session[j-1].t,bar.t)){
        // Missing minute: flatten at the next observed open; never invent stop fills.
        return {exitIndex:j,exitTime:bar.t,exitPrice:bar.o,reason:'欠損後手仕舞い',net:(bar.o/entryPrice-1)*100-costPct};
      }
      // Time exit occurs at the open of the first bar after `hold` elapsed,
      // or at the final bar open before lunch/close.
      if(j-entryIndex>=mode.hold || j===lastIndex){
        return {exitIndex:j,exitTime:bar.t,exitPrice:bar.o,reason:j===lastIndex?'場末手仕舞い':'時間切れ',net:(bar.o/entryPrice-1)*100-costPct};
      }
      // Resting stop/target can execute within the entry bar after entry at open.
      // Gap below stop executes at bar open (worse), but target gets no favorable gap fill.
      if(bar.o<=stop || bar.l<=stop){
        const price=Math.min(bar.o,stop);
        return {exitIndex:j,exitTime:bar.t,exitPrice:price,reason:'損切り',net:(price/entryPrice-1)*100-costPct};
      }
      if(bar.o>=target || bar.h>=target){
        return {exitIndex:j,exitTime:bar.t,exitPrice:target,reason:'利確',net:(target/entryPrice-1)*100-costPct};
      }
    }
    throw Error('exit horizon failed');
  }
  function simulate(days,mode,costPct){
    const trades=[];
    for(const day of days){
      let dayTrades=0;
      for(const session of [day.am,day.pm]){
        for(let i=20;i<session.length-2 && dayTrades<6;i++){
          if(!sameSegment(session[i].t,session[i+1].t))continue;
          // CRITICAL: the signal only receives a COPY of candles through i.
          const known=session.slice(0,i+1);
          if(!signal(known,mode))continue;
          const k=i+1;
          const closed=exitTrade(session,k,mode,costPct);
          trades.push({date:day.date,mode:mode.id,label:mode.label,entry:session[k].t,
            entryPrice:session[k].o,exit:closed.exitTime,exitPrice:closed.exitPrice,
            reason:closed.reason,net:closed.net,config:mode});
          dayTrades++;
          i=closed.exitIndex+2; // do not open overlapping trades, 2m cooldown
        }
      }
    }
    return trades;
  }
  function stats(trades){
    const n=trades.length;
    if(!n)return {n:0,mean:null,total:null,win:null,pf:null,dd:null};
    const sum=trades.reduce((s,t)=>s+t.net,0),positives=trades.filter(t=>t.net>0);
    const gain=positives.reduce((s,t)=>s+t.net,0),loss=-trades.filter(t=>t.net<0).reduce((s,t)=>s+t.net,0);
    let capital=0,peak=0,maxDD=0;
    for(const t of trades){capital+=t.net;peak=Math.max(peak,capital);maxDD=Math.min(maxDD,capital-peak);}
    return {n,mean:sum/n,total:sum,win:positives.length/n*100,pf:loss===0?(gain>0?Infinity:null):gain/loss,dd:maxDD};
  }
  function splitPeriod(days){
    const chosen=days.slice(-20);
    const trainCount=chosen.length===1?1:Math.ceil(chosen.length/2);
    return {training:chosen.slice(0,trainCount),heldout:chosen.slice(trainCount),trainCount,
      testCount:chosen.length-trainCount,dayCount:chosen.length,inSample:chosen.length===1};
  }
  function chooseTrainingConfig(training,costPct,mode){
    const tried=candidates.filter(c=>c.id===mode.id).map(config=>{
      const trades=simulate(training,config,costPct);
      return {config,trades,score:stats(trades)};
    });
    const minimumTrades=Math.min(5,training.length);
    const eligible=tried.filter(x=>x.score.n>=minimumTrades);
    if(!eligible.length)return null;
    eligible.sort((a,b)=>(b.score.mean-a.score.mean) || (b.score.n-a.score.n));
    return eligible[0];
  }
  function run(days,costPct){
    const split=splitPeriod(days),{training,heldout}=split;
    const result=modes.map(mode=>{
      const selected=chooseTrainingConfig(training,costPct,mode);
      if(!selected)return {id:mode.id,label:mode.label,selected:null,training:stats([]),test:stats([]),trades:[]};
      const newTrades=split.inSample?selected.trades:simulate(heldout,selected.config,costPct);
      return {id:mode.id,label:mode.label,selected:selected.config,training:selected.score,
        test:split.inSample?stats([]):stats(newTrades),trades:newTrades};
    });
    // Ranking depends only on the training segment; never on held-out results.
    result.sort((a,b)=>(b.training.mean??-Infinity)-(a.training.mean??-Infinity));
    result.meta=split;
    return result;
  }
  function drawPath(svgId,values,marks=[]){
    const target=$(svgId),min=Math.min(...values),max=Math.max(...values),span=(max-min)||1;
    const left=40,right=625,top=19,bottom=224;
    const point=(val,i)=>[(left+(right-left)*i/Math.max(1,values.length-1)),(bottom-(val-min)/span*(bottom-top))];
    const path=values.map((v,i)=>point(v,i).map(z=>z.toFixed(1)).join(',')).join(' ');
    const line='<line x1="'+left+'" y1="'+bottom+'" x2="'+right+'" y2="'+bottom+'" stroke="#d5dde9"/>';
    const txt='<text x="'+left+'" y="12" fill="#64748b" font-size="11">高 '+round(max)+'</text><text x="'+left+'" y="247" fill="#64748b" font-size="11">低 '+round(min)+'</text>';
    const colored=marks.map(m=>{const [x,y]=point(m.value,m.index);return '<circle cx="'+x+'" cy="'+y+'" r="4" fill="'+(m.buy?'#087c64':'#b63352')+'"><title>'+escape(m.title||'')+'</title></circle>';}).join('');
    target.innerHTML=line+'<polyline points="'+path+'" fill="none" stroke="#3971b5" stroke-width="2" stroke-linejoin="round"/>'+colored+txt;
  }
  function drawEquity(r){
    if(!r||!r.trades.length){$('equityChart').innerHTML='<text x="20" y="35" fill="#64748b">検証期間の取引がありません</text>';return;}
    let sum=0;const values=[0,...r.trades.map(t=>(sum+=t.net))];drawPath('equityChart',values);
  }
  function renderChart(){
    if(!evaluation)return;
    const date=$('chartDay').value,r=evaluation.results.find(x=>x.id===$('chartStrategy').value);
    const day=evaluation.days.find(d=>d.date===date);
    if(!day){$('priceChart').innerHTML='<text x="20" y="35">対象日がありません</text>';return;}
    const all=[...day.am,...day.pm],close=all.map(x=>x.c);
    const marks=[];
    for(const trade of (r?.trades||[]).filter(x=>x.date===date)){
      const k=all.findIndex(x=>x.t===trade.entry),j=all.findIndex(x=>x.t===trade.exit);
      if(k>=0)marks.push({buy:true,index:k,value:trade.entryPrice,title:`買い ${trade.entry}`});
      if(j>=0)marks.push({buy:false,index:j,value:trade.exitPrice,title:`売り ${trade.exit} ${rate(trade.net)}`});
    }
    drawPath('priceChart',close,marks);
    drawEquity(r);
    const body=$('tradeRows');
    body.innerHTML=r?.trades.length?r.trades.map(t=>`<tr><td>${escape(t.date)}</td><td>${escape(t.label)}</td><td>${escape(candleTime(t.entry))}</td><td>${formatMoney(t.entryPrice)}</td><td>${escape(candleTime(t.exit))}</td><td>${formatMoney(t.exitPrice)}</td><td>${escape(t.reason)}</td><td class="${t.net>=0?'pos':'neg'}">${rate(t.net)}</td></tr>`).join(''):'<tr><td colspan="8" style="text-align:left">該当する取引はありません</td></tr>';
    $('exportBtn').disabled=!(r?.trades?.length);
  }
  function renderResult(days,results){
    evaluation={days,results};
    const split=results.meta||splitPeriod(days);
    const {trainCount,testCount,inSample}=split;
    $('trainDaysColumn').textContent='学習'+trainCount+'日';
    $('trainAvgColumn').textContent='学習'+trainCount+'日';
    for(const id of ['testTradesColumn','testWinColumn','testAvgColumn','testTotalColumn']){
      $(id).textContent=inSample?'期間外なし':'検証'+testCount+'日';
    }
    $('equityTitle').textContent=inSample?'学習期間内の累積損益（参考）':'検証期間の累積損益';
    $('tradeTitle').textContent=inSample?'取引明細（同日内・参考）':'取引明細（検証'+testCount+'日）';
    const valid=results.filter(x=>x.selected);
    const rows=results.map((r,i)=>{
      const no=r.selected;
      const desc=no?`閾値 ${no.threshold}% / 利確 ${no.tp}% / 損切り ${no.sl}% / ${no.hold}分`:'学習期間の取引が少なく条件未選択';
      return `<tr class="${i===0?'best':''}"><td><strong>${escape(r.label)}</strong><small>${escape(desc)}</small></td><td>${r.training.n}</td><td>${rate(r.training.mean)}</td><td>${r.test.n}</td><td>${round(r.test.win,1)}${Number.isFinite(r.test.win)?'%':''}</td><td class="${r.test.mean>=0?'pos':'neg'}">${rate(r.test.mean)}</td><td class="${r.test.total>=0?'pos':'neg'}">${rate(r.test.total)}</td><td>${rate(r.test.dd)}</td></tr>`;
    });
    $('resultsRows').innerHTML=rows.join('');
    $('testStatus').textContent=valid.length+'戦略';
    $('testNote').textContent=inSample?'1日の同一期間内評価':'過去'+trainCount+'日で選定→後半'+testCount+'日で期間外検証';
    $('resultMessage').className='message warn';
    $('resultMessage').textContent=!valid.length?
      '条件を選ぶのに十分な取引がありません。データの追加を待ってください。':
      inSample?'1取引日だけの暫定検証です。成績は選定に使った同じ日のもので、未使用データでの検証ではありません。勝てる戦略の発見を意味しません。':
      '古い'+trainCount+'取引日で選んだ条件を、新しい'+testCount+'取引日で固定評価しました。20日未満のため暫定値です。データ欠損や少数取引・過剰最適化に注意してください。';
    $('chartDay').innerHTML=(inSample?days:days.slice(trainCount)).map(x=>`<option value="${escape(x.date)}">${escape(x.date)}</option>`).join('');
    $('chartStrategy').innerHTML=results.map(x=>`<option value="${escape(x.id)}">${escape(x.label)}</option>`).join('');
    $('chartDay').disabled=$('chartStrategy').disabled=false;
    $('chartDay').value=days.at(-1).date;
    $('chartStrategy').value=results[0].id;
    renderChart();
  }
  // A partial day may be used for exploration when at least 60 real bars
  // exist in ONE session; all missing timestamps remain absent in simulations.
  function usableDay(day){
    return day.am.length+day.pm.length>=60&&Math.max(day.am.length,day.pm.length)>=60;
  }
  function refreshBars(bars,origin){
    allBars=normalizeBars(bars);
    const groups=groupSessions(allBars),usable=groups.filter(usableDay);
    readyDays=usable.slice(-20);
    const full=readyDays.filter(completed).length;
    const partial=readyDays.length-full;
    evaluation=null;
    $('barCount').textContent=allBars.length.toLocaleString('ja-JP');
    $('dayCount').textContent=readyDays.length+'日';
    $('dayRange').textContent=readyDays.length?`${readyDays[0].date} 〜 ${readyDays.at(-1).date}／全日相当${full}日・部分データ${partial}日`:'検証可能な実データなし';
    $('startBtn').disabled=readyDays.length===0;
    $('startBtn').textContent=readyDays.length?`${readyDays.length}取引日で${readyDays.length<20?'暫定':''}バックテスト`:'1分足の蓄積待ち';
    $('loadMessage').className='message '+(readyDays.length<20?'warn':'ok');
    $('loadMessage').textContent=readyDays.length===0?
      `${origin}：連続検証に使える1分足が不足しています（同一場内で60本以上が必要）。`:
      `${origin}：${readyDays.length}取引日・${allBars.length}本。部分データ${partial}日を含む${readyDays.length<20?'暫定検証':'20日検証'}が可能です。欠損部分を補完せず、その場内の実在する足だけで売買を判定します。`;
    $('testStatus').textContent='未実行';
    $('testNote').textContent=readyDays.length<2?'期間外検証には2取引日以上必要':'学習期間と期間外検証を時系列で分離';
    $('resultMessage').textContent=readyDays.length?
      '「バックテスト」を押して実データで売買を再生できます。短期結果は統計的な優位性を示しません。':
      '1分足を取得でき次第、結果を計算できます。';
    $('resultsRows').innerHTML='<tr><td colspan="8" style="text-align:left">バックテスト実行待ち</td></tr>';
    $('tradeRows').innerHTML='<tr><td colspan="8" style="text-align:left">取引履歴なし</td></tr>';
    $('chartDay').disabled=$('chartStrategy').disabled=$('exportBtn').disabled=true;
  }
  function evaluate(){
    if(readyDays.length<1)return;
    const input=Number($('roundCost').value);
    if(!Number.isFinite(input)||input<0||input>2){$('resultMessage').textContent='往復コストを0〜2%に設定してください。';return;}
    cost=input;
    $('resultMessage').className='message';$('resultMessage').textContent='時系列に売買条件を評価しています…';
    // defer one frame so loading state renders
    setTimeout(()=>{
      const results=run(readyDays,cost);
      renderResult(readyDays,results);
    },20);
  }
  $('startBtn').addEventListener('click',evaluate);
  $('chartDay').addEventListener('change',renderChart);
  $('chartStrategy').addEventListener('change',renderChart);
  $('exportBtn').addEventListener('click',()=>{
    if(!evaluation)return;
    const s=evaluation.results.find(x=>x.id===$('chartStrategy').value);if(!s?.trades.length)return;
    const header=['date','strategy','entry','entry_price','exit','exit_price','reason','net_pct'];
    const lines=[header.join(','),...s.trades.map(x=>[x.date,x.mode,x.entry,x.entryPrice,x.exit,x.exitPrice,x.reason,x.net.toFixed(5)].join(','))];
    const blob=new Blob(['\uFEFF'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='taiyo-yuden-test-trades.csv';a.click();URL.revokeObjectURL(a.href);
  });
  $('csvInput').addEventListener('change',async()=>{
    const file=$('csvInput').files?.[0];if(!file)return;
    try{
      const parsed=fromCsv(await file.text());
      if(!parsed.length)throw Error('日本市場の立会時間に該当する有効なOHLCVがありません。');
      const merged=normalizeBars([...allBars,...parsed]);
      evaluation=null;refreshBars(merged,`CSV ${file.name}`);
    }catch(e){$('loadMessage').className='message warn';$('loadMessage').textContent='CSVの読込に失敗：'+e.message;}
  });
  if(typeof globalThis !== 'undefined' && globalThis.__STRATEGY_LAB_TEST__){
    globalThis.__STRATEGY_LAB_TEST_API__={signal,simulate,run,stats,groupSessions,completed,usableDay,splitPeriod,normalizeBars,fromCsv,candidates};
  }
  fetch('./data/taiyo-yuden-1m.json?rev='+Date.now(),{cache:'no-store'}).then(r=>{
    if(!r.ok)throw Error(`HTTP ${r.status}`);
    return r.json();
  }).then(p=>{
    if(p.symbol!=='6976.T'||p.interval!=='1m'||!Array.isArray(p.bars))throw Error('1分足アーカイブの形式が違います。');
    refreshBars(p.bars,'GitHub保存データ');
  }).catch(e=>{
    $('loadMessage').className='message warn';
    $('loadMessage').textContent='保存データを読み込めません：'+e.message+'。CSVからの読み込みは可能です。';
  });
})();