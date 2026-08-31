# Spoonflower Sales Analytics

A Chrome extension that turns your Spoonflower Spoondollar sales history into
a local analytics dashboard: revenue trends, best/worst sellers, and a
product-type breakdown — all built from data already visible to you on
Spoonflower, stored entirely on your own machine.

## How it works

Spoonflower doesn't expose a public sales API, but the "Yearly Spoondollar
Statements" page (`/account/<id>?sub_action=spoondollars&transition=statements`)
offers a CSV export per year with every field this extension needs already
broken into its own column (date, design, design id, product, substrate,
buyer, amount). The extension fetches that CSV directly (same-origin, one
request per year, no page navigation) and parses it into structured records
stored locally in IndexedDB. Nothing is sent anywhere — there's no backend,
no account, no network calls beyond the Spoonflower pages you're already
logged into.

An earlier version scraped the separate "Spoondollar history" ledger table
instead, driving its date-range filter programmatically to page through
history. That turned out to be unreliable — the filter's form controls
couldn't be located reliably by heuristic, so every "year" silently
re-scraped whatever the page defaulted to. The CSV export needs none of
that: the year is a plain URL query parameter, and the whole year comes
back in one response.

- **Content script** (`content/`) — on the Spoondollar history page, injects
  a small sync panel with:
  - **Full Backfill** — fetches each year's CSV statement from 2021 (adjust
    `startYear` in `content/spoonflower-history.js` if you started selling
    earlier; Spoonflower supports back to 2008) through the current year.
  - **Sync This Year** — re-fetches just the current year's CSV, for
    catching up after the initial backfill.
  - **Verify Totals** — fetches the *summary* numbers from the same Yearly
    Statements page (Total Earned From Sales, Paid Out, Spent, Withheld per
    year) — never as the transaction source itself, since that summary page
    has no stable per-row id to dedupe on. The dashboard's Payouts card
    surfaces the "Paid Out" figure specifically, since that's the one
    directly checkable against a bank statement (see note below on why
    "Earned" and "Paid Out" don't — and shouldn't — match for the same
    calendar year).
- **Background service worker** (`background/`) — receives parsed records
  from the content script and writes them to IndexedDB (the content script
  itself can't reach the extension's storage directly, since it runs at
  spoonflower.com's origin).
- **Dashboard** (`dashboard/`) — a full analytics view: revenue trend, top
  designs, revenue by category (wallpaper/fabric), a searchable/sortable
  transaction table, CSV export, and a verification table comparing synced
  totals against Spoonflower's official per-year figures.
- **Popup** — a quick-glance summary from the toolbar icon.

## Installing (unpacked, for development)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repository's folder.
4. Visit your Spoondollar history page on Spoonflower — the sync panel
   appears above the transaction table.

## Using it

1. On the Spoondollar history page, click **Full Backfill (2021–now)**. Each
   year is one fetch, so this is fast — a handful of seconds for several
   years of history.
2. Click **Verify Totals** to pull Spoonflower's own official per-year
   payout figures.
3. Click **Open Dashboard** (from the panel or the toolbar popup) to see your
   analytics, including the Payouts card — compare that against your bank
   deposits. (It won't match "Total Earned From Sales" for the same
   calendar year, even when everything is correct — payouts lag earnings,
   since money earned late in a year is often paid out early the next.)
4. On future visits, **Sync This Year** is enough to catch up — syncing is
   idempotent (records are upserted by a synthesized id derived from the
   CSV's second-precision timestamp, design id, and amount), so re-running
   it never creates duplicates.

## Data & privacy

- Everything is stored locally in your browser's IndexedDB; nothing is
  transmitted off your machine.
- The synced data includes buyer usernames as shown in Spoonflower's own
  export. These are stored locally like any other field but are not
  surfaced in the dashboard's charts — only in the raw transaction table and
  CSV export.
- Uninstalling the extension removes its local database.

## Extending

This first version covers: revenue trend, best/worst sellers, product-type
(wallpaper/fabric) breakdown, returns, repeat buyers, official payout
figures, and CSV export. Natural next additions: custom tagging/grouping of
designs into your own collections, and a design-performance view (if
Spoonflower ever exposes view/favorite counts alongside sales).
