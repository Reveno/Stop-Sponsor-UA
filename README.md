# Stop Sponsor

Chrome extension (Manifest V3) that flags products from companies that
continue funding Russia's war against Ukraine, sourced from the
[KSE Institute's #LeaveRussia project](https://leave-russia.org). All
matching runs locally in the browser — no browsing data is ever collected
or transmitted; the only network request is fetching the public brand
database itself.

(Formerly "Stop Funding War", then "Varta: War Sponsor Checker", then
"Corporate Watch Monitor", then "Impact Monitor", then "Spysok" —
"список" is Ukrainian for "list", which was a fitting name for a list of
war-sponsoring companies, but this round's brief asked for something more
directly action-oriented. The internal `im` prefix on CSS classes/storage
keys — `imSettings`, `im-badge`, etc. — is still left as-is through all
of these renames: it's genuinely internal, invisible to a user, and a
mechanical rename across every selector in
`content.js`/`styles.css`/`options.css` carries real risk of a missed
spot for no user-facing benefit. Earlier installs' settings under
`sfwSettings` still won't carry over to `imSettings` — only matters for a
pre-release dev install like this one, not a real user base.)

## Load it (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.

## Point it at your GitHub database

The extension ships with a bundled `data/brands.json` as an offline
fallback, but is designed to pull a live-editable copy from a GitHub repo
(raw file) so the data can be updated without republishing the extension.
This build already points at
[github.com/Reveno/Stop-Sponsor-UA](https://github.com/Reveno/Stop-Sponsor-UA)
(`background.js`'s `DEFAULT_REMOTE_URL`, verified live — a fetch against it
returns real data, not a 404) — to point it at a different repo instead:

1. Push `data/brands.json` to your own repo (see the file's `brands` /
   `corporations` shape).
2. In [`background.js`](background.js), [`popup.js`](popup.js), and
   [`options.js`](options.js), update `DEFAULT_REMOTE_URL`/
   `REPORT_REPO_URL` to your own GitHub username and repo name.
3. Reload the extension. The background worker fetches the remote JSON,
   caches it in `chrome.storage.local` for 24h, and falls back to the
   bundled copy (or a stale cache) if the fetch fails.

## How detection works

`content.js` runs a tiered scan, most-precise signal first:

0. **Site adapter cards** ("high precision") — for hostnames listed in
   `SITE_ADAPTERS`, scan every product card in a search/listing grid
   directly via a `cardSelector` + `titleSelector` (+ optional
   `cardPriceSelector` to anchor the badge at the price). Needed because
   sites like Rozetka and Silpo render grids with **no JSON-LD or
   microdata at all** — only a title string per card. Currently covers
   `rozetka.com.ua` and `silpo.ua`, verified against their live markup as
   of 2026-08. Frontend markup drifts — re-verify selectors (open the
   site, inspect a card) if badges stop appearing somewhere that used to
   work.
1. **JSON-LD** (`schema.org` `Product.brand`) — works out of the box on
   Shopify/WooCommerce/Magento and most modern storefronts, no adapter
   needed.
2. **Microdata / explicit brand fields** — `[itemprop="brand"]`,
   `data-brand`, `meta[property="product:brand"]`, etc. Handles both the
   simple case (value on the matched element itself) and the standard
   nested schema.org pattern (`<div itemprop="brand" itemscope><meta
   itemprop="name" content="Milka"></div>` — the outer element has no
   text of its own; seen live on epicentrk.ua).
3. **Generic title fallback** (`h1` / `og:title` / `twitter:title`) — only
   fires when the page also has a price-like element, so an unrelated
   article that happens to mention a brand name in its headline doesn't
   get badged. This is also what makes the "a search page's own title
   contains a brand name" false-positive (e.g. "Results for «milka»")
   avoidable: sites that need grid scanning should get a `SITE_ADAPTERS`
   entry (tier 0) rather than relying on this tier, which is a
   single-product-page fallback. The price check itself
   (`pageHasPriceSignal`) doesn't just check that a `.price`-ish selector
   *exists* — that class/attribute name is common enough on non-shop pages
   (a blog's CSS utility class, a hidden filter-sidebar template, a
   stock-ticker widget) to false-positive constantly. It requires the
   matched element to actually be visible and to contain text that looks
   like a real price (a currency symbol/code next to a number), with a
   narrower bare-number allowance only for the schema.org
   `itemprop="price"`/`data-price` convention (where the value is
   legitimately just a number, currency living in a sibling field).
4. **Instagram** (best-effort) — Instagram's DOM uses obfuscated,
   frequently-changing class names and has no `<article>`/`<header>`
   landmarks at all (verified live — every ancestor is a class-hashed
   `<div>`), so no CSS selector is stable, but two things are:
   `og:description`/`meta[name=description]` are server-rendered with the
   real post caption regardless of login state (and that text is
   prefixed `"<N> likes, <M> comments - <username> <date>: ..."`, so the
   username can be parsed out of it without touching the DOM), and once a
   username is known, `a[href="/<username>/"]` is a real functional link
   the page needs to work at all — it survives class-name churn in a way
   no CSS selector would. On profile pages the username comes from the
   URL path instead, anchored to the Follow button or a heading showing
   the username.

   Placement: from that anchor, `findInstagramContainer()` walks up a
   bounded number of ancestors looking for the first "row-shaped" one
   (wide, short — a geometric heuristic standing in for the header-bar
   landmark that doesn't exist), and the badge is pinned `position:
   absolute` inside *that* container rather than inserted as a sibling —
   it moves with the post as the container scrolls, not the viewport,
   without shifting the header's own layout. Falls back to a plain
   inline insertion next to the anchor, then to a small fixed viewport
   corner badge, if no suitable container is found. Every mode re-syncs
   on each scan (tears down and re-renders on a changed match *or* a
   detached/stale placement node) so it doesn't go stale or duplicate as
   Instagram's React tree re-renders while the user scrolls.

Matched brand names are normalized (case, diacritics, punctuation) and
matched with exact / word-boundary-substring / 1-edit-distance-fuzzy
matching, backed by a word-indexed lookup so matching stays fast (~0.08ms
per candidate against a 5,000-brand synthetic index) even on a grid page
scanning 60+ cards per scroll.

**Multilingual matching**: `normalizeBrand()` used to strip anything
outside `a-z0-9` — which silently reduced Cyrillic text to an empty
string ("Барні" → `""`), so a Ukrainian/Russian product title could never
match anything no matter what was in `brands.json`. Fixed by normalizing
against Unicode "Letter"/"Number" categories (`\p{L}`/`\p{N}`) instead of
an ASCII-only allowlist. On top of that fix, `data/brands.json` supports
transliterated aliases as ordinary additional keys in the same flat
`brands` map (`"барні": "mondelez"` right alongside `"barni": "mondelez"`)
— no schema change needed, since `buildBrandIndex` already indexes every
key it's given. The Catalog UI filters alias keys (any key with no Latin
letters) out of the card grid so "Barni" and "Барні" don't show up as two
separate-looking entries for the same brand, while both stay fully live
for on-page matching.

**Product-page detection** used to gate the generic-title fallback purely
on a visible price element existing — which fails outright on sites whose
markup doesn't match any known price selector at all (Tavria V, Epicentr).
`pageLooksLikeProductPage()` now also accepts either signal on its own:
`<meta property="og:type" content="product">`, or a visible "add to cart"
button (checked against common Ukrainian/Russian/English phrasing:
"Додати до кошика", "Купити", "В корзину", "Add to cart", etc.). When a
match fires, the badge anchors to the page's `<h1>` whenever one exists —
regardless of which candidate element's text actually contained the brand
name — since a real, visible heading is the one thing nearly every product
page has, unlike a site-specific price/title CSS class.

## Data source: KSE Leave-Russia

Every corporation in `data/brands.json` is sourced from KSE — each entry
carries a `source_url` pointing at that company's specific page, and
`inf_en`/`inf_ua` include the reported Russia revenue/taxes figures KSE
publishes (also stored as plain numbers on `revenue_rf_musd`/
`taxes_rf_musd`, in millions of USD, so the UI/exports don't have to
re-parse them out of prose). Nothing in this file is a hand-written
accusation; it's a plain-language summary of what a citable,
independently-checkable source says, with a link to verify it yourself.

**"Verified Only" rule**: `tools/verify_brands.py` and
`tools/brand_expander.py` never write a corporation entry whose status
doesn't resolve to `stay`/`reduced`/`left` — if leave-russia.org's status
markup can't be classified, that candidate is skipped entirely (no corp
entry, no brand mappings) rather than published as `"unknown"`. Every
corporation entry always has a real status and a complete
`inf_en`/`inf_ua`/`source_url`; `threat` is always derived consistently
from status + reported figures, never left contradicting the status.

### Propaganda flag (NACP "International Sponsors of War")

Some corporations also carry `is_propaganda: true` plus
`propaganda_desc_en`/`propaganda_desc_ua`. This was meant to be a live
cross-check against NACP's own list, but that turned out not to be
possible: NACP's `sanctions.nazk.gov.ua` subdomain (which hosted the list)
no longer resolves at all — consistent with NACP's own published notice
that the register was handed off to Ukraine's Interdepartmental Working
Group / State Sanctions Registry and the public list page was taken down
on 2024-03-22. There's no live NACP endpoint left to scrape.

Instead, `NACP_PROPAGANDA_LIST` in `tools/verify_brands.py` is a curated,
dated snapshot sourced from
[Wikipedia's "International Sponsors of War" article](https://en.wikipedia.org/wiki/International_Sponsors_of_War)
(itself citing NACP/press coverage while the list was live), captured
2026-08. Every generated `propaganda_desc_*` says exactly this — a dated
secondary-source snapshot, not a live feed — so nothing overstates its own
currency. The Catalog/badge UI also suppresses the "📢 Active propaganda"
label for any corp whose status is `left`: a company that has since exited
Russia isn't "active" anything, even if it was historically listed
(Unilever is the concrete case — NACP-listed in 2023, but KSE now shows it
fully exited).

As of this writing: 95 corporations, 522 brand mappings, still actively
growing via a background `--from-kse-file` run against the full ~3,150-
company KSE list (see below) — check `data/brands.json`'s own `updatedAt`
for the current count, since this number will be stale by the time you
read it.

**On Wikidata coverage gaps**: `find_subbrands()` only surfaces what
Wikidata's `P127` ("owned by") claims actually record, and that coverage
is uneven — re-running it against companies already processed in earlier
sessions mostly turned up nothing *new*, not because those companies lack
real sub-brands, but because Wikidata itself doesn't have the claim.
Henkel is the clean example: its Wikidata entity (`Q1605280`, confirmed
correct) has zero `P127` relationships at all, despite Persil and
Schwarzkopf being unambiguously real Henkel brands. That's a genuine gap
in the source data, not a bug in this pipeline — and it's treated as a
gap to disclose, not a reason to hand-type the missing brands without a
source.

### Russian-origin companies ("direct sponsors")

KSE Leave-Russia tracks *foreign* companies' operations in Russia — it has
no coverage of Russian-domiciled companies themselves. Those get a
separate flag, `is_russian_origin: true`, verified a different way:
`tools/brand_expander.py --russian-origin` checks each hand-picked
candidate against Wikidata's own `P17` ("country") / `P495` ("country of
origin") claim before writing anything — a structural, independently
checkable fact about the company's own nationality, not a specific
sourced allegation about what it's done. That's a deliberately narrower
claim: a Russian-domiciled company's revenue and taxes are part of the
Russian state's wartime economy by construction, which doesn't need a
citation beyond "this is where it's incorporated."

This distinction matters in practice: a claim was requested for one
candidate (Splat-Cosmetica) asserting it directly funds Russian military
units and war crimes. That's a specific, serious factual claim, and nothing
findable substantiates it — so it isn't in the data. What *is* verified
(Wikidata `Q4048866`, country: Russia) is written instead, same as the
other four current Russian-origin corps: Kaspersky Lab, Faberlic, Melon
Fashion Group, Greenfield, MAY. The Catalog/badge UI shows this as a
separate "🇷🇺 Russian-origin company" badge (dashed border) rather than
folding it into the NACP-sourced "📢 Active propaganda" badge — the two
are different designations with different evidence behind them, and
conflating them would misrepresent both.

Two of those (Greenfield, MAY) needed real reporting rather than
Wikidata, and getting their actual corporate structure right mattered:
**Greenfield** and **Tess**/**Jardin** are real Orimi Group tea/coffee
brands (Orimi's own Wikidata entry has no country claim at all — a
coverage gap, not counter-evidence — so this is sourced to independent
reporting: Ukrainska Pravda names Orimi's owners, Sergey Kasyanenko and
Alexander Yevnevich, both Russian). **Curtis** and **Richard**, despite
sometimes being lumped in with Greenfield as "similar Russian tea
brands", actually belong to a *different* Russian company — MAY
(Maysky, Wikidata `Q25952`, verified Russian) — confirmed via MAY's own
"About" page listing both as its brands. Conflating the two would have
been wrong in a small but real way. One brand from the same rough
category was deliberately **not** flagged: MacCoffee is a real brand,
but its actual owner (Food Empire Holdings) is Singaporean — checked
both via web search and Wikidata (`Q135020783`, no Russia country claim)
before deciding not to add it here.

### `tools/verify_brands.py` — corporation status + figures

```bash
python tools/verify_brands.py                 # refresh every corp in SLUG_MAP
python tools/verify_brands.py --only pmi jti    # refresh a subset
python tools/verify_brands.py --dry-run

python tools/verify_brands.py --discover        # enumerate the FULL KSE company
                                                  # list (~3,150 companies as of
                                                  # 2026-08) into tools/kse_companies.json
```

Don't hand-write a status or a "reason" string for a real company without
a source behind it — KSE's own data doesn't always match assumptions
(this project's Xiaomi entry started as a guess that it was actively
expanding in Russia; the sourced data shows the opposite — KSE classifies
it "Reducing Activities", revenue down >10% in 2024 — and the script
corrected it, along with catching that Unilever has actually exited
Russia entirely).

### `tools/brand_expander.py` — sub-brand discovery

```bash
python tools/brand_expander.py                          # expand every corp in SLUG_MAP
python tools/brand_expander.py --only mondelez pmi

python tools/brand_expander.py --from-kse-file --limit 500 --status stay reduced
                                                          # grow past SLUG_MAP using
                                                          # tools/kse_companies.json
```

Finds sub-brands via Wikidata's `P127` ("owned by") relationship, queried
through the CirrusSearch-backed action API
(`haswbstatement:P127=<QID>`) rather than the SPARQL endpoint
(`query.wikidata.org`) — that's a separate backend that was under an
active rate-limit outage when this was built (HTTP 429, "aggressively
rate-limiting... active wdqs outage"); the search API hits a different,
unaffected backend. Results are filtered to Wikidata "instance of" types
that represent an actual consumer brand (`Q431289` brand, `Q167270`
trademark, `Q16323605` food brand, `Q133459332` clothing brand,
`Q55315112` cosmetics brand, `Q10429667` car brand, `Q135409642` luxury
brand) — P127 also fires for factories, holding companies, and
non-consumer subsidiaries, which get filtered out. Institutional
investors (BlackRock, Vanguard, State Street, Berkshire Hathaway) are
blacklisted by name in `is_blacklisted_owner()` for the same reason:
Wikidata's P127 doesn't distinguish "owns as a subsidiary/brand" from
"holds shares in as an index fund", which is how "McDonald's → BlackRock"
briefly ended up in the data before this filter existed. No "electronics
brand" type is included — despite being requested, no Wikidata QID for it
could actually be found under any search term tried; electronics
companies still get picked up under the generic brand/trademark types
above whenever Wikidata tags them that way.

**On Open Food Facts**: the original plan was to use OFF's `brand_owner`
field as a second source of parent-company mappings. Tested against the
live API and it isn't populated in practice — even well-known products
like Milka come back with `brand_owner` absent, across every major
manufacturer tried. So OFF isn't used as a data source; instead each
Wikidata-derived candidate is cross-checked against OFF's `brands` tag as
a plausibility filter (does this brand name actually appear on real
products?), annotated but not required — OFF's coverage is too spotty for
"not found" to mean "not real."

**On scale**: `--discover` found ~3,150 companies across KSE's three
status categories (paginated via KSE's internal AJAX endpoint, ~120
companies/page). Running `brand_expander.py --from-kse-file` against all
of them is the realistic path to thousands of brand mappings, but budget
real wall-clock time for it — every candidate costs at least one
rate-limited request even when it finds nothing, and most of the ~3,150
are B2B/industrial/financial companies with no consumer brand at all. A
500-company bounded run against `stay`/`reduced` companies is a
reasonable next increment; running the full list is realistically an
hours-long background job, not a one-shot command.

## Settings (`options.html`)

Reachable from the popup's gear icon, or `chrome://extensions` →
Stop Sponsor → Details → Extension options. Laid out as a
dashboard: a persistent sidebar (General / The Catalog / Data
Transparency / How It Works / Site List) next to a scrollable content
pane. Glassmorphism accents (`backdrop-filter: blur()` over soft
gradient blobs) on cards, `1px solid` borders at exactly `#e5e7eb`
(light) / `#374151` (dark), navy/charcoal-dark and off-white-light
throughout.

- **General** — theme (light/dark/system), badge text size, badge style
  (icon+text or icon-only), and a live preview card that re-renders the
  actual shadow-DOM badge markup on every change (not a mockup — it's the
  real `.im-badge` CSS, so what you see is what you get on-page).
- **The Catalog** — every brand in the database as a full-width,
  searchable, filterable card grid (`repeat(auto-fill, minmax(300px, 1fr))`
  — the only panel that isn't width-capped, since it's a data grid, not
  prose). Search matches brand or parent-company name; filter by status.
  Each card shows brand, parent corporation, and a status pill whose
  *color* follows computed risk (crimson = high risk or active
  propaganda, amber = medium, a duller gold = low, green = exited, grey
  reserved only for a genuinely missing/unclassifiable entry) while its
  *label* still shows the plain status text. Propaganda-flagged corps get
  a "📢 Active propaganda" badge and, for the high-risk tier, the reported
  tax/revenue figures directly on the card. Click a card to expand its
  sourced description and "View proof" link. A **Bulk Update** button in
  the toolbar force-refreshes from the configured GitHub raw URL (same
  `REFRESH_DB` flow the popup's refresh button uses) and re-renders
  against the newly-synced data. Loads from the same live-synced
  `chrome.storage.local` cache `content.js`/`background.js` use, falling
  back to the bundled `data/brands.json` cold-start copy.
- **Data Transparency** — explains the pipeline in plain language, links
  out to the three sources involved (KSE Leave-Russia, NACP, Wikidata,
  each with an icon), and two export buttons (JSON / CSV) that download
  the full live dataset via a plain `Blob` + `<a download>` — no server
  round-trip, works offline.
- **How It Works** — a 4-step visual walkthrough (detect → match → look
  up → decide) plus a color legend for what each badge color means.
- **Site List** — blacklist (skip these sites) or whitelist (only run on
  these sites), one hostname per line.

A persistent "Feedback" button floats bottom-right across every section,
opening a general (non-templated) GitHub issue.

Settings are stored in `chrome.storage.local` under the `imSettings` key
(renamed from `sfwSettings` this round — see the top of this file) and
read once per page load by `content.js` — changing a setting takes
effect on the next page load/reload, not live on already-open tabs.

## Design

Palette: deep navy/charcoal (`#0f172a` / `#111827` family) for dark mode,
clean off-white (`#f8fafc`/`#ffffff`) for light — both driven by the same
CSS custom properties so there's one stylesheet per surface, not one per
theme. Risk-level accents are fixed across both themes since they're
status colors, not brand colors: crimson `#B91C1C` for high risk, amber
`#F59E0B` for medium. Cards use subtle shadows and short (~150–200ms)
transitions on hover/interaction throughout (`styles.css`, `popup.css`,
`options.css`).

## Popup

Shows live database stats (brand count, last-updated timestamp, remote
vs. local-fallback source), an animated sync-progress bar while a
manual refresh (`REFRESH_DB` message to the background worker) is in
flight, a settings gear, and a "Report missing product" link that opens
a structured GitHub issue form
([`.github/ISSUE_TEMPLATE/missing-brand.yml`](.github/ISSUE_TEMPLATE/missing-brand.yml))
pre-selecting fields for brand name, parent company, product URL, and —
required — a source for the claim, rather than a blank issue.

## Privacy

No user data is collected, transmitted, or stored anywhere. Brand
matching happens entirely client-side against the locally-cached
database. The only network requests the extension makes are: fetching
`data/brands.json` from the configured GitHub raw URL (falls back to the
bundled local copy), and — only on `leave-russia.org` KSE detail-page
links the user explicitly clicks in the info card — a normal outbound
link click, not a request the extension initiates.

## Icon

`icons/icon{16,48,128}.png` — a minimalist red (`#b91c1c`) octagon with a
white border and a horizontal white bar through the center: a stop-sign
silhouette, recognizable by shape alone even at 16px where actual text or
a letterform would turn to mud. Generated programmatically
(`System.Drawing`, no external asset).

## GitHub repo

Published at
[github.com/Reveno/Stop-Sponsor-UA](https://github.com/Reveno/Stop-Sponsor-UA)
(`main` branch). `background.js`/`popup.js`/`options.js` already point at
it — `DEFAULT_REMOTE_URL` and `REPORT_REPO_URL` are real, verified-live
URLs, not placeholders. To fork this to a different repo instead, update
those three constants and push there — see "Point it at your GitHub
database" above.
