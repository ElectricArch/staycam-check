'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8');
let assertions = 0;
function equal(...args) { assert.equal(...args); assertions += 1; }

async function openPopup() {
  const elements = new Map();
  const failures = new Map();
  const calls = [];
  let closes = 0;
  const settings = { hideConfirmed: true, autoScanNewResults: false };
  const status = { ok: true, state: { running: false, counts: { discovered: 1, checked: 0, cameras: 0, noCameras: 0, notListed: 0, unverified: 0 } }, settings };
  const context = {
    document: { querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } });
      return elements.get(selector);
    } },
    window: { close() { closes += 1; } },
    chrome: {
      runtime: {},
      tabs: {
        query: async () => [{ id: 1, url: 'https://www.airbnb.com/s/Test/homes' }],
        sendMessage(tabId, message, callback) {
          calls.push(message.type);
          if (failures.has(message.type)) { const response = failures.get(message.type); failures.delete(message.type); callback(response); return; }
          if (message.type === 'STAYCAM_GET_STATUS') callback(structuredClone(status));
          else { if (message.type === 'STAYCAM_SET_SETTINGS') Object.assign(settings, message.settings); callback({ ok: true, settings }); }
        }
      }
    }
  };
  await vm.runInNewContext(source, context, { filename: 'popup/popup.js' });
  return { elements, settings, status, calls, fail(type, response = { ok: false, error: 'Synthetic action failed' }) { failures.set(type, response); }, get closes() { return closes; } };
}

const cases = [
  ['settings failure is shown and controls recover persisted values', async () => {
    const popup = await openPopup();
    popup.fail('STAYCAM_SET_SETTINGS');
    const checkbox = popup.elements.get('#hide-confirmed');
    checkbox.checked = false;
    await checkbox.listeners.change();
    equal(checkbox.checked, true);
    equal(popup.settings.hideConfirmed, true);
    equal(popup.elements.get('#page-status').textContent, 'Synthetic action failed');
    checkbox.checked = false;
    await checkbox.listeners.change();
    equal(popup.settings.hideConfirmed, false);
    equal(popup.elements.get('#page-status').textContent, 'Ready on the current Airbnb tab.');
  }],
  ['Clear failure is shown and a deliberate retry works', async () => {
    const popup = await openPopup();
    popup.fail('STAYCAM_CLEAR');
    await popup.elements.get('#clear').listeners.click();
    equal(popup.elements.get('#page-status').textContent, 'Synthetic action failed');
    equal(popup.closes, 0);
    await popup.elements.get('#clear').listeners.click();
    equal(popup.calls.filter((type) => type === 'STAYCAM_CLEAR').length, 2);
    equal(popup.elements.get('#page-status').textContent, 'Ready on the current Airbnb tab.');
  }],
  ['Scan failure does not close the popup as if successful', async () => {
    const popup = await openPopup();
    popup.fail('STAYCAM_SCAN');
    await popup.elements.get('#scan').listeners.click();
    equal(popup.closes, 0);
    equal(popup.elements.get('#page-status').textContent, 'Synthetic action failed');
  }],
  ['missing action response is treated as failure', async () => {
    const popup = await openPopup();
    popup.fail('STAYCAM_CLEAR', null);
    await popup.elements.get('#clear').listeners.click();
    equal(popup.elements.get('#page-status').textContent, 'The extension could not complete this action.');
  }],
  ['status exposes degraded persistence without changing classification UI', async () => {
    const popup = await openPopup();
    popup.status.error = 'Results are temporary.';
    await popup.elements.get('#clear').listeners.click();
    equal(popup.elements.get('#page-status').textContent, 'Results are temporary.');
    equal(popup.elements.get('#scan').textContent, 'Scan current results');
  }],
  ['normal Scan and Stop preserve their existing message flow', async () => {
    const popup = await openPopup();
    await popup.elements.get('#scan').listeners.click();
    equal(popup.closes, 1);
    equal(popup.calls.includes('STAYCAM_SCAN'), true);
    popup.status.state.running = true;
    await popup.elements.get('#scan').listeners.click();
    equal(popup.calls.includes('STAYCAM_STOP'), true);
    equal(popup.closes, 2);
  }]
];

(async () => {
  for (const [name, test] of cases) {
    try { await test(); } catch (error) { throw new Error(`${name}: ${error.message}`); }
  }
  console.log(`All popup recovery tests passed (${cases.length} scenarios, ${assertions} assertions).`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
