# Changelog

## Unreleased — Experimental GitHub review preparation

- Documented the MV3 architecture, setup, test strategy, privacy behavior and known limitations; added a technical case study.
- Replaced packaged icons with size variants of owner-supplied artwork. No interface layout or styling redesign.
- Current regression suite: 220 scenarios / 1,116 assertions.

Current development behavior includes supported amenity-completeness safeguards and cross-script evidence reconciliation; duplicate-card/current-ID reconciliation; observer stabilization; Stop/Clear generation and storage ordering; a 20-second fetch/body deadline; and focused storage/error recovery.

Known language/ownership ambiguity, cross-tab consistency, nonsettling storage, resource-budget and broader SPA/layout limitations remain. These changes do not establish production accuracy or Chrome Web Store readiness.

## 0.1.0 — Local prototype record, 2026-07-17

- Initial Manifest V3 prototype; this date is not a public publication claim.
- Four-state camera-disclosure classification.
- User-initiated, queued listing scans.
- Local seven-day cache.
- Popup controls and in-page status panel.
- No telemetry or remote executable code.
