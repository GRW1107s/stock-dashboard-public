/* Shared dashboard header and optional sub-tabs. Data and analysis logic remain unchanged. */
(function(){
  "use strict";
  const pages={
    "index.html":[
      {label:"日次観測",start:"h1"},
      {label:"過去データ",start:"#pane-history"},
      {label:"相場の歴史",start:"#pane-history-search"}
    ],
    "jp-sectors.html":[
      {label:"セクター分析",start:"h1"},
      {label:"業種分析",start:"#industry-analysis-panel"},
      {label:"銘柄スクリーニング",start:"#leader-screener-panel"}
    ],
    "sectors.html":[
      {label:"セクター分析",start:"h1"},
      {label:"業種分析",start:"#industry-analysis-panel"},
      {label:"銘柄スクリーニング",start:"#leader-screener-panel"}
    ],
    "us-semiconductors.html":[
      {label:"日次データ",start:".panel:not([id])"},
      {label:"SOXX下落σ分析",start:"#sigmaDropPanel"},
      {label:"プレマーケット",start:"#premarketStudyPanel"}
    ],
    "us-anomalies.html":[
      {label:"週別",start:".card",index:0},
      {label:"日付別",start:".card",index:1},
      {label:"集計・比較",start:".grid2"},
      {label:"巨大IPO",start:"#ipoStudyPanel"}
    ]
  };
  function init(){
    const main=document.querySelector("main");
    const primary=main&&main.querySelector(":scope > nav.page-tabs");
    if(!primary)return;
    const header=document.createElement("header");
    header.id="stock-dashboard-header";
    const home=document.createElement("a");
    home.href="./index.html";
    home.textContent="Stock Dashboard";
    header.appendChild(home);
    main.insertBefore(header,primary);

    const page=location.pathname.split("/").pop()||"index.html";
    // Japanese semiconductor research: separate swing and day trading into sub-tabs.
    if(page==="semiconductors.html"){
      const swingStart=main.querySelector(".matrix-section");
      const dayStart=document.getElementById("daytrade");
      const reboundStart=document.getElementById("rebound");
      const footer=main.querySelector("footer");
      if(!swingStart||!dayStart||!reboundStart||!footer)return;
      const swingNodes=[],dayNodes=[],reboundNodes=[];
      for(let n=swingStart;n&&n!==dayStart;n=n.nextElementSibling)swingNodes.push(n);
      for(let n=dayStart;n&&n!==reboundStart;n=n.nextElementSibling)dayNodes.push(n);
      for(let n=reboundStart;n&&n!==footer;n=n.nextElementSibling)reboundNodes.push(n);
      const tabs=document.createElement("nav");
      tabs.className="stock-dashboard-subtabs";
      tabs.setAttribute("aria-label","日経半導体のサブタブ");
      tabs.setAttribute("role","tablist");
      primary.insertAdjacentElement("afterend",tabs);
      const tabIds=["swing","daytrade"];
      const panes=tabIds.map((id,i)=>{
        const p=document.createElement("section");
        p.className="stock-dashboard-pane";
        p.id="semi-"+id+"-pane";
        p.setAttribute("role","tabpanel");
        p.setAttribute("aria-labelledby","semi-"+id+"-tab");
        main.insertBefore(p,swingStart);
        return p;
      });
      [...swingNodes,...reboundNodes].forEach(n=>panes[0].appendChild(n));
      dayNodes.forEach(n=>panes[1].appendChild(n));
      const buttons=["スイング","デイトレ"].map((label,i)=>{
        const b=document.createElement("button");
        b.type="button";b.id="semi-"+tabIds[i]+"-tab";
        b.setAttribute("role","tab");b.setAttribute("aria-controls",panes[i].id);
        b.textContent=label;
        b.addEventListener("click",()=>select(i,true));
        tabs.appendChild(b);return b;
      });
      function select(i,changeHash){
        buttons.forEach((b,j)=>{
          const active=i===j;
          b.setAttribute("aria-selected",String(active));
          b.tabIndex=active?0:-1;
          panes[j].hidden=!active;
        });
        if(changeHash)history.replaceState(null,"","#"+tabIds[i]);
        requestAnimationFrame(()=>window.dispatchEvent(new Event("resize")));
      }
      tabs.addEventListener("keydown",e=>{
        if(!["ArrowRight","ArrowLeft","Home","End"].includes(e.key))return;
        const current=buttons.indexOf(document.activeElement);
        if(current<0)return;
        e.preventDefault();
        const next=e.key==="Home"?0:e.key==="End"?buttons.length-1:(current+(e.key==="ArrowRight"?1:-1)+buttons.length)%buttons.length;
        select(next,true);buttons[next].focus();
      });
      function chooseHash(){
        const hash=decodeURIComponent(location.hash.slice(1));
        const el=hash?document.getElementById(hash):null;
        select(hash==="daytrade"||hash==="semi-daytrade-pane"||!!(el&&panes[1].contains(el))?1:0,false);
      }
      chooseHash();
      window.addEventListener("hashchange",chooseHash);
      return;
    }
    if(page==="jp-themes.html"){
      // This page already implements its own working sub-tabs; reuse them.
      const existing=main.querySelector(":scope > .tabs[role='tablist']");
      if(existing){
        existing.classList.add("stock-dashboard-subtabs");
        existing.setAttribute("aria-label","サブタブ");
        primary.insertAdjacentElement("afterend",existing);
      }
      return;
    }
    const tabs=pages[page];
    if(!tabs)return;
    const starts=tabs.map(t=>{
      const matches=main.querySelectorAll(":scope > "+t.start);
      return matches[t.index||0]||null;
    });
    if(starts.some(x=>!x)||starts.some((x,i)=>i>0&&x===starts[i-1])){
      console.warn("Dashboard: page section anchors missing; keeping all content visible.");
      return;
    }
    const nav=document.createElement("nav");
    nav.className="stock-dashboard-subtabs";
    nav.setAttribute("aria-label","サブタブ");
    nav.setAttribute("role","tablist");
    primary.insertAdjacentElement("afterend",nav);
    const panes=[];
    tabs.forEach((tab,i)=>{
      const pane=document.createElement("section");
      pane.id="stock-dashboard-pane-"+i;
      pane.className="stock-dashboard-pane";
      pane.setAttribute("role","tabpanel");
      pane.setAttribute("aria-labelledby","stock-dashboard-tab-"+i);
      main.insertBefore(pane,starts[i]);
      let node=starts[i];
      const end=starts[i+1]||null;
      while(node&&node!==end){
        if(node.nodeType===1&&node.tagName==="SCRIPT")break;
        const next=node.nextSibling;
        pane.appendChild(node);
        node=next;
      }
      panes.push(pane);
    });
    const buttons=tabs.map((tab,i)=>{
      const button=document.createElement("button");
      button.type="button";
      button.id="stock-dashboard-tab-"+i;
      button.setAttribute("role","tab");
      button.setAttribute("aria-controls",panes[i].id);
      button.textContent=tab.label;
      button.addEventListener("click",()=>select(i,true));
      nav.appendChild(button);
      return button;
    });
    function select(index,updateUrl){
      buttons.forEach((b,i)=>{
        const active=i===index;
        b.setAttribute("aria-selected",String(active));
        b.tabIndex=active?0:-1;
        panes[i].hidden=!active;
      });
      if(updateUrl){
        history.replaceState(null,"","#"+panes[index].id);
      }
      requestAnimationFrame(()=>window.dispatchEvent(new Event("resize")));
    }
    nav.addEventListener("keydown",e=>{
      if(!["ArrowRight","ArrowLeft","Home","End"].includes(e.key))return;
      const current=buttons.indexOf(document.activeElement);
      if(current<0)return;
      e.preventDefault();
      const next=e.key==="Home"?0:e.key==="End"?buttons.length-1:(current+(e.key==="ArrowRight"?1:-1)+buttons.length)%buttons.length;
      select(next,true);
      buttons[next].focus();
    });
    const hash=decodeURIComponent(location.hash.slice(1));
    const hashTarget=hash&&document.getElementById(hash);
    const selected=hashTarget?panes.findIndex(p=>p===hashTarget||p.contains(hashTarget)):-1;
    select(selected<0?0:selected,false);
    window.addEventListener("hashchange",()=>{
      const target=document.getElementById(decodeURIComponent(location.hash.slice(1)));
      const index=panes.findIndex(p=>p===target||(target&&p.contains(target)));
      if(index>=0)select(index,false);
    });
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);
  else init();
})();
