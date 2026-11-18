// Backtest execution for jp-sectors.html.
//
// Reads the condition state from the backtest panel, loads the stored
// daily OHLCV (ohlcv/jp/<code>-T.json, written by the data pipeline) and
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
    sector: "所属セクターが上位を維持（緑丸）",
    tt1: "株価が150日・200日移動平均線より上",
    tt2: "150日MAが200日MAより上",
    tt3: "200日MAが少なくとも1か月上昇",
    tt4: "50日MAが150日・200日MAより上",
    tt5: "株価が50日MAより上",
    tt6: "52週安値から30%以上上昇",
    tt7: "52週高値から25%以内",
    tt8: "RS指数がしきい値以上"
  };
  var SELL_LABELS = {
    ma50: "株価が50日移動平均を下回る",
    loss8: "買値から8%下落",
    ma200: "株価が200日移動平均を下回る",
    rs70: "RS指数が70以下に低下",
    high25: "52週高値から25%以上下落",
    dd3: "出来高を伴う下落日（DD）が3日出る"
  };
  var BUY_EVALUABLE = { vol15: 1, tt1: 1, tt2: 1, tt3: 1, tt4: 1, tt5: 1, tt6: 1, tt7: 1 };
  var SELL_EVALUABLE = { ma50: 1, loss8: 1, ma200: 1, high25: 1, dd3: 1 };

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
  //       ddByDate:Map<date, ddCount>|null}
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
    var runBtn = document.getElementById("bt-run");
    var results = document.getElementById("bt-results");
    if (!runBtn || !results) return;

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
          (h.tse_rows || []).forEach(function (row) {
            var prime = row && row.prime;
            if (prime && prime.dd_count != null) map.set(row.date, prime.dd_count);
          });
        }).catch(function () {});
      });
      return Promise.all(jobs).then(function () { return map; });
    }

    runBtn.addEventListener("click", function () {
      var symbolsRaw = (document.getElementById("bt-symbols") || {}).value || "";
      var codes = symbolsRaw.split(/[\s,、，]+/).map(function (s) { return s.trim(); }).filter(Boolean)
        .map(function (s) { return s.replace(/\.T$/i, ""); });
      codes = Array.from(new Set(codes)).slice(0, 10);
      if (!codes.length) {
        results.innerHTML = '<p class="bt-res-note">銘柄コードを入力してから実行してください（対象セレクトだけでは実行できません）。</p>';
        return;
      }
      var buyAll = checked("buy"), sellAll = checked("sell"), marketAll = checked("market");
      var buy = buyAll.filter(function (id) { return BUY_EVALUABLE[id]; });
      var sell = sellAll.filter(function (id) { return SELL_EVALUABLE[id]; });
      var skipped = [];
      buyAll.filter(function (id) { return !BUY_EVALUABLE[id]; }).forEach(function (id) { skipped.push("買い：" + (BUY_LABELS[id] || id)); });
      sellAll.filter(function (id) { return !SELL_EVALUABLE[id]; }).forEach(function (id) { skipped.push("売り：" + (SELL_LABELS[id] || id)); });
      marketAll.filter(function (id) { return id !== "dd"; }).forEach(function (id) {
        skipped.push("市場：" + (id === "ad" ? "AD（買い集め日）" : id === "ftd" ? "FTD（フォロースルーデー）" : id));
      });
      if (!buy.length && !marketAll.includes("dd")) {
        results.innerHTML = '<p class="bt-res-note">判定できる買い条件が選択されていません。価格・出来高から判定できる条件（トレンドテンプレート、出来高など）を1つ以上選んでください。</p>';
        return;
      }
      if (!buy.length) buy = []; // market-DD-only: buy whenever DD allows
      var ddLimit = marketAll.includes("dd") ? numOf("dd") : null;
      var fromVal = (document.getElementById("bt-from") || {}).value || "";
      var toVal = (document.getElementById("bt-to") || {}).value || "";
      var periodYears = parseInt((document.getElementById("bt-period") || {}).value || "3", 10);

      runBtn.disabled = true;
      results.innerHTML = '<p class="bt-res-note">実行中…</p>';

      loadJson("sector-leaders.json").catch(function () { return null; }).then(function (leaders) {
        var names = {};
        ((leaders && leaders.jp) || []).forEach(function (r) {
          if (r.ticker) names[String(r.ticker).replace(/\.T$/, "")] = r.name || "";
        });
        var jobs = codes.map(function (code) {
          return loadJson("ohlcv/jp/" + code + "-T.json").then(function (data) {
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
        var html = "";
        ctx.loaded.forEach(function (item) {
          var title = esc(item.code) + (ctx.names[item.code] ? " " + esc(ctx.names[item.code]) : "");
          if (!item.rows) {
            html += '<div class="bt-res-block"><h4>' + title + '</h4><p class="bt-res-note">日足データがまだありません。自動更新で蓄積されてから実行できます。</p></div>';
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
            html += '<div class="bt-res-block"><h4>' + title + '</h4><p class="bt-res-note">指定期間のデータがありません（保有データ：' + esc(rows[0][0]) + " 〜 " + esc(lastDate) + '）。</p></div>';
            return;
          }
          var out = runBacktest(rows, {
            fromIdx: fromIdx, toIdx: toIdx, buy: buy, sell: sell,
            ddLimit: ddLimit, ddByDate: ctx.ddMap
          });
          var p = out.perf;
          html += '<div class="bt-res-block"><h4>' + title + '</h4>';
          html += '<p class="bt-res-range">期間：' + esc(out.range.from) + " 〜 " + esc(out.range.to) + "（" + out.range.sessions + '営業日）</p>';
          html += '<table class="bt-res-table"><thead><tr><th>戦略リターン</th><th>買い持ち</th><th>取引回数</th><th>勝率</th><th>平均損益</th><th>最大DD</th><th>平均保有</th></tr></thead><tbody><tr>' +
            "<td>" + pct(p.totalReturn) + "</td><td>" + pct(p.bhReturn) + "</td><td>" + p.closedCount + (p.hasOpen ? "（+保有中1）" : "") + "</td><td>" +
            (p.winRate == null ? "—" : pct(p.winRate, 0)) + "</td><td>" + (p.avgRet == null ? "—" : pct(p.avgRet)) + "</td><td>" + pct(p.maxDd) + "</td><td>" +
            (p.avgHold == null ? "—" : p.avgHold.toFixed(0) + "日") + "</td></tr></tbody></table>";
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
        });
        var applied = buy.map(function (id) { return BUY_LABELS[id] || id; })
          .concat(sell.map(function (id) { return "売り：" + (SELL_LABELS[id] || id); }));
        if (ddLimit != null) applied.push("市場：DDが" + ddLimit + "以下");
        html += '<p class="bt-res-note">適用した条件：' + esc(applied.join(" / ") || "なし") + "<br>判定は終値、売買は翌営業日の始値です。手数料・税金は含みません。</p>";
        if (skipped.length) {
          html += '<p class="bt-res-note">対象外（過去データがないため判定しませんでした）：' + esc(skipped.join(" / ")) + "</p>";
        }
        results.innerHTML = html;
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
