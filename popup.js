// Stop Sponsor — popup UI logic

// TODO: point this at your published stop-sponsor repo.
const REPORT_REPO_URL = 'https://github.com/YOUR_GITHUB_USERNAME/stop-sponsor';
const MISSING_BRAND_TEMPLATE = 'missing-brand.yml';

const dbStatusEl = document.getElementById('dbStatus');
const dbBrandsCountEl = document.getElementById('dbBrandsCount');
const dbUpdatedEl = document.getElementById('dbUpdated');
const refreshBtn = document.getElementById('refreshBtn');
const reportBtn = document.getElementById('reportBtn');
const sourceLink = document.getElementById('sourceLink');
const settingsBtn = document.getElementById('settingsBtn');
const syncIndicator = document.getElementById('syncIndicator');

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n-title'));
    if (msg) {
      el.title = msg;
      el.setAttribute('aria-label', msg);
    }
  });
}

async function applyTheme() {
  const stored = await chrome.storage.local.get('imSettings');
  document.documentElement.dataset.theme = stored.imSettings?.theme || 'system';
}

settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

async function loadStatus() {
  const stored = await chrome.storage.local.get('brandDbCache');
  const entry = stored.brandDbCache;

  if (!entry) {
    dbStatusEl.textContent = chrome.i18n.getMessage('statusLoading') || 'Loading…';
    dbBrandsCountEl.textContent = '—';
    dbUpdatedEl.textContent = '—';
    return;
  }

  dbStatusEl.textContent = entry.source === 'remote'
    ? (chrome.i18n.getMessage('statusRemote') || 'Remote (live)')
    : (chrome.i18n.getMessage('statusLocal') || 'Local fallback');
  dbBrandsCountEl.textContent = String(Object.keys(entry.data?.brands || {}).length);
  // Prefer the data's own `updatedAt` header (set by tools/verify_brands.py
  // and brand_expander.py when the dataset itself was last regenerated)
  // over `fetchedAt` (when this browser last synced) — a browser that
  // synced today against a dataset generated weeks ago should say so,
  // not just report "today".
  dbUpdatedEl.textContent = entry.data?.updatedAt || new Date(entry.fetchedAt).toLocaleDateString();
}

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  syncIndicator.hidden = false;
  const original = refreshBtn.textContent;
  refreshBtn.textContent = chrome.i18n.getMessage('refreshing') || 'Refreshing…';
  try {
    await chrome.runtime.sendMessage({ type: 'REFRESH_DB' });
  } finally {
    await loadStatus();
    refreshBtn.disabled = false;
    refreshBtn.textContent = original;
    syncIndicator.hidden = true;
  }
});

reportBtn.addEventListener('click', () => {
  const url = `${REPORT_REPO_URL}/issues/new?template=${MISSING_BRAND_TEMPLATE}`;
  chrome.tabs.create({ url });
});

sourceLink.href = REPORT_REPO_URL;

applyI18n();
applyTheme();
loadStatus();
