// Spysok — options page (dashboard sidebar layout)

const DEFAULT_SETTINGS = {
  theme: 'system',
  fontSize: 'medium',
  badgeStyle: 'full',
  domainListMode: 'blacklist',
  domainList: []
};

const REPORT_REPO_URL = 'https://github.com/YOUR_GITHUB_USERNAME/spysok';

const sidebarNav = document.getElementById('sidebarNav');
const panels = document.querySelectorAll('.panel');

function switchSection(section) {
  sidebarNav.querySelectorAll('.sidebar__nav-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.section === section);
  });
  panels.forEach((panel) => {
    panel.hidden = panel.dataset.panel !== section;
  });
}

sidebarNav.addEventListener('click', (e) => {
  const btn = e.target.closest('.sidebar__nav-item');
  if (btn) switchSection(btn.dataset.section);
});

const themeSegmented = document.getElementById('themeSegmented');
const fontSizeSegmented = document.getElementById('fontSizeSegmented');
const badgeStyleSegmented = document.getElementById('badgeStyleSegmented');
const domainModeSegmented = document.getElementById('domainModeSegmented');
const domainListInput = document.getElementById('domainListInput');
const saveBtn = document.getElementById('saveBtn');
const savedNotice = document.getElementById('savedNotice');
const badgePreviewHost = document.getElementById('badgePreviewHost');
const feedbackFab = document.getElementById('feedbackFab');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const catalogSearch = document.getElementById('catalogSearch');
const catalogStatusFilter = document.getElementById('catalogStatusFilter');
const catalogCount = document.getElementById('catalogCount');
const catalogGrid = document.getElementById('catalogGrid');
const bulkUpdateBtn = document.getElementById('bulkUpdateBtn');
const clearCacheBtn = document.getElementById('clearCacheBtn');
const catalogSyncIndicator = document.getElementById('catalogSyncIndicator');
const catalogModalOverlay = document.getElementById('catalogModalOverlay');
const catalogModal = document.getElementById('catalogModal');
const catalogModalClose = document.getElementById('catalogModalClose');
const modalBrand = document.getElementById('modalBrand');
const modalCorp = document.getElementById('modalCorp');
const modalBadges = document.getElementById('modalBadges');
const modalFigures = document.getElementById('modalFigures');
const modalDesc = document.getElementById('modalDesc');
const modalCopyBtn = document.getElementById('modalCopyBtn');
const modalVisitBtn = document.getElementById('modalVisitBtn');

let current = { ...DEFAULT_SETTINGS };
let stylesCssText = '';
let fullDb = null; // { brands, corporations, updatedAt, ... } — see loadDb()
let catalogEntries = []; // flattened [{ brandKey, brandLabel, corpKey, corp }]

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n-placeholder'));
    if (msg) el.placeholder = msg;
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function setSegmentedActive(container, value) {
  container.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.value === value);
  });
}

function wireSegmented(container, key, onChange) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    current[key] = btn.dataset.value;
    setSegmentedActive(container, btn.dataset.value);
    onChange?.();
  });
}

function applyPageTheme() {
  document.documentElement.dataset.theme = current.theme;
}

async function renderPreview() {
  if (!stylesCssText) {
    stylesCssText = await fetch(chrome.runtime.getURL('styles.css')).then((r) => r.text());
  }
  badgePreviewHost.innerHTML = '';
  const host = document.createElement('span');
  host.className = 'im-badge-host';
  host.setAttribute('data-theme', current.theme);
  host.setAttribute('data-font-size', current.fontSize);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = stylesCssText;
  shadow.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.className = 'im-wrapper';
  wrapper.style.margin = '0';

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'im-badge im-badge--high';
  const label = chrome.i18n.getMessage('badgeLabel') || 'War Sponsor';
  badge.textContent = current.badgeStyle === 'icon' ? '⚠️' : `⚠️ ${label}`;

  wrapper.appendChild(badge);
  shadow.appendChild(wrapper);
  badgePreviewHost.appendChild(host);
}

async function load() {
  const stored = await chrome.storage.local.get('imSettings');
  current = { ...DEFAULT_SETTINGS, ...(stored.imSettings || {}) };

  setSegmentedActive(themeSegmented, current.theme);
  setSegmentedActive(fontSizeSegmented, current.fontSize);
  setSegmentedActive(badgeStyleSegmented, current.badgeStyle);
  setSegmentedActive(domainModeSegmented, current.domainListMode);
  domainListInput.value = (current.domainList || []).join('\n');

  applyPageTheme();
  await renderPreview();
}

async function save() {
  current.domainList = domainListInput.value
    .split('\n')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  await chrome.storage.local.set({ imSettings: current });

  savedNotice.hidden = false;
  setTimeout(() => {
    savedNotice.hidden = true;
  }, 2000);
}

wireSegmented(themeSegmented, 'theme', () => {
  applyPageTheme();
  renderPreview();
});
wireSegmented(fontSizeSegmented, 'fontSize', renderPreview);
wireSegmented(badgeStyleSegmented, 'badgeStyle', renderPreview);
wireSegmented(domainModeSegmented, 'domainListMode');

saveBtn.addEventListener('click', save);

feedbackFab.addEventListener('click', () => {
  chrome.tabs.create({ url: `${REPORT_REPO_URL}/issues/new` });
});

// ---------- The Catalog ----------

function titleCase(key) {
  return key.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

async function loadDb() {
  // Prefer the same cache content.js/background.js use, so the catalog
  // reflects live data once synced — bundled data/brands.json is only a
  // cold-start fallback.
  try {
    const stored = await chrome.storage.local.get('brandDbCache');
    if (stored.brandDbCache?.data) return stored.brandDbCache.data;
  } catch {
    // fall through to bundled copy
  }
  const res = await fetch(chrome.runtime.getURL('data/brands.json'));
  return res.json();
}

// Transliterated aliases (e.g. "барні"/"барни" alongside "barni" — see
// content.js's normalizeBrand) are additional *matchable* keys in the same
// flat brands.json map, not a separate concept the schema tracks — the
// simplest way to make them matchable without a bigger schema migration
// (a nested {name, aliases[]} shape per brand would touch buildBrandIndex,
// every write site in tools/*.py, and CSV/JSON export). The one thing that
// approach needs here: the Catalog is a *display* list, and showing
// "Barni" and "Барні" as two separate cards for the same underlying
// mapping would just look like duplicate/broken data, so alias keys
// (detected by containing no Latin letters) are filtered out of the
// catalog view while remaining fully live for on-page matching.
const HAS_LATIN_LETTER_RE = /[a-z]/i;

function buildCatalogEntries(db) {
  return Object.entries(db.brands || {})
    .filter(([brandKey]) => HAS_LATIN_LETTER_RE.test(brandKey))
    .map(([brandKey, corpKey]) => ({
      brandKey,
      brandLabel: titleCase(brandKey),
      corpKey,
      corp: (db.corporations || {})[corpKey] || null
    }))
    .sort((a, b) => a.brandLabel.localeCompare(b.brandLabel));
}

// Badge color follows computed RISK, not the raw KSE status — a "stay"
// company with a trivial reported tax figure isn't the same shade as one
// with a multi-billion one. "left" (exited) always wins as green even if
// the corp was historically NACP-listed (see the propaganda-badge
// suppression below): a company that's gone is gone, not "high risk".
// Grey ("unknown") is reserved for the one truly unclassifiable
// fallback — a corp record that's missing or has no threat at all.
function riskClassFor(corp) {
  if (!corp) return 'unknown';
  if (corp.status === 'left') return 'left';
  if (corp.is_propaganda) return 'high';
  if (corp.threat === 'high' || corp.threat === 'medium' || corp.threat === 'low') return corp.threat;
  return 'unknown';
}

function formatUsd(musd) {
  if (musd == null) return null;
  const n = Number(musd);
  if (!Number.isFinite(n)) return null;
  return n >= 1000 ? `$${(n / 1000).toFixed(1)}B` : `$${Math.round(n)}M`;
}

// Shared between the card (compact) and the modal (full detail) so the two
// views can never disagree about what a given entry means.
function buildCardViewModel(entry) {
  const corp = entry.corp;
  const status = corp?.status || 'unknown';
  const lang = chrome.i18n.getUILanguage().toLowerCase().startsWith('uk') ? 'uk' : 'en';
  const info = (lang === 'uk' ? corp?.inf_ua : corp?.inf_en) || corp?.inf_ua || corp?.inf_en || '';
  const sourceUrl = corp?.source_url || 'https://leave-russia.org';
  const statusSuffix = status.charAt(0).toUpperCase() + status.slice(1);
  const statusLabel = chrome.i18n.getMessage(`status${statusSuffix}`) || status;
  const riskClass = riskClassFor(corp);

  // "Active propaganda" specifically claims *current* behavior — never show
  // it for a corp that has since exited Russia (status left), even though
  // is_propaganda stays true in the data as an honest historical record.
  const showPropaganda = !!corp?.is_propaganda && status !== 'left';
  const propagandaLabel = chrome.i18n.getMessage('catalogPropagandaBadge') || '📢 Active propaganda';
  const propagandaDesc = (lang === 'uk' ? corp?.propaganda_desc_ua : corp?.propaganda_desc_en)
    || corp?.propaganda_desc_ua || corp?.propaganda_desc_en || '';

  // Distinct from is_propaganda (which specifically means "on the sourced
  // NACP list of foreign war sponsors") — Russian-origin is a different,
  // structural designation (the company's own nationality), verified
  // against Wikidata's own country claim rather than the NACP list, so it
  // gets its own badge rather than reusing the propaganda one.
  const showRussianOrigin = !!corp?.is_russian_origin;
  const russianOriginLabel = chrome.i18n.getMessage('catalogRussianOriginBadge') || '🇷🇺 Russian-origin company';

  const revenueLabel = chrome.i18n.getMessage('catalogRevenueLabel') || 'Revenue';
  const taxLabel = chrome.i18n.getMessage('catalogTaxLabel') || 'Tax paid';
  const revenue = formatUsd(corp?.revenue_rf_musd);
  const taxes = formatUsd(corp?.taxes_rf_musd);
  // Figures are only surfaced for the risk tiers where they're the point
  // (high/propaganda) — showing a raw dollar figure next to a "left"/
  // low-risk entry reads as an accusation the data doesn't support.
  const showFigures = (riskClass === 'high') && (revenue || taxes);

  return {
    corp, status, info, sourceUrl, statusLabel, riskClass,
    showPropaganda, propagandaLabel, propagandaDesc,
    showRussianOrigin, russianOriginLabel,
    revenueLabel, taxLabel, revenue, taxes, showFigures,
  };
}

function renderCatalogCard(entry) {
  const vm = buildCardViewModel(entry);
  const { corp, riskClass, showPropaganda, propagandaLabel, showRussianOrigin, russianOriginLabel,
    revenueLabel, taxLabel, revenue, taxes, showFigures, statusLabel } = vm;

  const card = document.createElement('div');
  const cardClasses = ['catalog-card'];
  if (riskClass === 'high') cardClasses.push('catalog-card--critical');
  if (showRussianOrigin) cardClasses.push('catalog-card--ru-origin');
  card.className = cardClasses.join(' ');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.innerHTML = `
    <span class="catalog-card__status catalog-card__status--${riskClass}">${escapeHtml(statusLabel)}</span>
    ${showPropaganda ? `<span class="catalog-card__propaganda">${escapeHtml(propagandaLabel)}</span>` : ''}
    ${showRussianOrigin ? `<span class="catalog-card__propaganda catalog-card__propaganda--ru">${escapeHtml(russianOriginLabel)}</span>` : ''}
    <h3 class="catalog-card__brand">${escapeHtml(entry.brandLabel)}</h3>
    <p class="catalog-card__corp">${escapeHtml(corp?.name || entry.corpKey)}</p>
    ${showFigures ? `
    <p class="catalog-card__figures">
      ${taxes ? `<span>${escapeHtml(taxLabel)}: <strong>${escapeHtml(taxes)}</strong></span>` : ''}
      ${revenue ? `<span>${escapeHtml(revenueLabel)}: <strong>${escapeHtml(revenue)}</strong></span>` : ''}
    </p>` : ''}
  `;
  // A modal (not an inline expand) so opening a card never reflows the
  // grid — the row heights around it stayed stable no matter which card
  // was open, which the inline-expand version couldn't guarantee once
  // descriptions varied a lot in length.
  card.addEventListener('click', () => openCatalogModal(entry));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openCatalogModal(entry);
    }
  });
  return card;
}

// ---------- Catalog detail modal ----------

let modalLastFocused = null;

function openCatalogModal(entry) {
  const vm = buildCardViewModel(entry);
  const { corp, statusLabel, riskClass, showPropaganda, propagandaLabel, propagandaDesc,
    showRussianOrigin, russianOriginLabel, revenueLabel, taxLabel, revenue, taxes, info, sourceUrl } = vm;

  modalBrand.textContent = entry.brandLabel;
  modalCorp.textContent = corp?.name || entry.corpKey;

  const badges = [`<span class="catalog-card__status catalog-card__status--${riskClass}">${escapeHtml(statusLabel)}</span>`];
  if (showPropaganda) badges.push(`<span class="catalog-card__propaganda">${escapeHtml(propagandaLabel)}</span>`);
  if (showRussianOrigin) badges.push(`<span class="catalog-card__propaganda catalog-card__propaganda--ru">${escapeHtml(russianOriginLabel)}</span>`);
  modalBadges.innerHTML = badges.join('');

  if (revenue || taxes) {
    modalFigures.hidden = false;
    modalFigures.innerHTML = `
      ${taxes ? `<div class="modal__figure"><span>${escapeHtml(taxLabel)}</span><strong>${escapeHtml(taxes)}</strong></div>` : ''}
      ${revenue ? `<div class="modal__figure"><span>${escapeHtml(revenueLabel)}</span><strong>${escapeHtml(revenue)}</strong></div>` : ''}
    `;
  } else {
    modalFigures.hidden = true;
    modalFigures.innerHTML = '';
  }

  modalDesc.innerHTML = `
    <p>${escapeHtml(info)}</p>
    ${showPropaganda && propagandaDesc ? `<p class="catalog-card__propaganda-desc">${escapeHtml(propagandaDesc)}</p>` : ''}
  `;

  modalVisitBtn.href = sourceUrl;
  modalCopyBtn.dataset.url = sourceUrl;
  modalCopyBtn.textContent = chrome.i18n.getMessage('catalogCopyLink') || 'Copy link';

  modalLastFocused = document.activeElement;
  // Open/closed is driven purely by the .is-open class (opacity +
  // visibility + pointer-events in options.css) — no `hidden` attribute
  // involved. It was, briefly: but .modal-overlay's own `display: flex`
  // is an author-origin rule and always beats the [hidden] attribute's
  // UA-stylesheet `display: none`, hidden-attribute or not, which meant
  // the overlay silently sat over the entire page as a full-viewport,
  // invisible, click-blocking layer at all times. pointer-events on the
  // closed state now does the actual blocking-prevention; this class is
  // the only thing that needs toggling.
  catalogModalOverlay.classList.add('is-open');
  catalogModalClose.focus();
}

function closeCatalogModal() {
  catalogModalOverlay.classList.remove('is-open');
  modalLastFocused?.focus();
}

catalogModalClose.addEventListener('click', closeCatalogModal);
catalogModalOverlay.addEventListener('click', (e) => {
  if (e.target === catalogModalOverlay) closeCatalogModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && catalogModalOverlay.classList.contains('is-open')) closeCatalogModal();
});
modalCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(modalCopyBtn.dataset.url || '');
    const original = modalCopyBtn.textContent;
    modalCopyBtn.textContent = chrome.i18n.getMessage('catalogLinkCopied') || 'Copied!';
    window.setTimeout(() => {
      modalCopyBtn.textContent = original;
    }, 1500);
  } catch {
    // clipboard permission denied or unavailable — the Visit button next
    // to it still works, so this isn't a dead end for the user.
  }
});

let catalogRenderTimer = null;
function scheduleCatalogRender() {
  clearTimeout(catalogRenderTimer);
  catalogRenderTimer = setTimeout(renderCatalog, 120);
}

function renderCatalog() {
  const query = catalogSearch.value.trim().toLowerCase();
  const statusFilter = catalogStatusFilter.value;

  const frag = document.createDocumentFragment();
  let shown = 0;

  for (const entry of catalogEntries) {
    const status = entry.corp?.status || 'unknown';
    if (statusFilter && status !== statusFilter) continue;
    if (query) {
      const haystack = `${entry.brandLabel} ${entry.corp?.name || ''}`.toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    shown++;
    frag.appendChild(renderCatalogCard(entry));
  }

  catalogGrid.innerHTML = '';
  if (shown === 0) {
    const empty = document.createElement('div');
    empty.className = 'catalog-empty';
    empty.textContent = chrome.i18n.getMessage('catalogNoResults') || 'No brands match your search.';
    catalogGrid.appendChild(empty);
  } else {
    catalogGrid.appendChild(frag);
  }

  const ofWord = chrome.i18n.getMessage('catalogOf') || 'of';
  const brandsWord = chrome.i18n.getMessage('catalogBrandsSuffix') || 'brands';
  catalogCount.textContent = `${shown} ${ofWord} ${catalogEntries.length} ${brandsWord}`;
}

async function initCatalog() {
  fullDb = await loadDb();
  catalogEntries = buildCatalogEntries(fullDb);
  renderCatalog();
}

catalogSearch.addEventListener('input', scheduleCatalogRender);
catalogStatusFilter.addEventListener('change', renderCatalog);

// Force-downloads the latest brands.json from the configured GitHub raw URL
// (same REFRESH_DB flow the popup's own refresh button uses) and re-renders
// the Catalog against the freshly-synced data once it lands.
bulkUpdateBtn.addEventListener('click', async () => {
  bulkUpdateBtn.disabled = true;
  catalogSyncIndicator.hidden = false;
  const originalLabel = bulkUpdateBtn.textContent;
  bulkUpdateBtn.textContent = chrome.i18n.getMessage('refreshing') || 'Refreshing…';
  try {
    await chrome.runtime.sendMessage({ type: 'REFRESH_DB' });
  } finally {
    await initCatalog();
    bulkUpdateBtn.disabled = false;
    bulkUpdateBtn.textContent = originalLabel;
    catalogSyncIndicator.hidden = true;
  }
});

// Debug/troubleshooting escape hatch: wipes chrome.storage.local's cached
// snapshot outright and reloads straight from the bundled data/brands.json
// (via background.js's CLEAR_CACHE handler), for when a stale cache is
// stuck (e.g. during development, before REMOTE_URL points at a real repo)
// and Bulk Update's own remote-then-freshest-fallback logic hasn't picked
// up a locally-rebuilt file yet.
clearCacheBtn.addEventListener('click', async () => {
  clearCacheBtn.disabled = true;
  catalogSyncIndicator.hidden = false;
  const originalLabel = clearCacheBtn.textContent;
  clearCacheBtn.textContent = chrome.i18n.getMessage('refreshing') || 'Refreshing…';
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
  } finally {
    await initCatalog();
    clearCacheBtn.disabled = false;
    clearCacheBtn.textContent = originalLabel;
    catalogSyncIndicator.hidden = true;
  }
});

// ---------- export ----------

function downloadBlob(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

exportJsonBtn.addEventListener('click', async () => {
  const db = fullDb || (await loadDb());
  downloadBlob(JSON.stringify(db, null, 2), 'application/json', 'impact-monitor-brands.json');
});

exportCsvBtn.addEventListener('click', async () => {
  const db = fullDb || (await loadDb());
  const rows = [['brand', 'parent_corporation', 'status', 'threat', 'is_propaganda', 'revenue_rf_musd', 'taxes_rf_musd', 'source_url']];
  for (const [brandKey, corpKey] of Object.entries(db.brands || {})) {
    const corp = (db.corporations || {})[corpKey] || {};
    rows.push([
      brandKey, corp.name || corpKey, corp.status || '', corp.threat || '',
      corp.is_propaganda ? 'true' : 'false',
      corp.revenue_rf_musd ?? '', corp.taxes_rf_musd ?? '',
      corp.source_url || ''
    ]);
  }
  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  downloadBlob(csv, 'text/csv', 'impact-monitor-brands.csv');
});

applyI18n();
load();
initCatalog();
