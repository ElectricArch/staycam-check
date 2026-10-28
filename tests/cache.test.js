"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const contentSource = fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8');
const CACHE_KEY = 'staycam:cache:v3';
const SETTINGS_KEY = 'staycam:settings:v3';
const TTL = 7 * 24 * 60 * 60 * 1000;
const NOW = 1800000000000;
const SETTINGS = { hideConfirmed: false, autoScanNewResults: true, retainedOption: 'keep' };
let scenarios = 0;
let assertions = 0;

function equal(...args) { assert.equal(...args); assertions += 1; }
function deepEqual(...args) { assert.deepEqual(...args); assertions += 1; }

function storageWith(cache) {
  return {
    data: { [CACHE_KEY]: structuredClone(cache), [SETTINGS_KEY]: structuredClone(SETTINGS), unrelated: { keep: true } },
    writes: [],
    removals: []
  };
}

// Run the actual content script through its messages; only Chrome, DOM and fetch results are mocked.
// This fixed synthetic card is a cache fixture, not a model of Airbnb's homepage or live DOM.
async function openPage(storage, result = { status: 'not_listed' }) {
  const clock = { now: NOW };
  const requests = [];
  let classifications = 0;
  let onMessage;
  class Element {
    constructor() {
      this.dataset = {};
      this.isConnected = true;
      this.children = [];
      this.controls = new Map();
      this.style = { removeProperty() {} };
      this.classList = { add() {}, remove() {} };
    }
    addEventListener() {}
    appendChild(child) { this.children.push(child); child.parentElement = this; }
    remove() { this.parentElement.children = this.parentElement.children.filter((child) => child !== this); }
    querySelector(selector) {
      if (selector === ':scope > .staycam-card-badge') {
        return this.children.find((child) => child.className?.startsWith('staycam-card-badge')) || null;
      }
      if (!this.controls.has(selector)) this.controls.set(selector, new Element());
      return this.controls.get(selector);
    }
  }
  const card = new Element();
  class Anchor extends Element {
    constructor() { super(); this.href = 'https://www.airbnb.com/rooms/1001'; }
    closest() { return card; }
  }
  const anchor = new Anchor();
  card.querySelectorAll = () => [anchor];
  const context = {
    window: { addEventListener() {} },
    location: { origin: 'https://www.airbnb.com' },
    URL,
    HTMLElement: Element,
    HTMLAnchorElement: Anchor,
    Date: class extends Date { static now() { return clock.now; } },
    getComputedStyle: () => ({ position: 'relative' }),
    MutationObserver: class { observe() {} },
    document: {
      body: new Element(),
      createElement: () => new Element(),
      querySelectorAll: (selector) => selector === 'a[href*="/rooms/"]' ? [anchor] : [card]
    },
    StayCamClassifier: {
      inspectListingHtml() { classifications += 1; return structuredClone(result); }
    },
    chrome: {
      storage: { local: {
        async get(key) { return { [key]: structuredClone(storage.data[key]) }; },
        async set(values) { storage.writes.push(structuredClone(values)); Object.assign(storage.data, structuredClone(values)); },
        async remove(key) { storage.removals.push(key); delete storage.data[key]; }
      } },
      runtime: {
        onMessage: { addListener(listener) { onMessage = listener; } },
        sendMessage(message, callback) { requests.push(message); callback({ ok: true, html: 'synthetic response' }); }
      }
    }
  };
  await vm.runInNewContext(contentSource, context, { filename: 'src/content.js' });
  function status() {
    let response;
    onMessage({ type: 'STAYCAM_GET_STATUS' }, {}, (value) => { response = value; });
    return structuredClone(response);
  }
  return {
    clock, requests, status,
    get classifications() { return classifications; },
    async scan() {
      onMessage({ type: 'STAYCAM_SCAN' }, {}, () => {});
      await new Promise(setImmediate);
      if (status().state.running) throw new Error('Synthetic scan did not finish.');
      return card.dataset.staycamStatus;
    }
  };
}

function assertUntouchedSettings(storage, page) {
  deepEqual(storage.data[SETTINGS_KEY], SETTINGS);
  deepEqual(page.status().settings, SETTINGS);
  deepEqual(storage.data.unrelated, { keep: true });
  equal(storage.removals.length, 0);
  equal(storage.writes.every((write) => Object.keys(write).length === 1 && CACHE_KEY in write), true);
}

async function run() {
  const entry = (status, extra = {}) => ({ status, checkedAt: NOW - 1000, ...extra });
  const statuses = ['camera', 'no_camera', 'not_listed'];
  const revisions = [
    ['legacy', {}, 1],
    ['revision zero', { classifierRevision: 0 }, 1],
    ['revision one', { classifierRevision: 1 }, 1],
    ['current revision', { classifierRevision: 2 }, 0],
    ['future revision', { classifierRevision: 3 }, 1],
    ['string revision', { classifierRevision: '2' }, 1],
    ['object revision', { classifierRevision: { value: 2 } }, 1]
  ];
  const cases = statuses.flatMap((status) => revisions.map(([name, revision, fetches]) => [
    `${name} ${status}`, entry(status, revision), fetches, status
  ]));
  cases.push(...statuses.map((status) => [
    `expired current ${status}`, entry(status, { classifierRevision: 2, checkedAt: NOW - TTL }), 1, status
  ]));
  cases.push(['missing timestamp', { status: 'camera', classifierRevision: 2 }, 1, 'camera']);
  for (const [name, cached, fetches, expectedStatus] of cases) {
    const storage = storageWith({ 1001: cached });
    const page = await openPage(storage, { status: expectedStatus });
    equal(page.requests.length, 0, `${name}: no startup fetch`);
    equal(storage.writes.length, 0, `${name}: no startup write`);
    equal(await page.scan(), expectedStatus, name);
    equal(page.requests.length, fetches, `${name}: cache reuse`);
    equal(page.classifications, fetches, `${name}: reclassification`);
    equal(storage.writes.length, fetches, `${name}: writes`);
    if (fetches) {
      equal(storage.data[CACHE_KEY][1001].classifierRevision, 2, `${name}: new revision`);
      equal(storage.data[CACHE_KEY][1001].checkedAt, NOW, `${name}: new timestamp`);
    } else {
      deepEqual(storage.data[CACHE_KEY][1001], cached, `${name}: preserved entry`);
    }
    assertUntouchedSettings(storage, page);
    scenarios += 1;
  }

  for (const status of statuses) {
    const storage = storageWith({ 1001: entry(status, { classifierRevision: 1 }) });
    let page = await openPage(storage, { status });
    equal(await page.scan(), status);
    equal(await page.scan(), status);
    equal(page.requests.length, 1, `${status}: fresh result reused in the same page`);
    page = await openPage(storage, { status });
    equal(await page.scan(), status);
    equal(page.requests.length, 0, `${status}: fresh result reused after reload`);
    equal(storage.writes.length, 1, `${status}: no repeated compatibility writes`);
    assertUntouchedSettings(storage, page);
    scenarios += 1;
  }

  const boundaryStorage = storageWith({ 1001: entry('not_listed', { classifierRevision: 2, checkedAt: NOW - TTL + 1 }) });
  const boundaryPage = await openPage(boundaryStorage);
  equal(await boundaryPage.scan(), 'not_listed');
  equal(boundaryPage.requests.length, 0, 'reused just before expiry');
  boundaryPage.clock.now += 1;
  equal(await boundaryPage.scan(), 'not_listed');
  equal(boundaryPage.requests.length, 1, 'expired in memory at seven days');
  equal(boundaryStorage.data[CACHE_KEY][1001].checkedAt, NOW + 1);
  assertUntouchedSettings(boundaryStorage, boundaryPage);
  scenarios += 1;

  const failedStorage = storageWith({ 1001: entry('camera', { classifierRevision: 1 }) });
  let failedPage = await openPage(failedStorage, { status: 'unverified', reason: 'Synthetic incomplete response' });
  equal(await failedPage.scan(), 'unverified');
  equal(failedPage.requests.length, 1);
  equal(failedStorage.writes.length, 0, 'unverified result not persisted');
  failedPage = await openPage(failedStorage, { status: 'unverified' });
  equal(await failedPage.scan(), 'unverified');
  equal(failedPage.requests.length, 1, 'legacy result still rejected after reload');
  assertUntouchedSettings(failedStorage, failedPage);
  scenarios += 1;

  const fullCache = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [
    String(2000 + index), entry('camera', { classifierRevision: 2, checkedAt: NOW - index - 1 })
  ]));
  const fullStorage = storageWith(fullCache);
  const fullPage = await openPage(fullStorage);
  equal(await fullPage.scan(), 'not_listed');
  equal(Object.keys(fullStorage.data[CACHE_KEY]).length, 500, '500-entry limit retained');
  equal(fullStorage.data[CACHE_KEY][1001].classifierRevision, 2, 'new result retained');
  equal(fullStorage.data[CACHE_KEY][2499], undefined, 'oldest entry evicted');
  deepEqual(fullStorage.data[CACHE_KEY][2000], fullCache[2000], 'existing camera retained');
  assertUntouchedSettings(fullStorage, fullPage);
  scenarios += 1;

  console.log(`All cache tests passed (${scenarios} scenarios, ${assertions} assertions).`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
