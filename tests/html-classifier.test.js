"use strict";

const assert = require('node:assert/strict');
const classifier = require('../src/classifier.js');

// Synthetic examples of the already supported listing wrapper, not captured Airbnb schemas.
// IDs are opaque fixture entity identifiers, not a claimed production room-ID format.
function listing(amenities, id = 'listing-a') {
  return { data: { node: {
    ...(id === null ? {} : { id }),
    pdpPresentation: { amenities: { seeAllAmenitiesGroups: [{ title: 'Safety', amenities }] } }
  } } };
}

const camera = { title: 'Exterior security cameras on property', available: true };
const unavailable = { ...camera, available: false };
const wifi = { title: 'Wifi', available: true };
const present = listing([camera]);
const absent = listing([unavailable]);
const notListed = listing([wifi]);
const primary = (data) => ({ id: 'data-deferred-state-0', data });
const extra = (data) => ({ id: 'data-supplement', data });
const cases = [
  ['available then unavailable', [primary(present), extra(absent)], 'unverified'],
  ['unavailable then available', [primary(absent), extra(present)], 'unverified'],
  ['not-listed then available', [primary(notListed), extra(present)], 'unverified'],
  ['available then not-listed', [primary(present), extra(notListed)], 'unverified'],
  ['not-listed then unavailable', [primary(notListed), extra(absent)], 'unverified'],
  ['unavailable then not-listed', [primary(absent), extra(notListed)], 'unverified'],
  ['matching available', [primary(present), extra(present)], 'camera'],
  ['matching unavailable', [primary(absent), extra(absent)], 'no_camera'],
  ['matching not-listed', [primary(notListed), extra(notListed)], 'not_listed'],
  ['malformed then valid', [{ id: 'data-deferred-state-0', text: '{' }, extra(present)], 'camera'],
  ['valid then malformed', [primary(absent), { id: 'data-broken', text: '{' }], 'no_camera'],
  ['irrelevant JSON then listing', [extra({ configuration: { theme: 'light' } }), extra(absent)], 'no_camera'],
  ['recommendations do not override listing', [primary(absent), extra({ recommendations: [listing([camera], 'listing-b')] })], 'no_camera'],
  ['unscoped generic record excluded beside listing payload', [extra({ amenities: [camera] }), extra(notListed)], 'not_listed'],
  ['other listing does not conflict with unavailable', [primary(absent), extra(listing([camera], 'listing-b'))], 'no_camera'],
  ['other listing does not conflict with available', [primary(present), extra(listing([unavailable], 'listing-b'))], 'camera'],
  ['DOM order does not select a foreign listing', [extra(listing([camera], 'listing-b')), primary(absent)], 'no_camera'],
  ['incomplete primary excludes a foreign listing', [primary(listing([])), extra(listing([camera], 'listing-b'))], 'unverified'],
  ['incomplete primary allows matching listing evidence', [primary(listing([])), extra(present)], 'camera'],
  ['no primary and different identifiers', [extra(present), extra(listing([camera], 'listing-b'))], 'unverified'],
  ['reversed different identifiers without primary', [extra(listing([camera], 'listing-b')), extra(present)], 'unverified'],
  ['no identifiers with conflicting evidence', [primary(listing([camera], null)), extra(listing([unavailable], null))], 'unverified'],
  ['no identifiers with matching evidence', [primary(listing([camera], null)), extra(listing([camera], null))], 'camera'],
  ['unscoped generic conflict cannot establish a listing', [extra({ amenities: [camera] }), extra({ amenities: [unavailable] })], 'unverified'],
  ['unscoped generic duplicates cannot establish a listing', [extra({ amenities: [camera] }), extra({ amenities: [camera] })], 'unverified'],
  ['within-object conflict remains unverified', [primary(listing([camera, unavailable])), extra(present)], 'unverified'],
  ['single available', [primary(present)], 'camera'],
  ['single unavailable', [primary(absent)], 'no_camera'],
  ['single complete not-listed', [primary(notListed)], 'not_listed'],
  ['single partial preview', [primary({ amenities: [wifi] })], 'unverified'],
  ['single empty inventory', [primary(listing([]))], 'unverified'],
  ['single generic available retains fallback', [extra({ amenities: [camera] })], 'camera'],
  ['single generic unavailable retains fallback', [extra({ amenities: [unavailable] })], 'no_camera'],
  ['missing structured inventory', [primary({ data: { title: 'Synthetic listing' } })], 'unverified'],
  ['only malformed data', [{ id: 'data-deferred-state-0', text: '{' }], 'unverified'],
  ['no structured scripts', [], 'unverified'],
  ['duplicate selector matches use the same script once', [primary(absent)], 'no_camera'],
  ['non-JSON data script is inspected', [{ id: 'listing-state', type: 'text/plain', data: present }], 'camera']
].map(([name, scripts, expected]) => ({
  name, expected,
  scripts: scripts.map((script) => ({ ...script, type: script.type || 'application/json', textContent: script.text ?? JSON.stringify(script.data) }))
}));

for (const test of cases) {
  test.html = '<!doctype html><html><body><a href="/rooms/1001">Synthetic listing</a>' +
    test.scripts.map((script) => `<script id="${script.id}" type="${script.type}">${script.textContent}</script>`).join('') +
    '</body></html>';
}

function run() {
  // Node has no DOMParser. Supply only the selector interface for these exact fixtures.
  // Production JSON parsing/reconciliation runs unchanged; Chrome separately parses the same HTML.
  const documents = new Map(cases.map((test) => [test.html, {
    querySelector: () => test.scripts.find((script) => script.id === 'data-deferred-state-0') || null,
    querySelectorAll: (selector) => selector === 'script[type="application/json"]'
      ? test.scripts.filter((script) => script.type === 'application/json')
      : test.scripts.filter((script) => /data|state/i.test(script.id))
  }]));
  const previousDOMParser = global.DOMParser;
  global.DOMParser = class {
    parseFromString(html) {
      const document = documents.get(html);
      if (!document) throw new Error('Unexpected HTML outside the synthetic fixture set.');
      return document;
    }
  };
  try {
    for (const test of cases) {
      assert.equal(classifier.inspectListingHtml(test.html).status, test.expected, test.name);
    }
  } finally {
    if (previousDOMParser === undefined) delete global.DOMParser;
    else global.DOMParser = previousDOMParser;
  }
  console.log(`All HTML classifier tests passed (${cases.length} scenarios, ${cases.length} assertions).`);
}

module.exports = { cases };
if (require.main === module) run();
