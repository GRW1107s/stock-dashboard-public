/* US GICS industry analysis panels (業種分析① Industry / 業種分析② Sub-Industry).
   Mirrors the JP industry panels on jp-sectors.html: period strength
   rankings (3/10/25 sessions) with rank-movement bridges, a 25-session
   judgement history matrix, and a sortable daily table. Data comes from
   us-industries.json / us-industries-fine.json (see
   scripts/update_us_industries.py); the benchmark is the S&P 500.
   Clicking an industry name filters the screener below to that industry. */
(function (root) {
  "use strict";
  const hasNum = v => typeof v === "number" && Number.isFinite(v);
  const fmt = v => hasNum(v) ? (v > 0 ? "+" : "") + v.toFixed(2) + "%" : "—";
  const cls = v => !hasNum(v) ? "na" : v > 0 ? "pos" : v < 0 ? "neg" : "";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const display = name => (root.StockIndustryJA ? root.StockIndustryJA.display(name) : name);
  function compoundedReturns(changes) {
    if (changes.length === 0 || changes.some(v => !hasNum(v) || v <= -100)) return null;
    return (changes.reduce((p, v) => p * (1 + v / 100), 1) - 1) * 100;
  }
  function ddCircle(number) {
    if (typeof number !== "number" || !Number.isInteger(number) || number < 0) return '<span class="na">—</span>';
    return '<span class="dd-dot" title="有効DD ' + number + '件" aria-label="DD ' + number + '件">' + number + "</span>";
  }
  function badge(v) {
    if (v?.dd_number) return '<span class="signal-cell">' + ddCircle(v.dd_number) + "</span>";
    if (v?.judge === "sell") return '<span class="dot sell">×</span>';
    if (v?.judge === "ftd") return '<span class="ftd">FTD</span>';
    if (v?.judge === "buy") return '<span class="dot buy">✓</span>';
    return '<span class="na">—</span>';
  }
  function historyMark(v) {
    if (!v) return "";
    if (v.judge === "ftd") return '<span class="ftd">FTD</span>';
    if (v.dd_number) return '<span class="dd-cell-number">' + v.dd_number + "</span>";
    return "";
  }
  function priceCell(v) {
    if (!v) return '<span class="na">—</span>';
    return '<div class="price ' + cls(v.change) + '">' + fmt(v.change) + '</div><div class="vol">(' + fmt(v.volume) + ")</div>";
  }

  function createPanel(cfg) {
    let rows = [], names = {};
    let visibleTableDays = 25, sortPeriod = "1", columnKeys = [], lastUpdated = "";
    const $ = id => document.getElementById(id);
    const keys = () => Object.keys(names);

    function buildPeriodRanks(period) {
      const recent = rows.slice(0, period);
      const bench = recent.length === period ? compoundedReturns(recent.map(r => r.benchmark_change)) : null;
      return keys().map(k => {
        const ret = recent.length === period ? compoundedReturns(recent.map(r => r.sectors?.[k]?.change)) : null;
        return { key: k, name: names[k], ret, diff: ret !== null && bench !== null ? ret - bench : null };
      }).filter(x => x.ret !== null).sort((a, b) => b.ret - a.ret || a.key.localeCompare(b.key));
    }

    function renderRankings() {
      const target = $(cfg.ids.rankings);
      if (!target) return;
      const rank25 = buildPeriodRanks(25), rank10 = buildPeriodRanks(10), rank3 = buildPeriodRanks(3);
      const leaderCutoff = Math.max(1, Math.ceil(keys().length / cfg.divisor));
      const laggardCutoff = Math.max(1, Math.ceil(keys().length / 3));
      const complete = [rank3, rank10, rank25].every(r => r.length === keys().length);
      const inTop = (ranked, cut) => new Set(ranked.slice(0, cut).map(v => v.key));
      const inBottom = (ranked, cut) => new Set(ranked.slice(-cut).map(v => v.key));
      const leaders = complete ? [...inTop(rank3, leaderCutoff)].filter(k => inTop(rank10, leaderCutoff).has(k) && inTop(rank25, leaderCutoff).has(k)) : [];
      const laggards = complete ? [...inBottom(rank3, laggardCutoff)].filter(k => inBottom(rank10, laggardCutoff).has(k) && inBottom(rank25, laggardCutoff).has(k)) : [];
      const leaderSet = new Set(leaders), laggardSet = new Set(laggards);
      const legend = $(cfg.ids.legendCount);
      if (legend) legend.textContent = "（上位" + leaderCutoff + "位）";
      function panel(period, ranked, previous, previousPeriod) {
        const prevRanks = new Map((previous || []).map((v, i) => [v.key, i + 1]));
        const entries = ranked.length ? ranked.map((v, i) => {
          const before = prevRanks.get(v.key);
          const movement = before === undefined ? null : before - (i + 1);
          const state = movement === null ? "" : movement > 0 ? "up" : movement < 0 ? "down" : "level";
          const indicator = movement === null ? "" : movement > 0 ? "↑" + movement : movement < 0 ? "↓" + Math.abs(movement) : "→";
          const shift = indicator ? '<span class="rank-shift ' + state + '" title="' + previousPeriod + '日順位との差">' + indicator + "</span>" : "";
          const marker = leaderSet.has(v.key)
            ? '<span class="rank-leader-marker" role="img" aria-label="3・10・25日のすべてで' + cfg.bandLabel + '" title="3・10・25日のすべてで' + cfg.bandLabel + '"></span>'
            : laggardSet.has(v.key)
              ? '<span class="rank-laggard-marker" role="img" aria-label="3・10・25日のすべてで下位3分の1" title="3・10・25日のすべてで下位3分の1"></span>' : "";
          const vs = v.diff === null ? "—" : "S&P500比 " + (v.diff > 0 ? "+" : "") + v.diff.toFixed(2) + "pp";
          return '<div class="rank-entry ind-jump" data-us-ind-jump="' + cfg.jumpId + '" data-ind-name="' + esc(v.key) + '" title="クリックでこの業種の銘柄スクリーニング"><span class="rank-position">' + (i + 1) + '</span><span class="rank-name" title="' + esc(v.key) + '">' + marker + '<span class="rank-name-text">' + esc(display(v.name)) + "</span>" + shift + '</span><span class="rank-return ' + cls(v.ret) + '">' + fmt(v.ret) + '</span><span class="rank-spy">' + vs + "</span></div>";
        }).join("") : '<p class="muted">期間内のデータが不足しています</p>';
        return '<section class="rank-panel" data-period="' + period + '"><div class="rank-header"><h2>直近' + period + '取引日 強さランキング</h2><p class="rank-note">業種指数の累積騰落率順｜S&P500比は同期間との差</p></div>' + entries + "</section>";
      }
      function bridge(oldPeriod, newPeriod) {
        return '<div class="rank-bridge" data-from="' + oldPeriod + '" data-to="' + newPeriod + '" aria-label="' + oldPeriod + '日から' + newPeriod + '日の順位変化"><div class="rank-link-head">' + newPeriod + "日 ← " + oldPeriod + '日<br>緑：順位上昇／赤：下降</div><svg class="rank-link-svg" role="img" aria-label="業種順位の移動"></svg></div>';
      }
      target.innerHTML = panel(3, rank3, rank10, 10) + bridge(10, 3) + panel(10, rank10, rank25, 25) + bridge(25, 10) + panel(25, rank25, null, null);
      requestAnimationFrame(() => drawArrows());
    }

    function drawArrows() {
      const rootEl = $(cfg.ids.rankings);
      if (!rootEl) return;
      for (const bridge of rootEl.querySelectorAll(".rank-bridge")) {
        const svg = bridge.querySelector("svg.rank-link-svg");
        if (!svg || getComputedStyle(bridge).display === "none") continue;
        const from = bridge.dataset.from, to = bridge.dataset.to;
        const oldPanel = rootEl.querySelector('.rank-panel[data-period="' + from + '"]');
        const newPanel = rootEl.querySelector('.rank-panel[data-period="' + to + '"]');
        if (!oldPanel || !newPanel) continue;
        const oldRows = [...oldPanel.querySelectorAll(".rank-entry[data-ind-name]")];
        const newRows = [...newPanel.querySelectorAll(".rank-entry[data-ind-name]")];
        if (!oldRows.length || !newRows.length) { svg.innerHTML = ""; continue; }
        const bottom = Math.max(oldRows[oldRows.length - 1].getBoundingClientRect().bottom, newRows[newRows.length - 1].getBoundingClientRect().bottom);
        const top = svg.getBoundingClientRect().top;
        const height = Math.max(1, Math.ceil(bottom - top) + 2);
        svg.style.height = height + "px";
        const rect = svg.getBoundingClientRect();
        const width = rect.width;
        if (width < 8) continue;
        svg.setAttribute("viewBox", "0 0 " + width + " " + height);
        svg.setAttribute("preserveAspectRatio", "none");
        const nextRanks = new Map(newRows.map((row, i) => [row.dataset.indName, { row, rank: i + 1 }]));
        const colors = { up: "#15803d", down: "#dc2626", flat: "#94a3b8" };
        svg.innerHTML = oldRows.map((row, i) => {
          const match = nextRanks.get(row.dataset.indName);
          if (!match) return "";
          const before = i + 1, after = match.rank;
          const state = after < before ? "up" : after > before ? "down" : "flat";
          const y1 = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 - rect.top;
          const r2 = match.row.getBoundingClientRect();
          const y2 = r2.top + r2.height / 2 - rect.top;
          const label = row.dataset.indName + ": " + from + "日" + before + "位 → " + to + "日" + after + "位";
          return '<path d="M' + (width - 3) + " " + y1 + " C" + (width * .68) + " " + y1 + "," + (width * .32) + " " + y2 + "," + 4 + " " + y2 + '" fill="none" stroke="' + colors[state] + '" stroke-width="1.5" opacity=".72"><title>' + esc(label) + "</title></path>";
        }).join("");
      }
    }

    function renderSummary() {
      const el = $(cfg.ids.histories);
      if (!el) return;
      const selected = rows.slice(0, 25);
      const aligned = selected.concat(Array.from({ length: 25 - selected.length }, () => null));
      const dates = aligned.map(r => '<span class="history-date">' + (r ? r.date.slice(5).replace("-", "/") : "—") + "</span>").join("");
      const head = '<div class="history-row"><strong class="history-date-label">米国日付</strong><div class="blocks">' + dates + "</div></div>";
      const lines = keys().map(k => {
        const squares = aligned.map(r => {
          const v = r?.sectors?.[k];
          const kind = v?.judge === "ftd" ? "ftd" : v?.dd_number ? "sell" : ["buy", "sell"].includes(v?.judge) ? v.judge : "";
          const title = (r?.date || "—") + " " + k + " DD " + (v?.dd_count ?? "—") + "件 変動率" + fmt(v?.change) + " 出来高" + fmt(v?.volume) + " S&P500比" + (hasNum(v?.vs_benchmark) ? v.vs_benchmark.toFixed(2) + "pp" : "—");
          return '<span class="block ' + kind + " " + (v?.dd_number ? "dd-numbered dd-highlight" : "") + '" title="' + esc(title) + '">' + historyMark(v) + "</span>";
        }).join("");
        return '<div class="history-row"><strong class="ind-jump" data-us-ind-jump="' + cfg.jumpId + '" data-ind-name="' + esc(k) + '" title="クリックでこの業種の銘柄スクリーニング">' + esc(display(names[k])) + '</strong><div class="blocks">' + squares + "</div></div>";
      }).join("");
      el.innerHTML = head + lines;
    }

    function sortedKeys() {
      const base = keys();
      if (sortPeriod === "original") return base;
      const period = Number(sortPeriod);
      const recent = rows.slice(0, period);
      return base.map((key, index) => ({
        key, index,
        ret: recent.length === period ? compoundedReturns(recent.map(row => row.sectors?.[key]?.change)) : null
      })).sort((a, b) => {
        if (a.ret === null) return b.ret === null ? a.index - b.index : 1;
        if (b.ret === null) return -1;
        return b.ret - a.ret || a.index - b.index;
      }).map(item => item.key);
    }

    function rowHtml(r) {
      return "<tr><td class=\"date\">" + r.date.replaceAll("-", "/") + "</td>" +
        columnKeys.map(k => {
          const v = r.sectors?.[k];
          return "<td>" + priceCell(v) + "</td><td>" + badge(v) + "</td>";
        }).join("") + "</tr>";
    }

    function drawTable() {
      columnKeys = sortedKeys();
      const cols = $(cfg.ids.cols), head = $(cfg.ids.headrow), sub = $(cfg.ids.subhead), body = $(cfg.ids.body), status = $(cfg.ids.status);
      if (!cols || !head || !sub || !body) return;
      cols.innerHTML = '<col class="date-col">' + columnKeys.map(() => '<col class="price-col"><col class="judge-col">').join("");
      head.innerHTML = '<th rowspan="2" class="date">米国日付</th>' + columnKeys.map(k => '<th colspan="2"><span class="ind-jump" data-us-ind-jump="' + cfg.jumpId + '" data-ind-name="' + esc(k) + '" title="クリックでこの業種の銘柄スクリーニング">' + esc(display(names[k])) + "</span></th>").join("");
      sub.innerHTML = columnKeys.map(() => '<th title="変動率（出来高前日比）">変動率(量)</th><th title="判定">判定</th>').join("");
      const view = visibleTableDays ? rows.slice(0, visibleTableDays) : rows;
      body.innerHTML = view.length ? view.map(rowHtml).join("") : '<tr><td colspan="' + (1 + columnKeys.length * 2) + '">データがありません</td></tr>';
      if (status) {
        const label = sortPeriod === "original" ? "元の並び" : "直近" + sortPeriod + "取引日の強い順";
        status.textContent = view.length + "行表示 / 全" + rows.length + "行 / 列：" + label + (lastUpdated ? " / 最終更新 " + lastUpdated : "");
      }
    }

    function bindControls() {
      const wrap = $(cfg.ids.controls);
      if (!wrap) return;
      wrap.querySelectorAll("button[data-days]").forEach(btn => {
        btn.addEventListener("click", () => {
          visibleTableDays = Number(btn.dataset.days);
          wrap.querySelectorAll("button[data-days]").forEach(b => b.classList.toggle("active", b === btn));
          drawTable();
        });
      });
      const select = wrap.querySelector("select");
      if (select) select.addEventListener("change", () => { sortPeriod = select.value; drawTable(); });
    }

    fetch(cfg.url + "?t=" + Date.now(), { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data || !Array.isArray(data.rows)) return;
        rows = data.rows;
        names = data.names || {};
        lastUpdated = data.updated_at ? new Date(data.updated_at).toLocaleString("ja-JP") : "";
        renderRankings();
        renderSummary();
        bindControls();
        drawTable();
        if (window.AsofDate) {
          const allRows = rows;
          AsofDate.addDates(allRows.map(r => r.date));
          const applyAsof = () => {
            rows = AsofDate.sliceDesc(allRows);
            renderRankings();
            renderSummary();
            drawTable();
            AsofDate.setEffective(cfg.asofKey, AsofDate.effective(allRows));
          };
          AsofDate.onChange(applyAsof);
          if (AsofDate.get()) applyAsof();
        }
      })
      .catch(() => {});
    root.addEventListener("resize", () => requestAnimationFrame(() => drawArrows()));
    return { redrawArrows: drawArrows };
  }

  document.addEventListener("click", event => {
    const jumper = event.target.closest("[data-us-ind-jump]");
    if (!jumper) return;
    const id = jumper.getAttribute("data-us-ind-jump");
    const name = jumper.getAttribute("data-ind-name");
    const tabBtn = Array.from(document.querySelectorAll(".stock-dashboard-subtabs button")).find(b => b.textContent.trim() === "銘柄スクリーニング");
    if (tabBtn) tabBtn.click();
    if (typeof root.leaderScreenerSetIndustry === "function") {
      root.leaderScreenerSetIndustry(id, name);
    }
    document.getElementById("leader-screener-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  createPanel({
    url: "./us-industries.json", jumpId: "industry", divisor: 3, asofKey: "industry", bandLabel: "上位3分の1",
    ids: { rankings: "us-ind-period-rankings", histories: "us-ind-histories", cols: "us-ind-sector-cols", headrow: "us-ind-headrow", subhead: "us-ind-subhead", body: "us-ind-body", status: "us-ind-status", controls: "us-ind-controls", legendCount: "us-ind-legend-count" }
  });
  createPanel({
    url: "./us-industries-fine.json", jumpId: "industry2", divisor: 10, asofKey: "fine", bandLabel: "上位10分の1",
    ids: { rankings: "us-fine-period-rankings", histories: "us-fine-histories", cols: "us-fine-sector-cols", headrow: "us-fine-headrow", subhead: "us-fine-subhead", body: "us-fine-body", status: "us-fine-status", controls: "us-fine-controls", legendCount: "us-fine-legend-count" }
  });
})(typeof window !== "undefined" ? window : globalThis);
