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

  // ---- Yearly Spoondollar Statement CSV parsing ----
  // Spoonflower's own export from the Yearly Spoondollar Statements page
  // ("Download {year} Spoondollar Transaction Statement (CSV)"). Despite the
  // .csv extension it's tab-delimited in practice, so the delimiter is
  // sniffed from the header line rather than assumed. Confirmed columns:
  // Date, Type, Qty, Size, Design, Design id, Substrate, Customer, Amount,
  // Balance, Description. This is the primary transaction source — unlike
  // the ledger page it needs no date-picker automation (one fetch per year,
  // whole year in one response) and every field is already broken into its
  // own column, so no text-regex parsing is needed except two optional
  // extras (currency/ex-rate) folded out of Description.
  //
  // There's no per-row id column, so one is synthesized from the full
  // second-precision timestamp + design id + amount, with an occurrence
  // counter as a tiebreaker for the rare case of two matching rows in the
  // same second (this file's timestamps are precise enough that collisions
  // should be effectively impossible without it, but the counter costs
  // nothing and removes the risk entirely).
  function parseDelimitedText(text) {
    var firstLine = (text.split(/\r?\n/, 1) || [""])[0] || "";
    var tabCount = (firstLine.match(/\t/g) || []).length;
    var commaCount = (firstLine.match(/,/g) || []).length;
    var delimiter = tabCount >= commaCount ? "\t" : ",";

    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;

    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === delimiter) {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // skip; \n follows
      } else {
        field += c;
      }
    }
    if (field !== "" || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter(function (r) {
      return r.some(function (cell) {
        return cell !== "";
      });
    });
  }

  function parseYearlyCsvStatement(text) {
    var rows = parseDelimitedText(text);
    if (rows.length < 2) return [];
    var header = rows[0].map(function (h) {
      return h.trim();
    });
    var idx = {};
    header.forEach(function (h, i) {
      idx[h] = i;
    });

    if (!("Date" in idx) || !("Type" in idx) || !("Amount" in idx)) {
      console.warn("[Spoonflower Analytics] Yearly statement CSV missing expected columns:", header);
      return [];
    }

    var occurrenceCounts = {};
    var records = [];

    function get(cols, name) {
      return idx[name] != null ? (cols[idx[name]] || "").trim() : "";
    }

    for (var r = 1; r < rows.length; r++) {
      var cols = rows[r];
      var dateRaw = get(cols, "Date"); // e.g. "2021-12-31 03:20:52 UTC"
      var dateMatch = dateRaw.match(/^(\d{4}-\d{2}-\d{2})/);
      var date = dateMatch ? dateMatch[1] : null;
      var amount = parseMoney(get(cols, "Amount"));
      if (amount == null || !date) continue;

      var typeRaw = get(cols, "Type").toLowerCase();
      var description = get(cols, "Description");
      // Order cancellations/refunds show up with their own Description
      // shape ("Order Canceled | Design: X (Adjustment on original
      // transaction - DATE)") rather than the "Sale: ..." format, and may
      // still carry Type "sale" from Spoonflower's own export — so this
      // check runs before, and overrides, the typeRaw-based classification.
      var isReturn = /order canceled|adjustment on original transaction/i.test(description);
      var isFillAYard = /fill-a-yard/i.test(description);
      var type = typeRaw === "payout" ? "payout" : isReturn ? "return" : isFillAYard ? "fill_a_yard" : typeRaw === "sale" ? "sale" : typeRaw || "unknown";

      var designId = get(cols, "Design id") || null;
      var designName = get(cols, "Design") || null;
      if (!designName && isReturn) {
        // Fallback for a return row whose Design column came back empty —
        // the design name still appears inline in the Description text, in
        // one of two observed shapes: "Design: NAME (Adjustment..." or
        // "Design id NNNNN 'NAME' (Adjustment...".
        var designMatch = description.match(/Design(?:\s*:\s*|\s+id\s+\d+\s+')(.+?)'?\s*\(Adjustment/i);
        if (designMatch) designName = designMatch[1].trim();
      }
      if (!designId && isReturn) {
        var returnIdMatch = description.match(/Design\s+id\s+(\d+)/i);
        if (returnIdMatch) designId = returnIdMatch[1];
      }
      var productRaw = get(cols, "Size") || null;
      var substrate = get(cols, "Substrate") || null;
      var buyerRaw = get(cols, "Customer");
      var buyer = /^a guest user$/i.test(buyerRaw) ? null : buyerRaw || null;
      var qtyRaw = get(cols, "Qty");
      var exchange = description.match(/\((\w+) sale, ex rate ([\d.]+)\)/);

      // Keyed on date+designId only (not amount): the occurrence counter's
      // job is to disambiguate every row sharing a timestamp+design, and
      // that includes rows with genuinely different amounts (e.g. two
      // "Order Canceled" adjustment lines from one multi-item cancellation,
      // at the same second, same design, different amounts) — keying by
      // amount too would let two such rows each restart at occurrence 0
      // and collide on the same id, silently dropping one.
      var dedupeKey = dateRaw + "::" + (designId || "");
      var occurrence = occurrenceCounts[dedupeKey] || 0;
      occurrenceCounts[dedupeKey] = occurrence + 1;
      var id = "csv-" + dateRaw.replace(/[^0-9]/g, "") + "-" + (designId || "x") + "-" + occurrence;

      records.push({
        id: id,
        date: date,
        rawDate: dateRaw,
        type: type,
        amount: amount,
        balance: parseMoney(get(cols, "Balance")),
        rawText: description,
        designId: designId,
        designName: designName,
        productRaw: productRaw,
        productName: productRaw ? SpoonflowerProductTypes.normalizeProductName(productRaw) : null,
        category: productRaw || substrate ? SpoonflowerProductTypes.categorize(productRaw, substrate) : null,
        substrate: substrate,
        buyer: buyer,
        quantity: qtyRaw ? parseInt(qtyRaw, 10) : null,
        currency: exchange ? exchange[1] : null,
        exRate: exchange ? parseFloat(exchange[2]) : null,
        percent: null
      });
    }
    return records;
  }

  return {
    parseRow: parseRow,
    parseHistoryTable: parseHistoryTable,
    parseDate: parseDate,
    parseMoney: parseMoney,
    normalizeWhitespace: normalizeWhitespace,
    parseDelimitedText: parseDelimitedText,
    parseYearlyCsvStatement: parseYearlyCsvStatement
  };
})();
