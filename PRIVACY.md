# Privacy and Data Handling

Technical review date: **2026-10-28**. This describes the current experimental extension's implementation, not a production privacy certification.

## What is processed

StayCam Check reads room links and card structure on supported Airbnb pages, then retrieves listing-page HTML to analyze exterior-camera disclosures. The worker returns the full HTML through internal extension messaging to a content-script parser. The returned document and JSON evidence are used in memory; the implementation does not persist full HTML, screenshots, browsing history, authentication cookies or account credentials.

Requests use `credentials: include`. Chrome may therefore include applicable Airbnb cookies/session information under its normal browser policy, and responses may be personalized. This is not an anonymous fetch or a guarantee that only publicly visible content is processed. The extension does not request the cookies API or read cookie values directly.

## Network behavior

- No developer-operated backend, account system, analytics, telemetry, advertising SDK or data-broker integration is present in the runtime source.
- New listing requests begin after a deliberate Scan. Optional auto-scan requires both an enabled preference and prior scan activation; a fresh page does not scan just because that preference is stored.
- Initial request URLs are restricted to HTTPS numeric room paths on bare/www `airbnb.com`, canonicalized to the www host, without query or fragment.
- Redirects are followed and the final origin is not independently validated. Detached HTML parsing is not asserted to block every browser-managed subresource request. Host permissions and initial URL validation are not a blanket guarantee that all possible traffic stays on one origin.

The extension does not deliberately send classification data or browsing information to its developer or an analytics endpoint. Airbnb and browser-managed network destinations can observe requests under their own policies. No network-anonymity guarantee is made.

## Local storage

`chrome.storage.local` holds:

| Key | Contents |
| --- | --- |
| `staycam:cache:v3` | Numeric listing IDs mapped to status, evidence metadata such as source/reason/JSON path where present, check timestamp and classifier revision |
| `staycam:settings:v3` | Hide-confirmed and auto-scan preferences, preserving existing stored option fields |

Only `camera`, `no_camera` and `not_listed` classifications are persisted. `unverified` results can be retained temporarily for the current page, but are not written as cache entries. Failed saves leave valid results in memory with an unsaved indication; they are not falsely treated as confirmed persistence.

Results become ineligible for reuse after seven days. This is a lookup/load eligibility check, **not a scheduled physical-deletion job**: old entries can remain on disk until a later successful cache save/removal or extension removal. Successful saves retain the newest 500 entries. Settings persist until changed or the extension's storage is removed.

Listing IDs and timestamps can reveal which listings were checked. Local storage is not encrypted by this application and should not be treated as a secret vault. Browser/profile security and backups are outside this extension's control. Chrome documents its storage behavior in the [storage API reference](https://developer.chrome.com/docs/extensions/reference/api/storage).

## Clear, failures and multiple tabs

Clear immediately invalidates earlier scan work and removes this tab's markings, then removes the saved cache after earlier writes settle. It preserves settings and unrelated storage keys. The success response waits for removal; if removal rejects, the controls report failure and allow a deliberate retry. Visual clearing alone is not proof of persistent deletion.

Tabs maintain separate memory snapshots. Clearing one tab does not immediately remove another tab's markers, and concurrent writes can lose or restore cached entries. Refresh other tabs and prefer one evaluation tab. A genuinely nonsettling storage operation can keep ordered work or its acknowledgement pending; no guaranteed storage-cancellation deadline exists.

## Reporting privacy concerns

Use the hosting repository's issue tracker for nonsensitive privacy questions when it is available. For security-sensitive details, follow [SECURITY.md](SECURITY.md). Do not post authentication data, private listing responses or personal browsing records in an issue.
