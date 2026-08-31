import { getAllTransactions, getMeta, setMeta, getAllYearlySummaries, clearAllTransactions } from "../lib/db.js";

// Sensible starting default — Spoonflower's own "Total Earned From Sales"
// excludes a designer's purchases of their own designs, so this dashboard
// needs to know which buyer usernames are "you" to match. Editable in the
// dashboard (Verify Totals card) and persisted from there; these are just
// the seed value before that setting has ever been saved.
const DEFAULT_SELF_USERNAMES = ["textilemons", "shwetaggaikwad"];

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name, attrs) {
  const e = document.createElementNS(SVG_NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function isoDate(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function formatCurrency(n) {
  const v = Number(n) || 0;
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCompactCurrency(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1000000) return (v < 0 ? "-$" : "$") + (abs / 1000000).toFixed(1) + "M";
  if (abs >= 10000) return (v < 0 ? "-$" : "$") + (abs / 1000).toFixed(1) + "K";
  return formatCurrency(v);
}

function niceCeil(n) {
  if (n <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(n)));
  const residual = n / magnitude;
  let niceResidual;
  if (residual <= 1) niceResidual = 1;
  else if (residual <= 2) niceResidual = 2;
  else if (residual <= 5) niceResidual = 5;
  else niceResidual = 10;
  return niceResidual * magnitude;
}

// ---------- Stat tiles ----------

function renderStatTiles(container, stats) {
  container.replaceChildren();
  const tiles = [
    { label: "Total revenue", value: formatCompactCurrency(stats.totalRevenue) },
    { label: "Sales tracked", value: stats.salesCount.toLocaleString() },
    { label: "Avg per sale", value: formatCurrency(stats.avgPerSale) },
    { label: "This month", value: formatCompactCurrency(stats.monthRevenue) }
  ];
  tiles.forEach((t) => {
    const div = document.createElement("div");
    div.className = "stat-tile";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = t.label;
    const value = document.createElement("div");
    value.className = "value";
    value.textContent = t.value;
    div.append(label, value);
    container.appendChild(div);
  });
}

// ---------- Trend line chart (single series, with crosshair + tooltip) ----------

function renderTrendChart(container, points) {
  container.replaceChildren();
  if (points.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No data in this range.";
    container.appendChild(p);
    return;
  }

  const width = 640;
  const height = 220;
  const padding = { top: 16, right: 16, bottom: 26, left: 56 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const maxVal = niceCeil(Math.max(...points.map((p) => p.value), 1));
  const xStep = points.length > 1 ? innerW / (points.length - 1) : 0;
  const xFor = (i) => padding.left + (points.length > 1 ? i * xStep : innerW / 2);
  const yFor = (v) => padding.top + innerH - (v / maxVal) * innerH;

  const svg = svgEl("svg", { class: "chart-svg", viewBox: `0 0 ${width} ${height}` });

  [0, 0.25, 0.5, 0.75, 1].forEach((frac) => {
    const y = padding.top + innerH - frac * innerH;
    svg.appendChild(svgEl("line", { class: "chart-gridline", x1: padding.left, x2: width - padding.right, y1: y, y2: y }));
    const label = svgEl("text", { class: "chart-axis-label", x: padding.left - 8, y: y + 4, "text-anchor": "end" });
    label.textContent = formatCompactCurrency(maxVal * frac);
    svg.appendChild(label);
  });

  let d = "";
  points.forEach((p, i) => {
    d += (i === 0 ? "M" : "L") + xFor(i) + " " + yFor(p.value) + " ";
  });
  const areaD = d + `L ${xFor(points.length - 1)} ${padding.top + innerH} L ${xFor(0)} ${padding.top + innerH} Z`;
  svg.appendChild(svgEl("path", { class: "chart-area", d: areaD }));
  svg.appendChild(svgEl("path", { class: "chart-line", d }));

  const maxLabels = 7;
  const labelStride = Math.max(1, Math.ceil(points.length / maxLabels));
  const shownIndices = [];
  for (let i = 0; i < points.length; i += labelStride) shownIndices.push(i);
  const lastShown = shownIndices[shownIndices.length - 1];
  if (lastShown !== points.length - 1) {
    if (points.length - 1 - lastShown < labelStride) shownIndices.pop();
    shownIndices.push(points.length - 1);
  }
  shownIndices.forEach((i) => {
    const label = svgEl("text", {
      class: "chart-axis-label",
      x: xFor(i),
      y: height - 6,
      "text-anchor": i === points.length - 1 ? "end" : "middle"
    });
    label.textContent = points[i].label;
    svg.appendChild(label);
  });

  const lastI = points.length - 1;
  svg.appendChild(svgEl("circle", { class: "chart-end-dot", cx: xFor(lastI), cy: yFor(points[lastI].value), r: 4 }));
  const endLabel = svgEl("text", {
    class: "chart-value-label",
    x: xFor(lastI),
    y: Math.max(14, yFor(points[lastI].value) - 10),
    "text-anchor": "end"
  });
  endLabel.textContent = formatCurrency(points[lastI].value);
  svg.appendChild(endLabel);

  const crosshair = svgEl("line", {
    class: "chart-crosshair",
    x1: 0,
    x2: 0,
    y1: padding.top,
    y2: padding.top + innerH,
    visibility: "hidden"
  });
  const hoverDot = svgEl("circle", { class: "chart-hover-dot", r: 4, cx: 0, cy: 0, visibility: "hidden" });
  svg.append(crosshair, hoverDot);

  const hitRect = svgEl("rect", { x: padding.left, y: padding.top, width: innerW, height: innerH, fill: "transparent" });
  svg.appendChild(hitRect);
  container.appendChild(svg);

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  tooltip.hidden = true;
  const ttLabel = document.createElement("div");
  const ttValue = document.createElement("div");
  ttValue.className = "tt-value";
  tooltip.append(ttLabel, ttValue);
  container.appendChild(tooltip);

  function showAt(i) {
    const p = points[i];
    crosshair.setAttribute("x1", xFor(i));
    crosshair.setAttribute("x2", xFor(i));
    crosshair.setAttribute("visibility", "visible");
    hoverDot.setAttribute("cx", xFor(i));
    hoverDot.setAttribute("cy", yFor(p.value));
    hoverDot.setAttribute("visibility", "visible");
    ttLabel.textContent = p.label;
    ttValue.textContent = formatCurrency(p.value);
    const svgRect = svg.getBoundingClientRect();
    const scale = svgRect.width / width;
    tooltip.style.left = xFor(i) * scale + "px";
    tooltip.style.top = yFor(p.value) * scale - 10 + "px";
    tooltip.hidden = false;
  }
  function hide() {
    crosshair.setAttribute("visibility", "hidden");
    hoverDot.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
  }

  hitRect.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const scale = width / rect.width;
    const mouseX = (e.clientX - rect.left) * scale;
    let i = points.length > 1 ? Math.round((mouseX - padding.left) / xStep) : 0;
    i = Math.max(0, Math.min(points.length - 1, i));
    showAt(i);
  });
  hitRect.addEventListener("mouseleave", hide);
}

// ---------- Ranked bar chart (single measure across categories/designs) ----------

function renderBarChart(container, items) {
  container.replaceChildren();
  if (items.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No data in this range.";
    container.appendChild(p);
    return;
  }
  const maxVal = Math.max(...items.map((i) => i.value), 1);

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.style.position = "relative";

    const label = document.createElement("div");
    label.className = "bar-label";
    label.textContent = item.label; // scraped design/category name — textContent only
    label.title = item.label;

    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill" + (item.colorClass ? " " + item.colorClass : "");
    fill.style.width = Math.max(2, (item.value / maxVal) * 100) + "%";
    fill.tabIndex = 0;
    track.appendChild(fill);

    const value = document.createElement("div");
    value.className = "bar-value";
    value.textContent = formatCurrency(item.value);

    const tooltip = document.createElement("div");
    tooltip.className = "tooltip";
    tooltip.hidden = true;
    const ttLabel = document.createElement("div");
    ttLabel.textContent = item.label;
    const ttValue = document.createElement("div");
    ttValue.className = "tt-value";
    ttValue.textContent = formatCurrency(item.value);
    tooltip.append(ttLabel, ttValue);

    row.append(label, track, value, tooltip);
    container.appendChild(row);

    const show = (e) => {
      tooltip.hidden = false;
      const rowRect = row.getBoundingClientRect();
      const x = e.clientX != null ? e.clientX - rowRect.left : rowRect.width / 2;
      tooltip.style.left = x + "px";
      tooltip.style.top = "0px";
    };
    const hide = () => (tooltip.hidden = true);
    fill.addEventListener("mousemove", show);
    fill.addEventListener("mouseleave", hide);
    fill.addEventListener("focus", show);
    fill.addEventListener("blur", hide);
  });
}

// ---------- Data pipeline ----------

let allRecords = [];
let currentRange = "all";
let currentSort = { key: "date", dir: "desc" };
let currentSearch = "";
let selfUsernames = []; // lowercase; buyer usernames to exclude as self-purchases

function isEarningRecord(r) {
  if (r.type !== "sale" && r.type !== "fill_a_yard") return false;
  if (r.buyer && selfUsernames.includes(r.buyer.toLowerCase())) return false;
  return true;
}

function getRangeBounds(range) {
  const now = new Date();
  if (range === "90d") {
    const from = new Date(now);
    from.setDate(from.getDate() - 90);
    return { from: isoDate(from), to: isoDate(now) };
  }
  if (range === "12m") {
    const from = new Date(now);
    from.setFullYear(from.getFullYear() - 1);
    return { from: isoDate(from), to: isoDate(now) };
  }
  if (range === "ytd") {
    return { from: now.getFullYear() + "-01-01", to: isoDate(now) };
  }
  return null;
}

function filterByRange(records, range) {
  const bounds = getRangeBounds(range);
  if (!bounds) return records;
  return records.filter((r) => r.date && r.date >= bounds.from && r.date <= bounds.to);
}

function monthLabel(key) {
  const [y, m] = key.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function bucketByMonth(records) {
  const map = new Map();
  records.forEach((r) => {
    if (!r.date) return;
    const key = r.date.slice(0, 7);
    map.set(key, (map.get(key) || 0) + r.amount);
  });
  return Array.from(map.keys())
    .sort()
    .map((k) => ({ label: monthLabel(k), value: map.get(k) }));
}

function bucketByDay(records) {
  const map = new Map();
  records.forEach((r) => {
    if (!r.date) return;
    map.set(r.date, (map.get(r.date) || 0) + r.amount);
  });
  return Array.from(map.keys())
    .sort()
    .map((k) => ({ label: dayLabel(k), value: map.get(k) }));
}

function renderAll() {
  const scoped = filterByRange(allRecords, currentRange);
  const earnings = scoped.filter(isEarningRecord);

  const totalRevenue = earnings.reduce((s, r) => s + r.amount, 0);
  const thisMonthKey = new Date().toISOString().slice(0, 7);
  const monthRevenue = earnings.filter((r) => (r.date || "").startsWith(thisMonthKey)).reduce((s, r) => s + r.amount, 0);

  renderStatTiles(document.getElementById("stat-tiles"), {
    totalRevenue,
    salesCount: earnings.length,
    avgPerSale: earnings.length ? totalRevenue / earnings.length : 0,
    monthRevenue
  });

  const useMonthly = currentRange === "all" || currentRange === "12m" || currentRange === "ytd";
  renderTrendChart(document.getElementById("trend-chart"), useMonthly ? bucketByMonth(earnings) : bucketByDay(earnings));

  const byDesign = new Map();
  earnings.forEach((r) => {
    if (!r.designId) return;
    const prev = byDesign.get(r.designId) || { label: r.designName || r.designId, value: 0 };
    prev.value += r.amount;
    byDesign.set(r.designId, prev);
  });
  const topDesigns = Array.from(byDesign.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  renderBarChart(document.getElementById("top-designs-chart"), topDesigns);

  const byCategory = new Map();
  earnings.forEach((r) => {
    const key = r.category || "Other";
    const colorClass = key === "Fabric" ? "cat-fabric" : key === "Other" ? "cat-other" : "";
    const prev = byCategory.get(key) || { label: key, value: 0, colorClass };
    prev.value += r.amount;
    byCategory.set(key, prev);
  });
  const categories = Array.from(byCategory.values()).sort((a, b) => b.value - a.value);
  renderBarChart(document.getElementById("category-chart"), categories);

  renderTable(scoped);
}

function renderTable(scopedRecords) {
  let rows = scopedRecords.filter((r) => r.type !== "payout");
  if (currentSearch) {
    rows = rows.filter(
      (r) => (r.designName || "").toLowerCase().includes(currentSearch) || (r.productName || "").toLowerCase().includes(currentSearch)
    );
  }
  rows = rows.slice().sort((a, b) => {
    const av = a[currentSort.key];
    const bv = b[currentSort.key];
    const cmp = typeof av === "number" || typeof bv === "number" ? (av || 0) - (bv || 0) : String(av || "").localeCompare(String(bv || ""));
    return currentSort.dir === "asc" ? cmp : -cmp;
  });

  const MAX_ROWS = 500;
  const shown = rows.slice(0, MAX_ROWS);
  const tbody = document.getElementById("tx-table-body");
  tbody.replaceChildren();
  shown.forEach((r) => {
    const tr = document.createElement("tr");
    [r.date || "", r.designName || "", r.productName || "", r.category || "", r.buyer || "guest", formatCurrency(r.amount)].forEach(
      (val, i) => {
        const td = document.createElement("td");
        if (i === 5) td.className = "num";
        td.textContent = val;
        tr.appendChild(td);
      }
    );
    tbody.appendChild(tr);
  });

  const countEl = document.getElementById("table-count");
  countEl.textContent =
    rows.length > MAX_ROWS
      ? `Showing ${MAX_ROWS} of ${rows.length.toLocaleString()} transactions — search or narrow the date range to see more`
      : `${rows.length.toLocaleString()} transactions`;
}

// ---------- Verification against Spoonflower's official yearly totals ----------

function renderVerifyTable(records, summaries) {
  const card = document.getElementById("verify-card");
  if (!summaries || summaries.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const ourTotalsByYear = new Map();
  records
    .filter(isEarningRecord)
    .forEach((r) => {
      if (!r.date) return;
      const year = r.date.slice(0, 4);
      ourTotalsByYear.set(year, (ourTotalsByYear.get(year) || 0) + r.amount);
    });

  const tbody = document.getElementById("verify-table-body");
  tbody.replaceChildren();

  summaries
    .slice()
    .sort((a, b) => a.year - b.year)
    .forEach((summary) => {
      if (summary.earned == null) return; // couldn't parse that year's page
      const ourTotal = ourTotalsByYear.get(String(summary.year)) || 0;
      const diff = ourTotal - summary.earned;
      const matches = Math.abs(diff) < 0.01;

      const tr = document.createElement("tr");
      const yearTd = document.createElement("td");
      yearTd.textContent = String(summary.year);
      const ourTd = document.createElement("td");
      ourTd.className = "num";
      ourTd.textContent = formatCurrency(ourTotal);
      const officialTd = document.createElement("td");
      officialTd.className = "num";
      officialTd.textContent = formatCurrency(summary.earned);
      const diffTd = document.createElement("td");
      diffTd.className = "num";
      diffTd.textContent = formatCurrency(diff);
      const statusTd = document.createElement("td");
      statusTd.className = matches ? "status-match" : "status-mismatch";
      statusTd.textContent = matches ? "✓ Match" : "⚠ Mismatch";

      tr.append(yearTd, ourTd, officialTd, diffTd, statusTd);
      tbody.appendChild(tr);
    });
}

// ---------- CSV export ----------

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv() {
  const headers = [
    "id", "date", "type", "amount", "balance", "designId", "designName",
    "productName", "category", "substrate", "buyer", "quantity", "currency", "exRate", "percent"
  ];
  const lines = [headers.join(",")];
  allRecords.forEach((r) => {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `spoonflower-sales-${isoDate(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Wiring ----------

function applyRange(range) {
  currentRange = range;
  document.querySelectorAll(".filter-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === range)));
  renderAll();
}

async function loadSelfUsernames() {
  const stored = await getMeta("selfUsernames");
  if (Array.isArray(stored)) return stored;
  await setMeta("selfUsernames", DEFAULT_SELF_USERNAMES);
  return DEFAULT_SELF_USERNAMES;
}

async function init() {
  allRecords = await getAllTransactions();
  const [lastSyncAt, yearlySummaries, storedSelfUsernames] = await Promise.all([
    getMeta("lastSyncAt"),
    getAllYearlySummaries(),
    loadSelfUsernames()
  ]);
  selfUsernames = storedSelfUsernames;
  document.getElementById("self-usernames-input").value = selfUsernames.join(", ");
  renderVerifyTable(allRecords, yearlySummaries);

  document.getElementById("save-self-usernames").addEventListener("click", async () => {
    const raw = document.getElementById("self-usernames-input").value;
    selfUsernames = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    await setMeta("selfUsernames", selfUsernames);
    renderVerifyTable(allRecords, yearlySummaries);
    if (allRecords.length > 0) renderAll();
  });

  document.getElementById("sync-status").textContent = lastSyncAt
    ? `Last synced ${new Date(lastSyncAt).toLocaleString()} · ${allRecords.length.toLocaleString()} transactions`
    : "";

  document.getElementById("reset-data").addEventListener("click", async () => {
    const confirmed = confirm(
      "This deletes all synced transactions from this browser's local storage. " +
        "Your Spoonflower account and data on Spoonflower's servers are unaffected — " +
        "you can re-sync any time. Continue?"
    );
    if (!confirmed) return;
    await clearAllTransactions();
    location.reload();
  });

  if (allRecords.length === 0) {
    document.getElementById("empty-state").hidden = false;
    document.getElementById("app").hidden = true;
    return;
  }
  document.getElementById("app").hidden = false;

  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyRange(btn.dataset.range));
  });

  document.getElementById("table-search").addEventListener("input", (e) => {
    currentSearch = e.target.value.toLowerCase();
    renderAll();
  });

  document.querySelectorAll("#tx-table thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (currentSort.key === key) currentSort.dir = currentSort.dir === "asc" ? "desc" : "asc";
      else currentSort = { key, dir: "asc" };
      renderAll();
    });
  });

  document.getElementById("export-csv").addEventListener("click", exportCsv);

  applyRange("all");
}

init();
