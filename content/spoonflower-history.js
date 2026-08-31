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

  function getAccountId() {
    const m = location.pathname.match(/\/account\/(\d+)/);
    return m ? m[1] : null;
  }

  // Parses the "Earning Statement for {year}" block from the Yearly
  // Spoondollar Statements page (fetched separately — see fetchYearlyStatement)
  // into { year, earned, paidOut, spent, withheld }. Each stat sits in a
  // `.splam_totals` block with a `.left-key` label (which also contains a
  // help-icon <a> for the first one, stripped out below) and two
  // `.right-value` spans — one wrapping the "Show Transactions" form, one
  // holding the plain-text dollar amount. We take whichever `.right-value`
  // does NOT contain a form.
  function parseYearlyStatement(doc, year) {
    const result = { year, earned: null, paidOut: null, spent: null, withheld: null };
    const blocks = Array.from(doc.querySelectorAll(".splam-totals-wrapper .splam_totals"));
    blocks.forEach((block) => {
      const leftKeyEl = block.querySelector(".left-key");
      if (!leftKeyEl) return;
      const labelClone = leftKeyEl.cloneNode(true);
      labelClone.querySelectorAll("a").forEach((a) => a.remove());
      const label = SpoonflowerParser.normalizeWhitespace(labelClone.textContent).toLowerCase();

      const valueSpan = Array.from(block.querySelectorAll(".right-value")).find((s) => !s.querySelector("form"));
      if (!valueSpan) return;
      const value = SpoonflowerParser.parseMoney(valueSpan.textContent);
      if (value == null) return;

      if (label.includes("earned")) result.earned = value;
      else if (label.includes("paid out")) result.paidOut = value;
      else if (label.includes("spent")) result.spent = value;
      else if (label.includes("withheld")) result.withheld = value;
    });
    return result;
  }

  // Same-origin fetch (cookies included automatically) — no page navigation,
  // no waiting for AJAX, no date-picker automation. This page's URL takes a
  // plain `year` query param, confirmed from the live site.
  async function fetchYearlyStatement(accountId, year) {
    const url = `${location.origin}/account/${accountId}?sub_action=spoondollars&transition=statements&year=${year}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching statement for ${year}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return parseYearlyStatement(doc, year);
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

  // Waits for the table to settle after a search. Deliberately re-queries
  // findTable() on every poll rather than watching a captured node/parent —
  // if the page's AJAX response replaces the whole <table> element (rather
  // than just its rows), a captured reference goes stale and detached, and
  // a MutationObserver watching its (now-null) parentElement throws. Polling
  // for a signature (row count + first row id) to stop changing sidesteps
  // that entirely.
  async function waitForTableSettled(timeoutMs) {
    const start = Date.now();
    let lastSignature;
    let stableTicks = 0;
    while (Date.now() - start < timeoutMs) {
      await sleep(250);
      const t = findTable();
      const firstRowId = t?.querySelector("tr.sale, tr.debit")?.id || "";
      const signature = t ? `${t.querySelectorAll("tr").length}:${firstRowId}` : null;
      if (signature !== null && signature === lastSignature) {
        stableTicks++;
        if (stableTicks >= 2) return true;
      } else {
        stableTicks = 0;
      }
      lastSignature = signature;
    }
    return false;
  }

  // chrome.runtime.sendMessage throws SYNCHRONOUSLY (not via lastError) when
  // the extension has been reloaded/updated since this content script was
  // injected — "Extension context invalidated." A page left open across a
  // `chrome://extensions` reload is the classic trigger. Every call site
  // routes through here so that failure is reported, not thrown.
  function safeSendMessage(message) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) {
          resolve({ ok: false, invalidated: true });
          return;
        }
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, invalidated: /context invalidated/i.test(chrome.runtime.lastError.message || ""), error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false });
        });
      } catch (err) {
        resolve({ ok: false, invalidated: true, error: String(err) });
      }
    });
  }

  async function sendToBackground(records) {
    const r = await safeSendMessage({ type: "SYNC_TRANSACTIONS", records });
    return r.ok ? r : { ok: false, added: 0, updated: 0, invalidated: r.invalidated };
  }

  async function getStats() {
    const r = await safeSendMessage({ type: "GET_STATS" });
    return r.ok ? r : { count: 0, lastSyncAt: null, invalidated: r.invalidated };
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.className = "sfa-panel";
    panel.innerHTML = `
      <span class="sfa-panel__title">Spoonflower Analytics</span>
      <button type="button" data-action="backfill">Full Backfill (2021–now)</button>
      <button type="button" class="sfa-secondary" data-action="sync-recent">Sync Recent (90 days)</button>
      <button type="button" class="sfa-secondary" data-action="verify-totals">Verify Totals</button>
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

  async function runRange(panel, fromISO, toISO, label) {
    const beforeRowId = findTable()?.querySelector("tr.sale, tr.debit")?.id || "";
    const ok = await setDateRangeAndSearch(fromISO, toISO);
    if (!ok) {
      setStatus(panel, "Couldn't control the date filter automatically — see browser console for a diagnostic dump.");
      return null;
    }
    const settled = await waitForTableSettled(8000);
    if (!settled) {
      console.warn(`[Spoonflower Analytics] Table didn't settle for range ${fromISO}..${toISO} (beforeRowId=${beforeRowId}) — parsing whatever is currently rendered.`);
    }
    await sleep(150); // let any post-settle formatting finish
    const table = findTable();
    if (!table) {
      setStatus(panel, `${label}: table disappeared from the page — stopping.`);
      return null;
    }
    const records = SpoonflowerParser.parseHistoryTable(table);
    const result = await sendToBackground(records);
    if (result.invalidated) {
      setStatus(panel, "This extension was reloaded/updated — refresh this page (F5) and try again.");
      return null;
    }
    setStatus(panel, `${label}: +${result.added} new (${result.updated} already known)`);
    return result;
  }

  async function runBackfill(panel) {
    if (!findTable()) return;
    setButtonsDisabled(panel, true);
    const startYear = 2021; // adjust if your Spoonflower selling history starts earlier
    const endYear = new Date().getFullYear();
    let totalAdded = 0;
    let totalUpdated = 0;

    try {
      for (let year = startYear; year <= endYear; year++) {
        const from = `${year}-01-01`;
        const to = year === endYear ? todayISO() : `${year}-12-31`;
        setStatus(panel, `Fetching ${year}…`);
        const result = await runRange(panel, from, to, String(year));
        if (!result) return;
        totalAdded += result.added;
        totalUpdated += result.updated;
        await sleep(500); // be gentle with Spoonflower's server
      }
      setStatus(panel, `Done. ${totalAdded} new transactions, ${totalUpdated} already known across ${startYear}–${endYear}.`);
    } catch (err) {
      console.error("[Spoonflower Analytics] Backfill stopped early due to an error:", err);
      setStatus(panel, `Stopped early after an error (${totalAdded} new so far) — see console, then try Full Backfill again to resume.`);
    } finally {
      setButtonsDisabled(panel, false);
    }
  }

  async function runSyncRecent(panel) {
    if (!findTable()) return;
    setButtonsDisabled(panel, true);
    try {
      const to = todayISO();
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 90);
      const from = fromDate.getFullYear() + "-" + pad(fromDate.getMonth() + 1) + "-" + pad(fromDate.getDate());
      await runRange(panel, from, to, "Last 90 days");
    } catch (err) {
      console.error("[Spoonflower Analytics] Sync Recent failed:", err);
      setStatus(panel, "Sync failed — see console for details.");
    } finally {
      setButtonsDisabled(panel, false);
    }
  }

  // Fetches Spoonflower's own official per-year totals (Earning Statement
  // page) and stores them alongside — never instead of — the ledger-derived
  // transactions, purely so the dashboard can show whether our scraped sum
  // matches Spoonflower's own numbers. That page has no stable per-row id,
  // so it's not safe to use as the transaction source itself.
  async function runVerifyTotals(panel) {
    const accountId = getAccountId();
    if (!accountId) {
      setStatus(panel, "Couldn't find your account id in the page URL — can't verify totals from here.");
      return;
    }
    setButtonsDisabled(panel, true);
    const startYear = 2021; // keep in sync with runBackfill's startYear
    const endYear = new Date().getFullYear();
    const summaries = [];
    try {
      for (let year = startYear; year <= endYear; year++) {
        setStatus(panel, `Verifying ${year}…`);
        summaries.push(await fetchYearlyStatement(accountId, year));
        await sleep(300); // be gentle with Spoonflower's server
      }
      const r = await safeSendMessage({ type: "SYNC_YEARLY_SUMMARY", records: summaries });
      if (!r.ok) {
        setStatus(
          panel,
          r.invalidated
            ? "This extension was reloaded/updated — refresh this page (F5) and try again."
            : "Verify Totals failed to save — see console for details."
        );
        return;
      }
      setStatus(panel, `Verified ${summaries.length} year(s) of official totals — open the Dashboard to see the comparison.`);
    } catch (err) {
      console.error("[Spoonflower Analytics] Verify Totals failed:", err);
      setStatus(panel, "Verify Totals failed — see console for details.");
    } finally {
      setButtonsDisabled(panel, false);
    }
  }

  async function openDashboard() {
    const r = await safeSendMessage({ type: "OPEN_DASHBOARD" });
    if (r.invalidated) {
      alert("Spoonflower Analytics was reloaded/updated — refresh this page and try again.");
    }
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
      else if (action === "verify-totals") runVerifyTotals(panel);
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
