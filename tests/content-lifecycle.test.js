'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWorker } = require('./background.test');

const source = fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8');
const CACHE_KEY = 'staycam:cache:v3';
const SETTINGS_KEY = 'staycam:settings:v3';
let assertions = 0;
function equal(...args) { assert.equal(...args); assertions += 1; }
function deepEqual(...args) { assert.deepEqual(...args); assertions += 1; }
const flush = () => new Promise(setImmediate);

// A bounded DOM/childList adapter, not an Airbnb schema or an HTML parser.
// Runs the actual content script; messages, mutations, timers and request replies are controlled.
async function createPage({ ids = ['1001'], auto = true, cache = {}, failReads = [], worker } = {}) {
  const requests = [];
  const timers = new Map();
  const writes = [];
  const removals = [];
  const operations = [];
  const failures = { get: [...failReads], set: [], remove: [] };
  let listenerCount = 0;
  let observerCount = 0;
  let discoveryFailure = false;
  let classificationFailure = false;
  let messageFailure = false;
  function failNext(operation, key) { failures[operation].push(key); }
  function throwIfFailed(operation, key) {
    const index = failures[operation].findIndex((value) => value === undefined || value === key);
    if (index < 0) return;
    failures[operation].splice(index, 1);
    throw new Error('Synthetic storage rejection');
  }
  const gates = { set: [], remove: [] };
  function holdNext(operation) {
    let release;
    let reject;
    let started;
    const gate = {
      promise: new Promise((resolve, fail) => { release = resolve; reject = fail; }),
      started: new Promise((resolve) => { started = resolve; }),
      release: () => release(),
      reject: () => reject(new Error('Synthetic delayed storage rejection')),
      signal: () => started()
    };
    gates[operation].push(gate);
    return gate;
  }
  const data = { [CACHE_KEY]: structuredClone(cache), [SETTINGS_KEY]: {
    hideConfirmed: true, autoScanNewResults: auto, retainedOption: 'keep'
  }, unrelated: { keep: true } };
  let onMessage;
  let observer;
  let observerOptions;
  let mutationBatch = [];
  let deliveryQueued = false;
  let nextTimer = 0;
  let discoveryReads = 0;
  let textWrites = 0;
  let classifications = 0;
  let body;
  let documentElement;

  function mutate(target, addedNodes, removedNodes) {
    if (!observer || !target.isConnected) return;
    mutationBatch.push({ type: 'childList', target, addedNodes, removedNodes });
    if (deliveryQueued) return;
    deliveryQueued = true;
    queueMicrotask(() => {
      deliveryQueued = false;
      const batch = mutationBatch;
      mutationBatch = [];
      observer(batch);
    });
  }

  function attributeChanged(target, name) {
    if (!observer || !target.isConnected || !observerOptions.attributes ||
        !observerOptions.attributeFilter.includes(name)) return;
    queueMicrotask(() => observer([{ type: 'attributes', target, attributeName: name }]));
  }

  class Element {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.className = '';
      this.style = { removeProperty(key) { delete this[key]; } };
      this.listeners = {};
      this._text = '';
      this.rect = { width: 0, height: 0 };
      this.classList = {
        add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); }
      };
    }
    get isConnected() { return this === body || this === documentElement || Boolean(this.parentElement?.isConnected); }
    get textContent() { return this._text; }
    set textContent(value) {
      textWrites += 1;
      const removed = this.children.slice();
      const text = { parentElement: this, textContent: String(value) };
      this.children = [text];
      removed.forEach((child) => { child.parentElement = null; });
      this._text = String(value);
      mutate(this, [text], removed);
    }
    set innerHTML(markup) {
      // Only materialize the fixed panel's controls; nesting/layout are not under test here.
      for (const match of markup.matchAll(/<(div|button|input)[^>]*class="([^"]+)"[^>]*>([^<]*)/g)) {
        const element = new Element(match[1]);
        element.className = match[2];
        element.textContent = match[3];
        this.appendChild(element);
      }
    }
    appendChild(child) {
      if (child.parentElement) child.remove();
      this.children.push(child);
      child.parentElement = this;
      mutate(this, [child], []);
      return child;
    }
    remove() {
      const parent = this.parentElement;
      if (!parent) return;
      parent.children = parent.children.filter((child) => child !== this);
      this.parentElement = null;
      mutate(parent, [], [this]);
    }
    contains(node) {
      for (let current = node; current; current = current.parentElement) if (current === this) return true;
      return false;
    }
    matches(selector) {
      if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
      if (selector === '[data-testid="card-container"]') return this.dataset.testid === 'card-container';
      if (selector === '[data-testid*="listing-card"]') return this.dataset.testid?.includes('listing-card');
      if (selector === '[itemprop="itemListElement"]') return this.itemprop === 'itemListElement';
      if (selector === 'article' || selector === 'li') return this.tagName === selector;
      if (selector === '[data-staycam-listing-id]') return this.dataset.staycamListingId !== undefined;
      return selector === 'a[href*="/rooms/"]' && this instanceof Anchor && this.href.includes('/rooms/');
    }
    closest(selector) {
      for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current;
      return null;
    }
    querySelectorAll(selector) {
      const matches = [];
      for (const child of this.children) {
        if (!(child instanceof Element)) continue;
        if (child.matches(selector)) matches.push(child);
        matches.push(...child.querySelectorAll(selector));
      }
      return matches;
    }
    querySelector(selector) {
      if (selector === ':scope > .staycam-card-badge') {
        return this.children.find((child) => child instanceof Element && child.matches('.staycam-card-badge')) || null;
      }
      return this.querySelectorAll(selector)[0] || null;
    }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    getBoundingClientRect() { return this.rect; }
  }
  class Anchor extends Element {
    constructor(id) { super('a'); this.href = `https://www.airbnb.com/rooms/${id}`; }
    get href() { return this._href; }
    set href(value) { this._href = value; attributeChanged(this, 'href'); }
  }
  body = new Element('body');
  documentElement = new Element('html');
  documentElement.appendChild(body);
  function addCard(id) {
    const card = new Element('article');
    card.dataset.testid = 'card-container';
    card.appendChild(new Anchor(id));
    body.appendChild(card);
    return card;
  }
  const cards = ids.map(addCard);
  const navigationListeners = new Map();
  const pageLocation = new URL('https://www.airbnb.com/s/Atlanta/homes');
  const context = {
    window: { innerWidth: 1000, addEventListener(type, callback) { navigationListeners.set(type, callback); } }, location: pageLocation, URL,
    HTMLElement: Element, HTMLAnchorElement: Anchor,
    getComputedStyle: (element) => ({ position: element.style.position || 'static' }),
    MutationObserver: class { constructor(callback) { this.callback = callback; observerCount += 1; } observe(target, options) { observer = this.callback; observerOptions = options; } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    document: { body, documentElement, createElement: (tag) => new Element(tag), querySelectorAll(selector) {
      if (discoveryFailure) { discoveryFailure = false; throw new Error('Synthetic discovery exception'); }
      if (selector === 'a[href*="/rooms/"]') discoveryReads += 1;
      return body.querySelectorAll(selector);
    } },
    StayCamClassifier: { inspectListingHtml(html) {
      classifications += 1;
      if (classificationFailure) { classificationFailure = false; throw new Error('Synthetic classification exception'); }
      return JSON.parse(html);
    } },
    chrome: {
      storage: { local: {
        async get(key) { throwIfFailed('get', key); return { [key]: structuredClone(data[key]) }; },
        async set(values) {
          const snapshot = structuredClone(values);
          writes.push(snapshot);
          if (CACHE_KEY in values) {
            operations.push('set:start');
            const gate = gates.set.shift();
            if (gate) { gate.signal(); await gate.promise; }
          }
          throwIfFailed('set', Object.keys(values)[0]);
          Object.assign(data, snapshot);
          if (CACHE_KEY in values) operations.push('set:end');
        },
        async remove(key) {
          removals.push(key);
          operations.push('remove:start');
          const gate = gates.remove.shift();
          if (gate) { gate.signal(); await gate.promise; }
          throwIfFailed('remove', key);
          delete data[key];
          operations.push('remove:end');
        }
      } },
      runtime: {
        onMessage: { addListener(listener) { onMessage = listener; listenerCount += 1; } },
        sendMessage(message, callback) {
          if (messageFailure) { messageFailure = false; throw new Error('Synthetic messaging exception'); }
          requests.push({ ...message, callback });
          if (worker) worker.dispatch(message, callback);
        }
      }
    }
  };
  await vm.runInNewContext(source, context, { filename: 'src/content.js' });
  await flush();
  const panel = body.children.find((child) => child.id === 'staycam-panel');
  const message = (type, extra = {}) => new Promise((resolve) => onMessage({ type, ...extra }, {}, resolve));
  return {
    cards, addCard, body, documentElement, panel, requests, writes, removals, data, timers, message, holdNext, operations, failNext,
    get listenerCount() { return listenerCount; },
    get observerCount() { return observerCount; },
    throwDiscovery() { discoveryFailure = true; },
    throwClassification() { classificationFailure = true; },
    throwMessage() { messageFailure = true; },
    async reinject() { await vm.runInNewContext(source, context); await flush(); },
    element: (tag = 'div') => new Element(tag),
    link: (url) => { const anchor = new Anchor('1001'); anchor.href = url; return anchor; },
    navigate(path, popstate = false) {
      pageLocation.href = new URL(path, pageLocation).href;
      if (popstate) navigationListeners.get('popstate')?.();
    },
    get discoveryReads() { return discoveryReads; },
    get textWrites() { return textWrites; },
    get classifications() { return classifications; },
    async start() { await message('STAYCAM_SCAN'); await flush(); },
    async reply(index, result = { status: 'not_listed' }) {
      requests[index].callback({ ok: true, html: JSON.stringify(result) });
      await flush();
    },
    async fail(index) {
      requests[index].callback({ ok: false, error: 'Synthetic request failure' });
      await flush();
    },
    async tick() {
      await flush();
      const entry = timers.entries().next().value;
      if (!entry) return;
      const [id, { callback, delay }] = entry;
      timers.delete(id);
      equal(delay, 800, 'existing discovery debounce');
      callback();
      await flush();
    },
    async settle(limit = 6) {
      await flush();
      for (let i = 0; timers.size && i < limit; i += 1) await this.tick();
      return timers.size === 0;
    },
    async status() { return (await message('STAYCAM_GET_STATUS')).state; }
  };
}

async function receive(page, type, extra) {
  let reply;
  page.message(type, extra).then((value) => { reply = value; });
  await flush();
  assert.notEqual(reply, undefined, 'control message must receive a response');
  assertions += 1;
  return reply;
}

const cases = [
  ['F11 unexpected asynchronous response exception becomes an individual unverified result', async () => {
    const page = await createPage({ ids: ['1001', '1002'] });
    await page.start();
    page.requests[0].callback({ get ok() { throw new Error('Synthetic callback exception'); } });
    await flush();
    equal(page.cards[0].dataset.staycamStatus, 'unverified');
    await page.reply(1, { status: 'no_camera' });
    equal(page.cards[1].dataset.staycamStatus, 'no_camera');
    equal((await page.status()).running, false);
  }],
  ['F11 concurrent settings changes preserve both persisted choices', async () => {
    const page = await createPage();
    const replies = await Promise.all([
      page.message('STAYCAM_SET_SETTINGS', { settings: { hideConfirmed: false } }),
      page.message('STAYCAM_SET_SETTINGS', { settings: { autoScanNewResults: false } })
    ]);
    equal(replies.every((reply) => reply.ok), true);
    equal(page.data[SETTINGS_KEY].hideConfirmed, false);
    equal(page.data[SETTINGS_KEY].autoScanNewResults, false);
    equal(page.data[SETTINGS_KEY].retainedOption, 'keep');
  }],
  ['F11 marking exception cleans running state and manual Scan reuses valid saved data', async () => {
    const page = await createPage();
    const classes = page.cards[0].classList;
    const add = classes.add;
    classes.add = () => { classes.add = add; throw new Error('Synthetic marking exception'); };
    await page.start();
    await page.reply(0, { status: 'camera' });
    equal((await page.status()).running, false);
    equal(Boolean((await page.message('STAYCAM_GET_STATUS')).error), true);
    await page.start();
    equal(page.cards[0].hidden, true);
    equal(page.cards[0].querySelectorAll('.staycam-card-badge').length, 1);
    equal(page.requests.length, 1);
    equal((await page.message('STAYCAM_GET_STATUS')).error, null);
  }],
  ['F11 obsolete cache-write rejection cannot finalize the fresh scan', async () => {
    const page = await createPage();
    const write = page.holdNext('set');
    await page.start();
    await page.reply(0, { status: 'camera' });
    await write.started;
    const clear = page.message('STAYCAM_CLEAR');
    await page.start();
    write.reject();
    await clear;
    await flush();
    equal((await page.status()).running, true);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    await page.reply(1, { status: 'no_camera' });
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
    equal(page.data[CACHE_KEY][1001].status, 'no_camera');
    equal((await page.status()).running, false);
    equal((await page.message('STAYCAM_GET_STATUS')).error, null);
  }],
  ...[[SETTINGS_KEY], [CACHE_KEY], [SETTINGS_KEY, CACHE_KEY]].map((failReads) => [`F11 startup rejection ${failReads.join('+')} retains controls and recovers`, async () => {
    const page = await createPage({ failReads, auto: false });
    const first = await page.message('STAYCAM_GET_STATUS');
    equal(first.ok, true);
    equal(Boolean(first.error), true);
    equal(page.requests.length, 0);
    equal(page.writes.length, 0, 'fallback must not overwrite persisted values');
    equal(page.listenerCount, 1);
    equal(page.observerCount, 1);
    await page.start();
    await page.reply(0, { status: 'camera' });
    equal(page.cards[0].dataset.staycamStatus, 'camera');
    equal(page.data[CACHE_KEY][1001].status, 'camera');
    equal((await page.message('STAYCAM_GET_STATUS')).error, null);
    await page.reinject();
    equal(page.listenerCount, 1);
    equal(page.observerCount, 1);
    equal(page.body.children.filter((child) => child.id === 'staycam-panel').length, 1);
  }]),
  ['F11 unknown persisted settings are not overwritten by fallback defaults', async () => {
    const page = await createPage({ failReads: [SETTINGS_KEY] });
    page.failNext('get', SETTINGS_KEY);
    const reply = await receive(page, 'STAYCAM_SET_SETTINGS', { settings: { hideConfirmed: false } });
    equal(reply.ok, false);
    equal(page.data[SETTINGS_KEY].autoScanNewResults, true);
    equal(page.data[SETTINGS_KEY].hideConfirmed, true);
    equal(page.writes.length, 0);
    const retry = await receive(page, 'STAYCAM_SET_SETTINGS', { settings: { hideConfirmed: false } });
    equal(retry.ok, true);
    equal(retry.settings.autoScanNewResults, true);
    equal(page.data[SETTINGS_KEY].retainedOption, 'keep');
  }],
  ['F11 settings rejection rolls controls and hiding back, then retry succeeds', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0, { status: 'camera' });
    page.failNext('set', SETTINGS_KEY);
    const reply = await receive(page, 'STAYCAM_SET_SETTINGS', { settings: { hideConfirmed: false } });
    equal(reply.ok, false);
    equal(page.data[SETTINGS_KEY].hideConfirmed, true);
    equal(page.panel.querySelector('.staycam-hide').checked, true);
    equal(page.cards[0].hidden, true);
    equal(Boolean((await page.message('STAYCAM_GET_STATUS')).error), true);
    const retry = await receive(page, 'STAYCAM_SET_SETTINGS', { settings: { hideConfirmed: false } });
    equal(retry.ok, true);
    equal(page.data[SETTINGS_KEY].hideConfirmed, false);
    equal(page.cards[0].hidden, false);
    equal((await page.message('STAYCAM_GET_STATUS')).error, null);
  }],
  ['F11 floating-panel settings rejection is caught and checkbox restored', async () => {
    const page = await createPage();
    const checkbox = page.panel.querySelector('.staycam-auto');
    page.failNext('set', SETTINGS_KEY);
    checkbox.checked = false;
    await checkbox.listeners.change();
    equal(checkbox.checked, true);
    equal(page.data[SETTINGS_KEY].autoScanNewResults, true);
    equal(Boolean((await page.message('STAYCAM_GET_STATUS')).error), true);
  }],
  ['F11 cache rejection preserves valid classification, indicates unsaved state and recovers', async () => {
    const page = await createPage();
    page.failNext('set', CACHE_KEY);
    await page.start();
    await page.reply(0, { status: 'camera' });
    equal(page.cards[0].dataset.staycamStatus, 'camera');
    equal(page.cards[0].hidden, true);
    equal(page.data[CACHE_KEY][1001], undefined);
    const failed = await page.message('STAYCAM_GET_STATUS');
    equal(failed.persistence.unsavedCacheEntries, 1);
    equal(Boolean(failed.error), true);
    equal(failed.state.running, false);
    const second = page.addCard('1001');
    await page.tick();
    equal(second.dataset.staycamStatus, 'camera');
    equal(page.requests.length, 1);
    await page.start();
    equal(page.requests.length, 1, 'retry memory persistence without refetch or new classification');
    equal(page.data[CACHE_KEY][1001].status, 'camera');
    equal((await page.message('STAYCAM_GET_STATUS')).persistence.unsavedCacheEntries, 0);
    equal((await page.message('STAYCAM_GET_STATUS')).error, null);
  }],
  ['F11 unread cache prevents overwriting unknown entries; read/persistence recover', async () => {
    const page = await createPage({ failReads: [CACHE_KEY], cache: { retained: { status: 'no_camera', checkedAt: Date.now(), classifierRevision: 2 } } });
    page.failNext('get', CACHE_KEY);
    await page.start();
    await page.reply(0, { status: 'not_listed' });
    equal(page.cards[0].dataset.staycamStatus, 'not_listed');
    equal(page.writes.length, 0);
    equal(page.data[CACHE_KEY].retained.status, 'no_camera');
    await page.start();
    equal(page.data[CACHE_KEY].retained.status, 'no_camera');
    equal(page.data[CACHE_KEY][1001].status, 'not_listed');
    equal(page.requests.length, 1);
  }],
  ['F11 cache persistence retry retains original TTL timestamp and revision', async () => {
    const page = await createPage();
    page.failNext('set', CACHE_KEY);
    await page.start();
    await page.reply(0, { status: 'not_listed' });
    const firstAttempt = page.writes[0][CACHE_KEY][1001];
    await page.start();
    equal(page.data[CACHE_KEY][1001].checkedAt, firstAttempt.checkedAt);
    equal(page.data[CACHE_KEY][1001].classifierRevision, 2);
    equal(page.requests.length, 1);
    deepEqual(page.data.unrelated, { keep: true });
  }],
  ['F11 pending storage cannot produce an early successful Clear acknowledgement', async () => {
    const page = await createPage();
    const write = page.holdNext('set');
    await page.start();
    await page.reply(0, { status: 'camera' });
    await write.started;
    let reply;
    page.message('STAYCAM_CLEAR').then((value) => { reply = value; });
    await flush();
    equal(reply, undefined);
    equal((await page.status()).running, false);
    equal(page.removals.length, 0);
    equal(page.panel.querySelector('.staycam-status').textContent.includes('clearing saved cache'), true);
    write.release();
    await flush();
    equal(reply?.ok, true);
    equal(page.data[CACHE_KEY], undefined);
  }],
  ...[false, true].map((delayed) => [`F11 Clear ${delayed ? 'delayed prior write then' : 'immediate'} removal rejection is honest and retryable`, async () => {
    const page = await createPage();
    const gate = delayed ? page.holdNext('set') : null;
    await page.start();
    await page.reply(0, { status: 'camera' });
    if (gate) await gate.started;
    page.failNext('remove', CACHE_KEY);
    let reply;
    page.message('STAYCAM_CLEAR').then((value) => { reply = value; });
    await flush();
    if (gate) { gate.release(); await flush(); }
    equal(reply?.ok, false);
    equal(Boolean(reply?.error), true);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(Boolean(page.cards[0].hidden), false);
    equal(page.data[CACHE_KEY][1001].status, 'camera', 'failed persistent removal is not hidden');
    equal(page.data[SETTINGS_KEY].autoScanNewResults, true);
    deepEqual(page.data.unrelated, { keep: true });
    page.addCard('1001');
    await page.tick();
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.requests.length, 1);
    const retry = await receive(page, 'STAYCAM_CLEAR');
    equal(retry.ok, true);
    equal(page.data[CACHE_KEY], undefined);
    await page.start();
    await page.reply(1, { status: 'no_camera' });
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
  }]),
  ['F11 delayed Clear rejection cannot overwrite a newer scan state', async () => {
    const page = await createPage();
    const removal = page.holdNext('remove');
    let clearReply;
    page.message('STAYCAM_CLEAR').then((value) => { clearReply = value; });
    await removal.started;
    await page.start();
    removal.reject();
    await flush();
    equal(clearReply?.ok, false);
    equal((await page.status()).running, true);
    await page.reply(0, { status: 'camera' });
    equal(page.cards[0].dataset.staycamStatus, 'camera');
    equal(page.data[CACHE_KEY][1001].status, 'camera');
    equal((await page.status()).running, false);
  }],
  ['F11 discovery exception during scan finalizes and explicit restart works', async () => {
    const page = await createPage({ ids: ['1001', '1002'] });
    await page.start();
    page.throwDiscovery();
    await page.reply(0);
    equal((await page.status()).running, false);
    equal(page.panel.querySelector('.staycam-scan').textContent, 'Scan current results');
    equal(Boolean((await page.message('STAYCAM_GET_STATUS')).error), true);
    await page.tick();
    equal(page.requests.length, 1, 'unexpected error must not auto-loop');
    await page.message('STAYCAM_STOP');
    await page.start();
    await page.reply(1);
    equal((await page.status()).running, false);
    equal(page.cards[1].dataset.staycamStatus, 'not_listed');
  }],
  ['F11 pre-scan discovery exception is handled by existing control interface', async () => {
    const page = await createPage();
    page.throwDiscovery();
    await page.start();
    equal((await page.status()).running, false);
    equal(Boolean((await page.message('STAYCAM_GET_STATUS')).error), true);
    await page.message('STAYCAM_CLEAR');
    await page.start();
    await page.reply(0);
    equal(page.cards[0].dataset.staycamStatus, 'not_listed');
  }],
  ...['classification', 'message'].map((failure) => [`F11 recoverable ${failure} exception does not strand later listings`, async () => {
    const page = await createPage({ ids: ['1001', '1002'], auto: false });
    if (failure === 'message') page.throwMessage();
    else page.throwClassification();
    await page.start();
    if (failure === 'classification') await page.reply(0);
    equal(page.cards[0].dataset.staycamStatus, 'unverified');
    const nextIndex = failure === 'message' ? 0 : 1;
    await page.reply(nextIndex, { status: 'camera' });
    equal(page.cards[1].dataset.staycamStatus, 'camera');
    equal((await page.status()).running, false);
    equal(page.data[CACHE_KEY][1001], undefined);
  }]),
  ['F11 stale scan cleanup cannot reset the running flag of a new generation', async () => {
    const page = await createPage();
    await page.start();
    await page.message('STAYCAM_CLEAR');
    await page.start();
    await page.fail(0);
    equal((await page.status()).running, true);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    await page.reply(1, { status: 'no_camera' });
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
    equal((await page.status()).running, false);
  }],
  ['F11 observer discovery error pauses safely without a repeated error loop', async () => {
    const page = await createPage();
    page.addCard('1002');
    page.throwDiscovery();
    await page.tick();
    equal((await page.status()).running, false);
    equal(Boolean((await page.message('STAYCAM_GET_STATUS')).error), true);
    equal(await page.settle(), true);
    await page.start();
    await page.reply(0);
    await page.reply(1);
    equal((await page.status()).counts.checked, 2);
  }],
  ['F08/F06 Stop during a stalled worker request preserves finish-current semantics', async () => {
    const worker = createWorker(() => new Promise(() => {}));
    const page = await createPage({ ids: ['1001', '1002'], worker });
    await page.start();
    await page.message('STAYCAM_STOP');
    page.addCard('1003');
    await page.tick();
    await worker.advance(20000);
    equal(page.cards[0].dataset.staycamStatus, 'unverified');
    equal(page.requests.length, 1);
    equal((await page.status()).running, false);
    equal(page.writes.length, 0);
  }],
  ['F08/F05 Clear plus immediate manual restart survives an old timeout', async () => {
    let count = 0;
    const worker = createWorker(() => count++ === 0 ? new Promise(() => {}) : Promise.resolve({ ok: true, text: async () => JSON.stringify({ status: 'camera' }) }));
    const page = await createPage({ worker });
    await page.start();
    await page.message('STAYCAM_CLEAR');
    await page.start();
    await worker.advance(20000);
    equal(page.cards[0].dataset.staycamStatus, 'camera');
    equal(page.data[CACHE_KEY][1001].status, 'camera');
    equal(page.requests.length, 2);
    equal((await page.status()).running, false);
    equal(page.writes.length, 1);
  }],
  ['F08/F13 timed-out A cannot mark reused B; activated auto-scan continues', async () => {
    let count = 0;
    const worker = createWorker(() => count++ === 0 ? new Promise(() => {}) : Promise.resolve({ ok: true, text: async () => JSON.stringify({ status: 'no_camera' }) }));
    const page = await createPage({ worker });
    await page.start();
    page.cards[0].querySelector('a[href*="/rooms/"]').href = 'https://www.airbnb.com/rooms/1002';
    await worker.advance(20000);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    await page.tick();
    await worker.advance(900);
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
    equal(page.data[CACHE_KEY][1001], undefined);
    const newCard = page.addCard('1003');
    await page.tick();
    await worker.advance(900);
    equal(newCard.dataset.staycamStatus, 'no_camera');
    equal(page.requests.length, 3);
  }],
  ['F08/F13 Back/Forward and replacement reject old timeout state', async () => {
    let count = 0;
    const worker = createWorker(() => count++ === 0 ? new Promise(() => {}) : Promise.resolve({ ok: true, text: async () => JSON.stringify({ status: 'not_listed' }) }));
    const page = await createPage({ worker });
    await page.start();
    page.navigate('/s/Boston/homes', true);
    page.cards[0].remove();
    const replacement = page.addCard('1002');
    await page.tick();
    await worker.advance(20000);
    equal(replacement.dataset.staycamStatus, 'not_listed');
    equal(page.cards[0].dataset.staycamStatus, undefined);
    page.navigate('/s/Atlanta/homes', true);
    replacement.remove();
    page.body.appendChild(page.cards[0]);
    await page.tick();
    await worker.advance(900);
    equal(page.cards[0].dataset.staycamStatus, 'not_listed');
    equal(page.requests.length, 3);
  }],
  ['F07 multiple links in one card use one classification', async () => {
    const page = await createPage();
    page.cards[0].appendChild(page.link('https://www.airbnb.com/rooms/1001?photo=2'));
    await page.start();
    await page.reply(0, { status: 'camera' });
    equal(page.requests.length, 1);
    equal(page.classifications, 1);
    equal(page.cards[0].querySelectorAll('.staycam-card-badge').length, 1);
    equal((await page.status()).counts.discovered, 1);
  }],
  ['F07 two representations share one result and hide/restore together', async () => {
    const page = await createPage({ ids: ['1001', '1001'] });
    await page.start();
    await page.reply(0, { status: 'camera' });
    equal(page.requests.length, 1);
    for (const card of page.cards) {
      equal(card.dataset.staycamStatus, 'camera');
      equal(card.hidden, true);
      equal(card.querySelectorAll('.staycam-card-badge').length, 1);
    }
    equal((await page.status()).counts.discovered, 1, 'counts remain unique-listing counts');
    await page.message('STAYCAM_SET_SETTINGS', { settings: { hideConfirmed: false } });
    equal(page.cards.every((card) => !card.hidden), true);
  }],
  ['F07 shared multi-listing parent is never hidden or marked', async () => {
    const page = await createPage({ ids: ['1001', '1002'] });
    const shared = page.element('article');
    shared.dataset.testid = 'card-container';
    shared.rect = { width: 800, height: 400 };
    page.body.appendChild(shared);
    page.cards.forEach((card) => { delete card.dataset.testid; card.tagName = 'div'; shared.appendChild(card); });
    await page.start();
    equal(page.requests.length, 0);
    equal(shared.dataset.staycamStatus, undefined);
    equal(Boolean(shared.hidden), false);
    equal((await page.status()).counts.discovered, 0);
  }],
  ['F07 small generic room-link wrapper is not a verified card', async () => {
    const page = await createPage({ ids: [] });
    const wrapper = page.element('span');
    wrapper.appendChild(page.link('https://www.airbnb.com/rooms/1001'));
    page.body.appendChild(wrapper);
    await page.start();
    equal(page.requests.length, 0);
    equal(wrapper.dataset.staycamListingId, undefined);
  }],
  ['F07 tiny generic list item is not a result card', async () => {
    const page = await createPage({ ids: [] });
    const item = page.element('li');
    item.appendChild(page.link('https://www.airbnb.com/rooms/1001'));
    page.body.appendChild(item);
    await page.start();
    equal(page.requests.length, 0);
    equal(item.dataset.staycamListingId, undefined);
  }],
  ['F07 oversized sole-listing ancestor is rejected before geometry fallback', async () => {
    const page = await createPage();
    delete page.cards[0].dataset.testid;
    page.cards[0].tagName = 'div';
    page.body.rect = { width: 1000, height: 800 };
    await page.start();
    equal(page.requests.length, 0);
    equal(page.body.dataset.staycamListingId, undefined);
  }],
  ['F07 scrollbar-sized document root is never a card', async () => {
    const page = await createPage({ ids: [] });
    const wrapper = page.element('span');
    wrapper.appendChild(page.link('https://www.airbnb.com/rooms/1001'));
    page.body.appendChild(wrapper);
    page.documentElement.rect = { width: 950, height: 800 };
    await page.start();
    equal(page.requests.length, 0);
    equal(page.documentElement.dataset.staycamListingId, undefined);
  }],
  ...['body', 'documentElement'].map((root) => [`F07 dedicated marker cannot promote ${root} to a card`, async () => {
    const page = await createPage({ ids: [] });
    page[root].dataset.testid = 'card-container';
    page.body.appendChild(page.link('https://www.airbnb.com/rooms/1001'));
    await page.start();
    equal(page.requests.length, 0);
    equal(page[root].dataset.staycamListingId, undefined);
  }]),
  ['F07 existing geometry fallback accepts a bounded single-ID container', async () => {
    const page = await createPage();
    delete page.cards[0].dataset.testid;
    page.cards[0].tagName = 'div';
    page.cards[0].rect = { width: 220, height: 200 };
    await page.start();
    await page.reply(0, { status: 'no_camera' });
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
    equal(page.requests.length, 1);
  }],
  ['F07 previously accepted hidden generic card remains discoverable on reuse', async () => {
    const page = await createPage();
    delete page.cards[0].dataset.testid;
    page.cards[0].rect = { width: 220, height: 200 };
    await page.start();
    await page.reply(0, { status: 'camera' });
    page.cards[0].rect = { width: 0, height: 0 };
    page.cards[0].querySelector('a[href*="/rooms/"]').href = 'https://www.airbnb.com/rooms/1002';
    await page.tick();
    equal(page.cards[0].hidden, false);
    equal(page.requests.length, 2);
    await page.reply(1, { status: 'no_camera' });
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
  }],
  ['F07 nested wrappers select the existing dedicated card', async () => {
    const page = await createPage({ ids: [] });
    const card = page.element('article');
    card.dataset.testid = 'card-container';
    const wrapper = page.element('div');
    wrapper.appendChild(page.link('https://www.airbnb.com/rooms/1001'));
    card.appendChild(wrapper);
    page.body.appendChild(card);
    await page.start();
    await page.reply(0);
    equal(card.dataset.staycamStatus, 'not_listed');
    equal(wrapper.dataset.staycamStatus, undefined);
  }],
  ...['https://other.invalid/rooms/1001', 'http://www.airbnb.com/rooms/1001',
    'https://www.airbnb.com/rooms/1001/details', 'https://www.airbnb.com/rooms/1001abc',
    'https://www.airbnb.com/rooms/not-numeric'].map((url) => [`F07 unsupported room URL ${url}`, async () => {
      const page = await createPage();
      page.cards[0].querySelector('a[href*="/rooms/"]').href = url;
      await page.start();
      equal(page.requests.length, 0);
      equal((await page.status()).counts.discovered, 0);
    }]),
  ...['https://airbnb.com/rooms/1001/', '/rooms/1001?adults=2#photos'].map((url) => [`F07 supported room URL ${url}`, async () => {
    const page = await createPage();
    page.cards[0].querySelector('a[href*="/rooms/"]').href = url;
    await page.start();
    await page.reply(0);
    equal(page.cards[0].dataset.staycamStatus, 'not_listed');
    equal(page.requests[0].url, 'https://www.airbnb.com/rooms/1001');
  }]),
  ['F07 second representation added while request pending receives result', async () => {
    const page = await createPage();
    await page.start();
    const second = page.addCard('1001');
    await page.tick();
    equal(page.requests.length, 1);
    await page.reply(0, { status: 'camera' });
    equal(second.dataset.staycamStatus, 'camera');
    equal(second.hidden, true);
    equal(page.requests.length, 1);
    equal(await page.settle(), true);
  }],
  ['F07 unverified result can mark a later representation without persisting/refetching', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0, { status: 'unverified' });
    const second = page.addCard('1001');
    await page.tick();
    equal(second.dataset.staycamStatus, 'unverified');
    equal(page.requests.length, 1);
    equal(page.writes.length, 0);
  }],
  ['F13 href-only A-to-B reuse removes old hiding before B completes', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0, { status: 'camera' });
    page.cards[0].querySelector('a[href*="/rooms/"]').href = 'https://www.airbnb.com/rooms/1002';
    await page.tick();
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.cards[0].hidden, false);
    equal(page.cards[0].querySelector('.staycam-card-badge'), null);
    equal((await page.status()).counts.checked, 0);
    equal(page.requests.length, 2);
    await page.reply(1, { status: 'no_camera' });
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
    equal(page.cards[0].querySelectorAll('.staycam-card-badge').length, 1);
  }],
  ['F13 delayed A result cannot cross to reused B before debounce', async () => {
    const page = await createPage();
    await page.start();
    page.cards[0].querySelector('a[href*="/rooms/"]').href = 'https://www.airbnb.com/rooms/1002';
    await page.reply(0, { status: 'camera' });
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(Boolean(page.cards[0].hidden), false);
    await page.tick();
    equal(page.requests.length, 2);
    await page.reply(1, { status: 'not_listed' });
    equal(page.cards[0].dataset.staycamStatus, 'not_listed');
    equal(page.data[CACHE_KEY][1001].status, 'camera', 'valid cache stays tied to A');
  }],
  ['F13 in-flight result follows same-ID replacement rather than detached card', async () => {
    const page = await createPage();
    await page.start();
    page.cards[0].remove();
    const replacement = page.addCard('1001');
    await page.reply(0, { status: 'camera' });
    equal(replacement.dataset.staycamStatus, 'camera');
    equal(replacement.hidden, true);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal((await page.status()).counts.discovered, 1);
    equal(page.requests.length, 1);
  }],
  ['F13 detached in-flight card does not contribute counts or markings', async () => {
    const page = await createPage();
    await page.start();
    page.cards[0].remove();
    await page.reply(0, { status: 'camera' });
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal((await page.status()).counts.discovered, 0);
    equal((await page.status()).counts.checked, 0);
  }],
  ['F13 stopped reused card clears stale state but does not scan', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0, { status: 'camera' });
    await page.message('STAYCAM_STOP');
    page.cards[0].querySelector('a[href*="/rooms/"]').href = 'https://www.airbnb.com/rooms/1002';
    await page.tick();
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.cards[0].hidden, false);
    equal(page.requests.length, 1);
    await page.start();
    await page.reply(1, { status: 'no_camera' });
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
    equal(await page.settle(), true);
  }],
  ['F13 identity removal cleans unsupported former card', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0, { status: 'camera' });
    page.cards[0].querySelector('a[href*="/rooms/"]').href = 'https://www.airbnb.com/help';
    await page.tick();
    equal(page.cards[0].dataset.staycamListingId, undefined);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.cards[0].hidden, false);
    equal((await page.status()).counts.discovered, 0);
  }],
  ['F13 mixed IDs on a reused card cannot retain its old badge', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0, { status: 'camera' });
    page.cards[0].appendChild(page.link('https://www.airbnb.com/rooms/1002'));
    await page.tick();
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.cards[0].hidden, false);
    equal(page.requests.length, 1);
  }],
  ['F13 one of two pending representations changes identity independently', async () => {
    const page = await createPage({ ids: ['1001', '1001'] });
    await page.start();
    page.cards[1].querySelector('a[href*="/rooms/"]').href = 'https://www.airbnb.com/rooms/1002';
    await page.reply(0, { status: 'camera' });
    equal(page.cards[0].dataset.staycamStatus, 'camera');
    equal(page.cards[1].dataset.staycamStatus, undefined);
    await page.tick();
    equal(page.requests.length, 2);
    await page.reply(1, { status: 'no_camera' });
    equal(page.cards[1].dataset.staycamStatus, 'no_camera');
    equal(page.requests.length, 2);
    equal((await page.status()).counts.discovered, 2);
  }],
  ['F13 destination change invalidates old scan before response applies', async () => {
    const page = await createPage();
    await page.start();
    page.navigate('/s/Boston/homes?adults=2');
    page.cards[0].querySelector('a[href*="/rooms/"]').href = 'https://www.airbnb.com/rooms/1002';
    await page.reply(0, { status: 'camera' });
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.classifications, 0, 'prior search response is invalidated');
    await page.tick();
    equal(page.requests.length, 2);
    await page.reply(1, { status: 'no_camera' });
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
  }],
  ['F13 popstate with unchanged DOM invalidates old work without auto scan', async () => {
    const page = await createPage({ auto: false });
    await page.start();
    page.navigate('/s/Boston/homes', true);
    await page.tick();
    equal((await page.status()).running, false);
    equal(page.requests.length, 1);
    await page.reply(0, { status: 'camera' });
    equal(page.cards[0].dataset.staycamStatus, undefined);
    await page.start();
    await page.reply(1, { status: 'no_camera' });
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
  }],
  ['F13 navigation away/back reconciles processed IDs, retains valid cache', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0, { status: 'unverified' });
    page.navigate('/s/Boston/homes');
    page.cards[0].remove();
    const boston = page.addCard('1002');
    await page.tick();
    await page.reply(1, { status: 'no_camera' });
    page.navigate('/s/Atlanta/homes', true);
    boston.remove();
    const atlanta = page.addCard('1001');
    await page.tick();
    equal(page.requests.length, 3, 'old unverified processed ID does not skip new search');
    await page.reply(2, { status: 'camera' });
    equal(atlanta.dataset.staycamStatus, 'camera');
    page.navigate('/s/Boston/homes', true);
    atlanta.remove();
    const again = page.addCard('1002');
    await page.tick();
    equal(again.dataset.staycamStatus, 'no_camera');
    equal(page.requests.length, 3, 'valid ID cache survives search changes');
    equal(again.querySelectorAll('.staycam-card-badge').length, 1);
  }],
  ['F13 Clear and route/card replacement preserve stale-result invalidation', async () => {
    const page = await createPage();
    await page.start();
    await page.message('STAYCAM_CLEAR');
    page.navigate('/s/Boston/homes', true);
    page.cards[0].remove();
    const replacement = page.addCard('1002');
    await page.tick();
    await page.reply(0, { status: 'camera' });
    equal(replacement.dataset.staycamStatus, undefined);
    equal(page.data[CACHE_KEY], undefined);
    equal(page.requests.length, 1);
    await page.start();
    await page.reply(1, { status: 'no_camera' });
    equal(replacement.dataset.staycamStatus, 'no_camera');
  }],
  ['F13 cached hidden card can detach and reinsert without duplicate badges', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0, { status: 'camera' });
    page.cards[0].remove();
    await page.tick();
    equal((await page.status()).counts.discovered, 0);
    page.body.appendChild(page.cards[0]);
    await page.tick();
    equal(page.cards[0].dataset.staycamStatus, 'camera');
    equal(page.cards[0].querySelectorAll('.staycam-card-badge').length, 1);
    equal(page.requests.length, 1);
    equal(await page.settle(), true);
  }],
  ['F13 removing one representation during fetch still marks the other', async () => {
    const page = await createPage({ ids: ['1001', '1001'] });
    await page.start();
    page.cards[0].remove();
    await page.reply(0, { status: 'camera' });
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.cards[1].dataset.staycamStatus, 'camera');
    equal(page.requests.length, 1);
    equal((await page.status()).counts.discovered, 1);
    equal((await page.status()).counts.hidden, 1);
  }],
  ['F13 navigation and fresh result respect Clear with a pending old write', async () => {
    const page = await createPage();
    const write = page.holdNext('set');
    await page.start();
    await page.reply(0, { status: 'camera' });
    await write.started;
    const clear = page.message('STAYCAM_CLEAR');
    page.navigate('/s/Boston/homes', true);
    page.cards[0].querySelector('a[href*="/rooms/"]').href = 'https://www.airbnb.com/rooms/1002';
    await page.start();
    await page.reply(1, { status: 'no_camera' });
    write.release();
    await clear;
    await flush();
    equal(page.data[CACHE_KEY][1001], undefined);
    equal(page.data[CACHE_KEY][1002].status, 'no_camera');
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
    equal((await page.status()).running, false);
    equal(await page.settle(), true);
  }],
  ['F13 Clear cleans a marked detached card before reinsertion', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0, { status: 'camera' });
    page.cards[0].remove();
    await page.message('STAYCAM_CLEAR');
    page.body.appendChild(page.cards[0]);
    await page.tick();
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.cards[0].hidden, false);
    equal(page.cards[0].querySelector('.staycam-card-badge'), null);
    equal(page.data[CACHE_KEY], undefined);
    equal(page.requests.length, 1);
  }],
  ['F04 panel updates settle', async () => {
    const page = await createPage();
    await page.message('STAYCAM_SET_SETTINGS', { settings: { hideConfirmed: false } });
    equal(await page.settle(), true);
    equal(page.requests.length, 0);
  }],
  ['F04 badge insertion and removal settle', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0, { status: 'camera' });
    equal(page.cards[0].querySelector('.staycam-card-badge')?.textContent, 'Camera confirmed');
    const afterBadge = page.discoveryReads;
    equal(await page.settle(), true, 'badge insertion must settle');
    equal(page.discoveryReads, afterBadge, 'badge insertion does not schedule discovery');
    await page.message('STAYCAM_CLEAR');
    equal(page.cards[0].querySelector('.staycam-card-badge'), null);
    const afterClear = page.discoveryReads;
    equal(await page.settle(), true, 'badge removal must settle');
    equal(page.discoveryReads, afterClear, 'badge removal does not schedule discovery');
    equal(page.requests.length, 1);
  }],
  ['F04 unchanged panel updates do not rewrite text', async () => {
    const page = await createPage();
    const before = page.textWrites;
    for (let i = 0; i < 4; i += 1) {
      await page.message('STAYCAM_SET_SETTINGS', { settings: { hideConfirmed: true } });
    }
    equal(page.textWrites, before);
    equal(await page.settle(), true);
  }],
  ['F04 new cards discovered without startup activation', async () => {
    const page = await createPage();
    page.addCard('1002');
    await page.tick();
    equal((await page.status()).counts.discovered, 2);
    equal(page.requests.length, 0);
    equal(await page.settle(), true);
  }],
  ['F04 replacement card gets cached badge without another request', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0);
    page.cards[0].remove();
    const replacement = page.addCard('1001');
    await page.tick();
    equal(replacement.dataset.staycamStatus, 'not_listed');
    equal(page.requests.length, 1);
    equal(await page.settle(), true);
  }],
  ['F04 automatic scan after deliberate activation', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0);
    const card = page.addCard('1002');
    await page.tick();
    equal(page.requests.length, 2);
    await page.reply(1, { status: 'no_camera' });
    equal(card.dataset.staycamStatus, 'no_camera');
    equal(await page.settle(), true);
    equal(page.requests.length, 2);
  }],
  ['F04 automatic scan disabled still discovers new cards', async () => {
    const page = await createPage({ auto: false });
    await page.start();
    await page.reply(0);
    page.addCard('1002');
    await page.tick();
    equal((await page.status()).counts.discovered, 2);
    equal(page.requests.length, 1);
    equal(await page.settle(), true);
  }],
  ['F04 real host updates mixed with badge changes are observed', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0);
    const before = page.discoveryReads;
    page.cards[0].querySelector('.staycam-card-badge').remove();
    page.cards[0].appendChild(new page.body.constructor('span'));
    await page.tick();
    equal(page.discoveryReads > before, true);
    equal(page.cards[0].dataset.staycamStatus, 'not_listed');
    equal(await page.settle(), true);
  }],
  ['F04 observer activity does not duplicate in-flight requests', async () => {
    const page = await createPage({ ids: ['1001', '1002', '1001'] });
    await page.start();
    page.addCard('1001');
    await page.tick();
    equal(page.requests.length, 1);
    await page.reply(0);
    equal(page.requests.length, 2, 'next unique listing starts after first response');
    await page.reply(1);
    equal(await page.settle(), true);
    deepEqual(page.requests.map(({ url }) => url), ['https://www.airbnb.com/rooms/1001', 'https://www.airbnb.com/rooms/1002']);
  }],
  ['F05 Clear invalidates a pending response and its remaining queue', async () => {
    const page = await createPage({ ids: ['1001', '1002'] });
    await page.start();
    await page.message('STAYCAM_CLEAR');
    equal((await page.status()).running, false);
    equal(page.panel.querySelector('.staycam-scan').textContent, 'Scan current results');
    await page.reply(0, { status: 'camera' });
    equal(page.requests.length, 1);
    equal(page.classifications, 0, 'stale response never reaches classifier');
    equal(page.writes.length, 0);
    equal(page.data[CACHE_KEY], undefined);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.cards[0].querySelector('.staycam-card-badge'), null);
    equal(page.panel.querySelector('.staycam-status').textContent, 'Cache and page markings cleared.');
    equal((await page.status()).counts.checked, 0);
    page.addCard('1003');
    await page.tick();
    equal(page.requests.length, 1, 'Clear disables automatic restart');
    equal(await page.settle(), true);
  }],
  ['F05 Clear removes marked hidden cards and preserves settings', async () => {
    const page = await createPage({ ids: ['1001', '1002'] });
    await page.start();
    await page.reply(0, { status: 'camera' });
    equal(page.cards[0].hidden, true);
    await page.message('STAYCAM_CLEAR');
    equal(page.cards[0].hidden, false);
    equal(page.cards[0].style.position, undefined);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.cards[0].querySelector('.staycam-card-badge'), null);
    await page.reply(1);
    equal(page.cards[1].dataset.staycamStatus, undefined);
    deepEqual(page.data[SETTINGS_KEY], { hideConfirmed: true, autoScanNewResults: true, retainedOption: 'keep' });
    deepEqual(page.data.unrelated, { keep: true });
    equal(page.data[CACHE_KEY], undefined);
    equal(await page.settle(), true);
  }],
  ['F05 Clear is ordered after an in-flight cache write', async () => {
    const page = await createPage();
    const write = page.holdNext('set');
    await page.start();
    await page.reply(0, { status: 'camera' });
    await write.started;
    let cleared = false;
    const clear = page.message('STAYCAM_CLEAR').then(() => { cleared = true; });
    await flush();
    const removalsBeforeRelease = page.removals.length;
    const clearedBeforeRelease = cleared;
    write.release();
    await clear;
    await flush();
    equal(removalsBeforeRelease, 0, 'remove waits for the older write');
    equal(clearedBeforeRelease, false, 'Clear acknowledges completed persistence');
    deepEqual(page.operations, ['set:start', 'set:end', 'remove:start', 'remove:end']);
    equal(page.data[CACHE_KEY], undefined);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal((await page.status()).counts.checked, 0);
    equal(page.panel.querySelector('.staycam-status').textContent, 'Cache and page markings cleared.');
  }],
  ['F05 explicit restart is isolated from a stale response', async () => {
    const page = await createPage();
    await page.start();
    await page.message('STAYCAM_CLEAR');
    await page.start();
    equal(page.requests.length, 2, 'deliberate restart is permitted');
    await page.reply(0, { status: 'camera' });
    equal((await page.status()).running, true, 'stale completion does not finish the new scan');
    equal(page.panel.querySelector('.staycam-scan').textContent, 'Stop scan');
    equal(page.cards[0].dataset.staycamStatus, undefined);
    await page.reply(1, { status: 'no_camera' });
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
    equal(page.data[CACHE_KEY][1001].status, 'no_camera');
    equal(page.data[CACHE_KEY][1001].classifierRevision, 2);
    equal(page.writes.length, 1);
    equal((await page.status()).running, false);
    equal(page.panel.querySelector('.staycam-scan').textContent, 'Scan current results');
  }],
  ['F05 stale error after Clear cannot mark a new generation', async () => {
    const page = await createPage();
    await page.start();
    await page.message('STAYCAM_CLEAR');
    await page.fail(0);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.panel.querySelector('.staycam-status').textContent, 'Cache and page markings cleared.');
    equal(page.writes.length, 0);
  }],
  ['F05 restart persists after Clear even when an older write is pending', async () => {
    const page = await createPage();
    const write = page.holdNext('set');
    await page.start();
    await page.reply(0, { status: 'camera' });
    await write.started;
    const clear = page.message('STAYCAM_CLEAR');
    await page.start();
    const requestCount = page.requests.length;
    if (requestCount === 2) await page.reply(1, { status: 'not_listed' });
    write.release();
    await clear;
    await flush();
    equal(requestCount, 2);
    deepEqual(page.operations, ['set:start', 'set:end', 'remove:start', 'remove:end', 'set:start', 'set:end']);
    equal(page.data[CACHE_KEY][1001].status, 'not_listed');
    equal(page.cards[0].dataset.staycamStatus, 'not_listed');
    equal(page.writes.length, 2);
  }],
  ['F05 repeated Clear does not allow stale results to return', async () => {
    const page = await createPage();
    await page.start();
    await Promise.all([page.message('STAYCAM_CLEAR'), page.message('STAYCAM_CLEAR')]);
    await page.reply(0, { status: 'camera' });
    equal(page.data[CACHE_KEY], undefined);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.requests.length, 1);
    equal(await page.settle(), true);
  }],
  ['F05 fresh scan waits for a delayed removal before persisting', async () => {
    const page = await createPage();
    const removal = page.holdNext('remove');
    const clear = page.message('STAYCAM_CLEAR');
    await removal.started;
    await page.start();
    await page.reply(0, { status: 'no_camera' });
    equal(page.writes.length, 0, 'new write waits behind Clear');
    removal.release();
    await clear;
    await flush();
    equal(page.data[CACHE_KEY][1001].status, 'no_camera');
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
    deepEqual(page.operations, ['remove:start', 'remove:end', 'set:start', 'set:end']);
  }],
  ['F05 another Clear invalidates a write queued behind removal', async () => {
    const page = await createPage();
    const removal = page.holdNext('remove');
    const firstClear = page.message('STAYCAM_CLEAR');
    await removal.started;
    await page.start();
    await page.reply(0, { status: 'camera' });
    const secondClear = page.message('STAYCAM_CLEAR');
    removal.release();
    await Promise.all([firstClear, secondClear]);
    await flush();
    equal(page.writes.length, 0, 'queued stale write never starts');
    equal(page.data[CACHE_KEY], undefined);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal((await page.status()).running, false);
  }],
  ['F05 Clear before any request leaves cache empty until manual Scan', async () => {
    const page = await createPage({ cache: { 1001: { status: 'camera', checkedAt: Date.now(), classifierRevision: 2 } } });
    await page.message('STAYCAM_CLEAR');
    equal(page.data[CACHE_KEY], undefined);
    equal(page.requests.length, 0);
    page.addCard('1002');
    await page.tick();
    equal(page.requests.length, 0);
    await page.start();
    equal(page.requests.length, 1, 'old in-memory cache cannot survive Clear');
    await page.reply(0);
    await page.reply(1);
    equal((await page.status()).counts.checked, 2);
  }],
  ['F05 Clear invalidates a cache hit before its result applies', async () => {
    const page = await createPage({ cache: { 1001: { status: 'camera', checkedAt: Date.now(), classifierRevision: 2 } } });
    await Promise.all([page.message('STAYCAM_SCAN'), page.message('STAYCAM_CLEAR')]);
    await flush();
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.data[CACHE_KEY], undefined);
    equal(page.requests.length, 0);
    equal((await page.status()).running, false);
  }],
  ...[false, true].map((auto) => [`F05 Clear immediately before response, auto=${auto}`, async () => {
    const page = await createPage({ auto });
    await page.start();
    await Promise.all([page.message('STAYCAM_CLEAR'), page.reply(0, { status: 'camera' })]);
    equal(page.classifications, 0);
    equal(page.writes.length, 0);
    equal(page.cards[0].dataset.staycamStatus, undefined);
    equal(page.data[CACHE_KEY], undefined);
    equal(await page.settle(), true);
  }]),
  ['F05 old completion after a fresh completed scan stays invalid', async () => {
    const page = await createPage();
    await page.start();
    await page.message('STAYCAM_CLEAR');
    await page.start();
    const requestCount = page.requests.length;
    if (requestCount === 2) await page.reply(1, { status: 'no_camera' });
    await page.reply(0, { status: 'camera' });
    equal(requestCount, 2);
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
    equal(page.data[CACHE_KEY][1001].status, 'no_camera');
    equal((await page.status()).counts.noCameras, 1);
    equal((await page.status()).counts.cameras, 0);
    equal(page.classifications, 1);
  }],
  ['F05 repeated Scan/Clear cycles do not leave stale state', async () => {
    const page = await createPage();
    for (let i = 0; i < 3; i += 1) {
      await page.start();
      await page.message('STAYCAM_CLEAR');
      await page.reply(i, { status: 'camera' });
      equal(page.cards[0].dataset.staycamStatus, undefined);
      equal(page.data[CACHE_KEY], undefined);
      equal((await page.status()).running, false);
    }
    await page.start();
    await page.reply(3);
    equal(page.cards[0].dataset.staycamStatus, 'not_listed');
    equal(page.requests.length, 4);
    equal(page.writes.length, 1);
  }],
  ['F06 Stop finishes current listing and ignores later mutations', async () => {
    const page = await createPage({ ids: ['1001', '1002'] });
    await page.start();
    await page.message('STAYCAM_STOP');
    page.addCard('1003');
    await page.tick();
    equal(page.requests.length, 1);
    await page.reply(0, { status: 'camera' });
    equal(page.cards[0].dataset.staycamStatus, 'camera', 'finish-current behavior retained');
    equal(page.data[CACHE_KEY][1001].status, 'camera');
    equal((await page.status()).running, false);
    page.addCard('1004');
    await page.tick();
    equal(page.requests.length, 1, 'observer cannot restart stopped work');
    equal(page.panel.querySelector('.staycam-status').textContent, 'Scan stopped.');
    equal(page.data[SETTINGS_KEY].autoScanNewResults, true, 'stored preference is unchanged');
    equal(await page.settle(), true);
  }],
  ['F06 explicit manual restart re-enables automatic scanning', async () => {
    const page = await createPage();
    await page.start();
    await page.message('STAYCAM_STOP');
    await page.reply(0);
    page.addCard('1002');
    await page.tick();
    const stoppedRequests = page.requests.length;
    await page.start();
    equal(stoppedRequests, 1);
    equal(page.requests.length, 2);
    await page.reply(1);
    page.addCard('1003');
    await page.tick();
    equal(page.requests.length, 3);
    await page.reply(2);
    equal(await page.settle(), true);
  }],
  ['F06 toggling auto-scan alone does not resume Stop', async () => {
    const page = await createPage();
    await page.start();
    await page.reply(0);
    await page.message('STAYCAM_STOP');
    await page.message('STAYCAM_SET_SETTINGS', { settings: { autoScanNewResults: false } });
    await page.message('STAYCAM_SET_SETTINGS', { settings: { autoScanNewResults: true } });
    page.addCard('1002');
    await page.tick();
    equal(page.requests.length, 1);
    equal((await page.status()).counts.discovered, 2);
    equal(await page.settle(), true);
  }],
  ['F06 stopped queued and newly loaded cards wait even when cached', async () => {
    const page = await createPage({ ids: ['1001', '1002'], cache: {
      1002: { status: 'camera', checkedAt: Date.now(), classifierRevision: 2 },
      1003: { status: 'not_listed', checkedAt: Date.now(), classifierRevision: 2 }
    } });
    await page.start();
    await page.message('STAYCAM_STOP');
    const added = page.addCard('1003');
    await page.tick();
    equal(page.cards[1].dataset.staycamStatus, undefined, 'remaining cached card stays paused');
    equal(added.dataset.staycamStatus, undefined, 'new cached card stays paused');
    await page.reply(0, { status: 'no_camera' });
    equal(page.requests.length, 1);
    await page.start();
    equal(page.cards[1].dataset.staycamStatus, 'camera');
    equal(added.dataset.staycamStatus, 'not_listed');
    equal(page.requests.length, 1, 'deliberate restart still reuses valid cache');
    equal((await page.status()).counts.checked, 3);
  }],
  ['F06 Stop during a later request preserves both completed results', async () => {
    const page = await createPage({ ids: ['1001', '1002', '1003'] });
    await page.start();
    await page.reply(0, { status: 'no_camera' });
    await page.message('STAYCAM_STOP');
    await page.reply(1, { status: 'not_listed' });
    equal(page.requests.length, 2);
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
    equal(page.cards[1].dataset.staycamStatus, 'not_listed');
    equal(page.cards[2].dataset.staycamStatus, undefined);
    equal((await page.status()).counts.checked, 2);
    equal((await page.status()).running, false);
  }],
  ['F06 repeated Stop and idle Stop with auto disabled are safe', async () => {
    const page = await createPage({ ids: ['1001', '1002'], auto: false });
    await page.message('STAYCAM_STOP');
    equal(page.requests.length, 0);
    equal(page.panel.querySelector('.staycam-status').textContent, 'Scan stopped.');
    await page.start();
    await page.message('STAYCAM_STOP');
    await page.message('STAYCAM_STOP');
    await page.reply(0, { status: 'unverified', reason: 'Synthetic incomplete response' });
    equal(page.requests.length, 1);
    equal(page.cards[0].dataset.staycamStatus, 'unverified');
    equal(page.writes.length, 0);
    await page.message('STAYCAM_STOP');
    page.addCard('1003');
    await page.tick();
    equal(page.requests.length, 1);
    equal((await page.status()).running, false);
  }],
  ['F04/F05/F06 Stop, Clear, restart, then Stop isolates generations', async () => {
    const page = await createPage({ ids: ['1001', '1002'] });
    await page.start();
    await page.message('STAYCAM_STOP');
    await page.message('STAYCAM_CLEAR');
    await page.start();
    const requestCount = page.requests.length;
    await page.message('STAYCAM_STOP');
    await page.reply(0, { status: 'camera' });
    if (requestCount === 2) await page.reply(1, { status: 'no_camera' });
    page.addCard('1003');
    await page.tick();
    equal(requestCount, 2);
    equal(page.requests.length, 2);
    equal(page.cards[0].dataset.staycamStatus, 'no_camera');
    equal(page.data[CACHE_KEY][1001].status, 'no_camera');
    equal(page.cards[1].dataset.staycamStatus, undefined);
    equal((await page.status()).running, false);
    equal(page.panel.querySelector('.staycam-status').textContent, 'Scan stopped.');
    equal(await page.settle(), true);
  }],
  ['F04/F06 rapid repeated Scan and mutations do not start concurrent scans', async () => {
    const page = await createPage({ ids: ['1001', '1002'] });
    await Promise.all([page.start(), page.start(), page.start()]);
    page.addCard('1001');
    await page.tick();
    equal(page.requests.length, 1);
    await page.message('STAYCAM_STOP');
    await page.message('STAYCAM_STOP');
    await page.reply(0);
    page.addCard('1003');
    await page.tick();
    equal(page.requests.length, 1);
    equal((await page.status()).running, false);
    equal(await page.settle(), true);
  }]
];

async function run() {
  const failures = [];
  for (const [name, test] of cases) {
    try { await test(); } catch (error) { failures.push(`${name}: ${error.message}`); }
  }
  if (failures.length) {
    console.error(failures.join('\n\n'));
    process.exitCode = 1;
  } else {
    console.log(`All content lifecycle tests passed (${cases.length} scenarios, ${assertions} assertions).`);
  }
}
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
