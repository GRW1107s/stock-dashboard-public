/* Index options positioning panels (Nikkei 225 / SPX) for the market
   overview page. Data: options.json, written by scripts/update_options.py
   (JPX open-interest table for Nikkei 225 options, CBOE delayed quotes
   for SPX). Renders into [data-opt-market] roots inside the
   #pane-jp-options / #pane-us-options sections of index.html. */
(function () {
  "use strict";
  function boot() {
  var roots = document.querySelectorAll("[data-opt-market]");
  if (!roots.length) return;

  var css = [
    ".opt-head{font-size:12px;color:#555;margin:2px 0 6px}",
    ".opt-chips{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}",
    ".opt-chips button{border:1px solid #c9d2dd;background:#fff;border-radius:999px;padding:3px 12px;font-size:12px;cursor:pointer}",
    ".opt-chips button[aria-selected='true']{background:#2563eb;border-color:#2563eb;color:#fff}",
    ".opt-tiles{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}",
    ".opt-tile{border:1px solid #dde3ea;border-radius:8px;padding:6px 10px;min-width:100px;background:#fbfcfe}",
    ".opt-tile .k{font-size:11px;color:#667}",
    ".opt-tile .v{font-size:16px;font-weight:700}",
    ".opt-colhead,.opt-row{display:flex;align-items:center;gap:6px}",
    ".opt-colhead{font-size:11px;color:#667;margin-top:4px}",
    ".opt-row{height:18px;font-size:11px}",
    ".opt-bar{flex:1;display:flex;align-items:center;gap:4px;min-width:0}",
    ".opt-bar.put{justify-content:flex-end}",
    ".opt-bar i{display:block;height:11px;flex:none}",
    ".opt-bar.put i{background:#3b82c4}",
    ".opt-bar.call i{background:#d9534f}",
    ".opt-bar span{color:#555;white-space:nowrap}",
    ".opt-strike{width:76px;text-align:center;font-weight:600;white-space:nowrap;flex:none}",
    ".opt-colhead .opt-strike{font-weight:400}",
    ".opt-row.pain .opt-strike{background:#fdf0d5;border-radius:4px}",
    ".opt-spot{text-align:center;font-size:11px;color:#b45309;border-top:1px dashed #d9a441;margin:2px 0;padding-top:1px}",
    ".opt-note{font-size:11px;color:#778;margin-top:8px}"
  ].join("");
  css += ".opt-chain-scroll{overflow:auto;max-height:680px;border:1px solid #dbe3ed;border-radius:6px;background:white}.opt-chain{width:100%;min-width:840px;border-collapse:separate;border-spacing:0;table-layout:auto;font-size:11px;font-variant-numeric:tabular-nums}.opt-chain th,.opt-chain td{padding:4px 5px;text-align:right;white-space:nowrap;border-bottom:1px solid #e5eaf1;height:25px}.opt-chain thead th{position:sticky;top:0;background:#eaf0f6;z-index:2;text-align:center;height:26px}.opt-chain thead tr:nth-child(2) th{top:26px}.opt-chain .opt-k{text-align:center;background:#f1f5f9;font-weight:700;border-left:1px solid #dbe3ed;border-right:1px solid #dbe3ed}.opt-chain .opt-itm{background:#edf5ef}.opt-chain .opt-atm td{background:#eef2ff}.opt-chain .opt-up{color:#15803d;font-weight:600}.opt-chain .opt-down{color:#dc2626;font-weight:600}.opt-chain .opt-missing{color:#94a3b8}.opt-chain .opt-call-head{background:#e1ecfd;color:#1d4ed8}.opt-chain .opt-put-head{background:#e1ecfd;color:#1d4ed8}.opt-chain .opt-spotline td{text-align:center;background:#e2e8f0;font-weight:700}.opt-chain-controls{display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap}.opt-chain-controls select{font:inherit;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px;background:white}.opt-chain .opt-k{min-width:80px}";
  css += ".opt-chain .opt-alert{background:#fef3c7;font-weight:700}.opt-chain{min-width:1450px}";
  css += ".opt-chain.opt-resizable{table-layout:fixed;min-width:0;max-width:none}.opt-chain.opt-resizable td{overflow:hidden;text-overflow:ellipsis}.opt-chain.opt-resizable th{overflow:visible;padding-right:9px}.opt-chain.opt-resizable .opt-k{min-width:0}.opt-resize-label{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.opt-resize-grip{position:absolute;right:0;top:0;bottom:0;width:8px;cursor:col-resize;touch-action:none;border-right:1px solid #cbd5e1;z-index:4}.opt-resize-grip:hover,.opt-resize-grip:focus{background:#93c5fd;outline:none}.opt-resizing,.opt-resizing *{cursor:col-resize!important;user-select:none!important}";
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  function fmtInt(v) {
    return v == null ? "—" : Math.round(v).toLocaleString("ja-JP");
  }
  function fmtStrike(v) {
    if (v == null) return "—";
    return v % 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 })
                 : Math.round(v).toLocaleString("ja-JP");
  }
  function fmtRatio(v) { return v == null ? "—" : v.toFixed(2); }
  function fmtPx(v) {
    return v == null ? "—" : v.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
  }

  var META = {
    jp: {
      title: "日経225オプション",
      note: "出典: JPX「デリバティブ建玉残高表」（日経225オプション、ラージ）。建玉は当該取引日終了時点。チャートは現物に近い行使価格のみ表示し、比率・マックスペインは全行使価格で計算しています。"
    },
    us: {
      title: "SPXオプション（S&P500）",
      note: "出典: CBOE 遅延データ（SPX / SPXW / SPXO を合算）。ATM IV は現物に最も近い行使価格の IV、IV30 は CBOE 公表値。チャートは現物に近い行使価格のみ表示し、比率・マックスペインは全行使価格で計算しています。"
    }
  };


  function chainHTML(block,e,period,filter) {
    var history=(block.history||[]).filter(function(h){return h.date<block.date;}).slice().sort(function(a,b){return b.date.localeCompare(a.date);});
    var prior=history[period-1], prev=prior&&prior.expiries.find(function(x){return x.expiry===e.expiry;});
    var map=new Map((prev&&prev.strikes||[]).map(function(r){return [r[0],r];}));
    var rows=e.strikes.slice().sort(function(a,b){return b[0]-a[0];});
    var atm=block.spot==null||!rows.length?null:rows.reduce(function(a,b){return Math.abs(a[0]-block.spot)<=Math.abs(b[0]-block.spot)?a:b;})[0];
    // Compare the current session with up to 25 prior saved sessions.
    // Missing strikes and dates are never imputed as zero.
    var histMaps=history.slice(0,26).map(function(h){
      var exp=(h.expiries||[]).find(function(x){return x.expiry===e.expiry;});
      return new Map((exp&&exp.strikes||[]).map(function(r){return [r[0],r];}));
    });
    function ratio(n,d){return Number.isFinite(n)&&Number.isFinite(d)&&d>0?100*n/d:null;}
    function zscore(v,values){
      var a=values.filter(Number.isFinite);
      if(!Number.isFinite(v)||a.length<20)return null;
      var mean=a.reduce(function(x,y){return x+y;},0)/a.length;
      var sd=Math.sqrt(a.reduce(function(x,y){return x+(y-mean)*(y-mean);},0)/(a.length-1));
      return sd>0?(v-mean)/sd:null;
    }
    function stats(r,oi,vol,delta){
      var past=histMaps.map(function(m){return m.get(r[0]);});
      var vols=past.slice(0,25).map(function(x){return x?x[vol]:null;});
      var diffs=past.slice(0,25).map(function(x,i){return x&&past[i+1]?x[oi]-past[i+1][oi]:null;});
      var prevDay=past[0], daily=prevDay?r[oi]-prevDay[oi]:null;
      return {pct:ratio(delta,map.has(r[0])?map.get(r[0])[oi]:null),turn:ratio(r[vol],prevDay?prevDay[oi]:null),vz:zscore(r[vol],vols),oz:zscore(daily,diffs)};
    }
    // Common absolute scale across both sides of the selected expiry.
    var oiMax=rows.reduce(function(m,r){return Math.max(m,Number(r[1])||0,Number(r[2])||0);},0);
    function shares(r){return [ratio(r[1],e.call_oi),ratio(r[2],e.put_oi),ratio(r[3],e.call_vol),ratio(r[4],e.put_vol)];}
    var shareMax=[0,0];rows.forEach(function(r){var p=shares(r);shareMax[0]=Math.max(shareMax[0],p[0]||0,p[1]||0);shareMax[1]=Math.max(shareMax[1],p[2]||0,p[3]||0);});
    var totalRows=rows.length;
    rows=rows.filter(function(r){
      if(filter.atm&&r[0]===atm)return true;
      var vals=filter.mode==='share'?shares(r):r.slice(1,5);
      var oi=filter.oi===0||vals.slice(0,2).some(function(v){return Number.isFinite(v)&&v>=filter.oi;});
      var vol=filter.vol===0||vals.slice(2,4).some(function(v){return Number.isFinite(v)&&v>=filter.vol;});
      if(filter.oi===0)return filter.vol===0||vol;
      if(filter.vol===0)return oi;
      return filter.op==="AND"?oi&&vol:oi||vol;
    });
    function cell(v,kind,cls) {
      var missing=v==null||!Number.isFinite(v), c=cls||"";
      if(missing)c+=" opt-missing";
      else if(kind==="chg"||kind==="pct"||kind==="z")c+=v>0?" opt-up":v<0?" opt-down":"";
      if(!missing&&kind==="z"&&Math.abs(v)>=2)c+=" opt-alert";
      var t=missing?"—":(kind==="oiShare"||kind==="volShare")?v.toFixed(2)+"%":(kind==="iv"||kind==="pct"||kind==="ratio")?((kind==="pct"&&v>0)?"+":"")+v.toFixed(1)+"%":kind==="z"?(v>0?"+":"")+v.toFixed(2):kind==="money"?v.toFixed(2):kind==="chg"?(v>0?"+":"")+fmtInt(v):fmtPx(v);
      var heat="";
      var heatMax=kind==="oi"?oiMax:kind==="oiShare"?shareMax[0]:kind==="volShare"?shareMax[1]:0;
      if(!missing&&v>0&&heatMax>0){
        var intensity=Math.sqrt(v/heatMax);
        var alpha=0.06+0.64*intensity;
        heat=" style='background-color:rgba(37,99,235,"+alpha.toFixed(3)+");color:"+(alpha>=0.58?"#102451":"#182437")+";font-weight:"+(intensity>=0.55?"700":"400")+"'";
      }
      return "<td class='"+c+"'"+heat+">"+t+"</td>";
    }
    var h="<div class='opt-chain-controls'><label>建玉比較 <select data-oi-period>";
    [1,3,10,25].forEach(function(p){h+="<option value='"+p+"'"+(p===period?" selected":"")+">"+p+"取引日</option>";});
    h+="</select></label><span class='opt-note' style='margin:0'>"+(prior?"比較日："+prior.date:"比較履歴不足")+"｜価格・IV・金額は取得済みのもののみ表示</span></div>";
    var shareMode=filter.mode==="share", unit=shareMode?"%":"枚", step=shareMode?"0.01":"1", suffix=shareMode?"占有率":"";
    h+="<div class='opt-chain-controls'><label>基準 <select data-opt-mode><option value='count'"+(!shareMode?" selected":"")+">枚数</option><option value='share'"+(shareMode?" selected":"")+">占有率</option></select></label><label>最小建玉"+suffix+" <input data-opt-oi type='number' min='0' step='"+step+"' style='width:85px' value='"+filter.oi+"'> "+unit+"</label><label>最小出来高"+suffix+" <input data-opt-vol type='number' min='0' step='"+step+"' style='width:85px' value='"+filter.vol+"'> "+unit+"</label><select data-opt-op><option value='OR'"+(filter.op==="OR"?" selected":"")+">OR（いずれか）</option><option value='AND'"+(filter.op==="AND"?" selected":"")+">AND（両方）</option></select><label><input type='checkbox' data-opt-atm"+(filter.atm?" checked":"")+">ATM常時表示</label>";
    (shareMode?[[0,0,"全表示"],[0.5,0.5,"通常"],[1,1,"重要"],[3,3,"大口集中"]]:[[0,0,"全表示"],[500,100,"通常"],[1000,200,"重要"],[3000,500,"大口集中"]]).forEach(function(p){h+="<button type='button' data-opt-preset='"+p[0]+","+p[1]+"' aria-pressed='"+(filter.oi===p[0]&&filter.vol===p[1])+"'>"+p[2]+"</button>";});
    h+="<span class='opt-note' style='margin:0'>表示 "+rows.length+" / "+totalRows+" 行使価格</span></div>";
    h+="<div class='opt-chain-scroll'><table class='opt-chain'><thead><tr><th colspan='13' class='opt-put-head'>PUT プット</th><th rowspan='2' class='opt-k'>行使価格</th><th colspan='13' class='opt-call-head'>CALL コール</th></tr><tr><th>IV前日比</th><th>IV</th><th>清算値</th><th>増減額(億)</th><th>出来高σ</th><th>出来高/建玉</th><th>出来高占有率</th><th>出来高</th><th>建玉増減σ</th><th>建玉増減率</th><th>建玉増減</th><th>建玉占有率</th><th>建玉</th><th>建玉</th><th>建玉占有率</th><th>建玉増減</th><th>建玉増減率</th><th>建玉増減σ</th><th>出来高</th><th>出来高占有率</th><th>出来高/建玉</th><th>出来高σ</th><th>増減額(億)</th><th>清算値</th><th>IV</th><th>IV前日比</th></tr></thead><tbody>";
    var marker=false;
    rows.forEach(function(r){
      if(!marker&&block.spot!=null&&r[0]<block.spot){h+="<tr class='opt-spotline'><td colspan='27'>日経平均 "+fmtPx(block.spot)+"</td></tr>";marker=true;}
      var old=map.get(r[0]), cd=old?r[1]-old[1]:null,pd=old?r[2]-old[2]:null;
      var q=(e.quotes||{})[String(r[0])]||{}, c=q.call||{}, p=q.put||{};
      var cc=r[0]<block.spot?"opt-itm":"",pc=r[0]>block.spot?"opt-itm":"";
      var ps=stats(r,2,4,pd), cs=stats(r,1,3,cd);
      var prevExp=history[0]&&(history[0].expiries||[]).find(function(x){return x.expiry===e.expiry;});
      var pq=(prevExp&&prevExp.quotes||{})[String(r[0])]||{};
      function ivdiff(cur,old){return Number.isFinite(cur.iv)&&old&&Number.isFinite(old.iv)?cur.iv-old.iv:null;}
      h+="<tr"+(r[0]===atm?" class='opt-atm'":"")+">"+cell(ivdiff(p,pq.put),"pct",pc)+cell(p.iv,"iv",pc)+cell(p.settlement,"price",pc)+cell(pd!=null&&p.settlement!=null?pd*p.settlement/100000:null,"money",pc)+cell(ps.vz,"z",pc)+cell(ps.turn,"ratio",pc)+cell(ratio(r[4],e.put_vol),"volShare",pc)+cell(r[4],"int",pc)+cell(ps.oz,"z",pc)+cell(ps.pct,"pct",pc)+cell(pd,"chg",pc)+cell(ratio(r[2],e.put_oi),"oiShare",pc)+cell(r[2],"oi",pc)+"<td class='opt-k'>"+fmtStrike(r[0])+"</td>"+cell(r[1],"oi",cc)+cell(ratio(r[1],e.call_oi),"oiShare",cc)+cell(cd,"chg",cc)+cell(cs.pct,"pct",cc)+cell(cs.oz,"z",cc)+cell(r[3],"int",cc)+cell(ratio(r[3],e.call_vol),"volShare",cc)+cell(cs.turn,"ratio",cc)+cell(cs.vz,"z",cc)+cell(cd!=null&&c.settlement!=null?cd*c.settlement/100000:null,"money",cc)+cell(c.settlement,"price",cc)+cell(c.iv,"iv",cc)+cell(ivdiff(c,pq.call),"pct",cc)+"</tr>";
    });
    if(!marker&&block.spot!=null)h+="<tr class='opt-spotline'><td colspan='27'>日経平均 "+fmtPx(block.spot)+"</td></tr>";
    return h+"</tbody></table></div><p class='opt-note'>占有率＝同一限月・同一種類（PUT/CALL別）の全建玉または全出来高に対する割合。分母ゼロ・欠損は — 。建玉増減＝同一限月・同一行使価格の建玉差。増減額＝建玉増減×当日清算値×1,000円（億円換算、資金流入額ではありません）。建玉増減率＝比較期間の増減÷比較日の建玉。出来高/建玉＝当日出来高÷前日建玉。σは当日の値を過去最大25観測（最低20観測）の平均・標本標準偏差で標準化。建玉増減σは日次差、黄色は絶対値2以上。IV前日比はポイント差。建玉セルは同一限月のプット・コール共通の最大建玉を基準に青色の濃淡で表示（平方根スケール）。薄緑：ITM、薄青：ATM。比較対象外・未取得は — 。</p>";
  }


  function enableChainResize(root) {
    var table=root.querySelector(".opt-chain");
    if(!table)return;
    var head=table.tHead, second=Array.from(head.rows[1].cells);
    var n=second.length/2;var headers=second.slice(0,n).concat([head.rows[0].cells[1]],second.slice(n));
    var leftDefaults=[72,52,65,80,72,88,92,65,85,92,76,92,70];var defaults=leftDefaults.concat([84],leftDefaults.slice().reverse());
    var oldIndexes=[0,1,2,3,4,5,7,8,9,10,12,13,14,16,17,18,19,21,22,23,24,25,26];
    var key="nikkei-options-column-widths-v2";
    var widths=defaults.slice();
    try {
      var saved=JSON.parse(localStorage.getItem(key));
      if(Array.isArray(saved)&&saved.length===headers.length)
        widths=saved.map(function(v,i){return Number.isFinite(v)?Math.max(36,Math.min(500,v)):defaults[i];});
      else {var legacy=JSON.parse(localStorage.getItem("nikkei-options-column-widths-v1"));if(Array.isArray(legacy)&&legacy.length===23)oldIndexes.forEach(function(k,i){if(Number.isFinite(legacy[i]))widths[k]=Math.max(36,Math.min(500,legacy[i]));});}
    } catch(err){}
    var group=document.createElement("colgroup");
    var cols=headers.map(function(){var c=document.createElement("col");group.appendChild(c);return c;});
    table.insertBefore(group,table.firstChild);
    table.classList.add("opt-resizable");
    var visibilityKey="nikkei-options-column-visibility-v2";
    var labels=second.slice(0,n).map(function(th){return th.textContent;});
    var visible=labels.map(function(){return true;});
    try{var stored=JSON.parse(localStorage.getItem(visibilityKey));if(Array.isArray(stored)&&stored.length===n&&stored.every(function(v){return typeof v==="boolean";}))visible=stored;else{var legacy=JSON.parse(localStorage.getItem("nikkei-options-column-visibility-v1"));if(Array.isArray(legacy)&&legacy.length===11)[0,1,2,3,4,5,7,8,9,10,12].forEach(function(k,i){if(typeof legacy[i]==="boolean")visible[k]=legacy[i];});}}catch(err){}
    function shown(i){return i===n||visible[i<n?i:2*n-i];}
    function saveVisibility(){try{localStorage.setItem(visibilityKey,JSON.stringify(visible));}catch(err){}}
    function apply(){
      var count=visible.filter(Boolean).length;
      cols.forEach(function(c,i){c.style.width=shown(i)?widths[i]+"px":"0px";c.style.display=shown(i)?"":"none";headers[i].style.display=shown(i)?"":"none";});
      Array.from(table.tBodies[0].rows).forEach(function(row){
        if(row.cells.length===2*n+1)Array.from(row.cells).forEach(function(c,i){c.style.display=shown(i)?"":"none";});
        else if(row.cells.length===1)row.cells[0].colSpan=1+2*count;
      });
      var top=head.rows[0].cells;
      [top[0],top[2]].forEach(function(c){c.colSpan=Math.max(1,count);c.style.display=count?"":"none";});
      var width=widths.reduce(function(a,b,i){return a+(shown(i)?b:0);},0);
      table.style.width=width+"px";table.style.minWidth=width+"px";
    }
    function save(){try{localStorage.setItem(key,JSON.stringify(widths));}catch(err){}}
    function adjust(i,v){widths[i]=Math.max(36,Math.min(500,Math.round(v)));apply();}
    headers.forEach(function(th,i){
      var label=th.textContent, span=document.createElement("span");
      span.className="opt-resize-label";span.textContent=label;th.textContent="";th.appendChild(span);th.title=label;
      var grip=document.createElement("span");grip.className="opt-resize-grip";grip.tabIndex=0;
      grip.setAttribute("role","separator");grip.setAttribute("aria-orientation","vertical");
      grip.setAttribute("aria-label",label+"の列幅（左右キーで調整）");
      grip.title="ドラッグで列幅調整・ダブルクリックで初期幅";
      th.appendChild(grip);
      grip.addEventListener("pointerdown",function(ev){
        if(ev.button!==0)return;
        ev.preventDefault();var start=ev.clientX,w=widths[i],pid=ev.pointerId;
        grip.setPointerCapture(pid);document.body.classList.add("opt-resizing");
        function move(e){if(e.pointerId===pid)adjust(i,w+e.clientX-start);}
        function end(e){if(e.pointerId!==pid)return;grip.removeEventListener("pointermove",move);grip.removeEventListener("pointerup",end);grip.removeEventListener("pointercancel",end);grip.removeEventListener("lostpointercapture",end);document.body.classList.remove("opt-resizing");save();}
        grip.addEventListener("pointermove",move);grip.addEventListener("pointerup",end);grip.addEventListener("pointercancel",end);grip.addEventListener("lostpointercapture",end);
      });
      grip.addEventListener("dblclick",function(){adjust(i,defaults[i]);save();});
      grip.addEventListener("keydown",function(ev){if(ev.key==="ArrowLeft"||ev.key==="ArrowRight"){ev.preventDefault();adjust(i,widths[i]+(ev.key==="ArrowRight"?8:-8));save();}});
    });
    var controls=root.querySelector(".opt-chain-controls");
    if(controls){
      var reset=document.createElement("button");reset.type="button";reset.textContent="列幅リセット";
      reset.addEventListener("click",function(){widths=defaults.slice();apply();save();});
      controls.appendChild(reset);
      var details=document.createElement("details");details.style.cssText="position:relative;display:inline-block";
      var summary=document.createElement("summary");summary.textContent="表示列";summary.style.cssText="cursor:pointer;padding:4px 8px;border:1px solid #cbd5e1;border-radius:4px";details.appendChild(summary);
      var menu=document.createElement("div");menu.style.cssText="position:absolute;top:100%;left:0;z-index:20;background:white;color:#182437;border:1px solid #cbd5e1;border-radius:6px;padding:10px;min-width:200px;box-shadow:0 4px 12px #0002;display:grid;gap:5px";details.appendChild(menu);
      var buttons=document.createElement("div");buttons.style.cssText="display:flex;gap:6px";menu.appendChild(buttons);
      var checks=[];
      function sync(){checks.forEach(function(c,i){c.checked=visible[i];});summary.textContent="表示列 ("+visible.filter(Boolean).length+"/"+n+")";apply();saveVisibility();}
      [["全表示",function(){return true;}],["基本項目",function(i){return [6,7,10,11,12].includes(i);}]].forEach(function(p){var b=document.createElement("button");b.type="button";b.textContent=p[0];b.onclick=function(){visible=labels.map(function(_,i){return p[1](i);});sync();};buttons.appendChild(b);});
      labels.slice().reverse().forEach(function(label,j){var i=n-1-j;var l=document.createElement("label");l.style.cssText="display:flex;gap:6px;align-items:center;white-space:nowrap";var c=document.createElement("input");c.type="checkbox";c.checked=visible[i];checks[i]=c;c.onchange=function(){visible[i]=c.checked;sync();};l.appendChild(c);l.appendChild(document.createTextNode(label));menu.appendChild(l);});
      summary.textContent="表示列 ("+visible.filter(Boolean).length+"/"+n+")";
      var note=document.createElement("small");note.textContent="PUT/CALL共通・行使価格は常時表示";menu.appendChild(note);controls.appendChild(details);
      var tip=document.createElement("span");tip.className="opt-note";tip.style.margin="0";tip.textContent="列見出しの右端をドラッグして幅を調整";controls.appendChild(tip);
    }
    apply();
  }


  function participantPanel(root,block,e){
    var panel=document.createElement("section");
    panel.style.cssText="margin:14px 0;padding:10px;border:1px solid #dbe3ed;border-radius:6px;background:white";
    root.appendChild(panel);
    var key="nikkei-participants-weekly-v1", data=[];
    try{data=JSON.parse(localStorage.getItem(key)||"[]");if(!Array.isArray(data))data=[];}catch(err){}
    var firms=["GS","JPM","UBS","BNP","MS","SG","ABN","野村"], selected=new Set(firms), mode="change";
    panel.innerHTML="<strong>大口ポジション分析（週次・行使価格別）</strong><p class='opt-note'>JPX公表対象は期近限月のATM付近5行使価格・上位15参加者。公表対象外は —。証券会社経由の顧客取引を含みます。<br><a href='https://www.jpx.co.jp/markets/derivatives/open-interest/index.html' target='_blank' rel='noopener'>JPX 取引参加者別建玉残高一覧</a>｜CSV読込試験版（自動取得未対応）</p><label>CSV読込 <input type='file' accept='.csv,text/csv'></label> <button type='button' data-template>CSV形式</button><p data-message class='opt-note'></p><div data-controls></div><div data-result></div>";
    var msg=panel.querySelector("[data-message]"), controls=panel.querySelector("[data-controls]"), result=panel.querySelector("[data-result]");
    function draw(){
      var allDates=Array.from(new Set(data.map(function(r){return r.date;}))).sort().reverse(), now=allDates[0], prior=allDates[1];
      var rows=data.filter(function(r){return r.expiry===e.expiry&&(r.date===now||r.date===prior);});
      var strikes=Array.from(new Set(rows.map(function(r){return r.strike;}))).sort(function(a,b){return b-a;});
      var active=firms.filter(function(n){return selected.has(n);});
      if(!active.length){result.textContent="証券会社を選択してください。";return;}
      var values=new Map(rows.map(function(r){return [[r.date,r.strike,r.side,r.firm].join("|"),r.net];}));
      var table=document.createElement("table");table.className="opt-chain";table.style.minWidth="0";table.style.tableLayout="auto";
      var head=table.createTHead(), hr=head.insertRow();
      function th(row,t,span){var c=document.createElement("th");c.textContent=t;c.colSpan=span||1;row.appendChild(c);return c;}
      th(hr,"PUT",active.length).className="opt-put-head";th(hr,"行使価格");th(hr,"CALL",active.length).className="opt-call-head";
      var names=head.insertRow();active.slice().reverse().forEach(function(n){th(names,n);});th(names,"円");active.forEach(function(n){th(names,n);});
      var body=table.createTBody();
      function val(k,side,firm){var a=values.get([now,k,side,firm].join("|")), b=values.get([prior,k,side,firm].join("|"));return mode==="balance"?a:(a==null||b==null?null:a-b);}
      var max=1;strikes.forEach(function(k){active.forEach(function(n){["P","C"].forEach(function(side){max=Math.max(max,Math.abs(val(k,side,n)||0));});});});
      function add(tr,v){var c=tr.insertCell();c.textContent=v==null?"—":(v>0?"+":"")+fmtInt(v);if(v){c.style.color=v>0?"#15803d":"#dc2626";c.style.backgroundColor=(v>0?"rgba(22,163,74,":"rgba(220,38,38,")+(0.06+0.30*Math.abs(v)/max)+")";}else if(v==null)c.className="opt-missing";}
      strikes.forEach(function(k){var tr=body.insertRow();active.slice().reverse().forEach(function(n){add(tr,val(k,"P",n));});var c=tr.insertCell();c.className="opt-k";c.textContent=fmtStrike(k);active.forEach(function(n){add(tr,val(k,"C",n));});});
      result.textContent="";
      var note=document.createElement("p");note.className="opt-note";note.textContent="対象限月："+e.label+"｜最新："+(now||"未取得")+"｜比較："+(prior||"未取得")+"｜単位：枚、緑＝買超方向、赤＝売超方向。";result.appendChild(note);
      if(!strikes.length){var p=document.createElement("p");p.className="opt-note";p.textContent="この限月の公表データはまだ読み込まれていません。";result.appendChild(p);return;}
      var wrap=document.createElement("div");wrap.className="opt-chain-scroll";wrap.appendChild(table);result.appendChild(wrap);
    }
    var select=document.createElement("select");[["change","前週比"],["balance","ネット建玉"]].forEach(function(a){var o=document.createElement("option");o.value=a[0];o.textContent=a[1];select.appendChild(o);});select.onchange=function(){mode=select.value;draw();};controls.appendChild(select);
    firms.forEach(function(n){var label=document.createElement("label");label.style.marginLeft="10px";var c=document.createElement("input");c.type="checkbox";c.checked=true;c.onchange=function(){if(c.checked)selected.add(n);else selected.delete(n);draw();};label.appendChild(c);label.appendChild(document.createTextNode(n));controls.appendChild(label);});
    panel.querySelector("[data-template]").onclick=function(){msg.textContent="CSVヘッダー: date,expiry,strike,side,firm,net（date/expiryはYYYY-MM-DD、sideはPまたはC、firmは上記略称、netは買超を正・売超を負。数値はカンマなし）";};
    panel.querySelector("input[type=file]").onchange=async function(ev){try{
      var file=ev.target.files[0];if(!file)return;var lines=(await file.text()).replace(/^\uFEFF/,"").trim().split(/\r?\n/);
      if(lines.shift().trim()!=="date,expiry,strike,side,firm,net")throw Error("ヘッダーが違います。CSV形式を確認してください。");
      var incoming=lines.filter(function(l){return l.trim();}).map(function(l){var a=l.split(",").map(function(v){return v.trim();});if(a.length!==6||!/^\d{4}-\d{2}-\d{2}$/.test(a[0])||!/^\d{4}-\d{2}-\d{2}$/.test(a[1])||!/^\d+$/.test(a[2])||!["P","C"].includes(a[3])||!firms.includes(a[4])||!/^[-+]?\d+$/.test(a[5]))throw Error("不正な行があります。");return {date:a[0],expiry:a[1],strike:Number(a[2]),side:a[3],firm:a[4],net:Number(a[5])};});
      var m=new Map(data.concat(incoming).map(function(r){return [[r.date,r.expiry,r.strike,r.side,r.firm].join("|"),r];}));data=Array.from(m.values());try{localStorage.setItem(key,JSON.stringify(data));}catch(err){}msg.textContent=incoming.length+"行を読み込みました。";draw();
    }catch(err){msg.textContent=err.message;}};
    draw();
  }

  function render(root, block) {
    var market = root.getAttribute("data-opt-market");
    var meta = META[market] || { title: market, note: "" };
    if (!block || !block.expiries || !block.expiries.length) {
      root.innerHTML = "<p class='info'>オプションデータは準備中です。</p>";
      return;
    }
    var sel = 0, oiPeriod = 1;
    var filter={mode:"share",oi:1,vol:1,op:"OR",atm:true,count:{oi:500,vol:100},share:{oi:1,vol:1}};
    try{var saved=JSON.parse(localStorage.getItem("nikkei-option-filter-v2")||"null");function validPair(p,mode){return p&&[p.oi,p.vol].every(function(v){return Number.isFinite(v)&&v>=0&&(mode==="share"?v<=100:Number.isSafeInteger(v));});}if(saved&&["count","share"].includes(saved.mode)&&validPair(saved,saved.mode)&&validPair(saved.count,"count")&&validPair(saved.share,"share")&&["OR","AND"].includes(saved.op)&&typeof saved.atm==="boolean")filter=saved;else{var legacy=JSON.parse(localStorage.getItem("nikkei-option-filter-v1")||"null");if(validPair(legacy,"count"))filter.count={oi:legacy.oi,vol:legacy.vol};}}catch(err){}
    function saveFilter(){filter[filter.mode]={oi:filter.oi,vol:filter.vol};try{localStorage.setItem("nikkei-option-filter-v2",JSON.stringify(filter));}catch(err){}draw();}
    function draw() {
      var e = block.expiries[sel];
      var maxOi = 1;
      e.strikes.forEach(function (s) {
        maxOi = Math.max(maxOi, s[1], s[2]);
      });
      var tiles = [
        ["コール建玉", fmtInt(e.call_oi) + " 枚"],
        ["プット建玉", fmtInt(e.put_oi) + " 枚"],
        ["PC比率（建玉）", fmtRatio(e.pc_oi)],
        ["PC比率（出来高）", fmtRatio(e.pc_vol)],
        ["マックスペイン", fmtStrike(e.max_pain)],
        ["ATM IV", e.atm_iv == null ? "—" : e.atm_iv.toFixed(1) + "%"]
      ];
      var html = "<div class='opt-head'>" + meta.title +
        "｜データ日付 " + (block.date || "—") +
        "｜現物 " + fmtPx(block.spot) +
        (block.iv30 != null ? "｜IV30 " + block.iv30.toFixed(1) + "%" : "") +
        "</div>";
      html += "<div class='opt-chips' role='tablist'>";
      block.expiries.forEach(function (x, i) {
        html += "<button type='button' data-exp='" + i + "' aria-selected='" +
          (i === sel) + "'>" + x.label +
          (market === "us" && x.monthly ? "（月次）" : "") + "</button>";
      });
      html += "</div><div class='opt-tiles'>";
      tiles.forEach(function (t) {
        html += "<div class='opt-tile'><div class='k'>" + t[0] +
          "</div><div class='v'>" + t[1] + "</div></div>";
      });
      html += "</div>";
      if (market === "jp") { html += chainHTML(block,e,oiPeriod,filter); } else {
      html += "<div class='opt-colhead'><div class='opt-bar put'><span>プット建玉</span></div>" +
        "<div class='opt-strike'>行使価格</div><div class='opt-bar call'><span>コール建玉</span></div></div>";
      var rows = e.strikes.slice().sort(function (a, b) { return b[0] - a[0]; });
      var spotDrawn = false;
      rows.forEach(function (s) {
        if (!spotDrawn && block.spot != null && s[0] < block.spot) {
          html += "<div class='opt-spot'>現物 " + fmtPx(block.spot) + "</div>";
          spotDrawn = true;
        }
        var pain = e.max_pain != null && s[0] === e.max_pain;
        html += "<div class='opt-row" + (pain ? " pain" : "") + "'>" +
          "<div class='opt-bar put'><span>" + fmtInt(s[2]) + "</span><i style='width:" +
          (s[2] / maxOi * 100).toFixed(1) + "%'></i></div>" +
          "<div class='opt-strike'>" + fmtStrike(s[0]) + "</div>" +
          "<div class='opt-bar call'><i style='width:" +
          (s[1] / maxOi * 100).toFixed(1) + "%'></i><span>" + fmtInt(s[1]) + "</span></div></div>";
      });
      if (!spotDrawn && block.spot != null) {
        html += "<div class='opt-spot'>現物 " + fmtPx(block.spot) + "</div>";
      }
      }
      html += "<p class='opt-note'>" + meta.note + "</p>";
      root.innerHTML = html;
      if(market === "jp"){enableChainResize(root);participantPanel(root,block,e);}
      if(market==="jp"){
        [["oi","[data-opt-oi]"],["vol","[data-opt-vol]"]].forEach(function(pair){
          var input=root.querySelector(pair[1]);input.addEventListener("change",function(){var n=input.valueAsNumber;if(!Number.isFinite(n)||n<0||(filter.mode==="share"?n>100:!Number.isSafeInteger(n))){input.value=filter[pair[0]];return;}filter[pair[0]]=n;saveFilter();});
          input.addEventListener("keydown",function(ev){if(ev.key==="Enter"){ev.preventDefault();input.blur();}});
        });
        root.querySelector("[data-opt-mode]").onchange=function(ev){filter.mode=ev.target.value;filter.oi=filter[filter.mode].oi;filter.vol=filter[filter.mode].vol;saveFilter();};
        root.querySelector("[data-opt-op]").onchange=function(ev){filter.op=ev.target.value;saveFilter();};
        root.querySelector("[data-opt-atm]").onchange=function(ev){filter.atm=ev.target.checked;saveFilter();};
        root.querySelectorAll("[data-opt-preset]").forEach(function(b){b.onclick=function(){var p=b.getAttribute("data-opt-preset").split(",").map(Number);filter.oi=p[0];filter.vol=p[1];saveFilter();};});
      }
      var periodSelect=root.querySelector("[data-oi-period]");
      if(periodSelect)periodSelect.addEventListener("change",function(){oiPeriod=Number(periodSelect.value);draw();});
      root.querySelectorAll("[data-exp]").forEach(function (b) {
        b.addEventListener("click", function () {
          sel = Number(b.getAttribute("data-exp"));
          draw();
        });
      });
    }
    draw();
  }

  fetch("./options.json")
    .then(function (r) { if (!r.ok) throw new Error("http"); return r.json(); })
    .then(function (doc) {
      roots.forEach(function (root) {
        render(root, doc[root.getAttribute("data-opt-market")]);
      });
    })
    .catch(function () {
      roots.forEach(function (root) {
        root.innerHTML = "<p class='info'>オプションデータは準備中です。</p>";
      });
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
