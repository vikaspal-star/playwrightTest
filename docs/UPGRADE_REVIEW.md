# MMQA Studio upgrade review

Reviewed against the README, action catalog, executor, API routes, browser UI, persistence, optional integrations, and workflow configuration on 2026-09-05.

## Product requirement reconstructed from the application

MMQA is a local/team QA automation studio. Its core workflow is to create or import JSON tests, record browser interactions, edit ordered steps, run a test or a suite sharing one browser session, inspect live screenshots and errors, and use history to assess outcomes. A site admin manages team accounts and feature access. Test owners can restrict sharing. Postgres mirrors finished runs, while AI analysis is optional.

Existing branding, plain JavaScript UI, TypeScript backend, JSON format, and Playwright runner are retained. No framework migration or speculative dependency upgrade is necessary to fix the observed defects. A full dependency audit found no known advisories for the installed dependency graph at review time.

## Confirmed gaps addressed

| Area | Observed gap | Upgrade |
| --- | --- | --- |
| Access control | Hidden tests leaked through history, screenshot, report and knowledge routes | Related runs, artifacts, suites and analysis routes enforce source-test access; aggregate reports filter inaccessible runs |
| Historical privacy | Deleting/recreating a test could change access to its previous runs | Retain sharing metadata and source access attribution; filename reuse does not expose previous private runs |
| Recorder | Any signed-in user could inspect or stop another recording; applying steps bypassed feature access | Ownership checks on read/stream/stop/apply, explicit edit feature, active-run edit protection |
| Authentication | Malformed cookies caused errors; password changes left other sessions valid; no attempt limits | Defensive cookie parsing, bounded failed authentication attempts, session revocation/renewal, optional Secure cookies |
| Account UI | Change-password API had no form | Accessible password form with confirmation and clear session behavior |
| Browser request security | No origin enforcement or response security policy | Same-origin JSON mutations, CSP, nosniff, frame restrictions, referrer and permissions policies |
| Input validation | Unknown actions and missing fields could be saved; empty values were dropped | Shared catalog validator for API/CLI; action aliases normalized, field types/enums/timeout limits checked, empty values preserved |
| Test creation | Invalid placeholder navigation was inserted automatically | New tests start as empty drafts; running empty drafts is rejected |
| Starter test | Checked-in example navigated to an incomplete `https://` URL | Explicit Example Domain smoke test with an assertion |
| Run reliability | Concurrent runs shared report/output directories and mutable test inputs | Run-specific input snapshots, artifacts and HTML reports; one worker per single-test run |
| Run lifecycle | Unlimited jobs, suite waits, stale running states and incomplete process cancellation | Configurable capacity and deadlines, suite browser timeouts, process-tree cancellation, run-owner stop checks, restart recovery |
| Suites | Missing references accepted; deleting tests broke suites | Validate references on save/read and prevent deletion of referenced/in-use tests |
| Persistence | Direct writes risked partial files; corrupt auth/sharing data defaulted to empty | Atomic replacement, fail-closed reads, one-server workspace lock |
| Import fidelity | Visual comparisons were weakened into presence checks; waits/scrolls used invented values | Unsupported/missing evidence is explicitly reported |
| Reporting/AI | Optional database backfill counted failed writes; analysis could wait indefinitely | Count successful writes only, bound provider requests, use stored run input for step analysis, validate AI response field types |
| Usability | Blank initial workspace; controls ignored feature grants; save shortcut could target the wrong editor | Overview and recent activity, permission-aware controls, persistent step validation feedback, active-editor save shortcut |
| Accessibility/responsiveness | Step labels lacked associations; dialogs lacked semantics/focus containment; mobile had no usable layout | Associated labels, dialog names and focus trapping/restoration, visible focus, live feedback, collapsible mobile browsing and responsive panels |
| CI | Test failures explicitly ignored; only customer tests ran | Required Studio/core checks and dependency audit; artifacts retained; customer workflows are explicit manual runs |
| Operations | Binding and data paths implicit; optional service ports exposed on all interfaces | Localhost defaults, documented configuration, workspace isolation, liveness route and local Docker port binding |

Security changes follow the principles documented by [Express](https://expressjs.com/en/advanced/best-practice-security/). Report isolation uses Playwright's documented [HTML output directory](https://playwright.dev/docs/test-reporters); the Studio verification server follows its [webServer configuration](https://playwright.dev/docs/test-webserver).

## Verification

- `npm run check`: TypeScript, browser JavaScript syntax, six core/server regressions.
- `npm run test:studio`: eight ordered API and Chromium scenarios, using a disposable workspace.
- Core tests cover validation, import fidelity, atomic storage, historical statistics, orphan recovery, duplicate server rejection and corrupt-account handling.
- Browser/API coverage includes test and suite execution, session sharing, artifact isolation, authorization across history endpoints, filename reuse, recording ownership, validation recovery, member controls, process cancellation, password changes, and authentication throttling.
- Desktop (1280px) and mobile (390px) screenshots are inspected; the mobile check also verifies the page has no horizontal overflow. Browser journey checks capture uncaught JavaScript errors.
- Existing JSON definitions are validated without executing the configured customer workflows. The pre-existing untracked `json/anomali-prm-admin.json` is preserved.
- `npm audit` reports zero known vulnerabilities; `git diff --check` is used for patch hygiene.

Verification artifacts are generated in `test-results/` and `playwright-report/studio/`. They are intentionally git-ignored.

## Remaining work and deployment boundaries

These are not claims of completed production readiness. No target deployment, scale, authentication provider, or supported browser matrix was supplied.

1. **Live acceptance:** run the customer portal suites using the intended staging accounts and expected business outcomes. Local Studio regressions do not prove that those portals or their selectors are correct.
2. **Production hosting:** establish the host/domain, TLS proxy, account provisioning, backup retention and restore exercise. Current health reports liveness, not the availability of optional providers. File storage is explicitly single process.
3. **Trust boundary:** users allowed to author tests can drive a browser on the host and invoke file-upload actions with host paths. This remains a trusted-team tool. Public/untrusted tenancy requires isolated worker containers, upload allowlists, egress controls and a secrets system before exposure.
4. **Identity and scale:** SSO/MFA, invitations/reset recovery, immutable audit logging, paginated/indexed history and multiple worker processes need product requirements and a transactional primary database design. The current optional database only mirrors finished runs.
5. **Coverage expansion:** Firefox/WebKit, visual baselines, API/network assertions, scheduled execution, environment parameter sets and richer recording are future capabilities rather than implied support in the existing action catalog.
6. **Integration acceptance:** live Postgres and paid Anthropic calls were not exercised. Provider keys and intended model availability must be verified in the deployment environment. Existing provider model defaults were preserved, not asserted to be available.
7. **Further accessibility/security review:** the browser scenarios verify targeted improvements; they are not a WCAG conformance audit or penetration test. Large histories and long-running recording workloads have not been load tested.

## Upgrade and rollback

Stop the old server before starting the updated version. Preserve a backup of the workspace's tests, suites, run files and `ui/data/` together. No database schema migration is introduced. New run metadata is additive; legacy records still load and the global CLI report stays available to admins. Invalid old test definitions now receive an explicit validation error before execution. If rolling back code, retain the backup: older versions do not enforce the new access protections and may overwrite run artifacts.
