"use strict";

const REQUEST_DELAY_MS = 900;
// One budget covers headers and body. This bounds the logical queue even if abort is ignored.
const REQUEST_TIMEOUT_MS = 20000;
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function validateListingUrl(rawUrl) {
  const url = new URL(rawUrl);
  const allowedHost = url.hostname === 'www.airbnb.com' || url.hostname === 'airbnb.com';
  const validPath = /^\/rooms\/\d+\/?$/.test(url.pathname);
  if (!allowedHost || !validPath || url.protocol !== 'https:') {
    throw new Error('Blocked an invalid listing URL.');
  }
  url.hostname = 'www.airbnb.com';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function fetchListingHtml(rawUrl) {
  const url = validateListingUrl(rawUrl);
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < REQUEST_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS - elapsed));
  }
  lastRequestAt = Date.now();

  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('The listing request timed out.'));
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
  });
  const operation = (async () => {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (controller.signal.aborted) throw new Error('The listing request timed out.');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (!html) throw new Error('The listing returned an empty response.');
    return html;
  })();
  try {
    // Both branches stay observed after settlement, including late rejection after timeout.
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

function enqueueListingFetch(url) {
  const operation = requestQueue.then(() => fetchListingHtml(url));
  requestQueue = operation.catch(() => undefined);
  return operation;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'STAYCAM_FETCH_LISTING') return undefined;

  enqueueListingFetch(message.url)
    .then((html) => sendResponse({ ok: true, html }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    .catch(() => undefined); // A closed response channel cannot cause a second reply.
  return true;
});
