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
    eps25: "EPS増加率（前年同期比）が25%以上",
    roe17: "ROEが17%以上",
    rsiGe: "RSI（14日）が閾値以下",
    vol15: "出来高が20日平均の1.5倍以上",
    maCross: "移動平均クロス（短期MA＞長期MA）", emaCross: "9日EMA＞21日EMA", macdCross: "MACDがシグナル線より上", priceMa: "株価が閾値日移動平均より上",
    bollinger: "終値がボリンジャーバンド下限（20日、−閾値σ）以下",
    breakout: "当日高値が直近閾値日の最高値を上回る",
    bounceClose: "前日にσ以上下落したとき、引け成行で買う",
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
    maCrossDn: "移動平均クロス（短期MA＜長期MA）", emaCrossDn: "9日EMA＜21日EMA", macdCrossDn: "MACDがシグナル線より下",
    bollingerUp: "終値がボリンジャーバンド上限（20日、+閾値σ）以上",
    takeProfit: "買値から閾値%上昇", holdDays: "閾値日保有したら売る", ddGe: "DD（売り抜け日）が5以上（直近25取引日）",
    rsiLe: "RSI（14日）が閾値以上"
  };
  var BUY_EVALUABLE = { vol15: 1, tt1: 1, tt2: 1, tt3: 1, tt4: 1, tt5: 1, tt6: 1, tt7: 1, rsiGe: 1, bounceClose: 1, maCross: 1, emaCross: 1, macdCross: 1, priceMa: 1, bollinger: 1, breakout: 1, ftd: 1 };
  var SELL_EVALUABLE = { ma50: 1, loss8: 1, high25: 1, rsiLe: 1, dropPct: 1, ddGe: 1, maCrossDn: 1, emaCrossDn: 1, macdCrossDn: 1, bollingerUp: 1, takeProfit: 1, holdDays: 1 };

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
      var ma20 = [], ma50 = [], ma150 = [], ma200 = [], ma200Prev = [];
      function emaArr(period) {
        var out = [], k = 2 / (period + 1), e = null;
        for (var j = 0; j < n; j++) {
          if (j === period - 1) { var sum = 0; for (var q = 0; q < period; q++) sum += closes[q]; e = sum / period; }
          else if (j >= period) e = closes[j] * k + e * (1 - k);
          out.push(j >= period - 1 ? e : null);
        }
        return out;
      }
      var ema9 = emaArr(9), ema21 = emaArr(21);
      var ema12 = emaArr(12), ema26 = emaArr(26);
      // MACD (12/26) and its signal line (EMA9 of MACD, SMA-seeded).
      var macd = [], macdSig = [];
      (function () {
        var k = 2 / 10, sig = null, cnt = 0, seedSum = 0;
        for (var j = 0; j < n; j++) {
          var m = (ema12[j] != null && ema26[j] != null) ? ema12[j] - ema26[j] : null;
          macd.push(m);
          if (m == null) { macdSig.push(null); continue; }
          cnt++; seedSum += m;
          if (sig === null) {
            if (cnt < 9) { macdSig.push(null); continue; }
            sig = seedSum / 9; macdSig.push(sig); continue;
          }
          sig = m * k + sig * (1 - k); macdSig.push(sig);
        }
      })();
      function smaSeries(period) { var out = []; for (var sj = 0; sj < n; sj++) out.push(sma(closes, sj, period)); return out; }
      for (var i = 0; i < n; i++) {
        ma20.push(sma(closes, i, 20));
        ma50.push(sma(closes, i, 50));
        ma150.push(sma(closes, i, 150));
        ma200.push(sma(closes, i, 200));
        ma200Prev.push(i >= 21 ? sma(closes, i - 21, 200) : null);
      }
      var smaBy = { 5: smaSeries(5), 10: smaSeries(10), 20: ma20, 25: smaSeries(25), 50: ma50, 75: smaSeries(75), 100: smaSeries(100), 150: ma150, 200: ma200 };
      // Population std of closes over 20 sessions (Bollinger bands).
      var pstd20 = [];
      for (var pi = 0; pi < n; pi++) {
        if (pi < 19 || ma20[pi] == null) { pstd20.push(null); continue; }
        var pv = 0;
        for (var pk = pi - 19; pk <= pi; pk++) { var pd = closes[pk] - ma20[pi]; pv += pd * pd; }
        pstd20.push(Math.sqrt(pv / 20));
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
        ma20: ma20, ema9: ema9, ema21: ema21, ma50: ma50, ma150: ma150, ma200: ma200, ma200Prev: ma200Prev, rsi: rsi,
        ddActive: ddActive, pineFtd: pineFtd, pineWarning: pineWarning, pineWarningStart: pineWarningStart, pineByN: pineByN, sigma20: sigma20, smaBy: smaBy, pstd20: pstd20, macd: macd, macdSig: macdSig };
    }
    if (!per.maSell[maDays]) {
      var ms = [];
      for (var j = 0; j < per.base.closes.length; j++) ms.push(sma(per.base.closes, j, maDays));
      per.maSell[maDays] = ms;
    }
    var b = per.base;
    return { dates: b.dates, opens: b.opens, highs: b.highs, lows: b.lows, closes: b.closes, vols: b.vols,
      ma20: b.ma20, ema9: b.ema9, ema21: b.ema21, ma50: b.ma50, ma150: b.ma150, ma200: b.ma200, ma200Prev: b.ma200Prev, maSell: per.maSell[maDays], rsi: b.rsi,
      ddActive: b.ddActive, pineFtd: b.pineFtd, pineWarning: b.pineWarning, pineWarningStart: b.pineWarningStart, pineByN: b.pineByN, sigma20: b.sigma20, smaBy: b.smaBy, pstd20: b.pstd20, macd: b.macd, macdSig: b.macdSig };
  }

  // Tolerant formula parser: tokens are item ids plus "and" / "or" /
  // "not" / "(" / ")". Leaves the caller does not enable (leafOk false)
  // are pruned, and operators left without an operand collapse away, so
  // the all-patterns sweep can reuse one formula across patterns whose
  // item sets differ. Precedence: not > and > or.
  function parseFormula(tokens, leafOk) {
    var pos = 0;
    function peek() { return tokens[pos]; }
    function combine(op, a, b) { if (!a) return b; if (!b) return a; return { k: op, a: a, b: b }; }
    function parseOr() { var l = parseAnd(); while (peek() === "or") { pos++; l = combine("or", l, parseAnd()); } return l; }
    function parseAnd() { var l = parseUnary(); while (peek() === "and") { pos++; l = combine("and", l, parseUnary()); } return l; }
    function parseUnary() {
      var tk = peek();
      if (tk === "not") { pos++; var x = parseUnary(); return x ? { k: "not", a: x } : null; }
      if (tk === "(") { pos++; var e = parseOr(); if (peek() === ")") pos++; return e; }
      if (tk == null || tk === ")" || tk === "and" || tk === "or") return null;
      pos++;
      return leafOk(tk) ? { k: "item", id: tk } : null;
    }
    return parseOr();
  }
  function evalFormula(node, leafVal) {
    if (!node) return true;
    if (node.k === "item") return !!leafVal(node.id);
    if (node.k === "not") return !evalFormula(node.a, leafVal);
    if (node.k === "and") return evalFormula(node.a, leafVal) && evalFormula(node.b, leafVal);
    return evalFormula(node.a, leafVal) || evalFormula(node.b, leafVal);
  }
  // Default formula reproducing the legacy role grouping: AND items
  // joined by AND, OR items parenthesised and joined by OR, combined by
  // AND. With no AND items the OR items join plainly.
  function buildDefaultFormula(ids, orIds) {
    var andIds = ids.filter(function (id) { return orIds.indexOf(id) < 0; });
    var orOnly = ids.filter(function (id) { return orIds.indexOf(id) >= 0; });
    var out = [];
    andIds.forEach(function (id, i) { if (i) out.push("and"); out.push(id); });
    if (orOnly.length) {
      if (andIds.length) { out.push("and"); if (orOnly.length > 1) out.push("("); }
      orOnly.forEach(function (id, i) { if (i) out.push("or"); out.push(id); });
      if (andIds.length && orOnly.length > 1) out.push(")");
    }
    return out;
  }
  function validateFormula(tokens) {
    if (!tokens.length) return null;
    var pos = 0;
    function expr() { term(); while (tokens[pos] === "or") { pos++; term(); } }
    function term() { factor(); while (tokens[pos] === "and") { pos++; factor(); } }
    function factor() {
      var tk = tokens[pos];
      if (tk === "not") { pos++; factor(); return; }
      if (tk === "(") { pos++; expr(); if (tokens[pos] !== ")") throw new Error("paren"); pos++; return; }
      if (tk == null || tk === ")" || tk === "and" || tk === "or") throw new Error("operand");
      pos++;
    }
    try { expr(); if (pos !== tokens.length) return "式の並びが正しくありません"; } catch (e) { return "式の並びが正しくありません（カッコの対応や演算子の位置を確認してください）"; }
    return null;
  }
  // Drop dangling operators/parens after an item is removed from a formula.
  function normalizeFormula(tokens) {
    var t = tokens.slice(), changed = true, guard = 0;
    while (changed && guard++ < 60) {
      changed = false;
      for (var i = 0; i < t.length; i++) {
        var tk = t[i], prev = t[i - 1], next = t[i + 1], drop = false;
        if ((tk === "and" || tk === "or") && (i === 0 || i === t.length - 1 || prev === "(" || prev === "and" || prev === "or" || prev === "not" || next === ")" || next === "and" || next === "or")) drop = true;
        if (tk === "not" && (next == null || next === ")" || next === "and" || next === "or" || (prev != null && prev !== "(" && prev !== "and" && prev !== "or" && prev !== "not"))) drop = true;
        if (tk === "(" && next === ")") { t.splice(i, 2); changed = true; break; }
        if (tk === ")" && (prev === "(" || prev === "and" || prev === "or")) drop = true;
        if (drop) { t.splice(i, 1); changed = true; break; }
      }
    }
    var bal = 0, out = [];
    t.forEach(function (tk) { if (tk === "(") bal++; if (tk === ")") { if (!bal) return; bal--; } out.push(tk); });
    while (bal > 0) { var ix = out.lastIndexOf("("); if (ix < 0) break; out.splice(ix, 1); bal--; }
    return out;
  }

  function runBacktest(rows, cfg) {
    var ownInd = indicatorsFor(rows, cfg.maDays == null ? 50 : cfg.maDays);
    var ind = cfg.judgeRows ? indicatorsFor(cfg.judgeRows, cfg.maDays == null ? 50 : cfg.maDays) : ownInd;
    // Execution, equity and the loss-from-buy-price check always use the
    // traded instrument's own prices. Every series-derived judgment
    // (indicators, sigma, RSI, volume, highs/lows) uses the judge series
    // when one is supplied (leveraged ETFs are judged on the underlying).
    var dates = ownInd.dates, opens = ownInd.opens, closes = ownInd.closes;
    var pineSel = (cfg.ddSell === 6 || cfg.ddSell === 7) ? cfg.ddSell : 5;
    var jFtd = ind.pineFtd, jWarn = ind.pineWarning;
    if (ind.pineByN && ind.pineByN[pineSel]) { jFtd = ind.pineByN[pineSel].ftd; jWarn = ind.pineByN[pineSel].warning; }
    var ma20, ema9, ema21, ma50, ma150, ma200, ma200Prev, maSell, rsi, ddActive, pineFtd, pineWarning, sigma20, jCloses, jVols, jHighs, jLows;
    var smaS, smaL, smaSDn, smaLDn, macdA, macdSigA, pstdA, pmaA;
    function pickSma(src, p) { return (src.smaBy && src.smaBy[p]) || src.ma20; }
    if (ind === ownInd) {
      ma20 = ind.ma20; ema9 = ind.ema9; ema21 = ind.ema21; ma50 = ind.ma50; ma150 = ind.ma150; ma200 = ind.ma200; ma200Prev = ind.ma200Prev; maSell = ind.maSell;
      rsi = ind.rsi; ddActive = ind.ddActive; pineFtd = jFtd; pineWarning = jWarn; sigma20 = ind.sigma20;
      jCloses = ind.closes; jVols = ind.vols; jHighs = ind.highs; jLows = ind.lows;
      smaS = pickSma(ind, cfg.maShort || 20); smaL = pickSma(ind, cfg.maLong || 50);
      smaSDn = pickSma(ind, cfg.maShortDn || 20); smaLDn = pickSma(ind, cfg.maLongDn || 50);
      macdA = ind.macd; macdSigA = ind.macdSig; pstdA = ind.pstd20; pmaA = pickSma(ind, cfg.priceMaDays || 50);
    } else {
      var jIdx = new Map();
      ind.dates.forEach(function (d, j) { jIdx.set(d, j); });
      var remap = function (arr) { return dates.map(function (d) { var j = jIdx.get(d); return j == null ? null : arr[j]; }); };
      ma20 = remap(ind.ma20); ema9 = remap(ind.ema9); ema21 = remap(ind.ema21); ma50 = remap(ind.ma50); ma150 = remap(ind.ma150); ma200 = remap(ind.ma200); ma200Prev = remap(ind.ma200Prev); maSell = remap(ind.maSell);
      rsi = remap(ind.rsi); ddActive = remap(ind.ddActive); pineFtd = remap(jFtd); pineWarning = remap(jWarn); sigma20 = remap(ind.sigma20);
      jCloses = remap(ind.closes); jVols = remap(ind.vols); jHighs = remap(ind.highs); jLows = remap(ind.lows);
      smaS = remap(pickSma(ind, cfg.maShort || 20)); smaL = remap(pickSma(ind, cfg.maLong || 50));
      smaSDn = remap(pickSma(ind, cfg.maShortDn || 20)); smaLDn = remap(pickSma(ind, cfg.maLongDn || 50));
      macdA = remap(ind.macd); macdSigA = remap(ind.macdSig); pstdA = remap(ind.pstd20); pmaA = remap(pickSma(ind, cfg.priceMaDays || 50));
    }
    var n = rows.length;
    function ddOk(i) {
      return cfg.ddLimit == null || ddActive[i] <= cfg.ddLimit;
    }
    function buyCond(id, i) {
      var c = jCloses[i];
      if (id === "maCross") return smaS[i] != null && smaL[i] != null && smaS[i] > smaL[i];
      if (id === "macdCross") return macdA[i] != null && macdSigA[i] != null && macdA[i] > macdSigA[i];
      if (id === "priceMa") return pmaA[i] != null && c > pmaA[i];
      if (id === "bollinger") return cfg.bollSigma != null && pstdA[i] != null && ma20[i] != null && c <= ma20[i] - cfg.bollSigma * pstdA[i];
      if (id === "breakout") {
        var bn = cfg.breakoutDays || 20, bhi = null;
        if (i < bn) return false;
        for (var bk = i - bn; bk < i; bk++) { if (jHighs[bk] != null && (bhi === null || jHighs[bk] > bhi)) bhi = jHighs[bk]; }
        return bhi !== null && jHighs[i] > bhi;
      }
      if (id === "emaCross") return ema9[i] != null && ema21[i] != null && ema9[i] > ema21[i];
      if (id === "vol15") {
        var avg = sma(jVols, i - 1, 20);
        return avg != null && avg > 0 && jVols[i] >= 1.5 * avg;
      } else if (id === "dd") {
        return cfg.ddLimit == null || ddActive[i] <= cfg.ddLimit;
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
        var lo = extreme(jLows, i, 252, false);
        return lo != null && c >= lo * 1.30;
      } else if (id === "tt7") {
        var hi = extreme(jHighs, i, 252, true);
        return hi != null && c >= hi * 0.75;
      } else if (id === "rsiGe") {
        return cfg.rsiBuy != null && rsi[i] != null && rsi[i] <= cfg.rsiBuy;
      } else if (id === "bounceClose") {
        return cfg.bounceCloseSigma != null && sigma20[i] != null && i > 0 && jCloses[i] <= jCloses[i - 1] * (1 - cfg.bounceCloseSigma * sigma20[i]);
      } else if (id === "ftd") {
        return !!pineFtd[i];
      }
      return true;
    }
    var buyOrSet = cfg.buyOr ? new Set(cfg.buyOr) : null;
    var sellOrSet = cfg.sellOr ? new Set(cfg.sellOr) : null;
    var buyFormulaMode2 = Array.isArray(cfg.buyFormula);
    var exitRuleMap = {};
    (cfg.exitRules || []).forEach(function (r) { if (r && r.buy && r.sell) exitRuleMap[r.buy] = r.sell; });
    function entryReasonOf(i) {
      if (buyFormulaMode2 && cfg.buyFormula) {
        for (var ti = 0; ti < cfg.buyFormula.length; ti++) {
          var tk = cfg.buyFormula[ti];
          if (tk !== "and" && tk !== "or" && tk !== "not" && tk !== "(" && tk !== ")" && buyCond(tk, i)) return tk;
        }
        return null;
      }
      for (var bi = 0; bi < cfg.buy.length; bi++) { if (buyCond(cfg.buy[bi], i)) return cfg.buy[bi]; }
      return null;
    }
    var buyFormulaMode = Array.isArray(cfg.buyFormula);
    var sellFormulaMode = Array.isArray(cfg.sellFormula);
    var buyAst = buyFormulaMode ? parseFormula(cfg.buyFormula, function (id) { return cfg.buy.indexOf(id) >= 0; }) : null;
    var sellAst = sellFormulaMode ? parseFormula(cfg.sellFormula, function (id) { return cfg.sell.indexOf(id) >= 0; }) : null;
    function buyOk(i) {
      if (buyFormulaMode) {
        if (cfg.screen) for (var si = 0; si < cfg.screen.length; si++) { if (!buyCond(cfg.screen[si], i)) return false; }
        return buyAst ? evalFormula(buyAst, function (id) { return buyCond(id, i); }) : true;
      }
      var orAny = false, orFired = false;
      for (var j = 0; j < cfg.buy.length; j++) {
        var bid = cfg.buy[j];
        if (buyOrSet && buyOrSet.has(bid)) { orAny = true; if (buyCond(bid, i)) orFired = true; }
        else if (!buyCond(bid, i)) return false;
      }
      if (orAny && !orFired) return false;
      if (cfg.buy.indexOf("dd") < 0 && !ddOk(i)) return false;
      return true;
    }
    function sellCond(id, i, pos) {
      var c = jCloses[i];
      if (id === "maCrossDn") return smaSDn[i] != null && smaLDn[i] != null && smaSDn[i] < smaLDn[i];
      if (id === "macdCrossDn") return macdA[i] != null && macdSigA[i] != null && macdA[i] < macdSigA[i];
      if (id === "bollingerUp") return cfg.bollSellSigma != null && pstdA[i] != null && ma20[i] != null && c >= ma20[i] + cfg.bollSellSigma * pstdA[i];
      if (id === "takeProfit") return closes[i] >= pos.price * (1 + (cfg.profitPct == null ? 10 : cfg.profitPct) / 100);
      if (id === "holdDays") return cfg.holdDays != null && (i - pos.execIdx) >= cfg.holdDays;
      if (id === "emaCrossDn") return ema9[i] != null && ema21[i] != null && ema9[i] < ema21[i];
      if (id === "ma50") return maSell[i] != null && c < maSell[i];
      if (id === "loss8") return closes[i] <= pos.price * (1 - (cfg.lossPct == null ? 8 : cfg.lossPct) / 100);
      if (id === "high25") {
        var hi2 = extreme(jHighs, i, 252, true);
        return hi2 != null && c <= hi2 * (1 - (cfg.highPct == null ? 20 : cfg.highPct) / 100);
      }
      if (id === "rsiLe") return cfg.rsiSell != null && rsi[i] != null && rsi[i] >= cfg.rsiSell;
      if (id === "dropPct") return cfg.dropPct != null && i > 0 && jCloses[i - 1] > 0 && c / jCloses[i - 1] - 1 <= -cfg.dropPct / 100;
      // Pine's orange warning remains active until FTD even if DD falls below 5.
      // A new FTD bar is the final orange bar, but is not a sell signal.
      if (id === "ddGe") return cfg.ddSell != null && pineWarning[i] && !pineFtd[i];
      return false;
    }
    function sellReason(i, pos) {
      if (pos && pos.reason && exitRuleMap[pos.reason]) {
        return sellCond(exitRuleMap[pos.reason], i, pos) ? exitRuleMap[pos.reason] : null;
      }
      if (sellFormulaMode) {
        if (!sellAst) return null;
        if (!evalFormula(sellAst, function (id) { return sellCond(id, i, pos); })) return null;
        for (var fi = 0; fi < cfg.sellFormula.length; fi++) {
          var fid = cfg.sellFormula[fi];
          if (fid !== "and" && fid !== "or" && fid !== "not" && fid !== "(" && fid !== ")" && sellCond(fid, i, pos)) return fid;
        }
        return "formula";
      }
      var orAny = false, orFired = false, firstTrue = null;
      for (var j = 0; j < cfg.sell.length; j++) {
        var id = cfg.sell[j];
        var t = sellCond(id, i, pos);
        if (t && firstTrue === null) firstTrue = id;
        if (!sellOrSet || sellOrSet.has(id)) { orAny = true; if (t) orFired = true; }
        else if (!t) return null;
      }
      if (orAny && !orFired) return null;
      return firstTrue;
    }

    var from = Math.max(0, cfg.fromIdx), to = Math.min(n - 1, cfg.toIdx);
    var trades = [], pos = null, pendingBuy = false, pendingReason = null, pendingSell = null, waitRule = null;
    if (cfg.startHeld && to >= from) pos = { execIdx: from, signalIdx: from, price: opens[from], date: dates[from] };
    var equity = [], cash = 1;
    for (var d = from; d <= to; d++) {
      if (pendingBuy && !pos) {
        pos = { execIdx: d, signalIdx: d - 1, price: opens[d], date: dates[d], reason: pendingReason };
        pendingBuy = false; pendingReason = null;
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
      if (pos && !pendingSell) {
        var r = sellReason(d, pos);
        if (r) pendingSell = r;
      }
      if (!pos && !pendingBuy && (waitRule ? buyCond(waitRule.buy, d) : buyOk(d))) {
        var bounceExec = waitRule ? waitRule.buy === "bounceClose" : (cfg.buy.indexOf("bounceClose") >= 0 && buyCond("bounceClose", d));
        var entryReason = waitRule ? waitRule.buy : entryReasonOf(d);
        if (bounceExec) {
          pos = { execIdx: d, signalIdx: d, price: closes[d], date: dates[d], reason: entryReason };
          waitRule = null;
        } else { pendingBuy = true; pendingReason = entryReason; }
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
    var bhTotal = to > from ? closes[to] / closes[from] - 1 : 0;
    function calmarOf(total, dd) { var sess = to - from + 1; if (dd <= 0 || total <= -1 || sess <= 0) return null; return (Math.pow(1 + total, 252 / sess) - 1) / dd; }
    return {
      trades: trades,
      perf: {
        totalReturn: finalEq - 1,
        bhReturn: bhTotal,
        closedCount: closed.length,
        winRate: closed.length ? wins.length / closed.length : null,
        avgRet: closed.length ? closed.reduce(function (s, t) { return s + t.ret; }, 0) / closed.length : null,
        avgHold: closed.length ? closed.reduce(function (s, t) { return s + t.hold; }, 0) / closed.length : null,
        maxDd: maxDd,
        bhMaxDd: bhMaxDd,
        sharpe: sharpeOf(eqRets),
        bhSharpe: sharpeOf(bhRets),
        calmar: calmarOf(finalEq - 1, maxDd),
        bhCalmar: calmarOf(bhTotal, bhMaxDd),
        bhClosedCount: to > from ? 1 : 0,
        bhAvgHold: to > from ? to - from : null,
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

    // ---- Result export (CSV / Excel) -------------------------------------
    function btCollectTables() {
      var TITLES = [["bt-all-matrix", "ヒートマップ"], ["bt-all-table", "全パターン"], ["bt-rollall-table", "全パターン（ローリング）"], ["bt-rollall-dates", "開始日別結果"], ["bt-roll-table", "ローリング開始日別"], ["bt-cmpmx-table", "戦略比較"], ["bt-cmp-table", "戦略比較"], ["bt-stock-table", "銘柄別結果"], ["bt-trades-table", "売買履歴"]];
      var tables = [];
      var note = results.querySelector(".bt-res-note");
      if (note && note.textContent.trim()) tables.push({ title: "適用条件", rows: [[note.textContent.trim().replace(/\s+/g, " ")]] });
      var used = {};
      results.querySelectorAll("table").forEach(function (tbl) {
        var title = "表";
        TITLES.forEach(function (pair) { if (tbl.classList.contains(pair[0])) title = pair[1]; });
        var rows = [];
        tbl.querySelectorAll("tr").forEach(function (tr) {
          var row = [];
          tr.querySelectorAll("th,td").forEach(function (cell) {
            row.push(cell.textContent.trim().replace(/\s+/g, " "));
            var cs = parseInt(cell.getAttribute("colspan") || "1", 10);
            for (var k = 1; k < cs; k++) row.push("");
          });
          if (row.length) rows.push(row);
        });
        if (!rows.length) return;
        var name = title;
        if (used[title]) { used[title]++; name = title + used[title]; } else used[title] = 1;
        tables.push({ title: name, rows: rows });
      });
      return tables;
    }
    function btCsvQuote(v) { var t = String(v == null ? "" : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }
    function btDownload(blob, filename) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }
    function btXmlEsc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function btColName(i) { var t = ""; i++; while (i > 0) { var m = (i - 1) % 26; t = String.fromCharCode(65 + m) + t; i = Math.floor((i - 1) / 26); } return t; }
    function btSheetXml(rows) {
      var x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
      rows.forEach(function (r, ri) {
        x += '<row r="' + (ri + 1) + '">';
        r.forEach(function (v, ci) {
          var t = String(v == null ? "" : v);
          if (/^-?\d+(\.\d+)?$/.test(t)) x += '<c r="' + btColName(ci) + (ri + 1) + '"><v>' + Number(t) + "</v></c>";
          else if (t !== "") x += '<c r="' + btColName(ci) + (ri + 1) + '" t="inlineStr"><is><t>' + btXmlEsc(t) + "</t></is></c>";
        });
        x += "</row>";
      });
      return x + "</sheetData></worksheet>";
    }
    var btCrcTable = null;
    function btCrc(data) {
      if (!btCrcTable) { btCrcTable = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); btCrcTable[n] = c >>> 0; } }
      var crc = 0xFFFFFFFF;
      for (var i = 0; i < data.length; i++) crc = btCrcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function btZipBlob(files) {
      var enc = new TextEncoder();
      var chunks = [], central = [], offset = 0;
      files.forEach(function (f) {
        var name = enc.encode(f.name), crc = btCrc(f.data);
        var lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
        lh.setUint32(14, crc, true); lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true);
        lh.setUint16(26, name.length, true);
        chunks.push(new Uint8Array(lh.buffer), name, f.data);
        var ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
        ch.setUint32(16, crc, true); ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true);
        ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
        central.push(new Uint8Array(ch.buffer), name);
        offset += 30 + name.length + f.data.length;
      });
      var csize = central.reduce(function (a, c) { return a + c.length; }, 0);
      var end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
      end.setUint32(12, csize, true); end.setUint32(16, offset, true);
      return new Blob(chunks.concat(central, [new Uint8Array(end.buffer)]), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    }
    function btExportResults(format) {
      var tables = btCollectTables().filter(function (t) { return t.title !== "適用条件" || t.rows.length; });
      var dataTables = tables.filter(function (t) { return t.title !== "適用条件"; });
      if (!dataTables.length) {
        var btn = document.getElementById("bt-export");
        if (btn) { var old = btn.textContent; btn.textContent = "結果がありません"; setTimeout(function () { btn.textContent = old; }, 1400); }
        return;
      }
      var now = new Date();
      var stamp = now.getFullYear() + ("0" + (now.getMonth() + 1)).slice(-2) + ("0" + now.getDate()).slice(-2) + "-" + ("0" + now.getHours()).slice(-2) + ("0" + now.getMinutes()).slice(-2);
      if (format === "xlsx") {
        var enc = new TextEncoder();
        var sheetName = function (t) { return t.replace(/[\\\/?*[\]:]/g, "").slice(0, 31) || "表"; };
        var overrides = tables.map(function (_, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join("");
        var files = [
          { name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + overrides + "</Types>") },
          { name: "_rels/.rels", data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
          { name: "xl/workbook.xml", data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + tables.map(function (t, i) { return '<sheet name="' + btXmlEsc(sheetName(t.title)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join("") + "</sheets></workbook>") },
          { name: "xl/_rels/workbook.xml.rels", data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + tables.map(function (_, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join("") + "</Relationships>") }
        ];
        tables.forEach(function (t, i) { files.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: enc.encode(btSheetXml(t.rows)) }); });
        btDownload(btZipBlob(files), "backtest-results-" + stamp + ".xlsx");
      } else {
        var parts = [];
        tables.forEach(function (t) {
          parts.push("■ " + t.title);
          t.rows.forEach(function (r) { parts.push(r.map(btCsvQuote).join(",")); });
          parts.push("");
        });
        btDownload(new Blob(["\uFEFF" + parts.join("\r\n")], { type: "text/csv;charset=utf-8" }), "backtest-results-" + stamp + ".csv");
      }
    }

    (function setupFilterChips() {
      var host = document.getElementById("bt-filter-chips");
      if (!host) return;
      host.addEventListener("click", function (e) {
        var chip = e.target.closest ? e.target.closest("[data-bt-chip]") : null;
        if (chip) {
          var parts = chip.getAttribute("data-bt-chip").split("|");
          if (btFilters[parts[0]]) delete btFilters[parts[0]][parts[1]];
          applyAllBtFilters();
          return;
        }
        if (e.target.closest && e.target.closest(".bt-filter-clearall")) {
          btFilters = {};
          applyAllBtFilters();
        }
      });
    })();

    (function setupEtfToSymbols() {
      var sym = document.getElementById("bt-symbols");
      if (!sym) return;
      panel.addEventListener("change", function (e) {
        var box = e.target;
        if (!box || !box.matches || !box.matches("input[data-bt-etf]")) return;
        var code = box.value;
        var norm = function (x) { return MARKET === "us" ? x.toUpperCase() : x.replace(/\.T$/i, ""); };
        var parts = sym.value.split(/[\s,、，]+/).map(function (x) { return x.trim(); }).filter(Boolean);
        var has = parts.some(function (x) { return norm(x) === code; });
        if (box.checked && !has) parts.push(code);
        else if (!box.checked && has) parts = parts.filter(function (x) { return norm(x) !== code; });
        else return;
        sym.value = parts.join(",");
        sym.dispatchEvent(new Event("input", { bubbles: true }));
        sym.dispatchEvent(new Event("change", { bubbles: true }));
      });
    })();

    (function setupExport() {
      var btn = document.getElementById("bt-export");
      if (!btn) return;
      var menu = btn.parentElement.querySelector(".bt-export-menu");
      btn.addEventListener("click", function (e) { e.stopPropagation(); if (menu) menu.hidden = !menu.hidden; });
      document.addEventListener("click", function () { if (menu) menu.hidden = true; });
      if (menu) menu.querySelectorAll("[data-bt-export]").forEach(function (b) {
        b.addEventListener("click", function () { menu.hidden = true; btExportResults(b.getAttribute("data-bt-export")); });
      });
    })();

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
        // Membership follows the CURRENT layout: items can be dragged
        // across group headings, so collect them when applying.
        function groupItems() {
          var items = [];
          var el = g.nextElementSibling;
          while (el && !el.classList.contains("bt-group") && !el.classList.contains("bt-block-foot") && !el.classList.contains("bt-formula")) {
            if (el.classList.contains("bt-item")) items.push(el);
            el = el.nextElementSibling;
          }
          return items;
        }
        if (!groupItems().length) return;
        var btn = makeBtn(!!saved["g:" + label]);
        function apply() {
          var closed = !!saved["g:" + label];
          btn.textContent = closed ? "＋" : "−";
          groupItems().forEach(function (it) { it.style.display = closed ? "none" : ""; });
        }
        btn.addEventListener("click", function () { saved["g:" + label] = !saved["g:" + label]; persist(); apply(); });
        g.insertBefore(btn, g.firstChild);
        apply();
      });
    })();

    // IF-rule frame (GRW 2026-11-23): re-entry and exit rules are written
    // as IF lines in one frame under the buy/sell blocks, replacing the
    // per-item re-entry selects. Data shapes are unchanged.
    var curReentryRules = [];
    var curExitRules = [];
    var BUY_RULE_IDS = ["vol15", "maCross", "emaCross", "rsiGe", "bounceClose", "ftd", "macdCross", "bollinger", "breakout", "priceMa"];
    var SELL_RULE_IDS = ["maCrossDn", "emaCrossDn", "ma50", "loss8", "dropPct", "high25", "ddGe", "rsiLe", "macdCrossDn", "bollingerUp", "takeProfit", "holdDays"];
    // IF rows live inside the formula frames, anchored on the TRIGGER
    // side (GRW 2026-11-24): re-entry rules (triggered by a sell) in the
    // sell frame, exit rules (triggered by a buy) in the buy frame.
    function makeIfSection(kind) {
      var sec = document.createElement("div");
      sec.className = "bt-if-sec";
      sec.innerHTML = '<div class="bt-if-sec-head">' + (kind === "exit" ? "IF文（撤退ルール）" : "IF文（再エントリールール）") + ' <button type="button" class="bt-rule-add" data-add="' + kind + '">＋追加</button></div><div class="bt-rules-rows" data-rules="' + kind + '"></div>';
      return sec;
    }
    var buyFrameEl = panel.querySelector('.bt-formula[data-formula="buy"]');
    var sellFrameEl = panel.querySelector('.bt-formula[data-formula="sell"]');
    var reentrySec = makeIfSection("reentry");
    var exitSec = makeIfSection("exit");
    if (buyFrameEl) buyFrameEl.appendChild(exitSec);
    if (sellFrameEl) sellFrameEl.appendChild(reentrySec);
    var rulesFrame = panel; // delegation root for rule events
    function ruleOptions(ids, labels, cur) {
      return ids.map(function (id) { return '<option value="' + id + '"' + (id === cur ? " selected" : "") + ">" + esc(labels[id] || id) + "</option>"; }).join("");
    }
    function renderRules() {
      var exitEl = exitSec.querySelector('[data-rules="exit"]');
      var reEl = reentrySec.querySelector('[data-rules="reentry"]');
      exitEl.innerHTML = curExitRules.map(function (r, i) {
        return '<div class="bt-rule-row">IF <select class="bt-select bt-rule-sel" data-kind="exit" data-part="buy" data-idx="' + i + '">' + ruleOptions(BUY_RULE_IDS, BUY_LABELS, r.buy) + '</select> で買ったら → <select class="bt-select bt-rule-sel" data-kind="exit" data-part="sell" data-idx="' + i + '">' + ruleOptions(SELL_RULE_IDS, SELL_LABELS, r.sell) + '</select> でのみ売る <button type="button" class="bt-rule-del" data-kind="exit" data-idx="' + i + '">削除</button></div>';
      }).join("") || '<div class="bt-rules-empty">（なし）</div>';
      reEl.innerHTML = curReentryRules.map(function (r, i) {
        return '<div class="bt-rule-row">IF <select class="bt-select bt-rule-sel" data-kind="reentry" data-part="sell" data-idx="' + i + '">' + ruleOptions(SELL_RULE_IDS, SELL_LABELS, r.sell) + '</select> で売ったら → <select class="bt-select bt-rule-sel" data-kind="reentry" data-part="buy" data-idx="' + i + '">' + ruleOptions(BUY_RULE_IDS, BUY_LABELS, r.buy) + '</select> でのみ買い戻す <button type="button" class="bt-rule-del" data-kind="reentry" data-idx="' + i + '">削除</button></div>';
      }).join("") || '<div class="bt-rules-empty">（なし）</div>';
    }
    function rulesChanged() {
      renderRules();
      alignFormulas();
      var ev = new Event("change", { bubbles: true });
      reentrySec.dispatchEvent(ev);
    }
    rulesFrame.addEventListener("change", function (e) {
      var sel = e.target;
      if (!sel.classList || !sel.classList.contains("bt-rule-sel")) return;
      var list = sel.getAttribute("data-kind") === "exit" ? curExitRules : curReentryRules;
      var idx = parseInt(sel.getAttribute("data-idx"), 10);
      var part = sel.getAttribute("data-part");
      if (!list[idx]) return;
      list[idx][part] = sel.value;
      // One rule per trigger: drop any other row with the same trigger.
      var trigPart = sel.getAttribute("data-kind") === "exit" ? "buy" : "sell";
      if (part === trigPart) {
        for (var i = list.length - 1; i >= 0; i--) { if (i !== idx && list[i][trigPart] === sel.value) list.splice(i, 1); }
      }
      rulesChanged();
    });
    rulesFrame.addEventListener("click", function (e) {
      var add = e.target.closest ? e.target.closest(".bt-rule-add") : null;
      if (add) {
        if (add.getAttribute("data-add") === "exit") {
          if (!curExitRules.some(function (r) { return r.buy === BUY_RULE_IDS[0]; })) curExitRules.push({ buy: BUY_RULE_IDS[0], sell: SELL_RULE_IDS[0] });
        } else {
          if (!curReentryRules.some(function (r) { return r.sell === SELL_RULE_IDS[0]; })) curReentryRules.push({ sell: SELL_RULE_IDS[0], buy: BUY_RULE_IDS[0] });
        }
        rulesChanged();
        return;
      }
      var del = e.target.closest ? e.target.closest(".bt-rule-del") : null;
      if (del) {
        var list2 = del.getAttribute("data-kind") === "exit" ? curExitRules : curReentryRules;
        list2.splice(parseInt(del.getAttribute("data-idx"), 10), 1);
        rulesChanged();
      }
    });
    renderRules();

    // Strategy slots: ten fixed tabs (戦略1-10), each holding its own buy/sell
    // condition set, edited through the single buy/sell blocks. The screening
    // block and the target/period settings are shared across slots. A checkbox
    // on each tab marks the slot for comparison runs. The old named-strategy
    // store is discarded (GRW, 2026-11-23).
    // Logical-formula frames (GRW 2026-11-23): checked items become chips
    // in a formula under each block; AND/OR/NOT/parens are inserted with
    // dedicated buttons. The formula replaces the AND/OR columns.
    var curFormulas = { buy: [], sell: [] };
    var formulaSel = { buy: -1, sell: -1 };
    var formulaValid = { buy: true, sell: true };
    if (window.__btSavedFormulas) {
      curFormulas.buy = (window.__btSavedFormulas.buy || []).slice();
      curFormulas.sell = (window.__btSavedFormulas.sell || []).slice();
    } else if (window.__btSavedRoles) {
      curFormulas.buy = buildDefaultFormula(checked("buy"), window.__btSavedRoles.buyOr || []);
      curFormulas.sell = buildDefaultFormula(checked("sell"), window.__btSavedRoles.sellOr || checked("sell"));
    } else {
      curFormulas.buy = buildDefaultFormula(checked("buy"), []);
      curFormulas.sell = buildDefaultFormula(checked("sell"), checked("sell"));
    }
    function chipLabel(group, id) { return condLabel(group, id); }
    function formulaText(tokens, group, ids) {
      if (!tokens.length) return ids.map(function (id) { return condLabel(group, id); }).join(group === "buy" ? " かつ " : " または ");
      return tokens.map(function (tk) {
        if (tk === "and") return " かつ ";
        if (tk === "or") return " または ";
        if (tk === "not") return " NOT ";
        if (tk === "(") return "（";
        if (tk === ")") return "）";
        return condLabel(group, tk);
      }).join("");
    }
    function renderFormula(group) {
      var frame = panel.querySelector('.bt-formula[data-formula="' + group + '"]');
      if (!frame) return;
      var chipsEl = frame.querySelector(".bt-formula-chips");
      var stateEl = frame.querySelector(".bt-formula-state");
      var tokens = curFormulas[group];
      if (!tokens.length) {
        chipsEl.innerHTML = '<span class="bt-formula-empty">（未設定：' + (group === "buy" ? "チェックした項目はすべてANDで判定します" : "チェックした項目はどれか1つで判定します") + "）</span>";
      } else {
        chipsEl.innerHTML = tokens.map(function (tk, i) {
          var cls = "bt-fchip", lab = tk;
          if (tk === "and" || tk === "or") { cls += " op"; lab = tk.toUpperCase(); }
          else if (tk === "(" || tk === ")") { cls += " par"; lab = tk === "(" ? "（" : "）"; }
          else if (tk === "not") { cls += " op"; lab = "NOT"; }
          else lab = chipLabel(group, tk);
          return '<span class="' + cls + (formulaSel[group] === i ? " sel" : "") + '" data-fidx="' + i + '">' + esc(lab) + "</span>";
        }).join("");
      }
      var err = validateFormula(tokens);
      formulaValid[group] = !err;
      frame.classList.toggle("invalid", !!err);
      stateEl.textContent = err || "";
      alignFormulas();
    }
    // Keep the buy/sell formula frames at the same height: the higher
    // frame is pushed down to the lower one's top (GRW 2026-11-23).
    // Only when the two blocks sit side by side (same row).
    function alignFormulas() {
      var fb = panel.querySelector('.bt-formula[data-formula="buy"]');
      var fs = panel.querySelector('.bt-formula[data-formula="sell"]');
      var bb = panel.querySelector(".bt-block.buy"), bs = panel.querySelector(".bt-block.sell");
      if (!fb || !fs || !bb || !bs) return;
      fb.style.marginTop = "10px"; fs.style.marginTop = "10px";
      if (Math.abs(bb.getBoundingClientRect().top - bs.getBoundingClientRect().top) > 2) return;
      var tb = fb.getBoundingClientRect().top, ts = fs.getBoundingClientRect().top;
      if (tb < ts) fb.style.marginTop = (10 + ts - tb) + "px";
      else if (ts < tb) fs.style.marginTop = (10 + tb - ts) + "px";
    }
    window.addEventListener("resize", function () { alignFormulas(); });
    panel.addEventListener("click", function () { requestAnimationFrame(function () { alignFormulas(); }); });
    // ---- Sector rotation tab (GRW, 2026-11-25): for every session,
    // rank the sector ETFs by their trailing n-session return, then
    // average the forward returns per rank. ----
    var ROT_SECTORS = MARKET === "us" ? [
      ["XLK", "情報技術"], ["XLF", "金融"], ["XLV", "ヘルスケア"],
      ["XLE", "エネルギー"], ["XLI", "資本財"], ["XLY", "一般消費財"],
      ["XLP", "生活必需品"], ["XLB", "素材"], ["XLC", "通信サービス"],
      ["XLU", "公益事業"], ["XLRE", "不動産"]
    ] : [
      ["1617.T", "食品"], ["1618.T", "エネルギー資源"], ["1619.T", "建設・資材"],
      ["1620.T", "素材・化学"], ["1621.T", "医薬品"], ["1622.T", "自動車・輸送機"],
      ["1623.T", "鉄鋼・非鉄"], ["1624.T", "機械"], ["1625.T", "電機・精密"],
      ["1626.T", "情報通信・サービスその他"], ["1627.T", "電力・ガス"],
      ["1628.T", "運輸・物流"], ["1629.T", "商社・卸売"], ["1630.T", "小売"],
      ["1631.T", "銀行"], ["1632.T", "金融（除く銀行）"], ["1633.T", "不動産"]
    ];
    var ROT_HOLDS = [1, 5, 10, 20, 25];
    var ROT_SHOW = 10; // top and bottom ranks shown per table
    var rotCache = null;
    var rotBenchCache = undefined;
    var rotIndCache = {};
    function rotFile(ticker) {
      return MARKET === "us" ? "ohlcv/us/" + ticker + ".json"
        : "ohlcv/jp/" + ticker.replace(/\.T$/, "") + "-T.json";
    }
    function ohlcvSeries(data) {
      if (!data || !data.rows || !data.rows.length) return null;
      var dates = [], closes = [], idx = new Map();
      data.rows.forEach(function (row, i) { dates.push(row[0]); closes.push(row[4]); idx.set(row[0], i); });
      return { dates: dates, closes: closes, idx: idx };
    }
    function loadRotSeries() {
      if (rotCache) return Promise.resolve(rotCache);
      var out = [];
      return Promise.all(ROT_SECTORS.map(function (pair) {
        return fetch(rotFile(pair[0]), { cache: "no-cache" }).then(function (res) {
          if (!res.ok) return null;
          return res.json();
        }).then(function (data) {
          var sr = ohlcvSeries(data);
          if (!sr || sr.dates.length <= 130) return;
          sr.ticker = pair[0]; sr.name = pair[1];
          out.push(sr);
        }).catch(function () { /* sector file not seeded yet */ });
      })).then(function () {
        out.sort(function (a, b) {
          return ROT_SECTORS.findIndex(function (p) { return p[0] === a.ticker; })
            - ROT_SECTORS.findIndex(function (p) { return p[0] === b.ticker; });
        });
        rotCache = out;
        return out;
      });
    }
    function loadRotBench() {
      if (rotBenchCache !== undefined) return Promise.resolve(rotBenchCache);
      var ticker = MARKET === "us" ? "SPY" : "1306.T";
      return fetch(rotFile(ticker), { cache: "no-cache" }).then(function (res) {
        if (!res.ok) return null;
        return res.json();
      }).then(function (data) {
        rotBenchCache = ohlcvSeries(data);
        return rotBenchCache;
      }).catch(function () { rotBenchCache = null; return null; });
    }
    // Industry history files hold 200 sessions of daily changes; compound
    // them into index series (start 100) per category, benchmark included.
    function loadIndFile(file) {
      if (rotIndCache[file]) return Promise.resolve(rotIndCache[file]);
      return fetch(file, { cache: "no-cache" }).then(function (res) {
        if (!res.ok) return null;
        return res.json();
      }).then(function (data) {
        if (!data || !data.rows || !data.rows.length) { rotIndCache[file] = null; return null; }
        var rows = data.rows.slice().reverse();
        var benchField = MARKET === "us" ? "benchmark_change" : "topix_change";
        var dates = rows.map(function (r) { return r.date; });
        function compound(getChange) {
          var closes = [], level = 100;
          rows.forEach(function (r) {
            var c = getChange(r);
            level *= 1 + (typeof c === "number" ? c : 0) / 100;
            closes.push(level);
          });
          var idx = new Map();
          dates.forEach(function (d, i) { idx.set(d, i); });
          return { dates: dates, closes: closes, idx: idx };
        }
        var series = Object.keys(data.names || {}).map(function (key) {
          var sr = compound(function (r) { var cell = (r.sectors || {})[key]; return cell ? cell.change : null; });
          sr.key = key;
          return sr;
        });
        var bench = compound(function (r) { return r[benchField]; });
        rotIndCache[file] = { series: series, bench: bench };
        return rotIndCache[file];
      }).catch(function () { rotIndCache[file] = null; return null; });
    }
    function rotationStats(series, bench, n, fromD, toD) {
      var calSet = new Set();
      series.forEach(function (sr) {
        sr.dates.forEach(function (d) {
          if ((!fromD || d >= fromD) && (!toD || d <= toD)) calSet.add(d);
        });
      });
      var cal = Array.from(calSet).sort();
      var rankSums = series.map(function () { return ROT_HOLDS.map(function () { return 0; }); });
      var rankCounts = series.map(function () { return ROT_HOLDS.map(function () { return 0; }); });
      var bSums = ROT_HOLDS.map(function () { return 0; }), bCounts = ROT_HOLDS.map(function () { return 0; });
      var days = 0;
      cal.forEach(function (d) {
        var ranked = [];
        series.forEach(function (sr) {
          var j = sr.idx.get(d);
          if (j === undefined || j < n) return;
          var base = sr.closes[j - n];
          if (!(base > 0) || !(sr.closes[j] > 0)) return;
          ranked.push({ sr: sr, j: j, trail: sr.closes[j] / base - 1 });
        });
        if (ranked.length < 3) return;
        ranked.sort(function (a, b) { return b.trail - a.trail; });
        days++;
        ranked.forEach(function (rk, rank) {
          ROT_HOLDS.forEach(function (h, hi) {
            var k = rk.j + h;
            if (k >= rk.sr.closes.length) return;
            rankSums[rank][hi] += rk.sr.closes[k] / rk.sr.closes[rk.j] - 1;
            rankCounts[rank][hi]++;
          });
        });
        if (bench) {
          var bj = bench.idx.get(d);
          if (bj !== undefined) ROT_HOLDS.forEach(function (h, hi) {
            var k = bj + h;
            if (k >= bench.closes.length) return;
            bSums[hi] += bench.closes[k] / bench.closes[bj] - 1;
            bCounts[hi]++;
          });
        }
      });
      var avg = function (sums, counts) {
        return ROT_HOLDS.map(function (h, hi) { return counts[hi] ? sums[hi] / counts[hi] : null; });
      };
      return {
        days: days,
        ranks: rankSums.map(function (sums, rank) {
          return { rank: rank, avgs: avg(sums, rankCounts[rank]), has: rankCounts[rank].some(function (c) { return c > 0; }) };
        }).filter(function (row) { return row.has; }),
        benchAvgs: avg(bSums, bCounts)
      };
    }
    function rotCellStyle(v) {
      if (v == null) return "";
      var a = Math.min(0.10 + Math.abs(v) * 16, 0.55);
      return ' style="background:' + (v >= 0 ? "rgba(22,163,74," : "rgba(220,38,38,") + a.toFixed(2) + ')"';
    }
    function rotTableHtml(heading, st, benchLabel, n) {
      var html = '<h4 class="bt-rot-head">' + heading + '（直近' + n + '営業日ランキング）</h4>';
      if (!st) return html + '<p class="bt-note">データが読み込めませんでした。</p>';
      if (!st.days) return html + '<p class="bt-note">対象期間に集計できる日がありません。</p>';
      var pct = function (v) { return v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%"; };
      html += '<table class="bt-res-table bt-rot-table"><thead><tr><th>購入条件</th>'
        + ROT_HOLDS.map(function (h) { return "<th>" + h + "日</th>"; }).join("") + "</tr></thead><tbody>";
      var total = st.ranks.length;
      var topEnd = Math.min(ROT_SHOW, total);
      var botStart = Math.max(topEnd, total - ROT_SHOW);
      st.ranks.forEach(function (row, i) {
        if (i === botStart && botStart > topEnd) {
          html += '<tr class="bt-rot-gap"><td colspan="' + (ROT_HOLDS.length + 1) + '">…（中間' + (botStart - topEnd) + '件）</td></tr>';
        }
        if (i >= topEnd && i < botStart) return;
        html += '<tr><td style="text-align:center">' + (row.rank + 1) + '位</td>' + row.avgs.map(function (v) {
          return "<td" + rotCellStyle(v) + ">" + pct(v) + "</td>";
        }).join("") + "</tr>";
      });
      html += '<tr class="bt-rot-avg"><td style="text-align:center">' + benchLabel + '</td>' + st.benchAvgs.map(function (v) {
        return "<td>" + pct(v) + "</td>";
      }).join("") + "</tr></tbody></table>";
      html += '<p class="bt-note">集計した営業日 ' + st.days.toLocaleString() + '日</p>';
      return html;
    }
    function runRotation() {
      var host = document.getElementById("bt-rot-results");
      if (!host) return;
      var n = parseInt((document.getElementById("bt-rot-n") || {}).value || "3", 10);
      var norm = function (v) {
        var d = String(v || "").replace(/\D/g, "");
        return d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : "";
      };
      var fromD = norm((document.getElementById("bt-rot-from") || {}).value);
      var toD = norm((document.getElementById("bt-rot-to") || {}).value);
      host.innerHTML = '<p class="bt-note">読み込んでいます…</p>';
      var ind1 = MARKET === "us" ? "us-industries.json" : "jp-industries.json";
      var ind2 = MARKET === "us" ? "us-industries-fine.json" : "jp-industries-fine.json";
      var benchLabel = MARKET === "us" ? "S&P500" : "TOPIX";
      Promise.all([loadRotSeries(), loadRotBench(), loadIndFile(ind1), loadIndFile(ind2)]).then(function (res) {
        var html = "";
        if (res[0] && res[0].length) {
          html += rotTableHtml("セクター", rotationStats(res[0], res[1], n, fromD, toD), benchLabel, n);
        } else {
          html += '<h4 class="bt-rot-head">セクター（直近' + n + '営業日ランキング）</h4>'
            + '<p class="bt-note">セクターETFのデータがまだ準備できていません（自動更新で順次そろいます）。</p>';
        }
        html += '<div class="bt-rot-cols"><div class="bt-rot-col">'
          + rotTableHtml("業種①", res[2] ? rotationStats(res[2].series, res[2].bench, n, fromD, toD) : null, benchLabel, n)
          + '</div><div class="bt-rot-col">'
          + rotTableHtml("業種②", res[3] ? rotationStats(res[3].series, res[3].bench, n, fromD, toD) : null, benchLabel, n)
          + '</div></div>';
        host.innerHTML = html;
      });
    }
    panel.querySelectorAll(".bt-subtab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        panel.querySelectorAll(".bt-subtab").forEach(function (b) { b.classList.toggle("is-active", b === btn); });
        var rot = btn.getAttribute("data-bt-view") === "rotation";
        var stockView = document.getElementById("bt-stock-view");
        var rotView = document.getElementById("bt-rotation-view");
        if (stockView) stockView.hidden = rot;
        if (rotView) rotView.hidden = !rot;
        if (!rot) requestAnimationFrame(function () { alignFormulas(); });
      });
    });
    var rotRunBtn = document.getElementById("bt-rot-run");
    if (rotRunBtn) rotRunBtn.addEventListener("click", runRotation);

    function setFormula(group, tokens) {
      curFormulas[group] = tokens;
      if (formulaSel[group] >= tokens.length) formulaSel[group] = tokens.length - 1;
      renderFormula(group);
    }
    window.__btFormulas = {
      get: function () { return { buy: curFormulas.buy.slice(), sell: curFormulas.sell.slice() }; },
      set: function (b, s2) { curFormulas.buy = (b || []).slice(); curFormulas.sell = (s2 || []).slice(); renderFormula("buy"); renderFormula("sell"); }
    };
    panel.addEventListener("change", function (e) {
      if (panel.dataset.applying) return;
      var tg = e.target;
      if (!tg || !tg.getAttribute) return;
      var grp = tg.getAttribute("data-bt");
      if ((grp !== "buy" && grp !== "sell") || tg.type !== "checkbox") return;
      var tokens = curFormulas[grp].slice();
      if (tg.checked) {
        if (tokens.indexOf(tg.value) < 0) {
          var last = tokens[tokens.length - 1];
          if (tokens.length && last !== "(" && last !== "and" && last !== "or" && last !== "not") tokens.push(grp === "buy" ? "and" : "or");
          tokens.push(tg.value);
        }
      } else {
        tokens = normalizeFormula(tokens.filter(function (tk) { return tk !== tg.value; }));
      }
      setFormula(grp, tokens);
    });
    panel.addEventListener("click", function (e) {
      var chip = e.target.closest ? e.target.closest(".bt-fchip") : null;
      if (chip) {
        var fr = chip.closest(".bt-formula");
        var g = fr.getAttribute("data-formula");
        formulaSel[g] = parseInt(chip.getAttribute("data-fidx"), 10);
        renderFormula(g);
        return;
      }
      var btn = e.target.closest ? e.target.closest(".bt-formula-tools button") : null;
      if (!btn) return;
      var frame = btn.closest(".bt-formula");
      var group = frame.getAttribute("data-formula");
      var op = btn.getAttribute("data-fop");
      var tokens = curFormulas[group].slice();
      var at = formulaSel[group] + 1;
      if (op === "clear") { tokens = []; formulaSel[group] = -1; }
      else if (op === "del") { var di = formulaSel[group] >= 0 ? formulaSel[group] : tokens.length - 1; if (di >= 0) { tokens.splice(di, 1); formulaSel[group] = di - 1; } }
      else { tokens.splice(at, 0, op); formulaSel[group] = at; }
      setFormula(group, tokens);
      var st2 = panel.querySelector("#bt-strat-tabs");
      var ev = new Event("change", { bubbles: true });
      var anchor = frame.querySelector(".bt-formula-chips");
      if (anchor) anchor.dispatchEvent(ev);
    });
    var slotsApi = (function setupSlots() {
      var tabsEl = document.getElementById("bt-strat-tabs");
      var KEY = "stock-dashboard-bt-slots-" + MARKET;
      var store = null;
      try { store = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { store = null; }
      try { localStorage.removeItem("stock-dashboard-bt-strategies-" + MARKET); } catch (e) {}
      function readReentryDom() { return curReentryRules.map(function (r) { return { sell: r.sell, buy: r.buy }; }); }
      function applyReentry(list) {
        curReentryRules = (list || []).map(function (r) { return { sell: r.sell, buy: r.buy }; });
        renderRules();
      }
      function applyExitRules(list) {
        curExitRules = (list || []).map(function (r) { return { buy: r.buy, sell: r.sell }; });
        renderRules();
      }
      function blank() { return { buy: [], sell: [], buyFormula: [], sellFormula: [], nums: {}, cmp: false, reentry: [], exitRules: [], startHeld: false }; }
      function collectDom() {
        var st = { buy: checked("buy"), sell: checked("sell"), buyFormula: curFormulas.buy.slice(), sellFormula: curFormulas.sell.slice(), nums: {}, reentry: readReentryDom(), exitRules: curExitRules.map(function (r) { return { buy: r.buy, sell: r.sell }; }), startHeld: !!((panel.querySelector("#bt-start-held") || {}).checked) };
        panel.querySelectorAll("[data-bt-num]").forEach(function (n) { st.nums[n.getAttribute("data-bt-num")] = n.value; });
        return st;
      }
      if (!store || !Array.isArray(store.slots) || (store.slots.length !== 8 && store.slots.length !== 10)) {
        var seed = collectDom();
        store = { active: 0, slots: [] };
        for (var i = 0; i < 8; i++) store.slots.push(i === 0 ? { buy: seed.buy, sell: seed.sell, buyFormula: seed.buyFormula || [], sellFormula: seed.sellFormula || [], nums: seed.nums, cmp: false, reentry: seed.reentry || [], exitRules: seed.exitRules || [], startHeld: !!seed.startHeld } : blank());
      }
      if (store.slots.length === 10) store.slots = store.slots.slice(0, 8);
      store.slots.forEach(function (sl) {
        if (!sl || !Array.isArray(sl.buy) || !Array.isArray(sl.sell) || !sl.nums) { sl.buy = []; sl.sell = []; sl.nums = {}; }
        sl.cmp = !!sl.cmp;
        if (!Array.isArray(sl.reentry)) sl.reentry = [];
        if (!Array.isArray(sl.exitRules)) sl.exitRules = [];
        if (!Array.isArray(sl.buyFormula)) sl.buyFormula = buildDefaultFormula(sl.buy || [], sl.buyOr || []);
        if (!Array.isArray(sl.sellFormula)) sl.sellFormula = buildDefaultFormula(sl.sell || [], Array.isArray(sl.sellOr) ? sl.sellOr : (sl.sell || []));
        sl.startHeld = !!sl.startHeld;
      });
      var active = store.active >= 0 && store.active < 8 ? store.active : 0;
      var applying = false;
      function persist() { store.active = active; try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {} }
      function syncFromDom() {
        var st = collectDom();
        store.slots[active].buy = st.buy; store.slots[active].sell = st.sell; store.slots[active].buyFormula = st.buyFormula; store.slots[active].sellFormula = st.sellFormula; store.slots[active].nums = st.nums; store.slots[active].reentry = st.reentry; store.slots[active].exitRules = st.exitRules; store.slots[active].startHeld = st.startHeld;
      }
      function applySlot(idx) {
        var st = store.slots[idx];
        applying = true;
        panel.dataset.applying = "1";
        panel.querySelectorAll('input[type="checkbox"][data-bt="buy"], input[type="checkbox"][data-bt="sell"]').forEach(function (b) {
          var grp = b.getAttribute("data-bt");
          var list = grp === "buy" ? st.buy : st.sell;
          var on = list.indexOf(b.value) >= 0;
          if (b.checked !== on) { b.checked = on; b.dispatchEvent(new Event("change", { bubbles: true })); }
        });
        curFormulas.buy = (st.buyFormula || []).slice();
        curFormulas.sell = (st.sellFormula || []).slice();
        formulaSel.buy = -1; formulaSel.sell = -1;
        renderFormula("buy"); renderFormula("sell");
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
        applyExitRules(st.exitRules || []);
        var shEl = panel.querySelector("#bt-start-held");
        if (shEl && shEl.checked !== !!st.startHeld) shEl.checked = !!st.startHeld;
        applying = false;
        delete panel.dataset.applying;
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
        if (tg.getAttribute("data-bt") === "buy" || tg.getAttribute("data-bt") === "sell" || tg.hasAttribute("data-bt-num") || tg.classList.contains("bt-formula-chips") || tg.classList.contains("bt-if-sec") || tg.id === "bt-start-held") { syncFromDom(); persist(); }
      });
      applySlot(active);
      persist(); paintTabs();
      return {
        activeName: function () { return "戦略" + (store.active + 1); },
        activeReentry: function () { return (store.slots[store.active].reentry || []).filter(function (r) { return ["vol15", "rsiGe", "bounceClose", "ftd", "breakout"].indexOf(r.buy) >= 0; }).map(function (r) { return { sell: r.sell, buy: r.buy }; }); },
        activeExitRules: function () { return (store.slots[store.active].exitRules || []).map(function (r) { return { buy: r.buy, sell: r.sell }; }); },
        activeBuyFormula: function () { return (store.slots[store.active].buyFormula || []).slice(); },
        activeSellFormula: function () { return (store.slots[store.active].sellFormula || []).slice(); },
        activeStartHeld: function () { return !!store.slots[store.active].startHeld; },
        selected: function () {
          var screen = checked("screen");
          var out = [];
          store.slots.forEach(function (sl, i) {
            if (sl.cmp) out.push({ name: "戦略" + (i + 1), state: { screen: screen, buy: sl.buy.slice(), sell: sl.sell.slice(), buyFormula: (sl.buyFormula || []).slice(), sellFormula: (sl.sellFormula || []).slice(), nums: Object.assign({}, sl.nums), reentry: (sl.reentry || []).map(function (r) { return { sell: r.sell, buy: r.buy }; }), exitRules: (sl.exitRules || []).map(function (r) { return { buy: r.buy, sell: r.sell }; }), startHeld: !!sl.startHeld } });
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
      return el ? parseFloat(el.value) : NaN;
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

    // Leveraged ETFs are judged on their underlying ETF's series (all
    // statistics: sigma, RSI, moving averages, volume, DD/FTD); fills and
    // returns still use the leveraged ETF's own prices (GRW 2026-11-23).
    var UNDERLYING = { QLD: "QQQ", TQQQ: "QQQ", SOXL: "SOXX" };
    var judgePromises = {};
    function judgePromise(u) {
      if (!judgePromises[u]) judgePromises[u] = loadJson(ohlcvUrl(u)).then(function (d) { return (d && d.rows) || null; }).catch(function () { return null; });
      return judgePromises[u];
    }
    function withJudge(code, rows) {
      var u = UNDERLYING[code];
      if (!u) return Promise.resolve({ rows: rows, judgeRows: null });
      return judgePromise(u).then(function (jr) { return { rows: rows, judgeRows: jr }; });
    }
    var JUDGE_NOTE = "レバレッジETF（QLD・TQQQ・SOXL）の条件判定は原資産（QQQ・SOXX）で行います（約定・損益はETF自身の価格）。";

    var INDEX_LABELS = { nikkei: "日経225", prime: "東証プライム", standard: "東証スタンダード", growth: "東証グロース", sp500: "S&P500", nasdaq100: "NASDAQ100", nasdaq: "NASDAQ総合", dow: "ダウ" };
    var ETF_NAMES = { "1321": "NEXT FUNDS 日経225連動型上場投信", "1306": "NEXT FUNDS TOPIX連動型上場投信", "QQQ": "インベスコ QQQ（NASDAQ100連動）", "SPY": "SPDR S&P500 ETF（SPY）", "QLD": "NASDAQ100連動2倍ETF（QLD）", "TQQQ": "NASDAQ100連動3倍ETF（TQQQ）", "SOXX": "半導体ETF（SOXX）", "SOXL": "半導体連動3倍ETF（SOXL）" };

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
          var startDate = fromVal || rows[0][0];
          var endDate = toVal || lastDate;
          var fromIdx = rows.findIndex(function (r) { return r[0] >= startDate; });
          var toIdx = -1;
          for (var i = rows.length - 1; i >= 0; i--) { if (rows[i][0] <= endDate) { toIdx = i; break; } }
          if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) {
            out.push({ title: title, out: null, noData: "指定期間のデータがありません（保有データ：" + rows[0][0] + " 〜 " + lastDate + "）。" });
            return;
          }
          var res = runBacktest(rows, {
            fromIdx: fromIdx, toIdx: toIdx, buy: cfgBase.buy, sell: cfgBase.sell, screen: cfgBase.screen, buyFormula: cfgBase.buyFormula, sellFormula: cfgBase.sellFormula,
            ddLimit: cfgBase.ddLimit, rsiBuy: rsiBuyVal, rsiSell: rsiSellVal, dropPct: dropPctVal, ddSell: ddSellVal, lossPct: lossPctVal, highPct: highPctVal, bounceCloseSigma: bounceCloseSigmaVal, maDays: maDaysVal, maShort: maPairVal ? maPairVal[0] : 20, maLong: maPairVal ? maPairVal[1] : 50, maShortDn: maPairDnVal ? maPairDnVal[0] : 20, maLongDn: maPairDnVal ? maPairDnVal[1] : 50, bollSigma: bollSigmaVal, bollSellSigma: bollSellSigmaVal, breakoutDays: breakoutDaysVal, profitPct: profitPctVal, holdDays: holdDaysVal, priceMaDays: priceMaDaysVal, reentry: slotsApi.activeReentry(), exitRules: slotsApi.activeExitRules(), startHeld: slotsApi.activeStartHeld()
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
    var STOCK_COLS = ["title", "kind", "ret", "count", "win", "avg", "maxdd", "sharpe", "calmar", "hold", "period"];
    var ROLL_COLS = ["start", "kind", "n", "avg", "median", "count", "win", "hold", "sharpe", "calmar"];
    var CMP_COLS = ["strat", "ret", "win", "count", "avg", "maxdd", "hold", "sharpe", "calmar"];
    // Column reorder + width adjustment shared by every backtest table:
    // heading drag reorders, the right-edge grip resizes, Ctrl+click selects
    // several columns for a bulk resize. Order and widths persist by column id.
    function setThLabel(th, txt) {
      var n = th.firstChild;
      if (n && n.nodeType === 3) n.nodeValue = txt;
      else th.insertBefore(document.createTextNode(txt), th.firstChild);
    }
    // Column filters for the result tables, mirroring the screener's
    // column filter: a small triangle button in each heading opens a
    // popup (number range + presence, text search, or a choice), active
    // filters combine with AND across columns and show as chips above
    // the results.
    var BT_FILTER_KINDS = { ret: "number", bh: "number", win: "number", winRate: "number", avg: "number", avgRet: "number", median: "number", best: "number", worst: "number", maxdd: "number", sharpe: "number", calmar: "number", hold: "number", avgHold: "number", count: "number", closed: "number", n: "number", buyPrice: "number", sellPrice: "number", kind: "choice" };
    var BT_FILTER_LABELS = { no: "番号", label: "パターン", title: "銘柄", strat: "戦略", kind: "区分", ret: "リターン", bh: "買い持ち", win: "勝率", winRate: "勝率", count: "取引回数", closed: "取引回数", avg: "平均", avgRet: "平均損益", median: "中央値", best: "最大", worst: "最小", maxdd: "最大DD", sharpe: "シャープ", calmar: "カルマー", hold: "平均保有", avgHold: "平均保有", start: "開始日", period: "期間", n: "銘柄数", buyDate: "買い日", buyPrice: "買値", sellDate: "売り日", sellPrice: "売値", reason: "売り理由" };
    var BT_TABLE_TITLES = { stock: "銘柄別結果", cmp: "戦略比較", cmpmx: "戦略比較", roll: "ローリング開始日別", all: "全パターン", allroll: "全パターン（ローリング）", allrolldates: "開始日別結果", trades: "売買履歴", sweep: "ランキング", sweeproll: "ランキング" };
    var btFilters = {};
    var btFilterPopup = null, btFilterCtx = null;
    function btFilterKind(colId) { return BT_FILTER_KINDS[colId] || "text"; }
    function btFilterMeaningful(colId, f) {
      if (!f) return false;
      var k = btFilterKind(colId);
      if (k === "number") return (f.min || "") !== "" || (f.max || "") !== "" || f.presence === "has" || f.presence === "missing";
      if (k === "choice") return !!f.choice;
      return !!(f.text || "");
    }
    function btFilterActive(kind, colId) { return btFilterMeaningful(colId, btFilters[kind] && btFilters[kind][colId]); }
    function btRowPasses(kind, tr) {
      var fs = btFilters[kind];
      if (!fs) return true;
      for (var colId in fs) {
        var f = fs[colId];
        if (!btFilterMeaningful(colId, f)) continue;
        var td = tr.querySelector('td[data-bt-col="' + colId + '"]');
        if (!td) continue;
        var txt = td.textContent;
        var k = btFilterKind(colId);
        if (k === "number") {
          var v = parseFloat(String(txt).replace(/[,%+\s]/g, ""));
          var valid = !isNaN(v);
          if (f.presence === "missing") { if (valid) return false; continue; }
          if (!valid) { if (f.presence === "has" || (f.min || "") !== "" || (f.max || "") !== "") return false; continue; }
          if ((f.min || "") !== "" && v < parseFloat(f.min)) return false;
          if ((f.max || "") !== "" && v > parseFloat(f.max)) return false;
        } else if (k === "choice") {
          if (txt.trim() !== f.choice) return false;
        } else if (txt.toLocaleLowerCase().indexOf((f.text || "").toLocaleLowerCase()) < 0) return false;
      }
      return true;
    }
    function applyBtFilters(table, kind) {
      if (!table) return;
      table.querySelectorAll("tbody tr").forEach(function (tr) {
        if (tr.querySelector("td[colspan]")) { tr.style.display = ""; return; }
        tr.style.display = btRowPasses(kind, tr) ? "" : "none";
      });
      Array.from(table.querySelectorAll("thead th")).forEach(function (th) {
        var b = th.querySelector(".bt-col-filter");
        if (b) b.classList.toggle("bt-col-filter-on", btFilterActive(kind, th.dataset.btCol));
      });
    }
    function applyAllBtFilters() {
      if (!results) return;
      results.querySelectorAll("table.bt-res-table").forEach(function (t) { if (t.dataset.btKind) applyBtFilters(t, t.dataset.btKind); });
      renderBtFilterChips();
    }
    function btFilterDesc(colId, f) {
      var k = btFilterKind(colId);
      if (k === "number") {
        var parts = [];
        if (f.presence === "has") parts.push("取得済みのみ");
        if (f.presence === "missing") parts.push("未取得のみ");
        if ((f.min || "") !== "") parts.push(f.min + "以上");
        if ((f.max || "") !== "") parts.push(f.max + "以下");
        return parts.join("・");
      }
      if (k === "choice") return f.choice;
      return "「" + f.text + "」を含む";
    }
    function renderBtFilterChips() {
      var host = document.getElementById("bt-filter-chips");
      if (!host) return;
      var chips = [];
      Object.keys(btFilters).forEach(function (kind) {
        Object.keys(btFilters[kind]).forEach(function (colId) {
          var f = btFilters[kind][colId];
          if (!btFilterMeaningful(colId, f)) return;
          chips.push('<span class="bt-filter-chip">' + esc((BT_TABLE_TITLES[kind] || kind) + "：" + (BT_FILTER_LABELS[colId] || colId) + " " + btFilterDesc(colId, f)) + '<button type="button" data-bt-chip="' + kind + "|" + colId + '" aria-label="この条件を解除">×</button></span>');
        });
      });
      host.innerHTML = chips.length ? '<span class="bt-filter-cap">列フィルター：</span>' + chips.join("") + '<button type="button" class="bt-filter-clearall">全条件を解除</button>' : "";
    }
    function closeBtFilterPopup() { if (btFilterPopup) btFilterPopup.hidden = true; btFilterCtx = null; }
    function openBtFilterPopup(kind, colId, anchorBtn) {
      if (!btFilterPopup) {
        btFilterPopup = document.createElement("div");
        btFilterPopup.id = "bt-col-popup";
        btFilterPopup.className = "bt-col-popup";
        btFilterPopup.setAttribute("role", "dialog");
        btFilterPopup.setAttribute("aria-label", "列フィルター");
        panel.appendChild(btFilterPopup);
        document.addEventListener("pointerdown", function (e) {
          if (btFilterPopup && !btFilterPopup.hidden && !btFilterPopup.contains(e.target) && !(e.target.closest && e.target.closest(".bt-col-filter"))) closeBtFilterPopup();
        });
        btFilterPopup.addEventListener("click", function (e) {
          var b = e.target.closest ? e.target.closest("[data-action]") : null;
          if (!b || !btFilterCtx) return;
          var action = b.getAttribute("data-action");
          if (action === "close") { closeBtFilterPopup(); return; }
          if (action === "clear") {
            if (btFilters[btFilterCtx.kind]) delete btFilters[btFilterCtx.kind][btFilterCtx.colId];
            closeBtFilterPopup(); applyAllBtFilters(); return;
          }
          if (action === "apply") {
            var k = btFilterKind(btFilterCtx.colId);
            var f = {};
            if (k === "number") {
              f.min = btFilterPopup.querySelector('[data-btf="min"]').value;
              f.max = btFilterPopup.querySelector('[data-btf="max"]').value;
              f.presence = btFilterPopup.querySelector('[data-btf="presence"]').value;
              if (f.min !== "" && f.max !== "" && parseFloat(f.min) > parseFloat(f.max)) {
                btFilterPopup.querySelector(".bt-col-error").textContent = "最小値は最大値以下にしてください";
                return;
              }
            } else if (k === "choice") f.choice = btFilterPopup.querySelector('[data-btf="choice"]').value;
            else f.text = btFilterPopup.querySelector('[data-btf="text"]').value.trim();
            if (!btFilters[btFilterCtx.kind]) btFilters[btFilterCtx.kind] = {};
            if (btFilterMeaningful(btFilterCtx.colId, f)) btFilters[btFilterCtx.kind][btFilterCtx.colId] = f;
            else delete btFilters[btFilterCtx.kind][btFilterCtx.colId];
            closeBtFilterPopup(); applyAllBtFilters();
          }
        });
      }
      btFilterCtx = { kind: kind, colId: colId };
      var f = (btFilters[kind] && btFilters[kind][colId]) || {};
      var k = btFilterKind(colId);
      var label = BT_FILTER_LABELS[colId] || colId;
      var input = "";
      if (k === "number") {
        var sel = function (v) { return (f.presence || "all") === v ? " selected" : ""; };
        input = '<div class="bt-col-range"><label>最小値<input type="number" step="any" data-btf="min" placeholder="指定なし" value="' + esc(f.min || "") + '"></label><label>最大値<input type="number" step="any" data-btf="max" placeholder="指定なし" value="' + esc(f.max || "") + '"></label></div>' +
          '<label>データの有無<select data-btf="presence"><option value="all"' + sel("all") + '>すべて</option><option value="has"' + sel("has") + '>取得済みのみ</option><option value="missing"' + sel("missing") + '>未取得のみ（数値範囲は無視）</option></select></label>';
      } else if (k === "choice") {
        input = '<label>区分を選択<select data-btf="choice"><option value="">すべて</option>' + ["戦略", "買い持ち"].map(function (v) { return '<option value="' + v + '"' + (f.choice === v ? " selected" : "") + '>' + v + '</option>'; }).join("") + '</select></label>';
      } else {
        input = '<label>この文字を含む<input type="search" data-btf="text" placeholder="文字列を入力" value="' + esc(f.text || "") + '"></label>';
      }
      btFilterPopup.innerHTML = '<div class="bt-col-pophead"><strong>' + esc(label) + '</strong><button type="button" data-action="close" aria-label="閉じる">×</button></div>' + input +
        '<div class="bt-col-error" aria-live="polite"></div>' +
        '<div class="bt-col-actions"><button type="button" data-action="clear">この列を解除</button><button type="button" data-action="apply" class="bt-col-apply">適用</button></div>';
      btFilterPopup.hidden = false;
      var rect = anchorBtn.getBoundingClientRect(), w = btFilterPopup.offsetWidth, h = btFilterPopup.offsetHeight;
      btFilterPopup.style.left = Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))) + "px";
      btFilterPopup.style.top = Math.round(rect.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, rect.top - h - 6) : rect.bottom + 6) + "px";
      var first = btFilterPopup.querySelector("input, select");
      if (first) first.focus({ preventScroll: true });
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
      table.dataset.btKind = kind;
      cols.forEach(function (id) {
        if (id === "no") return;
        var th = thById[id];
        if (!th) return;
        var fb = document.createElement("button");
        fb.type = "button";
        fb.className = "bt-col-filter";
        fb.textContent = "▾";
        fb.title = (BT_FILTER_LABELS[id] || id) + " の絞り込み";
        fb.setAttribute("aria-label", (BT_FILTER_LABELS[id] || id) + " の絞り込み");
        fb.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
        fb.addEventListener("click", function (e) {
          e.stopPropagation();
          if (btFilterCtx && btFilterCtx.kind === kind && btFilterCtx.colId === id && btFilterPopup && !btFilterPopup.hidden) closeBtFilterPopup();
          else openBtFilterPopup(kind, id, fb);
        });
        th.appendChild(fb);
      });
      applyBtFilters(table, kind);
      return {
        restamp: function () {
          Array.from(table.querySelectorAll("tbody tr")).forEach(function (tr) {
            var tds = Array.from(tr.children);
            if (tds.length === cols.length) tds.forEach(function (td, i) { td.dataset.btCol = cols[i]; });
          });
          var cur = Array.from(table.querySelectorAll("thead th")).map(function (t) { return t.dataset.btCol; });
          reorder(cur);
          applyBtFilters(table, kind);
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
      var html = '<table class="bt-res-table bt-stock-table"><thead><tr><th>銘柄</th><th>区分</th><th>リターン</th><th>取引回数</th><th>勝率</th><th>平均損益</th><th>最大DD</th><th>シャープレシオ</th><th>カルマー</th><th>平均保有</th><th>期間</th></tr></thead><tbody>';
      entries.forEach(function (e, idx) {
        var short = (e.title || "").split(" ")[0];
        if (!e.out) {
          html += '<tr class="bt-stock-row" data-bt-stock="' + idx + '"><td colspan="11" style="text-align:left">' + short + "：" + esc(e.noData || "") + "</td></tr>";
          return;
        }
        var p = e.out.perf;
        html += '<tr class="bt-stock-row bt-bh-row" data-bt-stock="' + idx + '"><td style="text-align:left">' + short + '</td><td>買い持ち</td><td>' + pct(p.bhReturn) + "</td><td>" + p.bhClosedCount + "</td><td>—</td><td>—</td><td>" + pct(p.bhMaxDd) + "</td><td>" + sharpeTxt(p.bhSharpe) + "</td><td>" + sharpeTxt(p.bhCalmar) + "</td><td>" + (p.bhAvgHold == null ? "—" : p.bhAvgHold + "日") + "</td><td>" + esc(e.out.range.from) + " 〜 " + esc(e.out.range.to) + "</td></tr>";
        html += '<tr class="bt-stock-row" data-bt-stock="' + idx + '"><td style="text-align:left">' + short + "</td><td>戦略</td><td>" + pct(p.totalReturn) + "</td><td>" + p.closedCount + (p.hasOpen ? "（+保有中1）" : "") + "</td><td>" +
          (p.winRate == null ? "—" : pct(p.winRate, 0)) + "</td><td>" + (p.avgRet == null ? "—" : pct(p.avgRet)) + "</td><td>" + pct(p.maxDd) + "</td><td>" + sharpeTxt(p.sharpe) + "</td><td>" + sharpeTxt(p.calmar) + "</td><td>" +
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

    var rsiBuyVal = null, rsiSellVal = null, dropPctVal = null, ddSellVal = null, ddGateVal = null, lossPctVal = null, highPctVal = null, bounceCloseSigmaVal = null, maDaysVal = null, maPairVal = null, maPairDnVal = null, bollSigmaVal = null, bollSellSigmaVal = null, breakoutDaysVal = null, profitPctVal = null, holdDaysVal = null, priceMaDaysVal = null;
    function condLabel(group, id) {
      if (id === "rsiGe") return "RSI（14日）が" + (rsiBuyVal == null ? "閾値" : rsiBuyVal) + "以下";
      if (id === "bounceClose") return "前日に" + (bounceCloseSigmaVal == null ? "閾値" : bounceCloseSigmaVal) + "σ以上下落したとき、引け成行で買う";
      if (id === "rsiLe") return "RSI（14日）が" + (rsiSellVal == null ? "閾値" : rsiSellVal) + "以上";
      if (id === "dropPct") return "前日終値から" + (dropPctVal == null ? "閾値" : dropPctVal) + "%以上下落";
      if (id === "ma50") return "株価が" + (maDaysVal == null ? "閾値" : maDaysVal) + "日移動平均を下回る";
      if (id === "loss8") return "買値から" + (lossPctVal == null ? "閾値" : lossPctVal) + "%下落";
      if (id === "high25") return "52週高値から" + (highPctVal == null ? "閾値" : highPctVal) + "%以上下落";
      if (id === "ddGe") return "DD（売り抜け日）が" + (ddSellVal == null ? "閾値" : ddSellVal) + "以上（直近25取引日）";
      if (id === "dd") return "DD（売り抜け日）が" + (ddGateVal == null ? "閾値" : ddGateVal) + "以下";
      if (id === "maCross") return "短期" + (maPairVal ? maPairVal[0] : 20) + "日MA＞長期" + (maPairVal ? maPairVal[1] : 50) + "日MA";
      if (id === "maCrossDn") return "短期" + (maPairDnVal ? maPairDnVal[0] : 20) + "日MA＜長期" + (maPairDnVal ? maPairDnVal[1] : 50) + "日MA";
      if (id === "bollinger") return "終値がボリンジャーバンド下限（20日、−" + (bollSigmaVal == null ? "閾値" : bollSigmaVal) + "σ）以下";
      if (id === "breakout") return "当日高値が直近" + (breakoutDaysVal == null ? "閾値" : breakoutDaysVal) + "日の最高値を上回る";
      if (id === "bollingerUp") return "終値がボリンジャーバンド上限（20日、+" + (bollSellSigmaVal == null ? "閾値" : bollSellSigmaVal) + "σ）以上";
      if (id === "takeProfit") return "買値から" + (profitPctVal == null ? "閾値" : profitPctVal) + "%上昇";
      if (id === "holdDays") return (holdDaysVal == null ? "閾値" : holdDaysVal) + "日保有したら売る";
      if (id === "priceMa") return "株価が" + (priceMaDaysVal == null ? "閾値" : priceMaDaysVal) + "日移動平均より上";
      if (id === "formula") return "論理式";
      return ((group === "sell" ? SELL_LABELS : BUY_LABELS)[id] || id);
    }
    function readRsi(buyAll, sellAll) {
      if (buyAll.includes("rsiGe")) { var v = numOf("rsiBuy"); rsiBuyVal = isFinite(v) ? v : 30; } else rsiBuyVal = null;
      if (buyAll.includes("bounceClose")) { var bc = numOf("bounceCloseSigma"); bounceCloseSigmaVal = isFinite(bc) ? bc : 2; } else bounceCloseSigmaVal = null;
      if (sellAll.includes("rsiLe")) { var w = numOf("rsiSell"); rsiSellVal = isFinite(w) ? w : 70; } else rsiSellVal = null;
      if (sellAll.includes("dropPct")) { var d = numOf("dropSell"); dropPctVal = isFinite(d) ? d : 5; } else dropPctVal = null;
      if (sellAll.includes("ma50")) { var md = numOf("maSellDays"); maDaysVal = isFinite(md) ? md : 50; } else maDaysVal = null;
      if (sellAll.includes("loss8")) { var l = numOf("lossPct"); lossPctVal = isFinite(l) ? l : 8; } else lossPctVal = null;
      if (sellAll.includes("high25")) { var h = numOf("highPct"); highPctVal = isFinite(h) ? h : 20; } else highPctVal = null;
      if (sellAll.includes("ddGe")) { var g = numOf("ddSell"); ddSellVal = isFinite(g) ? g : 5; } else ddSellVal = null;
      if (buyAll.includes("dd")) { var dv = numOf("dd"); ddGateVal = isFinite(dv) ? dv : 5; } else ddGateVal = null;
      var pairOf = function (key) { var el = panel.querySelector('[data-bt-num="' + key + '"]'); if (!el) return null; var p = String(el.value).split(","); var a = parseInt(p[0], 10), b = parseInt(p[1], 10); return (isFinite(a) && isFinite(b)) ? [a, b] : null; };
      if (buyAll.includes("maCross")) { maPairVal = pairOf("maPair") || [20, 50]; } else maPairVal = null;
      if (sellAll.includes("maCrossDn")) { maPairDnVal = pairOf("maPairDn") || [20, 50]; } else maPairDnVal = null;
      if (buyAll.includes("bollinger")) { var bs = numOf("bollSigma"); bollSigmaVal = isFinite(bs) ? bs : 2; } else bollSigmaVal = null;
      if (sellAll.includes("bollingerUp")) { var bsu = numOf("bollSellSigma"); bollSellSigmaVal = isFinite(bsu) ? bsu : 2; } else bollSellSigmaVal = null;
      if (buyAll.includes("breakout")) { var bd = numOf("breakoutDays"); breakoutDaysVal = isFinite(bd) ? bd : 20; } else breakoutDaysVal = null;
      if (sellAll.includes("takeProfit")) { var tp = numOf("profitPct"); profitPctVal = isFinite(tp) ? tp : 10; } else profitPctVal = null;
      if (sellAll.includes("holdDays")) { var hd = numOf("holdDays"); holdDaysVal = isFinite(hd) ? hd : 20; } else holdDaysVal = null;
      if (buyAll.includes("priceMa")) { var pm = numOf("priceMaDays"); priceMaDaysVal = isFinite(pm) ? pm : 50; } else priceMaDaysVal = null;
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
      panel.querySelectorAll("input[data-bt-etf]:checked").forEach(function (b) { inputCodes.push(b.value); });
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
      var buyFormulaNow = slotsApi.activeBuyFormula(), sellFormulaNow = slotsApi.activeSellFormula();
      if (buyAll.includes("dd") && buy.indexOf("dd") < 0) buy.push("dd");
      var reRulesNow = slotsApi.activeReentry();
      readRsi(buyAll.concat(reRulesNow.map(function (r) { return r.buy; })), sellAll.concat(reRulesNow.map(function (r) { return r.sell; })));
      var rsMin = parseInt((document.getElementById("bt-tt-rs") || {}).value || "70", 10);
      var normDate = function (v) { var d = String(v || "").replace(/\D/g, ""); return d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : ""; };
      var fromVal = normDate((document.getElementById("bt-from") || {}).value);
      var toVal = normDate((document.getElementById("bt-to") || {}).value) || "9999-12-31";
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
            return withJudge(code, (data && data.rows) || null).then(function (r) { store[code] = r.rows; if (r.judgeRows) { store.__judge = store.__judge || {}; store.__judge[code] = r.judgeRows; } });
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
          var lo = null, hi = null;
          fixedCodes.forEach(function (c) {
            var rows = store[c] || [];
            if (rows.length) { if (!lo || rows[0][0] > lo) lo = rows[0][0]; if (!hi || rows[rows.length - 1][0] < hi) hi = rows[rows.length - 1][0]; }
          });
          var effFrom = fromVal || lo || "";
          var effTo = toVal !== "9999-12-31" ? toVal : (hi || toVal);
          var grid = new Set();
          fixedCodes.forEach(function (c) {
            (store[c] || []).forEach(function (r) { if (r[0] >= effFrom && r[0] <= effTo) grid.add(r[0]); });
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
              return withJudge(code, (data && data.rows) || null).then(function (r) { store[code] = r.rows; if (r.judgeRows) { store.__judge = store.__judge || {}; store.__judge[code] = r.judgeRows; } });
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
          var entries = [], n = 0, sumRet = 0, sumBh = 0, rets = [], bhRets = [], closedTrades = 0, winTrades = 0, holdSum = 0, sumSharpe = 0, nSharpe = 0, sumBhSharpe = 0, nBhSharpe = 0, sumCalmar = 0, nCalmar = 0, sumBhCalmar = 0, nBhCalmar = 0, bhClosedSum = 0, bhHoldSum = 0, nBhHold = 0;
          pd.codes.forEach(function (code) {
            var rows = ctx.store[code];
            if (!rows || !rows.length) return;
            var fromIdx = rows.findIndex(function (r) { return r[0] >= pd.date; });
            if (fromIdx < 0) return;
            var toIdx = Math.min(rows.length - 1, fromIdx + horizon - 1);
            if (toIdx <= fromIdx) return;
            var out = runBacktest(rows, {
              fromIdx: fromIdx, toIdx: toIdx, judgeRows: (ctx.store.__judge || {})[code] || null, buy: buy, sell: sell, buyFormula: buyFormulaNow, sellFormula: sellFormulaNow,
              ddLimit: ddLimit, rsiBuy: rsiBuyVal, rsiSell: rsiSellVal, dropPct: dropPctVal, ddSell: ddSellVal, lossPct: lossPctVal, highPct: highPctVal, bounceCloseSigma: bounceCloseSigmaVal, maDays: maDaysVal, maShort: maPairVal ? maPairVal[0] : 20, maLong: maPairVal ? maPairVal[1] : 50, maShortDn: maPairDnVal ? maPairDnVal[0] : 20, maLongDn: maPairDnVal ? maPairDnVal[1] : 50, bollSigma: bollSigmaVal, bollSellSigma: bollSellSigmaVal, breakoutDays: breakoutDaysVal, profitPct: profitPctVal, holdDays: holdDaysVal, priceMaDays: priceMaDaysVal, reentry: slotsApi.activeReentry(), exitRules: slotsApi.activeExitRules(), startHeld: slotsApi.activeStartHeld()
            });
            var title = esc(code) + (ctx.names[code] ? " " + esc(ctx.names[code]) : "");
            entries.push({ title: title, out: out });
            n++; sumRet += out.perf.totalReturn; sumBh += out.perf.bhReturn; rets.push(out.perf.totalReturn); bhRets.push(out.perf.bhReturn);
            if (out.perf.sharpe != null) { sumSharpe += out.perf.sharpe; nSharpe++; }
            if (out.perf.bhSharpe != null) { sumBhSharpe += out.perf.bhSharpe; nBhSharpe++; }
            if (out.perf.calmar != null) { sumCalmar += out.perf.calmar; nCalmar++; }
            if (out.perf.bhCalmar != null) { sumBhCalmar += out.perf.bhCalmar; nBhCalmar++; }
            bhClosedSum += out.perf.bhClosedCount; if (out.perf.bhAvgHold != null) { bhHoldSum += out.perf.bhAvgHold; nBhHold++; }
            out.trades.forEach(function (t) { if (!t.open) { closedTrades++; holdSum += t.hold; if (t.ret > 0) winTrades++; } });
          });
          rets.sort(function (a, b) { return a - b; });
          var median = !rets.length ? null : (rets.length % 2 ? rets[(rets.length - 1) / 2] : (rets[rets.length / 2 - 1] + rets[rets.length / 2]) / 2);
          bhRets.sort(function (a, b) { return a - b; });
          var bhMedian = !bhRets.length ? null : (bhRets.length % 2 ? bhRets[(bhRets.length - 1) / 2] : (bhRets[bhRets.length / 2 - 1] + bhRets[bhRets.length / 2]) / 2);
          summaries.push({
            date: pd.date, count: n, avg: n ? sumRet / n : null, median: median,
            bhAvg: n ? sumBh / n : null, bhMedian: bhMedian, trades: closedTrades, bhTrades: bhClosedSum, bhHoldAvg: nBhHold ? bhHoldSum / nBhHold : null,
            sharpeAvg: nSharpe ? sumSharpe / nSharpe : null, bhSharpeAvg: nBhSharpe ? sumBhSharpe / nBhSharpe : null, calmarAvg: nCalmar ? sumCalmar / nCalmar : null, bhCalmarAvg: nBhCalmar ? sumBhCalmar / nBhCalmar : null,
            avgHold: closedTrades ? holdSum / closedTrades : null, winRate: closedTrades ? winTrades / closedTrades : null, truncated: pd.truncated
          });
          details[pd.date] = entries;
        });
        var valid = summaries.filter(function (s) { return s.count > 0; });
        var html = '<table class="bt-res-table bt-roll-table"><thead><tr><th>開始日</th><th>区分</th><th>対象銘柄数</th><th>平均リターン</th><th>中央値</th><th>取引回数</th><th>勝率</th><th>平均保有</th><th>シャープレシオ</th><th>カルマー</th></tr></thead><tbody>';
        if (valid.length) {
          var totAvg = valid.reduce(function (s, x) { return s + x.avg; }, 0) / valid.length;
          var totBh = valid.reduce(function (s, x) { return s + x.bhAvg; }, 0) / valid.length;
          var totCount = valid.reduce(function (s, x) { return s + x.count; }, 0);
          var totTrades = valid.reduce(function (s, x) { return s + x.trades; }, 0);
          var totBhTrades = valid.reduce(function (s, x) { return s + x.bhTrades; }, 0);
          var bhHoldVals = valid.map(function (x) { return x.bhHoldAvg; }).filter(function (v) { return v != null; });
          var totBhHold = bhHoldVals.length ? bhHoldVals.reduce(function (a, b) { return a + b; }, 0) / bhHoldVals.length : null;
          var shVals = valid.map(function (x) { return x.sharpeAvg; }).filter(function (v) { return v != null; });
          var bhShVals = valid.map(function (x) { return x.bhSharpeAvg; }).filter(function (v) { return v != null; });
          var totSharpe = shVals.length ? shVals.reduce(function (a, b) { return a + b; }, 0) / shVals.length : null;
          var totBhSharpe = bhShVals.length ? bhShVals.reduce(function (a, b) { return a + b; }, 0) / bhShVals.length : null;
          var holdVals = valid.map(function (x) { return x.avgHold; }).filter(function (v) { return v != null; });
          var totHold = holdVals.length ? holdVals.reduce(function (a, b) { return a + b; }, 0) / holdVals.length : null;
          var cmVals = valid.map(function (x) { return x.calmarAvg; }).filter(function (v) { return v != null; });
          var totCalmar = cmVals.length ? cmVals.reduce(function (a, b) { return a + b; }, 0) / cmVals.length : null;
          var bhCmVals = valid.map(function (x) { return x.bhCalmarAvg; }).filter(function (v) { return v != null; });
          var totBhCalmar = bhCmVals.length ? bhCmVals.reduce(function (a, b) { return a + b; }, 0) / bhCmVals.length : null;
          html += '<tr class="bt-roll-total bt-bh-row"><td>全開始日の平均</td><td>買い持ち</td><td>' + totCount + '</td><td>' + pct(totBh) + '</td><td>—</td><td>' + totBhTrades + '</td><td>—</td><td>' + (totBhHold == null ? "—" : totBhHold.toFixed(0) + "日") + '</td><td>' + sharpeTxt(totBhSharpe) + '</td><td>' + sharpeTxt(totBhCalmar) + '</td></tr>';
          html += '<tr class="bt-roll-total"><td>全開始日の平均</td><td>戦略</td><td>' + totCount + '</td><td>' + pct(totAvg) + '</td><td>—</td><td>' + totTrades + '</td><td>—</td><td>' + (totHold == null ? "—" : totHold.toFixed(0) + "日") + '</td><td>' + sharpeTxt(totSharpe) + '</td><td>' + sharpeTxt(totCalmar) + '</td></tr>';
        }
        summaries.forEach(function (s) {
          html += '<tr class="bt-roll-row bt-bh-row" data-roll-date="' + s.date + '"><td>' + s.date + '</td><td>買い持ち</td><td>' + s.count + (s.truncated ? "（上限200）" : "") + '</td><td>' + pct(s.bhAvg) + '</td><td>' + pct(s.bhMedian) + '</td><td>' + s.bhTrades + '</td><td>—</td><td>' + (s.bhHoldAvg == null ? "—" : s.bhHoldAvg.toFixed(0) + "日") + '</td><td>' + sharpeTxt(s.bhSharpeAvg) + '</td><td>' + sharpeTxt(s.bhCalmarAvg) + '</td></tr>';
          html += '<tr class="bt-roll-row" data-roll-date="' + s.date + '"><td>' + s.date + '</td><td>戦略</td><td>' + s.count + (s.truncated ? "（上限200）" : "") + '</td><td>' + pct(s.avg) + '</td><td>' + pct(s.median) + '</td><td>' + s.trades + '</td><td>' + (s.winRate == null ? "—" : pct(s.winRate, 0)) + '</td><td>' + (s.avgHold == null ? "—" : s.avgHold.toFixed(0) + "日") + '</td><td>' + sharpeTxt(s.sharpeAvg) + '</td><td>' + sharpeTxt(s.calmarAvg) + '</td></tr>';
        });
        html += '</tbody></table>';
        html += '<p class="bt-res-note">開始日の行を選ぶと、その日の銘柄別結果を表示します。' + (fixedCodes ? "対象銘柄は入力した銘柄です（スクリーニング条件は使っていません）。" : "対象銘柄は開始日時点のスナップショットでスクリーニング条件を判定しています。") + '</p>';
        html += '<div id="bt-roll-detail"></div>';
        var applied = (fixedCodes ? [] : screenIds.map(function (id) { return "スクリーニング：" + condLabel("buy", id); }))
          .concat(buy.length ? ["買い式：" + formulaText(buyFormulaNow, "buy", buy)] : [])
          .concat(sell.length ? ["売り式：" + formulaText(sellFormulaNow, "sell", sell)] : []);
        if (ddLimit != null) applied.push("買い：" + condLabel("buy", "dd"));
        slotsApi.activeReentry().forEach(function (r) { applied.push("再エントリー：" + condLabel("sell", r.sell) + "で売った後は" + condLabel("buy", r.buy) + "で買い戻す"); });
        slotsApi.activeExitRules().forEach(function (r) { applied.push("撤退ルール：" + condLabel("buy", r.buy) + "で買った後は" + condLabel("sell", r.sell) + "でのみ売る"); });
        if (slotsApi.activeStartHeld()) applied.push("最初から保有した状態で開始");
        if (ctx.perDate.some(function (pd) { return pd.codes.some(function (c) { return UNDERLYING[c]; }); })) applied.push(JUDGE_NOTE);
        html += '<p class="bt-res-note">適用した条件：' + esc(applied.join(" / ")) + "<br>判定は終値、売買は翌営業日の始値です（σ下落の買いは当日の終値で買います）。手数料・税金は含みません。シャープレシオは日次リターンから計算しています（無リスク金利0）。" + (buy.length ? "" : "買い条件が未選択のため、対象銘柄は各開始日の翌営業日に買います。") + "</p>";
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
      var ddLimit = buyAll.includes("dd") ? numOf("dd") : null;
      var buyFormulaNow = slotsApi.activeBuyFormula(), sellFormulaNow = slotsApi.activeSellFormula();
      var buyCfg = buy.slice();
      if (buyAll.includes("dd")) buyCfg.push("dd");
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
            return withJudge(code, (data && data.rows) || []).then(function (r) { return { code: code, rows: r.rows, judgeRows: r.judgeRows }; });
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
          var startDate = fromVal || rows[0][0];
          var endDate = toVal || lastDate;
          var fromIdx = rows.findIndex(function (r) { return r[0] >= startDate; });
          var toIdx = -1;
          for (var i = rows.length - 1; i >= 0; i--) { if (rows[i][0] <= endDate) { toIdx = i; break; } }
          if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) {
            entries.push({ title: title, out: null, noData: "指定期間のデータがありません（保有データ：" + rows[0][0] + " 〜 " + lastDate + "）。" });
            return;
          }
          var out = runBacktest(rows, {
            fromIdx: fromIdx, toIdx: toIdx, judgeRows: item.judgeRows || null, buy: buyCfg, sell: sell, screen: screen, buyFormula: buyFormulaNow, sellFormula: sellFormulaNow,
            ddLimit: ddLimit, rsiBuy: rsiBuyVal, rsiSell: rsiSellVal, dropPct: dropPctVal, ddSell: ddSellVal, lossPct: lossPctVal, highPct: highPctVal, bounceCloseSigma: bounceCloseSigmaVal, maDays: maDaysVal, maShort: maPairVal ? maPairVal[0] : 20, maLong: maPairVal ? maPairVal[1] : 50, maShortDn: maPairDnVal ? maPairDnVal[0] : 20, maLongDn: maPairDnVal ? maPairDnVal[1] : 50, bollSigma: bollSigmaVal, bollSellSigma: bollSellSigmaVal, breakoutDays: breakoutDaysVal, profitPct: profitPctVal, holdDays: holdDaysVal, priceMaDays: priceMaDaysVal, reentry: slotsApi.activeReentry(), exitRules: slotsApi.activeExitRules(), startHeld: slotsApi.activeStartHeld()
          });
          entries.push({ title: title, out: out });
        });
        var applied = screen.map(function (id) { return "スクリーニング：" + condLabel("buy", id); })
          .concat(buy.length ? ["買い式：" + formulaText(buyFormulaNow, "buy", buy)] : [])
          .concat(sell.length ? ["売り式：" + formulaText(sellFormulaNow, "sell", sell)] : []);
        if (ddLimit != null) applied.push("買い：" + condLabel("buy", "dd"));
        slotsApi.activeReentry().forEach(function (r) { applied.push("再エントリー：" + condLabel("sell", r.sell) + "で売った後は" + condLabel("buy", r.buy) + "で買い戻す"); });
        slotsApi.activeExitRules().forEach(function (r) { applied.push("撤退ルール：" + condLabel("buy", r.buy) + "で買った後は" + condLabel("sell", r.sell) + "でのみ売る"); });
        if (slotsApi.activeStartHeld()) applied.push("最初から保有した状態で開始");
        if (ctx.loaded.some(function (it) { return UNDERLYING[it.code]; })) applied.push(JUDGE_NOTE);
        var notes = '<p class="bt-res-note">適用した条件：' + esc(applied.join(" / ") || "なし") + "<br>判定は終値、売買は翌営業日の始値です（σ下落の買いは当日の終値で買います）。手数料・税金は含みません。シャープレシオは日次リターンから計算しています（無リスク金利0）。" + (buy.length ? "" : "買い条件（判定できるもの）が未選択のため、対象銘柄は期間開始の翌営業日に買います。") + "</p>";
        if (skipped.length) {
          notes += '<p class="bt-res-note">対象外（過去データがないため判定しませんでした）：' + esc(skipped.join(" / ")) + "</p>";
        }
        var finish = function () {
          results.innerHTML = '<div id="bt-stock-results"></div>' + notes;
          renderStockResults(document.getElementById("bt-stock-results"), entries, { stratName: slotsApi.activeName() });
        };
        if (indexKeys.length) {
          var endYear = toVal ? +toVal.slice(0, 4) : new Date().getFullYear();
          var startYear = fromVal ? +fromVal.slice(0, 4) : 1992;
          var indexYears = [];
          for (var iy = startYear - 1; iy <= endYear; iy++) indexYears.push(iy);
          loadIndexEntries(indexKeys, indexYears, { buy: buyCfg, sell: sell, screen: screen, buyFormula: buyFormulaNow, sellFormula: sellFormulaNow, ddLimit: ddLimit }, fromVal, toVal, periodYears)
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
      function parsePair(v) { var p = String(v == null ? "" : v).split(","); var a = parseInt(p[0], 10), b = parseInt(p[1], 10); return (isFinite(a) && isFinite(b) && a < b) ? [a, b] : [20, 50]; }
      var maPairC = parsePair(nums.maPair), maPairDnC = parsePair(nums.maPairDn);
      var screen = (st.screen || []).filter(function (id) { return BUY_EVALUABLE[id]; });
      var buyList = (st.buy || []).filter(function (id) { return BUY_EVALUABLE[id]; });
      var sell = (st.sell || []).filter(function (id) { return SELL_EVALUABLE[id]; });
      var buyFormula = Array.isArray(st.buyFormula) ? st.buyFormula.filter(function (tk) { return tk === "and" || tk === "or" || tk === "not" || tk === "(" || tk === ")" || buyList.indexOf(tk) >= 0; }) : buildDefaultFormula(buyList, (st.buyOr || []).filter(function (id) { return buyList.indexOf(id) >= 0; }));
      var sellFormula = Array.isArray(st.sellFormula) ? st.sellFormula.filter(function (tk) { return tk === "and" || tk === "or" || tk === "not" || tk === "(" || tk === ")" || sell.indexOf(tk) >= 0; }) : buildDefaultFormula(sell, st.sellOr ? st.sellOr.filter(function (id) { return sell.indexOf(id) >= 0; }) : sell.slice());
      return {
        buy: buyList, sell: sell, screen: screen, buyFormula: buyFormula, sellFormula: sellFormula,
        ddLimit: null,
        rsiBuy: Math.min(50, Math.max(25, num("rsiBuy", 30))), rsiSell: Math.min(85, Math.max(70, num("rsiSell", 70))),
        dropPct: Math.min(10, Math.max(3, num("dropSell", 5))), ddSell: [5, 6, 7].reduce(function (a, o) { return Math.abs(o - num("ddSell", 5)) < Math.abs(a - num("ddSell", 5)) ? o : a; }, 5), lossPct: num("lossPct", 8), highPct: [5, 10, 15, 20].reduce(function (a, o) { return Math.abs(o - num("highPct", 20)) < Math.abs(a - num("highPct", 20)) ? o : a; }, 20), bounceCloseSigma: Math.min(3, Math.max(1.5, num("bounceCloseSigma", 2))), maDays: [20, 50, 200].reduce(function (a, o) { return Math.abs(o - num("maSellDays", 50)) < Math.abs(a - num("maSellDays", 50)) ? o : a; }, 50),
        maShort: maPairC[0], maLong: maPairC[1], maShortDn: maPairDnC[0], maLongDn: maPairDnC[1],
        bollSigma: [1.5, 2, 2.5, 3].reduce(function (a, o) { return Math.abs(o - num("bollSigma", 2)) < Math.abs(a - num("bollSigma", 2)) ? o : a; }, 2), bollSellSigma: [1.5, 2, 2.5, 3].reduce(function (a, o) { return Math.abs(o - num("bollSellSigma", 2)) < Math.abs(a - num("bollSellSigma", 2)) ? o : a; }, 2),
        breakoutDays: [20, 60, 120, 252].reduce(function (a, o) { return Math.abs(o - num("breakoutDays", 20)) < Math.abs(a - num("breakoutDays", 20)) ? o : a; }, 20),
        profitPct: Math.min(50, Math.max(1, num("profitPct", 10))), holdDays: [5, 10, 20, 30, 60, 90, 120, 252].reduce(function (a, o) { return Math.abs(o - num("holdDays", 20)) < Math.abs(a - num("holdDays", 20)) ? o : a; }, 20),
        priceMaDays: [20, 50, 200].reduce(function (a, o) { return Math.abs(o - num("priceMaDays", 50)) < Math.abs(a - num("priceMaDays", 50)) ? o : a; }, 50),
        reentry: (st.reentry || []).filter(function (r) { return r && SELL_EVALUABLE[r.sell] && ["vol15", "rsiGe", "bounceClose", "ftd", "breakout"].indexOf(r.buy) >= 0; }).map(function (r) { return { sell: r.sell, buy: r.buy }; }),
        exitRules: (st.exitRules || []).filter(function (r) { return r && BUY_EVALUABLE[r.buy] && SELL_EVALUABLE[r.sell]; }).map(function (r) { return { buy: r.buy, sell: r.sell }; }),
        startHeld: !!st.startHeld
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
      var cm = outs.map(function (o) { return o.perf.calmar; }).filter(function (x) { return x != null; });
      var bcm = outs.map(function (o) { return o.perf.bhCalmar; }).filter(function (x) { return x != null; });
      var bhh = outs.map(function (o) { return o.perf.bhAvgHold; }).filter(function (x) { return x != null; });
      return {
        n: outs.length, ret: mean(function (p) { return p.totalReturn; }), bh: mean(function (p) { return p.bhReturn; }),
        maxDd: mean(function (p) { return p.maxDd; }),
        bhMaxDd: mean(function (p) { return p.bhMaxDd; }),
        bhSharpe: bsh.length ? bsh.reduce(function (a, b) { return a + b; }, 0) / bsh.length : null,
        sharpe: sh.length ? sh.reduce(function (a, b) { return a + b; }, 0) / sh.length : null,
        bhCalmar: bcm.length ? bcm.reduce(function (a, b) { return a + b; }, 0) / bcm.length : null,
        bhClosed: outs.reduce(function (sm, o) { return sm + o.perf.bhClosedCount; }, 0),
        bhAvgHold: bhh.length ? bhh.reduce(function (a, b) { return a + b; }, 0) / bhh.length : null,
        calmar: cm.length ? cm.reduce(function (a, b) { return a + b; }, 0) / cm.length : null,
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
            return withJudge(code, (data && data.rows) || []).then(function (r) { return { code: code, rows: r.rows, judgeRows: r.judgeRows }; });
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
            var startDate = fromVal || rows[0][0];
            var endDate = toVal || lastDate;
            var fromIdx = rows.findIndex(function (r) { return r[0] >= startDate; });
            var toIdx = -1;
            for (var i = rows.length - 1; i >= 0; i--) { if (rows[i][0] <= endDate) { toIdx = i; break; } }
            if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) {
              entries.push({ title: title, out: null, noData: "指定期間のデータがありません（保有データ：" + rows[0][0] + " 〜 " + lastDate + "）。" });
              return;
            }
            entries.push({ title: title, out: runBacktest(rows, Object.assign({ fromIdx: fromIdx, toIdx: toIdx, judgeRows: item.judgeRows || null }, cfg)) });
          });
          return { name: it.name, cfg: cfg, entries: entries };
        });
        var ixJobs = perStrat.map(function (ps) {
          if (!indexKeys.length) return Promise.resolve();
          var endYear = toVal ? +toVal.slice(0, 4) : new Date().getFullYear();
          var startYear = fromVal ? +fromVal.slice(0, 4) : 1992;
          var indexYears = [];
          for (var iy = startYear - 1; iy <= endYear; iy++) indexYears.push(iy);
          return loadIndexEntries(indexKeys, indexYears, { buy: ps.cfg.buy, sell: ps.cfg.sell, buyOr: ps.cfg.buyOr, sellOr: ps.cfg.sellOr, ddLimit: ps.cfg.ddLimit }, fromVal, toVal, periodYears)
            .then(function (ixEntries) { ps.entries.push.apply(ps.entries, ixEntries); })
            .catch(function () {});
        });
        return Promise.all(ixJobs).then(function () { return perStrat; });
      }).then(function (perStrat) {
        var ddTxt = function (v) { return v > 0 ? "-" + (v * 100).toFixed(2) + "%" : "0.00%"; };
        var targetNames = perStrat[0].entries.map(function (e) { return e.title; });
        var CMPMX_COLS = ["title", "strat", "ret", "win", "count", "avg", "maxdd", "sharpe", "calmar", "hold", "period"];
        var CMPMX_LABELS = ["銘柄", "戦略", "リターン", "勝率", "取引回数", "平均損益", "最大DD", "シャープ", "カルマー", "平均保有", "期間"];
        function entryStat(out) {
          var closed = 0, open = 0, wins = 0, retSum = 0, holdSum = 0;
          out.trades.forEach(function (t) { if (t.open) open++; else { closed++; retSum += t.ret; holdSum += t.hold; if (t.ret > 0) wins++; } });
          return { closed: closed, open: open, winRate: closed ? wins / closed : null, avgRet: closed ? retSum / closed : null, avgHold: closed ? holdSum / closed : null };
        }
        var mxRows = [];
        perStrat[0].entries.forEach(function (e0, ei) {
          if (e0.out) {
            var p0 = e0.out.perf;
            mxRows.push({ title: e0.title, strat: "買い持ち", bh: true, entryIdx: ei, stratIdx: -1, ret: p0.bhReturn, win: null, count: p0.bhClosedCount, open: 0, avg: null, maxdd: p0.bhMaxDd, sharpe: p0.bhSharpe, calmar: p0.bhCalmar, hold: p0.bhAvgHold, period: e0.out.range.from + " 〜 " + e0.out.range.to });
          }
          perStrat.forEach(function (ps, si) {
            var e = ps.entries[ei];
            if (!e) return;
            if (!e.out) { mxRows.push({ title: e.title, strat: ps.name, bh: false, entryIdx: ei, stratIdx: si, noData: e.noData || "" }); return; }
            var st = entryStat(e.out), p = e.out.perf;
            mxRows.push({ title: e.title, strat: ps.name, bh: false, entryIdx: ei, stratIdx: si, ret: p.totalReturn, win: st.winRate, count: st.closed, open: st.open, avg: st.avgRet, maxdd: p.maxDd, sharpe: p.sharpe, calmar: p.calmar, hold: st.avgHold, period: e.out.range.from + " 〜 " + e.out.range.to });
          });
        });
        var html = '<p class="bt-res-note">戦略比較（銘柄×戦略） / 銘柄：' + targetNames.join("、") + "<br>行を選ぶと、その銘柄×戦略の売買履歴を表示します。</p>";
        html += '<table class="bt-res-table bt-cmpmx-table"><thead><tr>' + CMPMX_LABELS.map(function (h) { return "<th>" + h + "</th>"; }).join("") + '</tr></thead><tbody></tbody></table>';
        html += '<p class="bt-res-note">判定は終値、売買は翌営業日の始値です（σ下落の買いは当日の終値で買います）。手数料・税金は含みません。シャープレシオは日次リターンから計算しています（無リスク金利0）。スクリーニング条件のうち過去データで判定できないもの（EPS・ROE・セクター等）は比較でも対象外です。</p>';
        html += '<div id="bt-cmp-detail"></div>';
        results.innerHTML = html;
        var mxTable = results.querySelector(".bt-cmpmx-table");
        var mxDetail = document.getElementById("bt-cmp-detail");
        var mxSort = { key: null, dir: 1 };
        var mxHandle = setupFlexTable(mxTable, CMPMX_COLS, "cmpmx");
        function mxSelect(r, tr) {
          Array.from(mxTable.querySelectorAll(".bt-cmpmx-row")).forEach(function (x) { x.classList.remove("bt-stock-sel"); });
          if (tr) tr.classList.add("bt-stock-sel");
          if (!r || r.noData != null) { mxDetail.innerHTML = ""; return; }
          if (r.bh) { mxDetail.innerHTML = '<p class="bt-res-note">買い持ちは期間中ずっと保有するため、売買履歴はありません。</p>'; return; }
          var ps = perStrat[r.stratIdx];
          var e = ps.entries[r.entryIdx];
          mxDetail.innerHTML = '<h3 class="bt-roll-detail-title">' + esc(r.title) + " × " + esc(ps.name) + '</h3><div class="bt-cmp-stocks"></div>';
          renderStockResults(mxDetail.querySelector(".bt-cmp-stocks"), [e], { stratName: ps.name });
        }
        function mxRender() {
          var rows = mxRows.slice();
          if (mxSort.key) {
            var k = mxSort.key;
            rows.sort(function (a, b) {
              var va = a[k], vb = b[k];
              if (va == null && vb == null) return 0;
              if (va == null) return 1;
              if (vb == null) return -1;
              var c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "ja", { numeric: true });
              return c * mxSort.dir;
            });
          }
          var tb = "";
          rows.forEach(function (r) {
            var short = esc(String(r.title).split(" ")[0]);
            var mi = mxRows.indexOf(r);
            if (r.noData != null) { tb += '<tr class="bt-cmpmx-row" data-mx="' + mi + '"><td style="text-align:left">' + short + '</td><td style="text-align:left">' + esc(r.strat) + '</td><td colspan="9" style="text-align:left">' + esc(r.noData) + "</td></tr>"; return; }
            tb += '<tr class="bt-cmpmx-row' + (r.bh ? " bt-bh-row" : "") + '" data-mx="' + mi + '"><td style="text-align:left">' + short + '</td><td style="text-align:left">' + esc(r.strat) + "</td><td>" + pct(r.ret) + "</td><td>" + (r.win == null ? "—" : pct(r.win, 0)) + "</td><td>" + r.count + (r.open ? "（+保有中" + r.open + "）" : "") + "</td><td>" + (r.avg == null ? "—" : pct(r.avg)) + "</td><td>" + pct(r.maxdd) + "</td><td>" + sharpeTxt(r.sharpe) + "</td><td>" + sharpeTxt(r.calmar) + "</td><td>" + (r.hold == null ? "—" : Math.round(r.hold) + "日") + "</td><td>" + esc(r.period) + "</td></tr>";
          });
          mxTable.querySelector("tbody").innerHTML = tb;
          if (mxHandle) mxHandle.restamp();
          Array.from(mxTable.querySelectorAll(".bt-cmpmx-row")).forEach(function (tr) {
            tr.addEventListener("click", function () { mxSelect(mxRows[parseInt(tr.dataset.mx, 10)], tr); });
          });
        }
        Array.from(mxTable.querySelectorAll("thead th")).forEach(function (th, thi) {
          var pos = null;
          th.addEventListener("pointerdown", function (e) { pos = [e.clientX, e.clientY]; });
          th.addEventListener("click", function (e) {
            if (pos && Math.hypot(e.clientX - pos[0], e.clientY - pos[1]) > 5) return;
            var id = th.dataset.btCol;
            if (!id) return;
            if (mxSort.key === id) mxSort.dir = -mxSort.dir;
            else { mxSort.key = id; mxSort.dir = (id === "title" || id === "strat" || id === "period") ? 1 : -1; }
            Array.from(mxTable.querySelectorAll("thead th")).forEach(function (x) {
              var xi = CMPMX_COLS.indexOf(x.dataset.btCol);
              var node = x.childNodes[0];
              if (node && xi >= 0) node.textContent = CMPMX_LABELS[xi] + (mxSort.key === x.dataset.btCol ? (mxSort.dir > 0 ? " ▲" : " ▼") : "");
            });
            mxRender();
          });
        });
        mxRender();
        var firstStrat = mxRows.find(function (r) { return !r.bh && r.noData == null; });
        if (firstStrat) {
          var ftr = mxTable.querySelector('.bt-cmpmx-row[data-mx="' + mxRows.indexOf(firstStrat) + '"]');
          mxSelect(firstStrat, ftr);
        }
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
    var PARAM_KEY = { vol15: null, rsiGe: "rsiBuy", bounceClose: "bounceCloseSigma", dd: "dd", ma50: "maSellDays", loss8: "lossPct", dropPct: "dropSell", high25: "highPct", ddGe: "ddSell", rsiLe: "rsiSell", maCross: "maPair", maCrossDn: "maPairDn", bollinger: "bollSigma", bollingerUp: "bollSellSigma", breakout: "breakoutDays", takeProfit: "profitPct", holdDays: "holdDays", priceMa: "priceMaDays" };
    function runAllPatterns() {
      var runAllBtn = document.getElementById("bt-run-all");
      var mtRaw = ((document.getElementById("bt-min-trades") || {}).value || "0");
      var zeroOnly = mtRaw === "0only";
      var minTrades = zeroOnly ? 0 : (parseInt(mtRaw, 10) || 0);
      function mtExcluded(closed) { if (zeroOnly) return !closed; return minTrades > 0 && (closed || 0) < minTrades; }
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
          var label = b.closest(".bt-item");
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
        if (id === "maCross" || id === "maCrossDn") { var pp = String(nums.maPair || nums.maPairDn || "20,50").split(","); return "移動平均クロス（短期" + pp[0] + "日MA" + (id === "maCross" ? "＞" : "＜") + "長期" + pp[1] + "日MA）"; }
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
        p.cfg = stratCfg({ screen: screenChecked, buy: p.buy, sell: p.sell, buyFormula: slotsApi.activeBuyFormula(), sellFormula: slotsApi.activeSellFormula(), nums: p.nums, reentry: slotsApi.activeReentry(), exitRules: slotsApi.activeExitRules(), startHeld: slotsApi.activeStartHeld() }, null);
      });
      var normDate = function (v) { var d = String(v || "").replace(/\D/g, ""); return d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : ""; };
      var fromVal = normDate((document.getElementById("bt-from") || {}).value);
      var toVal = normDate((document.getElementById("bt-to") || {}).value);
      var periodYears = parseInt((document.getElementById("bt-period") || {}).value || "3", 10);
      var isRolling = ((document.getElementById("bt-mode") || {}).value || "normal") === "rolling";
      runBtn.disabled = true;
      if (runAllBtn) runAllBtn.disabled = true;
      results.innerHTML = '<p class="bt-res-note">全パターンを実行中…（' + patterns.length.toLocaleString("ja-JP") + '通り）</p>';
      function windowed(title, rows, judgeRows) {
        if (!rows || !rows.length) return { title: title, rows: null, noData: "日足データがまだありません。自動更新で蓄積されてから実行できます。" };
        if (isRolling) return { title: title, rows: rows, judgeRows: judgeRows || null };
        var lastDate = rows[rows.length - 1][0];
        var startDate = fromVal || rows[0][0];
        var endDate = toVal || lastDate;
        var fromIdx = rows.findIndex(function (r) { return r[0] >= startDate; });
        var toIdx = -1;
        for (var i = rows.length - 1; i >= 0; i--) { if (rows[i][0] <= endDate) { toIdx = i; break; } }
        if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) {
          return { title: title, rows: null, noData: "指定期間のデータがありません（保有データ：" + rows[0][0] + " 〜 " + lastDate + "）。" };
        }
        return { title: title, rows: rows, judgeRows: judgeRows || null, fromIdx: fromIdx, toIdx: toIdx };
      }
      // ---- Rolling variant of the all-patterns sweep (GRW 2026-11-23):
      // every pattern runs on every start date with the bt-roll-horizon
      // window, then results are aggregated across start dates (each start
      // date first averaged across targets, like runRolling). Per-date
      // entries are not kept in memory; a start date's per-stock results
      // are recomputed on demand when its row is clicked.
      function startRollAll(rawTargets) {
        var horizon = parseInt((document.getElementById("bt-roll-horizon") || {}).value || "21", 10);
        var validTargets = rawTargets.filter(function (t) { return t.rows; });
        var lo = null, hi = null;
        validTargets.forEach(function (t) { if (t.rows.length) { if (!lo || t.rows[0][0] > lo) lo = t.rows[0][0]; if (!hi || t.rows[t.rows.length - 1][0] < hi) hi = t.rows[t.rows.length - 1][0]; } });
        var rollFrom = fromVal || lo || "";
        var rollTo = toVal || hi || "9999-12-31";
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
          t.rows.forEach(function (r) { if (r[0] >= rollFrom && r[0] <= rollTo) gridSet.add(r[0]); });
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
            return { title: t.title, out: runBacktest(t.rows, Object.assign({ fromIdx: w.fromIdx, toIdx: w.toIdx, judgeRows: t.judgeRows || null }, p.cfg)) };
          });
        }
        function statOf(entries) {
          var a = aggregate(entries);
          if (!a) return null;
          return { n: a.n, ret: a.ret, bh: a.bh, closed: a.closed, open: a.open, winRate: a.winRate, maxDd: a.maxDd, sharpe: a.sharpe, bhMaxDd: a.bhMaxDd, bhSharpe: a.bhSharpe, avgHold: a.avgHold, calmar: a.calmar, bhCalmar: a.bhCalmar, bhClosed: a.bhClosed, bhAvgHold: a.bhAvgHold };
        }
        function meanOf(vals) { return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null; }
        function medianOf(vals) {
          if (!vals.length) return null;
          var s = vals.slice().sort(function (a, b) { return a - b; });
          return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
        }
        function aggOf(stats, retKey, ddKey, shKey, cmKey) {
          var rets = stats.map(function (s) { return s[retKey]; });
          return {
            ret: meanOf(rets), median: medianOf(rets),
            winRate: rets.length ? rets.filter(function (v) { return v > 0; }).length / rets.length : null,
            worst: rets.length ? Math.min.apply(null, rets) : null,
            best: rets.length ? Math.max.apply(null, rets) : null,
            maxDd: meanOf(stats.map(function (s) { return s[ddKey]; })),
            sharpe: meanOf(stats.map(function (s) { return s[shKey]; }).filter(function (v) { return v != null; })),
            avgHold: meanOf(stats.map(function (s) { return s.avgHold; }).filter(function (v) { return v != null; })),
            bhClosed: meanOf(stats.map(function (s) { return s.bhClosed; })),
            bhAvgHold: meanOf(stats.map(function (s) { return s.bhAvgHold; }).filter(function (v) { return v != null; })),
            calmar: meanOf(stats.map(function (s) { return s[cmKey]; }).filter(function (v) { return v != null; }))
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
            var a = aggOf(stats, "ret", "maxDd", "sharpe", "calmar");
            a.closed = meanOf(stats.map(function (s) { return s.closed; }));
            p.rollAgg = a;
          });
          renderRollAll();
        }
        function renderRollAll() {
          var ddTxt = function (v) { return v == null ? "—" : v > 0 ? "-" + (v * 100).toFixed(2) + "%" : "0.00%"; };
          var AXIS_LABEL = { rsiGe: "買いRSI", vol15: "出来高条件", bounceClose: "前日σ下落（引け）", dd: "DD以下", ftd: "FTD", ma50: "MA日数", loss8: "買値から%", dropPct: "前日終値から%", highPct: "52週高値から%", ddGe: "DD以上", rsiLe: "売りRSI", maCross: "MAクロス期間", emaCross: "9EMA>21EMA", maCrossDn: "MAクロス期間", emaCrossDn: "9EMA<21EMA", macdCross: "MACDクロス", macdCrossDn: "MACDクロス", bollinger: "ボリンジャーσ", bollingerUp: "ボリンジャーσ", breakout: "ブレイク日数", takeProfit: "利確%", holdDays: "保有日数", priceMa: "株価MA日数" };
          function groupedHeat(gi) {
            var dB = dims[gi.rsiGe], dS = dims[gi.rsiLe], dD = dims[gi.ddGe];
            var stateTxt = function (dim, si) { var v = dim.states[si]; return v === null ? "なし" : v === "on" ? "あり" : v; };
            var maxAbs = 0;
            patterns.forEach(function (p) { if (p.rollAgg && p.rollAgg.ret != null && !mtExcluded(p.rollAgg.closed) && Math.abs(p.rollAgg.ret) > maxAbs) maxAbs = Math.abs(p.rollAgg.ret); });
            var out = "";
            dD.states.forEach(function (_, di) {
              var grid = {}, best = null;
              patterns.forEach(function (p) {
                if (!p.rollAgg || p.rollAgg.ret == null || p.st[gi.ddGe] !== di || mtExcluded(p.rollAgg.closed)) return;
                grid[p.st[gi.rsiGe] + "," + p.st[gi.rsiLe]] = p;
                if (!best || p.rollAgg.ret > best.rollAgg.ret) best = p;
              });
              if (!Object.keys(grid).length) return;
              var dv = dD.states[di];
              out += '<p style="font-weight:600;font-size:13px;margin:12px 0 4px">' + (dv === null ? "DD条件なし" : "DD（売り抜け日）が" + dv + "以上（直近25取引日）") + '</p>';
              out += '<table class="bt-sweep-matrix bt-all-matrix"><thead><tr><th>買いRSI ＼ 売りRSI</th>';
              dS.states.forEach(function (_, bi) { out += "<th>" + esc(stateTxt(dS, bi)) + "</th>"; });
              out += "</tr></thead><tbody>";
              dB.states.forEach(function (_, ai) {
                out += "<tr><th>" + esc(stateTxt(dB, ai)) + "</th>";
                dS.states.forEach(function (_, bi) {
                  var p = grid[ai + "," + bi];
                  if (!p || !p.rollAgg || p.rollAgg.ret == null) { out += '<td class="na">—</td>'; return; }
                  var r = p.rollAgg.ret;
                  var alpha = maxAbs > 0 ? Math.min(0.85, Math.abs(r) / maxAbs * 0.85) : 0;
                  var bg = r > 0 ? "background:rgba(22,163,74," + alpha.toFixed(2) + ")" : r < 0 ? "background:rgba(220,38,38," + alpha.toFixed(2) + ")" : "";
                  var title = "プラスの開始日 " + (p.rollAgg.winRate == null ? "—" : (p.rollAgg.winRate * 100).toFixed(0) + "%") + " / 平均取引 " + (p.rollAgg.closed == null ? "—" : p.rollAgg.closed.toFixed(1)) + "回";
                  out += '<td data-pidx="' + patterns.indexOf(p) + '" data-ai="' + ai + '" data-bi="' + bi + '"' + (p === best ? ' class="best"' : '') + ' style="' + bg + '" title="' + esc(title) + '">' + (r * 100).toFixed(1) + "%</td>";
                });
                out += "</tr>";
              });
              out += "</tbody></table>";
            });
            return out;
          }
          function heatHtml() {
            if (dims.length === 3) {
              var gi = {}; dims.forEach(function (d, ix) { gi[d.id] = ix; });
              if (gi.rsiGe != null && gi.rsiLe != null && gi.ddGe != null) return groupedHeat(gi);
            }
            if (dims.length < 1 || dims.length > 2) return "";
            var dA = dims[0], dB = dims.length === 2 ? dims[1] : null;
            var grid = {};
            var maxAbs = 0;
            patterns.forEach(function (p) {
              if (!p.rollAgg || p.rollAgg.ret == null || mtExcluded(p.rollAgg.closed)) return;
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
                hh += '<td data-pidx="' + patterns.indexOf(p) + '" data-ai="' + ai + '" data-bi="' + bi + '" style="' + bg + '" title="' + esc(title) + '">' + (r * 100).toFixed(1) + "%</td>";
              });
              hh += "</tr>";
            });
            hh += "</tbody></table>";
            return hh;
          }
          var targetNames = rawTargets.map(function (t) { return t.title; });
          var exclN = (minTrades > 0 || zeroOnly) ? patterns.filter(function (p) { return p.rollAgg && !p.st.every(function (v) { return v === 0; }) && mtExcluded(p.rollAgg.closed); }).length : 0;
          var html = '<p class="bt-res-note">全パターン検証（ローリング） ' + patterns.length.toLocaleString("ja-JP") + '通り × ' + rollDates.length.toLocaleString("ja-JP") + '開始日 / 銘柄：' + targetNames.join("、") + '<br>開始日を1営業日ずつずらし、各回' + horizon + '営業日で全パターンを実行しました。値は開始日ごとの結果（対象銘柄の平均）を開始日間で集計したものです。勝率は平均リターンがプラスだった開始日の割合です（スクリーニングは今の設定で固定、判定できない項目は除きます）。</p>';
          if (exclN > 0) html += '<p class="bt-res-note">' + (zeroOnly ? '平均取引回数0回の' : '平均取引回数' + minTrades + '回未満の') + exclN + '件を除外しています。</p>';
          html += heatHtml();
          html += '<table class="bt-res-table bt-rollall-table"><thead><tr>'
            + '<th data-k="no">番号</th><th data-k="label">パターン</th><th data-k="ret">平均</th><th data-k="median">中央値</th><th data-k="winRate">勝率</th><th data-k="best">最大</th><th data-k="worst">最小</th><th data-k="closed">取引回数</th><th data-k="maxDd">最大DD</th><th data-k="avgHold">平均保有</th><th data-k="sharpe">シャープ</th><th data-k="calmar">カルマー</th>'
            + '</tr></thead><tbody></tbody></table>';
          html += '<p class="bt-res-note">判定は終値、売買は翌営業日の始値です（σ下落の買いは当日の終値で買います）。手数料・税金は含みません。取引回数は開始日ごとの平均です。行を選ぶと、そのパターンの開始日別結果を表示します。</p>';
          html += '<div id="bt-all-detail"></div>';
          results.innerHTML = html;
          var tbody = results.querySelector(".bt-rollall-table tbody");
          var flex = setupFlexTable(results.querySelector(".bt-rollall-table"), ["no", "label", "ret", "median", "winRate", "best", "worst", "closed", "maxDd", "avgHold", "sharpe", "calmar"], "allroll");
          var sortKey = "sharpe", sortDir = -1;
          var CAP = 300;
          function isAllOff(p) { return p.st.every(function (v) { return v === 0; }); }
          function rowHtml(p, i) {
            var a = p.rollAgg;
            if (!a || a.ret == null) return '<tr class="bt-all-row"><td>' + (i + 1) + '</td><td class="bt-pat-label" title="' + esc(p.label) + '" style="text-align:left">' + esc(p.label) + '</td><td colspan="7" style="text-align:left">データがありませんでした</td></tr>';
            var bh = isAllOff(p);
            return '<tr class="bt-all-row' + (bh ? " bt-bh-row" : "") + '"><td>' + (i + 1) + '</td>' + (bh ? '<td style="text-align:left">買い持ち</td>' : '<td class="bt-pat-label" title="' + esc(p.label) + '" style="text-align:left">' + esc(p.label) + "</td>") + "<td>" + pct(a.ret) + "</td><td>" + pct(a.median) + "</td><td>"
              + (a.winRate == null ? "—" : pct(a.winRate, 0)) + "</td><td>" + pct(a.best) + "</td><td>" + pct(a.worst) + "</td><td>" + (a.closed == null ? "—" : a.closed.toFixed(1)) + "</td><td>" + ddTxt(a.maxDd) + "</td><td>" + (a.avgHold == null ? "—" : a.avgHold.toFixed(0) + "日") + "</td><td>" + sharpeTxt(a.sharpe) + "</td><td>" + sharpeTxt(a.calmar) + "</td></tr>";
          }
          function renderRows() {
            var arr = patterns.slice();
            arr.sort(function (x, y) {
              if (sortKey === "label") return x.label < y.label ? sortDir : x.label > y.label ? -sortDir : 0;
              var xv = x.rollAgg ? x.rollAgg[sortKey] : null;
              var yv = y.rollAgg ? y.rollAgg[sortKey] : null;
              if (xv == null && yv == null) return 0;
              if (xv == null) return 1;
              if (yv == null) return -1;
              return (xv - yv) * sortDir;
            });
            var arrF = arr.filter(function (p) { return isAllOff(p) || !p.rollAgg || !mtExcluded(p.rollAgg.closed); });
            var shown = arrF.slice(0, CAP);
            tbody.innerHTML = shown.map(function (p, i) { return rowHtml(p, i); }).join("") + (arrF.length > CAP ? '<tr><td colspan="9" style="text-align:left">上位' + CAP + '件を表示しています（全' + arrF.length.toLocaleString("ja-JP") + '通り）。並び替えると上位が入れ替わります。</td></tr>' : "");
            if (flex) flex.restamp();
            tbody.querySelectorAll(".bt-all-row").forEach(function (tr, i) {
              tr.addEventListener("click", function () { selectRollPattern(shown[i]); });
            });
            results.querySelectorAll(".bt-rollall-table th").forEach(function (th) {
              var labels = { no: "番号", label: "パターン", ret: "平均", median: "中央値", winRate: "勝率", best: "最大", worst: "最小", closed: "取引回数", maxDd: "最大DD", avgHold: "平均保有", sharpe: "シャープ", calmar: "カルマー" };
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
            html += '<table class="bt-res-table bt-rollall-dates"><thead><tr><th>開始日</th><th>対象銘柄数</th><th>リターン</th><th>買い持ち</th><th>取引回数</th><th>勝率</th><th>最大DD</th><th>平均保有</th><th>シャープ</th><th>カルマー</th></tr></thead><tbody>';
            rollDates.forEach(function (rd, di) {
              var s = p.rollStats && p.rollStats[di];
              if (!s) { html += '<tr class="bt-rollall-date-row" data-roll-di="' + di + '"><td>' + rd.date + '</td><td colspan="9" style="text-align:left">データがありませんでした</td></tr>'; return; }
              html += '<tr class="bt-rollall-date-row" data-roll-di="' + di + '"><td>' + rd.date + '</td><td>' + s.n + '</td><td>' + pct(s.ret) + '</td><td>' + pct(s.bh) + '</td><td>' + s.closed + (s.open ? "（+保有中" + s.open + "）" : "") + '</td><td>' + (s.winRate == null ? "—" : pct(s.winRate, 0)) + '</td><td>' + ddTxt(s.maxDd) + '</td><td>' + (s.avgHold == null ? "—" : s.avgHold.toFixed(0) + "日") + '</td><td>' + sharpeTxt(s.sharpe) + '</td><td>' + sharpeTxt(s.calmar) + '</td></tr>';
            });
            html += '</tbody></table>';
            html += '<p class="bt-res-note">開始日の行を選ぶと、その開始日の銘柄別結果を表示します。</p>';
            html += '<div class="bt-rollall-stocks"></div>';
            detail.innerHTML = html;
            setupFlexTable(detail.querySelector(".bt-rollall-dates"), ["start", "n", "ret", "bh", "count", "win", "maxdd", "avgHold", "sharpe", "calmar"], "allrolldates");
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
          results.querySelectorAll(".bt-all-matrix").forEach(function (matrix) {
            matrix.querySelectorAll("td[data-pidx]").forEach(function (td) {
              var found = patterns[parseInt(td.getAttribute("data-pidx"), 10)];
              td.addEventListener("click", function () {
                results.querySelectorAll(".bt-all-matrix td").forEach(function (x) { x.classList.remove("sel"); });
                td.classList.add("sel");
                if (found) selectRollPattern(found);
              });
            });
          });
          var bestP = null;
          patterns.forEach(function (p) { if (p.rollAgg && p.rollAgg.ret != null && (!bestP || p.rollAgg.ret > bestP.rollAgg.ret)) bestP = p; });
          if (bestP) results.querySelectorAll(".bt-all-matrix td[data-pidx]").forEach(function (td) { if (patterns[parseInt(td.getAttribute("data-pidx"), 10)] === bestP) td.classList.add("best"); });
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
            return withJudge(code, (data && data.rows) || []).then(function (r) { return windowed(esc(code) + (nm ? " " + esc(nm) : ""), r.rows, r.judgeRows); });
          }).catch(function () {
            var nm = names[code] || ETF_NAMES[code] || "";
            return { title: esc(code) + (nm ? " " + esc(nm) : ""), rows: null, noData: "日足データがまだありません。自動更新で蓄積されてから実行できます。" };
          });
        });
        return Promise.all(jobs).then(function (targets) { return targets; });
      }).then(function (targets) {
        if (!indexKeys.length) return targets;
        var endYear = toVal ? +toVal.slice(0, 4) : new Date().getFullYear();
        var startYear = fromVal ? +fromVal.slice(0, 4) : 1992;
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
            return t.rows ? { title: t.title, out: runBacktest(t.rows, Object.assign({ fromIdx: t.fromIdx, toIdx: t.toIdx, judgeRows: t.judgeRows || null }, p.cfg)) } : { title: t.title, out: null, noData: t.noData };
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
          var AXIS_LABEL = { rsiGe: "買いRSI", vol15: "出来高条件", bounceClose: "前日σ下落（引け）", dd: "DD以下", ftd: "FTD", ma50: "MA日数", loss8: "買値から%", dropPct: "前日終値から%", highPct: "52週高値から%", ddGe: "DD以上", rsiLe: "売りRSI", maCross: "MAクロス期間", emaCross: "9EMA>21EMA", maCrossDn: "MAクロス期間", emaCrossDn: "9EMA<21EMA", macdCross: "MACDクロス", macdCrossDn: "MACDクロス", bollinger: "ボリンジャーσ", bollingerUp: "ボリンジャーσ", breakout: "ブレイク日数", takeProfit: "利確%", holdDays: "保有日数", priceMa: "株価MA日数" };
          function groupedHeat(gi) {
            var dB = dims[gi.rsiGe], dS = dims[gi.rsiLe], dD = dims[gi.ddGe];
            var stateTxt = function (dim, si) { var v = dim.states[si]; return v === null ? "なし" : v === "on" ? "あり" : v; };
            var maxAbs = 0;
            patterns.forEach(function (p) { if (p.agg && !mtExcluded(p.agg.closed) && Math.abs(p.agg.ret) > maxAbs) maxAbs = Math.abs(p.agg.ret); });
            var out = "";
            dD.states.forEach(function (_, di) {
              var grid = {}, best = null;
              patterns.forEach(function (p) {
                if (!p.agg || p.st[gi.ddGe] !== di || mtExcluded(p.agg.closed)) return;
                grid[p.st[gi.rsiGe] + "," + p.st[gi.rsiLe]] = p;
                if (!best || p.agg.ret > best.agg.ret) best = p;
              });
              if (!Object.keys(grid).length) return;
              var dv = dD.states[di];
              out += '<p style="font-weight:600;font-size:13px;margin:12px 0 4px">' + (dv === null ? "DD条件なし" : "DD（売り抜け日）が" + dv + "以上（直近25取引日）") + '</p>';
              out += '<table class="bt-sweep-matrix bt-all-matrix"><thead><tr><th>買いRSI ＼ 売りRSI</th>';
              dS.states.forEach(function (_, bi) { out += "<th>" + esc(stateTxt(dS, bi)) + "</th>"; });
              out += "</tr></thead><tbody>";
              dB.states.forEach(function (_, ai) {
                out += "<tr><th>" + esc(stateTxt(dB, ai)) + "</th>";
                dS.states.forEach(function (_, bi) {
                  var p = grid[ai + "," + bi];
                  if (!p || !p.agg) { out += '<td class="na">—</td>'; return; }
                  var r = p.agg.ret;
                  var alpha = maxAbs > 0 ? Math.min(0.85, Math.abs(r) / maxAbs * 0.85) : 0;
                  var bg = r > 0 ? "background:rgba(22,163,74," + alpha.toFixed(2) + ")" : r < 0 ? "background:rgba(220,38,38," + alpha.toFixed(2) + ")" : "";
                  var title = "勝率 " + (p.agg.winRate == null ? "—" : (p.agg.winRate * 100).toFixed(0) + "%") + " / 取引 " + p.agg.closed + "回";
                  out += '<td data-pidx="' + patterns.indexOf(p) + '" data-ai="' + ai + '" data-bi="' + bi + '"' + (p === best ? ' class="best"' : '') + ' style="' + bg + '" title="' + esc(title) + '">' + (r * 100).toFixed(1) + "%</td>";
                });
                out += "</tr>";
              });
              out += "</tbody></table>";
            });
            return out;
          }
          function heatHtml() {
            if (dims.length === 3) {
              var gi = {}; dims.forEach(function (d, ix) { gi[d.id] = ix; });
              if (gi.rsiGe != null && gi.rsiLe != null && gi.ddGe != null) return groupedHeat(gi);
            }
            if (dims.length < 1 || dims.length > 2) return "";
            var dA = dims[0], dB = dims.length === 2 ? dims[1] : null;
            var grid = {};
            var maxAbs = 0;
            patterns.forEach(function (p) {
              if (!p.agg || mtExcluded(p.agg.closed)) return;
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
                hh += '<td data-pidx="' + patterns.indexOf(p) + '" data-ai="' + ai + '" data-bi="' + bi + '" style="' + bg + '" title="' + esc(title) + '">' + (r * 100).toFixed(1) + "%</td>";
              });
              hh += "</tr>";
            });
            hh += "</tbody></table>";
            return hh;
          }
          var targetNames = targets.map(function (t) { return t.title; });
          var exclN = (minTrades > 0 || zeroOnly) ? patterns.filter(function (p) { return p.agg && !p.st.every(function (v) { return v === 0; }) && mtExcluded(p.agg.closed); }).length : 0;
          var html = '<p class="bt-res-note">全パターン検証（' + patterns.length.toLocaleString("ja-JP") + '通り） / 銘柄：' + targetNames.join("、") + '<br>チェックした買い・売り項目の ON/OFF とパラメータの全組合せです（スクリーニングは今の設定で固定、判定できない項目は除きます）。' + (targetNames.length > 1 ? '複数銘柄の値は平均です（勝率・平均損益・平均保有は全取引の合算、取引回数は合計）。' : '') + '</p>';
          if (exclN > 0) html += '<p class="bt-res-note">' + (zeroOnly ? '取引回数0回の' : '取引回数' + minTrades + '回未満の') + exclN + '件を除外しています。</p>';
          html += heatHtml();
          html += '<table class="bt-res-table bt-all-table"><thead><tr>'
            + '<th data-k="no">番号</th><th data-k="label">パターン</th><th data-k="ret">リターン</th><th data-k="winRate">勝率</th><th data-k="closed">取引回数</th><th data-k="avgRet">平均損益</th><th data-k="maxDd">最大DD</th><th data-k="avgHold">平均保有</th><th data-k="sharpe">シャープ</th><th data-k="calmar">カルマー</th>'
            + '</tr></thead><tbody></tbody></table>';
          html += '<p class="bt-res-note">判定は終値、売買は翌営業日の始値です（σ下落の買いは当日の終値で買います）。手数料・税金は含みません。行を選ぶと、そのパターンの銘柄別結果を表示します。</p>';
          html += '<div id="bt-all-detail"></div>';
          results.innerHTML = html;
          var tbody = results.querySelector(".bt-all-table tbody");
          var flex = setupFlexTable(results.querySelector(".bt-all-table"), ["no", "label", "ret", "winRate", "closed", "avgRet", "maxDd", "avgHold", "sharpe", "calmar"], "all");
          var sortKey = "sharpe", sortDir = -1;
          var CAP = 300;
          function isAllOff(p) { return p.st.every(function (v) { return v === 0; }); }
          function rowHtml(p, i) {
            var a = p.agg;
            if (!a) return '<tr class="bt-all-row"><td>' + (i + 1) + '</td><td class="bt-pat-label" title="' + esc(p.label) + '" style="text-align:left">' + esc(p.label) + '</td><td colspan="7" style="text-align:left">データがありませんでした</td></tr>';
            var bh = isAllOff(p);
            return '<tr class="bt-all-row' + (bh ? " bt-bh-row" : "") + '"><td>' + (i + 1) + '</td>' + (bh ? '<td style="text-align:left">買い持ち</td>' : '<td class="bt-pat-label" title="' + esc(p.label) + '" style="text-align:left">' + esc(p.label) + "</td>") + "<td>" + pct(a.ret) + "</td><td>"
              + (a.winRate == null ? "—" : pct(a.winRate, 0)) + "</td><td>" + a.closed + (a.open ? "（+保有中" + a.open + "）" : "") + "</td><td>"
              + (a.avgRet == null ? "—" : pct(a.avgRet)) + "</td><td>" + ddTxt(a.maxDd) + "</td><td>"
              + (a.avgHold == null ? "—" : a.avgHold.toFixed(0) + "日") + "</td><td>" + sharpeTxt(a.sharpe) + "</td><td>" + sharpeTxt(a.calmar) + "</td></tr>";
          }
          function renderRows() {
            var arr = patterns.slice();
            arr.sort(function (x, y) {
              if (sortKey === "label") return x.label < y.label ? sortDir : x.label > y.label ? -sortDir : 0;
              var xv = x.agg ? x.agg[sortKey] : null;
              var yv = y.agg ? y.agg[sortKey] : null;
              if (xv == null && yv == null) return 0;
              if (xv == null) return 1;
              if (yv == null) return -1;
              return (xv - yv) * sortDir;
            });
            var arrF = arr.filter(function (p) { return isAllOff(p) || !p.agg || !mtExcluded(p.agg.closed); });
            var shown = arrF.slice(0, CAP);
            tbody.innerHTML = shown.map(function (p, i) { return rowHtml(p, i); }).join("") + (arrF.length > CAP ? '<tr><td colspan="9" style="text-align:left">上位' + CAP + '件を表示しています（全' + arrF.length.toLocaleString("ja-JP") + '通り）。並び替えると上位が入れ替わります。</td></tr>' : "");
            if (flex) flex.restamp();
            tbody.querySelectorAll(".bt-all-row").forEach(function (tr, i) {
              tr.addEventListener("click", function () { selectPattern(shown[i]); });
            });
            results.querySelectorAll(".bt-all-table th").forEach(function (th) {
              var labels = { no: "番号", label: "パターン", ret: "リターン", winRate: "勝率", closed: "取引回数", avgRet: "平均損益", maxDd: "最大DD", avgHold: "平均保有", sharpe: "シャープ", calmar: "カルマー" };
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
          results.querySelectorAll(".bt-all-matrix").forEach(function (matrix) {
            matrix.querySelectorAll("td[data-pidx]").forEach(function (td) {
              var found = patterns[parseInt(td.getAttribute("data-pidx"), 10)];
              td.addEventListener("click", function () {
                results.querySelectorAll(".bt-all-matrix td").forEach(function (x) { x.classList.remove("sel"); });
                td.classList.add("sel");
                if (found) selectPattern(found);
              });
            });
          });
          var bestP = null;
          patterns.forEach(function (p) { if (p.agg && (!bestP || p.agg.ret > bestP.agg.ret)) bestP = p; });
          if (bestP) results.querySelectorAll(".bt-all-matrix td[data-pidx]").forEach(function (td) { if (patterns[parseInt(td.getAttribute("data-pidx"), 10)] === bestP) td.classList.add("best"); });
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
