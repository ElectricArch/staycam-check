# Security Policy and Evaluation Boundaries

StayCam Check is experimental source for local evaluation. No production security certification, property-safety guarantee or Chrome Web Store approval is claimed. Only the current development version is evaluated; there is no promised security-support period or response SLA.

## Implemented boundaries

- Packaged local JavaScript only; no runtime dependencies, remote executable code, account system, telemetry or developer-operated backend.
- Manifest V3 with storage permission and HTTPS access to bare/www Airbnb hosts. No cookies/history/debugger/all-sites permission.
- Initial listing URLs must match supported HTTPS numeric room paths. Background requests are logically serialized, paced by at least 900 ms and bounded by a 20-second fetch/body deadline.
- Fetched HTML is parsed in a detached document and never inserted into the live page. JSON is parsed as data. Panel HTML is a fixed literal; badge/status output uses text properties rather than untrusted HTML interpolation.
- Runtime handlers are internal. There is no external-message listener, webpage `postMessage` bridge or externally-connectable webpage declaration. Explicit sender/schema validation is limited; page DOM and returned evidence remain untrusted inputs.

With no custom CSP, Chrome applies its [default extension-page CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy). That is an additional boundary, not a substitute for reviewing data flows. External extension messages use separate [message APIs](https://developer.chrome.com/docs/extensions/develop/concepts/messaging); absence of a webpage bridge is not a claim that a compromised content-script context is trusted.

## Known limitations

| Area | Consequence / evaluation guidance |
| --- | --- |
| Disclosure accuracy | Negated phrases or nested records for another listing can produce incorrect positive or negative labels. Unsupported evidence can be missed. Do not use labels to determine whether accommodation is safe or camera-free. |
| Response origin | Fetch follows redirects without independently checking the final origin. Initial host validation is not a complete redirect policy. |
| Resource use | Full HTML is read/transferred/parsed without an application byte, parse-time or recursion budget. Large/malformed data can consume memory or block the page. Network timeout does not bound parsing. |
| Cancellation / worker lifetime | Abort is requested, but physical cancellation and survival across MV3 suspension/termination are not guaranteed. Queue state is in memory. |
| Storage / multiple tabs | Ordinary rejections have recovery paths; nonsettling promises can block ordered work. Cross-tab cache/settings writes and Clear are not synchronized. |
| Host-page DOM | Card heuristics can affect a recommendation container or miss unfamiliar cards. The page can manipulate shared DOM, including extension controls/markers. These are not a tamper-proof security indicator. |

Detached `DOMParser` output is not a sanitizer for later HTML insertion. Browser resource behavior also matters even when scripts are inert; see [DOMParser guidance](https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString). This project does not import fetched nodes into an active document. Future changes must preserve that boundary and assess browser-managed resource requests separately.

## Responsible reporting

If the hosting repository enables GitHub's **Security → Report a vulnerability** feature, use it for sensitive reports. If that option is absent, open an issue requesting a private reporting route **without exploit details or secrets**. A private reporting channel is not assumed to exist before repository setup.

Include version/commit, affected component, realistic impact and a small synthetic reproduction where safe. Never submit cookies, tokens, authenticated HTML, personal listing/search records, or local profile paths. Do not test against other users, scan live listings at scale, or publish an exploit while arranging private contact.

Security reports and code review do not establish Airbnb authorization, compliance with platform terms, intellectual-property rights or general legal compliance. Those are separate owner responsibilities.
