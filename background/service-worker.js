import { putTransactions, setMeta, getMeta, countTransactions } from "../lib/db.js";

// The content script runs at spoonflower.com's origin and can't reach the
// extension's own IndexedDB directly, so it relays parsed rows here for
// storage. Reads for the popup and dashboard go straight to lib/db.js since
// those pages already run at the extension's chrome-extension:// origin;
// GET_STATS exists only because the content script (page origin) needs the
// same relay for reads too.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "SYNC_TRANSACTIONS") {
    (async () => {
      try {
        const result = await putTransactions(message.records || []);
        await setMeta("lastSyncAt", new Date().toISOString());
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message.type === "OPEN_DASHBOARD") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
    return false;
  }

  if (message.type === "GET_STATS") {
    (async () => {
      try {
        const [count, lastSyncAt] = await Promise.all([countTransactions(), getMeta("lastSyncAt")]);
        sendResponse({ ok: true, count, lastSyncAt: lastSyncAt || null });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  return false;
});
