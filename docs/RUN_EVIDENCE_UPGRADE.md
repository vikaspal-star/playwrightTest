# Automation run evidence review

Reviewed and implemented September 7, 2026. The signed-in LambdaTest Automation run shared by the user was inspected through its **All Commands, Logs, Network, Meta Data, Performance, Smart UI, and Accessibility** tabs. The Logs view also exposed Console and Terminal. This review did not modify the vendor test or start a paid run.

The sample contained 44 commands and a video. Console/terminal logs were empty, Network and Accessibility were not enabled, Performance had no Lighthouse report, and Smart UI had no results for that test. These empty states are not evidence that the vendor lacks those capabilities. The current [Automation dashboard guide](https://www.testmuai.com/support/docs/inside-testmu-platform/) describes commands, logs, network evidence, configuration, history and video together.

## What Maya now includes

Open **Inspect run** in a test or suite, or **Reports → Run history & evidence**. The inspector has a fixed header, keyboard-accessible tabs and one content scroller. The project tabs remain Test cases, Requirements and Suites.

| Reviewed area | Maya behavior |
| --- | --- |
| Commands | Search/filter saved step results, jump to the first failure, view per-step duration, screenshot and error. Historical results do not use the current editor's step definitions. |
| Logs | Separate browser console/page errors and runner output, with search and browser severity filters. |
| Network | Method, sanitized URL, HTTP status, resource type, owning step, observed duration and timeline; filter failed requests. |
| Video and screenshots | Successful and failed runs retain video when enabled; play/download recordings and browse step screenshots. Both single runs and shared-session suites are supported, including application popups. |
| Metadata | Run ID, source, executor, timestamps, actual browser/version, operating system, Node version, viewport and project/environment names captured at execution. |
| Performance | Slowest steps and page navigation TTFB, DOM-ready and load-event samples. Missing timings remain unavailable rather than becoming zero. |
| Smart UI / visual testing | Manual side-by-side screenshot comparison with earlier accessible runs of the same test/suite, selecting a corresponding step. This does not assign an automated visual verdict. |
| Accessibility | Optional axe-core WCAG 2.1 A/AA scans of each test's final reached page. Findings show impact, rule, target selectors and guidance; errors and incomplete checks remain explicit. |
| History and export | Search accessible run history, filter status, load additional rows, inspect an older run and export its JSON evidence without sharing grants or raw input snapshots. |

## Capture controls

**Settings → Run evidence** stores browser-local preferences for subsequent UI-started browser tests and suites. Video defaults on; accessibility defaults off. These captures do not call an AI provider. Existing **Settings → Telemetry** continues tracking AI tokens and estimated spend.

API callers can pass `{"capture":{"video":true,"accessibility":false}}` to the existing `POST /api/tests/:file/run` or `POST /api/suites/:file/run` endpoint. Options are validated before starting a run. Plain CLI test behavior is unchanged.

`GET /api/runs/:id/evidence` returns the run, diagnostics and finalized video paths; `?download=1` downloads it. Each request and video range request uses the same access check as run details. JSON input snapshots and diagnostics files are not exposed as arbitrary static assets. Videos are finalized on browser-context closure, following [Playwright's video lifecycle](https://playwright.dev/docs/videos).

## Data and limits

- Evidence is saved locally beneath `runs/<id>/`. Back up this directory; videos increase disk use. Existing runs are retained and show “not captured” where new evidence is unavailable.
- Network capture stores metadata only: no request/response bodies or headers, URL credentials, query values, or fragments. Browser console text removes common password/token/API-key fields and URL queries, but unstructured application logs and screenshots can still contain business data. Existing runner output is retained as before.
- Capture is bounded to the first 500 console entries, 500 network requests, 200 page timing samples and 10 accessibility scans per run. Omitted counts are retained; scans have a 15-second deadline. Accessibility findings retain up to 100 rules and 10 target examples per rule, with the affected-node total.
- Accessibility findings are advisory and do not change the functional verdict. Closed pages and scan timeouts produce a scan error. Automated checks cover only the final reached page, not every state or manual keyboard/screen-reader behavior. This follows [Playwright's distinction between automated and manual accessibility testing](https://playwright.dev/docs/accessibility-testing).
- Navigation samples are local diagnostic measurements, not Lighthouse, Core Web Vitals certification or a load test. Repeated samples may refer to the same navigation. Visual comparison is manual, not a pixel-diff baseline or AI visual assertion. Changed step inputs, live data or viewports require reviewer judgment.
- There is no LambdaTest cloud execution, HyperExecute integration, paid vendor upgrade, device/browser grid, automatic bug-ticket submission, HAR body capture or scheduling in this change. Agent Testing keeps its existing manual/API transcripts and optional AI evaluation.

## Verification

The Studio browser suite exercises real browser console errors and HTTP failures against an isolated fixture, token redaction, successful video capture/playback and range requests, video opt-out, a real axe button-name violation, suite capture, historical comparison, all inspector tabs, responsive layouts, settings persistence and restricted evidence access. Unit tests cover option validation, redaction, bounded noisy-page capture and failed scans. Existing project, recording, agent-testing, authentication and reporting journeys are rerun.
