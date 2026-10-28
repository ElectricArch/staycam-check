"use strict";

const assert = require('node:assert/strict');
const classifier = require('../src/classifier.js');

function listingWith(amenities) {
  return {
    data: {
      node: {
        pdpPresentation: {
          amenities: {
            seeAllAmenitiesGroups: [{ title: 'Safety', amenities }]
          }
        }
      }
    }
  };
}

const present = classifier.classifyStructuredData(listingWith([
  { title: 'Smoke alarm', available: true },
  { title: 'Exterior security cameras on property', available: true }
]));
assert.equal(present.status, 'camera');

const crossedOut = classifier.classifyStructuredData(listingWith([
  { title: 'Exterior security cameras on property', available: false }
]));
assert.equal(crossedOut.status, 'no_camera');

const notListed = classifier.classifyStructuredData(listingWith([
  { title: 'Smoke alarm', available: true },
  { title: 'Carbon monoxide alarm', available: true }
]));
assert.equal(notListed.status, 'not_listed');

const conflicting = classifier.classifyStructuredData(listingWith([
  { title: 'Exterior security cameras on property', available: true },
  { title: 'Exterior security cameras on property', available: false }
]));
assert.equal(conflicting.status, 'unverified');

const missingInventory = classifier.classifyStructuredData({ data: { title: 'Ordinary listing data' } });
assert.equal(missingInventory, null);

// Synthetic fixtures exercise the existing supported shapes, not captured Airbnb responses.
const wifi = { title: 'Wifi', available: true };
const camera = { title: 'Exterior security cameras on property', available: true };
const unavailableCamera = { ...camera, available: false };
const completenessCases = [
  ['generic available preview', { amenities: [wifi] }, false, null],
  ['generic isAvailable preview', { amenities: [{ title: 'Wifi', isAvailable: true }] }, false, null],
  ['nested isPresent preview', { data: { amenities: [{ title: 'Wifi', isPresent: true }] } }, false, null],
  ['empty generic preview', { amenities: [] }, false, null],
  ['empty full-inventory groups', { seeAllAmenitiesGroups: [] }, false, null],
  ['empty full-inventory group', listingWith([]), false, null],
  ['unloaded full-inventory group', { seeAllAmenitiesGroups: [{ title: 'Safety' }] }, false, null],
  ['null full-inventory group', { seeAllAmenitiesGroups: [null] }, false, null],
  ['partly unloaded groups', { seeAllAmenitiesGroups: [{ amenities: [wifi] }, { title: 'Safety' }] }, false, null],
  ['partly empty groups', { seeAllAmenitiesGroups: [{ amenities: [wifi] }, { amenities: [] }] }, false, null],
  ['blank amenity placeholder', listingWith([{ title: '  ', available: true }]), false, null],
  ['null amenity placeholder', listingWith([wifi, null]), false, null],
  ['untitled amenity placeholder', listingWith([wifi, {}]), false, null],
  ['populated full-inventory groups', { seeAllAmenitiesGroups: [
    { title: 'Internet', amenities: [wifi] },
    { title: 'Safety', amenities: [{ title: 'Smoke alarm', available: true }] }
  ] }, true, 'not_listed'],
  ['populated full inventory without availability flags', listingWith([{ title: 'Wifi' }]), true, 'not_listed'],
  ['explicit camera in generic preview', { amenities: [camera] }, false, 'camera'],
  ['explicit unavailable in generic preview', { amenities: [unavailableCamera] }, false, 'no_camera'],
  ['conflict in generic preview', { amenities: [camera, unavailableCamera] }, false, 'unverified'],
  ['camera with unknown availability', { amenities: [{ title: camera.title }] }, false, 'unverified'],
  ['positive safety disclosure', { safety: [{ title: camera.title }] }, false, 'camera'],
  ['unavailable versus safety conflict', { amenities: [unavailableCamera], safety: [{ title: camera.title }] }, false, 'unverified'],
  ['missing structured data', null, false, null],
  ['incomplete presentation data', { data: { node: { pdpPresentation: {} } } }, false, null]
];

for (const [name, data, expectedComplete, expectedStatus] of completenessCases) {
  assert.equal(classifier.containsCompleteAmenityInventory(data), expectedComplete, `${name}: completeness`);
  const result = classifier.classifyStructuredData(data);
  assert.equal(result?.status ?? null, expectedStatus, `${name}: classification`);
}

console.log(`All classifier tests passed (${5 + completenessCases.length} scenarios, ${5 + completenessCases.length * 2} assertions).`);
