# Spoonflower Sales Analytics

A Chrome extension that turns your Spoonflower "Spoondollar history" ledger
into a local analytics dashboard: revenue trends, best/worst sellers, and a
product-type breakdown — all built from data already visible to you on
Spoonflower, stored entirely on your own machine.

## How it works

Spoonflower doesn't expose a public sales API, so this extension reads the
same HTML table your browser already renders on your Spoondollar history
page, parses it into structured records, and stores them locally in the
browser's IndexedDB. Nothing is sent anywhere — there's no backend, no
account, no network calls beyond the Spoonflower pages you're already on.

- **Content script** (`content/`) — detects the Spoondollar history table on
  the page, injects a small sync panel above it, and can drive the page's own
  date-range filter to pull your full history (back to 2008) in one pass.
- **Background service worker** (`background/`) — receives parsed rows from
  the content script and writes them to IndexedDB (the content script itself
  can't reach the extension's storage directly, since it runs at
  spoonflower.com's origin).
- **Dashboard** (`dashboard/`) — a full analytics view: revenue trend, top
  designs, revenue by category (wallpaper/fabric), a searchable/sortable
  transaction table, and CSV export.
- **Popup** — a quick-glance summary from the toolbar icon.

## Installing (unpacked, for development)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repository's folder.
4. Visit your Spoondollar history page on Spoonflower — the sync panel
   appears above the transaction table.

## Using it

1. On the Spoondollar history page, click **Full Backfill (2008–now)**. This
   steps through your history year by year, scraping and storing each batch.
   It takes a little while for long histories — the panel shows progress.
2. Click **Open Dashboard** (from the panel or the toolbar popup) to see your
   analytics.
3. On future visits, **Sync Recent (90 days)** is enough to catch up — the
   backfill is idempotent, so re-running it never creates duplicates.

## Known limitation: the date-filter selectors

The content script drives the page's FROM DATE / TO DATE fields and Search
button by best-effort heuristics (matching on nearby label text like "date"
and a button whose text is "Search"), since the exact markup of that form
wasn't available while building this. If **Full Backfill** or **Sync Recent**
reports it "couldn't locate the date filter controls," open the browser
console on that page — it logs which of the two date inputs and the search
button it did/didn't find — and tighten the selectors in
`content/spoonflower-history.js` (`guessDateInputs` / `guessSearchButton`)
against the real form HTML.

## Data & privacy

- Everything is stored locally in your browser's IndexedDB; nothing is
  transmitted off your machine.
- The ledger sometimes includes buyer usernames or lightly-obfuscated email
  addresses (e.g. `name@gmail_com`). These are stored locally like any other
  field but are not surfaced in the dashboard's charts — only in the raw
  transaction table and CSV export.
- Uninstalling the extension removes its local database.

## Extending

This first version covers: revenue trend, best/worst sellers, product-type
(wallpaper/fabric) breakdown, and CSV export. Natural next additions:
Spoondollar payout tracking (earned vs. paid out over time), and custom
tagging/grouping of designs into your own collections.
