// Stop Sponsor — background service worker
// Fetches the brand/corporation database from a remote GitHub-hosted JSON
// file, caches it in chrome.storage.local for 24h, and falls back to the
// bundled local copy (data/brands.json) if the remote fetch fails.

const REMOTE_URL_KEY = 'remoteDbUrl';
const CACHE_KEY = 'brandDbCache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// TODO: point this at your published stop-sponsor repo, e.g.
// "https://raw.githubusercontent.com/<user>/stop-sponsor/main/brands.json"
const DEFAULT_REMOTE_URL =
  'https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/stop-sponsor/main/brands.json';

async function loadLocalFallback() {
  const res = await fetch(chrome.runtime.getURL('data/brands.json'));
  const data = await res.json();
  return { data, source: 'local-fallback' };
}

async function getRemoteUrl() {
  const stored = await chrome.storage.local.get(REMOTE_URL_KEY);
  return stored[REMOTE_URL_KEY] || DEFAULT_REMOTE_URL;
}

function isValidDb(data) {
  return !!data && typeof data === 'object' &&
    data.brands && typeof data.brands === 'object' &&
    data.corporations && typeof data.corporations === 'object';
}

async function fetchRemoteDb() {
  const remoteUrl = await getRemoteUrl();
  const res = await fetch(remoteUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Remote DB fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!isValidDb(data)) throw new Error('Remote DB has an unexpected shape');
  return { data, source: 'remote' };
}

// Whether `candidate` is more current than `incumbent` — compares the
// data's own `updatedAt` (set by tools/verify_brands.py and
// brand_expander.py), falling back to brand count if that's missing or
// tied. This is what lets a locally-rebuilt data/brands.json (e.g. during
// development, where the file on disk changes between extension reloads
// but chrome.storage.local persists across them) actually replace a
// smaller/older cached snapshot — REMOTE_URL is still a placeholder in
// this build, so remote fetches always fail and previously the code just
// kept re-serving whatever was cached first, forever, however stale.
function isNewer(candidate, incumbent) {
  if (!incumbent) return true;
  if (!candidate) return false;
  const cDate = candidate.updatedAt || '';
  const iDate = incumbent.updatedAt || '';
  if (cDate && iDate && cDate !== iDate) return cDate > iDate;
  const cCount = Object.keys(candidate.brands || {}).length;
  const iCount = Object.keys(incumbent.brands || {}).length;
  return cCount > iCount;
}

async function freshestOf(cached) {
  // A local file read is cheap (bundled resource, no network round-trip),
  // so it's always worth checking rather than only on install/update —
  // that way a stale cache self-heals the next time anything calls
  // getDb(), not just right after a reload.
  const local = await loadLocalFallback().catch(() => null);
  if (local && isNewer(local.data, cached?.data)) {
    const entry = { ...local, fetchedAt: Date.now() };
    await chrome.storage.local.set({ [CACHE_KEY]: entry });
    return entry;
  }
  return cached;
}

async function getDb({ forceRefresh = false } = {}) {
  const cached = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
  const isFresh = cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS;

  if (isFresh && !forceRefresh) {
    return await freshestOf(cached);
  }

  try {
    const { data, source } = await fetchRemoteDb();
    const entry = { data, source, fetchedAt: Date.now() };
    await chrome.storage.local.set({ [CACHE_KEY]: entry });
    return entry;
  } catch (err) {
    console.warn('[StopSponsor] Remote DB unavailable, using fallback.', err);
    // Previously this unconditionally returned the stale cache here — but
    // a stale cache doesn't "beat nothing" when the bundled local copy is
    // actually newer, which is exactly the case while REMOTE_URL is a
    // placeholder: every refresh attempt hits this branch and, before this
    // fix, could never surface locally-rebuilt data at all.
    return await freshestOf(cached);
  }
}

async function clearCache() {
  await chrome.storage.local.remove(CACHE_KEY);
  return await getDb({ forceRefresh: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GET_DB') {
    getDb({ forceRefresh: !!message.forceRefresh }).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (message?.type === 'REFRESH_DB') {
    getDb({ forceRefresh: true }).then(sendResponse);
    return true;
  }
  if (message?.type === 'CLEAR_CACHE') {
    clearCache().then(sendResponse);
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  getDb().catch((err) => console.error('[StopSponsor] initial DB load failed', err));
});
