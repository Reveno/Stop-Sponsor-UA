// Stop Sponsor — content script
//
// Universal detection engine. Priority order per scan:
//   0. Site adapter card scan   — "high precision" override for grid/listing
//                                  sites with a registered adapter (Rozetka,
//                                  Silpo). Runs first because it's the most
//                                  targeted signal available.
//   1. JSON-LD (schema.org)     — Product.brand. Works out of the box on
//                                  Shopify/WooCommerce/Magento and most
//                                  modern storefronts.
//   2. Microdata / brand meta   — itemprop="brand", data-brand, etc.
//   3. Generic title fallback   — h1 / og:title / twitter:title, only when
//                                  the page also has a price-like element
//                                  (so we don't badge random articles that
//                                  happen to mention a brand name).
//   4. Instagram caption        — best-effort: og:description holds the
//                                  post caption server-side even though the
//                                  rest of the page is a heavily obfuscated
//                                  SPA, so it's the one stable signal there.
//
// Matches are rendered as a Shadow-DOM badge + info card, so host-page CSS
// can never reach in and nothing we inject can leak out either.

(() => {
  'use strict';

  const BADGE_ATTR = 'imBadgeAttached';
  let db = null;
  let brandIndex = null; // { map, wordIndex, singleWordByLength } — see buildBrandIndex
  let stylesCssText = '';
  let settings = null;

  const DEFAULT_SETTINGS = {
    theme: 'system', // 'light' | 'dark' | 'system'
    fontSize: 'medium', // 'small' | 'medium' | 'large'
    badgeStyle: 'full', // 'full' | 'icon'
    domainListMode: 'blacklist', // 'blacklist' | 'whitelist'
    domainList: [] // hostnames, no protocol/www
  };

  // ---------- per-site placement adapters ("high precision" overrides) ----------
  // Generic shops vary too much to guess a universal "product card" selector
  // reliably, so grid/listing detection only works out of the box via the
  // universal tiers below on sites without an adapter. `cardSelector` +
  // `titleSelector` opt a site into per-card scanning (see
  // extractCardCandidates) for sites whose search/category grids carry no
  // JSON-LD/microdata at all. Add more hostnames as needed; re-verify
  // selectors if a site's markup changes.
  const SITE_ADAPTERS = {
    'rozetka.com.ua': {
      // Product detail page: JSON-LD carries the brand, this just anchors the badge.
      priceSelector: '.product-price__big, .product-price__small',
      // Search/category grid: <rz-product-tile> cards, no JSON-LD/microdata at all.
      cardSelector: 'rz-product-tile',
      titleSelector: '.tile-title',
      cardPriceSelector: 'rz-tile-price, .price, .old-price'
    },
    'auchan.ua': {
      priceSelector: '.product-price, .price'
    },
    'silpo.ua': {
      // Search/category grid: no JSON-LD/microdata at all — same situation as Rozetka.
      cardSelector: 'article.product-card',
      titleSelector: '.product-card__title',
      cardPriceSelector: '.product-card-price__displayPrice, .product-card-price__displayOldPrice'
    },
    default: {
      priceSelector: '.price, [itemprop="price"], [data-price], .product-price'
    }
  };

  function getSiteAdapter() {
    const host = location.hostname.replace(/^www\./, '');
    return SITE_ADAPTERS[host] || SITE_ADAPTERS.default;
  }

  const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
  function isInstagram() {
    return INSTAGRAM_HOSTS.has(location.hostname.toLowerCase());
  }

  // ---------- settings & domain gating ----------

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get('imSettings');
      return { ...DEFAULT_SETTINGS, ...(stored.imSettings || {}) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function isDomainAllowed(s) {
    const host = location.hostname.replace(/^www\./, '').toLowerCase();
    const list = (s.domainList || []).map((d) => d.replace(/^www\./, '').toLowerCase());
    const inList = list.includes(host);
    return s.domainListMode === 'whitelist' ? inList : !inList;
  }

  // ---------- brand name normalization & matching ----------

  function normalizeBrand(raw) {
    if (!raw) return '';
    return raw
      .toString()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '') // strip diacritics: "Nestlé" -> "nestle"
      .replace(/['’`]/g, '')
      .replace(/[®™©]/g, '')
      // \p{L}/\p{N} (Unicode "Letter"/"Number") rather than a bare a-z0-9
      // allowlist — the ASCII-only version silently stripped Cyrillic
      // text to an empty string ("Барні" -> ""), which would have made
      // every Cyrillic alias in brands.json (see the "aliases" section of
      // buildBrandIndex below) completely unmatchable without ever
      // erroring — it'd just quietly never fire.
      .replace(/[^\p{L}\p{N}\s&]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Builds three structures so matching stays fast even with a database of
  // thousands of brands:
  //   - map:               normalizedKey -> corpKey (exact match, O(1))
  //   - wordIndex:         single word -> Set<normalizedKey> containing it,
  //                        so substring matching only checks keys that share
  //                        at least one word with the candidate instead of
  //                        scanning the whole database per candidate text.
  //   - singleWordByLength: length -> [normalizedKey], for fuzzy/typo
  //                        matching bounded to same-length-ish single words.
  function buildBrandIndex(brands) {
    const map = new Map();
    const wordIndex = new Map();
    const singleWordByLength = new Map();

    for (const [key, corpKey] of Object.entries(brands)) {
      const nk = normalizeBrand(key);
      if (!nk) continue;
      map.set(nk, corpKey);

      const words = nk.split(' ');
      for (const w of words) {
        if (!w) continue;
        if (!wordIndex.has(w)) wordIndex.set(w, new Set());
        wordIndex.get(w).add(nk);
      }
      if (words.length === 1) {
        const len = nk.length;
        if (!singleWordByLength.has(len)) singleWordByLength.set(len, []);
        singleWordByLength.get(len).push(nk);
      }
    }
    return { map, wordIndex, singleWordByLength };
  }

  function isWordBoundaryMatch(candidate, key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i').test(candidate);
  }

  function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[n];
  }

  function fuzzyMatch(candidate, index) {
    const tokens = candidate.split(' ').filter((t) => t.length >= 4);
    let best = null;
    let bestDist = Infinity;
    for (const token of tokens) {
      for (const len of [token.length - 1, token.length, token.length + 1]) {
        const bucket = index.singleWordByLength.get(len);
        if (!bucket) continue;
        for (const key of bucket) {
          const dist = levenshtein(key, token);
          if (dist <= 1 && dist < bestDist) {
            bestDist = dist;
            best = index.map.get(key);
          }
        }
      }
    }
    return best;
  }

  function matchBrand(candidateRaw, index) {
    const candidate = normalizeBrand(candidateRaw);
    if (!candidate) return null;

    if (index.map.has(candidate)) return index.map.get(candidate);

    // word-boundary substring match, pruned via the per-word index instead
    // of scanning every key — matters once the database has thousands of
    // entries and this runs per product card on a grid page.
    const candidateKeys = new Set();
    for (const token of candidate.split(' ')) {
      const bucket = index.wordIndex.get(token);
      if (bucket) for (const k of bucket) candidateKeys.add(k);
    }
    if (candidateKeys.size) {
      const sorted = [...candidateKeys].sort((a, b) => b.length - a.length);
      for (const key of sorted) {
        if (key.length < 3) continue; // avoid noisy short-code false positives
        if (isWordBoundaryMatch(candidate, key)) return index.map.get(key);
      }
    }

    return fuzzyMatch(candidate, index);
  }

  // ---------- Tier 1: JSON-LD (schema.org) ----------

  function extractJsonLdBrands() {
    const found = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      let json;
      try {
        json = JSON.parse(script.textContent);
      } catch {
        return;
      }
      const nodes = Array.isArray(json) ? json : (json['@graph'] || [json]);
      nodes.forEach((node) => {
        if (!node || typeof node !== 'object') return;
        const type = node['@type'];
        const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
        if (!isProduct) return;
        let brand = node.brand;
        if (brand && typeof brand === 'object') brand = brand.name;
        if (typeof brand === 'string' && brand.trim()) {
          found.push({ brand: brand.trim(), anchor: script });
        }
      });
    });
    return found;
  }

  // ---------- Tier 2: microdata / explicit brand attributes ----------

  const SELECTOR_CANDIDATES = [
    '[itemprop="brand"]',
    'meta[itemprop="brand"]',
    'meta[property="product:brand"]',
    '[data-brand]',
    '.product-brand',
    '.brand-name',
    '.product__brand'
  ];

  function extractSelectorBrands() {
    const found = [];
    document.querySelectorAll(SELECTOR_CANDIDATES.join(',')).forEach((el) => {
      if (el.dataset && el.dataset[BADGE_ATTR]) return;
      let text = el.getAttribute('content') || el.getAttribute('data-brand');
      if (!text) {
        // Standard schema.org itemscope pattern:
        //   <div itemprop="brand" itemscope itemtype=".../Brand">
        //     <meta itemprop="name" content="Milka">
        //   </div>
        // — the outer element carries no text/content of its own; the
        // actual value lives on the nested meta. Seen on e.g. epicentrk.ua.
        const nestedName = el.querySelector('[itemprop="name"]');
        text = nestedName?.getAttribute('content') || nestedName?.textContent;
      }
      text = (text || el.textContent || '').trim();
      if (text) found.push({ brand: text, anchor: el });
    });
    return found;
  }

  // ---------- Tier 0: site-adapter grid/listing cards ("high precision") ----------
  // Grid/listing pages (e.g. Rozetka search & category results) render many
  // repeated product cards with no JSON-LD or microdata at all — only a
  // title string per card. `processedCards` ensures each card's title is
  // only read/matched once ever, even across repeated MutationObserver
  // scans triggered by lazy-loaded/infinite-scroll cards being appended.
  const processedCards = new WeakSet();

  function extractCardCandidates() {
    const adapter = getSiteAdapter();
    if (!adapter.cardSelector || !adapter.titleSelector) return [];
    const found = [];
    document.querySelectorAll(adapter.cardSelector).forEach((card) => {
      if (processedCards.has(card)) return;
      const titleEl = card.querySelector(adapter.titleSelector);
      const text = titleEl?.textContent.trim();
      if (text) found.push({ brand: text, card });
    });
    return found;
  }

  function resolveCardAnchorTarget(card, adapter) {
    const priceEl = adapter.cardPriceSelector && card.querySelector(adapter.cardPriceSelector);
    return priceEl || card.querySelector(adapter.titleSelector) || card;
  }

  // ---------- Tier 3: generic title fallback (h1 / og:title / twitter:title) ----------
  // Only fires on pages that also look like a single-product page (a price
  // element exists somewhere), so we don't badge an unrelated article whose
  // text happens to mention a brand name in its headline.

  // A bare `querySelector(adapter.priceSelector)` existence check false-
  // positives constantly: `.price`/`[data-price]` are common class/attribute
  // names on non-shop pages too (a blog post's CSS utility class, a hidden
  // filter-sidebar template, a stock-ticker widget), and an element matching
  // one of those selectors doesn't mean the page is actually showing a
  // price. Require the matched element to (a) actually be visible and
  // (b) contain text that looks like a real price (currency symbol/code
  // next to a number) before treating the page as a product page.
  const PRICE_TEXT_RE = /(?:[$€£₴₽]|\bUSD\b|\bEUR\b|\bUAH\b|грн\.?|\bGBP\b)\s*\d[\d\s.,]*|\d[\d\s.,]*\s*(?:[$€£₴₽]|\bUSD\b|\bEUR\b|\bUAH\b|грн\.?|\bGBP\b)/i;

  function looksLikePrice(text) {
    return !!text && PRICE_TEXT_RE.test(text.trim());
  }

  function isRenderedVisible(el) {
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function pageHasPriceSignal(adapter) {
    const candidates = document.querySelectorAll(adapter.priceSelector);
    for (const el of candidates) {
      if (el.tagName === 'META' || el.hasAttribute('data-price')) {
        // schema.org itemprop="price" / data-price conventionally hold a
        // bare numeric value (currency lives in a sibling
        // itemprop="priceCurrency"), so a plain positive number is enough
        // here — unlike free text, where a bare number alone is too noisy
        // to trust (dates, quantities, SKU-looking strings, etc).
        const raw = (el.getAttribute('content') || el.getAttribute('data-price') || '').trim();
        const num = parseFloat(raw.replace(',', '.'));
        if (/^\d+([.,]\d+)?$/.test(raw) && num > 0) return true;
        continue;
      }
      if (!isRenderedVisible(el)) continue;
      if (looksLikePrice(el.textContent)) return true;
    }
    return false;
  }

  // A missing/unmatched price selector (the `default` adapter's
  // `.price, [itemprop="price"], [data-price], .product-price` guess
  // simply doesn't exist on plenty of real sites — Tavria V and Epicentr
  // among them) shouldn't be the ONLY way to recognize a product page.
  // Two more independent signals, either one sufficient on its own:
  //   - `<meta property="og:type" content="product">` — part of the Open
  //     Graph spec, widely emitted by product pages regardless of markup
  //     framework, and unrelated to whatever a site names its price CSS.
  //   - a visible "add to cart" / "buy" button, checked against common
  //     Ukrainian, Russian, and English phrasing — a product page needs
  //     one of these to function at all, so it's at least as reliable a
  //     signal as a price element, and doesn't depend on knowing the
  //     site's specific class names either.
  const CART_BUTTON_RE = /додати до кошика|додати в кошик|купити|в кошик|добавить в корзину|в корзину|купить|add to cart|add to bag|buy now/i;

  function pageHasCartAction() {
    const els = document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"]');
    for (const el of els) {
      if (!isRenderedVisible(el)) continue;
      const text = el.tagName === 'INPUT' ? el.value : el.textContent;
      if (text && CART_BUTTON_RE.test(text)) return true;
    }
    return false;
  }

  function isProductOgType() {
    const og = document.querySelector('meta[property="og:type"]');
    return (og?.getAttribute('content') || '').trim().toLowerCase() === 'product';
  }

  function pageLooksLikeProductPage(adapter) {
    return pageHasPriceSignal(adapter) || isProductOgType() || pageHasCartAction();
  }

  function extractGenericTitleFallback(index, adapter) {
    if (!pageLooksLikeProductPage(adapter)) return null;

    // A real <h1> is by far the most reliable universally-present visible
    // anchor a product page has — prefer it as the anchor point even when
    // the text that actually matched a brand came from a different
    // candidate (e.g. an og:title meta tag whose content differs slightly
    // from the on-page heading). This is what makes the badge show up
    // reliably on sites with no dedicated price/title selector at all.
    const h1 = document.querySelector('h1');
    const candidates = [
      h1,
      document.querySelector('.product-title, [itemprop="name"]'),
      document.querySelector('meta[property="og:title"]'),
      document.querySelector('meta[name="twitter:title"]')
    ].filter(Boolean);

    for (const el of candidates) {
      if (el.dataset && el.dataset[BADGE_ATTR]) continue;
      const text = el.tagName === 'META' ? el.getAttribute('content') || '' : el.textContent || '';
      const corpKey = matchBrand(text, index);
      if (corpKey) {
        const anchor = (h1 && !(h1.dataset && h1.dataset[BADGE_ATTR])) ? h1 : el;
        return { brand: text.trim(), anchor, corpKey };
      }
    }
    return null;
  }

  // ---------- Tier 4: Instagram (best-effort) ----------
  // Instagram's DOM uses obfuscated, frequently-changing class names and is
  // largely login-walled, so nothing class-based is stable. Two things are:
  //   - og:description / meta[name=description] is server-rendered with the
  //     real post caption regardless of login state, and that text is
  //     prefixed "<N> likes, <M> comments - <username> <date>: ..." — the
  //     username can be parsed out of it without touching the DOM.
  //   - once we have a username, `a[href="/<username>/"]` is a real,
  //     functional link the page needs to work at all, so it survives
  //     Instagram's class-name churn in a way no CSS selector would.
  // On profile pages there's no caption; the username comes straight from
  // the URL path instead, and the anchor is the Follow button or an
  // <h1>/<h2> showing the username.
  // If no inline anchor can be found at all, callers fall back to a fixed
  // corner badge (see syncInstagramBadge) — always visible, just not as
  // contextually placed.

  const IG_RESERVED_PATH_SEGMENTS = new Set([
    'explore', 'reels', 'reel', 'stories', 'direct', 'accounts', 'about',
    'p', 'tv', 'legal', 'developer', 'ads', 'privacy', 'terms', 'api', 'topics'
  ]);

  function getInstagramProfileUsername() {
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (!seg || IG_RESERVED_PATH_SEGMENTS.has(seg.toLowerCase())) return null;
    return seg;
  }

  function findInstagramUsernameAnchor(username) {
    if (!username) return null;
    const escaped = username.replace(/["\\]/g, '\\$&');
    const links = [...document.querySelectorAll(`a[href="/${escaped}/"]`)]
      .filter((a) => a.getClientRects().length > 0); // skip hidden/offscreen duplicates
    return links[0] || null;
  }

  function findInstagramFollowOrHeadingAnchor(username) {
    const followBtn = [...document.querySelectorAll('button')]
      .find((b) => /^(follow|стежити|підписатися|подписаться)$/i.test(b.textContent.trim()));
    if (followBtn) return followBtn;
    const heading = [...document.querySelectorAll('h1, h2')]
      .find((h) => h.textContent.trim().toLowerCase() === username.toLowerCase());
    return heading || findInstagramUsernameAnchor(username);
  }

  // Instagram has no <article>/<header> landmarks at all — every ancestor
  // is an obfuscated, class-hashed <div> (verified live; Meta's build
  // pipeline generates fresh atomic class names per release, so nothing
  // there is a stable target). Walk up from the username/Follow anchor
  // looking for the first "row-shaped" ancestor instead: wide enough to
  // be the actual post/profile header bar, short enough that it isn't
  // the whole post (which would defeat the point — pinning to a giant
  // container is barely different from pinning to the viewport). Bounded
  // to a handful of levels so a layout change can't walk it into
  // something unrelated.
  function findInstagramContainer(anchor) {
    let el = anchor;
    for (let i = 0; i < 10 && el; i++) {
      const r = el.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 20 && r.height <= 120) return el;
      el = el.parentElement;
    }
    return null;
  }

  function extractInstagramPostMatch(index) {
    const descMeta =
      document.querySelector('meta[property="og:description"]') ||
      document.querySelector('meta[name="description"]');
    if (!descMeta) return null;
    const fullText = descMeta.getAttribute('content') || '';
    const caption = fullText.slice(0, 200);
    const corpKey = matchBrand(caption, index);
    if (!corpKey) return null;
    const usernameMatch = fullText.match(/-\s*([a-zA-Z0-9_.]+)\s+\S+ \d{1,2}, \d{4}:/);
    const anchor = usernameMatch ? findInstagramUsernameAnchor(usernameMatch[1]) : null;
    const container = anchor ? findInstagramContainer(anchor) : null;
    return { brand: caption.trim(), corpKey, anchor, container };
  }

  function extractInstagramProfileMatch(index) {
    const username = getInstagramProfileUsername();
    if (!username) return null;
    const corpKey = matchBrand(username, index);
    if (!corpKey) return null;
    const anchor = findInstagramFollowOrHeadingAnchor(username);
    const container = anchor ? findInstagramContainer(anchor) : null;
    return { brand: username, corpKey, anchor, container };
  }

  function extractInstagramMatch(index) {
    const isPostPath = /^\/[^/]+\/(p|reel|tv)\/[^/]+\/?/.test(location.pathname);
    return isPostPath ? extractInstagramPostMatch(index) : extractInstagramProfileMatch(index);
  }

  // ---------- rendering ----------

  function resolveAnchorTarget(anchor, adapter) {
    if (anchor.tagName === 'SCRIPT' || anchor.tagName === 'META') {
      return document.querySelector(adapter.priceSelector) || document.querySelector('h1') || document.body;
    }
    return anchor;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  function getStatusLabel(status) {
    const suffix = status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown';
    return chrome.i18n.getMessage(`status${suffix}`) || chrome.i18n.getMessage('statusUnknown') || status;
  }

  // Badge/pill color follows computed RISK, not raw status: "Crimson for
  // High/Propaganda, Amber for Medium, Green for Exited, Grey ONLY as
  // fallback" (matches the same rule applied to Catalog cards in
  // options.js's riskClassFor). Exited (threat "none") always wins as
  // green even for a corp that was historically NACP-listed — a company
  // that's left Russia isn't "active propaganda" any more.
  function riskClassFor(corp) {
    if (corp.threat === 'none') return 'none';
    if (corp.is_propaganda) return 'high';
    return corp.threat || 'unknown';
  }

  function makeUnknownCorp(key) {
    return {
      name: key,
      status: 'unknown',
      threat: 'unknown',
      inf_ua: chrome.i18n.getMessage('unknownCorpInfo') || '',
      inf_en: chrome.i18n.getMessage('unknownCorpInfo') || ''
    };
  }

  function buildCard(corp, brand) {
    const card = document.createElement('div');
    // Open/closed is a class (im-card--open), not the `hidden` attribute —
    // `[hidden] { display: none }` can't be transitioned, and the fade
    // in/out needs a real CSS transition (see styles.css).
    card.className = 'im-card';

    const lang = chrome.i18n.getUILanguage().toLowerCase().startsWith('uk') ? 'uk' : 'en';
    const info = (lang === 'uk' ? corp.inf_ua : corp.inf_en) || corp.inf_ua || corp.inf_en || '';
    const riskClass = riskClassFor(corp);

    const header = document.createElement('div');
    header.className = 'im-card__header';
    header.innerHTML = `
      <span class="im-card__corp">${escapeHtml(corp.name || '')}</span>
      <span class="im-card__status im-card__status--${riskClass}">${escapeHtml(getStatusLabel(corp.status))}</span>
    `;

    const brandLine = document.createElement('p');
    brandLine.className = 'im-card__brand';
    brandLine.innerHTML = `${escapeHtml(chrome.i18n.getMessage('detectedBrand') || 'Brand')}: <strong>${escapeHtml(brand)}</strong>`;

    const infoLine = document.createElement('p');
    infoLine.className = 'im-card__info';
    infoLine.textContent = info;

    const elements = [header, brandLine, infoLine];

    // "Active propaganda" specifically claims *current* behavior, so it's
    // suppressed once a corp has actually exited (threat "none") even
    // though is_propaganda stays true in the data as an honest historical
    // record — same rule as the Catalog card in options.js.
    if (corp.is_propaganda && corp.threat !== 'none') {
      const propLine = document.createElement('p');
      propLine.className = 'im-card__propaganda';
      const desc = (lang === 'uk' ? corp.propaganda_desc_ua : corp.propaganda_desc_en)
        || corp.propaganda_desc_ua || corp.propaganda_desc_en || '';
      propLine.textContent = `${chrome.i18n.getMessage('catalogPropagandaBadge') || '📢 Active propaganda'}${desc ? ' — ' + desc : ''}`;
      elements.push(propLine);
    }

    // Distinct from is_propaganda (NACP-sourced list of foreign war
    // sponsors) — this is the company's own nationality, verified against
    // Wikidata's country claim, not an allegation about a specific act.
    if (corp.is_russian_origin) {
      const ruLine = document.createElement('p');
      ruLine.className = 'im-card__propaganda im-card__propaganda--ru';
      ruLine.textContent = chrome.i18n.getMessage('catalogRussianOriginBadge') || '🇷🇺 Russian-origin company';
      elements.push(ruLine);
    }

    const links = document.createElement('div');
    links.className = 'im-card__links';
    const sourceUrl = corp.source_url || 'https://leave-russia.org';
    links.innerHTML = `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">KSE Leave Russia →</a>`;
    elements.push(links);

    card.append(...elements);
    return card;
  }

  // .im-card defaults to opening below-and-right of the badge (see
  // styles.css). A badge near the right or bottom edge of the viewport
  // would otherwise push the 300px-wide card partly off-screen — flip it
  // to open left/up instead whenever the default placement would overflow.
  function positionCardInViewport(card) {
    card.classList.remove('im-card--align-right', 'im-card--flip-up');
    const rect = card.getBoundingClientRect();
    if (rect.right > window.innerWidth) card.classList.add('im-card--align-right');
    if (rect.bottom > window.innerHeight) card.classList.add('im-card--flip-up');
  }

  function renderBadge(targetEl, { brand, corp, fixed = false, container = null }) {
    // Plain inline insertion is the only mode that anchors to (and
    // dedups against) a specific target element. `fixed` and `container`
    // placement don't take a targetEl at all — their dedup is handled by
    // the caller (see syncInstagramBadge) since they can be re-synced
    // across scans without a single stable element to key off of.
    if (!fixed && !container) {
      if (!targetEl || (targetEl.dataset && targetEl.dataset[BADGE_ATTR])) return;
      if (targetEl.dataset) targetEl.dataset[BADGE_ATTR] = '1';
    }

    const host = document.createElement('span');
    host.className = fixed ? 'im-badge-host im-badge-host--fixed' : 'im-badge-host';
    host.setAttribute('data-theme', settings.theme);
    host.setAttribute('data-font-size', settings.fontSize);
    const shadow = host.attachShadow({ mode: 'open' });

    // Inlined (not a <link>): a <link rel="stylesheet"> inside a shadow
    // root loads asynchronously, so the first paint (and the first click,
    // if it lands before the fetch resolves) renders completely unstyled —
    // .im-card even loses its `position: absolute` and pushes the host
    // page's layout around it. A cached, synchronously-available <style>
    // avoids that FOUC/race entirely.
    const style = document.createElement('style');
    style.textContent = stylesCssText;
    shadow.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.className = fixed ? 'im-wrapper im-wrapper--fixed' : container ? 'im-wrapper im-wrapper--pinned' : 'im-wrapper';

    const hasLeft = corp.status === 'left';
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = `im-badge im-badge--${riskClassFor(corp)}`;
    badge.setAttribute(
      'aria-label',
      chrome.i18n.getMessage(hasLeft ? 'badgeAriaLabelLeft' : 'badgeAriaLabel') || 'War sponsor warning'
    );
    const icon = hasLeft ? '✅' : '⚠️';
    const label = chrome.i18n.getMessage(hasLeft ? 'badgeLabelLeft' : 'badgeLabel') || (hasLeft ? 'Left Russia' : 'War Sponsor');
    badge.textContent = settings.badgeStyle === 'icon' ? icon : `${icon} ${label}`;

    const card = buildCard(corp, brand);

    // Host pages routinely wrap an entire product card (including wherever
    // this badge gets inserted) in a single clickable <a> to the product
    // page. stopPropagation alone doesn't reliably stop that — an
    // ancestor <a>'s "navigate on click" activation isn't a bubble-phase
    // listener we can out-race, it's evaluated against the event's
    // defaultPrevented state — so the badge explicitly calls
    // preventDefault() on every interaction, not just stopPropagation().
    function swallow(e) {
      e.preventDefault();
      e.stopPropagation();
    }

    let hideTimer = null;
    function showCard() {
      clearTimeout(hideTimer);
      // Positioned while still invisible (opacity 0, not display:none —
      // see .im-card in styles.css) so its real rendered size is
      // measurable before the fade-in starts, then made open in the same
      // tick so the edge-flip never has a chance to visibly flash the
      // wrong way round first.
      positionCardInViewport(card);
      card.classList.add('im-card--open');
    }
    function scheduleHideCard() {
      clearTimeout(hideTimer);
      // A short grace period, not an instant hide: .im-card sits a few
      // pixels below/beside the badge (see styles.css), so moving the
      // mouse from one to the other briefly crosses that gap — an instant
      // hide on mouseleave would close the card before the user's cursor
      // ever reaches a link inside it.
      hideTimer = setTimeout(() => {
        card.classList.remove('im-card--open');
      }, 200);
    }

    wrapper.addEventListener('mouseenter', showCard);
    wrapper.addEventListener('mouseleave', scheduleHideCard);
    // Hover has no equivalent on touch/keyboard, so focus and click remain
    // as fallbacks — without them the card would be permanently
    // unreachable for keyboard and touch users.
    badge.addEventListener('focus', showCard);
    badge.addEventListener('blur', scheduleHideCard);
    badge.addEventListener('click', (e) => {
      swallow(e);
      if (card.classList.contains('im-card--open')) card.classList.remove('im-card--open');
      else showCard();
    });
    // Only stopPropagation here, deliberately NOT preventDefault: this is
    // what lets a real link inside the card (e.g. "View proof") still
    // navigate normally on click, while stopping that click from bubbling
    // past the shadow root into whatever the host page wrapped the badge
    // in. preventDefault is reserved for the badge's own click handler
    // above, which has no legitimate default action to preserve.
    shadow.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', (e) => {
      if (e.composedPath().includes(wrapper)) return;
      card.classList.remove('im-card--open');
    });

    wrapper.append(badge, card);
    shadow.appendChild(wrapper);

    if (fixed) {
      document.body.appendChild(host);
    } else if (container) {
      // Pin the badge to a corner of the post/profile container itself
      // (position: absolute relative to it) rather than the viewport, so
      // it scrolls together with that specific post instead of sitting
      // fixed on screen. Only forces `position: relative` if the
      // container isn't already positioned — never overrides an existing
      // position value.
      if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }
      container.appendChild(host);
    } else {
      targetEl.insertAdjacentElement('afterend', host);
    }
    return host;
  }

  // Instagram is a single long-lived SPA page — the user scrolls through
  // many posts without a real navigation, so "show a badge once ever"
  // would leave a stale one (wrong brand, or pinned to a post-header node
  // React has since discarded) stuck on screen indefinitely. Instead every
  // scan re-derives the current match + placement and syncs the badge to
  // it: swap it in on a new/changed match or a stale/detached placement,
  // remove it entirely once nothing matches any more. Placement prefers
  // `container` (pinned inside the post/profile header, moves with it) >
  // `anchor` (inserted right after it) > fixed viewport corner as the
  // last resort when neither could be found.
  let igBadgeHost = null;
  let igBadgeCorpKey = null;
  let igBadgePlacementNode = null; // the container/anchor node in use, or null in fixed mode

  function teardownInstagramBadge() {
    igBadgeHost?.remove();
    igBadgeHost = null;
    igBadgePlacementNode = null;
  }

  function syncInstagramBadge(match) {
    const corpKey = match ? match.corpKey ?? null : null;
    const placementNode = match ? match.container || match.anchor || null : null;
    const placementStillGood = placementNode ? document.contains(placementNode) : true;

    if (
      corpKey === igBadgeCorpKey &&
      igBadgeHost &&
      document.contains(igBadgeHost) &&
      igBadgePlacementNode === placementNode &&
      placementStillGood
    ) {
      return; // same match, same (still-attached) placement as last scan
    }

    igBadgeCorpKey = corpKey;
    teardownInstagramBadge();
    if (!match) return;

    igBadgePlacementNode = placementNode;
    if (match.container) {
      igBadgeHost = renderBadge(null, { brand: match.brand, corp: match.corp, container: match.container });
    } else if (match.anchor) {
      igBadgeHost = renderBadge(match.anchor, { brand: match.brand, corp: match.corp });
    } else {
      igBadgeHost = renderBadge(null, { brand: match.brand, corp: match.corp, fixed: true });
    }
  }

  // ---------- scan cycle ----------

  function collectCandidates() {
    return [...extractJsonLdBrands(), ...extractSelectorBrands()];
  }

  function scan() {
    if (!brandIndex || !db) return;

    if (isInstagram()) {
      const ig = extractInstagramMatch(brandIndex);
      syncInstagramBadge(ig && { ...ig, corp: db.corporations[ig.corpKey] || makeUnknownCorp(ig.corpKey) });
      return; // Instagram doesn't have shop-style DOM for the other tiers
    }

    const adapter = getSiteAdapter();
    let matchedAny = false;

    for (const { brand, anchor } of collectCandidates()) {
      const corpKey = matchBrand(brand, brandIndex);
      if (!corpKey) continue;
      matchedAny = true; // a real brand was found, even if already badged
      const target = resolveAnchorTarget(anchor, adapter);
      if (!target || (target.dataset && target.dataset[BADGE_ATTR])) continue;
      const corp = db.corporations[corpKey] || makeUnknownCorp(corpKey);
      renderBadge(target, { brand, corp });
    }

    for (const { brand, card } of extractCardCandidates()) {
      processedCards.add(card); // evaluate each card's title once, match or not
      const corpKey = matchBrand(brand, brandIndex);
      if (!corpKey) continue;
      matchedAny = true;
      const target = resolveCardAnchorTarget(card, adapter);
      if (!target || (target.dataset && target.dataset[BADGE_ATTR])) continue;
      const corp = db.corporations[corpKey] || makeUnknownCorp(corpKey);
      renderBadge(target, { brand, corp });
    }

    if (!matchedAny) {
      const fallback = extractGenericTitleFallback(brandIndex, adapter);
      if (fallback) {
        const corp = db.corporations[fallback.corpKey] || makeUnknownCorp(fallback.corpKey);
        renderBadge(fallback.anchor, { brand: fallback.brand, corp });
      }
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  }

  async function init() {
    settings = await loadSettings();
    if (!isDomainAllowed(settings)) return;

    try {
      const [response, css] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_DB' }),
        fetch(chrome.runtime.getURL('styles.css')).then((res) => res.text())
      ]);
      db = response.data;
      brandIndex = buildBrandIndex(db.brands);
      stylesCssText = css;
    } catch (err) {
      console.error('[StopSponsor] Failed to load brand database', err);
      return;
    }

    scan();

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes.length) {
          scheduleScan();
          break;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();
