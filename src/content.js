(async function () {
  'use strict';

  if (window.__stayCamCheckLoaded) return;

  const CLASSIFIER = globalThis.StayCamClassifier;
  if (!CLASSIFIER) {
    console.error('[StayCam Check] Classifier failed to load.');
    return;
  }
  window.__stayCamCheckLoaded = true;

  const CACHE_KEY = 'staycam:cache:v3';
  const SETTINGS_KEY = 'staycam:settings:v3';
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_CACHE_ENTRIES = 500;
  const CLASSIFIER_REVISION = 2;
  const DEFAULT_SETTINGS = { hideConfirmed: true, autoScanNewResults: false };

  const state = {
    running: false,
    scanActivated: false,
    stopRequested: false,
    processedThisPage: new Map(),
    counts: { discovered: 0, checked: 0, cameras: 0, noCameras: 0, notListed: 0, hidden: 0, unverified: 0 }
  };

  let settings = { ...DEFAULT_SETTINGS };
  let cache = {};
  let settingsLoaded = false;
  let cacheLoaded = false;
  let storageRecovery;
  let settingsOperation = Promise.resolve();
  const unsavedCacheIds = new Set();
  const errors = {};
  let statusText = 'Ready. Scans run only when requested.';
  let panel;
  let statusElement;
  let scanButton;
  let hideCheckbox;
  let autoCheckbox;
  let observerTimer;
  let scanGeneration = 0;
  let cacheOperation = Promise.resolve();
  let knownCards = new Map();
  let searchContext = `${location.pathname || ''}${location.search || ''}`;

  async function loadSettings() {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
  }

  function syncSettingsControls() {
    if (hideCheckbox) hideCheckbox.checked = settings.hideConfirmed;
    if (autoCheckbox) autoCheckbox.checked = settings.autoScanNewResults;
  }

  function reportError(key, message) {
    errors[key] = message;
    // Keep the error available to messages even if the affected DOM cannot display it.
    try { setStatusLine(statusText); } catch { /* A later control action can retry the UI. */ }
  }

  function recoverStorage() {
    if (storageRecovery) return storageRecovery;
    const generation = scanGeneration;
    const tasks = [];
    if (!settingsLoaded) tasks.push(loadSettings().then((loaded) => {
      settings = loaded;
      settingsLoaded = true;
      delete errors.settingsRead;
    }, () => reportError('settingsRead', 'Saved settings could not be read; using temporary defaults. Scan or change a setting to retry.')));
    if (!cacheLoaded) tasks.push(loadCache().then((loaded) => {
      if (generation !== scanGeneration) return;
      cache = { ...loaded, ...cache };
      cacheLoaded = true;
      delete errors.cacheRead;
    }, () => {
      if (generation === scanGeneration) reportError('cacheRead', 'Saved cache could not be read; results are temporary. Scan to retry.');
    }));
    storageRecovery = Promise.all(tasks).finally(() => {
      storageRecovery = null;
      syncSettingsControls();
      setStatusLine(statusText);
    });
    return storageRecovery;
  }

  function updateSettings(changes) {
    const pending = settingsOperation.then(async () => {
      await recoverStorage();
      // Do not overwrite unknown persistent settings with fallback defaults.
      if (!settingsLoaded) throw new Error('Saved settings are unavailable. Please retry.');
      const next = { ...settings, ...changes };
      try {
        await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      } catch {
        reportError('settingsWrite', 'Settings were not saved. Please retry.');
        throw new Error(errors.settingsWrite);
      }
      settings = next;
      delete errors.settingsWrite;
      syncSettingsControls();
      refreshVisibility();
      setStatusLine(statusText);
      return { ok: true, settings };
    });
    settingsOperation = pending.catch(() => undefined);
    return pending.finally(syncSettingsControls);
  }

  async function loadCache() {
    const data = await chrome.storage.local.get(CACHE_KEY);
    const parsed = data[CACHE_KEY] || {};
    const now = Date.now();
    return Object.fromEntries(Object.entries(parsed).filter(([, entry]) =>
      entry && Number.isFinite(entry.checkedAt) && now - entry.checkedAt < CACHE_TTL_MS
    ));
  }

  async function saveCache() {
    const entries = Object.entries(cache)
      .sort((a, b) => (b[1].checkedAt || 0) - (a[1].checkedAt || 0))
      .slice(0, MAX_CACHE_ENTRIES);
    cache = Object.fromEntries(entries);
    unsavedCacheIds.forEach((id) => { if (!cache[id]) unsavedCacheIds.delete(id); });
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  }

  function extractListingId(url) {
    try {
      const parsed = new URL(url, location.origin);
      if (parsed.protocol !== 'https:' ||
          !['www.airbnb.com', 'airbnb.com'].includes(parsed.hostname)) return null;
      return parsed.pathname.match(/^\/rooms\/(\d+)\/?$/)?.[1] || null;
    } catch {
      return null;
    }
  }

  function listingIdsInside(element) {
    const ids = new Set();
    element.querySelectorAll('a[href*="/rooms/"]').forEach((link) => {
      const id = extractListingId(link.href);
      if (id) ids.add(id);
    });
    return ids;
  }

  function containsOnlyListing(element, listingId) {
    const ids = listingIdsInside(element);
    return ids.size === 1 && ids.has(listingId);
  }

  function findCardForAnchor(anchor, listingId) {
    const selectors = [
      '[data-testid="card-container"]',
      '[data-testid*="listing-card"]',
      '[itemprop="itemListElement"]',
      'article',
      'li'
    ];
    for (const [index, selector] of selectors.entries()) {
      const candidate = anchor.closest(selector);
      // Generic article/li tags need geometry; keep accepted cards discoverable while hidden.
      if (candidate && candidate !== document.body && candidate !== document.documentElement &&
          containsOnlyListing(candidate, listingId) && (index < 3 || knownCards.has(candidate) || hasCardSize(candidate))) return candidate;
    }

    let node = anchor;
    let best = null;
    for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue;
      const rect = node.getBoundingClientRect();
      const ids = listingIdsInside(node);
      if (ids.size > 1 || rect.width > window.innerWidth * 0.95) break;
      if (node !== document.body && node !== document.documentElement && ids.size === 1 && ids.has(listingId) &&
          rect.width >= 180 && rect.height >= 150) best = node;
    }
    return best;
  }

  function hasCardSize(card) {
    const rect = card.getBoundingClientRect();
    return rect.width >= 180 && rect.height >= 150 && rect.width <= window.innerWidth * 0.95;
  }

  function reconcileSearchContext() {
    const current = `${location.pathname || ''}${location.search || ''}`;
    if (current === searchContext) return;
    searchContext = current;
    scanGeneration += 1;
    state.running = false;
    state.processedThisPage.clear();
    setScanButtonState();
    setStatusLine(state.stopRequested ? 'Scan stopped.' : 'Ready. Scans run only when requested.');
  }

  function discoverListings() {
    reconcileSearchContext();
    const byId = new Map();
    const nextCards = new Map();
    document.querySelectorAll('a[href*="/rooms/"]').forEach((anchor) => {
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const id = extractListingId(anchor.href);
      if (!id) return;
      const card = findCardForAnchor(anchor, id);
      if (!card?.isConnected) return;
      nextCards.set(card, id);
      if (!byId.has(id)) byId.set(id, { id, url: `https://www.airbnb.com/rooms/${id}`, cards: new Set() });
      byId.get(id).cards.add(card);
    });
    knownCards.forEach((id, card) => {
      if (nextCards.get(card) === id) return;
      if (card.dataset.staycamStatus) clearCardMarks(card);
      delete card.dataset.staycamListingId;
    });
    nextCards.forEach((id, card) => {
      if (card.dataset.staycamListingId !== id) card.dataset.staycamListingId = id;
    });
    knownCards = nextCards;
    state.counts.discovered = byId.size;
    updatePanel();
    return [...byId.values()];
  }

  function fetchListingHtml(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'STAYCAM_FETCH_LISTING', url }, (response) => {
        try {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || 'Listing request failed.'));
            return;
          }
          resolve(response.html);
        } catch (error) { reject(error); }
      });
    });
  }

  function getCachedResult(id) {
    const entry = cache[id];
    if (!entry) return null;
    if (Date.now() - entry.checkedAt >= CACHE_TTL_MS ||
        entry.classifierRevision !== CLASSIFIER_REVISION) {
      delete cache[id];
      return null;
    }
    return entry;
  }

  function getDisplayResult(id) {
    const cached = getCachedResult(id);
    if (cached) return cached;
    const previous = state.processedThisPage.get(id);
    // Share an unverified result between representations, without persisting it.
    return previous?.status === 'unverified' ? previous : null;
  }

  function queueCacheOperation(operation) {
    const pending = cacheOperation.then(operation);
    cacheOperation = pending.catch(() => undefined);
    return pending;
  }

  async function setCachedResult(id, result, generation) {
    if (result.status === 'unverified') return;
    await queueCacheOperation(async () => {
      if (generation !== scanGeneration) return;
      cache[id] = { ...result, checkedAt: Date.now(), classifierRevision: CLASSIFIER_REVISION };
      unsavedCacheIds.add(id);
      await persistCache(generation);
    });
  }

  async function persistCache(generation) {
    if (generation !== scanGeneration || !cacheLoaded) return;
    try {
      await saveCache();
      if (generation !== scanGeneration) return;
      unsavedCacheIds.clear();
      delete errors.cacheWrite;
      setStatusLine(statusText);
    } catch {
      if (generation === scanGeneration) reportError('cacheWrite', 'Results are shown but cache saving failed. Scan to retry.');
    }
  }

  function removeBadge(card) {
    card.querySelector(':scope > .staycam-card-badge')?.remove();
  }

  function addBadge(card, text, type, title) {
    const existing = card.querySelector(':scope > .staycam-card-badge');
    if (existing?.className === `staycam-card-badge staycam-card-badge--${type}` &&
        existing.textContent === text && existing.title === (title || text)) return;
    removeBadge(card);
    const badge = document.createElement('div');
    badge.className = `staycam-card-badge staycam-card-badge--${type}`;
    badge.textContent = text;
    badge.title = title || text;
    if (getComputedStyle(card).position === 'static') {
      card.dataset.staycamChangedPosition = 'true';
      card.style.position = 'relative';
    }
    card.appendChild(badge);
  }

  function applyResult(listing, result) {
    listing?.cards.forEach((card) => {
      if (isCurrentCard(card, listing.id)) applyResultToCard(card, listing.id, result);
    });
  }

  function isCurrentCard(card, id) {
    return card?.isConnected && knownCards.get(card) === id && containsOnlyListing(card, id);
  }

  function applyResultToCard(card, id, result) {
    card.dataset.staycamClassifiedId = id;
    card.dataset.staycamStatus = result.status;
    card.hidden = false;
    card.style.removeProperty('display');
    card.classList.remove('staycam-camera-card', 'staycam-no-camera-card', 'staycam-not-listed-card', 'staycam-unverified-card');

    if (result.status === 'camera') {
      card.classList.add('staycam-camera-card');
      addBadge(card, 'Camera confirmed', 'camera', `${result.source || 'Listing data'}${result.path ? ` - ${result.path}` : ''}`);
      if (settings.hideConfirmed) card.hidden = true;
    } else if (result.status === 'no_camera') {
      card.classList.add('staycam-no-camera-card');
      addBadge(card, 'Camera explicitly unavailable', 'no-camera', `The camera amenity was returned with available=false.${result.path ? ` ${result.path}` : ''}`);
    } else if (result.status === 'not_listed') {
      card.classList.add('staycam-not-listed-card');
      addBadge(card, 'Camera amenity not listed', 'not-listed', result.reason);
    } else {
      card.classList.add('staycam-unverified-card');
      addBadge(card, 'Could not verify', 'unverified', `${result.reason || 'The listing could not be checked.'}${result.path ? ` ${result.path}` : ''}`);
    }
  }

  function recount(listings = discoverListings()) {
    const counts = { discovered: listings.length, checked: 0, cameras: 0, noCameras: 0, notListed: 0, hidden: 0, unverified: 0 };
    listings.forEach((listing) => {
      const marked = [...listing.cards].filter((card) => isCurrentCard(card, listing.id) &&
        card.dataset.staycamClassifiedId === listing.id && card.dataset.staycamStatus);
      const status = marked[0]?.dataset.staycamStatus;
      if (!status) return;
      counts.checked += 1;
      if (status === 'camera') counts.cameras += 1;
      if (status === 'no_camera') counts.noCameras += 1;
      if (status === 'not_listed') counts.notListed += 1;
      if (status === 'unverified') counts.unverified += 1;
      if (marked.some((card) => card.hidden)) counts.hidden += 1;
    });
    state.counts = counts;
    updatePanel();
  }

  async function checkListing(listing, generation) {
    const cached = getCachedResult(listing.id);
    if (cached) {
      if (unsavedCacheIds.has(listing.id)) await queueCacheOperation(() => persistCache(generation));
      return cached;
    }
    try {
      const html = await fetchListingHtml(listing.url);
      reconcileSearchContext();
      if (generation !== scanGeneration) return null;
      const result = CLASSIFIER.inspectListingHtml(html);
      await setCachedResult(listing.id, result, generation);
      return result;
    } catch (error) {
      return { status: 'unverified', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async function scanCurrentResults({ onlyNew = false } = {}) {
    let generation = scanGeneration;
    let ownsScan = false;
    let failed = false;
    try {
      discoverListings();
      if (state.running) return;
      generation = scanGeneration;
      ownsScan = true;
      state.running = true;
      state.scanActivated = true;
      state.stopRequested = false;
      delete errors.scan;
      delete errors.control;
      setScanButtonState();
      await recoverStorage();
      if (generation !== scanGeneration) return;
      const queue = discoverListings().filter((listing) => !onlyNew || !state.processedThisPage.has(listing.id));
      for (let index = 0; index < queue.length; index += 1) {
        if (generation !== scanGeneration) return;
        if (state.stopRequested) break;
        const current = discoverListings();
        if (generation !== scanGeneration) return;
        const listing = current.find((item) => item.id === queue[index].id);
        if (!listing) continue;
        setStatusLine(`Checking ${index + 1} of ${queue.length}...`);
        const result = await checkListing(listing, generation);
        // Obsolete work must not even discover/clean up the newer scan's DOM.
        if (generation !== scanGeneration) return;
        const visible = discoverListings();
        if (generation !== scanGeneration) return;
        state.processedThisPage.set(listing.id, result);
        applyResult(visible.find((item) => item.id === listing.id), result);
        recount(visible);
      }
    } catch {
      if (generation === scanGeneration) {
        failed = true;
        pauseAfterError();
      }
    } finally {
      if (ownsScan && generation === scanGeneration) {
        state.running = false;
        try {
          setScanButtonState();
          recount(discoverListings());
          if (!failed && generation === scanGeneration) setStatusLine(state.stopRequested ? 'Scan stopped.' : 'Current results checked.');
        } catch { pauseAfterError(); }
      }
    }
  }

  function pauseAfterError() {
    state.scanActivated = false;
    state.stopRequested = true;
    reportError('scan', 'Scan interrupted by an unexpected error. Scan to retry.');
    try { setScanButtonState(); } catch { /* Running state is still recoverable through messages. */ }
  }

  function stopScan() {
    state.scanActivated = false;
    state.stopRequested = true;
    setStatusLine(state.running ? 'Stopping after the current listing...' : 'Scan stopped.');
  }

  function setScanButtonState() {
    setTextIfChanged(scanButton, state.running ? 'Stop scan' : 'Scan current results');
  }

  function refreshVisibility() {
    const listings = discoverListings();
    listings.forEach((listing) => {
      listing.cards.forEach((card) => {
        if (card.dataset.staycamClassifiedId === listing.id && card.dataset.staycamStatus === 'camera') {
          card.hidden = settings.hideConfirmed;
        }
      });
    });
    recount(listings);
  }

  async function clearCacheAndMarks() {
    // Invalidate results immediately; the shared background queue still owns network ordering.
    scanGeneration += 1;
    state.running = false;
    state.scanActivated = false;
    state.stopRequested = true;
    clearTimeout(observerTimer);
    setScanButtonState();
    cache = {};
    cacheLoaded = true; // Never rehydrate pre-Clear data, even if removal fails.
    unsavedCacheIds.clear();
    delete errors.cacheRead;
    delete errors.cacheWrite;
    // A started write must finish before removal, and new-generation writes follow removal.
    const cleared = queueCacheOperation(() => chrome.storage.local.remove(CACHE_KEY));
    const generation = scanGeneration;
    let visualError = false;
    try {
      state.processedThisPage.clear();
      new Set([...knownCards.keys(), ...document.querySelectorAll('[data-staycam-listing-id]')]).forEach(clearCardMarks);
      setStatusLine('Page markings cleared; clearing saved cache...');
      recount();
    } catch { visualError = true; }
    try {
      await cleared;
    } catch {
      const error = 'Saved cache could not be cleared. Retry Clear.';
      if (generation === scanGeneration) reportError('clear', error);
      return { ok: false, error };
    }
    if (visualError) throw new Error('Page markings could not all be cleared. Retry Clear.');
    if (generation === scanGeneration) {
      delete errors.clear;
      delete errors.scan;
      setStatusLine('Cache and page markings cleared.');
    }
    return { ok: true };
  }

  function clearCardMarks(card) {
    card.hidden = false;
    card.style.removeProperty('display');
    delete card.dataset.staycamStatus;
    delete card.dataset.staycamClassifiedId;
    card.classList.remove('staycam-camera-card', 'staycam-no-camera-card', 'staycam-not-listed-card', 'staycam-unverified-card');
    removeBadge(card);
    if (card.dataset.staycamChangedPosition === 'true') {
      card.style.removeProperty('position');
      delete card.dataset.staycamChangedPosition;
    }
  }

  function setTextIfChanged(element, text) {
    if (element && element.textContent !== text) element.textContent = text;
  }

  function setStatusLine(text) {
    statusText = text;
    const warnings = Object.values(errors).filter((message) => !text.includes(message));
    setTextIfChanged(statusElement, [text, ...warnings].join(' '));
  }

  function runControl(action, key, failure, respond = () => {}) {
    let pending;
    try { pending = action(); } catch (error) { pending = Promise.reject(error); }
    return Promise.resolve(pending).then((result) => {
      if (result?.ok !== false) delete errors[key];
      try { setStatusLine(statusText); } catch {
        errors.control = 'Control status could not be displayed. Please retry.';
      }
      respond(result || { ok: true });
    }, () => {
      reportError(key, failure);
      respond({ ok: false, error: failure });
    }).catch(() => undefined); // A closed popup/message channel must not reject globally.
  }

  function updatePanel() {
    if (!panel) return;
    const c = state.counts;
    setTextIfChanged(panel.querySelector('.staycam-counts'),
      `${c.discovered} found - ${c.checked} checked - ${c.cameras} camera - ` +
      `${c.noCameras} crossed out - ${c.notListed} not listed - ` +
      `${c.hidden} hidden - ${c.unverified} unverified`);
  }

  function createPanel() {
    panel = document.createElement('section');
    panel.id = 'staycam-panel';
    panel.innerHTML = `
      <div class="staycam-title">StayCam Check</div>
      <div class="staycam-subtitle">Exterior-camera disclosure classifier</div>
      <div class="staycam-counts">0 found - 0 checked</div>
      <div class="staycam-status">Ready. Scans run only when requested.</div>
      <div class="staycam-controls">
        <button type="button" class="staycam-scan">Scan current results</button>
        <label class="staycam-row"><input type="checkbox" class="staycam-hide">Hide confirmed camera listings</label>
        <label class="staycam-row"><input type="checkbox" class="staycam-auto">Auto-scan newly loaded results</label>
        <button type="button" class="staycam-secondary staycam-clear">Clear local cache and markings</button>
      </div>
      <div class="staycam-warning">Unofficial tool. It detects disclosed status only and cannot identify undisclosed cameras.</div>`;
    document.body.appendChild(panel);

    statusElement = panel.querySelector('.staycam-status');
    scanButton = panel.querySelector('.staycam-scan');
    hideCheckbox = panel.querySelector('.staycam-hide');
    autoCheckbox = panel.querySelector('.staycam-auto');
    hideCheckbox.checked = settings.hideConfirmed;
    autoCheckbox.checked = settings.autoScanNewResults;

    scanButton.addEventListener('click', () => state.running ? stopScan() : scanCurrentResults());
    hideCheckbox.addEventListener('change', () => runControl(
      () => updateSettings({ hideConfirmed: hideCheckbox.checked }), 'settingsWrite', 'Settings could not be saved. Please retry.'));
    autoCheckbox.addEventListener('change', () => runControl(
      () => updateSettings({ autoScanNewResults: autoCheckbox.checked }), 'settingsWrite', 'Settings could not be saved. Please retry.'));
    panel.querySelector('.staycam-clear').addEventListener('click', () => runControl(
      clearCacheAndMarks, 'clear', 'Cache or page clearing failed. Retry Clear.'));
  }

  function watchForNewResults() {
    function isExtensionNode(node) {
      const element = node instanceof HTMLElement ? node : node.parentElement;
      return Boolean(element && (panel.contains(element) || element.closest('.staycam-card-badge')));
    }
    function scheduleDiscovery() {
      clearTimeout(observerTimer);
      observerTimer = setTimeout(() => {
        try {
          const listings = discoverListings();
          listings.forEach((listing) => {
            const result = getDisplayResult(listing.id);
            if (!state.stopRequested && result && [...listing.cards].some((card) =>
              card.dataset.staycamClassifiedId !== listing.id || !card.dataset.staycamStatus)) {
              state.processedThisPage.set(listing.id, result);
              applyResult(listing, result);
            }
          });
          recount(listings);
          if (state.scanActivated && settings.autoScanNewResults && !state.running &&
              listings.some((listing) => !state.processedThisPage.has(listing.id))) {
            scanCurrentResults({ onlyNew: true });
          }
        } catch { pauseAfterError(); }
      }, 800);
    }
    const observer = new MutationObserver((mutations) => {
      const hasPageChange = mutations.some((mutation) =>
        !isExtensionNode(mutation.target) && (mutation.type === 'attributes'
          ? mutation.target instanceof HTMLAnchorElement
          : [...mutation.addedNodes, ...mutation.removedNodes].some((node) => !isExtensionNode(node)))
      );
      if (hasPageChange) scheduleDiscovery();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    window.addEventListener('popstate', scheduleDiscovery);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message?.type === 'STAYCAM_SCAN') {
        scanCurrentResults();
        sendResponse({ ok: true });
      } else if (message?.type === 'STAYCAM_STOP') {
        stopScan();
        sendResponse({ ok: true });
      } else if (message?.type === 'STAYCAM_CLEAR') {
        runControl(clearCacheAndMarks, 'clear', 'Cache or page clearing failed. Retry Clear.', sendResponse);
        return true;
      } else if (message?.type === 'STAYCAM_GET_STATUS') {
        sendResponse({ ok: true, state: { running: state.running, counts: state.counts }, settings,
          error: Object.values(errors).join(' ') || null,
          persistence: { settingsLoaded, cacheLoaded, unsavedCacheEntries: unsavedCacheIds.size } });
      } else if (message?.type === 'STAYCAM_SET_SETTINGS') {
        runControl(() => updateSettings(message.settings), 'settingsWrite', 'Settings could not be saved. Please retry.', sendResponse);
        return true;
      }
    } catch {
      reportError('control', 'Control action failed. Please retry.');
      sendResponse({ ok: false, error: errors.control });
    }
    return undefined;
  });

  createPanel();
  watchForNewResults();
  await recoverStorage();
  try { discoverListings(); } catch { pauseAfterError(); }
})();
