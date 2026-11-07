'use strict';
/* Visualize precomputed exhaustive x/y optimization without choosing params on test day. */
(async()=>{
const $=id=>document.getElementById(id);
const f=(n,d=2)=>Number.isFinite(n)?n.toFixed(d):'—';
const pct=(n,d=3)=>Number.isFinite(n)?(n>0?'+':'')+f(n,d)+'%':'—';
function cellText(x){return Number.isFinite(x)?x.toFixed(2):'—';}
const td=(v,style='')=>'<td'+(style?' style="'+style+'"':'')+'>'+v+'</td>';
const th=v=>'<th>'+v+'</th>';
function row(label,r,held){
  if(!r)return '<tr><td colspan="7" style="text-align:left">評価できる組がありません</td></tr>';
  const out=held||null;
  return '<tr>'+td(label)+td(f(r.x,2)+'%')+td(f(r.y,2)+'%')+
    td(pct(r.total),'color:'+(r.total>=0?'#057b64':'#b33152'))+
    td(out?pct(out.total):'未評価','color:'+(out?.total>=0?'#057b64':'#b33152'))+
    td(out?out.trades:'—')+td(out?.winRate==null?'—':f(out.winRate,1)+'%')+'</tr>';
}
try{
const response=await fetch('./data/xy-grid.json?rev='+Date.now(),{cache:'no-store'});
if(!response.ok)throw Error('HTTP '+response.status);
const data=await response.json();
if(data.version!==1||!Array.isArray(data.grid)||!data.search?.axes)throw Error('最適化結果の形式が不正です');
const count=data.search.gridSize;
$('gridCount').textContent=count.toLocaleString('ja-JP')+'通り';
const b=data.fullBest;
$('gridBestX').textContent=b?f(b.x)+'%':'—';
$('gridBestY').textContent=b?f(b.y)+'%':'—';
$('gridBestScore').textContent=b?f(b.score,3):'—';
$('gridBestTrades').textContent=b?b.trades+'回':'—';
$('gridStatus').className='message warn';
$('gridStatus').textContent=
  '実際の1分足 '+data.dates.map(x=>x.date+'（'+(x.am+x.pm)+'本'+(x.partial?'・部分データ':'')+'）').join('、')+
  'で x '+f(data.search.axes.x[0])+'〜'+f(data.search.axes.x.at(-1))+'%、y '+
  f(data.search.axes.y[0])+'〜'+f(data.search.axes.y.at(-1))+
  '% の'+count.toLocaleString('ja-JP')+'組を比較しました。最高得点は学習期間内の値であり、将来の期待利益を示しません。';
$('oosRows').innerHTML=row('学習2日の最高得点',data.trainingBest,data.testForTrainingBest)+
  row('学習2日の近傍安定性',data.trainingRobust,data.trainingRobust?.test);
$('bestGridRows').innerHTML=(data.topFull||[]).slice(0,10).map((r,i)=>'<tr>'+td(i+1)+
  td(f(r.x,2)+'%')+td(f(r.y,2)+'%')+td(f(r.score,3))+
  td(pct(r.total),'color:'+(r.total>=0?'#057b64':'#b33152'))+
  td(r.trades)+td(r.winRate==null?'—':f(r.winRate,1)+'%')+
  td(pct(r.dd))+'</tr>').join('');
const map=new Map(data.grid.map(c=>[f(c[0],2)+'/'+f(c[1],2),c]));
const xs=[.15,.25,.35,.45,.55,.65,.8,1,1.25,1.5,2,2.5,3];
const ys=[.2,.4,.6,.8,1,1.5,2,2.5,3,3.5];
let html='<thead><tr>'+th('x ＼ y')+ys.map(y=>th(f(y,2)+'%')).join('')+'</tr></thead><tbody>';
for(const x of xs){
  html+='<tr>'+th(f(x,2)+'%');
  for(const y of ys){
    const c=map.get(f(x,2)+'/'+f(y,2));
    if(!c){html+=td('—');continue;}
    const score=c[2],trades=c[4];
    const minTrades=data.search.minTradesFull||5;
    const color=trades<minTrades?'#f1f5f9':score>=0?
      'rgba(5,123,100,'+(0.07+Math.min(0.38,score/15)).toFixed(3)+')':
      'rgba(179,49,82,'+(0.07+Math.min(0.38,Math.abs(score)/15)).toFixed(3)+')';
    html+=td((trades<minTrades?'※':'')+f(score,1),
      'background:'+color+';text-align:center;white-space:nowrap');
  }
  html+='</tr>';
}
$('xyHeatmap').innerHTML=html+'</tbody>';
}catch(e){
$('gridStatus').className='message warn';
$('gridStatus').textContent='総当たり結果の読み込みに失敗：'+e.message+'。3日エピソードの手動学習は利用可能です。';
}
})();
