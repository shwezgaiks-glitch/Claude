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
  - **Sync Design Tags** — fetches your design library
    (`/designs?...&look=batch&...`) page by page (72 designs per page,
    stops once a page comes back empty) and pulls each design's tags,
    status, full name, and thumbnail URL from the batch-edit markup.
    Powers the dashboard's "Revenue by tag" breakdown and its design
    thumbnails — not a transaction source, just metadata joined against
    designId. The thumbnail costs no extra request: its URL is already in
    the library markup, and only that URL is stored, never the image data.
- **Background service worker** (`background/`) — receives parsed records
  from the content script and writes them to IndexedDB (the content script
  itself can't reach the extension's storage directly, since it runs at
  spoonflower.com's origin).
- **Dashboard** (`dashboard/`) — a full analytics view: revenue trend with a
  period-over-period delta, top designs (linked to their Spoonflower
  product pages), revenue by category and by substrate (wallpaper/fabric
  types, each with a $/unit average), revenue by tag, keyword trends,
  design families, swatch conversion, new design
  performance (how much of a design's revenue arrives in its first
  30/60/90 days), returns (a date-scoped summary alongside an all-time
  return-rate-by-design table), official payout figures, a
  searchable/sortable transaction table, and CSV export. Refund % and
  guest-checkout % surface as notes on the revenue and sales-count tiles.
  Clicking a bar in Top Designs or Revenue by Tag filters the transaction
  table to just that design's or tag's records (click the chip's × to
  clear it). Clicking a Top Designs bar's dollar value instead opens a
  detail view for that design: its thumbnail, lifetime net revenue, units,
  returns, a monthly revenue trend, and buyer-type/product breakdowns —
  all all-time, not scoped to the date filter. Once design tags are
  synced, Top Designs shows each design's thumbnail inline too. A **Customers** card lists
  every signed-in buyer with a per-buyer design breakdown plus your own
  free-text tags and private notes attached (e.g. "interior designer",
  wholesale terms) — stored locally only, searchable by name, tag, or note
  text, with a "Repeat buyers only" toggle for the ones who came back and
  a headline showing how much of your signed-in revenue they account for.
  (Guest checkouts are anonymized by Spoonflower, so they can't appear
  here at all.)

  Three views build on the synced tags rather than the sales data alone:
  **Keyword trends** plots each top keyword's monthly revenue as its own
  small panel — deliberately not one chart with a line per keyword, which
  knots into unreadable spaghetti; all panels share one vertical scale so
  their heights compare honestly. **Design families** groups designs by
  how much of their tag vocabulary they share, which tends to recover the
  sets you published together (one motif in several colorways) without
  looking at the images, and ranks those groups by combined revenue.
  **Swatch conversion** tracks how often a buyer who ordered a swatch came
  back later for a full-size order of the same design — signed-in buyers
  only, since guest swatches can't be tied to a later guest order.
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

- Everything is stored locally in your browser's IndexedDB; none of your
  data is transmitted off your machine.
- One caveat to that, worth stating plainly: design thumbnails are stored
  as URLs pointing at Spoonflower's image CDN, not as copied image data.
  So when the dashboard displays them, your browser requests those images
  from `img.spoonflower.com` — which means Spoonflower's CDN can see that
  you opened the dashboard, the same way it would if you were browsing
  your design library. No data of yours is sent in those requests, and
  nothing goes to any third party. If you'd rather the dashboard make no
  network requests at all, delete your `designTags` store (or just don't
  run Sync Design Tags) and everything else still works.
- The synced data includes buyer usernames as shown in Spoonflower's own
  export. These are stored locally like any other field but are not
  surfaced in the dashboard's charts — only in the raw transaction table,
  the Customers card, and CSV export.
- Buyer tags and notes (Customers card) are entirely your own typed
  input — never scraped from Spoonflower, never sent anywhere, stored
  only in this browser's IndexedDB alongside everything else. They're also
  the one thing here that can't be re-synced if lost, so the Customers
  card has **Export tags/notes** and **Import** buttons: export writes a
  small JSON file, import merges it back (per buyer, the imported record
  replaces the local one; buyers absent from the file are left alone, and
  you get the counts to confirm before anything is written).
- Uninstalling the extension removes its local database.

## Extending

This version covers: revenue trend with period-over-period deltas,
best/worst sellers, product-type (wallpaper/fabric) breakdown with $/unit
pricing, revenue by tag, new design performance (30/60/90-day revenue
share), returns (with an all-time return-rate-by-design breakdown), a
Customers card with user-editable tags/notes and a repeat-buyer filter, a
per-design detail view (lifetime trend, buyer type and product mix,
with the design's thumbnail), official payout figures, click-to-drill
chart filtering, refund/guest-checkout stat notes, keyword trend small
multiples, tag-derived design families, swatch conversion, CSV export,
and JSON export/import of buyer tags and notes. A design-performance view
showing view/favorite counts isn't possible unless Spoonflower exposes
those alongside sales somewhere we haven't found yet.
