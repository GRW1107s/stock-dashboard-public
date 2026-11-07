/* Nikkei semiconductor embedded backtest tabs. */
(()=>{
'use strict';
const views={
 compare:['strategy-lab.html?v=compact-20261104','戦略比較・時間足切替','1分・5分・15分・1時間・日足を選択し、25MA逆張りなど複数の戦略をチェックして同じ期間で比較します。'],
 walkforward:['walkforward.html','逐次学習・初見検証','初期3取引日を学習し、次の未学習日を先に評価します。SBI日計り信用の手数料と当日買方金利0%、約定摩擦の仮定往復0.06%を差し引きます。'],
 fixed:['index.html','固定ルール検証','実際の1分足を使った固定ルール研究です。旧モデルには1日最大3回の制約がまだ適用されていないものがあります。'],
 xy:['episode.html','x/y反復学習','高値からx%下落で買い、y%上昇で売る条件を反復探索します。学習中の成績は期間外検証ではありません。'],
 five:['five-minute.html','5分足検証','実際の5分足でバックテストします。データが足りない場合は結果を表示しません。']
};
function init(){
 const frame=document.getElementById('semiBtFrame'),tabs=document.querySelector('.semi-bt-modes'),note=document.getElementById('semiBtNote');
 if(!frame||!tabs||!note)return;
 let obs=null;
 function resize(){
  try{
   const doc=frame.contentDocument;if(!doc?.body)return;
   frame.style.height=Math.min(18000,Math.max(650,doc.body.scrollHeight,doc.documentElement.scrollHeight)+30)+'px';
  }catch(e){}
 }
 frame.addEventListener('load',()=>{
  if(obs)obs.disconnect();resize();
  try{
   if(typeof ResizeObserver==='function'&&frame.contentDocument?.body){
    obs=new ResizeObserver(resize);obs.observe(frame.contentDocument.body);
   }
  }catch(e){}
 });
 tabs.addEventListener('click',e=>{
  const b=e.target.closest('button[data-bt]');if(!b||!views[b.dataset.bt])return;
  const [file,title,description]=views[b.dataset.bt];
  for(const x of tabs.querySelectorAll('button[data-bt]'))x.setAttribute('aria-selected',String(x===b));
  note.textContent=description;
  frame.title='太陽誘電バックテスト｜'+title;
  frame.style.height='1050px';
  if(!frame.getAttribute('src')?.endsWith('/'+file))frame.src='./backtest/'+file;
 });
 window.addEventListener('resize',resize);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();