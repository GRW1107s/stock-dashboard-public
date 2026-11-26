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
  css += ".opt-chain-scroll{overflow:auto;max-height:680px;border:1px solid #dbe3ed;border-radius:6px;background:white}.opt-chain{width:100%;min-width:840px;border-collapse:separate;border-spacing:0;table-layout:auto;font-size:11px;font-variant-numeric:tabular-nums}.opt-chain th,.opt-chain td{padding:4px 5px;text-align:right;white-space:nowrap;border-bottom:1px solid #e5eaf1;height:25px}.opt-chain thead th{position:sticky;top:0;background:#eaf0f6;z-index:2;text-align:center;height:26px}.opt-chain thead tr:nth-child(2) th{top:26px}.opt-chain .opt-k{text-align:center;background:#f1f5f9;font-weight:700;border-left:1px solid #dbe3ed;border-right:1px solid #dbe3ed}.opt-chain .opt-itm{background:#edf5ef}.opt-chain .opt-atm td{background:#eef2ff}.opt-chain .opt-up{color:#15803d;font-weight:600}.opt-chain .opt-down{color:#dc2626;font-weight:600}.opt-chain .opt-missing{color:#94a3b8}.opt-chain .opt-call-head{background:#e1ecfd;color:#1d4ed8}.opt-chain .opt-put-head{background:#fff0e5;color:#9a3412}.opt-chain .opt-spotline td{text-align:center;background:#e2e8f0;font-weight:700}.opt-chain-controls{display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap}.opt-chain-controls select{font:inherit;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px;background:white}.opt-chain .opt-k{min-width:80px}";
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


  function chainHTML(block,e,period) {
    var history=(block.history||[]).filter(function(h){return h.date<block.date;}).slice().sort(function(a,b){return b.date.localeCompare(a.date);});
    var prior=history[period-1], prev=prior&&prior.expiries.find(function(x){return x.expiry===e.expiry;});
    var map=new Map((prev&&prev.strikes||[]).map(function(r){return [r[0],r];}));
    var rows=e.strikes.slice().sort(function(a,b){return a[0]-b[0];});
    var atm=block.spot==null||!rows.length?null:rows.reduce(function(a,b){return Math.abs(a[0]-block.spot)<=Math.abs(b[0]-block.spot)?a:b;})[0];
    function cell(v,kind,cls) {
      var missing=v==null||!Number.isFinite(v), c=cls||"";
      if(missing)c+=" opt-missing";
      else if(kind==="chg")c+=v>0?" opt-up":v<0?" opt-down":"";
      var t=missing?"—":kind==="iv"?v.toFixed(2)+"%":kind==="money"?v.toFixed(2):kind==="chg"?(v>0?"+":"")+fmtInt(v):fmtPx(v);
      return "<td class='"+c+"'>"+t+"</td>";
    }
    var h="<div class='opt-chain-controls'><label>建玉比較 <select data-oi-period>";
    [1,3,10,25].forEach(function(p){h+="<option value='"+p+"'"+(p===period?" selected":"")+">"+p+"取引日</option>";});
    h+="</select></label><span class='opt-note' style='margin:0'>"+(prior?"比較日："+prior.date:"比較履歴不足")+"｜価格・IV・金額は取得済みのもののみ表示</span></div>";
    h+="<div class='opt-chain-scroll'><table class='opt-chain'><thead><tr><th colspan='6' class='opt-put-head'>PUT プット</th><th rowspan='2' class='opt-k'>行使価格</th><th colspan='6' class='opt-call-head'>CALL コール</th></tr><tr><th>IV</th><th>清算値</th><th>増減額(億)</th><th>出来高</th><th>建玉残高増減</th><th>建玉残高</th><th>建玉残高</th><th>建玉残高増減</th><th>出来高</th><th>増減額(億)</th><th>清算値</th><th>IV</th></tr></thead><tbody>";
    var marker=false;
    rows.forEach(function(r){
      if(!marker&&block.spot!=null&&r[0]>block.spot){h+="<tr class='opt-spotline'><td colspan='13'>日経平均 "+fmtPx(block.spot)+"</td></tr>";marker=true;}
      var old=map.get(r[0]), cd=old?r[1]-old[1]:null,pd=old?r[2]-old[2]:null;
      var q=(e.quotes||{})[String(r[0])]||{}, c=q.call||{}, p=q.put||{};
      var cc=r[0]<block.spot?"opt-itm":"",pc=r[0]>block.spot?"opt-itm":"";
      h+="<tr"+(r[0]===atm?" class='opt-atm'":"")+">"+cell(p.iv,"iv",pc)+cell(p.settlement,"price",pc)+cell(pd!=null&&p.settlement!=null?pd*p.settlement/100000:null,"money",pc)+cell(r[4],"int",pc)+cell(pd,"chg",pc)+cell(r[2],"int",pc)+"<td class='opt-k'>"+fmtStrike(r[0])+"</td>"+cell(r[1],"int",cc)+cell(cd,"chg",cc)+cell(r[3],"int",cc)+cell(cd!=null&&c.settlement!=null?cd*c.settlement/100000:null,"money",cc)+cell(c.settlement,"price",cc)+cell(c.iv,"iv",cc)+"</tr>";
    });
    if(!marker&&block.spot!=null)h+="<tr class='opt-spotline'><td colspan='13'>日経平均 "+fmtPx(block.spot)+"</td></tr>";
    return h+"</tbody></table></div><p class='opt-note'>建玉残高増減＝同一限月・同一行使価格の建玉差。増減額＝建玉残高増減×当日清算値×1,000円（億円換算、資金流入額ではありません）。薄緑：ITM、薄青：ATM。比較対象外・未取得は — 。</p>";
  }

  function render(root, block) {
    var market = root.getAttribute("data-opt-market");
    var meta = META[market] || { title: market, note: "" };
    if (!block || !block.expiries || !block.expiries.length) {
      root.innerHTML = "<p class='info'>オプションデータは準備中です。</p>";
      return;
    }
    var sel = 0, oiPeriod = 1;
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
      if (market === "jp") { html += chainHTML(block,e,oiPeriod); } else {
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
