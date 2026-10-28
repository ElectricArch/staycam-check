(function (global) {
  'use strict';

  const CAMERA_PHRASES = [
    'exterior security cameras on property',
    'exterior security camera on property'
  ];

  function normalizeText(value) {
    return String(value || '')
      .toLocaleLowerCase('en-US')
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, '/')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchCameraPhrase(value) {
    const normalized = normalizeText(value);
    return CAMERA_PHRASES.find((phrase) => normalized.includes(phrase)) || null;
  }

  function getAvailabilityState(object) {
    if (!object || typeof object !== 'object') return null;

    const booleanKeys = ['available', 'isAvailable', 'isPresent', 'present', 'enabled'];
    for (const key of booleanKeys) {
      if (!(key in object)) continue;
      const value = object[key];
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
      }
      if (value === 1) return true;
      if (value === 0) return false;
    }
    return null;
  }

  function collectCameraEntries(value, path = '$', seen = new WeakSet(), matches = []) {
    if (!value || typeof value !== 'object') return matches;
    if (seen.has(value)) return matches;
    seen.add(value);

    if (!Array.isArray(value)) {
      const textKeys = ['title', 'name', 'label', 'text', 'accessibilityLabel'];
      for (const key of textKeys) {
        if (typeof value[key] !== 'string') continue;
        const phrase = matchCameraPhrase(value[key]);
        if (!phrase) continue;
        matches.push({
          phrase,
          value: value[key],
          field: key,
          path: `${path}.${key}`,
          objectPath: path,
          available: getAvailabilityState(value),
          keys: Object.keys(value)
        });
        break;
      }
    }

    if (Array.isArray(value)) {
      value.forEach((nested, index) => {
        if (nested && typeof nested === 'object') {
          collectCameraEntries(nested, `${path}[${index}]`, seen, matches);
        }
      });
    } else {
      Object.entries(value).forEach(([key, nested]) => {
        if (nested && typeof nested === 'object') {
          collectCameraEntries(nested, `${path}.${key}`, seen, matches);
        }
      });
    }
    return matches;
  }

  function containsCompleteAmenityInventory(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);

    if (!Array.isArray(value)) {
      // Generic previews and unloaded groups cannot establish a complete inventory.
      if (
        Array.isArray(value.seeAllAmenitiesGroups) &&
        value.seeAllAmenitiesGroups.length > 0 &&
        value.seeAllAmenitiesGroups.every((group) =>
          Array.isArray(group?.amenities) && group.amenities.length > 0 &&
          group.amenities.every((item) =>
            typeof item?.title === 'string' && item.title.trim().length > 0
          )
        )
      ) {
        return true;
      }
    }

    const nestedValues = Array.isArray(value) ? value : Object.values(value);
    return nestedValues.some((nested) =>
      nested && typeof nested === 'object' && containsCompleteAmenityInventory(nested, seen)
    );
  }

  function classifyStructuredData(parsed) {
    const matches = collectCameraEntries(parsed);
    const hasAmenityInventory = containsCompleteAmenityInventory(parsed);
    const presentMatches = matches.filter((match) => match.available === true);
    const absentMatches = matches.filter((match) => match.available === false);
    const safetyPolicyMatches = matches.filter((match) =>
      match.available === null && /(?:houseRulesSections|safety|policies)/i.test(match.objectPath)
    );

    if (presentMatches.length && absentMatches.length) {
      return {
        status: 'unverified',
        reason: 'Airbnb returned conflicting available=true and available=false camera records.',
        path: `${presentMatches[0].path} | ${absentMatches[0].path}`
      };
    }
    if (presentMatches.length) {
      const match = presentMatches[0];
      return { status: 'camera', phrase: match.phrase, source: 'amenity record with available=true', path: match.path };
    }
    if (absentMatches.length && safetyPolicyMatches.length) {
      return {
        status: 'unverified',
        reason: 'Airbnb marked the camera amenity unavailable but also listed it under Safety & property.',
        path: `${absentMatches[0].path} | ${safetyPolicyMatches[0].path}`
      };
    }
    if (absentMatches.length) {
      const match = absentMatches[0];
      return { status: 'no_camera', phrase: match.phrase, source: 'amenity record with available=false', path: match.path };
    }
    if (safetyPolicyMatches.length) {
      const match = safetyPolicyMatches[0];
      return { status: 'camera', phrase: match.phrase, source: 'Safety & property disclosure', path: match.path };
    }
    if (matches.length) {
      return {
        status: 'unverified',
        reason: 'The camera phrase was present, but Airbnb did not expose whether it was available.',
        path: matches[0].path
      };
    }
    if (hasAmenityInventory) {
      return {
        status: 'not_listed',
        reason: 'The complete amenity inventory was found, but it contained no exterior-camera entry.'
      };
    }
    return null;
  }

  function inspectListingHtml(html) {
    const responseDocument = new DOMParser().parseFromString(html, 'text/html');
    const primaryScript = responseDocument.querySelector('#data-deferred-state-0');
    const prioritizedScripts = [
      primaryScript,
      ...responseDocument.querySelectorAll('script[type="application/json"]'),
      ...responseDocument.querySelectorAll('script[id*="data" i], script[id*="state" i]')
    ].filter(Boolean);

    const checkedScripts = new Set();
    const scriptResults = [];
    let parsedAnyStructuredData = false;
    let sawListingContext = false;
    let primaryListingId = null;
    for (const script of prioritizedScripts) {
      if (checkedScripts.has(script)) continue;
      checkedScripts.add(script);
      const scriptText = script.textContent || '';
      if (!scriptText.trim()) continue;
      try {
        const parsed = JSON.parse(scriptText);
        parsedAnyStructuredData = true;
        // Limit cross-script comparison to the existing listing wrapper or primary state.
        // Opaque node IDs distinguish payloads; they are not decoded as Airbnb room IDs.
        const node = parsed?.data?.node;
        const hasListingContext = Boolean(node?.pdpPresentation &&
          typeof node.pdpPresentation === 'object' && !Array.isArray(node.pdpPresentation));
        const listingId = hasListingContext && (typeof node.id === 'string' ||
          (typeof node.id === 'number' && Number.isFinite(node.id)))
          ? String(node.id).trim() || null : null;
        const relevant = script === primaryScript || hasListingContext;
        if (relevant) sawListingContext = true;
        if (script === primaryScript) primaryListingId = listingId;
        const classification = classifyStructuredData(parsed);
        if (classification) scriptResults.push({ classification, listingId, relevant });
      } catch {
        // Text-only matching cannot distinguish available from crossed-out amenities.
      }
    }

    const results = scriptResults.filter((result) =>
      (!sawListingContext || result.relevant) &&
      (!primaryListingId || !result.listingId || result.listingId === primaryListingId)
    );
    const listingIds = new Set(results.map((result) => result.listingId).filter(Boolean));
    if (listingIds.size > 1 || (!sawListingContext && results.length > 1)) {
      return {
        status: 'unverified',
        reason: 'Multiple structured scripts were found, but their target-listing scope could not be established.'
      };
    }
    if (results.length) {
      const first = results[0].classification;
      if (results.some((result) => result.classification.status !== first.status)) {
        return {
          status: 'unverified',
          reason: 'Structured listing scripts disagree about exterior-camera disclosure.',
          path: results.map((result) => result.classification.path).filter(Boolean).join(' | ')
        };
      }
      return first;
    }

    const looksLikeListing = html.includes('/rooms/') ||
      html.includes('stayProductDetailPage') ||
      Boolean(responseDocument.querySelector('#data-deferred-state-0'));

    if (!looksLikeListing) return { status: 'unverified', reason: 'The response did not look like a listing page.' };
    if (parsedAnyStructuredData) {
      return { status: 'unverified', reason: 'Structured data was present, but the complete amenities inventory was unavailable.' };
    }
    return { status: 'unverified', reason: 'No parseable structured listing data was returned.' };
  }

  const api = {
    CAMERA_PHRASES,
    normalizeText,
    matchCameraPhrase,
    getAvailabilityState,
    collectCameraEntries,
    containsCompleteAmenityInventory,
    classifyStructuredData,
    inspectListingHtml
  };

  global.StayCamClassifier = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
