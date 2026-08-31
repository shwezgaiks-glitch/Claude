// Content script for the Spoonflower "Spoondollar history" page. Injects a
// small sync panel above the transaction table, and — for the full backfill —
// drives the page's own date-range filter + search control programmatically,
// scraping and relaying each resulting table to the background worker.
//
// NOTE on selectors: the date inputs / search button locators below are
// best-effort heuristics (matched by nearby label text / visible text),
// since we haven't yet pinned down the exact markup of that filter form.
// If "Full Backfill" reports it can't find the controls, open the console
// for a diagnostic dump and tighten SELECTORS below against the real HTML.
(function () {
  "use strict";

  function findTable() {
    return document.querySelector("table.spoonclams");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function todayISO() {
    const d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  // Converts "YYYY-MM-DD" to "MM/DD/YYYY" — the format shown in the FROM/TO
  // DATE fields in the dashboard screenshot. Adjust here if the real inputs
  // expect a different format.
  function isoToDisplay(iso) {
    const [y, m, d] = iso.split("-");
    return `${m}/${d}/${y}`;
  }

  // Best-effort: find the two date inputs by scanning for "date"-ish
  // attributes/placeholders/nearby text, in DOM order (first = FROM, second = TO).
  function guessDateInputs() {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="date"], input:not([type])'));
    const dateish = inputs.filter((el) => {
      const nearbyText = el.closest("td,th,label,div,span")?.textContent || "";
      const haystack = `${el.id} ${el.name} ${el.placeholder || ""} ${nearbyText}`.toLowerCase();
      return haystack.includes("date");
    });
    return { from: dateish[0] || null, to: dateish[1] || null };
  }

  function guessSearchButton() {
    const candidates = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
    return candidates.find((el) => /^\s*search\s*$/i.test(el.textContent || el.value || "")) || null;
  }

  function setInputValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function setDateRangeAndSearch(fromISO, toISO) {
    const { from, to } = guessDateInputs();
    const button = guessSearchButton();
    if (!from || !to || !button) {
      console.warn("[Spoonflower Analytics] Could not locate date filter controls.", {
        foundFrom: !!from,
        foundTo: !!to,
        foundButton: !!button
      });
      return false;
    }
    setInputValue(from, isoToDisplay(fromISO));
    setInputValue(to, isoToDisplay(toISO));
    button.click();
    return true;
  }

  // Waits for the table to re-render after a search, via MutationObserver
  // with a timeout fallback (some searches may return an identical table,
  // which wouldn't otherwise fire a mutation).
  function waitForTableUpdate(table, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const observer = new MutationObserver(() => {
        if (done) return;
        done = true;
        observer.disconnect();
        resolve();
      });
      observer.observe(table.parentElement || table, { childList: true, subtree: true });
      setTimeout(() => {
        if (done) return;
        done = true;
        observer.disconnect();
        resolve();
      }, timeoutMs);
    });
  }

  function sendToBackground(records) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "SYNC_TRANSACTIONS", records }, (response) => {
        resolve(response && response.ok ? response : { ok: false, added: 0, updated: 0 });
      });
    });
  }

  function getStats() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_STATS" }, (response) => {
        resolve(response && response.ok ? response : { count: 0, lastSyncAt: null });
      });
    });
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.className = "sfa-panel";
    panel.innerHTML = `
      <span class="sfa-panel__title">Spoonflower Analytics</span>
      <button type="button" data-action="backfill">Full Backfill (2008–now)</button>
      <button type="button" class="sfa-secondary" data-action="sync-recent">Sync Recent (90 days)</button>
      <button type="button" class="sfa-secondary" data-action="open-dashboard">Open Dashboard</button>
      <span class="sfa-panel__status" data-role="status"></span>
    `;
    return panel;
  }

  function setStatus(panel, text) {
    panel.querySelector('[data-role="status"]').textContent = text;
  }

  function setButtonsDisabled(panel, disabled) {
    panel.querySelectorAll("button").forEach((b) => {
      if (b.dataset.action !== "open-dashboard") b.disabled = disabled;
    });
  }

  async function runRange(panel, table, fromISO, toISO, label) {
    const ok = await setDateRangeAndSearch(fromISO, toISO);
    if (!ok) {
      setStatus(panel, "Couldn't control the date filter automatically — see browser console for a diagnostic dump.");
      return null;
    }
    await waitForTableUpdate(table, 8000);
    await sleep(150); // let any post-render formatting settle
    const records = SpoonflowerParser.parseHistoryTable(findTable() || table);
    const result = await sendToBackground(records);
    setStatus(panel, `${label}: +${result.added} new (${result.updated} already known)`);
    return result;
  }

  async function runBackfill(panel) {
    const table = findTable();
    if (!table) return;
    setButtonsDisabled(panel, true);
    const startYear = 2008;
    const endYear = new Date().getFullYear();
    let totalAdded = 0;
    let totalUpdated = 0;

    for (let year = startYear; year <= endYear; year++) {
      const from = `${year}-01-01`;
      const to = year === endYear ? todayISO() : `${year}-12-31`;
      setStatus(panel, `Fetching ${year}…`);
      const result = await runRange(panel, table, from, to, String(year));
      if (!result) {
        setButtonsDisabled(panel, false);
        return;
      }
      totalAdded += result.added;
      totalUpdated += result.updated;
      await sleep(500); // be gentle with Spoonflower's server
    }

    setStatus(panel, `Done. ${totalAdded} new transactions, ${totalUpdated} already known.`);
    setButtonsDisabled(panel, false);
  }

  async function runSyncRecent(panel) {
    const table = findTable();
    if (!table) return;
    setButtonsDisabled(panel, true);
    const to = todayISO();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 90);
    const from = fromDate.getFullYear() + "-" + pad(fromDate.getMonth() + 1) + "-" + pad(fromDate.getDate());
    await runRange(panel, table, from, to, "Last 90 days");
    setButtonsDisabled(panel, false);
  }

  function openDashboard() {
    chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
  }

  async function init() {
    const table = findTable();
    if (!table) return; // not on a page with the Spoondollar history table

    const panel = buildPanel();
    table.parentElement.insertBefore(panel, table);

    panel.addEventListener("click", (e) => {
      const action = e.target?.dataset?.action;
      if (action === "backfill") runBackfill(panel);
      else if (action === "sync-recent") runSyncRecent(panel);
      else if (action === "open-dashboard") openDashboard();
    });

    const stats = await getStats();
    setStatus(
      panel,
      stats.count
        ? `${stats.count} transactions synced${stats.lastSyncAt ? " · last synced " + new Date(stats.lastSyncAt).toLocaleString() : ""}`
        : "No data synced yet — run Full Backfill to import your history."
    );
  }

  init();
})();
