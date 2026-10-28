# Contributing

Keep the project focused on exterior-camera **disclosure analysis**. Read the [README](README.md), [technical showcase](docs/TECHNICAL_SHOWCASE.md), and [security boundaries](SECURITY.md) before proposing changes.

## Local development

Use Node.js 22 or later and a Chrome build supporting Manifest V3. No dependency installation or build is required. Load the directory containing `manifest.json` unpacked using the README instructions.

Run:

```sh
npm test
npm run check
git diff --check
```

On Windows PowerShell, use `npm.cmd` if `npm.ps1` is blocked. The current regression baseline is 220 scenarios / 1,116 assertions. Counts are not a coverage percentage or production-accuracy measure.

## Change expectations

- Reproduce a concrete problem with a small synthetic fixture before changing parser, discovery, storage or lifecycle logic. Prefer exercising actual code over copying an algorithm into tests.
- Preserve the four states, conservative conflict handling, cache compatibility, user activation, Stop/Clear distinction, identity guards and request pacing. Explain any deliberate contract change and its migration implications.
- Keep functional reliability work and visual redesign in separate changes. Do not broaden selectors from guessed production markup.
- Do not add telemetry, advertising, remote executable code, dependencies or permissions without a demonstrated need and explicit review. Explain any proposed privilege increase.
- Keep test data synthetic. Never commit authenticated responses, cookies, credentials, browsing records, private review documents, local configuration or personal filesystem paths.

For a pull request, describe the problem, resulting behavior, relevant tests, and material limitations. Distinguish Node fixtures, native browser fixtures and actual unpacked-extension smoke tests. Record browser/version and observed scenarios when manual testing is performed; do not infer universal compatibility from a basic pass.

Do not automate live Airbnb scans as part of the test suite. If representative markup is needed, use a minimal sanitized structure and remove personal data. For sensitive vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than posting details publicly.
