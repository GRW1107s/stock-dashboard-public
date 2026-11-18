// Shared "as-of date" state for the sector / industry / screener panels.
//
// Every panel registers the dates its own data covers; the union fills
// each .asof-select on the page. Changing any one select updates all of
// them (they are linked) and notifies panels through onChange. Panels
// re-render from their time series sliced at the selected date, or from
// the screener snapshot archive for that date. Empty value = latest.
(function () {
  "use strict";
  var selected = "";
  var dateSet = new Set();
  var selects = [];
  var listeners = [];

  function rebuild() {
    var dates = Array.from(dateSet).sort().reverse();
    selects.forEach(function (sel) {
      sel.innerHTML = '<option value="">最新</option>' + dates.map(function (d) {
        return '<option value="' + d + '">' + d + "</option>";
      }).join("");
      sel.value = selected;
    });
  }
  function set(date) {
    selected = date || "";
    selects.forEach(function (sel) { sel.value = selected; });
    listeners.forEach(function (fn) { try { fn(selected); } catch (e) {} });
  }
  function addDates(list) {
    var changed = false;
    (list || []).forEach(function (d) {
      if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !dateSet.has(d)) {
        dateSet.add(d); changed = true;
      }
    });
    if (changed) rebuild();
  }
  // Rows are descending by date. Returns the sub-array whose first row is
  // the selected date (or the nearest earlier one). Latest = all rows.
  function sliceDesc(rows) {
    if (!selected || !rows.length) return rows;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].date <= selected) return rows.slice(i);
    }
    return rows.slice(rows.length - 1);
  }
  function effective(rows) {
    var s = sliceDesc(rows);
    return s.length ? s[0].date : null;
  }
  function setEffective(key, date) {
    document.querySelectorAll('[data-asof-eff="' + key + '"]').forEach(function (el) {
      if (!selected || !date) { el.textContent = ""; return; }
      el.textContent = date === selected
        ? selected + "時点を表示中"
        : "最も近い" + date + "時点を表示中";
    });
  }

  window.AsofDate = {
    get: function () { return selected; },
    set: set,
    addDates: addDates,
    sliceDesc: sliceDesc,
    effective: effective,
    setEffective: setEffective,
    onChange: function (fn) { listeners.push(fn); },
    register: function (sel) {
      if (selects.indexOf(sel) >= 0) return;
      selects.push(sel);
      sel.addEventListener("change", function () { set(sel.value); });
      rebuild();
    }
  };

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("select.asof-select").forEach(function (sel) {
      window.AsofDate.register(sel);
    });
  });
})();
