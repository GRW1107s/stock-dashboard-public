// Backtest execution for jp-sectors.html and sectors.html (US).
//
// Reads the condition state from the backtest panel, loads the stored
// daily OHLCV (ohlcv/jp/<code>-T.json or ohlcv/us/<ticker>.json,
// written by the data pipeline) and
// simulates: buy when every checked (and evaluable) buy condition plus
// the market DD condition holds, sell when any checked sell condition
// holds. Signals are judged on the close and executed at the next
// session's open. Conditions that need data the daily store does not
// have (RS ranking history, EPS/ROE history, sector strength history,
// market AD/FTD history) are reported as skipped, never faked.
(function () {
  "use strict";

  var BUY_LABELS = {
    vol15: "出来高が20日平均の1.5倍以上",
    eps25: "EPS増加率（前年同期比）が25%以上",
    roe17: "ROEが17%以上",
    rsiGe: "RSI（14日）がしきい値以下",
    sector: "所属セクターが上位を維持",
    tt1: "株価が150日・200日移動平均線より上",
    tt2: "150日MAが200日MAより上",
    tt3: "200日MAが少なくとも1か月上昇",
    tt4: "50日MAが150日・200日MAより上",
    tt5: "株価が50日MAより上",
    tt6: "52週安値から30%以上上昇",
    tt7: "52週高値から25%以内",
    tt8: "RS指数がしきい値以上",
    ftd: "FTD（フォロースルーデー）が発生",
    ad: "AD（買い集め日）がしきい値以上",
    dd: "DD（売り抜け日）がしきい値以下"
  };
  var SELL_LABELS = {
    ma50: "株価が50日移動平均を下回る",
    loss8: "買値から8%下落",
    dropPct: "前日終値からしきい値%以上下落",
    ma200: "株価が200日移動平均を下回る",
    rs70: "RS指数が70以下に低下",
    high25: "52週高値から25%以上下落",
    dd3: "出来高を伴う下落日（DD）が3日出る",
    ddGe: "DD（売り抜け日）がしきい値以上",
    rsiLe: "RSI（14日）がしきい値以上"
  };
  var BUY_EVALUABLE = { vol15: 1, tt1: 1, tt2: 1, tt3: 1, tt4: 1, tt5: 1, tt6: 1, tt7: 1, rsiGe: 1 };
  var SELL_EVALUABLE = { ma50: 1, loss8: 1, ma200: 1, high25: 1, dd3: 1, rsiLe: 1, dropPct: 1, ddGe: 1 };

  function sma(arr, i, n) {
    if (i + 1 < n) return null;
    var s = 0;
    for (var k = i - n + 1; k <= i; k++) {
      if (arr[k] == null) return null;
      s += arr[k];
    }
    return s / n;
  }
  function extreme(arr, i, n, isMax) {
    var from = Math.max(0, i - n + 1), v = null;
    for (var k = from; k <= i; k++) {
      if (arr[k] == null) continue;
      if (v == null || (isMax ? arr[k] > v : arr[k] < v)) v = arr[k];
    }
    return v;
  }

  // rows: [[date, open, high, low, close, volume], ...] ascending by date.
  // cfg: {fromIdx, toIdx, buy:[ids], sell:[ids], ddLimit:null|number,
  //       ddByDate:Map<date, ddCount>|null, rsiBuy:null|number, rsiSell:null|number}
  function runBacktest(rows, cfg) {
    var dates = [], opens = [], highs = [], lows = [], closes = [], vols = [];
    rows.forEach(function (r) {
      dates.push(r[0]); opens.push(r[1]); highs.push(r[2]);
      lows.push(r[3]); closes.push(r[4]); vols.push(r[5] || 0);
    });
    var n = rows.length;
    var ma50 = [], ma150 = [], ma200 = [], ma200Prev = [];
    for (var i = 0; i < n; i++) {
      ma50.push(sma(closes, i, 50));
      ma150.push(sma(closes, i, 150));
      ma200.push(sma(closes, i, 200));
      ma200Prev.push(i >= 21 ? sma(closes, i - 21, 200) : null);
    }
    // Wilder's RSI(14) on closes; null until 14 changes are available.
    var rsi = [];
    (function () {
      var period = 14, avgGain = 0, avgLoss = 0;
      for (var i = 0; i < n; i++) {
        if (i === 0) { rsi.push(null); continue; }
        var diff = closes[i] - closes[i - 1];
        var gain = diff > 0 ? diff : 0, loss = diff < 0 ? -diff : 0;
        if (i <= period) {
          avgGain += gain / period; avgLoss += loss / period;
          rsi.push(i === period ? (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss)) : null);
        } else {
          avgGain = (avgGain * (period - 1) + gain) / period;
          avgLoss = (avgLoss * (period - 1) + loss) / period;
          rsi.push(avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss));
        }
      }
    })();
    function ddOk(i) {
      if (cfg.ddLimit == null) return true;
      if (!cfg.ddByDate) return false;
      // carry the most recent known count forward
      for (var k = i; k >= 0; k--) {
        if (cfg.ddByDate.has(dates[k])) return cfg.ddByDate.get(dates[k]) <= cfg.ddLimit;
      }
      return false;
    }
    function buyOk(i) {
      for (var j = 0; j < cfg.buy.length; j++) {
        var id = cfg.buy[j], c = closes[i];
        if (id === "vol15") {
          var avg = sma(vols, i - 1, 20);
          if (avg == null || avg <= 0 || vols[i] < 1.5 * avg) return false;
        } else if (id === "tt1") {
          if (ma150[i] == null || ma200[i] == null || !(c > ma150[i] && c > ma200[i])) return false;
        } else if (id === "tt2") {
          if (ma150[i] == null || ma200[i] == null || !(ma150[i] > ma200[i])) return false;
        } else if (id === "tt3") {
          if (ma200[i] == null || ma200Prev[i] == null || !(ma200[i] > ma200Prev[i])) return false;
        } else if (id === "tt4") {
          if (ma50[i] == null || ma150[i] == null || ma200[i] == null || !(ma50[i] > ma150[i] && ma50[i] > ma200[i])) return false;
        } else if (id === "tt5") {
          if (ma50[i] == null || !(c > ma50[i])) return false;
        } else if (id === "tt6") {
          var lo = extreme(lows, i, 252, false);
          if (lo == null || !(c >= lo * 1.30)) return false;
        } else if (id === "tt7") {
          var hi = extreme(highs, i, 252, true);
          if (hi == null || !(c >= hi * 0.75)) return false;
        } else if (id === "rsiGe") {
          if (cfg.rsiBuy == null || rsi[i] == null || !(rsi[i] <= cfg.rsiBuy)) return false;
        }
      }
      return ddOk(i);
    }
    function sellReason(i, pos) {
      for (var j = 0; j < cfg.sell.length; j++) {
        var id = cfg.sell[j], c = closes[i];
        if (id === "ma50" && ma50[i] != null && c < ma50[i]) return id;
        if (id === "loss8" && c <= pos.price * 0.92) return id;
        if (id === "ma200" && ma200[i] != null && c < ma200[i]) return id;
        if (id === "high25") {
          var hi2 = extreme(highs, i, 252, true);
          if (hi2 != null && c <= hi2 * 0.75) return id;
        }
        if (id === "rsiLe" && cfg.rsiSell != null && rsi[i] != null && rsi[i] >= cfg.rsiSell) return id;
        if (id === "dropPct" && cfg.dropPct != null && i > 0 && closes[i - 1] > 0 && c / closes[i - 1] - 1 <= -cfg.dropPct / 100) return id;
        if (id === "ddGe" && cfg.ddSell != null && cfg.ddByDate) {
          for (var k2 = i; k2 >= 0; k2--) {
            if (cfg.ddByDate.has(dates[k2])) { if (cfg.ddByDate.get(dates[k2]) >= cfg.ddSell) return id; break; }
          }
        }
        if (id === "dd3") {
          var cnt = 0;
          for (var k = pos.execIdx + 1; k <= i; k++) {
            if (closes[k] < closes[k - 1] && vols[k] > vols[k - 1]) cnt++;
          }
          if (cnt >= 3) return id;
        }
      }
      return null;
    }

    var from = Math.max(0, cfg.fromIdx), to = Math.min(n - 1, cfg.toIdx);
    var trades = [], pos = null, pendingBuy = false, pendingSell = null;
    var equity = [], cash = 1;
    for (var d = from; d <= to; d++) {
      if (pendingBuy && !pos) {
        pos = { execIdx: d, signalIdx: d - 1, price: opens[d], date: dates[d] };
        pendingBuy = false;
      } else if (pendingSell && pos) {
        var ret = opens[d] / pos.price - 1;
        trades.push({
          buyDate: pos.date, buyPrice: pos.price, sellDate: dates[d],
          sellPrice: opens[d], ret: ret, hold: d - pos.execIdx,
          reason: pendingSell, open: false
        });
        cash *= opens[d] / pos.price;
        pos = null; pendingSell = null;
      }
      equity.push(pos ? cash * closes[d] / pos.price : cash);
      if (d === to) break;
      if (!pos && !pendingBuy && buyOk(d)) pendingBuy = true;
      if (pos && !pendingSell) {
        var r = sellReason(d, pos);
        if (r) pendingSell = r;
      }
    }
    if (pos) {
      trades.push({
        buyDate: pos.date, buyPrice: pos.price, sellDate: dates[to],
        sellPrice: closes[to], ret: closes[to] / pos.price - 1,
        hold: to - pos.execIdx, reason: "period-end", open: true
      });
    }
    var closed = trades.filter(function (t) { return !t.open; });
    var wins = closed.filter(function (t) { return t.ret > 0; });
    var peak = 0, maxDd = 0;
    equity.forEach(function (e) {
      if (e > peak) peak = e;
      if (peak > 0 && 1 - e / peak > maxDd) maxDd = 1 - e / peak;
    });
    var finalEq = equity.length ? equity[equity.length - 1] : 1;
    function sharpeOf(rets) {
      if (rets.length < 2) return null;
      var mean = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
      var sd = Math.sqrt(rets.reduce(function (a, r) { return a + (r - mean) * (r - mean); }, 0) / (rets.length - 1));
      return sd > 0 ? mean / sd * Math.sqrt(252) : null;
    }
    var eqRets = [];
    for (var ei = 1; ei < equity.length; ei++) if (equity[ei - 1] > 0) eqRets.push(equity[ei] / equity[ei - 1] - 1);
    var bhRets = [], bhPeak = 0, bhMaxDd = 0;
    for (var bi = from; bi <= to; bi++) {
      if (closes[bi] > bhPeak) bhPeak = closes[bi];
      if (bhPeak > 0 && 1 - closes[bi] / bhPeak > bhMaxDd) bhMaxDd = 1 - closes[bi] / bhPeak;
      if (bi > from && closes[bi - 1] > 0) bhRets.push(closes[bi] / closes[bi - 1] - 1);
    }
    return {
      trades: trades,
      perf: {
        totalReturn: finalEq - 1,
        bhReturn: to > from ? closes[to] / closes[from] - 1 : 0,
        closedCount: closed.length,
        winRate: closed.length ? wins.length / closed.length : null,
        avgRet: closed.length ? closed.reduce(function (s, t) { return s + t.ret; }, 0) / closed.length : null,
        avgHold: closed.length ? closed.reduce(function (s, t) { return s + t.hold; }, 0) / closed.length : null,
        maxDd: maxDd,
        bhMaxDd: bhMaxDd,
        sharpe: sharpeOf(eqRets),
        bhSharpe: sharpeOf(bhRets),
        hasOpen: !!pos
      },
      range: { from: dates[from], to: dates[to], sessions: to - from + 1 }
    };
  }

  window.BacktestEngine = { runBacktest: runBacktest };

  // ---------- page wiring ----------
  function init() {
    var panel = document.getElementById("backtest-panel");
    if (!panel) return;
    var MARKET = panel.getAttribute("data-bt-market") || "jp";
    function ohlcvUrl(code) {
      return MARKET === "us" ? "ohlcv/us/" + code + ".json" : "ohlcv/jp/" + code + "-T.json";
    }
    function buildNames(leaders) {
      var names = {};
      ((leaders && leaders[MARKET]) || []).forEach(function (r) {
        if (r.ticker) names[MARKET === "us" ? String(r.ticker) : String(r.ticker).replace(/\.T$/, "")] = r.name || "";
      });
      return names;
    }
    // Data coverage note: how much history the backtest can use.
    (function showDataNote() {
      var note = document.getElementById("bt-data-note");
      if (!note) return;
      var label = MARKET === "us" ? "米国株" : "日本株";
      function get(url) { return fetch(url, { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }
      Promise.all([get("ohlcv/coverage.json"), get("ohlcv/backfill10y-state.json"), get("screener-archive/index.json")]).then(function (res) {
        var cov = res[0], st = res[1], arc = res[2], parts = [];
        if (cov && cov[MARKET] && cov[MARKET].files) {
          var c = cov[MARKET];
          var done = st && Array.isArray(st[MARKET]) ? st[MARKET].length : null;
          parts.push("価格データ: " + label + " " + c.files.toLocaleString("ja-JP") + "銘柄（" + c.oldest + "〜" + c.newest + "）" + (done != null ? "、10年分そろった銘柄は " + done.toLocaleString("ja-JP") + "（自動更新で拡大中）" : ""));
        }
        if (arc && Array.isArray(arc.dates) && arc.dates.length) {
          parts.push("スクリーニング履歴: " + arc.dates.length.toLocaleString("ja-JP") + "日分（" + arc.dates[arc.dates.length - 1] + "〜" + arc.dates[0] + "）");
        }
        note.textContent = parts.length ? parts.join("／") : "データ量の集計を表示できませんでした。";
      });
    })();

    var runBtn = document.getElementById("bt-run");
    var results = document.getElementById("bt-results");
    if (!runBtn || !results) return;

    // Collapsible blocks and groups: +/- toggles, state persisted per market.
    (function setupCollapse() {
      var KEY = "stock-dashboard-bt-collapse-" + MARKET;
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { saved = {}; }
      function persist() { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {} }
      function makeBtn(closed) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "bt-collapse-btn";
        b.textContent = closed ? "＋" : "−";
        b.setAttribute("aria-label", "開閉");
        return b;
      }
      panel.querySelectorAll(".bt-block").forEach(function (block) {
        var head = block.querySelector(".bt-block-head");
        if (!head) return;
        var kind = block.classList.contains("screen") ? "screen" : block.classList.contains("buy") ? "buy" : "sell";
        var btn = makeBtn(!!saved["b:" + kind]);
        function apply() {
          var closed = !!saved["b:" + kind];
          btn.textContent = closed ? "＋" : "−";
          block.classList.toggle("bt-closed", closed);
        }
        btn.addEventListener("click", function () { saved["b:" + kind] = !saved["b:" + kind]; persist(); apply(); });
        head.insertBefore(btn, head.firstChild);
        apply();
      });
      panel.querySelectorAll(".bt-group").forEach(function (g) {
        var label = (g.textContent || "").replace(/すべて外す/g, "").trim();
        if (!label) return;
        var host = g.closest(".bt-block");
        var hostKind = host && host.classList.contains("screen") ? "screen" : host && host.classList.contains("buy") ? "buy" : "sell";
        label = hostKind + ":" + label;
        var items = [];
        var el = g.nextElementSibling;
        while (el && !el.classList.contains("bt-group") && !el.classList.contains("bt-block-foot")) {
          if (el.classList.contains("bt-item")) items.push(el);
          el = el.nextElementSibling;
        }
        if (!items.length) return;
        var btn = makeBtn(!!saved["g:" + label]);
        function apply() {
          var closed = !!saved["g:" + label];
          btn.textContent = closed ? "＋" : "−";
          items.forEach(function (it) { it.style.display = closed ? "none" : ""; });
        }
        btn.addEventListener("click", function () { saved["g:" + label] = !saved["g:" + label]; persist(); apply(); });
        g.insertBefore(btn, g.firstChild);
        apply();
      });
    })();

    // Named strategies: save / load / delete the checked condition set.
    (function setupStrategies() {
      var nameInput = document.getElementById("bt-strat-name");
      var saveBtn = document.getElementById("bt-strat-save");
      var listEl = document.getElementById("bt-strat-list");
      if (!saveBtn || !listEl) return;
      var KEY = "stock-dashboard-bt-strategies-" + MARKET;
      var items = [];
      try { items = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { items = []; }
      if (!Array.isArray(items)) items = [];
      function persist() { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {} }
      function collect() {
        var st = { screen: checked("screen"), buy: checked("buy"), sell: checked("sell"), nums: {}, ttRs: "70" };
        panel.querySelectorAll("[data-bt-num]").forEach(function (n) { st.nums[n.getAttribute("data-bt-num")] = n.value; });
        var tt = document.getElementById("bt-tt-rs");
        if (tt) st.ttRs = tt.value;
        return st;
      }
      function apply(st) {
        panel.querySelectorAll('input[type="checkbox"][data-bt]').forEach(function (b) {
          var list = st[b.getAttribute("data-bt")] || [];
          if (b.getAttribute("data-bt") === "buy" && st.market) list = list.concat(st.market);
          var on = list.indexOf(b.value) >= 0;
          if (b.checked !== on) { b.checked = on; b.dispatchEvent(new Event("change", { bubbles: true })); }
        });
        panel.querySelectorAll("[data-bt-num]").forEach(function (n) {
          var v = st.nums ? st.nums[n.getAttribute("data-bt-num")] : undefined;
          if (v !== undefined && n.value !== String(v)) { n.value = String(v); n.dispatchEvent(new Event("change", { bubbles: true })); }
        });
        var tt = document.getElementById("bt-tt-rs");
        if (tt && st.ttRs && tt.value !== String(st.ttRs)) { tt.value = String(st.ttRs); tt.dispatchEvent(new Event("change", { bubbles: true })); }
      }
      function render() {
        listEl.innerHTML = "";
        items.forEach(function (it, idx) {
          var chip = document.createElement("span");
          chip.className = "bt-strat-chip";
          var cmp = document.createElement("input");
          cmp.type = "checkbox"; cmp.checked = !!it.cmp; cmp.title = "比較用に選択";
          cmp.addEventListener("change", function () { it.cmp = cmp.checked; persist(); });
          var name = document.createElement("button");
          name.type = "button"; name.className = "bt-strat-load"; name.textContent = it.name; name.title = "クリックで読み込み";
          name.addEventListener("click", function () { apply(it.state); });
          var del = document.createElement("button");
          del.type = "button"; del.className = "bt-strat-del"; del.textContent = "×"; del.title = "削除";
          del.addEventListener("click", function () { items.splice(idx, 1); persist(); render(); });
          chip.appendChild(cmp); chip.appendChild(name); chip.appendChild(del);
          listEl.appendChild(chip);
        });
      }
      saveBtn.addEventListener("click", function () {
        var nm = nameInput ? String(nameInput.value || "").trim() : "";
        if (!nm) nm = "戦略" + (items.length + 1);
        var st = collect();
        var ex = null;
        items.forEach(function (i) { if (i.name === nm) ex = i; });
        if (ex) ex.state = st; else items.push({ name: nm, state: st, cmp: false });
        persist(); render();
        if (nameInput) nameInput.value = "";
      });
      render();
    })();

    function checked(group) {
      return Array.from(panel.querySelectorAll('input[type="checkbox"][data-bt="' + group + '"]:checked')).map(function (b) { return b.value; });
    }
    function numOf(key) {
      var el = panel.querySelector('[data-bt-num="' + key + '"]');
      return el ? parseInt(el.value, 10) : NaN;
    }
    function esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      });
    }
    function pct(v, digits) {
      if (v == null || !isFinite(v)) return "—";
      return (v * 100).toFixed(digits == null ? 1 : digits) + "%";
    }
    function price(v) {
      return v == null ? "—" : Number(v).toLocaleString("ja-JP", { maximumFractionDigits: 2 });
    }

    function loadJson(url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error(url + " " + r.status);
        return r.json();
      });
    }

    function loadMarketDd(years) {
      var map = new Map();
      var jobs = years.map(function (y) {
        return loadJson("history-" + y + ".json").then(function (h) {
          if (MARKET === "us") {
            (h.rows || []).forEach(function (row) {
              var sp = row && row.sp500;
              if (sp && sp.dd_count != null) map.set(row.date, sp.dd_count);
            });
          } else {
            (h.tse_rows || []).forEach(function (row) {
              var prime = row && row.prime;
              if (prime && prime.dd_count != null) map.set(row.date, prime.dd_count);
            });
          }
        }).catch(function () {});
      });
      return Promise.all(jobs).then(function () { return map; });
    }

    var INDEX_LABELS = { nikkei: "日経225", prime: "東証プライム", standard: "東証スタンダード", growth: "東証グロース", sp500: "S&P500", nasdaq100: "NASDAQ100", nasdaq: "NASDAQ総合", dow: "ダウ" };
    var ETF_NAMES = { "1321": "NEXT FUNDS 日経225連動型上場投信", "1306": "NEXT FUNDS TOPIX連動型上場投信", "QQQ": "インベスコ QQQ（NASDAQ100連動）", "SPY": "SPDR S&P500 ETF（SPY）" };

    // Index targets are judged on closes only: history-<year>.json holds
    // daily index closes (and a volume proxy), so rows are close-filled.
    function loadIndexEntries(keys, years, cfgBase, fromVal, toVal, periodYears) {
      var jobs = years.map(function (y) {
        return loadJson("history-" + y + ".json").catch(function () { return null; });
      });
      return Promise.all(jobs).then(function (files) {
        var byKey = {};
        keys.forEach(function (k) { byKey[k] = new Map(); });
        files.forEach(function (h) {
          if (!h) return;
          (MARKET === "us" ? (h.rows || []) : (h.tse_rows || [])).forEach(function (row) {
            keys.forEach(function (k) {
              var cell = row[k];
              if (cell && cell.close != null) {
                var vol = cell.volume_value > 0 ? cell.volume_value : (cell.shares_10000 || 0);
                byKey[k].set(row.date, [row.date, cell.close, cell.close, cell.close, cell.close, vol]);
              }
            });
          });
        });
        var out = [];
        keys.forEach(function (k) {
          var rows = Array.from(byKey[k].values()).sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
          var title = esc(INDEX_LABELS[k] || k) + "（指数）";
          if (!rows.length) { out.push({ title: title, out: null, noData: "指数データがありません。" }); return; }
          var lastDate = rows[rows.length - 1][0];
          var startDate = fromVal;
          if (!startDate) {
            var d = new Date(lastDate + "T00:00:00");
            d.setFullYear(d.getFullYear() - periodYears);
            startDate = d.toISOString().slice(0, 10);
          }
          var endDate = toVal || lastDate;
          var fromIdx = rows.findIndex(function (r) { return r[0] >= startDate; });
          var toIdx = -1;
          for (var i = rows.length - 1; i >= 0; i--) { if (rows[i][0] <= endDate) { toIdx = i; break; } }
          if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) {
            out.push({ title: title, out: null, noData: "指定期間のデータがありません（保有データ：" + rows[0][0] + " 〜 " + lastDate + "）。" });
            return;
          }
          var res = runBacktest(rows, {
            fromIdx: fromIdx, toIdx: toIdx, buy: cfgBase.buy, sell: cfgBase.sell,
            ddLimit: cfgBase.ddLimit, ddByDate: cfgBase.ddMap, rsiBuy: rsiBuyVal, rsiSell: rsiSellVal, dropPct: dropPctVal, ddSell: ddSellVal
          });
          out.push({ title: title, out: res });
        });
        return out;
      });
    }

    // One stock's trade list, shown under the summary table.
    function stockTradesHtml(title, out) {
      var html = '<div class="bt-res-block"><h4>' + title + '</h4>';
      html += '<p class="bt-res-range">期間：' + esc(out.range.from) + " 〜 " + esc(out.range.to) + "（" + out.range.sessions + '営業日）</p>';
      if (out.trades.length) {
        html += '<table class="bt-res-table"><thead><tr><th>買い日</th><th>買い値</th><th>売り日</th><th>売り値</th><th>損益</th><th>保有</th><th>売り理由</th></tr></thead><tbody>';
        out.trades.forEach(function (t) {
          html += "<tr><td>" + esc(t.buyDate) + "</td><td>" + price(t.buyPrice) + "</td><td>" + esc(t.sellDate) + (t.open ? "（期末評価）" : "") + "</td><td>" + price(t.sellPrice) + "</td><td>" + pct(t.ret) + "</td><td>" + t.hold + "日</td><td>" +
            esc(t.open ? "期間終了" : (SELL_LABELS[t.reason] || t.reason)) + "</td></tr>";
        });
        html += "</tbody></table>";
      } else {
        html += '<p class="bt-res-note">この期間に買い条件を満たす日はありませんでした。</p>';
      }
      html += "</div>";
      return html;
    }

    function sharpeTxt(v) { return v == null || !isFinite(v) ? "—" : v.toFixed(2); }

    // Draggable column widths for result tables, saved per table kind.
    function makeResizable(table, key) {
      if (!table) return;
      var ths = Array.from(table.querySelectorAll("thead th"));
      if (!ths.length) return;
      var cg = document.createElement("colgroup");
      ths.forEach(function () { cg.appendChild(document.createElement("col")); });
      table.insertBefore(cg, table.firstChild);
      var cols = Array.from(cg.children);
      function apply(widths) {
        if (!widths) return;
        table.style.tableLayout = "fixed";
        var total = 0;
        cols.forEach(function (c, i) { var w = widths[i]; if (w) { c.style.width = w + "px"; total += w; } });
        if (total) table.style.width = total + "px";
      }
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { saved = null; }
      if (Array.isArray(saved) && saved.length === ths.length) apply(saved);
      ths.forEach(function (th, i) {
        th.style.position = "relative";
        var h = document.createElement("span");
        h.className = "bt-col-resizer";
        h.title = "ドラッグで列幅を変更（ダブルクリックでリセット）";
        th.appendChild(h);
        h.addEventListener("click", function (e) { e.stopPropagation(); });
        h.addEventListener("dblclick", function (e) {
          e.stopPropagation();
          try { localStorage.removeItem(key); } catch (err) {}
          table.style.tableLayout = ""; table.style.width = "";
          cols.forEach(function (c) { c.style.width = ""; });
        });
        h.addEventListener("pointerdown", function (e) {
          e.preventDefault(); e.stopPropagation();
          var widths = cols.map(function (c, j) { return c.style.width ? parseInt(c.style.width, 10) : ths[j].offsetWidth; });
          apply(widths);
          var startX = e.clientX, startW = widths[i];
          function move(ev) { widths[i] = Math.max(36, startW + ev.clientX - startX); apply(widths); }
          function up() {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            try { localStorage.setItem(key, JSON.stringify(widths)); } catch (err) {}
          }
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", up);
        });
      });
    }

    // Summary table with two rows per stock (the strategy and buy & hold
    // as separate rows); clicking a row shows that stock's trade list underneath.
    // entries: [{title, out|null, noData|null}] (title is pre-escaped).
    function renderStockResults(container, entries) {
      var html = '<table class="bt-res-table bt-stock-table"><thead><tr><th>銘柄</th><th>区分</th><th>リターン</th><th>取引回数</th><th>勝率</th><th>平均損益</th><th>最大DD</th><th>シャープレシオ</th><th>平均保有</th><th>期間</th></tr></thead><tbody>';
      entries.forEach(function (e, idx) {
        if (!e.out) {
          html += '<tr class="bt-stock-row" data-bt-stock="' + idx + '"><td style="text-align:left">' + e.title + '</td><td colspan="9" style="text-align:left">' + esc(e.noData || "") + "</td></tr>";
          return;
        }
        var p = e.out.perf;
        html += '<tr class="bt-stock-row" data-bt-stock="' + idx + '"><td rowspan="2" style="text-align:left">' + e.title + "</td><td>戦略</td><td>" + pct(p.totalReturn) + "</td><td>" + p.closedCount + (p.hasOpen ? "（+保有中1）" : "") + "</td><td>" +
          (p.winRate == null ? "—" : pct(p.winRate, 0)) + "</td><td>" + (p.avgRet == null ? "—" : pct(p.avgRet)) + "</td><td>" + pct(p.maxDd) + "</td><td>" + sharpeTxt(p.sharpe) + "</td><td>" +
          (p.avgHold == null ? "—" : p.avgHold.toFixed(0) + "日") + '</td><td rowspan="2">' + esc(e.out.range.from) + " 〜 " + esc(e.out.range.to) + "</td></tr>";
        html += '<tr class="bt-stock-row bt-bh-row" data-bt-stock="' + idx + '"><td>買い持ち</td><td>' + pct(p.bhReturn) + "</td><td>—</td><td>—</td><td>—</td><td>" + pct(p.bhMaxDd) + "</td><td>" + sharpeTxt(p.bhSharpe) + "</td><td>—</td></tr>";
      });
      html += "</tbody></table>";
      html += '<p class="bt-res-note">銘柄の行を選ぶと、その銘柄の売買履歴を表示します。</p>';
      html += '<div class="bt-stock-detail"></div>';
      container.innerHTML = html;
      makeResizable(container.querySelector(".bt-stock-table"), "stock-dashboard-bt-widths-stock-" + MARKET + "-v1");
      var detail = container.querySelector(".bt-stock-detail");
      var rowsEls = Array.from(container.querySelectorAll(".bt-stock-row"));
      function select(idx) {
        rowsEls.forEach(function (x) { x.classList.remove("bt-stock-sel"); });
        var tr = rowsEls[idx];
        if (!tr) { detail.innerHTML = ""; return; }
        tr.classList.add("bt-stock-sel");
        var e = entries[idx];
        detail.innerHTML = e.out ? stockTradesHtml(e.title, e.out) : '<div class="bt-res-block"><h4>' + e.title + '</h4><p class="bt-res-note">' + esc(e.noData || "") + "</p></div>";
      }
      rowsEls.forEach(function (tr) {
        tr.addEventListener("click", function () { select(parseInt(tr.dataset.btStock, 10)); });
      });
      if (entries.length) select(0);
    }

    var rsiBuyVal = null, rsiSellVal = null, dropPctVal = null, ddSellVal = null, ddGateVal = null;
    function condLabel(group, id) {
      if (id === "rsiGe") return "RSI（14日）が" + (rsiBuyVal == null ? "しきい値" : rsiBuyVal) + "以下";
      if (id === "rsiLe") return "RSI（14日）が" + (rsiSellVal == null ? "しきい値" : rsiSellVal) + "以上";
      if (id === "dropPct") return "前日終値から" + (dropPctVal == null ? "しきい値" : dropPctVal) + "%以上下落";
      if (id === "ddGe") return "DD（売り抜け日）が" + (ddSellVal == null ? "しきい値" : ddSellVal) + "以上";
      if (id === "dd") return "DD（売り抜け日）が" + (ddGateVal == null ? "しきい値" : ddGateVal) + "以下";
      return ((group === "sell" ? SELL_LABELS : BUY_LABELS)[id] || id);
    }
    function readRsi(buyAll, sellAll) {
      if (buyAll.includes("rsiGe")) { var v = numOf("rsiBuy"); rsiBuyVal = isFinite(v) ? v : 30; } else rsiBuyVal = null;
      if (sellAll.includes("rsiLe")) { var w = numOf("rsiSell"); rsiSellVal = isFinite(w) ? w : 70; } else rsiSellVal = null;
      if (sellAll.includes("dropPct")) { var d = numOf("dropSell"); dropPctVal = isFinite(d) ? d : 5; } else dropPctVal = null;
      if (sellAll.includes("ddGe")) { var g = numOf("ddSell"); ddSellVal = isFinite(g) ? g : 5; } else ddSellVal = null;
      if (buyAll.includes("dd")) { var dv = numOf("dd"); ddGateVal = isFinite(dv) ? dv : 5; } else ddGateVal = null;
    }

    var screenRunBtn = document.getElementById("bt-screen-run");
    if (screenRunBtn) screenRunBtn.addEventListener("click", function () {
      var note = document.getElementById("bt-screen-note");
      var ids = checked("screen");
      if (!ids.length) { if (note) note.textContent = "条件を選んでください"; return; }
      if (typeof window.leaderScreenerEvalScreen !== "function") { if (note) note.textContent = "スクリーナーの読み込み待ちです"; return; }
      var rsMin = parseInt((document.getElementById("bt-tt-rs") || {}).value || "70", 10);
      var codes = window.leaderScreenerEvalScreen(ids, rsMin);
      var input = document.getElementById("bt-symbols");
      if (input) {
        input.value = codes.join(", ");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (note) note.textContent = codes.length ? codes.length + "銘柄が対象に入りました" : "条件を満たす銘柄がありませんでした";
    });
    // Rolling run: for each start date in [from, to], the universe is
    // the stocks passing the screening conditions as of that date
    // (judged from the day's snapshot), and each stock is simulated
    // for the chosen horizon. Results are summarised per start date.
    function runRolling() {
      var screenIds = checked("screen");
      var inputCodes = ((document.getElementById("bt-symbols") || {}).value || "").split(/[\s,、，]+/)
        .map(function (x) { return x.trim(); }).filter(Boolean)
        .map(function (x) { return MARKET === "us" ? x.toUpperCase() : x.replace(/\.T$/i, ""); });
      inputCodes = Array.from(new Set(inputCodes)).slice(0, 200);
      var fixedCodes = inputCodes.length ? inputCodes : null;
      var buyAll = checked("buy"), sellAll = checked("sell");
      var buy = buyAll.filter(function (id) { return BUY_EVALUABLE[id]; });
      var sell = sellAll.filter(function (id) { return SELL_EVALUABLE[id]; });
      var skipped = [];
      buyAll.filter(function (id) { return !BUY_EVALUABLE[id] && id !== "dd"; }).forEach(function (id) { skipped.push("買い：" + (BUY_LABELS[id] || id)); });
      sellAll.filter(function (id) { return !SELL_EVALUABLE[id]; }).forEach(function (id) { skipped.push("売り：" + (SELL_LABELS[id] || id)); });
      if (!fixedCodes && !screenIds.length) {
        results.innerHTML = '<p class="bt-res-note">銘柄を入力するか、スクリーニング条件を1つ以上選んでください（スクリーニング条件は各開始日の対象銘柄の選定に使います）。</p>';
        return;
      }
      if (!fixedCodes && (typeof window.leaderScreenerArchiveDates !== "function" || typeof window.leaderScreenerEvalScreenAt !== "function")) {
        results.innerHTML = '<p class="bt-res-note">スクリーナーの読み込み待ちです。少し待ってから実行してください。</p>';
        return;
      }
      var ddLimit = buyAll.includes("dd") ? numOf("dd") : null;
      readRsi(buyAll, sellAll);
      var rsMin = parseInt((document.getElementById("bt-tt-rs") || {}).value || "70", 10);
      var normDate = function (v) { var d = String(v || "").replace(/\D/g, ""); return d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : ""; };
      var fromVal = normDate((document.getElementById("bt-from") || {}).value);
      var toVal = normDate((document.getElementById("bt-to") || {}).value) || fromVal;
      if (!fromVal) {
        results.innerHTML = '<p class="bt-res-note">開始日を入力してください（ローリングで開始日をずらす範囲の初日です）。</p>';
        return;
      }
      var horizon = parseInt((document.getElementById("bt-roll-horizon") || {}).value || "21", 10);
      var universe = (document.getElementById("bt-universe") || {}).value || "all";
      var markets = MARKET === "us" ? null : universe === "prime" ? ["プライム"] : universe === "standard" ? ["スタンダード"] : universe === "growth" ? ["グロース"] : null;
      var spSet = null;
      var preRoll = Promise.resolve();
      if (!fixedCodes && MARKET === "us" && universe === "sp500") {
        preRoll = loadJson("sector-leaders.json").then(function (leaders) {
          var set = new Set();
          ((leaders && leaders.us) || []).forEach(function (r) {
            if (r.universe_group === "S&P500" && r.ticker) set.add(String(r.ticker));
          });
          spSet = set;
        }).catch(function () {});
      }

      runBtn.disabled = true;
      results.innerHTML = '<p class="bt-res-note">実行中…</p>';

      var fixedStore = null;
      function loadStoreFor(codes) {
        var store = {};
        var queue = codes.slice();
        function worker() {
          var code = queue.shift();
          if (!code) return Promise.resolve();
          return loadJson(ohlcvUrl(code)).then(function (data) {
            store[code] = (data && data.rows) || null;
          }).catch(function () { store[code] = null; }).then(function () { return worker(); });
        }
        var pool = [];
        for (var k = 0; k < 8; k++) pool.push(worker());
        return Promise.all(pool).then(function () { return store; });
      }
      var perDatePromise;
      if (fixedCodes) {
        perDatePromise = loadStoreFor(fixedCodes).then(function (store) {
          fixedStore = store;
          var grid = new Set();
          fixedCodes.forEach(function (c) {
            (store[c] || []).forEach(function (r) { if (r[0] >= fromVal && r[0] <= toVal) grid.add(r[0]); });
          });
          var startDates = Array.from(grid).sort();
          if (!startDates.length) {
            throw { rollMsg: "指定範囲に入力銘柄の価格データがありません。期間を広げてください。" };
          }
          return startDates.map(function (d) { return { date: d, codes: fixedCodes, truncated: false }; });
        });
      } else {
        perDatePromise = preRoll.then(function () { return window.leaderScreenerArchiveDates(); }).then(function (datesDesc) {
        var startDates = datesDesc.filter(function (d) { return d >= fromVal && d <= toVal; }).sort();
        if (!startDates.length) {
          throw { rollMsg: "指定範囲にスナップショットのある日がありません" + (datesDesc.length ? "（保存範囲：" + datesDesc[datesDesc.length - 1] + " 〜 " + datesDesc[0] + "）" : "") + "。" };
        }
        var perDate = [];
        var chain = Promise.resolve();
        startDates.forEach(function (d) {
          chain = chain.then(function () {
            results.innerHTML = '<p class="bt-res-note">実行中… ' + esc(d) + ' 時点のスクリーニング判定</p>';
            return window.leaderScreenerEvalScreenAt(d, screenIds, rsMin, markets).then(function (res) {
              if (res) {
                var codes = res.codes;
                if (spSet) codes = codes.filter(function (c) { return spSet.has(c); });
                perDate.push({ date: res.date, codes: codes.slice(0, 200), truncated: codes.length > 200 });
              }
            });
          });
        });
        return chain.then(function () { return perDate; });
        });
      }
      perDatePromise.then(function (perDate) {
        var seen = {}, uniq = [];
        perDate.forEach(function (pd) { if (!seen[pd.date]) { seen[pd.date] = 1; uniq.push(pd); } });
        var unionSet = new Set();
        uniq.forEach(function (pd) { pd.codes.forEach(function (c) { unionSet.add(c); }); });
        var union = Array.from(unionSet);
        if (!union.length) {
          results.innerHTML = '<p class="bt-res-note">条件を満たす銘柄がありませんでした。</p>';
          runBtn.disabled = false;
          return null;
        }
        return loadJson("sector-leaders.json").catch(function () { return null; }).then(function (leaders) {
          var names = buildNames(leaders);
          if (fixedStore) return { names: names, store: fixedStore, perDate: uniq };
          var store = {}, done = 0;
          var queue = union.slice();
          function worker() {
            var code = queue.shift();
            if (!code) return Promise.resolve();
            return loadJson(ohlcvUrl(code)).then(function (data) {
              store[code] = (data && data.rows) || null;
            }).catch(function () { store[code] = null; }).then(function () {
              done++;
              if (done % 25 === 0) results.innerHTML = '<p class="bt-res-note">実行中… 日足データ取得 ' + done + "/" + union.length + "銘柄</p>";
              return worker();
            });
          }
          var pool = [];
          for (var k = 0; k < 8; k++) pool.push(worker());
          return Promise.all(pool).then(function () { return { names: names, store: store, perDate: uniq }; });
        });
      }).then(function (ctx) {
        if (!ctx) return null;
        var years = [];
        Object.keys(ctx.store).forEach(function (code) {
          var rows = ctx.store[code];
          if (rows && rows.length) {
            var y0 = +rows[0][0].slice(0, 4), y1 = +rows[rows.length - 1][0].slice(0, 4);
            for (var y = y0; y <= y1; y++) if (!years.includes(y)) years.push(y);
          }
        });
        var ddPromise = ddLimit != null && years.length ? loadMarketDd(years) : Promise.resolve(new Map());
        return ddPromise.then(function (ddMap) { ctx.ddMap = ddMap; return ctx; });
      }).then(function (ctx) {
        if (!ctx) return;
        var summaries = [], details = {};
        ctx.perDate.forEach(function (pd) {
          var entries = [], n = 0, sumRet = 0, sumBh = 0, rets = [], bhRets = [], closedTrades = 0, winTrades = 0, sumSharpe = 0, nSharpe = 0, sumBhSharpe = 0, nBhSharpe = 0;
          pd.codes.forEach(function (code) {
            var rows = ctx.store[code];
            if (!rows || !rows.length) return;
            var fromIdx = rows.findIndex(function (r) { return r[0] >= pd.date; });
            if (fromIdx < 0) return;
            var toIdx = Math.min(rows.length - 1, fromIdx + horizon - 1);
            if (toIdx <= fromIdx) return;
            var out = runBacktest(rows, {
              fromIdx: fromIdx, toIdx: toIdx, buy: buy, sell: sell,
              ddLimit: ddLimit, ddByDate: ctx.ddMap, rsiBuy: rsiBuyVal, rsiSell: rsiSellVal, dropPct: dropPctVal, ddSell: ddSellVal
            });
            var title = esc(code) + (ctx.names[code] ? " " + esc(ctx.names[code]) : "");
            entries.push({ title: title, out: out });
            n++; sumRet += out.perf.totalReturn; sumBh += out.perf.bhReturn; rets.push(out.perf.totalReturn); bhRets.push(out.perf.bhReturn);
            if (out.perf.sharpe != null) { sumSharpe += out.perf.sharpe; nSharpe++; }
            if (out.perf.bhSharpe != null) { sumBhSharpe += out.perf.bhSharpe; nBhSharpe++; }
            out.trades.forEach(function (t) { if (!t.open) { closedTrades++; if (t.ret > 0) winTrades++; } });
          });
          rets.sort(function (a, b) { return a - b; });
          var median = !rets.length ? null : (rets.length % 2 ? rets[(rets.length - 1) / 2] : (rets[rets.length / 2 - 1] + rets[rets.length / 2]) / 2);
          bhRets.sort(function (a, b) { return a - b; });
          var bhMedian = !bhRets.length ? null : (bhRets.length % 2 ? bhRets[(bhRets.length - 1) / 2] : (bhRets[bhRets.length / 2 - 1] + bhRets[bhRets.length / 2]) / 2);
          summaries.push({
            date: pd.date, count: n, avg: n ? sumRet / n : null, median: median,
            bhAvg: n ? sumBh / n : null, bhMedian: bhMedian, trades: closedTrades,
            sharpeAvg: nSharpe ? sumSharpe / nSharpe : null, bhSharpeAvg: nBhSharpe ? sumBhSharpe / nBhSharpe : null,
            winRate: closedTrades ? winTrades / closedTrades : null, truncated: pd.truncated
          });
          details[pd.date] = entries;
        });
        var valid = summaries.filter(function (s) { return s.count > 0; });
        var html = '<table class="bt-res-table bt-roll-table"><thead><tr><th>開始日</th><th>区分</th><th>対象銘柄数</th><th>平均リターン</th><th>中央値</th><th>取引回数</th><th>勝率</th><th>シャープレシオ</th></tr></thead><tbody>';
        if (valid.length) {
          var totAvg = valid.reduce(function (s, x) { return s + x.avg; }, 0) / valid.length;
          var totBh = valid.reduce(function (s, x) { return s + x.bhAvg; }, 0) / valid.length;
          var totCount = valid.reduce(function (s, x) { return s + x.count; }, 0);
          var totTrades = valid.reduce(function (s, x) { return s + x.trades; }, 0);
          var shVals = valid.map(function (x) { return x.sharpeAvg; }).filter(function (v) { return v != null; });
          var bhShVals = valid.map(function (x) { return x.bhSharpeAvg; }).filter(function (v) { return v != null; });
          var totSharpe = shVals.length ? shVals.reduce(function (a, b) { return a + b; }, 0) / shVals.length : null;
          var totBhSharpe = bhShVals.length ? bhShVals.reduce(function (a, b) { return a + b; }, 0) / bhShVals.length : null;
          html += '<tr class="bt-roll-total"><td rowspan="2">全開始日の平均</td><td>戦略</td><td rowspan="2">' + totCount + '</td><td>' + pct(totAvg) + '</td><td>—</td><td>' + totTrades + '</td><td>—</td><td>' + sharpeTxt(totSharpe) + '</td></tr>';
          html += '<tr class="bt-roll-total bt-bh-row"><td>買い持ち</td><td>' + pct(totBh) + '</td><td>—</td><td>—</td><td>—</td><td>' + sharpeTxt(totBhSharpe) + '</td></tr>';
        }
        summaries.forEach(function (s) {
          html += '<tr class="bt-roll-row" data-roll-date="' + s.date + '"><td rowspan="2">' + s.date + '</td><td>戦略</td><td rowspan="2">' + s.count + (s.truncated ? "（上限200）" : "") + '</td><td>' + pct(s.avg) + '</td><td>' + pct(s.median) + '</td><td>' + s.trades + '</td><td>' + (s.winRate == null ? "—" : pct(s.winRate, 0)) + '</td><td>' + sharpeTxt(s.sharpeAvg) + '</td></tr>';
          html += '<tr class="bt-roll-row bt-bh-row" data-roll-date="' + s.date + '"><td>買い持ち</td><td>' + pct(s.bhAvg) + '</td><td>' + pct(s.bhMedian) + '</td><td>—</td><td>—</td><td>' + sharpeTxt(s.bhSharpeAvg) + '</td></tr>';
        });
        html += '</tbody></table>';
        html += '<p class="bt-res-note">開始日の行を選ぶと、その日の銘柄別結果を表示します。' + (fixedCodes ? "対象銘柄は入力した銘柄です（スクリーニング条件は使っていません）。" : "対象銘柄は開始日時点のスナップショットでスクリーニング条件を判定しています。") + '</p>';
        html += '<div id="bt-roll-detail"></div>';
        var applied = (fixedCodes ? [] : screenIds.map(function (id) { return "スクリーニング：" + condLabel("buy", id); }))
          .concat(buy.map(function (id) { return "買い：" + condLabel("buy", id); }))
          .concat(sell.map(function (id) { return "売り：" + condLabel("sell", id); }));
        if (ddLimit != null) applied.push("買い：" + condLabel("buy", "dd"));
        html += '<p class="bt-res-note">適用した条件：' + esc(applied.join(" / ")) + "<br>判定は終値、売買は翌営業日の始値です。手数料・税金は含みません。シャープレシオは日次リターンから計算しています（無リスク金利0）。" + (buy.length ? "" : "買い条件が未選択のため、対象銘柄は各開始日の翌営業日に買います。") + "</p>";
        if (skipped.length) {
          html += '<p class="bt-res-note">対象外（過去データがないため判定しませんでした）：' + esc(skipped.join(" / ")) + "</p>";
        }
        results.innerHTML = html;
        makeResizable(results.querySelector(".bt-roll-table"), "stock-dashboard-bt-widths-roll-" + MARKET + "-v1");
        var detail = document.getElementById("bt-roll-detail");
        results.querySelectorAll(".bt-roll-row").forEach(function (tr) {
          tr.addEventListener("click", function () {
            results.querySelectorAll(".bt-roll-row").forEach(function (x) { x.classList.remove("bt-roll-sel"); });
            tr.classList.add("bt-roll-sel");
            detail.innerHTML = '<h3 class="bt-roll-detail-title">' + esc(tr.dataset.rollDate) + ' 開始の銘柄別結果</h3><div class="bt-roll-stocks"></div>';
            var ents = details[tr.dataset.rollDate];
            if (ents && ents.length) renderStockResults(detail.querySelector(".bt-roll-stocks"), ents);
            else detail.insertAdjacentHTML("beforeend", '<p class="bt-res-note">対象銘柄がありませんでした。</p>');
          });
        });
        runBtn.disabled = false;
      }).catch(function (e) {
        results.innerHTML = '<p class="bt-res-note">' + esc(e && e.rollMsg ? e.rollMsg : "実行中にエラーが発生しました。期間と条件を確認してください。") + "</p>";
        runBtn.disabled = false;
      });
    }

    runBtn.addEventListener("click", function () {
      if (((document.getElementById("bt-mode") || {}).value || "normal") === "rolling") { runRolling(); return; }
      var symbolsRaw = (document.getElementById("bt-symbols") || {}).value || "";
      var codes = symbolsRaw.split(/[\s,、，]+/).map(function (s) { return s.trim(); }).filter(Boolean)
        .map(function (s) { return MARKET === "us" ? s.toUpperCase() : s.replace(/\.T$/i, ""); });
      codes = Array.from(new Set(codes)).slice(0, 200);
      var etfCodes = Array.from(panel.querySelectorAll('input[data-bt-etf]:checked')).map(function (b) { return b.value; });
      etfCodes.forEach(function (c) { if (!codes.includes(c)) codes.push(c); });
      var indexKeys = Array.from(panel.querySelectorAll('input[data-bt-index]:checked')).map(function (b) { return b.value; });
      if (!codes.length && !indexKeys.length) {
        results.innerHTML = MARKET === "us"
          ? '<p class="bt-res-note">ティッカーを入力するか、指数・ETFを選んでから実行してください（対象セレクトだけでは実行できません）。</p>'
          : '<p class="bt-res-note">銘柄コードを入力するか、指数・ETFを選んでから実行してください（対象セレクトだけでは実行できません）。</p>';
        return;
      }
      var screenAll = checked("screen"), buyAll = checked("buy"), sellAll = checked("sell");
      var screen = screenAll.filter(function (id) { return BUY_EVALUABLE[id]; });
      var buy = buyAll.filter(function (id) { return BUY_EVALUABLE[id]; });
      var sell = sellAll.filter(function (id) { return SELL_EVALUABLE[id]; });
      var skipped = [];
      screenAll.filter(function (id) { return !BUY_EVALUABLE[id]; }).forEach(function (id) { skipped.push("スクリーニング：" + (BUY_LABELS[id] || id)); });
      buyAll.filter(function (id) { return !BUY_EVALUABLE[id] && id !== "dd"; }).forEach(function (id) { skipped.push("買い：" + (BUY_LABELS[id] || id)); });
      sellAll.filter(function (id) { return !SELL_EVALUABLE[id]; }).forEach(function (id) { skipped.push("売り：" + (SELL_LABELS[id] || id)); });
      var entry = screen.concat(buy); // screening gates + buy timing
      var ddLimit = buyAll.includes("dd") ? numOf("dd") : null;
      readRsi(buyAll, sellAll);
      var normDate = function (v) { var d = String(v || "").replace(/\D/g, ""); return d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : ""; };
      var fromVal = normDate((document.getElementById("bt-from") || {}).value);
      var toVal = normDate((document.getElementById("bt-to") || {}).value);
      var periodYears = parseInt((document.getElementById("bt-period") || {}).value || "3", 10);

      runBtn.disabled = true;
      results.innerHTML = '<p class="bt-res-note">実行中…</p>';

      loadJson("sector-leaders.json").catch(function () { return null; }).then(function (leaders) {
        var names = buildNames(leaders);
        var jobs = codes.map(function (code) {
          return loadJson(ohlcvUrl(code)).then(function (data) {
            return { code: code, rows: (data && data.rows) || [] };
          }).catch(function () { return { code: code, rows: null }; });
        });
        return Promise.all(jobs).then(function (loaded) { return { names: names, loaded: loaded }; });
      }).then(function (ctx) {
        var years = [];
        ctx.loaded.forEach(function (item) {
          if (item.rows && item.rows.length) {
            var y0 = +item.rows[0][0].slice(0, 4), y1 = +item.rows[item.rows.length - 1][0].slice(0, 4);
            for (var y = y0; y <= y1; y++) if (!years.includes(y)) years.push(y);
          }
        });
        var ddPromise = ddLimit != null && years.length ? loadMarketDd(years) : Promise.resolve(new Map());
        return ddPromise.then(function (ddMap) { return { names: ctx.names, loaded: ctx.loaded, ddMap: ddMap }; });
      }).then(function (ctx) {
        var entries = [];
        ctx.loaded.forEach(function (item) {
          var nm = ctx.names[item.code] || ETF_NAMES[item.code] || "";
          var title = esc(item.code) + (nm ? " " + esc(nm) : "");
          if (!item.rows) {
            entries.push({ title: title, out: null, noData: "日足データがまだありません。自動更新で蓄積されてから実行できます。" });
            return;
          }
          var rows = item.rows;
          var lastDate = rows[rows.length - 1][0];
          var startDate = fromVal;
          if (!startDate) {
            var d = new Date(lastDate + "T00:00:00");
            d.setFullYear(d.getFullYear() - periodYears);
            startDate = d.toISOString().slice(0, 10);
          }
          var endDate = toVal || lastDate;
          var fromIdx = rows.findIndex(function (r) { return r[0] >= startDate; });
          var toIdx = -1;
          for (var i = rows.length - 1; i >= 0; i--) { if (rows[i][0] <= endDate) { toIdx = i; break; } }
          if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) {
            entries.push({ title: title, out: null, noData: "指定期間のデータがありません（保有データ：" + rows[0][0] + " 〜 " + lastDate + "）。" });
            return;
          }
          var out = runBacktest(rows, {
            fromIdx: fromIdx, toIdx: toIdx, buy: entry, sell: sell,
            ddLimit: ddLimit, ddByDate: ctx.ddMap, rsiBuy: rsiBuyVal, rsiSell: rsiSellVal, dropPct: dropPctVal, ddSell: ddSellVal
          });
          entries.push({ title: title, out: out });
        });
        var applied = screen.map(function (id) { return "スクリーニング：" + condLabel("buy", id); })
          .concat(buy.map(function (id) { return "買い：" + condLabel("buy", id); }))
          .concat(sell.map(function (id) { return "売り：" + condLabel("sell", id); }));
        if (ddLimit != null) applied.push("買い：" + condLabel("buy", "dd"));
        var notes = '<p class="bt-res-note">適用した条件：' + esc(applied.join(" / ") || "なし") + "<br>判定は終値、売買は翌営業日の始値です。手数料・税金は含みません。シャープレシオは日次リターンから計算しています（無リスク金利0）。" + (entry.length ? "" : "買い条件（判定できるもの）が未選択のため、対象銘柄は期間開始の翌営業日に買います。") + "</p>";
        if (skipped.length) {
          notes += '<p class="bt-res-note">対象外（過去データがないため判定しませんでした）：' + esc(skipped.join(" / ")) + "</p>";
        }
        var finish = function () {
          results.innerHTML = '<div id="bt-stock-results"></div>' + notes;
          renderStockResults(document.getElementById("bt-stock-results"), entries);
        };
        if (indexKeys.length) {
          var endYear = toVal ? +toVal.slice(0, 4) : new Date().getFullYear();
          var startYear = fromVal ? +fromVal.slice(0, 4) : endYear - periodYears;
          var indexYears = [];
          for (var iy = startYear - 1; iy <= endYear; iy++) indexYears.push(iy);
          loadIndexEntries(indexKeys, indexYears, { buy: entry, sell: sell, ddLimit: ddLimit, ddMap: ctx.ddMap }, fromVal, toVal, periodYears)
            .then(function (ixEntries) { entries.push.apply(entries, ixEntries); finish(); })
            .catch(function () { finish(); });
        } else {
          finish();
        }
        runBtn.disabled = false;
      }).catch(function (e) {
        results.innerHTML = '<p class="bt-res-note">実行中にエラーが発生しました。銘柄コードと期間を確認してください。</p>';
        runBtn.disabled = false;
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
