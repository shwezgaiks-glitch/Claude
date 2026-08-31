import { getAllTransactions, getMeta } from "../lib/db.js";

function formatCurrency(n) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function computeStats(records) {
  const earnings = records.filter((r) => r.type === "sale" || r.type === "fill_a_yard");
  const totalRevenue = earnings.reduce((sum, r) => sum + r.amount, 0);
  const thisMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const monthRevenue = earnings.filter((r) => (r.date || "").startsWith(thisMonth)).reduce((sum, r) => sum + r.amount, 0);
  return {
    salesCount: earnings.length,
    totalRevenue,
    monthRevenue
  };
}

async function render() {
  const [records, lastSyncAt] = await Promise.all([getAllTransactions(), getMeta("lastSyncAt")]);
  const statsEl = document.getElementById("stats");
  const emptyEl = document.getElementById("empty");
  const lastSyncEl = document.getElementById("last-sync");

  if (records.length === 0) {
    statsEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }

  const stats = computeStats(records);
  statsEl.innerHTML = `
    <div class="stat-row"><span class="stat-label">Sales tracked</span><span class="stat-value">${stats.salesCount.toLocaleString()}</span></div>
    <div class="stat-row"><span class="stat-label">Total revenue</span><span class="stat-value">${formatCurrency(stats.totalRevenue)}</span></div>
    <div class="stat-row"><span class="stat-label">This month</span><span class="stat-value">${formatCurrency(stats.monthRevenue)}</span></div>
  `;

  if (lastSyncAt) {
    lastSyncEl.textContent = `Last synced ${new Date(lastSyncAt).toLocaleString()}`;
  }
}

document.getElementById("open-dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
});

render();
