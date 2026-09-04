// ES module — shared IndexedDB access for the background service worker,
// the dashboard page, and the popup. All three run at the extension's own
// chrome-extension:// origin, so they see the same database. The content
// script (running at spoonflower.com's origin) cannot reach this directly —
// it relays parsed records to the background worker over chrome.runtime
// messaging instead.

const DB_NAME = "spoonflower-analytics";
const DB_VERSION = 4;
const STORE_TRANSACTIONS = "transactions";
const STORE_META = "meta";
const STORE_YEARLY_SUMMARY = "yearlySummary";
const STORE_DESIGN_TAGS = "designTags";
const STORE_BUYER_NOTES = "buyerNotes";

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TRANSACTIONS)) {
        const store = db.createObjectStore(STORE_TRANSACTIONS, { keyPath: "id" });
        store.createIndex("date", "date", { unique: false });
        store.createIndex("designId", "designId", { unique: false });
        store.createIndex("type", "type", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
      // Official per-year totals scraped from Spoonflower's own "Yearly
      // Spoondollar Statements" page (Total Earned From Sales / Paid Out /
      // Spent / Withheld) — used only to cross-check the ledger-derived
      // totals below, never as the source of transaction records (that page
      // doesn't expose a stable per-row id, so it can't be deduped safely).
      if (!db.objectStoreNames.contains(STORE_YEARLY_SUMMARY)) {
        db.createObjectStore(STORE_YEARLY_SUMMARY, { keyPath: "year" });
      }
      // Tags/keywords per design, scraped from the seller's own design
      // library (spoonflower.com/designs, batch view) — not available from
      // any transaction source. Used to correlate tags with sales.
      if (!db.objectStoreNames.contains(STORE_DESIGN_TAGS)) {
        db.createObjectStore(STORE_DESIGN_TAGS, { keyPath: "designId" });
      }
      // User-entered labels/notes per buyer username — never scraped, purely
      // local annotations the seller adds themselves (e.g. "interior
      // designer", wholesale terms). Keyed by buyer since that's the only
      // stable identifier a transaction record carries for a signed-in buyer.
      if (!db.objectStoreNames.contains(STORE_BUYER_NOTES)) {
        db.createObjectStore(STORE_BUYER_NOTES, { keyPath: "buyer" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Upserts records by id (transaction id from the ledger row). Returns how
// many of the given records were brand new vs. already present, so callers
// can report sync progress without a separate read pass.
export async function putTransactions(records) {
  if (!records || records.length === 0) return { added: 0, updated: 0 };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TRANSACTIONS, "readwrite");
    const store = tx.objectStore(STORE_TRANSACTIONS);
    let added = 0;
    let updated = 0;
    let pending = records.length;

    records.forEach((record) => {
      const getReq = store.get(record.id);
      getReq.onsuccess = () => {
        if (getReq.result) updated++;
        else added++;
        store.put(record);
      };
      getReq.onerror = () => {
        // Treat as new if the lookup itself failed; put still runs below.
        added++;
      };
    });

    tx.oncomplete = () => resolve({ added, updated });
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllTransactions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TRANSACTIONS, "readonly");
    const store = tx.objectStore(STORE_TRANSACTIONS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function countTransactions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TRANSACTIONS, "readonly");
    const req = tx.objectStore(STORE_TRANSACTIONS).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function clearAllTransactions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TRANSACTIONS, "readwrite");
    tx.objectStore(STORE_TRANSACTIONS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// records: [{ year, earned, paidOut, spent, withheld }, ...]. Upserted by
// year, so re-fetching a year (e.g. the current, still-changing one) just
// overwrites it.
export async function putYearlySummaries(records) {
  if (!records || records.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_YEARLY_SUMMARY, "readwrite");
    const store = tx.objectStore(STORE_YEARLY_SUMMARY);
    records.forEach((record) => store.put(record));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllYearlySummaries() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_YEARLY_SUMMARY, "readonly");
    const req = tx.objectStore(STORE_YEARLY_SUMMARY).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// records: [{ designId, name, status, tags: [...] }, ...]. Upserted by
// designId, so re-syncing just refreshes each design's current tags.
export async function putDesignTags(records) {
  if (!records || records.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DESIGN_TAGS, "readwrite");
    const store = tx.objectStore(STORE_DESIGN_TAGS);
    records.forEach((record) => store.put(record));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllDesignTags() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DESIGN_TAGS, "readonly");
    const req = tx.objectStore(STORE_DESIGN_TAGS).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// record: { buyer, tags: string[], notes: string, updatedAt: ISOString }.
// Upserted by buyer, so saving just overwrites that buyer's whole record —
// callers read-modify-write via getBuyerNote first.
export async function putBuyerNote(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BUYER_NOTES, "readwrite");
    tx.objectStore(STORE_BUYER_NOTES).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllBuyerNotes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BUYER_NOTES, "readonly");
    const req = tx.objectStore(STORE_BUYER_NOTES).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getMeta(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, "readonly");
    const req = tx.objectStore(STORE_META).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, "readwrite");
    tx.objectStore(STORE_META).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
