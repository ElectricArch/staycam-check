# Chrome Web Store Listing Draft

**Planning text only.** This project is currently prepared for experimental GitHub source review and unpacked evaluation. It is not represented as listed, approved or ready for Chrome Web Store distribution. Store policy, privacy disclosures, asset rights and production-readiness checks require a separate review.

## Name
StayCam Check

## Short description
Review structured exterior-camera disclosures on supported Airbnb search-result cards.

## Detailed description
StayCam Check adds a user-controlled disclosure scan to Airbnb search-results pages.

It places each checked listing into one of four categories:

- Camera confirmed
- Camera explicitly unavailable (crossed out)
- Camera amenity not listed
- Could not verify

Cards classified as `camera` can be hidden when the preference is enabled. Eligible results can be reused locally for seven days, with a 500-entry limit on saves. Expiry is not immediate physical deletion.

These labels express the classifier's interpretation of supported disclosure evidence. Negation, nested records for another listing, unsupported wording and changing schemas can produce incorrect labels, including both false positives and false negatives. The destination-search workflow is primary; homepage and universal page compatibility are not claimed.

Privacy design:
- No telemetry
- No advertising
- No account
- No developer-operated server
- Local extension settings and cache; no application-level cross-device synchronization
- Permissions for HTTPS bare/www Airbnb pages and storage

Listing requests use normal browser-managed credentials and follow redirects; final response origin is not independently checked. Tabs are not synchronized, and nonsettling storage/MV3 lifecycle behavior remains limited. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) for the actual data-handling boundaries.

Important: StayCam Check analyzes disclosures, not physical equipment. It cannot detect undisclosed cameras, verify the absence of interior cameras, guarantee a camera-free property or certify safety. Do not rely on its labels for a property-safety decision. It is not affiliated with Airbnb.

## Single purpose
Help users identify and filter vacation-rental listings based on the listing's disclosed exterior-camera amenity status.

## Permission justification
- `storage`: saves user settings and a short-lived local classification cache.
- HTTPS bare/www `airbnb.com` access: discovers supported room links and retrieves listing pages after a manual Scan; optional new-result scanning requires both enabled auto-scan and prior activation.

## Suggested category
Shopping

## Suggested screenshots
Future screenshots must be captured with permission and sanitized; none are supplied or represented as validated here.

1. Search page with all four disclosure badges visible.
2. Popup showing category totals.
3. Search page with confirmed-camera listings hidden.
