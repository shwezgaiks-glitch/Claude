// Content script for the Spoonflower "Spoondollar history" page. Injects a
// small sync panel above the transaction table.
//
// Transaction sync (Full Backfill / Sync This Year) pulls Spoonflower's own
// official per-year CSV export from the Yearly Spoondollar Statements page
// (one same-origin fetch per year, no page navigation, no date-picker
// automation) — see lib/parser.js's parseYearlyCsvStatement for the format.
// An earlier version drove the ledger page's FROM/TO DATE filter inputs
// programmatically; that turned out to silently fail (the heuristic
// selectors never actually found the real controls), which re-scraped the
// same default view on every "year" and left most years empty. The CSV
// export needs none of that guessing, so it replaced that approach entirely.
//
// Verify Totals fetches the *summary* numbers from that same Yearly
// Statements page (Total Earned From Sales, etc.) purely as a cross-check —
// see runVerifyTotals below.
(function () {
  "use strict";

  function findTable() {
    return document.querySelector("table.spoonclams");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
  // no waiting for AJAX. This page's URL takes a plain `year` query param,
  // confirmed from the live site.
  async function fetchYearlyStatement(accountId, year) {
    const url = `${location.origin}/account/${accountId}?sub_action=spoondollars&transition=statements&year=${year}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching statement for ${year}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return parseYearlyStatement(doc, year);
  }

  // The "Download {year} Spoondollar Transaction Statement (CSV)" link on
  // the Yearly Statements page, confirmed from the live site's markup.
  function buildYearCsvUrl(accountId, year) {
    const params = new URLSearchParams({
      commit: "download csv statement",
      sub_action: "spoondollars",
      transition: "statements",
      year: String(year)
    });
    return `${location.origin}/account/${accountId}.csv?${params.toString()}`;
  }

  async function fetchYearlyCsvTransactions(accountId, year) {
    const url = buildYearCsvUrl(accountId, year);
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${year} CSV statement`);
    const text = await res.text();
    return SpoonflowerParser.parseYearlyCsvStatement(text);
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
      <button type="button" class="sfa-secondary" data-action="sync-recent">Sync This Year</button>
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

  async function runBackfill(panel) {
    const accountId = getAccountId();
    if (!accountId) {
      setStatus(panel, "Couldn't find your account id in the page URL — can't sync from here.");
      return;
    }
    setButtonsDisabled(panel, true);
    const startYear = 2021; // adjust if your Spoonflower selling history starts earlier
    const endYear = new Date().getFullYear();
    let totalAdded = 0;
    let totalUpdated = 0;

    try {
      for (let year = startYear; year <= endYear; year++) {
        setStatus(panel, `Fetching ${year}…`);
        const records = await fetchYearlyCsvTransactions(accountId, year);
        const result = await sendToBackground(records);
        if (result.invalidated) {
          setStatus(panel, "This extension was reloaded/updated — refresh this page (F5) and try again.");
          return;
        }
        totalAdded += result.added;
        totalUpdated += result.updated;
        setStatus(panel, `${year}: +${result.added} new (${result.updated} already known)`);
        await sleep(300); // be gentle with Spoonflower's server
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
    const accountId = getAccountId();
    if (!accountId) {
      setStatus(panel, "Couldn't find your account id in the page URL — can't sync from here.");
      return;
    }
    setButtonsDisabled(panel, true);
    try {
      const year = new Date().getFullYear();
      setStatus(panel, `Fetching ${year}…`);
      const records = await fetchYearlyCsvTransactions(accountId, year);
      const result = await sendToBackground(records);
      if (result.invalidated) {
        setStatus(panel, "This extension was reloaded/updated — refresh this page (F5) and try again.");
        return;
      }
      setStatus(panel, `${year}: +${result.added} new (${result.updated} already known)`);
    } catch (err) {
      console.error("[Spoonflower Analytics] Sync Recent failed:", err);
      setStatus(panel, "Sync failed — see console for details.");
    } finally {
      setButtonsDisabled(panel, false);
    }
  }

  // Fetches Spoonflower's own official per-year totals (Earning Statement
  // page) and stores them alongside — never instead of — the CSV-derived
  // transactions, purely so the dashboard can show whether our synced sum
  // matches Spoonflower's own numbers.
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
