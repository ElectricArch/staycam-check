'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/background.js'), 'utf8');
const flush = () => new Promise(setImmediate);
const URL_A = 'https://www.airbnb.com/rooms/1001';
const URL_B = 'https://www.airbnb.com/rooms/1002';
let assertions = 0;
function equal(...args) { assert.equal(...args); assertions += 1; }
function matches(...args) { assert.match(...args); assertions += 1; }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Execute the actual worker with a virtual clock and controlled fetch/body promises.
function createWorker(fetchImpl = async () => ({ ok: true, text: async () => 'listing' })) {
  let now = 1000000;
  let nextTimer = 0;
  let listener;
  const timers = new Map();
  const starts = [];
  const context = {
    URL, AbortController,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) { starts.push({ url, options, at: now }); return fetchImpl(url, options); },
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } }
  };
  vm.runInNewContext(source, context, { filename: 'src/background.js' });
  return {
    starts, timers,
    dispatch(message, callback) { return listener(message, {}, callback); },
    request(url = URL_A) {
      const replies = [];
      listener({ type: 'STAYCAM_FETCH_LISTING', url }, {}, (reply) => replies.push(reply));
      return replies;
    },
    async advance(ms) {
      const target = now + ms;
      await flush();
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = target;
      await flush();
    }
  };
}

const cases = [
  ['body success just before the overall deadline remains successful', async () => {
    const body = deferred();
    const worker = createWorker(async () => ({ ok: true, text: () => body.promise }));
    const replies = worker.request();
    await worker.advance(19999);
    equal(replies.length, 0);
    body.resolve('on time');
    await flush();
    await worker.advance(1);
    equal(replies[0]?.html, 'on time');
    equal(replies.length, 1);
    equal(worker.starts[0].options.signal.aborted, false);
    equal(worker.timers.size, 0);
  }],
  ['synchronous fetch exception also cleans its timer', async () => {
    const worker = createWorker(() => { throw new Error('synchronous fetch failure'); });
    const replies = worker.request();
    await flush();
    equal(replies[0]?.ok, false);
    matches(replies[0].error, /synchronous fetch failure/);
    equal(worker.timers.size, 0);
  }],
  ['successful response preserves request options and cleans deadline', async () => {
    const worker = createWorker();
    const replies = worker.request('https://airbnb.com/rooms/1001?private=omitted#photos');
    await flush();
    equal(replies[0]?.ok, true);
    equal(replies[0]?.html, 'listing');
    equal(worker.starts[0].url, URL_A);
    equal(worker.starts[0].options.credentials, 'include');
    equal(worker.starts[0].options.redirect, 'follow');
    equal(worker.starts[0].options.method, 'GET');
    equal(worker.starts[0].options.signal instanceof AbortSignal, true);
    equal(worker.starts[0].options.signal.aborted, false);
    equal(worker.timers.size, 0);
  }],
  ['never-settling fetch times out logically even when abort is ignored', async () => {
    const worker = createWorker(() => new Promise(() => {}));
    const replies = worker.request();
    await worker.advance(19999);
    equal(replies.length, 0);
    await worker.advance(1);
    equal(replies.length, 1);
    equal(replies[0].ok, false);
    matches(replies[0].error, /timed out/i);
    equal(worker.starts[0].options.signal.aborted, true);
    equal(worker.timers.size, 0);
  }],
  ['fetch rejection cleans timer and permits the next request', async () => {
    let count = 0;
    const worker = createWorker(async () => { if (!count++) throw new Error('synthetic fetch failure'); return { ok: true, text: async () => 'next' }; });
    const first = worker.request();
    const second = worker.request(URL_B);
    await worker.advance(900);
    equal(first[0]?.ok, false);
    matches(first[0].error, /synthetic fetch failure/);
    equal(second[0]?.html, 'next');
    equal(worker.timers.size, 0);
    equal(worker.starts[1].at - worker.starts[0].at, 900);
  }],
  ['body shares the original deadline after delayed headers', async () => {
    const headers = deferred();
    const worker = createWorker(() => headers.promise);
    const replies = worker.request();
    await worker.advance(12000);
    headers.resolve({ ok: true, text: () => new Promise(() => {}) });
    await worker.advance(7999);
    equal(replies.length, 0);
    await worker.advance(1);
    equal(replies[0]?.ok, false);
    matches(replies[0].error, /timed out/i);
    equal(worker.starts[0].options.signal.aborted, true);
    equal(worker.timers.size, 0);
  }],
  ['body rejection cleans timer', async () => {
    const worker = createWorker(async () => ({ ok: true, text: async () => { throw new Error('synthetic body failure'); } }));
    const replies = worker.request();
    await flush();
    equal(replies[0]?.ok, false);
    matches(replies[0].error, /synthetic body failure/);
    equal(worker.timers.size, 0);
  }],
  ...['fetch', 'body'].flatMap((stage) => ['resolve', 'reject'].map((settlement) => [`late ${stage} ${settlement} cannot replace timeout or reply twice`, async () => {
    const late = deferred();
    const worker = createWorker(() => stage === 'fetch' ? late.promise : Promise.resolve({ ok: true, text: () => late.promise }));
    const replies = worker.request();
    await worker.advance(20000);
    equal(replies[0]?.ok, false);
    matches(replies[0].error, /timed out/i);
    if (settlement === 'resolve') late.resolve(stage === 'fetch' ? { ok: true, text: async () => 'late' } : 'late');
    else late.reject(new Error('late synthetic rejection'));
    await flush();
    equal(replies.length, 1);
    equal(worker.timers.size, 0);
  }])) ,
  ['timeout releases multiple queued requests with minimum start spacing', async () => {
    let count = 0;
    const worker = createWorker(() => count++ === 0 ? new Promise(() => {}) : Promise.resolve({ ok: true, text: async () => 'next' }));
    const first = worker.request();
    const second = worker.request(URL_B);
    const third = worker.request('https://www.airbnb.com/rooms/1003');
    await worker.advance(19999);
    equal(worker.starts.length, 1);
    await worker.advance(1);
    equal(first[0]?.ok, false);
    equal(second[0]?.html, 'next');
    equal(worker.starts.length, 2);
    equal(third.length, 0);
    await worker.advance(899);
    equal(worker.starts.length, 2);
    await worker.advance(1);
    equal(third[0]?.html, 'next');
    equal(worker.starts[2].at - worker.starts[1].at, 900);
    equal(worker.timers.size, 0);
  }],
  ['pending body keeps logical serialization until completion', async () => {
    const body = deferred();
    let count = 0;
    const worker = createWorker(async () => ({ ok: true, text: () => count++ === 0 ? body.promise : Promise.resolve('second') }));
    const first = worker.request();
    const second = worker.request(URL_B);
    await worker.advance(1000);
    equal(worker.starts.length, 1);
    body.resolve('first');
    await flush();
    equal(first[0]?.html, 'first');
    equal(second[0]?.html, 'second');
    equal(worker.starts.length, 2);
    equal(worker.starts[1].at - worker.starts[0].at, 1000);
    equal(worker.timers.size, 0);
  }],
  ...[
    ['HTTP error', { ok: false, status: 503, text: async () => 'unused' }, /HTTP 503/],
    ['empty body', { ok: true, text: async () => '' }, /empty response/]
  ].map(([name, response, pattern]) => [name, async () => {
    const worker = createWorker(async () => response);
    const replies = worker.request();
    await flush();
    equal(replies[0]?.ok, false);
    matches(replies[0].error, pattern);
    equal(worker.timers.size, 0);
  }]),
  ...['https://other.invalid/rooms/1001', 'http://www.airbnb.com/rooms/1001',
    'https://www.airbnb.com/rooms/1001/details', 'https://www.airbnb.com/rooms/no', 'not a URL'].map((url) => [`unsupported URL rejected: ${url}`, async () => {
    const worker = createWorker();
    const replies = worker.request(url);
    await flush();
    equal(replies[0]?.ok, false);
    equal(worker.starts.length, 0);
    equal(worker.timers.size, 0);
  }]),
  ['other message types remain ignored', async () => {
    const worker = createWorker();
    equal(worker.dispatch({ type: 'OTHER' }, () => { throw new Error('Unexpected response'); }), undefined);
    equal(worker.starts.length, 0);
    equal(worker.timers.size, 0);
  }]
];

async function run() {
  const failures = [];
  for (const [name, test] of cases) {
    try { await test(); } catch (error) { failures.push(`${name}: ${error.message}`); }
  }
  if (failures.length) { console.error(failures.join('\n\n')); process.exitCode = 1; }
  else console.log(`All background tests passed (${cases.length} scenarios, ${assertions} assertions).`);
}
module.exports = { createWorker };
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
