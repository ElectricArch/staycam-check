"use strict";

const pageStatus = document.querySelector('#page-status');
const counts = document.querySelector('#counts');
const scanButton = document.querySelector('#scan');
const clearButton = document.querySelector('#clear');
const hideCheckbox = document.querySelector('#hide-confirmed');
const autoCheckbox = document.querySelector('#auto-scan');
let activeTabId = null;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(activeTabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || 'The extension could not complete this action.'));
      else resolve(response);
    });
  });
}

function displayStatus(response) {
  const current = response?.state;
  if (!current) return;
  const c = current.counts;
  counts.textContent = `${c.discovered} found | ${c.checked} checked | ${c.cameras} cameras | ` +
    `${c.noCameras} crossed out | ${c.notListed} not listed | ${c.unverified} unverified`;
  scanButton.textContent = current.running ? 'Stop scan' : 'Scan current results';
  hideCheckbox.checked = Boolean(response.settings?.hideConfirmed);
  autoCheckbox.checked = Boolean(response.settings?.autoScanNewResults);
  pageStatus.textContent = response.error || 'Ready on the current Airbnb tab.';
}

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  const isSupported = /^https:\/\/(www\.)?airbnb\.com\//.test(tab?.url || '');
  if (!activeTabId || !isSupported) {
    pageStatus.textContent = 'Open an Airbnb search-results page to use this extension.';
    scanButton.disabled = true;
    clearButton.disabled = true;
    hideCheckbox.disabled = true;
    autoCheckbox.disabled = true;
    return;
  }
  pageStatus.textContent = 'Ready on the current Airbnb tab.';
  try { displayStatus(await send({ type: 'STAYCAM_GET_STATUS' })); }
  catch { pageStatus.textContent = 'Refresh the Airbnb tab, then reopen this popup.'; }
}

scanButton.addEventListener('click', async () => {
  try {
    const status = await send({ type: 'STAYCAM_GET_STATUS' });
    await send({ type: status?.state?.running ? 'STAYCAM_STOP' : 'STAYCAM_SCAN' });
    window.close();
  } catch (error) { pageStatus.textContent = error.message; }
});

clearButton.addEventListener('click', async () => {
  try {
    await send({ type: 'STAYCAM_CLEAR' });
    displayStatus(await send({ type: 'STAYCAM_GET_STATUS' }));
  } catch (error) { pageStatus.textContent = error.message; }
});

async function updateSettings() {
  try {
    const response = await send({
      type: 'STAYCAM_SET_SETTINGS',
      settings: { hideConfirmed: hideCheckbox.checked, autoScanNewResults: autoCheckbox.checked }
    });
    hideCheckbox.checked = Boolean(response.settings?.hideConfirmed);
    autoCheckbox.checked = Boolean(response.settings?.autoScanNewResults);
    pageStatus.textContent = 'Ready on the current Airbnb tab.';
  } catch (error) {
    try { displayStatus(await send({ type: 'STAYCAM_GET_STATUS' })); } catch { /* Keep the original action error. */ }
    pageStatus.textContent = error.message;
  }
}

hideCheckbox.addEventListener('change', updateSettings);
autoCheckbox.addEventListener('change', updateSettings);
initialize();
