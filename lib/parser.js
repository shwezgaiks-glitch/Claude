// Classic script — parses the Spoonflower "Spoondollar history" table
// (table.spoonclams) into structured transaction records. Depends on
// SpoonflowerProductTypes (loaded first, see manifest.json).

var SpoonflowerParser = (function () {
  function normalizeWhitespace(str) {
    return (str || "").replace(/\s+/g, " ").trim();
  }

  function parseMoney(str) {
    if (!str) return null;
    var cleaned = str.replace(/[^0-9.\-]/g, "");
    if (cleaned === "" || cleaned === "-") return null;
    return parseFloat(cleaned);
  }

  // Table dates are MM-DD-YY with a 2-digit year. Spoonflower launched in
  // 2008, so every year in this ledger is unambiguously 20YY.
  function parseDate(mmddyy) {
    var m = mmddyy.match(/^(\d{2})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var month = m[1],
      day = m[2],
      year = "20" + m[3];
    return {
      iso: year + "-" + month + "-" + day,
      year: parseInt(year, 10),
      month: parseInt(month, 10),
      day: parseInt(day, 10)
    };
  }

  function baseRecord(tr, cells) {
    var dateRaw = normalizeWhitespace(cells[0].textContent);
    var detailsRaw = normalizeWhitespace(cells[1].textContent);
    var debit = parseMoney(cells[2].textContent);
    var credit = parseMoney(cells[3].textContent);
    var balance = parseMoney(cells[4].textContent);
    var date = parseDate(dateRaw);

    return {
      id: tr.id || null,
      date: date ? date.iso : null,
      rawDate: dateRaw,
      // Credit cells are positive earnings; debit cells already carry their
      // own minus sign (e.g. "-$72.39000" for a payout), so it's used as-is.
      amount: credit != null ? credit : debit != null ? debit : 0,
      balance: balance,
      rawText: detailsRaw,
      type: "unknown",
      designId: null,
      designName: null,
      productRaw: null,
      productName: null,
      category: null,
      substrate: null,
      buyer: null,
      quantity: null,
      currency: null,
      exRate: null,
      percent: null
    };
  }

  // Regexes run against whitespace-normalized text pulled from live DOM
  // (entities like &#x27; are already decoded by the browser at that point).
  var SALE_RE =
    /^Sale: (\d+) x (.+) of design id (\d+) '(.+)' on (.+?) to (.+) \((\w+) sale, ex rate ([\d.]+)\)$/;
  var FILL_A_YARD_RE =
    /^(.+?) used design id (\d+) '(.+)' in ([\d.]+)% of a Fill-A-Yard project on (.+) of (.+) \((\w+) sale, ex rate ([\d.]+)\)$/;
  var PAYOUT_RE = /^Spoondollar Payout for (.+)$/;

  function parseRow(tr) {
    var cells = tr.querySelectorAll("td");
    if (cells.length < 5) return null;

    var record = baseRecord(tr, cells);
    var className = tr.className || "";
    var text = record.rawText;
    var m;

    if (className.indexOf("payout") !== -1) {
      record.type = "payout";
      m = text.match(PAYOUT_RE);
      if (m) record.payoutLabel = m[1];
      return record;
    }

    m = text.match(SALE_RE);
    if (m) {
      record.type = "sale";
      record.quantity = parseInt(m[1], 10);
      record.productRaw = m[2];
      record.productName = SpoonflowerProductTypes.normalizeProductName(m[2]);
      record.designId = m[3];
      record.designName = m[4];
      record.substrate = m[5];
      record.buyer = /^a guest user$/i.test(m[6]) ? null : m[6];
      record.currency = m[7];
      record.exRate = parseFloat(m[8]);
      record.category = SpoonflowerProductTypes.categorize(record.productName, record.substrate);
      return record;
    }

    m = text.match(FILL_A_YARD_RE);
    if (m) {
      record.type = "fill_a_yard";
      record.buyer = m[1];
      record.designId = m[2];
      record.designName = m[3];
      record.percent = parseFloat(m[4]);
      record.productRaw = m[5];
      record.productName = m[5];
      record.substrate = m[6];
      record.currency = m[7];
      record.exRate = parseFloat(m[8]);
      record.category = SpoonflowerProductTypes.categorize(record.substrate, record.substrate);
      return record;
    }

    // Unrecognized row shape (a new transaction type Spoonflower adds
    // later, say) — keep rawText so nothing is silently dropped, and let
    // the dashboard surface an "unrecognized transactions" count.
    return record;
  }

  function parseHistoryTable(tableEl) {
    var rows = tableEl.querySelectorAll('tr.sale, tr.debit, tr[class*="payout"]');
    var records = [];
    for (var i = 0; i < rows.length; i++) {
      var rec = parseRow(rows[i]);
      if (rec && rec.id) records.push(rec);
    }
    return records;
  }

  return {
    parseRow: parseRow,
    parseHistoryTable: parseHistoryTable,
    parseDate: parseDate,
    parseMoney: parseMoney,
    normalizeWhitespace: normalizeWhitespace
  };
})();
