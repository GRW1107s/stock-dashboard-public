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
    rsiGe: "RSI（14日）が閾値以下",
    bounce: "前日に閾値σ以上下落",
    sector: "所属セクターが上位を維持",
    tt1: "株価が150日・200日移動平均線より上",
    tt2: "150日MAが200日MAより上",
    tt3: "200日MAが少なくとも1か月上昇",
    tt4: "50日MAが150日・200日MAより上",
    tt5: "株価が50日MAより上",
    tt6: "52週安値から30%以上上昇",
    tt7: "52週高値から25%以内",
    tt8: "RS指数が閾値以上",
    ftd: "FTD（フォロースルーデー）が発生",
    ad: "AD（買い集め日）が閾値以上",
    dd: "DD（売り抜け日）が閾値以下"
  };
  var SELL_LABELS = {
    ma50: "株価が閾値日移動平均を下回る",
    loss8: "買値から閾値%下落",
    dropPct: "前日終値から閾値%以上下落",
    high25: "52週高値から閾値%以上下落",
    ddGe: "DD（売り抜け日）が5以上（直近25取引日）",
    rsiLe: "RSI（14日）が閾値以上"
  };
  var BUY_EVALUABLE = { vol15: 1, tt1: 1, tt2: 1, tt3: 1, tt4: 1, tt5: 1, tt6: 1, tt7: 1, rsiGe: 1, bounce: 1, ftd: 1 };
  var SELL_EVALUABLE = { ma50: 1, loss8: 1, high25: 1, rsiLe: 1, dropPct: 1, ddGe: 1 };

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
  //       rsiBuy:null|number, rsiSell:null|number} — DD counts, FTD and the
  //       warning state are computed from the rows themselves (Pine rules).
  // Indicator series (MA / RSI / DD / FTD / sigma20) depend only on the
  // rows themselves — maSell only on cfg.maDays — so they are computed
  // once per rows array and memoised in a WeakMap. The all-patterns
  // rolling sweep calls runBacktest hundreds of thousands of times on
  // the same rows; without this cache every call re-did the full-history
  // indicator pass (~4ms on 2,518 rows) and the sweep took ~13 minutes.
  var indCache = new WeakMap();
  function indicatorsFor(rows, maDays) {
    var per = indCache.get(rows);
    if (!per) { per = { base: null, maSell: {} }; indCache.set(rows, per); }
    if (!per.base) {
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
      // Active distribution-day count, aligned with the Pine indicator:
      // a DD is a session down 0.2% or more on higher volume; it stays
      // active for 25 sessions and expires early once the close recovers
      // 5% or more from the DD session's close. Expiry is applied before
      // the current session's DD is added, as in the Pine script.
      var ddActive = [];
      (function () {
        var active = [];
        for (var i = 0; i < n; i++) {
          var c = closes[i];
          active = active.filter(function (a) { return i - a[0] < 25 && c < a[1] * 1.05; });
          if (i > 0 && closes[i - 1] > 0 && c <= closes[i - 1] * 0.998 && vols[i] > vols[i - 1]) active.push([i, c]);
          ddActive.push(active.length);
        }
      })();
      // Pine Script parity: DD5 starts the warning, FTD ends it, but DD
      // history itself is NOT cleared. Use the charted instrument's OHLCV.
      var pineFtd = [], pineWarning = [], pineWarningStart = [];
      var pineByN = {};
      (function () {
        [5, 6, 7].forEach(function (th) {
          var warningActive = false, rallyDay = 0, rallyLow = null;
          var ftdArr = [], warnArr = [];
          for (var i = 0; i < n; i++) {
            var isDd = i > 0 && closes[i] <= closes[i - 1] * 0.998 && vols[i] > vols[i - 1];
            var reached = isDd && ddActive[i] >= th && (i === 0 || ddActive[i - 1] < th);
            var isFtd = false;
            if (reached && !warningActive) {
              warningActive = true;
              rallyDay = 0;
              rallyLow = null;
            } else if (warningActive && i > 0) {
              if (rallyDay > 0 && lows[i] < rallyLow) {
                rallyDay = 0;
                rallyLow = null;
              }
              if (rallyDay === 0) {
                if (closes[i] > closes[i - 1]) {
                  rallyDay = 1;
                  rallyLow = lows[i];
                }
              } else {
                rallyDay++;
              }
              if (rallyDay >= 4 && closes[i] >= closes[i - 1] * 1.0125 && vols[i] > vols[i - 1]) {
                isFtd = true;
                warningActive = false;
                rallyDay = 0;
                rallyLow = null;
              }
            }
            ftdArr.push(isFtd);
            warnArr.push(warningActive || isFtd);
            if (th === 5) pineWarningStart.push(reached);
          }
          pineByN[th] = { ftd: ftdArr, warning: warnArr };
        });
        pineFtd = pineByN[5].ftd;
        pineWarning = pineByN[5].warning;
      })();
      // Bounce Strategy: sigma20[i] is the population standard deviation of
      // the 20 daily returns before day i (the drop day itself is excluded).
      var sigma20 = [];
      for (var si = 0; si < n; si++) {
        if (si < 21) { sigma20.push(null); continue; }
        var mean = 0, prevRets = [];
        for (var k = si - 20; k < si; k++) { var rr = closes[k] / closes[k - 1] - 1; prevRets.push(rr); mean += rr; }
        mean /= 20;
        var varSum = 0;
        prevRets.forEach(function (r) { varSum += (r - mean) * (r - mean); });
        sigma20.push(Math.sqrt(varSum / 20));
      }
      per.base = { dates: dates, opens: opens, highs: highs, lows: lows, closes: closes, vols: vols,
        ma50: ma50, ma150: ma150, ma200: ma200, ma200Prev: ma200Prev, rsi: rsi,
        ddActive: ddActive, pineFtd: pineFtd, pineWarning: pineWarning, pineWarningStart: pineWarningStart, pineByN: pineByN, sigma20: sigma20 };
    }
    if (!per.maSell[maDays]) {
      var ms = [];
      for (var j = 0; j < per.base.closes.length; j++) ms.push(sma(per.base.closes, j, maDays));
      per.maSell[maDays] = ms;
    }
    var b = per.base;
    return { dates: b.dates, opens: b.opens, highs: b.highs, lows: b.lows, closes: b.closes, vols: b.vols,
      ma50: b.ma50, ma150: b.ma150, ma200: b.ma200, ma200Prev: b.ma200Prev, maSell: per.maSell[maDays], rsi: b.rsi,
      ddActive: b.ddActive, pineFtd: b.pineFtd, pineWarning: b.pineWarning, pineWarningStart: b.pineWarningStart, pineByN: b.pineByN, sigma20: b.sigma20 };
  }

  function runBacktest(rows, cfg) {
    var ind = indicatorsFor(rows, cfg.maDays == null ? 50 : cfg.maDays);
    var dates = ind.dates, opens = ind.opens, highs = ind.highs, lows = ind.lows, closes = ind.closes, vols = ind.vols;
    var ma50 = ind.ma50, ma150 = ind.ma150, ma200 = ind.ma200, ma200Prev = ind.ma200Prev, maSell = ind.maSell;
    var rsi = ind.rsi, ddActive = ind.ddActive, pineFtd = ind.pineFtd, pineWarning = ind.pineWarning, sigma20 = ind.sigma20;
    var pineSel = (cfg.ddSell === 6 || cfg.ddSell === 7) ? cfg.ddSell : 5;
    if (ind.pineByN && ind.pineByN[pineSel]) { pineFtd = ind.pineByN[pineSel].ftd; pineWarning = ind.pineByN[pineSel].warning; }
    var n = rows.length;
    function ddOk(i) {
      return cfg.ddLimit == null || ddActive[i] <= cfg.ddLimit;
    }
    function buyCond(id, i) {
      var c = closes[i];
      if (id === "vol15") {
        var avg = sma(vols, i - 1, 20);
        return avg != null && avg > 0 && vols[i] >= 1.5 * avg;
      } else if (id === "tt1") {
        return ma150[i] != null && ma200[i] != null && c > ma150[i] && c > ma200[i];
      } else if (id === "tt2") {
        return ma150[i] != null && ma200[i] != null && ma150[i] > ma200[i];
      } else if (id === "tt3") {
        return ma200[i] != null && ma200Prev[i] != null && ma200[i] > ma200Prev[i];
      } else if (id === "tt4") {
        return ma50[i] != null && ma150[i] != null && ma200[i] != null && ma50[i] > ma150[i] && ma50[i] > ma200[i];
      } else if (id === "tt5") {
        return ma50[i] != null && c > ma50[i];
      } else if (id === "tt6") {
        var lo = extreme(lows, i, 252, false);
        return lo != null && c >= lo * 1.30;
      } else if (id === "tt7") {
        var hi = extreme(highs, i, 252, true);
        return hi != null && c >= hi * 0.75;
      } else if (id === "rsiGe") {
        return cfg.rsiBuy != null && rsi[i] != null && rsi[i] <= cfg.rsiBuy;
      } else if (id === "bounce") {
        return cfg.bounceSigma != null && sigma20[i] != null && i > 0 && closes[i] <= closes[i - 1] * (1 - cfg.bounceSigma * sigma20[i]);
      } else if (id === "ftd") {
        return !!pineFtd[i];
      }
      return true;
    }
    function buyOk(i) {
      for (var j = 0; j < cfg.buy.length; j++) {
        if (!buyCond(cfg.buy[j], i)) return false;
      }
      return ddOk(i);
    }
    function sellReason(i, pos) {
      for (var j = 0; j < cfg.sell.length; j++) {
        var id = cfg.sell[j], c = closes[i];
        if (id === "ma50" && maSell[i] != null && c < maSell[i]) return id;
        if (id === "loss8" && c <= pos.price * (1 - (cfg.lossPct == null ? 8 : cfg.lossPct) / 100)) return id;
        if (id === "high25") {
          var hi2 = extreme(highs, i, 252, true);
          if (hi2 != null && c <= hi2 * (1 - (cfg.highPct == null ? 25 : cfg.highPct) / 100)) return id;
        }
        if (id === "rsiLe" && cfg.rsiSell != null && rsi[i] != null && rsi[i] >= cfg.rsiSell) return id;
        if (id === "dropPct" && cfg.dropPct != null && i > 0 && closes[i - 1] > 0 && c / closes[i - 1] - 1 <= -cfg.dropPct / 100) return id;
        // Pine's orange warning remains active until FTD even if DD falls below 5.
        // A new FTD bar is the final orange bar, but is not a sell signal.
        if (id === "ddGe" && cfg.ddSell != null && pineWarning[i] && !pineFtd[i]) return id;
      }
      return null;
    }

    var from = Math.max(0, cfg.fromIdx), to = Math.min(n - 1, cfg.toIdx);
    var trades = [], pos = null, pendingBuy = false, pendingSell = null, waitRule = null;
    var equity = [], cash = 1;
    for (var d = from; d <= to; d++) {
      if (pendingBuy && !pos) {
        pos = { execIdx: d, signalIdx: d - 1, price: opens[d], date: dates[d] };
        pendingBuy = false;
        waitRule = null;
      } else if (pendingSell && pos) {
        var ret = opens[d] / pos.price - 1;
        trades.push({
          buyDate: pos.date, buyPrice: pos.price, sellDate: dates[d],
          sellPrice: opens[d], ret: ret, hold: d - pos.execIdx,
          reason: pendingSell, open: false
        });
        cash *= opens[d] / pos.price;
        waitRule = null;
        if (cfg.reentry) {
          for (var ri = 0; ri < cfg.reentry.length; ri++) {
            if (cfg.reentry[ri].sell === pendingSell) { waitRule = cfg.reentry[ri]; break; }
          }
        }
        pos = null; pendingSell = null;
      }
      equity.push(pos ? cash * closes[d] / pos.price : cash);
      if (d === to) break;
      if (!pos && !pendingBuy && (waitRule ? buyCond(waitRule.buy, d) : buyOk(d))) pendingBuy = true;
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

    // Strategy slots: ten fixed tabs (戦略1-10), each holding its own buy/sell
    // condition set, edited through the single buy/sell blocks. The screening
    // block and the target/period settings are shared across slots. A checkbox
    // on each tab marks the slot for comparison runs. The old named-strategy
    // store is discarded (GRW, 2026-11-23).
    var slotsApi = (function setupSlots() {
      var tabsEl = document.getElementById("bt-strat-tabs");
      var KEY = "stock-dashboard-bt-slots-" + MARKET;
      var store = null;
      try { store = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { store = null; }
      try { localStorage.removeItem("stock-dashboard-bt-strategies-" + MARKET); } catch (e) {}
      function readReentryDom() {
        var out = [];
        panel.querySelectorAll("select.bt-re-for").forEach(function (sel) {
          if (sel.value) out.push({ sell: sel.getAttribute("data-re-for"), buy: sel.value });
        });
        return out;
      }
      function applyReentry(list) {
        var map = {};
        (list || []).forEach(function (r) { map[r.sell] = r.buy; });
        panel.querySelectorAll("select.bt-re-for").forEach(function (sel) {
          var v = map[sel.getAttribute("data-re-for")] || "";
          if (sel.value !== v) sel.value = v;
        });
      }
      function blank() { return { buy: [], sell: [], nums: {}, cmp: false, reentry: [] }; }
      function collectDom() {
        var st = { buy: checked("buy"), sell: checked("sell"), nums: {}, reentry: readReentryDom() };
        panel.querySelectorAll("[data-bt-num]").forEach(function (n) { st.nums[n.getAttribute("data-bt-num")] = n.value; });
        return st;
      }
      if (!store || !Array.isArray(store.slots) || (store.slots.length !== 8 && store.slots.length !== 10)) {
        var seed = collectDom();
        store = { active: 0, slots: [] };
        for (var i = 0; i < 8; i++) store.slots.push(i === 0 ? { buy: seed.buy, sell: seed.sell, nums: seed.nums, cmp: false, reentry: seed.reentry || [] } : blank());
      }
      if (store.slots.length === 10) store.slots = store.slots.slice(0, 8);
      store.slots.forEach(function (sl) {
        if (!sl || !Array.isArray(sl.buy) || !Array.isArray(sl.sell) || !sl.nums) { sl.buy = []; sl.sell = []; sl.nums = {}; }
        sl.cmp = !!sl.cmp;
        if (!Array.isArray(sl.reentry)) sl.reentry = [];
      });
      var active = store.active >= 0 && store.active < 8 ? store.active : 0;
      var applying = false;
      function persist() { store.active = active; try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {} }
      function syncFromDom() {
        var st = collectDom();
        store.slots[active].buy = st.buy; store.slots[active].sell = st.sell; store.slots[active].nums = st.nums; store.slots[active].reentry = st.reentry;
      }
      function applySlot(idx) {
        var st = store.slots[idx];
        applying = true;
        panel.querySelectorAll('input[type="checkbox"][data-bt="buy"], input[type="checkbox"][data-bt="sell"]').forEach(function (b) {
          var list = b.getAttribute("data-bt") === "buy" ? st.buy : st.sell;
          var on = list.indexOf(b.value) >= 0;
          if (b.checked !== on) { b.checked = on; b.dispatchEvent(new Event("change", { bubbles: true })); }
        });
        panel.querySelectorAll("[data-bt-num]").forEach(function (n) {
          var v = st.nums[n.getAttribute("data-bt-num")];
          if (v === undefined) return;
          if (n.value !== String(v)) {
            n.value = String(v);
            if (n.tagName === "SELECT" && n.value !== String(v)) {
              // Stored value outside the current option range (e.g. the RSI
              // ranges were narrowed): clamp to the nearest option.
              var num = parseFloat(v), best = null, bestD = Infinity;
              Array.from(n.options).forEach(function (o) { var dd2 = Math.abs(parseFloat(o.value) - num); if (isFinite(dd2) && dd2 < bestD) { bestD = dd2; best = o.value; } });
              n.value = best != null ? best : n.defaultValue;
            }
            n.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
        applyReentry(st.reentry || []);
        applying = false;
      }
      var buyHead = panel.querySelector(".bt-block.buy .bt-block-head h3");
      var sellHead = panel.querySelector(".bt-block.sell .bt-block-head h3");
      function paintTabs() {
        if (buyHead) buyHead.textContent = "買いシグナル（戦略" + (active + 1) + "）";
        if (sellHead) sellHead.textContent = "売りシグナル（戦略" + (active + 1) + "）";
        if (tabsEl) Array.from(tabsEl.children).forEach(function (el, i) { el.classList.toggle("active", i === active); });
      }
      if (tabsEl) {
        for (var t = 0; t < store.slots.length; t++) (function (idx) {
          var tab = document.createElement("button");
          tab.type = "button"; tab.className = "bt-strat-tab";
          var cmp = document.createElement("input");
          cmp.type = "checkbox"; cmp.checked = !!store.slots[idx].cmp; cmp.title = "比較用に選択";
          cmp.addEventListener("click", function (e) { e.stopPropagation(); });
          cmp.addEventListener("change", function () { store.slots[idx].cmp = cmp.checked; persist(); });
          var lab = document.createElement("span"); lab.textContent = "戦略" + (idx + 1);
          tab.appendChild(cmp); tab.appendChild(lab);
          tab.addEventListener("click", function () {
            if (idx === active) return;
            syncFromDom();
            active = idx;
            applySlot(active);
            persist(); paintTabs();
          });
          tabsEl.appendChild(tab);
        })(t);
      }
      panel.addEventListener("change", function (e) {
        if (applying) return;
        var tg = e.target;
        if (!tg || !tg.getAttribute) return;
        if (tg.getAttribute("data-bt") === "buy" || tg.getAttribute("data-bt") === "sell" || tg.hasAttribute("data-bt-num") || tg.classList.contains("bt-re-for")) { syncFromDom(); persist(); }
      });
      applySlot(active);
      persist(); paintTabs();
      return {
        activeName: function () { return "戦略" + (store.active + 1); },
        activeReentry: function () { return (store.slots[store.active].reentry || []).map(function (r) { return { sell: r.sell, buy: r.buy }; }); },
        selected: function () {
          var screen = checked("screen");
          var out = [];
          store.slots.forEach(function (sl, i) {
            if (sl.cmp) out.push({ name: "戦略" + (i + 1), state: { screen: screen, buy: sl.buy.slice(), sell: sl.sell.slice(), nums: Object.assign({}, sl.nums), reentry: (sl.reentry || []).map(function (r) { return { sell: r.sell, buy: r.buy }; }) } });
          });
          return out;
        }
      };
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
            ddLimit: cfgBase.ddLimit, rsiBuy: rsiBuyVal, rsiSell: rsiSellVal, dropPct: dropPctVal, ddSell: ddSellVal, lossPct: lossPctVal, highPct: highPctVal, bounceSigma: bounceSigmaVal, maDays: maDaysVal, reentry: slotsApi.activeReentry()
          });
          out.push({ title: title, out: res });
        });
        return out;
      });
    }

    // One stock's trade list, shown under the summary table.
    function stockTradesHtml(title, out, stratName) {
      var html = '<div class="bt-res-block"><h4>' + title + '</h4>';
      html += '<p class="bt-res-range">期間：' + esc(out.range.from) + " 〜 " + esc(out.range.to) + "（" + out.range.sessions + '営業日）</p>';
      if (out.trades.length) {
        html += '<table class="bt-res-table bt-trades-table"><thead><tr>' + (stratName ? '<th data-bt-col="strat">戦略</th>' : '') + '<th data-bt-col="buyDate">買い日</th><th data-bt-col="buyPrice">買い値</th><th data-bt-col="sellDate">売り日</th><th data-bt-col="sellPrice">売り値</th><th data-bt-col="ret">損益</th><th data-bt-col="hold">保有</th><th data-bt-col="reason">売り理由</th></tr></thead><tbody>';
        out.trades.forEach(function (t) {
          html += '<tr>' + (stratName ? '<td data-bt-col="strat">' + esc(stratName) + '</td>' : '') + '<td data-bt-col="buyDate">' + esc(t.buyDate) + '</td><td data-bt-col="buyPrice">' + price(t.buyPrice) + '</td><td data-bt-col="sellDate">' + esc(t.sellDate) + (t.open ? "（期末評価）" : "") + '</td><td data-bt-col="sellPrice">' + price(t.sellPrice) + '</td><td data-bt-col="ret">' + pct(t.ret) + '</td><td data-bt-col="hold">' + t.hold + '日</td><td data-bt-col="reason">' +
            esc(t.open ? "期間終了" : (SELL_LABELS[t.reason] || t.reason)) + "</td></tr>";
        });
        html += "</tbody></table>";
        html += '<p class="bt-res-note">見出しをドラッグで列順変更、右端のつまみで幅調整。Ctrl+クリックで複数列を選ぶと幅を一括調整できます（どちらも保存されます）。</p>';
      } else {
        html += '<p class="bt-res-note">この期間に買い条件を満たす日はありませんでした。</p>';
      }
      html += "</div>";
      return html;
    }

    function sharpeTxt(v) { return v == null || !isFinite(v) ? "—" : v.toFixed(2); }

    // Trade-history table: column order and widths with the same
    // behaviour as the stock screener — drag a heading to reorder (with
    // drop indicators), drag the heading's right-edge grip to resize,
    // Ctrl+click headings to select several columns and resize them
    // together, Alt+arrow keys to move a column, Escape clears the
    // selection. Order and widths are saved per market, keyed by
    // column id.
    var TRADE_COLS = ["buyDate", "buyPrice", "sellDate", "sellPrice", "ret", "hold", "reason"];
    var STRAT_TRADE_COLS = ["strat"].concat(TRADE_COLS);
    var STOCK_COLS = ["title", "kind", "ret", "count", "win", "avg", "maxdd", "sharpe", "hold", "period"];
    var ROLL_COLS = ["start", "kind", "n", "avg", "median", "count", "win", "hold", "sharpe"];
    var CMP_COLS = ["strat", "ret", "win", "count", "avg", "maxdd", "hold", "sharpe"];
    // Column reorder + width adjustment shared by every backtest table:
    // heading drag reorders, the right-edge grip resizes, Ctrl+click selects
    // several columns for a bulk resize. Order and widths persist by column id.
    function setThLabel(th, txt) {
      var n = th.firstChild;
      if (n && n.nodeType === 3) n.nodeValue = txt;
      else th.insertBefore(document.createTextNode(txt), th.firstChild);
    }
    function setupFlexTable(table, cols, kind) {
      if (!table) return;
      Array.from(table.querySelectorAll("thead th")).forEach(function (th, i) { if (cols[i]) th.dataset.btCol = cols[i]; });
      Array.from(table.querySelectorAll("tbody tr")).forEach(function (tr) {
        var tds = Array.from(tr.children);
        if (tds.length === cols.length) tds.forEach(function (td, i) { td.dataset.btCol = cols[i]; });
      });
      var orderKey = "stock-dashboard-bt-" + kind + "-order-" + MARKET + "-v1";
      var widthKey = "stock-dashboard-bt-" + kind + "-widths-" + MARKET + "-v1";
      var order = cols.slice();
      try {
        var savedOrder = JSON.parse(localStorage.getItem(orderKey) || "null");
        if (Array.isArray(savedOrder)) {
          var filtered = savedOrder.filter(function (c) { return cols.includes(c); });
          cols.forEach(function (c) { if (!filtered.includes(c)) filtered.push(c); });
          if (filtered.length === cols.length) order = filtered;
        }
      } catch (e) {}
      var cg = document.createElement("colgroup");
      var colById = {};
      cols.forEach(function (c) { var col = document.createElement("col"); col.dataset.btCol = c; colById[c] = col; cg.appendChild(col); });
      table.insertBefore(cg, table.firstChild);
      function reorder(ord) {
        Array.from(table.querySelectorAll("tr")).forEach(function (tr) {
          var cells = {};
          Array.from(tr.children).forEach(function (cell) { cells[cell.dataset.btCol] = cell; });
          ord.forEach(function (c) { if (cells[c]) tr.appendChild(cells[c]); });
        });
        ord.forEach(function (c) { if (colById[c]) cg.appendChild(colById[c]); });
      }
      reorder(order);
      var thById = {};
      Array.from(table.querySelectorAll("thead th")).forEach(function (th) { thById[th.dataset.btCol] = th; });
      var clampW = function (v) { return Math.max(58, Math.min(650, Math.round(v))); };
      var defaults = {}, widths = {};
      var savedWidths = null;
      try { savedWidths = JSON.parse(localStorage.getItem(widthKey) || "null"); } catch (e) {}
      cols.forEach(function (c) {
        var th = thById[c];
        defaults[c] = clampW((th && th.offsetWidth) || 90);
        widths[c] = savedWidths && typeof savedWidths[c] === "number" && isFinite(savedWidths[c]) ? clampW(savedWidths[c]) : defaults[c];
      });
      function draw() {
        var total = 0;
        cols.forEach(function (c) { colById[c].style.width = widths[c] + "px"; total += widths[c]; });
        table.style.tableLayout = "fixed";
        table.style.width = total + "px";
        table.style.minWidth = total + "px";
      }
      function persistWidths() { try { localStorage.setItem(widthKey, JSON.stringify(widths)); } catch (e) {} }
      draw();
      var selectedCols = new Set();
      function paintSelection() {
        cols.forEach(function (c) { if (thById[c]) thById[c].classList.toggle("bt-col-selected", selectedCols.has(c)); });
      }
      table.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        if (!(e.ctrlKey || e.metaKey)) {
          if (selectedCols.size && !(e.target && e.target.closest && e.target.closest(".bt-col-resizer"))) { selectedCols.clear(); paintSelection(); }
          return;
        }
        var th = e.target && e.target.closest ? e.target.closest("th[data-bt-col]") : null;
        if (!th || !table.contains(th)) return;
        if (e.target.closest(".bt-col-resizer")) return;
        var id = th.dataset.btCol;
        if (!cols.includes(id)) return;
        e.preventDefault(); e.stopPropagation();
        if (selectedCols.has(id)) selectedCols.delete(id); else selectedCols.add(id);
        paintSelection();
      }, true);
      table.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && selectedCols.size) { selectedCols.clear(); paintSelection(); }
      });
      function widthTargets(id) { return selectedCols.has(id) && selectedCols.size > 1 ? Array.from(selectedCols) : [id]; }
      cols.forEach(function (id) {
        var th = thById[id];
        if (!th) return;
        th.classList.add("bt-reorderable");
        th.tabIndex = 0;
        th.title = "ドラッグで列順を変更（保存）。Ctrl+クリックで複数選択。Alt+左右キーでも移動可能。";
        var grip = document.createElement("span");
        grip.className = "bt-col-resizer";
        grip.setAttribute("tabindex", "0");
        grip.title = "ドラッグで幅を調整・自動保存。ダブルクリックで元に戻す";
        th.appendChild(grip);
        grip.addEventListener("pointerdown", function (e) {
          if (e.button !== 0 || e.isPrimary === false) return;
          e.preventDefault(); e.stopPropagation();
          var startX = e.clientX, startWidth = widths[id], pointerId = e.pointerId;
          function move(ev) {
            if (ev.pointerId !== pointerId) return;
            var raw = startWidth + (ev.clientX - startX);
            widthTargets(id).forEach(function (t) { widths[t] = clampW(raw); });
            draw();
          }
          function up(ev) {
            if (ev.pointerId !== pointerId) return;
            window.removeEventListener("pointermove", move, true);
            window.removeEventListener("pointerup", up, true);
            window.removeEventListener("pointercancel", up, true);
            persistWidths();
          }
          window.addEventListener("pointermove", move, true);
          window.addEventListener("pointerup", up, true);
          window.addEventListener("pointercancel", up, true);
        });
        grip.addEventListener("click", function (e) { e.stopPropagation(); });
        grip.addEventListener("dblclick", function (e) {
          e.preventDefault(); e.stopPropagation();
          widthTargets(id).forEach(function (t) { widths[t] = defaults[t]; });
          draw(); persistWidths();
        });
        grip.addEventListener("keydown", function (e) {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          var raw = widths[id] + (e.key === "ArrowRight" ? 10 : -10);
          widthTargets(id).forEach(function (t) { widths[t] = clampW(raw); });
          draw(); persistWidths();
        });
        var drag = null, hover = null, after = false;
        function highlight(next, right) {
          if (hover) hover.classList.remove("bt-drop-before", "bt-drop-after");
          hover = next; after = right;
          if (hover) hover.classList.add(right ? "bt-drop-after" : "bt-drop-before");
        }
        function endDrag(pointerId, cancel) {
          if (!drag || drag.id !== pointerId) return;
          var target = hover, right = after;
          drag = null;
          th.classList.remove("bt-column-dragging");
          highlight(null, false);
          try { if (th.hasPointerCapture && th.hasPointerCapture(pointerId)) th.releasePointerCapture(pointerId); } catch (err) {}
          if (!cancel && target) {
            var cur = Array.from(table.querySelectorAll("thead th")).map(function (t) { return t.dataset.btCol; });
            cur.splice(cur.indexOf(id), 1);
            var ti = cur.indexOf(target.dataset.btCol);
            cur.splice(right ? ti + 1 : ti, 0, id);
            reorder(cur);
            try { localStorage.setItem(orderKey, JSON.stringify(cur)); } catch (err) {}
          }
        }
        th.addEventListener("pointerdown", function (e) {
          if (e.button !== 0 || e.isPrimary === false || e.pointerType === "touch") return;
          if (e.target.closest(".bt-col-resizer")) return;
          drag = { id: e.pointerId, x: e.clientX, y: e.clientY, active: false };
          try { th.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
        });
        th.addEventListener("pointermove", function (e) {
          if (!drag || drag.id !== e.pointerId) return;
          if (!drag.active) {
            if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
            drag.active = true;
            th.classList.add("bt-column-dragging");
          }
          var under = document.elementFromPoint ? document.elementFromPoint(e.clientX, e.clientY) : null;
          var target = under && under.closest ? under.closest("thead th[data-bt-col]") : null;
          var next = target && target !== th && table.contains(target) ? target : null;
          var right = next ? e.clientX > next.getBoundingClientRect().left + next.getBoundingClientRect().width / 2 : false;
          if (next !== hover || right !== after) highlight(next, right);
        });
        th.addEventListener("pointerup", function (e) { if (drag && drag.active) endDrag(e.pointerId, false); else drag = null; });
        th.addEventListener("pointercancel", function (e) { endDrag(e.pointerId, true); });
        th.addEventListener("keydown", function (e) {
          if (e.target !== th || !e.altKey || e.ctrlKey || e.metaKey) return;
          var delta = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
          if (!delta) return;
          e.preventDefault();
          var cur = Array.from(table.querySelectorAll("thead th")).map(function (t) { return t.dataset.btCol; });
          var idx = cur.indexOf(id), swap = idx + delta;
          if (swap < 0 || swap >= cur.length) return;
          var other = cur[swap];
          cur[swap] = id; cur[idx] = other;
          reorder(cur);
          try { localStorage.setItem(orderKey, JSON.stringify(cur)); } catch (err) {}
          th.focus();
        });
      });
      return {
        restamp: function () {
          Array.from(table.querySelectorAll("tbody tr")).forEach(function (tr) {
            var tds = Array.from(tr.children);
            if (tds.length === cols.length) tds.forEach(function (td, i) { td.dataset.btCol = cols[i]; });
          });
          var cur = Array.from(table.querySelectorAll("thead th")).map(function (t) { return t.dataset.btCol; });
          reorder(cur);
        }
      };
    }



    function renderStockResults(container, entries, opts) {
      opts = opts || {};
      var tradesFor = function (e) {
        if (!e.out) return '<div class="bt-res-block"><h4>' + e.title + '</h4><p class="bt-res-note">' + esc(e.noData || "") + "</p></div>";
        return opts.tradesHtml ? opts.tradesHtml(e) : stockTradesHtml(e.title, e.out, opts.stratName);
      };
      var wireTrades = function (root) {
        var tbl = root.querySelector(".bt-trades-table");
        if (tbl) setupFlexTable(tbl, tbl.querySelector("th") && tbl.querySelector("th").getAttribute("data-bt-col") === "strat" ? STRAT_TRADE_COLS : TRADE_COLS, "trades");
        var block = root.querySelector(".bt-res-block");
        if (block && tbl && !block.querySelector(".bt-trades-toggle")) {
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "bt-trades-toggle";
          btn.textContent = "売買履歴を非表示";
          block.insertBefore(btn, tbl);
          btn.addEventListener("click", function () {
            var hidden = tbl.style.display === "none";
            tbl.style.display = hidden ? "" : "none";
            var hint = tbl.nextElementSibling;
            if (hint) hint.style.display = tbl.style.display;
            btn.textContent = hidden ? "売買履歴を非表示" : "売買履歴を表示";
          });
        }
      };
      // With a single tested stock the per-stock table adds nothing (its rows
      // are the aggregate), so show that stock's trades directly (GRW).
      if (entries.length === 1 && entries[0].out) {
        container.innerHTML = tradesFor(entries[0]);
        wireTrades(container);
        return;
      }
      var html = '<table class="bt-res-table bt-stock-table"><thead><tr><th>銘柄</th><th>区分</th><th>リターン</th><th>取引回数</th><th>勝率</th><th>平均損益</th><th>最大DD</th><th>シャープレシオ</th><th>平均保有</th><th>期間</th></tr></thead><tbody>';
      entries.forEach(function (e, idx) {
        var short = (e.title || "").split(" ")[0];
        if (!e.out) {
          html += '<tr class="bt-stock-row" data-bt-stock="' + idx + '"><td colspan="10" style="text-align:left">' + short + "：" + esc(e.noData || "") + "</td></tr>";
          return;
        }
        var p = e.out.perf;
        html += '<tr class="bt-stock-row bt-bh-row" data-bt-stock="' + idx + '"><td style="text-align:left">' + short + '</td><td>買い持ち</td><td>' + pct(p.bhReturn) + "</td><td>—</td><td>—</td><td>—</td><td>" + pct(p.bhMaxDd) + "</td><td>" + sharpeTxt(p.bhSharpe) + "</td><td>—</td><td>" + esc(e.out.range.from) + " 〜 " + esc(e.out.range.to) + "</td></tr>";
        html += '<tr class="bt-stock-row" data-bt-stock="' + idx + '"><td style="text-align:left">' + short + "</td><td>戦略</td><td>" + pct(p.totalReturn) + "</td><td>" + p.closedCount + (p.hasOpen ? "（+保有中1）" : "") + "</td><td>" +
          (p.winRate == null ? "—" : pct(p.winRate, 0)) + "</td><td>" + (p.avgRet == null ? "—" : pct(p.avgRet)) + "</td><td>" + pct(p.maxDd) + "</td><td>" + sharpeTxt(p.sharpe) + "</td><td>" +
          (p.avgHold == null ? "—" : p.avgHold.toFixed(0) + "日") + '</td><td>' + esc(e.out.range.from) + " 〜 " + esc(e.out.range.to) + "</td></tr>";
      });
      html += "</tbody></table>";
      html += '<p class="bt-res-note">銘柄の行を選ぶと、その銘柄の売買履歴を表示します。見出しをドラッグで列順変更、右端のつまみで幅調整できます（どちらも保存されます）。</p>';
      html += '<div class="bt-stock-detail"></div>';
      container.innerHTML = html;
      setupFlexTable(container.querySelector(".bt-stock-table"), STOCK_COLS, "stock");
      var detail = container.querySelector(".bt-stock-detail");
      var rowsEls = Array.from(container.querySelectorAll(".bt-stock-row"));
      function select(idx) {
        rowsEls.forEach(function (x) { x.classList.remove("bt-stock-sel"); });
        var pair = rowsEls.filter(function (x) { return parseInt(x.dataset.btStock, 10) === idx; });
        if (!pair.length) { detail.innerHTML = ""; return; }
        pair.forEach(function (x) { x.classList.add("bt-stock-sel"); });
        var e = entries[idx];
        detail.innerHTML = tradesFor(e);
        wireTrades(detail);
      }
      rowsEls.forEach(function (tr) {
        tr.addEventListener("click", function () { select(parseInt(tr.dataset.btStock, 10)); });
      });
      if (entries.length) select(0);
    }

    var rsiBuyVal = null, rsiSellVal = null, dropPctVal = null, ddSellVal = null, ddGateVal = null, lossPctVal = null, highPctVal = null, bounceSigmaVal = null, maDaysVal = null;
    function condLabel(group, id) {
      if (id === "rsiGe") return "RSI（14日）が" + (rsiBuyVal == null ? "閾値" : rsiBuyVal) + "以下";
      if (id === "bounce") return "前日に" + (bounceSigmaVal == null ? "閾値" : bounceSigmaVal) + "σ以上下落";
      if (id === "rsiLe") return "RSI（14日）が" + (rsiSellVal == null ? "閾値" : rsiSellVal) + "以上";
      if (id === "dropPct") return "前日終値から" + (dropPctVal == null ? "閾値" : dropPctVal) + "%以上下落";
      if (id === "ma50") return "株価が" + (maDaysVal == null ? "閾値" : maDaysVal) + "日移動平均を下回る";
      if (id === "loss8") return "買値から" + (lossPctVal == null ? "閾値" : lossPctVal) + "%下落";
      if (id === "high25") return "52週高値から" + (highPctVal == null ? "閾値" : highPctVal) + "%以上下落";
      if (id === "ddGe") return "DD（売り抜け日）が" + (ddSellVal == null ? "閾値" : ddSellVal) + "以上（直近25取引日）";
      if (id === "dd") return "DD（売り抜け日）が" + (ddGateVal == null ? "閾値" : ddGateVal) + "以下";
      return ((group === "sell" ? SELL_LABELS : BUY_LABELS)[id] || id);
    }
    function readRsi(buyAll, sellAll) {
      if (buyAll.includes("rsiGe")) { var v = numOf("rsiBuy"); rsiBuyVal = isFinite(v) ? v : 30; } else rsiBuyVal = null;
      if (buyAll.includes("bounce")) { var bs = numOf("bounceSigma"); bounceSigmaVal = isFinite(bs) ? bs : 2; } else bounceSigmaVal = null;
      if (sellAll.includes("rsiLe")) { var w = numOf("rsiSell"); rsiSellVal = isFinite(w) ? w : 70; } else rsiSellVal = null;
      if (sellAll.includes("dropPct")) { var d = numOf("dropSell"); dropPctVal = isFinite(d) ? d : 5; } else dropPctVal = null;
      if (sellAll.includes("ma50")) { var md = numOf("maSellDays"); maDaysVal = isFinite(md) ? md : 50; } else maDaysVal = null;
      if (sellAll.includes("loss8")) { var l = numOf("lossPct"); lossPctVal = isFinite(l) ? l : 8; } else lossPctVal = null;
      if (sellAll.includes("high25")) { var h = numOf("highPct"); highPctVal = isFinite(h) ? h : 25; } else highPctVal = null;
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
      var reRulesNow = slotsApi.activeReentry();
      readRsi(buyAll.concat(reRulesNow.map(function (r) { return r.buy; })), sellAll.concat(reRulesNow.map(function (r) { return r.sell; })));
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
        return ctx;
      }).then(function (ctx) {
        if (!ctx) return;
        var summaries = [], details = {};
        ctx.perDate.forEach(function (pd) {
          var entries = [], n = 0, sumRet = 0, sumBh = 0, rets = [], bhRets = [], closedTrades = 0, winTrades = 0, holdSum = 0, sumSharpe = 0, nSharpe = 0, sumBhSharpe = 0, nBhSharpe = 0;
          pd.codes.forEach(function (code) {
            var rows = ctx.store[code];
            if (!rows || !rows.length) return;
            var fromIdx = rows.findIndex(function (r) { return r[0] >= pd.date; });
            if (fromIdx < 0) return;
            var toIdx = Math.min(rows.length - 1, fromIdx + horizon - 1);
            if (toIdx <= fromIdx) return;
            var out = runBacktest(rows, {
              fromIdx: fromIdx, toIdx: toIdx, buy: buy, sell: sell,
              ddLimit: ddLimit, rsiBuy: rsiBuyVal, rsiSell: rsiSellVal, dropPct: dropPctVal, ddSell: ddSellVal, lossPct: lossPctVal, highPct: highPctVal, bounceSigma: bounceSigmaVal, maDays: maDaysVal, reentry: slotsApi.activeReentry()
            });
            var title = esc(code) + (ctx.names[code] ? " " + esc(ctx.names[code]) : "");
            entries.push({ title: title, out: out });
            n++; sumRet += out.perf.totalReturn; sumBh += out.perf.bhReturn; rets.push(out.perf.totalReturn); bhRets.push(out.perf.bhReturn);
            if (out.perf.sharpe != null) { sumSharpe += out.perf.sharpe; nSharpe++; }
            if (out.perf.bhSharpe != null) { sumBhSharpe += out.perf.bhSharpe; nBhSharpe++; }
            out.trades.forEach(function (t) { if (!t.open) { closedTrades++; holdSum += t.hold; if (t.ret > 0) winTrades++; } });
          });
          rets.sort(function (a, b) { return a - b; });
          var median = !rets.length ? null : (rets.length % 2 ? rets[(rets.length - 1) / 2] : (rets[rets.length / 2 - 1] + rets[rets.length / 2]) / 2);
          bhRets.sort(function (a, b) { return a - b; });
          var bhMedian = !bhRets.length ? null : (bhRets.length % 2 ? bhRets[(bhRets.length - 1) / 2] : (bhRets[bhRets.length / 2 - 1] + bhRets[bhRets.length / 2]) / 2);
          summaries.push({
            date: pd.date, count: n, avg: n ? sumRet / n : null, median: median,
            bhAvg: n ? sumBh / n : null, bhMedian: bhMedian, trades: closedTrades,
            sharpeAvg: nSharpe ? sumSharpe / nSharpe : null, bhSharpeAvg: nBhSharpe ? sumBhSharpe / nBhSharpe : null,
            avgHold: closedTrades ? holdSum / closedTrades : null, winRate: closedTrades ? winTrades / closedTrades : null, truncated: pd.truncated
          });
          details[pd.date] = entries;
        });
        var valid = summaries.filter(function (s) { return s.count > 0; });
        var html = '<table class="bt-res-table bt-roll-table"><thead><tr><th>開始日</th><th>区分</th><th>対象銘柄数</th><th>平均リターン</th><th>中央値</th><th>取引回数</th><th>勝率</th><th>平均保有</th><th>シャープレシオ</th></tr></thead><tbody>';
        if (valid.length) {
          var totAvg = valid.reduce(function (s, x) { return s + x.avg; }, 0) / valid.length;
          var totBh = valid.reduce(function (s, x) { return s + x.bhAvg; }, 0) / valid.length;
          var totCount = valid.reduce(function (s, x) { return s + x.count; }, 0);
          var totTrades = valid.reduce(function (s, x) { return s + x.trades; }, 0);
          var shVals = valid.map(function (x) { return x.sharpeAvg; }).filter(function (v) { return v != null; });
          var bhShVals = valid.map(function (x) { return x.bhSharpeAvg; }).filter(function (v) { return v != null; });
          var totSharpe = shVals.length ? shVals.reduce(function (a, b) { return a + b; }, 0) / shVals.length : null;
          var totBhSharpe = bhShVals.length ? bhShVals.reduce(function (a, b) { return a + b; }, 0) / bhShVals.length : null;
          var holdVals = valid.map(function (x) { return x.avgHold; }).filter(function (v) { return v != null; });
          var totHold = holdVals.length ? holdVals.reduce(function (a, b) { return a + b; }, 0) / holdVals.length : null;
          html += '<tr class="bt-roll-total bt-bh-row"><td>全開始日の平均</td><td>買い持ち</td><td>' + totCount + '</td><td>' + pct(totBh) + '</td><td>—</td><td>—</td><td>—</td><td>—</td><td>' + sharpeTxt(totBhSharpe) + '</td></tr>';
          html += '<tr class="bt-roll-total"><td>全開始日の平均</td><td>戦略</td><td>' + totCount + '</td><td>' + pct(totAvg) + '</td><td>—</td><td>' + totTrades + '</td><td>—</td><td>' + (totHold == null ? "—" : totHold.toFixed(0) + "日") + '</td><td>' + sharpeTxt(totSharpe) + '</td></tr>';
        }
        summaries.forEach(function (s) {
          html += '<tr class="bt-roll-row bt-bh-row" data-roll-date="' + s.date + '"><td>' + s.date + '</td><td>買い持ち</td><td>' + s.count + (s.truncated ? "（上限200）" : "") + '</td><td>' + pct(s.bhAvg) + '</td><td>' + pct(s.bhMedian) + '</td><td>—</td><td>—</td><td>—</td><td>' + sharpeTxt(s.bhSharpeAvg) + '</td></tr>';
          html += '<tr class="bt-roll-row" data-roll-date="' + s.date + '"><td>' + s.date + '</td><td>戦略</td><td>' + s.count + (s.truncated ? "（上限200）" : "") + '</td><td>' + pct(s.avg) + '</td><td>' + pct(s.median) + '</td><td>' + s.trades + '</td><td>' + (s.winRate == null ? "—" : pct(s.winRate, 0)) + '</td><td>' + (s.avgHold == null ? "—" : s.avgHold.toFixed(0) + "日") + '</td><td>' + sharpeTxt(s.sharpeAvg) + '</td></tr>';
        });
        html += '</tbody></table>';
        html += '<p class="bt-res-note">開始日の行を選ぶと、その日の銘柄別結果を表示します。' + (fixedCodes ? "対象銘柄は入力した銘柄です（スクリーニング条件は使っていません）。" : "対象銘柄は開始日時点のスナップショットでスクリーニング条件を判定しています。") + '</p>';
        html += '<div id="bt-roll-detail"></div>';
        var applied = (fixedCodes ? [] : screenIds.map(function (id) { return "スクリーニング：" + condLabel("buy", id); }))
          .concat(buy.map(function (id) { return "買い：" + condLabel("buy", id); }))
          .concat(sell.map(function (id) { return "売り：" + condLabel("sell", id); }));
        if (ddLimit != null) applied.push("買い：" + condLabel("buy", "dd"));
        slotsApi.activeReentry().forEach(function (r) { applied.push("再エントリー：" + condLabel("sell", r.sell) + "で売った後は" + condLabel("buy", r.buy) + "で買い戻す"); });
        html += '<p class="bt-res-note">適用した条件：' + esc(applied.join(" / ")) + "<br>判定は終値、売買は翌営業日の始値です。手数料・税金は含みません。シャープレシオは日次リターンから計算しています（無リスク金利0）。" + (buy.length ? "" : "買い条件が未選択のため、対象銘柄は各開始日の翌営業日に買います。") + "</p>";
        if (skipped.length) {
          html += '<p class="bt-res-note">対象外（過去データがないため判定しませんでした）：' + esc(skipped.join(" / ")) + "</p>";
        }
        results.innerHTML = html;
        setupFlexTable(results.querySelector(".bt-roll-table"), ROLL_COLS, "roll");
        var detail = document.getElementById("bt-roll-detail");
        results.querySelectorAll(".bt-roll-row").forEach(function (tr) {
          tr.addEventListener("click", function () {
            results.querySelectorAll(".bt-roll-row").forEach(function (x) { x.classList.remove("bt-roll-sel"); });
            tr.classList.add("bt-roll-sel");
            detail.innerHTML = '<h3 class="bt-roll-detail-title">' + esc(tr.dataset.rollDate) + ' 開始の銘柄別結果</h3><div class="bt-roll-stocks"></div>';
            var ents = details[tr.dataset.rollDate];
            if (ents && ents.length) renderStockResults(detail.querySelector(".bt-roll-stocks"), ents, { stratName: slotsApi.activeName() });
            else detail.insertAdjacentHTML("beforeend", '<p class="bt-res-note">対象銘柄がありませんでした。</p>');
          });
        });
        runBtn.disabled = false;
      }).catch(function (e) {
        results.innerHTML = '<p class="bt-res-note">' + esc(e && e.rollMsg ? e.rollMsg : "実行中にエラーが発生しました。期間と条件を確認してください。") + "</p>";
        runBtn.disabled = false;
      });
    }

    var mtEl = document.getElementById("bt-min-trades");
    if (mtEl) {
      try { var mtSaved = localStorage.getItem("stock-dashboard-bt-mintrades-" + MARKET); if (mtSaved != null) mtEl.value = mtSaved; } catch (e) {}
      mtEl.addEventListener("change", function () { try { localStorage.setItem("stock-dashboard-bt-mintrades-" + MARKET, mtEl.value); } catch (e) {} });
    }
    var runAllBtnEl = document.getElementById("bt-run-all");
    if (runAllBtnEl) runAllBtnEl.addEventListener("click", runAllPatterns);
    runBtn.addEventListener("click", function () {
      var cmpSel = slotsApi.selected();
      if (cmpSel.length) { runCompare(); return; }
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
      var reRulesNow = slotsApi.activeReentry();
      readRsi(buyAll.concat(reRulesNow.map(function (r) { return r.buy; })), sellAll.concat(reRulesNow.map(function (r) { return r.sell; })));
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
        return { names: ctx.names, loaded: ctx.loaded };
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
            ddLimit: ddLimit, rsiBuy: rsiBuyVal, rsiSell: rsiSellVal, dropPct: dropPctVal, ddSell: ddSellVal, lossPct: lossPctVal, highPct: highPctVal, bounceSigma: bounceSigmaVal, maDays: maDaysVal, reentry: slotsApi.activeReentry()
          });
          entries.push({ title: title, out: out });
        });
        var applied = screen.map(function (id) { return "スクリーニング：" + condLabel("buy", id); })
          .concat(buy.map(function (id) { return "買い：" + condLabel("buy", id); }))
          .concat(sell.map(function (id) { return "売り：" + condLabel("sell", id); }));
        if (ddLimit != null) applied.push("買い：" + condLabel("buy", "dd"));
        slotsApi.activeReentry().forEach(function (r) { applied.push("再エントリー：" + condLabel("sell", r.sell) + "で売った後は" + condLabel("buy", r.buy) + "で買い戻す"); });
        var notes = '<p class="bt-res-note">適用した条件：' + esc(applied.join(" / ") || "なし") + "<br>判定は終値、売買は翌営業日の始値です。手数料・税金は含みません。シャープレシオは日次リターンから計算しています（無リスク金利0）。" + (entry.length ? "" : "買い条件（判定できるもの）が未選択のため、対象銘柄は期間開始の翌営業日に買います。") + "</p>";
        if (skipped.length) {
          notes += '<p class="bt-res-note">対象外（過去データがないため判定しませんでした）：' + esc(skipped.join(" / ")) + "</p>";
        }
        var finish = function () {
          results.innerHTML = '<div id="bt-stock-results"></div>' + notes;
          renderStockResults(document.getElementById("bt-stock-results"), entries, { stratName: slotsApi.activeName() });
        };
        if (indexKeys.length) {
          var endYear = toVal ? +toVal.slice(0, 4) : new Date().getFullYear();
          var startYear = fromVal ? +fromVal.slice(0, 4) : endYear - periodYears;
          var indexYears = [];
          for (var iy = startYear - 1; iy <= endYear; iy++) indexYears.push(iy);
          loadIndexEntries(indexKeys, indexYears, { buy: entry, sell: sell, ddLimit: ddLimit }, fromVal, toVal, periodYears)
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
    // ---- strategy comparison (table only, GRW chose layout 3) ----
    function stratCfg(st, ctx) {
      var nums = st.nums || {};
      var num = function (k, dflt) { var v = parseFloat(nums[k]); return isFinite(v) ? v : dflt; };
      var allBuy = (st.screen || []).concat(st.buy || []);
      var entry = allBuy.filter(function (id) { return BUY_EVALUABLE[id]; });
      var sell = (st.sell || []).filter(function (id) { return SELL_EVALUABLE[id]; });
      return {
        buy: entry, sell: sell,
        ddLimit: (st.buy || []).includes("dd") ? num("dd", 5) : null,
        rsiBuy: Math.min(50, Math.max(25, num("rsiBuy", 30))), rsiSell: Math.min(85, Math.max(70, num("rsiSell", 70))),
        dropPct: num("dropSell", 5), ddSell: [5, 6, 7].reduce(function (a, o) { return Math.abs(o - num("ddSell", 5)) < Math.abs(a - num("ddSell", 5)) ? o : a; }, 5), lossPct: num("lossPct", 8), highPct: num("highPct", 25), bounceSigma: num("bounceSigma", 2), maDays: [20, 50, 200].reduce(function (a, o) { return Math.abs(o - num("maSellDays", 50)) < Math.abs(a - num("maSellDays", 50)) ? o : a; }, 50),
        reentry: (st.reentry || []).filter(function (r) { return r && SELL_EVALUABLE[r.sell] && ["vol15", "rsiGe", "bounce", "ftd"].indexOf(r.buy) >= 0; }).map(function (r) { return { sell: r.sell, buy: r.buy }; })
      };
    }
    function aggregate(entries) {
      var outs = entries.filter(function (e) { return e.out; }).map(function (e) { return e.out; });
      if (!outs.length) return null;
      var closed = 0, wins = 0, retSum = 0, holdSum = 0, open = 0;
      outs.forEach(function (o) {
        o.trades.forEach(function (t) {
          if (t.open) open++;
          else { closed++; retSum += t.ret; holdSum += t.hold; if (t.ret > 0) wins++; }
        });
      });
      var mean = function (f) { return outs.reduce(function (sm, o) { return sm + f(o.perf); }, 0) / outs.length; };
      var sh = outs.map(function (o) { return o.perf.sharpe; }).filter(function (x) { return x != null; });
      var bsh = outs.map(function (o) { return o.perf.bhSharpe; }).filter(function (x) { return x != null; });
      return {
        n: outs.length, ret: mean(function (p) { return p.totalReturn; }), bh: mean(function (p) { return p.bhReturn; }),
        maxDd: mean(function (p) { return p.maxDd; }),
        bhMaxDd: mean(function (p) { return p.bhMaxDd; }),
        bhSharpe: bsh.length ? bsh.reduce(function (a, b) { return a + b; }, 0) / bsh.length : null,
        sharpe: sh.length ? sh.reduce(function (a, b) { return a + b; }, 0) / sh.length : null,
        closed: closed, open: open, winRate: closed ? wins / closed : null,
        avgRet: closed ? retSum / closed : null, avgHold: closed ? holdSum / closed : null
      };
    }
    function runCompare() {
      var selected = slotsApi.selected();
      if (!selected.length) {
        results.innerHTML = '<p class="bt-res-note">比較する戦略を、戦略タブの□で1つ以上選んでください。</p>';
        return;
      }
      var symbolsRaw = (document.getElementById("bt-symbols") || {}).value || "";
      var codes = symbolsRaw.split(/[\s,、，]+/).map(function (x) { return x.trim(); }).filter(Boolean)
        .map(function (x) { return MARKET === "us" ? x.toUpperCase() : x.replace(/\.T$/i, ""); });
      codes = Array.from(new Set(codes)).slice(0, 200);
      var etfCodes = Array.from(panel.querySelectorAll('input[data-bt-etf]:checked')).map(function (b) { return b.value; });
      etfCodes.forEach(function (c) { if (!codes.includes(c)) codes.push(c); });
      var indexKeys = Array.from(panel.querySelectorAll('input[data-bt-index]:checked')).map(function (b) { return b.value; });
      if (!codes.length && !indexKeys.length) {
        results.innerHTML = MARKET === "us"
          ? '<p class="bt-res-note">ティッカーを入力するか、指数・ETFを選んでから比較してください。</p>'
          : '<p class="bt-res-note">銘柄コードを入力するか、指数・ETFを選んでから比較してください。</p>';
        return;
      }
      var normDate = function (v) { var d = String(v || "").replace(/\D/g, ""); return d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : ""; };
      var fromVal = normDate((document.getElementById("bt-from") || {}).value);
      var toVal = normDate((document.getElementById("bt-to") || {}).value);
      var periodYears = parseInt((document.getElementById("bt-period") || {}).value || "3", 10);
      runBtn.disabled = true;
      results.innerHTML = '<p class="bt-res-note">比較を実行中…</p>';
      loadJson("sector-leaders.json").catch(function () { return null; }).then(function (leaders) {
        var names = buildNames(leaders);
        var jobs = codes.map(function (code) {
          return loadJson(ohlcvUrl(code)).then(function (data) {
            return { code: code, rows: (data && data.rows) || [] };
          }).catch(function () { return { code: code, rows: null }; });
        });
        return Promise.all(jobs).then(function (loaded) { return { names: names, loaded: loaded }; });
      }).then(function (ctx) {
        return { names: ctx.names, loaded: ctx.loaded };
      }).then(function (ctx) {
        var perStrat = selected.map(function (it) {
          var cfg = stratCfg(it.state, ctx);
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
            entries.push({ title: title, out: runBacktest(rows, Object.assign({ fromIdx: fromIdx, toIdx: toIdx }, cfg)) });
          });
          return { name: it.name, cfg: cfg, entries: entries };
        });
        var ixJobs = perStrat.map(function (ps) {
          if (!indexKeys.length) return Promise.resolve();
          var endYear = toVal ? +toVal.slice(0, 4) : new Date().getFullYear();
          var startYear = fromVal ? +fromVal.slice(0, 4) : endYear - periodYears;
          var indexYears = [];
          for (var iy = startYear - 1; iy <= endYear; iy++) indexYears.push(iy);
          return loadIndexEntries(indexKeys, indexYears, { buy: ps.cfg.buy, sell: ps.cfg.sell, ddLimit: ps.cfg.ddLimit }, fromVal, toVal, periodYears)
            .then(function (ixEntries) { ps.entries.push.apply(ps.entries, ixEntries); })
            .catch(function () {});
        });
        return Promise.all(ixJobs).then(function () { return perStrat; });
      }).then(function (perStrat) {
        var ddTxt = function (v) { return v > 0 ? "-" + (v * 100).toFixed(2) + "%" : "0.00%"; };
        function mergedTradesHtml(title) {
          var rowsAll = [];
          var range = null;
          perStrat.forEach(function (ps) {
            var e = null;
            ps.entries.forEach(function (x) { if (x.title === title) e = x; });
            if (e && e.out) {
              if (!range) range = e.out.range;
              e.out.trades.forEach(function (t) { rowsAll.push({ strat: ps.name, t: t }); });
            }
          });
          var html = '<div class="bt-res-block"><h4>' + title + ' の売買履歴（全戦略）</h4>';
          if (range) html += '<p class="bt-res-range">期間：' + esc(range.from) + " 〜 " + esc(range.to) + "（" + range.sessions + '営業日）</p>';
          if (!rowsAll.length) return html + '<p class="bt-res-note">売買履歴はありません</p></div>';
          rowsAll.sort(function (a, b) { return a.t.buyDate < b.t.buyDate ? -1 : a.t.buyDate > b.t.buyDate ? 1 : (a.strat < b.strat ? -1 : 1); });
          html += '<table class="bt-res-table bt-trades-table bt-trades-merged"><thead><tr><th data-bt-col="strat">戦略</th><th data-bt-col="buyDate">買い日</th><th data-bt-col="buyPrice">買い値</th><th data-bt-col="sellDate">売り日</th><th data-bt-col="sellPrice">売り値</th><th data-bt-col="ret">損益</th><th data-bt-col="hold">保有</th><th data-bt-col="reason">売り理由</th></tr></thead><tbody>';
          rowsAll.forEach(function (r) {
            var t = r.t;
            html += '<tr><td data-bt-col="strat">' + esc(r.strat) + '</td><td data-bt-col="buyDate">' + esc(t.buyDate) + '</td><td data-bt-col="buyPrice">' + price(t.buyPrice) + '</td><td data-bt-col="sellDate">' + esc(t.sellDate) + (t.open ? "（期末評価）" : "") + '</td><td data-bt-col="sellPrice">' + price(t.sellPrice) + '</td><td data-bt-col="ret">' + pct(t.ret) + '</td><td data-bt-col="hold">' + t.hold + '日</td><td data-bt-col="reason">' + esc(t.open ? "期間終了" : (SELL_LABELS[t.reason] || t.reason)) + "</td></tr>";
          });
          html += "</tbody></table>";
          html += '<p class="bt-res-note">見出しをドラッグで列順変更、右端のつまみで幅調整。Ctrl+クリックで複数列を選ぶと幅を一括調整できます（どちらも保存されます）。</p></div>';
          return html;
        }
        var targetNames = perStrat[0].entries.map(function (e) { return e.title; });
        var html = '<p class="bt-res-note">戦略比較 / 銘柄：' + targetNames.join("、") + "<br>行を選ぶと、その戦略の銘柄別結果を表示します。" + (targetNames.length > 1 ? "複数銘柄の値は平均です（勝率・平均損益・平均保有は全取引の合算、取引回数は合計）。" : "") + "</p>";
        html += '<table class="bt-res-table bt-cmp-table"><thead><tr><th>戦略</th><th>戦略リターン</th><th>勝率</th><th>取引回数</th><th>平均損益</th><th>最大DD</th><th>平均保有</th><th>シャープ</th></tr></thead><tbody>';
        var bhAgg = null;
        perStrat.forEach(function (ps) { if (!bhAgg) bhAgg = aggregate(ps.entries); });
        if (bhAgg) {
          html += '<tr class="bt-bh-row"><td style="text-align:left">買い持ち</td><td>' + pct(bhAgg.bh) + "</td><td>—</td><td>—</td><td>—</td><td>" + ddTxt(bhAgg.bhMaxDd) + "</td><td>—</td><td>" + sharpeTxt(bhAgg.bhSharpe) + "</td></tr>";
        }
        perStrat.forEach(function (ps, idx) {
          var a = aggregate(ps.entries);
          if (!a) {
            html += '<tr class="bt-cmp-row" data-cmp-idx="' + idx + '"><td colspan="8" style="text-align:left">' + esc(ps.name) + "：対象銘柄のデータがありませんでした</td></tr>";
            return;
          }
          html += '<tr class="bt-cmp-row" data-cmp-idx="' + idx + '"><td style="text-align:left">' + esc(ps.name) + "</td><td>" + pct(a.ret) + "</td><td>" +
            (a.winRate == null ? "—" : pct(a.winRate, 0)) + "</td><td>" + a.closed + (a.open ? "（+保有中" + a.open + "）" : "") + "</td><td>" +
            (a.avgRet == null ? "—" : pct(a.avgRet)) + "</td><td>" + ddTxt(a.maxDd) + "</td><td>" +
            (a.avgHold == null ? "—" : a.avgHold.toFixed(0) + "日") + "</td><td>" + sharpeTxt(a.sharpe) + "</td></tr>";
        });
        html += "</tbody></table>";
        html += '<p class="bt-res-note">判定は終値、売買は翌営業日の始値です。手数料・税金は含みません。シャープレシオは日次リターンから計算しています（無リスク金利0）。スクリーニング条件のうち過去データで判定できないもの（EPS・ROE・セクター等）は比較でも対象外です。</p>';
        html += '<div id="bt-cmp-detail"></div>';
        results.innerHTML = html;
        setupFlexTable(results.querySelector(".bt-cmp-table"), CMP_COLS, "cmp");
        var detail = document.getElementById("bt-cmp-detail");
        var rowsEls = Array.from(results.querySelectorAll(".bt-cmp-row"));
        function select(idx) {
          rowsEls.forEach(function (x) { x.classList.remove("bt-stock-sel"); });
          var tr = rowsEls[idx];
          if (!tr) { detail.innerHTML = ""; return; }
          tr.classList.add("bt-stock-sel");
          var ps = perStrat[idx];
          detail.innerHTML = '<h3 class="bt-roll-detail-title">' + esc(ps.name) + ' の銘柄別結果</h3><div class="bt-cmp-stocks"></div>';
          renderStockResults(detail.querySelector(".bt-cmp-stocks"), ps.entries, { tradesHtml: function (entry) { return mergedTradesHtml(entry.title); } });
        }
        rowsEls.forEach(function (tr) {
          tr.addEventListener("click", function () { select(parseInt(tr.dataset.cmpIdx, 10)); });
        });
        if (perStrat.length) select(0);
        runBtn.disabled = false;
      }).catch(function () {
        results.innerHTML = '<p class="bt-res-note">比較の実行中にエラーが発生しました。銘柄コードと期間を確認してください。</p>';
        runBtn.disabled = false;
      });
    }
    // ---- All-patterns run: every on/off x parameter combination of the
    // checked buy/sell items (full cross product, GRW 2026-11-23). Screening
    // stays fixed at the current checks; items the engine cannot judge are
    // left out. Results are a sortable ranking table with per-stock detail.
    var PARAM_KEY = { rsiGe: "rsiBuy", bounce: "bounceSigma", dd: "dd", ma50: "maSellDays", loss8: "lossPct", dropPct: "dropSell", high25: "highPct", ddGe: "ddSell", rsiLe: "rsiSell" };
    function runAllPatterns() {
      var runAllBtn = document.getElementById("bt-run-all");
      var minTrades = parseInt(((document.getElementById("bt-min-trades") || {}).value || "0"), 10) || 0;
      var symbolsRaw = (document.getElementById("bt-symbols") || {}).value || "";
      var codes = symbolsRaw.split(/[\s,、，]+/).map(function (x) { return x.trim(); }).filter(Boolean)
        .map(function (x) { return MARKET === "us" ? x.toUpperCase() : x.replace(/\.T$/i, ""); });
      codes = Array.from(new Set(codes)).slice(0, 200);
      var etfCodes = Array.from(panel.querySelectorAll('input[data-bt-etf]:checked')).map(function (b) { return b.value; });
      etfCodes.forEach(function (c) { if (!codes.includes(c)) codes.push(c); });
      var indexKeys = Array.from(panel.querySelectorAll('input[data-bt-index]:checked')).map(function (b) { return b.value; });
      if (!codes.length && !indexKeys.length) {
        results.innerHTML = MARKET === "us"
          ? '<p class="bt-res-note">ティッカーを入力するか、指数・ETFを選んでから実行してください。</p>'
          : '<p class="bt-res-note">銘柄コードを入力するか、指数・ETFを選んでから実行してください。</p>';
        return;
      }
      function dimsFor(kind) {
        var dims = [];
        panel.querySelectorAll('input[type="checkbox"][data-bt="' + kind + '"]:checked').forEach(function (b) {
          var id = b.value;
          if (kind === "buy" && !(BUY_EVALUABLE[id] || id === "dd")) return;
          if (kind === "sell" && !SELL_EVALUABLE[id]) return;
          var label = b.closest("label");
          var sel = label ? label.querySelector("select[data-bt-num]") : null;
          var states = [null];
          if (sel) Array.from(sel.options).forEach(function (o) { states.push(o.value); });
          else states.push("on");
          dims.push({ kind: kind, id: id, key: sel ? sel.getAttribute("data-bt-num") : null, states: states });
        });
        return dims;
      }
      var dims = dimsFor("buy").concat(dimsFor("sell"));
      if (!dims.length) {
        results.innerHTML = '<p class="bt-res-note">パターンを作れる項目がチェックされていません（判定できる買い・売り条件を1つ以上チェックしてください）。</p>';
        return;
      }
      var patterns = [{ buy: [], sell: [], nums: {}, st: [] }];
      dims.forEach(function (dim) {
        var next = [];
        patterns.forEach(function (p) {
          dim.states.forEach(function (st, si) {
            var q = { buy: p.buy.slice(), sell: p.sell.slice(), nums: Object.assign({}, p.nums), st: p.st.concat([si]) };
            if (st !== null) {
              q[dim.kind].push(dim.id);
              if (dim.key) q.nums[dim.key] = st;
            }
            next.push(q);
          });
        });
        patterns = next;
      });
      var screenChecked = checked("screen");
      function patLabel(kind, id, nums) {
        if (id === "ddGe") return "DD（売り抜け日）が" + (nums.ddSell != null ? nums.ddSell : "5") + "以上（直近25取引日）";
        if (id === "dd") return "DD（売り抜け日）が" + (nums.dd != null ? nums.dd : "5") + "以下（直近25取引日）";
        var lab = (kind === "sell" ? SELL_LABELS : BUY_LABELS)[id] || id;
        var key = PARAM_KEY[id];
        if (key && nums[key] != null) lab = lab.replace("閾値", nums[key]);
        return lab;
      }
      patterns.forEach(function (p) {
        var bl = p.buy.map(function (id) { return patLabel("buy", id, p.nums); });
        var sl = p.sell.map(function (id) { return patLabel("sell", id, p.nums); });
        p.label = "買い：" + (bl.join("、") || "（なし）") + " ／ 売り：" + (sl.join("、") || "（なし）");
        p.cfg = stratCfg({ screen: screenChecked, buy: p.buy, sell: p.sell, nums: p.nums, reentry: slotsApi.activeReentry() }, null);
      });
      var normDate = function (v) { var d = String(v || "").replace(/\D/g, ""); return d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : ""; };
      var fromVal = normDate((document.getElementById("bt-from") || {}).value);
      var toVal = normDate((document.getElementById("bt-to") || {}).value);
      var periodYears = parseInt((document.getElementById("bt-period") || {}).value || "3", 10);
      var isRolling = ((document.getElementById("bt-mode") || {}).value || "normal") === "rolling";
      if (isRolling && !fromVal) {
        results.innerHTML = '<p class="bt-res-note">開始日を入力してください（ローリングで開始日をずらす範囲の初日です）。</p>';
        return;
      }
      runBtn.disabled = true;
      if (runAllBtn) runAllBtn.disabled = true;
      results.innerHTML = '<p class="bt-res-note">全パターンを実行中…（' + patterns.length.toLocaleString("ja-JP") + '通り）</p>';
      function windowed(title, rows) {
        if (!rows || !rows.length) return { title: title, rows: null, noData: "日足データがまだありません。自動更新で蓄積されてから実行できます。" };
        if (isRolling) return { title: title, rows: rows };
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
          return { title: title, rows: null, noData: "指定期間のデータがありません（保有データ：" + rows[0][0] + " 〜 " + lastDate + "）。" };
        }
        return { title: title, rows: rows, fromIdx: fromIdx, toIdx: toIdx };
      }
      // ---- Rolling variant of the all-patterns sweep (GRW 2026-11-23):
      // every pattern runs on every start date with the bt-roll-horizon
      // window, then results are aggregated across start dates (each start
      // date first averaged across targets, like runRolling). Per-date
      // entries are not kept in memory; a start date's per-stock results
      // are recomputed on demand when its row is clicked.
      function startRollAll(rawTargets) {
        var horizon = parseInt((document.getElementById("bt-roll-horizon") || {}).value || "21", 10);
        var rollTo = toVal || fromVal;
        var validTargets = rawTargets.filter(function (t) { return t.rows; });
        if (!validTargets.length) {
          results.innerHTML = '<p class="bt-res-note">対象銘柄のデータがありませんでした。</p>';
          runBtn.disabled = false;
          if (runAllBtn) runAllBtn.disabled = false;
          return;
        }
        // Start-date grid: the union of the targets' sessions inside
        // [from, to], exactly like runRolling with fixed codes. A start
        // date is valid for a target when fromIdx (the first session on
        // or after the date) exists and the window end, fromIdx +
        // horizon - 1 clipped at the last session, is after fromIdx —
        // the same window-end handling as runRolling.
        var gridSet = new Set();
        validTargets.forEach(function (t) {
          t.rows.forEach(function (r) { if (r[0] >= fromVal && r[0] <= rollTo) gridSet.add(r[0]); });
        });
        var dateStrs = Array.from(gridSet).sort();
        var ptrs = validTargets.map(function () { return 0; });
        var rollDates = [];
        dateStrs.forEach(function (d) {
          var wins = [];
          validTargets.forEach(function (t, ti) {
            var rows = t.rows;
            var idx = ptrs[ti];
            while (idx < rows.length && rows[idx][0] < d) idx++;
            ptrs[ti] = idx;
            if (idx >= rows.length) return;
            var toIdx = Math.min(rows.length - 1, idx + horizon - 1);
            if (toIdx <= idx) return;
            wins.push({ t: ti, fromIdx: idx, toIdx: toIdx });
          });
          if (wins.length) rollDates.push({ date: d, wins: wins });
        });
        if (!rollDates.length) {
          results.innerHTML = '<p class="bt-res-note">指定範囲に対象銘柄の価格データがありません。期間を広げてください。</p>';
          runBtn.disabled = false;
          if (runAllBtn) runAllBtn.disabled = false;
          return;
        }
        var totalRuns = patterns.length * rollDates.length * validTargets.length;
        if (totalRuns > 10000000) {
          results.innerHTML = '<p class="bt-res-note">対象が多すぎます（' + patterns.length.toLocaleString("ja-JP") + '通り × ' + rollDates.length.toLocaleString("ja-JP") + '開始日 × ' + validTargets.length.toLocaleString("ja-JP") + '銘柄 ＝ 約' + Math.round(totalRuns / 10000) + '万回の計算）。チェックする項目を減らすか、開始日の範囲を狭めてください。</p>';
          runBtn.disabled = false;
          if (runAllBtn) runAllBtn.disabled = false;
          return;
        }
        function rollEntries(p, rd) {
          return rd.wins.map(function (w) {
            var t = validTargets[w.t];
            return { title: t.title, out: runBacktest(t.rows, Object.assign({ fromIdx: w.fromIdx, toIdx: w.toIdx }, p.cfg)) };
          });
        }
        function statOf(entries) {
          var a = aggregate(entries);
          if (!a) return null;
          return { n: a.n, ret: a.ret, bh: a.bh, closed: a.closed, open: a.open, winRate: a.winRate, maxDd: a.maxDd, sharpe: a.sharpe, bhMaxDd: a.bhMaxDd, bhSharpe: a.bhSharpe };
        }
        function meanOf(vals) { return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null; }
        function medianOf(vals) {
          if (!vals.length) return null;
          var s = vals.slice().sort(function (a, b) { return a - b; });
          return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
        }
        function aggOf(stats, retKey, ddKey, shKey) {
          var rets = stats.map(function (s) { return s[retKey]; });
          return {
            ret: meanOf(rets), median: medianOf(rets),
            winRate: rets.length ? rets.filter(function (v) { return v > 0; }).length / rets.length : null,
            worst: rets.length ? Math.min.apply(null, rets) : null,
            best: rets.length ? Math.max.apply(null, rets) : null,
            maxDd: meanOf(stats.map(function (s) { return s[ddKey]; })),
            sharpe: meanOf(stats.map(function (s) { return s[shKey]; }).filter(function (v) { return v != null; })),
            avgHold: meanOf(stats.map(function (s) { return s.avgHold; }).filter(function (v) { return v != null; }))
          };
        }
        var totalPairs = patterns.length * rollDates.length;
        var pairDone = 0;
        var cancelled = false;
        var CHUNK_PAIRS = 120;
        function stepRoll() {
          if (cancelled) {
            results.innerHTML = '<p class="bt-res-note">中止しました。</p>';
            runBtn.disabled = false;
            if (runAllBtn) runAllBtn.disabled = false;
            return;
          }
          var upto = Math.min(totalPairs, pairDone + CHUNK_PAIRS);
          while (pairDone < upto) {
            var pi = Math.floor(pairDone / rollDates.length);
            var di = pairDone - pi * rollDates.length;
            var p = patterns[pi];
            if (!p.rollStats) p.rollStats = [];
            p.rollStats[di] = statOf(rollEntries(p, rollDates[di]));
            pairDone++;
          }
          if (pairDone < totalPairs) {
            results.innerHTML = '<p class="bt-res-note">全パターン（ローリング）を実行中…（' + pairDone.toLocaleString("ja-JP") + ' / ' + totalPairs.toLocaleString("ja-JP") + '組） <button type="button" class="bt-all-cancel">中止</button></p>';
            var cb = results.querySelector(".bt-all-cancel");
            if (cb) cb.addEventListener("click", function () { cancelled = true; });
            setTimeout(stepRoll, 0);
          } else {
            finishRoll();
          }
        }
        function finishRoll() {
          patterns.forEach(function (p) {
            var stats = (p.rollStats || []).filter(Boolean);
            var a = aggOf(stats, "ret", "maxDd", "sharpe");
            a.closed = meanOf(stats.map(function (s) { return s.closed; }));
            p.rollAgg = a;
          });
          var bhStats = patterns.length && patterns[0].rollStats ? patterns[0].rollStats.filter(Boolean) : [];
          renderRollAll(aggOf(bhStats, "bh", "bhMaxDd", "bhSharpe"));
        }
        function renderRollAll(bhAgg) {
          var ddTxt = function (v) { return v == null ? "—" : v > 0 ? "-" + (v * 100).toFixed(2) + "%" : "0.00%"; };
          var AXIS_LABEL = { rsiGe: "買いRSI", bounce: "前日下落σ", dd: "DD以下", vol15: "出来高条件", ftd: "FTD", ma50: "MA日数", loss8: "買値から%", dropPct: "前日終値から%", highPct: "52週高値から%", ddGe: "DD以上", rsiLe: "売りRSI" };
          function heatHtml() {
            if (dims.length < 1 || dims.length > 2) return "";
            var dA = dims[0], dB = dims.length === 2 ? dims[1] : null;
            var grid = {};
            var maxAbs = 0;
            patterns.forEach(function (p) {
              if (!p.rollAgg || p.rollAgg.ret == null || (minTrades > 0 && (p.rollAgg.closed || 0) < minTrades)) return;
              grid[p.st[0] + "," + (dB ? p.st[1] : 0)] = p;
              if (Math.abs(p.rollAgg.ret) > maxAbs) maxAbs = Math.abs(p.rollAgg.ret);
            });
            if (!Object.keys(grid).length) return "";
            var stateTxt = function (dim, si) { var v = dim.states[si]; return v === null ? "なし" : v === "on" ? "あり" : v; };
            var hh = '<table class="bt-sweep-matrix bt-all-matrix"><thead><tr><th>' + esc(AXIS_LABEL[dA.id] || dA.id) + (dB ? " ＼ " + esc(AXIS_LABEL[dB.id] || dB.id) : "") + "</th>";
            var bStates = dB ? dB.states : ["on"];
            bStates.forEach(function (_, bi) { hh += "<th>" + esc(dB ? stateTxt(dB, bi) : "結果") + "</th>"; });
            hh += "</tr></thead><tbody>";
            dA.states.forEach(function (_, ai) {
              hh += "<tr><th>" + esc(stateTxt(dA, ai)) + "</th>";
              bStates.forEach(function (_, bi) {
                var p = grid[ai + "," + bi];
                if (!p || !p.rollAgg || p.rollAgg.ret == null) { hh += '<td class="na">—</td>'; return; }
                var r = p.rollAgg.ret;
                var alpha = maxAbs > 0 ? Math.min(0.85, Math.abs(r) / maxAbs * 0.85) : 0;
                var bg = r > 0 ? "background:rgba(22,163,74," + alpha.toFixed(2) + ")" : r < 0 ? "background:rgba(220,38,38," + alpha.toFixed(2) + ")" : "";
                var title = "プラスの開始日 " + (p.rollAgg.winRate == null ? "—" : (p.rollAgg.winRate * 100).toFixed(0) + "%") + " / 平均取引 " + (p.rollAgg.closed == null ? "—" : p.rollAgg.closed.toFixed(1)) + "回";
                hh += '<td data-ai="' + ai + '" data-bi="' + bi + '" style="' + bg + '" title="' + esc(title) + '">' + (r * 100).toFixed(1) + "%</td>";
              });
              hh += "</tr>";
            });
            hh += "</tbody></table>";
            return hh;
          }
          var targetNames = rawTargets.map(function (t) { return t.title; });
          var exclN = minTrades > 0 ? patterns.filter(function (p) { return p.rollAgg && (p.rollAgg.closed || 0) < minTrades; }).length : 0;
          var html = '<p class="bt-res-note">全パターン検証（ローリング） ' + patterns.length.toLocaleString("ja-JP") + '通り × ' + rollDates.length.toLocaleString("ja-JP") + '開始日 / 銘柄：' + targetNames.join("、") + '<br>開始日を1営業日ずつずらし、各回' + horizon + '営業日で全パターンを実行しました。値は開始日ごとの結果（対象銘柄の平均）を開始日間で集計したものです。勝率は平均リターンがプラスだった開始日の割合です（スクリーニングは今の設定で固定、判定できない項目は除きます）。</p>';
          if (exclN > 0) html += '<p class="bt-res-note">平均取引回数' + minTrades + '回未満の' + exclN + '件を除外しています。</p>';
          html += heatHtml();
          html += '<table class="bt-res-table bt-rollall-table"><thead><tr>'
            + '<th data-k="no">番号</th><th data-k="label">パターン</th><th data-k="ret">平均</th><th data-k="median">中央値</th><th data-k="winRate">勝率</th><th data-k="best">最大</th><th data-k="worst">最小</th><th data-k="closed">取引回数</th><th data-k="maxDd">最大DD</th><th data-k="avgHold">平均保有</th><th data-k="sharpe">シャープ</th>'
            + '</tr></thead><tbody></tbody></table>';
          html += '<p class="bt-res-note">判定は終値、売買は翌営業日の始値です。手数料・税金は含みません。取引回数は開始日ごとの平均です。行を選ぶと、そのパターンの開始日別結果を表示します。</p>';
          html += '<div id="bt-all-detail"></div>';
          results.innerHTML = html;
          var tbody = results.querySelector(".bt-rollall-table tbody");
          var flex = setupFlexTable(results.querySelector(".bt-rollall-table"), ["no", "label", "ret", "median", "winRate", "best", "worst", "closed", "maxDd", "avgHold", "sharpe"], "allroll");
          var sortKey = "sharpe", sortDir = -1;
          var CAP = 300;
          function rowHtml(p, i) {
            var a = p.rollAgg;
            if (!a || a.ret == null) return '<tr class="bt-all-row"><td>' + (i + 1) + '</td><td class="bt-pat-label" title="' + esc(p.label) + '" style="text-align:left">' + esc(p.label) + '</td><td colspan="7" style="text-align:left">データがありませんでした</td></tr>';
            return '<tr class="bt-all-row"><td>' + (i + 1) + '</td><td class="bt-pat-label" title="' + esc(p.label) + '" style="text-align:left">' + esc(p.label) + "</td><td>" + pct(a.ret) + "</td><td>" + pct(a.median) + "</td><td>"
              + (a.winRate == null ? "—" : pct(a.winRate, 0)) + "</td><td>" + pct(a.best) + "</td><td>" + pct(a.worst) + "</td><td>" + (a.closed == null ? "—" : a.closed.toFixed(1)) + "</td><td>" + ddTxt(a.maxDd) + "</td><td>" + (a.avgHold == null ? "—" : a.avgHold.toFixed(0) + "日") + "</td><td>" + sharpeTxt(a.sharpe) + "</td></tr>";
          }
          function renderRows() {
            var arr = patterns.slice().sort(function (x, y) {
              if (sortKey === "label") return x.label < y.label ? sortDir : x.label > y.label ? -sortDir : 0;
              var xv = x.rollAgg ? x.rollAgg[sortKey] : null;
              var yv = y.rollAgg ? y.rollAgg[sortKey] : null;
              if (xv == null && yv == null) return 0;
              if (xv == null) return 1;
              if (yv == null) return -1;
              return (xv - yv) * sortDir;
            });
            var arrF = arr.filter(function (p) { return minTrades <= 0 || !p.rollAgg || (p.rollAgg.closed || 0) >= minTrades; });
            var shown = arrF.slice(0, CAP);
            var bhRow = bhAgg && bhAgg.ret != null ? '<tr class="bt-bh-row"><td>—</td><td style="text-align:left">買い持ち</td><td>' + pct(bhAgg.ret) + "</td><td>" + pct(bhAgg.median) + "</td><td>" + (bhAgg.winRate == null ? "—" : pct(bhAgg.winRate, 0)) + "</td><td>" + pct(bhAgg.best) + "</td><td>" + pct(bhAgg.worst) + "</td><td>—</td><td>" + ddTxt(bhAgg.maxDd) + "</td><td>—</td><td>" + sharpeTxt(bhAgg.sharpe) + "</td></tr>" : "";
            tbody.innerHTML = bhRow + shown.map(function (p, i) { return rowHtml(p, i); }).join("") + (arrF.length > CAP ? '<tr><td colspan="9" style="text-align:left">上位' + CAP + '件を表示しています（全' + arrF.length.toLocaleString("ja-JP") + '通り）。並び替えると上位が入れ替わります。</td></tr>' : "");
            if (flex) flex.restamp();
            tbody.querySelectorAll(".bt-all-row").forEach(function (tr, i) {
              tr.addEventListener("click", function () { selectRollPattern(shown[i]); });
            });
            results.querySelectorAll(".bt-rollall-table th").forEach(function (th) {
              var labels = { no: "番号", label: "パターン", ret: "平均", median: "中央値", winRate: "勝率", best: "最大", worst: "最小", closed: "取引回数", maxDd: "最大DD", avgHold: "平均保有", sharpe: "シャープ" };
              var base = labels[th.getAttribute("data-k")] || th.textContent.replace(/[▲▼]/g, "");
              setThLabel(th, th.getAttribute("data-k") === sortKey ? base + (sortDir < 0 ? "▼" : "▲") : base);
            });
          }
          var downXY = null;
          results.querySelector(".bt-rollall-table").addEventListener("pointerdown", function (e) { downXY = [e.clientX, e.clientY]; }, true);
          results.querySelectorAll(".bt-rollall-table th").forEach(function (th) {
            th.addEventListener("click", function (e) {
              if (downXY && Math.abs(e.clientX - downXY[0]) + Math.abs(e.clientY - downXY[1]) > 5) return;
              var k = th.getAttribute("data-k");
              if (k === "no") return;
              if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === "label" ? 1 : -1; }
              renderRows();
            });
          });
          function selectRollPattern(p) {
            tbody.querySelectorAll(".bt-all-row").forEach(function (r) { r.classList.remove("sel"); });
            var detail = document.getElementById("bt-all-detail");
            var html = '<h3 class="bt-roll-detail-title">' + esc(p.label) + ' の開始日別結果</h3>';
            html += '<table class="bt-res-table bt-rollall-dates"><thead><tr><th>開始日</th><th>対象銘柄数</th><th>リターン</th><th>買い持ち</th><th>取引回数</th><th>勝率</th><th>最大DD</th><th>平均保有</th><th>シャープ</th></tr></thead><tbody>';
            rollDates.forEach(function (rd, di) {
              var s = p.rollStats && p.rollStats[di];
              if (!s) { html += '<tr class="bt-rollall-date-row" data-roll-di="' + di + '"><td>' + rd.date + '</td><td colspan="8" style="text-align:left">データがありませんでした</td></tr>'; return; }
              html += '<tr class="bt-rollall-date-row" data-roll-di="' + di + '"><td>' + rd.date + '</td><td>' + s.n + '</td><td>' + pct(s.ret) + '</td><td>' + pct(s.bh) + '</td><td>' + s.closed + (s.open ? "（+保有中" + s.open + "）" : "") + '</td><td>' + (s.winRate == null ? "—" : pct(s.winRate, 0)) + '</td><td>' + ddTxt(s.maxDd) + '</td><td>' + (s.avgHold == null ? "—" : s.avgHold.toFixed(0) + "日") + '</td><td>' + sharpeTxt(s.sharpe) + '</td></tr>';
            });
            html += '</tbody></table>';
            html += '<p class="bt-res-note">開始日の行を選ぶと、その開始日の銘柄別結果を表示します。</p>';
            html += '<div class="bt-rollall-stocks"></div>';
            detail.innerHTML = html;
            setupFlexTable(detail.querySelector(".bt-rollall-dates"), ["start", "n", "ret", "bh", "count", "win", "maxdd", "avgHold", "sharpe"], "allrolldates");
            var stocks = detail.querySelector(".bt-rollall-stocks");
            detail.querySelectorAll(".bt-rollall-date-row").forEach(function (tr) {
              tr.addEventListener("click", function () {
                detail.querySelectorAll(".bt-rollall-date-row").forEach(function (x) { x.classList.remove("bt-roll-sel"); });
                tr.classList.add("bt-roll-sel");
                var di = parseInt(tr.getAttribute("data-roll-di"), 10);
                stocks.innerHTML = '<h3 class="bt-roll-detail-title">' + esc(rollDates[di].date) + ' 開始の銘柄別結果</h3><div class="bt-rollall-stocks-in"></div>';
                renderStockResults(stocks.querySelector(".bt-rollall-stocks-in"), rollEntries(p, rollDates[di]));
              });
            });
          }
          results.querySelector(".bt-rollall-table").addEventListener("click", function (e) {
            var tr = e.target.closest(".bt-all-row");
            if (tr) tr.classList.add("sel");
          });
          var matrix = results.querySelector(".bt-all-matrix");
          if (matrix) {
            var bestP = null, bestKey = null;
            patterns.forEach(function (p) { if (p.rollAgg && p.rollAgg.ret != null && (!bestP || p.rollAgg.ret > bestP.rollAgg.ret)) { bestP = p; bestKey = p.st[0] + "," + (dims.length === 2 ? p.st[1] : 0); } });
            matrix.querySelectorAll("td[data-ai]").forEach(function (td) {
              var key = td.getAttribute("data-ai") + "," + td.getAttribute("data-bi");
              if (key === bestKey) td.classList.add("best");
              td.addEventListener("click", function () {
                matrix.querySelectorAll("td").forEach(function (x) { x.classList.remove("sel"); });
                td.classList.add("sel");
                var found = null;
                patterns.forEach(function (p) { if ((p.st[0] + "," + (dims.length === 2 ? p.st[1] : 0)) === key) found = p; });
                if (found) selectRollPattern(found);
              });
            });
          }
          renderRows();
          runBtn.disabled = false;
          if (runAllBtn) runAllBtn.disabled = false;
        }
        setTimeout(stepRoll, 0);
      }
      loadJson("sector-leaders.json").catch(function () { return null; }).then(function (leaders) {
        var names = buildNames(leaders);
        var jobs = codes.map(function (code) {
          return loadJson(ohlcvUrl(code)).then(function (data) {
            var nm = names[code] || ETF_NAMES[code] || "";
            return windowed(esc(code) + (nm ? " " + esc(nm) : ""), (data && data.rows) || []);
          }).catch(function () {
            var nm = names[code] || ETF_NAMES[code] || "";
            return { title: esc(code) + (nm ? " " + esc(nm) : ""), rows: null, noData: "日足データがまだありません。自動更新で蓄積されてから実行できます。" };
          });
        });
        return Promise.all(jobs).then(function (targets) { return targets; });
      }).then(function (targets) {
        if (!indexKeys.length) return targets;
        var endYear = toVal ? +toVal.slice(0, 4) : new Date().getFullYear();
        var startYear = fromVal ? +fromVal.slice(0, 4) : endYear - periodYears;
        var years = [];
        for (var iy = startYear - 1; iy <= endYear; iy++) years.push(iy);
        var jobs = years.map(function (y) { return loadJson("history-" + y + ".json").catch(function () { return null; }); });
        return Promise.all(jobs).then(function (files) {
          var byKey = {};
          indexKeys.forEach(function (k) { byKey[k] = new Map(); });
          files.forEach(function (h) {
            if (!h) return;
            (MARKET === "us" ? (h.rows || []) : (h.tse_rows || [])).forEach(function (row) {
              indexKeys.forEach(function (k) {
                var cell = row[k];
                if (cell && cell.close != null) {
                  var vol = cell.volume_value > 0 ? cell.volume_value : (cell.shares_10000 || 0);
                  byKey[k].set(row.date, [row.date, cell.close, cell.close, cell.close, cell.close, vol]);
                }
              });
            });
          });
          indexKeys.forEach(function (k) {
            var rows = Array.from(byKey[k].values()).sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
            targets.push(windowed(esc(INDEX_LABELS[k] || k) + "（指数）", rows));
          });
          return targets;
        });
      }).then(function (targets) {
        if (isRolling) { startRollAll(targets); return; }
        var validTargets = targets.filter(function (t) { return t.rows; });
        if (!validTargets.length) {
          results.innerHTML = '<p class="bt-res-note">対象銘柄のデータがありませんでした。</p>';
          runBtn.disabled = false;
          if (runAllBtn) runAllBtn.disabled = false;
          return;
        }
        if (patterns.length * validTargets.length > 10000000) {
          results.innerHTML = '<p class="bt-res-note">対象が多すぎます（' + patterns.length.toLocaleString("ja-JP") + '通り × ' + validTargets.length + '銘柄 ＝ 約' + Math.round(patterns.length * validTargets.length / 10000) + '万回の計算）。チェックする項目を減らすか、銘柄を絞ってください。</p>';
          runBtn.disabled = false;
          if (runAllBtn) runAllBtn.disabled = false;
          return;
        }
        function patEntries(p) {
          return targets.map(function (t) {
            return t.rows ? { title: t.title, out: runBacktest(t.rows, Object.assign({ fromIdx: t.fromIdx, toIdx: t.toIdx }, p.cfg)) } : { title: t.title, out: null, noData: t.noData };
          });
        }
        var done = 0;
        var cancelled = false;
        var CHUNK = 100;
        function step() {
          if (cancelled) {
            results.innerHTML = '<p class="bt-res-note">中止しました。</p>';
            runBtn.disabled = false;
            if (runAllBtn) runAllBtn.disabled = false;
            return;
          }
          var upto = Math.min(patterns.length, done + CHUNK);
          for (var i = done; i < upto; i++) patterns[i].agg = aggregate(patEntries(patterns[i]));
          done = upto;
          if (done < patterns.length) {
            results.innerHTML = '<p class="bt-res-note">全パターンを実行中…（' + done.toLocaleString("ja-JP") + ' / ' + patterns.length.toLocaleString("ja-JP") + '通り） <button type="button" class="bt-all-cancel">中止</button></p>';
            var cb2 = results.querySelector(".bt-all-cancel");
            if (cb2) cb2.addEventListener("click", function () { cancelled = true; });
            setTimeout(step, 0);
          } else {
            renderAll();
          }
        }
        function renderAll() {
          var ddTxt = function (v) { return v > 0 ? "-" + (v * 100).toFixed(2) + "%" : "0.00%"; };
          var AXIS_LABEL = { rsiGe: "買いRSI", bounce: "前日下落σ", dd: "DD以下", vol15: "出来高条件", ftd: "FTD", ma50: "MA日数", loss8: "買値から%", dropPct: "前日終値から%", highPct: "52週高値から%", ddGe: "DD以上", rsiLe: "売りRSI" };
          function heatHtml() {
            if (dims.length < 1 || dims.length > 2) return "";
            var dA = dims[0], dB = dims.length === 2 ? dims[1] : null;
            var grid = {};
            var maxAbs = 0;
            patterns.forEach(function (p) {
              if (!p.agg || (minTrades > 0 && (p.agg.closed || 0) < minTrades)) return;
              grid[p.st[0] + "," + (dB ? p.st[1] : 0)] = p;
              if (Math.abs(p.agg.ret) > maxAbs) maxAbs = Math.abs(p.agg.ret);
            });
            if (!Object.keys(grid).length) return "";
            var stateTxt = function (dim, si) { var v = dim.states[si]; return v === null ? "なし" : v === "on" ? "あり" : v; };
            var hh = '<table class="bt-sweep-matrix bt-all-matrix"><thead><tr><th>' + esc(AXIS_LABEL[dA.id] || dA.id) + (dB ? " ＼ " + esc(AXIS_LABEL[dB.id] || dB.id) : "") + "</th>";
            var bStates = dB ? dB.states : ["on"];
            bStates.forEach(function (_, bi) { hh += "<th>" + esc(dB ? stateTxt(dB, bi) : "結果") + "</th>"; });
            hh += "</tr></thead><tbody>";
            dA.states.forEach(function (_, ai) {
              hh += "<tr><th>" + esc(stateTxt(dA, ai)) + "</th>";
              bStates.forEach(function (_, bi) {
                var p = grid[ai + "," + bi];
                if (!p || !p.agg) { hh += '<td class="na">—</td>'; return; }
                var r = p.agg.ret;
                var alpha = maxAbs > 0 ? Math.min(0.85, Math.abs(r) / maxAbs * 0.85) : 0;
                var bg = r > 0 ? "background:rgba(22,163,74," + alpha.toFixed(2) + ")" : r < 0 ? "background:rgba(220,38,38," + alpha.toFixed(2) + ")" : "";
                var title = "勝率 " + (p.agg.winRate == null ? "—" : (p.agg.winRate * 100).toFixed(0) + "%") + " / 取引 " + p.agg.closed + "回";
                hh += '<td data-ai="' + ai + '" data-bi="' + bi + '" style="' + bg + '" title="' + esc(title) + '">' + (r * 100).toFixed(1) + "%</td>";
              });
              hh += "</tr>";
            });
            hh += "</tbody></table>";
            return hh;
          }
          var targetNames = targets.map(function (t) { return t.title; });
          var exclN = minTrades > 0 ? patterns.filter(function (p) { return p.agg && (p.agg.closed || 0) < minTrades; }).length : 0;
          var html = '<p class="bt-res-note">全パターン検証（' + patterns.length.toLocaleString("ja-JP") + '通り） / 銘柄：' + targetNames.join("、") + '<br>チェックした買い・売り項目の ON/OFF とパラメータの全組合せです（スクリーニングは今の設定で固定、判定できない項目は除きます）。' + (targetNames.length > 1 ? '複数銘柄の値は平均です（勝率・平均損益・平均保有は全取引の合算、取引回数は合計）。' : '') + '</p>';
          if (exclN > 0) html += '<p class="bt-res-note">取引回数' + minTrades + '回未満の' + exclN + '件を除外しています。</p>';
          html += heatHtml();
          html += '<table class="bt-res-table bt-all-table"><thead><tr>'
            + '<th data-k="no">番号</th><th data-k="label">パターン</th><th data-k="ret">リターン</th><th data-k="winRate">勝率</th><th data-k="closed">取引回数</th><th data-k="avgRet">平均損益</th><th data-k="maxDd">最大DD</th><th data-k="avgHold">平均保有</th><th data-k="sharpe">シャープ</th>'
            + '</tr></thead><tbody></tbody></table>';
          html += '<p class="bt-res-note">判定は終値、売買は翌営業日の始値です。手数料・税金は含みません。行を選ぶと、そのパターンの銘柄別結果を表示します。</p>';
          html += '<div id="bt-all-detail"></div>';
          results.innerHTML = html;
          var tbody = results.querySelector(".bt-all-table tbody");
          var flex = setupFlexTable(results.querySelector(".bt-all-table"), ["no", "label", "ret", "winRate", "closed", "avgRet", "maxDd", "avgHold", "sharpe"], "all");
          var sortKey = "sharpe", sortDir = -1;
          var CAP = 300;
          function rowHtml(p, i) {
            var a = p.agg;
            if (!a) return '<tr class="bt-all-row"><td>' + (i + 1) + '</td><td class="bt-pat-label" title="' + esc(p.label) + '" style="text-align:left">' + esc(p.label) + '</td><td colspan="7" style="text-align:left">データがありませんでした</td></tr>';
            return '<tr class="bt-all-row"><td>' + (i + 1) + '</td><td class="bt-pat-label" title="' + esc(p.label) + '" style="text-align:left">' + esc(p.label) + "</td><td>" + pct(a.ret) + "</td><td>"
              + (a.winRate == null ? "—" : pct(a.winRate, 0)) + "</td><td>" + a.closed + (a.open ? "（+保有中" + a.open + "）" : "") + "</td><td>"
              + (a.avgRet == null ? "—" : pct(a.avgRet)) + "</td><td>" + ddTxt(a.maxDd) + "</td><td>"
              + (a.avgHold == null ? "—" : a.avgHold.toFixed(0) + "日") + "</td><td>" + sharpeTxt(a.sharpe) + "</td></tr>";
          }
          function renderRows() {
            var arr = patterns.slice().sort(function (x, y) {
              if (sortKey === "label") return x.label < y.label ? sortDir : x.label > y.label ? -sortDir : 0;
              var xv = x.agg ? x.agg[sortKey] : null;
              var yv = y.agg ? y.agg[sortKey] : null;
              if (xv == null && yv == null) return 0;
              if (xv == null) return 1;
              if (yv == null) return -1;
              return (xv - yv) * sortDir;
            });
            var arrF = arr.filter(function (p) { return minTrades <= 0 || !p.agg || (p.agg.closed || 0) >= minTrades; });
            var shown = arrF.slice(0, CAP);
            var bhAgg = null;
            patterns.forEach(function (p) { if (!bhAgg && p.agg) bhAgg = p.agg; });
            var bhRow = bhAgg ? '<tr class="bt-bh-row"><td>—</td><td style="text-align:left">買い持ち</td><td>' + pct(bhAgg.bh) + "</td><td>—</td><td>—</td><td>—</td><td>" + ddTxt(bhAgg.bhMaxDd) + "</td><td>—</td><td>" + sharpeTxt(bhAgg.bhSharpe) + "</td></tr>" : "";
            tbody.innerHTML = bhRow + shown.map(function (p, i) { return rowHtml(p, i); }).join("") + (arrF.length > CAP ? '<tr><td colspan="9" style="text-align:left">上位' + CAP + '件を表示しています（全' + arrF.length.toLocaleString("ja-JP") + '通り）。並び替えると上位が入れ替わります。</td></tr>' : "");
            if (flex) flex.restamp();
            tbody.querySelectorAll(".bt-all-row").forEach(function (tr, i) {
              tr.addEventListener("click", function () { selectPattern(shown[i]); });
            });
            results.querySelectorAll(".bt-all-table th").forEach(function (th) {
              var labels = { no: "番号", label: "パターン", ret: "リターン", winRate: "勝率", closed: "取引回数", avgRet: "平均損益", maxDd: "最大DD", avgHold: "平均保有", sharpe: "シャープ" };
              var base = labels[th.getAttribute("data-k")] || th.textContent.replace(/[▲▼]/g, "");
              setThLabel(th, th.getAttribute("data-k") === sortKey ? base + (sortDir < 0 ? "▼" : "▲") : base);
            });
          }
          var downXY = null;
          results.querySelector(".bt-all-table").addEventListener("pointerdown", function (e) { downXY = [e.clientX, e.clientY]; }, true);
          results.querySelectorAll(".bt-all-table th").forEach(function (th) {
            th.addEventListener("click", function (e) {
              if (downXY && Math.abs(e.clientX - downXY[0]) + Math.abs(e.clientY - downXY[1]) > 5) return;
              var k = th.getAttribute("data-k");
              if (k === "no") return;
              if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === "label" ? 1 : -1; }
              renderRows();
            });
          });
          function selectPattern(p) {
            tbody.querySelectorAll(".bt-all-row").forEach(function (r) { r.classList.remove("sel"); });
            var detail = document.getElementById("bt-all-detail");
            detail.innerHTML = '<h3 class="bt-roll-detail-title">' + esc(p.label) + '</h3><div class="bt-all-stocks"></div>';
            renderStockResults(detail.querySelector(".bt-all-stocks"), patEntries(p));
          }
          results.querySelector(".bt-all-table").addEventListener("click", function (e) {
            var tr = e.target.closest(".bt-all-row");
            if (tr) tr.classList.add("sel");
          });
          var matrix = results.querySelector(".bt-all-matrix");
          if (matrix) {
            var bestP = null, bestKey = null;
            patterns.forEach(function (p) { if (p.agg && (!bestP || p.agg.ret > bestP.agg.ret)) { bestP = p; bestKey = p.st[0] + "," + (dims.length === 2 ? p.st[1] : 0); } });
            matrix.querySelectorAll("td[data-ai]").forEach(function (td) {
              var key = td.getAttribute("data-ai") + "," + td.getAttribute("data-bi");
              if (key === bestKey) td.classList.add("best");
              td.addEventListener("click", function () {
                matrix.querySelectorAll("td").forEach(function (x) { x.classList.remove("sel"); });
                td.classList.add("sel");
                var found = null;
                patterns.forEach(function (p) { if ((p.st[0] + "," + (dims.length === 2 ? p.st[1] : 0)) === key) found = p; });
                if (found) selectPattern(found);
              });
            });
          }
          renderRows();
          var best = patterns.filter(function (p) { return p.agg; }).sort(function (a, b) { return b.agg.ret - a.agg.ret; })[0];
          if (best) selectPattern(best);
          runBtn.disabled = false;
          if (runAllBtn) runAllBtn.disabled = false;
        }
        setTimeout(step, 0);
      }).catch(function () {
        results.innerHTML = '<p class="bt-res-note">実行中にエラーが発生しました。銘柄コードと期間を確認してください。</p>';
        runBtn.disabled = false;
        var b = document.getElementById("bt-run-all");
        if (b) b.disabled = false;
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
