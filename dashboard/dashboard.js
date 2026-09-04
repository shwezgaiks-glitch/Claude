import {
  getAllTransactions,
  getMeta,
  getAllYearlySummaries,
  getAllDesignTags,
  clearAllTransactions,
  getAllBuyerNotes,
  putBuyerNote
} from "../lib/db.js";

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

// ---------- Design page links ----------
// Spoonflower's own design-page URL depends on which product the design was
// sold as (wallpaper vs. fabric vs. a specific home-decor item each have
// their own path), and a design can be sold as more than one — the
// classification is guessed per-sale from the product text, and the caller
// picks whichever product type earned the design the most before building
// the link, so it points at the product page most relevant to the sales
// being shown.

function classifyProductType(productRaw, productName, category) {
  const text = `${productRaw || ""} ${productName || ""}`.toLowerCase();
  if (text.includes("tea towel")) return "teatowel";
  if (text.includes("curtain")) return "curtain";
  if (text.includes("napkin")) return "napkins";
  if (text.includes("pillow sham")) return "pillowsham";
  if (text.includes("placemat")) return "placemat";
  if (text.includes("table runner")) return "tablerunner";
  if (text.includes("sheet set")) return "sheetset";
  if (text.includes("tablecloth")) return "tablecloth";
  if (text.includes("throw blanket")) return "throwblanket";
  if (text.includes("throw pillow")) return "throwpillow";
  if (text.includes("duvet") || text.includes("bedding")) return "duvetcover";
  if (text.includes("wallpaper") || category === "Wallpaper") return "wallpaper";
  return "fabric"; // default: swatches, fat quarters, yards, and anything else cut from yardage
}

function designUrl(designId, productType) {
  const base = "https://www.spoonflower.com/en/artists";
  const paths = {
    wallpaper: `wallpaper/${designId}`,
    fabric: `fabric/${designId}`,
    teatowel: `home-decor/dining/tea-towel/${designId}`,
    curtain: `home-decor/living-decor/curtains/${designId}`,
    napkins: `home-decor/dining/napkins/${designId}`,
    pillowsham: `home-decor/bedding/pillow-sham/${designId}`,
    placemat: `home-decor/dining/placemats/${designId}`,
    tablerunner: `home-decor/dining/table-runner/${designId}`,
    sheetset: `home-decor/bedding/sheet-set/${designId}`,
    tablecloth: `home-decor/dining/tablecloth/${designId}`,
    throwblanket: `home-decor/living-decor/throw-blanket/${designId}`,
    throwpillow: `home-decor/living-decor/throw-pillow/${designId}`,
    duvetcover: `home-decor/bedding/duvet-cover/${designId}`
  };
  return `${base}/${paths[productType] || paths.fabric}`;
}

function bestProductType(productTypeRevenueMap) {
  const sorted = Array.from(productTypeRevenueMap.entries()).sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0][0] : "fabric";
}

// Builds the design-name element used in tables/lists: a link to the
// design's product page (picking whichever product type earned it the
// most, since one design can sell as more than one) when a designId and
// per-product-type revenue breakdown are available, otherwise plain text.
function buildDesignLinkEl(designId, name, productTypeRevenueMap) {
  if (!designId || !productTypeRevenueMap || productTypeRevenueMap.size === 0) {
    const span = document.createElement("span");
    span.textContent = name; // scraped design name — textContent only
    return span;
  }
  const a = document.createElement("a");
  a.className = "design-link";
  a.href = designUrl(designId, bestProductType(productTypeRevenueMap));
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = name; // scraped design name — textContent only
  return a;
}

// ---------- Stat tiles ----------

function renderStatTiles(container, stats) {
  container.replaceChildren();
  const tiles = [
    { label: "Total revenue", value: formatCompactCurrency(stats.totalRevenue), delta: stats.revenueDelta, note: stats.refundNote },
    { label: "Sales tracked", value: stats.salesCount.toLocaleString(), note: stats.guestNote },
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
    if (t.delta) {
      const deltaEl = document.createElement("div");
      if (t.delta.isNew) {
        deltaEl.className = "delta delta-up";
        deltaEl.textContent = `▲ New ${t.delta.periodLabel}`;
      } else {
        const up = t.delta.pct >= 0;
        deltaEl.className = "delta " + (up ? "delta-up" : "delta-down");
        deltaEl.textContent = `${up ? "▲" : "▼"} ${Math.abs(t.delta.pct).toFixed(1)}% ${t.delta.periodLabel}`;
      }
      div.appendChild(deltaEl);
    }
    if (t.note) {
      const noteEl = document.createElement("div");
      noteEl.className = "note";
      noteEl.textContent = t.note;
      div.appendChild(noteEl);
    }
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

    const label = document.createElement(item.href ? "a" : "div");
    label.className = "bar-label";
    if (item.href) {
      label.href = item.href;
      label.target = "_blank";
      label.rel = "noopener noreferrer";
    }
    label.textContent = item.label; // scraped design/category name — textContent only
    label.title = item.label;

    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill" + (item.colorClass ? " " + item.colorClass : "");
    fill.style.width = Math.max(2, (item.value / maxVal) * 100) + "%";
    fill.tabIndex = 0;
    track.appendChild(fill);

    const valueText = item.valueLabel || formatCurrency(item.value);
    const value = document.createElement("div");
    value.className = "bar-value";
    value.textContent = valueText;

    const tooltip = document.createElement("div");
    tooltip.className = "tooltip";
    tooltip.hidden = true;
    const ttLabel = document.createElement("div");
    ttLabel.textContent = item.label;
    const ttValue = document.createElement("div");
    ttValue.className = "tt-value";
    ttValue.textContent = valueText;
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

    // Click-to-drill: the bar itself (not the label, which may already be
    // an external link to the design's Spoonflower page) filters the
    // transaction table below to this bar's underlying records.
    if (typeof item.onClick === "function") {
      fill.classList.add("bar-fill--clickable");
      fill.setAttribute("role", "button");
      fill.setAttribute("aria-label", `Filter transactions by ${item.label}`);
      fill.addEventListener("click", item.onClick);
      fill.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          item.onClick();
        }
      });
    }

    // A separate, optional detail-view trigger on the value text (kept
    // distinct from onClick's drill filter and from the label's external
    // link, so all three can coexist on the same row without stepping on
    // each other) — currently only Top Designs wires this up.
    if (typeof item.onDetailClick === "function") {
      value.classList.add("bar-value--clickable");
      value.tabIndex = 0;
      value.setAttribute("role", "button");
      value.setAttribute("aria-label", `View details for ${item.label}`);
      value.addEventListener("click", item.onDetailClick);
      value.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          item.onDetailClick();
        }
      });
    }
  });
}

// ---------- Data pipeline ----------

let allRecords = [];
let currentRange = "all";
let currentSort = { key: "date", dir: "desc" };
let currentSearch = "";
let tagsByDesignId = new Map(); // designId -> string[] tags, from Sync Design Tags
let designRollups = new Map(); // designId -> all-time sale/return rollup, from buildDesignRollups
let currentDrillFilter = null; // { label: string, designIds: Set<string> } | null — set by clicking a chart bar
let buyerNotesByBuyer = new Map(); // buyer -> { buyer, tags: string[], notes: string, updatedAt } — user-entered, never scraped
let currentCustomerSearch = "";

function applyDrillFilter(filter) {
  currentDrillFilter = filter;
  renderAll();
  document.getElementById("tx-table").scrollIntoView({ behavior: "smooth", block: "start" });
}

function isEarningRecord(r) {
  return r.type === "sale" || r.type === "fill_a_yard";
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
  if (range === "month") {
    return { from: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, to: isoDate(now) };
  }
  return null;
}

function filterByBounds(records, bounds) {
  if (!bounds) return records;
  return records.filter((r) => r.date && r.date >= bounds.from && r.date <= bounds.to);
}

function filterByRange(records, range) {
  return filterByBounds(records, getRangeBounds(range));
}

// The comparison period for each filter — calendar-aligned for ytd/month
// (comparable seasons, not an arbitrary trailing window) and a contiguous
// immediately-preceding window for the rolling ranges. "all" has no
// meaningful prior period to compare against.
function getPreviousRangeBounds(range) {
  const now = new Date();
  if (range === "90d") {
    const to = new Date(now);
    to.setDate(to.getDate() - 91);
    const from = new Date(now);
    from.setDate(from.getDate() - 180);
    return { from: isoDate(from), to: isoDate(to) };
  }
  if (range === "12m") {
    const to = new Date(now);
    to.setFullYear(to.getFullYear() - 1);
    to.setDate(to.getDate() - 1);
    const from = new Date(now);
    from.setFullYear(from.getFullYear() - 2);
    return { from: isoDate(from), to: isoDate(to) };
  }
  if (range === "ytd") {
    const prevYear = now.getFullYear() - 1;
    return { from: `${prevYear}-01-01`, to: `${prevYear}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` };
  }
  if (range === "month") {
    const prevMonthLastDay = new Date(now.getFullYear(), now.getMonth(), 0);
    const prevMonthFirstDay = new Date(prevMonthLastDay.getFullYear(), prevMonthLastDay.getMonth(), 1);
    const cutoffDay = Math.min(now.getDate(), prevMonthLastDay.getDate());
    const cutoff = new Date(prevMonthFirstDay.getFullYear(), prevMonthFirstDay.getMonth(), cutoffDay);
    return { from: isoDate(prevMonthFirstDay), to: isoDate(cutoff) };
  }
  return null;
}

function previousPeriodLabel(range) {
  switch (range) {
    case "90d":
      return "vs prior 90 days";
    case "12m":
      return "vs prior 12 months";
    case "ytd":
      return "vs same period last year";
    case "month":
      return "vs same days last month";
    default:
      return null;
  }
}

function buildRevenueDelta(currentRevenue, range) {
  const bounds = getPreviousRangeBounds(range);
  if (!bounds) return null;
  const previousRevenue = filterByBounds(allRecords, bounds)
    .filter(isEarningRecord)
    .reduce((s, r) => s + r.amount, 0);
  if (previousRevenue === 0 && currentRevenue === 0) return null;
  const periodLabel = previousPeriodLabel(range);
  if (previousRevenue === 0) return { pct: null, isNew: true, periodLabel };
  return { pct: ((currentRevenue - previousRevenue) / Math.abs(previousRevenue)) * 100, isNew: false, periodLabel };
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

  const refundTotal = Math.abs(scoped.filter((r) => r.type === "return").reduce((s, r) => s + r.amount, 0));
  const refundPct = totalRevenue > 0 ? (refundTotal / totalRevenue) * 100 : 0;
  const guestCount = earnings.filter((r) => !r.buyer).length;
  const guestPct = earnings.length ? (guestCount / earnings.length) * 100 : 0;

  renderStatTiles(document.getElementById("stat-tiles"), {
    totalRevenue,
    salesCount: earnings.length,
    avgPerSale: earnings.length ? totalRevenue / earnings.length : 0,
    monthRevenue,
    revenueDelta: buildRevenueDelta(totalRevenue, currentRange),
    refundNote: refundTotal > 0 ? `${formatCurrency(refundTotal)} refunds (${refundPct.toFixed(1)}%)` : null,
    guestNote: earnings.length ? `${guestPct.toFixed(0)}% guest checkout` : null
  });

  const useMonthly = currentRange === "all" || currentRange === "12m" || currentRange === "ytd";
  renderTrendChart(document.getElementById("trend-chart"), useMonthly ? bucketByMonth(earnings) : bucketByDay(earnings));

  const byDesign = new Map();
  earnings.forEach((r) => {
    if (!r.designId) return;
    const prev = byDesign.get(r.designId) || {
      designId: r.designId,
      name: r.designName || r.designId,
      value: 0,
      productTypeRevenue: new Map()
    };
    prev.value += r.amount;
    const slug = classifyProductType(r.productRaw, r.productName, r.category);
    prev.productTypeRevenue.set(slug, (prev.productTypeRevenue.get(slug) || 0) + r.amount);
    byDesign.set(r.designId, prev);
  });
  const topDesigns = Array.from(byDesign.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
    .map((d) => {
      const bestSlug = Array.from(d.productTypeRevenue.entries()).sort((a, b) => b[1] - a[1])[0][0];
      return {
        label: `${d.name} (#${d.designId})`,
        value: d.value,
        href: designUrl(d.designId, bestSlug),
        onClick: () => applyDrillFilter({ label: d.name, designIds: new Set([d.designId]) }),
        onDetailClick: () => openDesignDetail(d.designId)
      };
    });
  renderBarChart(document.getElementById("top-designs-chart"), topDesigns);

  const byCategory = new Map();
  earnings.forEach((r) => {
    const key = r.category || "Other";
    const colorClass = key === "Fabric" ? "cat-fabric" : key === "Other" ? "cat-other" : "";
    const prev = byCategory.get(key) || { label: key, value: 0, colorClass, units: 0 };
    prev.value += r.amount;
    prev.units += r.quantity || 1;
    byCategory.set(key, prev);
  });
  const categories = Array.from(byCategory.values())
    .sort((a, b) => b.value - a.value)
    .map((c) => ({ ...c, valueLabel: `${formatCurrency(c.value)} · ${formatCurrency(c.value / c.units)}/unit` }));
  renderBarChart(document.getElementById("category-chart"), categories);

  renderSubstrateBreakdown(document.getElementById("wallpaper-types-chart"), earnings, "Wallpaper");
  renderSubstrateBreakdown(document.getElementById("fabric-types-chart"), earnings, "Fabric");

  renderTagRevenue(earnings);
  renderRepeatBuyers(earnings);
  renderCustomers(earnings);
  renderReturnsCard(scoped);
  renderTable(scoped);
}

// ---------- Design-level rollups (all-time, not scoped to the date filter) ----------
// Powers the merged Returns card's by-design return-rate table.

function buildDesignRollups(records) {
  const byDesign = new Map();
  records.forEach((r) => {
    if (!r.designId) return;
    if (r.type !== "sale" && r.type !== "fill_a_yard" && r.type !== "return") return;

    const prev = byDesign.get(r.designId) || {
      designId: r.designId,
      name: r.designName || r.designId,
      saleCount: 0,
      returnCount: 0,
      productTypeRevenue: new Map()
    };

    if (r.type === "sale" || r.type === "fill_a_yard") {
      prev.saleCount += 1;
      const slug = classifyProductType(r.productRaw, r.productName, r.category);
      prev.productTypeRevenue.set(slug, (prev.productTypeRevenue.get(slug) || 0) + r.amount);
    } else if (r.type === "return") {
      prev.returnCount += 1;
    }

    byDesign.set(r.designId, prev);
  });
  return byDesign;
}

// ---------- Design detail modal (all-time, not scoped to the date filter) ----------
// Same reasoning as the return-rate table: a design's lifetime trend and mix
// only mean something against its full history, not whatever slice of time
// happens to be selected above.

function buildDesignDetail(designId) {
  const records = allRecords.filter((r) => r.designId === designId);
  const earnings = records.filter(isEarningRecord);
  const returns = records.filter((r) => r.type === "return");

  const name = (earnings[0] && earnings[0].designName) || (returns[0] && returns[0].designName) || designId;
  const grossRevenue = earnings.reduce((s, r) => s + r.amount, 0);
  const refundTotal = Math.abs(returns.reduce((s, r) => s + r.amount, 0));
  const unitsSold = earnings.reduce((s, r) => s + (r.quantity || 1), 0);

  const dates = earnings.map((r) => r.date).filter(Boolean).sort();

  const guestEarnings = earnings.filter((r) => !r.buyer);
  const signedInEarnings = earnings.filter((r) => r.buyer);

  const byProduct = new Map();
  const productTypeRevenue = new Map();
  earnings.forEach((r) => {
    const key = r.productName || "Unspecified";
    const prev = byProduct.get(key) || { label: key, value: 0 };
    prev.value += r.amount;
    byProduct.set(key, prev);

    const slug = classifyProductType(r.productRaw, r.productName, r.category);
    productTypeRevenue.set(slug, (productTypeRevenue.get(slug) || 0) + r.amount);
  });

  return {
    designId,
    name,
    grossRevenue,
    refundTotal,
    netRevenue: grossRevenue - refundTotal,
    salesCount: earnings.length,
    returnCount: returns.length,
    unitsSold,
    firstSold: dates[0] || null,
    lastSold: dates[dates.length - 1] || null,
    trend: bucketByMonth(earnings),
    guestCount: guestEarnings.length,
    guestRevenue: guestEarnings.reduce((s, r) => s + r.amount, 0),
    signedInCount: signedInEarnings.length,
    signedInRevenue: signedInEarnings.reduce((s, r) => s + r.amount, 0),
    byProduct: Array.from(byProduct.values()).sort((a, b) => b.value - a.value),
    productTypeRevenue
  };
}

function closeDesignDetail() {
  document.getElementById("design-detail-modal").hidden = true;
}

function openDesignDetail(designId) {
  const detail = buildDesignDetail(designId);
  const modal = document.getElementById("design-detail-modal");

  document.getElementById("design-detail-title").textContent = detail.name;
  document.getElementById("design-detail-link").href = designUrl(detail.designId, bestProductType(detail.productTypeRevenue));

  const tiles = [
    { label: "Net revenue", value: formatCurrency(detail.netRevenue) },
    { label: "Units sold", value: detail.unitsSold.toLocaleString() },
    { label: "Sales", value: detail.salesCount.toLocaleString() },
    { label: "Returns", value: detail.returnCount.toLocaleString() }
  ];
  const tilesEl = document.getElementById("design-detail-tiles");
  tilesEl.replaceChildren();
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
    tilesEl.appendChild(div);
  });

  document.getElementById("design-detail-dates").textContent = detail.firstSold
    ? `First sold ${detail.firstSold} · Last sold ${detail.lastSold}`
    : "No sales recorded yet.";

  renderTrendChart(document.getElementById("design-detail-trend"), detail.trend);

  const buyerTypeItems = [
    { label: "Signed-in", value: detail.signedInRevenue, valueLabel: `${formatCurrency(detail.signedInRevenue)} · ${detail.signedInCount}` },
    { label: "Guest", value: detail.guestRevenue, valueLabel: `${formatCurrency(detail.guestRevenue)} · ${detail.guestCount}` }
  ];
  renderBarChart(document.getElementById("design-detail-buyer-types"), buyerTypeItems);

  const productItems = detail.byProduct.map((p) => ({ label: p.label, value: p.value }));
  renderBarChart(document.getElementById("design-detail-products"), productItems);

  modal.hidden = false;
  document.getElementById("design-detail-close").focus();
}

// Whether designs make most of their money in a quick spike right after
// listing, or build up steadily over a long tail — informs whether it's
// worth chasing trends or building an evergreen catalog. For each design
// with a first sale at least 90 days ago (so all three windows have a fair
// chance to be observed — a design listed last week can't have 90-day
// data yet), computes what % of its revenue-to-date arrived within 30/60/90
// days of that first sale, then averages that % across designs. Deliberately
// all-time / unscoped by the date filter — it's a per-design cohort
// question, not a "how did this period do" one.
function computeNewDesignPerformance(records) {
  const byDesign = new Map();
  records
    .filter(isEarningRecord)
    .filter((r) => r.designId && r.date)
    .forEach((r) => {
      const prev = byDesign.get(r.designId) || { firstSaleDate: r.date, sales: [] };
      if (r.date < prev.firstSaleDate) prev.firstSaleDate = r.date;
      prev.sales.push(r);
      byDesign.set(r.designId, prev);
    });

  const today = new Date();
  const shares = { 30: [], 60: [], 90: [] };
  let eligibleCount = 0;

  byDesign.forEach((d) => {
    const firstDate = new Date(d.firstSaleDate);
    const daysSinceFirst = Math.floor((today - firstDate) / 86400000);
    if (daysSinceFirst < 90) return; // not enough history for a fair 90-day read yet
    const lifetimeRevenue = d.sales.reduce((s, r) => s + r.amount, 0);
    if (lifetimeRevenue <= 0) return;
    eligibleCount++;
    [30, 60, 90].forEach((windowDays) => {
      const cutoff = new Date(firstDate);
      cutoff.setDate(cutoff.getDate() + windowDays);
      const cutoffIso = isoDate(cutoff);
      const windowRevenue = d.sales.filter((r) => r.date < cutoffIso).reduce((s, r) => s + r.amount, 0);
      shares[windowDays].push((windowRevenue / lifetimeRevenue) * 100);
    });
  });

  const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
  return { eligibleCount, avg30: avg(shares[30]), avg60: avg(shares[60]), avg90: avg(shares[90]) };
}

function renderNewDesignPerformance(records) {
  const card = document.getElementById("new-design-performance-card");
  const result = computeNewDesignPerformance(records);

  if (result.eligibleCount < 3) {
    card.hidden = true; // too few designs with 90+ days of history for a meaningful average
    return;
  }
  card.hidden = false;

  document.getElementById("new-design-performance-caption").textContent =
    `Average share of a design's revenue-to-date earned within N days of its first sale, across ${result.eligibleCount} design(s) with at least 90 days of history. Higher early numbers mean your designs spike and taper off; lower ones mean they build steadily.`;

  const tiles = [
    { label: "First 30 days", value: `${result.avg30.toFixed(0)}%` },
    { label: "First 60 days", value: `${result.avg60.toFixed(0)}%` },
    { label: "First 90 days", value: `${result.avg90.toFixed(0)}%` }
  ];
  const container = document.getElementById("new-design-performance-tiles");
  container.replaceChildren();
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

// Attributes each earning's revenue to every tag its design carries (a
// design with 5 tags counts its full revenue toward all 5, not 1/5th each —
// this answers "which tags show up on my best sellers", not "how is
// revenue partitioned"). That alone tends to mislead: a single design with
// many tags puts all of them at the identical top value, crowding out tags
// that genuinely recur across the catalog. Sorting by how many *different*
// designs carry a tag first (then revenue as a tiebreaker) fixes that —
// tags proven across multiple designs surface first — and the design count
// is shown alongside the dollar figure so a run of identical values reads
// as "one design's tag list" rather than looking like a data error.
// Tags are often multi-word phrases ("vintage golf sport", "golfing gift
// for him") that are really just a few keywords on one design worded
// several ways — treated as whole phrases, every one of a design's tags
// shows the same dollar figure. Splitting each tag into its individual
// words instead lets "golf" from one phrase merge with "golf" from
// another, producing an actual per-keyword signal.
function wordsForDesign(designId) {
  const tags = tagsByDesignId.get(designId) || [];
  const words = new Set();
  tags.forEach((tag) => {
    tag.split(/\s+/).forEach((word) => {
      const normalized = word.trim().toLowerCase();
      if (normalized) words.add(normalized);
    });
  });
  return words;
}

function renderTagRevenue(earnings) {
  const card = document.getElementById("tags-card");
  if (tagsByDesignId.size === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const wordsByDesignId = new Map();
  const byTag = new Map();
  const untaggedByDesignId = new Map();
  earnings.forEach((r) => {
    if (!r.designId) return;
    let words = wordsByDesignId.get(r.designId);
    if (!words) {
      words = wordsForDesign(r.designId);
      wordsByDesignId.set(r.designId, words);
    }
    if (words.size === 0) {
      const prev = untaggedByDesignId.get(r.designId) || {
        designId: r.designId,
        name: r.designName || r.designId,
        value: 0,
        productTypeRevenue: new Map()
      };
      prev.value += r.amount;
      const slug = classifyProductType(r.productRaw, r.productName, r.category);
      prev.productTypeRevenue.set(slug, (prev.productTypeRevenue.get(slug) || 0) + r.amount);
      untaggedByDesignId.set(r.designId, prev);
      return;
    }
    words.forEach((word) => {
      const prev = byTag.get(word) || { label: word, value: 0, designIds: new Set() };
      prev.value += r.amount;
      prev.designIds.add(r.designId);
      byTag.set(word, prev);
    });
  });

  const items = Array.from(byTag.values())
    .sort((a, b) => b.designIds.size - a.designIds.size || b.value - a.value)
    .slice(0, 20)
    .map((t) => ({
      label: t.label,
      value: t.value,
      valueLabel: `${formatCurrency(t.value)} · ${t.designIds.size} design${t.designIds.size === 1 ? "" : "s"}`,
      onClick: () => applyDrillFilter({ label: `word "${t.label}"`, designIds: t.designIds })
    }));
  renderBarChart(document.getElementById("tags-chart"), items);
  renderUntaggedDesigns(Array.from(untaggedByDesignId.values()));
}

// A design with no tags synced (or genuinely none set on Spoonflower)
// contributes nothing to the word breakdown above and would otherwise just
// silently vanish from the chart — surfaced here instead as a collapsed,
// clickable list so it's clear those designs exist and aren't a data bug.
function renderUntaggedDesigns(items) {
  const toggle = document.getElementById("untagged-toggle");
  const list = document.getElementById("untagged-list");
  if (items.length === 0) {
    toggle.hidden = true;
    list.hidden = true;
    return;
  }
  items.sort((a, b) => b.value - a.value);

  toggle.hidden = false;
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = `▸ ${items.length} design${items.length === 1 ? "" : "s"} with no tags synced`;
  list.hidden = true;

  list.replaceChildren();
  items.forEach((d) => {
    const li = document.createElement("li");
    li.appendChild(buildDesignLinkEl(d.designId, d.name, d.productTypeRevenue));
    const value = document.createElement("span");
    value.className = "num";
    value.textContent = formatCurrency(d.value);
    li.appendChild(value);
    list.appendChild(li);
  });
}

// "Substrate" is the specific material within a category — e.g. within
// Wallpaper: Traditional, Peel and Stick, Grasscloth; within Fabric: Petal
// Signature Cotton, Cotton Poplin, Velvet. Ranked single-measure bar chart,
// same treatment as Top designs (one hue — these aren't distinct series
// being compared, just categories ranked by one number).
function renderSubstrateBreakdown(container, earnings, category) {
  const bySubstrate = new Map();
  earnings
    .filter((r) => r.category === category)
    .forEach((r) => {
      const key = r.substrate || "Unspecified";
      const prev = bySubstrate.get(key) || { label: key, value: 0, units: 0 };
      prev.value += r.amount;
      prev.units += r.quantity || 1;
      bySubstrate.set(key, prev);
    });
  const items = Array.from(bySubstrate.values())
    .sort((a, b) => b.value - a.value)
    .map((s) => ({ ...s, valueLabel: `${formatCurrency(s.value)} · ${formatCurrency(s.value / s.units)}/unit` }));
  renderBarChart(container, items);
}

// Shared by Repeat Buyers and Customers — both need the same per-buyer
// aggregation (purchase count/total/dates plus a per-design breakdown),
// just filtered and rendered differently. Guest checkouts are anonymized
// to a null buyer by Spoonflower and can't be tracked as a person at all,
// so they're excluded here rather than in each caller.
//
// Deliberately earnings-only: an earlier version also tracked returns per
// buyer, but Spoonflower's CSV export leaves the Customer column blank on
// cancellation/adjustment rows even when the original sale had a named
// buyer, so a return could never actually be attributed to anyone — the
// "Returned" column it produced showed "—" for every single buyer. Rather
// than ship a column that can never show real data, that was removed;
// per-design return rate (unaffected by this, since it doesn't need a
// buyer) is still in the Returns card below.
function buildBuyerSummaries(earnings) {
  const byBuyer = new Map();
  earnings.forEach((r) => {
    if (!r.buyer) return;
    const prev = byBuyer.get(r.buyer) || { buyer: r.buyer, count: 0, total: 0, first: r.date, last: r.date, designs: new Map() };
    prev.count += 1;
    prev.total += r.amount;
    if (r.date && (!prev.first || r.date < prev.first)) prev.first = r.date;
    if (r.date && (!prev.last || r.date > prev.last)) prev.last = r.date;

    const designKey = r.designId || r.designName || r.productName || "Unknown";
    const designPrev = prev.designs.get(designKey) || {
      design: r.designName || r.productName || "Unknown",
      designId: r.designId || null,
      count: 0,
      total: 0,
      productTypeRevenue: new Map()
    };
    designPrev.count += 1;
    designPrev.total += r.amount;
    const slug = classifyProductType(r.productRaw, r.productName, r.category);
    designPrev.productTypeRevenue.set(slug, (designPrev.productTypeRevenue.get(slug) || 0) + r.amount);
    prev.designs.set(designKey, designPrev);

    byBuyer.set(r.buyer, prev);
  });
  return Array.from(byBuyer.values());
}

function buildBuyerDesignListEl(designsMap) {
  const designList = document.createElement("ul");
  designList.className = "buyer-design-list";
  Array.from(designsMap.values())
    .sort((a, c) => c.total - a.total)
    .forEach((d) => {
      const li = document.createElement("li");
      let nameEl;
      if (d.designId) {
        const bestSlug = Array.from(d.productTypeRevenue.entries()).sort((a, c) => c[1] - a[1])[0][0];
        nameEl = document.createElement("a");
        nameEl.href = designUrl(d.designId, bestSlug);
        nameEl.target = "_blank";
        nameEl.rel = "noopener noreferrer";
      } else {
        nameEl = document.createElement("span");
      }
      nameEl.textContent = d.design; // scraped design name — textContent only
      const valueSpan = document.createElement("span");
      valueSpan.className = "num";
      valueSpan.textContent = `${d.count}× — ${formatCurrency(d.total)}`;
      li.append(nameEl, valueSpan);
      designList.appendChild(li);
    });
  return designList;
}

function renderRepeatBuyers(earnings) {
  const card = document.getElementById("repeat-buyers-card");
  const repeats = buildBuyerSummaries(earnings)
    .filter((b) => b.count >= 2)
    .sort((a, b) => b.count - a.count || b.total - a.total)
    .slice(0, 25);

  if (repeats.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const tbody = document.getElementById("repeat-buyers-table-body");
  tbody.replaceChildren();
  repeats.forEach((b, i) => {
    const detailId = `buyer-detail-${i}`;

    const tr = document.createElement("tr");
    const buyerTd = document.createElement("td");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "row-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.dataset.target = detailId;
    toggle.dataset.buyer = b.buyer;
    toggle.textContent = "▸ " + b.buyer;
    buyerTd.appendChild(toggle);

    const countTd = document.createElement("td");
    countTd.className = "num";
    countTd.textContent = b.count.toLocaleString();
    const totalTd = document.createElement("td");
    totalTd.className = "num";
    totalTd.textContent = formatCurrency(b.total);
    const firstTd = document.createElement("td");
    firstTd.textContent = b.first || "";
    const lastTd = document.createElement("td");
    lastTd.textContent = b.last || "";
    tr.append(buyerTd, countTd, totalTd, firstTd, lastTd);
    tbody.appendChild(tr);

    const detailTr = document.createElement("tr");
    detailTr.id = detailId;
    detailTr.className = "buyer-detail-row";
    detailTr.hidden = true;
    const detailTd = document.createElement("td");
    detailTd.colSpan = 5;
    detailTd.appendChild(buildBuyerDesignListEl(b.designs));
    detailTr.appendChild(detailTd);
    tbody.appendChild(detailTr);
  });
}

// ---------- Customers (tags & notes) ----------
// User-entered labels/notes per buyer, stored locally only — never scraped,
// never sent anywhere. Persists in the buyerNotes store, keyed by buyer
// username, independent of the date filter (a note about a buyer doesn't
// stop applying when you switch ranges).

async function saveBuyerNote(buyer, patch) {
  const existing = buyerNotesByBuyer.get(buyer) || { buyer, tags: [], notes: "" };
  const updated = { ...existing, ...patch, buyer, updatedAt: new Date().toISOString() };
  buyerNotesByBuyer.set(buyer, updated);
  await putBuyerNote(updated);
  return updated;
}

async function addBuyerTag(buyer, tag) {
  const normalized = tag.trim();
  if (!normalized) return;
  const existing = buyerNotesByBuyer.get(buyer) || { buyer, tags: [], notes: "" };
  if (existing.tags.includes(normalized)) return;
  await saveBuyerNote(buyer, { tags: [...existing.tags, normalized] });
}

async function removeBuyerTag(buyer, tag) {
  const existing = buyerNotesByBuyer.get(buyer);
  if (!existing) return;
  await saveBuyerNote(buyer, { tags: existing.tags.filter((t) => t !== tag) });
}

function renderCustomerTagChips(container, buyer) {
  container.replaceChildren();
  const note = buyerNotesByBuyer.get(buyer);
  const tags = (note && note.tags) || [];
  tags.forEach((tag) => {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.textContent = tag; // user-entered text — textContent only
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Remove tag ${tag}`);
    removeBtn.className = "tag-chip-remove";
    removeBtn.dataset.buyer = buyer;
    removeBtn.dataset.tag = tag;
    chip.appendChild(removeBtn);
    container.appendChild(chip);
  });
}

function updateCustomerRowTagsEl(el, buyer) {
  const note = buyerNotesByBuyer.get(buyer);
  const tags = (note && note.tags) || [];
  el.hidden = tags.length === 0;
  el.textContent = tags.length ? " " + tags.join(", ") : ""; // user-entered text — textContent only
}

// Patches the collapsed row's inline tag summary for one buyer in place,
// so adding/removing a tag from the expanded detail panel doesn't require
// a full table re-render (which would collapse every expanded row).
function refreshCustomerRowTags(buyer) {
  const toggle = document.querySelector(`#customers-table-body .row-toggle[data-buyer="${CSS.escape(buyer)}"]`);
  const rowTags = toggle && toggle.nextElementSibling;
  if (rowTags && rowTags.classList.contains("customer-row-tags")) {
    updateCustomerRowTagsEl(rowTags, buyer);
  }
}

function renderCustomers(earnings) {
  const card = document.getElementById("customers-card");
  const buyers = buildBuyerSummaries(earnings);
  if (buyers.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  let filtered = buyers;
  if (currentCustomerSearch) {
    filtered = filtered.filter((b) => {
      if (b.buyer.toLowerCase().includes(currentCustomerSearch)) return true;
      const note = buyerNotesByBuyer.get(b.buyer);
      if (!note) return false;
      if ((note.notes || "").toLowerCase().includes(currentCustomerSearch)) return true;
      return (note.tags || []).some((t) => t.toLowerCase().includes(currentCustomerSearch));
    });
  }
  filtered = filtered.slice().sort((a, b) => b.total - a.total);

  const MAX_ROWS = 200;
  const shown = filtered.slice(0, MAX_ROWS);
  const tbody = document.getElementById("customers-table-body");
  tbody.replaceChildren();
  shown.forEach((b, i) => {
    const detailId = `customer-detail-${i}`;

    const tr = document.createElement("tr");
    const buyerTd = document.createElement("td");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "row-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.dataset.target = detailId;
    toggle.dataset.buyer = b.buyer;
    toggle.textContent = "▸ " + b.buyer;
    buyerTd.appendChild(toggle);

    // Always present (even empty/hidden) so it can be found and patched in
    // place by name after a tag add/remove, without a full table re-render.
    const rowTags = document.createElement("span");
    rowTags.className = "customer-row-tags";
    buyerTd.appendChild(rowTags);
    updateCustomerRowTagsEl(rowTags, b.buyer);

    const countTd = document.createElement("td");
    countTd.className = "num";
    countTd.textContent = b.count.toLocaleString();
    const totalTd = document.createElement("td");
    totalTd.className = "num";
    totalTd.textContent = formatCurrency(b.total);
    const firstTd = document.createElement("td");
    firstTd.textContent = b.first || "";
    const lastTd = document.createElement("td");
    lastTd.textContent = b.last || "";
    tr.append(buyerTd, countTd, totalTd, firstTd, lastTd);
    tbody.appendChild(tr);

    const detailTr = document.createElement("tr");
    detailTr.id = detailId;
    detailTr.className = "buyer-detail-row";
    detailTr.hidden = true;
    const detailTd = document.createElement("td");
    detailTd.colSpan = 5;

    const tagsRow = document.createElement("div");
    tagsRow.className = "customer-tags-row";
    const chipList = document.createElement("div");
    chipList.className = "tag-chip-list";
    renderCustomerTagChips(chipList, b.buyer);
    const tagInput = document.createElement("input");
    tagInput.type = "text";
    tagInput.className = "tag-input";
    tagInput.placeholder = "Add tag, press Enter";
    tagInput.dataset.buyer = b.buyer;
    tagsRow.append(chipList, tagInput);

    const notesArea = document.createElement("textarea");
    notesArea.className = "customer-notes";
    notesArea.placeholder = "Private notes about this buyer — wholesale terms, custom requests, anything worth remembering.";
    notesArea.dataset.buyer = b.buyer;
    notesArea.value = (buyerNotesByBuyer.get(b.buyer) || {}).notes || "";

    detailTd.append(tagsRow, notesArea, buildBuyerDesignListEl(b.designs));
    detailTr.appendChild(detailTd);
    tbody.appendChild(detailTr);
  });

  const countEl = document.getElementById("customers-count");
  countEl.textContent =
    filtered.length > MAX_ROWS
      ? `Showing ${MAX_ROWS} of ${filtered.length.toLocaleString()} customers — search to narrow`
      : `${filtered.length.toLocaleString()} customer${filtered.length === 1 ? "" : "s"}`;
}

// Merged card: the date-scoped summary line (how many/how much this period)
// plus the all-time, unscoped by-design return-rate table (needs a design's
// full sale history to mean anything, so it isn't filtered by the date range).
function renderReturnsCard(scopedRecords) {
  const returns = scopedRecords.filter((r) => r.type === "return");
  const rateItems = Array.from(designRollups.values())
    .filter((d) => d.returnCount > 0 && d.saleCount > 0)
    .map((d) => ({ ...d, rate: (d.returnCount / d.saleCount) * 100 }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 25);

  const card = document.getElementById("returns-card");
  if (returns.length === 0 && rateItems.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const totalEl = document.getElementById("returns-total");
  if (returns.length === 0) {
    totalEl.textContent = "No returns in this range.";
  } else {
    const total = returns.reduce((s, r) => s + r.amount, 0); // amounts are negative
    totalEl.textContent =
      `${formatCurrency(Math.abs(total))} across ${returns.length} order${returns.length === 1 ? "" : "s"} — excluded from revenue above.`;
  }

  const rateTable = document.getElementById("return-rate-table");
  rateTable.hidden = rateItems.length === 0;
  document.getElementById("return-rate-caption").hidden = rateItems.length === 0;
  const tbody = document.getElementById("return-rate-table-body");
  tbody.replaceChildren();
  rateItems.forEach((d) => {
    const tr = document.createElement("tr");
    const designTd = document.createElement("td");
    designTd.appendChild(buildDesignLinkEl(d.designId, d.name, d.productTypeRevenue));
    const salesTd = document.createElement("td");
    salesTd.className = "num";
    salesTd.textContent = d.saleCount.toLocaleString();
    const returnsTd = document.createElement("td");
    returnsTd.className = "num";
    returnsTd.textContent = d.returnCount.toLocaleString();
    const rateTd = document.createElement("td");
    rateTd.className = "num";
    rateTd.textContent = `${d.rate.toFixed(1)}%`;
    tr.append(designTd, salesTd, returnsTd, rateTd);
    tbody.appendChild(tr);
  });
}

function renderTable(scopedRecords) {
  let rows = scopedRecords.filter((r) => r.type !== "payout" && r.type !== "return");

  const chip = document.getElementById("drill-filter-chip");
  if (currentDrillFilter) {
    rows = rows.filter((r) => r.designId && currentDrillFilter.designIds.has(r.designId));
    chip.hidden = false;
    document.getElementById("drill-filter-label").textContent = `Filtered by ${currentDrillFilter.label}`;
  } else {
    chip.hidden = true;
  }

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

    const dateTd = document.createElement("td");
    dateTd.textContent = r.date || "";

    const designTd = document.createElement("td");
    if (r.designId) {
      const slug = classifyProductType(r.productRaw, r.productName, r.category);
      const link = document.createElement("a");
      link.className = "design-link";
      link.href = designUrl(r.designId, slug);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = r.designName || ""; // scraped design name — textContent only
      designTd.appendChild(link);
    } else {
      designTd.textContent = r.designName || "";
    }

    const productTd = document.createElement("td");
    productTd.textContent = r.productName || "";
    const categoryTd = document.createElement("td");
    categoryTd.textContent = r.category || "";
    const buyerTd = document.createElement("td");
    buyerTd.textContent = r.buyer || "guest";
    const amountTd = document.createElement("td");
    amountTd.className = "num";
    amountTd.textContent = formatCurrency(r.amount);

    tr.append(dateTd, designTd, productTd, categoryTd, buyerTd, amountTd);
    tbody.appendChild(tr);
  });

  const countEl = document.getElementById("table-count");
  countEl.textContent =
    rows.length > MAX_ROWS
      ? `Showing ${MAX_ROWS} of ${rows.length.toLocaleString()} transactions — search or narrow the date range to see more`
      : `${rows.length.toLocaleString()} transactions`;
}

// ---------- Payouts (Spoonflower's official per-year figures) ----------

function renderPayoutsTable(summaries) {
  const card = document.getElementById("payouts-card");
  const summariesWithPaidOut = (summaries || []).filter((s) => s.paidOut != null);
  if (summariesWithPaidOut.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const tbody = document.getElementById("payouts-table-body");
  tbody.replaceChildren();

  summariesWithPaidOut
    .slice()
    .sort((a, b) => a.year - b.year)
    .forEach((summary) => {
      const tr = document.createElement("tr");
      const yearTd = document.createElement("td");
      yearTd.textContent = String(summary.year);
      const officialTd = document.createElement("td");
      officialTd.className = "num";
      officialTd.textContent = formatCurrency(Math.abs(summary.paidOut));
      tr.append(yearTd, officialTd);
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

async function init() {
  allRecords = await getAllTransactions();
  const [lastSyncAt, yearlySummaries, designTags, buyerNotes] = await Promise.all([
    getMeta("lastSyncAt"),
    getAllYearlySummaries(),
    getAllDesignTags(),
    getAllBuyerNotes()
  ]);
  tagsByDesignId = new Map(designTags.map((d) => [d.designId, d.tags || []]));
  buyerNotesByBuyer = new Map(buyerNotes.map((n) => [n.buyer, n]));
  renderPayoutsTable(yearlySummaries);

  designRollups = buildDesignRollups(allRecords);
  renderNewDesignPerformance(allRecords);

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

  // Delegated once here rather than re-bound per row, since
  // renderRepeatBuyers replaces the tbody's contents on every re-render.
  document.getElementById("repeat-buyers-table").addEventListener("click", (e) => {
    const btn = e.target.closest(".row-toggle");
    if (!btn) return;
    const target = document.getElementById(btn.dataset.target);
    if (!target) return;
    const expanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!expanded));
    target.hidden = expanded;
    btn.textContent = (expanded ? "▸ " : "▾ ") + btn.dataset.buyer;
  });

  // Customers table: row expand/collapse (same pattern as Repeat Buyers),
  // plus tag removal — both delegated since tbody is rebuilt on every
  // re-render.
  document.getElementById("customers-table").addEventListener("click", async (e) => {
    const toggleBtn = e.target.closest(".row-toggle");
    if (toggleBtn) {
      const target = document.getElementById(toggleBtn.dataset.target);
      if (!target) return;
      const expanded = toggleBtn.getAttribute("aria-expanded") === "true";
      toggleBtn.setAttribute("aria-expanded", String(!expanded));
      target.hidden = expanded;
      toggleBtn.textContent = (expanded ? "▸ " : "▾ ") + toggleBtn.dataset.buyer;
      return;
    }
    const removeBtn = e.target.closest(".tag-chip-remove");
    if (removeBtn) {
      const chipList = removeBtn.closest(".tag-chip-list");
      await removeBuyerTag(removeBtn.dataset.buyer, removeBtn.dataset.tag);
      renderCustomerTagChips(chipList, removeBtn.dataset.buyer);
      refreshCustomerRowTags(removeBtn.dataset.buyer);
    }
  });

  document.getElementById("customers-table").addEventListener("keydown", async (e) => {
    if (!e.target.classList.contains("tag-input") || e.key !== "Enter") return;
    e.preventDefault();
    const input = e.target;
    await addBuyerTag(input.dataset.buyer, input.value);
    input.value = "";
    const chipList = input.closest(".customer-tags-row").querySelector(".tag-chip-list");
    renderCustomerTagChips(chipList, input.dataset.buyer);
    refreshCustomerRowTags(input.dataset.buyer);
  });

  // focusout (not blur) so it bubbles and can be delegated on the table.
  document.getElementById("customers-table").addEventListener("focusout", (e) => {
    if (!e.target.classList.contains("customer-notes")) return;
    saveBuyerNote(e.target.dataset.buyer, { notes: e.target.value });
  });

  document.getElementById("customer-search").addEventListener("input", (e) => {
    currentCustomerSearch = e.target.value.toLowerCase();
    renderAll();
  });

  document.getElementById("design-detail-close").addEventListener("click", closeDesignDetail);
  document.getElementById("design-detail-modal").addEventListener("click", (e) => {
    if (e.target.id === "design-detail-modal") closeDesignDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("design-detail-modal").hidden) closeDesignDetail();
  });

  document.getElementById("untagged-toggle").addEventListener("click", () => {
    const btn = document.getElementById("untagged-toggle");
    const list = document.getElementById("untagged-list");
    const expanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!expanded));
    list.hidden = expanded;
    btn.textContent = (expanded ? "▸" : "▾") + btn.textContent.slice(1);
  });

  document.getElementById("drill-filter-clear").addEventListener("click", () => {
    currentDrillFilter = null;
    renderAll();
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
