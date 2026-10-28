# StayCam Check — Technical Showcase

## Project overview

StayCam Check is an experimental Chrome Manifest V3 extension for reviewing exterior-camera disclosures on Airbnb destination-search results. It combines a structured-data classifier with an asynchronous scan lifecycle, per-card identity tracking, local caching, and recoverable controls.

The engineering problem is broader than adding labels to cards: the website changes its DOM while requests are outstanding, multiple cards can represent the same listing, users can interrupt work, and storage or network operations can fail. The project addresses those interactions without a framework or backend.

It analyzes disclosure data, not surveillance equipment. Known language and ownership ambiguities can produce incorrect labels. It must not be used to certify a property's safety or absence of cameras.

## Engineering objectives

- Keep four evidence outcomes distinct instead of treating missing data as a negative finding.
- Preserve manual control over network work and optional activated auto-scanning.
- Bound ordinary network stalls without abandoning request pacing.
- Prevent delayed results from crossing listing identities or undoing Clear.
- Recover from ordinary storage rejections and unexpected scan exceptions.
- Make behavior reproducible with deterministic tests that run the actual implementation.
- Keep the permission and dependency footprint understandable to a source reviewer.

## System architecture

| Component | Responsibility | Boundary |
| --- | --- | --- |
| MV3 worker | Validate room URLs, serialize fetches, pace starts, enforce fetch/body deadline | Receives internal requests; returns HTML or an error, not a classification |
| Content script | Discover cards, manage lifecycle and settings/cache, apply current-ID results | Runs on bare/www HTTPS Airbnb pages; the host controls its DOM |
| Classifier | Parse supported JSON evidence and produce four disclosure states | Shared browser/CommonJS module; no network or storage calls |
| Popup | Request actions and display the current tab's status snapshot | Does not maintain a live status subscription |
| Local storage | Persist settings and reusable results | Shared extension storage; tab memory is not synchronized |

The implementation uses vanilla JavaScript, native HTML/CSS and Chrome APIs. Node.js built-ins provide assertions, VM execution, fixture loading and controlled asynchronous tests. No external runtime or test packages are required.

## Classification pipeline

1. The content script identifies accepted cards containing supported numeric room links and groups representations by listing ID.
2. A valid revision/TTL cache entry can satisfy a check; otherwise the worker retrieves the canonical listing page.
3. The classifier parses a detached HTML document and reads candidate JSON scripts. It does not execute those scripts or insert fetched nodes into the live page.
4. Recognized English exterior-camera phrases and availability fields supply explicit evidence. A populated supported full-inventory shape is required for `not_listed`; generic previews and empty placeholders do not establish completeness.
5. Supported cross-script contexts are reconciled. Recognized conflicting statuses or ambiguous cross-script identities yield `unverified`.
6. The content script applies a result only to accepted connected cards still representing the relevant ID.

`camera` means a disclosed exterior camera in recognized evidence; `no_camera` means its amenity is explicitly unavailable; `not_listed` means no entry in a sufficiently complete supported inventory; `unverified` covers inconclusive evidence. These describe the model's intended interpretation, not independent ground truth.

Conservative abstention has boundaries. Substring matching can misread negation. Recursive discovery can use nested records belonging to another listing. Unsupported supplemental shapes or wording can be missed. This can create both false positive and false negative outcomes; passing tests for supported fixtures is not an accuracy benchmark.

## Sequential requests and bounded completion

The worker chains operations through a shared Promise queue while its service-worker instance remains alive. Fetch starts are separated by at least **900 ms**. Initial URLs must use HTTPS, a bare/www Airbnb host and a numeric room path; query and fragment are removed.

One **20,000 ms** budget begins at fetch start after pacing and includes both headers and `response.text()`. An AbortController requests cancellation when the deadline expires. A Promise race also supplies logical completion when an operation ignores abort. Cleanup removes the timer, and attached settlement handlers keep late rejections observed. A timed-out check becomes `unverified`, allowing later logical work to proceed without an automatic retry storm.

This distinction matters: logical timeout does not prove physical network cancellation. An old non-cooperative operation may outlive its queue slot. Worker suspension/termination can interrupt timers, messages and the in-memory queue; there is no durable job system. Redirects are followed without an independent final-origin check. Full HTML has no application byte cap, and its internal message transfer and subsequent parsing have no application memory/CPU budget.

## Cache and recovery design

The cache uses `chrome.storage.local`, with a seven-day eligibility window, newest-500 retention on saves, and numeric classifier revision **2**. Only `camera`, `no_camera` and `not_listed` results are persisted. Expired entries are rejected in memory; physical removal waits for a later write, successful Clear or extension removal.

Settings default to hiding `camera` results and leaving auto-scan off. Controls and listeners are installed before storage awaits. Ordinary read rejections leave safe temporary defaults and an explicit retry path; fallback defaults do not overwrite unread persistent settings.

Setting writes are ordered within one tab and become effective after successful persistence. A rejected cache save preserves its otherwise valid classification and tracks the entry as unsaved. A deliberate Scan can retry saving without refetching or extending the original timestamp. Existing status areas and message responses distinguish these failures from success.

Storage that never settles remains unresolved. Releasing an old write's queue slot on a timer would allow it to finish after Clear and restore stale data. The implementation preserves ordering rather than claiming a storage timeout cancels that write.

## Card identity, navigation and user interruption

Visual results belong to both an ID and a current DOM card; persistent results belong to an ID. A card-to-ID map and per-ID representation groups maintain that distinction. Live connectivity and identity checks surround awaited work. Removed or reused cards lose obsolete markings; duplicate representations share ordinary-scan requests and results.

DOM child changes, room-link `href` changes and `popstate` feed the existing 800 ms debounce. Extension-owned panel/badge changes are filtered so their updates settle instead of causing an observer loop. Supported path/query context changes invalidate older generations and reset processed IDs while retaining eligible cached results.

Pure History API changes without an observable signal wait until the next discovery/check/manual Scan; hash-only contexts are not modeled. Owner testing reported working Back/Forward, with an earlier couple-second label redisplay delay whose cause and timing were not measured.

**Stop** finishes the current check, preserves completed results and disables activated automatic processing until deliberate restart. **Clear** immediately advances the generation, clears memory/markings, restores hidden cards and pauses scanning. Persistent removal follows already-started cache writes; fresh writes follow removal. Failed removal is reported honestly. A newer scan's state is protected from obsolete `finally` cleanup by ownership and generation checks.

## Security and privacy tradeoffs

All executable files are packaged locally. The manifest requests storage and HTTPS bare/www Airbnb access, with no cookies/history/debugger/all-sites privilege. Default extension-page CSP restricts executable sources; fetched content is parsed as data. Badge/status text uses text properties; the panel's `innerHTML` is a fixed literal.

The project has no developer-operated backend, telemetry or account system. Fetch uses browser-managed credentials, so responses may be personalized. Full HTML stays in memory; result metadata is stored locally. Redirects and detached-parser resource behavior are not claimed to be a strict network-origin firewall.

Message handlers are internal and there is no webpage message bridge or external-message listener. Sender/schema hardening and explicit final-origin/resource limits are reasonable future defense-in-depth work; the current URL allowlist is not a universal security guarantee. See [SECURITY.md](../SECURITY.md) and [PRIVACY.md](../PRIVACY.md).

## Testing strategy and verified results

The six suites run through `npm test` without a network dependency:

| Suite | Scenarios | Assertions | Focus |
| --- | ---: | ---: | --- |
| Classifier | 28 | 51 | Completeness, supported states and conflicts |
| Cache | 31 | 385 | Revision/TTL compatibility, reuse, limits and preservation |
| HTML classifier | 38 | 38 | Supported multi-script reconciliation using a selector adapter |
| Content lifecycle | 96 | 533 | Actual content script, controlled DOM/messages, deferred storage and worker integration |
| Background | 21 | 91 | Actual worker, fake clock, stalled fetch/body and late settlements |
| Popup recovery | 6 | 18 | Actual popup messages, failure display and settings rollback |
| **Total** | **220** | **1,116** | No production accuracy percentage implied |

Tests, syntax checks and whitespace checks passed during the technical documentation review. Native Chrome synthetic work previously exercised real DOM/MutationObserver/parsing/AbortController primitives, including 25 checks for timeout/recovery interactions. Such fixtures mock extension APIs and networking and are not installed-extension or worker-lifecycle certification.

Separately, owner-reported real-Airbnb smoke testing covered normal scans/classifications/hiding, settings after refresh, cache clearing, Stop/restart, Clear during scanning, immediate fresh Scan, Back/Forward and cache persistence during navigation. Deliberately stalled networking, injected storage failures and exhaustive production schemas were not established by that smoke.

Multiple tabs reportedly scan normally. Clearing one tab did not immediately remove markers in another; refreshing the second restored the expected appearance. Concurrent write races remain unverified. Automated evidence, browser fixtures and manual observations are complementary rather than interchangeable.

## Important tradeoffs and future work

- **Evidence precision versus coverage:** improving language/ownership rules requires representative sanitized data and regression checks, not guessed production schemas.
- **Simplicity versus resource control:** full HTML messaging enables the current DOMParser flow but needs measurement before selecting bounded response/parsing limits or another architecture.
- **Per-tab ordering versus global consistency:** current Clear protects one tab's ordered work; cache/settings snapshots can still race across tabs.
- **Observed transitions versus a router:** supported signals avoid a broad SPA framework, while universal navigation compatibility remains unclaimed.
- **Functional reliability versus presentation:** popup snapshots, fixed-panel placement, accessibility, narrow viewports and homepage support remain limitations. Visual redesign is a separate phase.

Potential future work includes measured resource budgets, stronger evidence attribution, separately scoped cross-tab coordination and broader browser/schema validation. This case study describes an experimental engineering project, not Chrome Web Store approval, platform authorization or a production security certification.
