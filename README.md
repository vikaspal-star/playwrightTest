# MMQA — QA Automation Studio

<img src="ui/public/brand/logo.svg" alt="MMQA" width="240">

JSON-driven UI automation on Playwright. Each file in `json/` is one test case:

```json
{
  "name": "login smoke",
  "steps": [
    { "action": "navigate", "url": "https://example.com/" },
    { "action": "fill", "selector": "#email", "value": "user" },
    { "action": "click", "selector": "#btnLogin" },
    { "action": "text-visible", "text": "Dashboard" }
  ]
}
```

`tests/json-runner.spec.ts` turns every JSON file into a Playwright test and `src/ActionExecutor.ts` executes the steps. The full list of actions and their fields lives in `src/actionCatalog.ts`.

## Setup

Requires Node.js 22 or newer (CI uses Node 24).

```bash
npm ci
npx playwright install chromium
```

## Run from the command line

```bash
npm test                 # run every JSON test headless
npm run test:headed      # watch the browser
npm run report           # open the Playwright HTML report
npm run allure:generate  # build the Allure report from allure-results/
```

## MMQA Studio (web UI)

A local UI for building and running the JSON tests:

```bash
npm run ui               # http://localhost:4173
```

- Use the persistent navigation to move between Overview, Projects, Suites, and Reports. The overview shows current counts and recent test activity; click a count to open the corresponding library filter.
- Open a project card, choose its Sandbox or Production environment, and browse a flat test list. Create projects, configure application URLs and import JSON from the Projects toolbar. New tests receive unique filenames automatically.
- Collapse step details in the compact left column and use the larger right browser panel to record or replay. Add steps manually or record them from the application screen. The navigation drawer can be hidden on desktop as well as mobile. Unsaved drafts survive returning to Projects.
- Run a test and follow its live browser screen. Completed steps retain screenshots, failure details and console logs. Selecting an earlier step pauses following; Follow live resumes it.
- Run history is kept under `runs/<runId>/` (git-ignored). Each single-test run has its own HTML report at `/runs/<runId>/report/`, linked from its run panel. `/report/` is reserved for admin access to legacy CLI reports.

The UI uses the same Playwright JSON runner as the CLI. It sets `RUN_DIR`, which makes `src/JsonRunner.ts` write per-step screenshots and emit `@@STEP` progress lines; plain CLI runs are unaffected.

The UI supplies a private input snapshot and separate output directories to the same JSON runner used by the CLI. Concurrent tests cannot overwrite one another's reports. An empty test can be saved as a draft; running requires at least one valid step. Saving and execution both validate actions against the catalog, including required fields and bounded timeouts. Intentional empty input values are preserved.

### Projects and environments

Projects contain one level of environments, each with a Sandbox or Production type and application URL. Existing folders are migrated additively into `ui/data/projects.json`; test files, sharing metadata and history remain intact. Use **Move** under a test name to preview destination URL changes and request an optional AI review before applying them. See [the upgrade guide](docs/PROJECTS_UPGRADE.md) for migration, recovery, recording controls and verification.

### Sharing

Every test is visible to the whole team by default (unchanged from before). **Test actions → Share test** gives you a direct link to the test and lets the creator (or an admin) restrict it to specific people, each granted either "can view & run" or "can edit". Restricted tests disappear from other people's lists entirely, and the server enforces this on every route, not just in the UI.

### Suites

A suite is an ordered chain of existing tests that runs in **one shared browser session**, so a login test can hand its session to the tests that follow. Suites live in `suites/` and are version-controlled alongside the tests. Set "continue with the remaining tests if one fails" per suite; otherwise a failure stops the chain and the rest is marked skipped. The run view groups steps under the test they came from.

### Login, roles, and feature access

The first person to open Test Studio becomes the **site admin**; everyone after that logs in. Sessions are cookie-based (7-day expiry, backed by `ui/data/sessions.json` so a server restart doesn't log anyone out). Passwords are hashed with scrypt and never stored or logged in plain text. All of this data lives under `ui/data/` (git-ignored).

Three roles, in a ladder:

| Role | Can do |
| --- | --- |
| Site admin | Everything. The only role that can create admins or change anyone's feature access. |
| Admin | Day-to-day administration: users, tests, suites, reports. |
| Member | Only what the site admin grants. Defaults include creating/editing/running tests, managing folders, running suites, and viewing reports. |

The **Manage users** dialog separates account creation from the member list, with labeled fields, role guidance, password visibility, and search by name or role.

Usernames are the workspace identity key — they attribute tests, address sharing grants and notifications, and group the reports. They must start with a letter or number and use only letters, numbers, spaces, dots, hyphens and underscores, and repeated whitespace is collapsed before the name is stored, so two accounts can never render identically. A member whose grants differ from their role default is marked **Custom access** in the member list.

Feature access is granular. The site admin selects **Manage access** beside a person in **Manage users** and ticks the features that account may use: creating, editing, deleting or running tests, managing folders and suites, viewing reports, using AI analysis, and managing users. Every one of those is enforced server-side.

This is good local-tool hygiene, not a hardened multi-tenant auth system — don't expose this server beyond your own machine/network without more thought.

The server binds to `127.0.0.1` by default. Passwords can be changed from **Password** in the header account menu; a change revokes other sessions and renews the current one. Authentication attempts are rate limited, browser mutations require the same origin, and responses include security headers. Restricted-test access also governs related suites, historical runs, event streams, screenshots, reports, and AI routes. Recordings belong to their creator; applying them requires test-edit access. Only a run's starter or an admin with the run feature can stop it.

File storage supports one server process per workspace. Writes replace complete JSON files atomically. Invalid account or sharing storage fails closed rather than silently resetting access. On restart, interrupted runs are marked failed with an explanation. Retained sharing metadata protects history after a test is deleted or its filename is reused.

### Reports

The **Reports** page keeps its period selector and refresh control beside the report, and aggregates every stored run over a chosen window: pass rate, steps executed, average duration, a per-day pass/fail trend, and the most recent failures with the step and error that caused them. Clicking a row opens that test or suite.

Three breakdowns are included:

- **By project** — one row per folder, since folders are how tests are grouped into projects. Shows how many tests it holds, runs, pass rate, average duration, and a **never run** count so untested work in a project is visible. Suite runs are excluded here: a suite spans tests and so has no single folder.
- **By user** — runs started, split by test vs suite, passed/failed, pass rate, steps executed, average duration, and last activity. Runs recorded before attribution existed appear as "unattributed".
- **Tests** and **Suites** — the same per-subject stats.

A run still in flight counts toward "Runs" but not toward pass or fail, and its pass rate shows as a dash rather than a misleading 0%.

### Notifications

The bell in the header shows unread notifications: when a run you started finishes (with the failing step named if it failed), when someone shares a test with you, and when your access changes. Clicking one jumps to the relevant test or suite.

### AI failure analysis

On a failed step, an **Analyze with AI** button calls Anthropic's Claude API with the step definition, the error, and the failure screenshot, and returns a likely cause and suggested fix. It requires an API key:

```bash
ANTHROPIC_API_KEY=sk-ant-...  npm run ui
# optional: ANTHROPIC_MODEL (default claude-sonnet-5), ANTHROPIC_API_BASE
```

Without the key set, the button is replaced by a note explaining how to enable it — nothing else in the app is affected. Each analysis is cached on the run record, so revisiting a step doesn't re-call the API (use **Re-analyze** to force a fresh call).

## Recording, importing, and exporting

- **Record screen** opens an interactive Chromium screen inside the editor. Click and type directly in it; recorded steps appear below. Select an insertion position and choose **Add to draft** to preserve unsaved work. Password values are omitted. **Capture screenshot step** adds a screenshot action. Complex frame/tab journeys need manual review.
- **Import JSON** (Projects toolbar): accepts a Test Studio export or a **Reflect** export. Reflect steps are mapped to the equivalent actions and their descriptions are kept as notes; anything with no faithful equivalent is reported rather than silently dropped.
- **Export JSON** (test editor → Test actions): downloads the open test as JSON.

Reflect visual comparisons are reported as unsupported because no baseline comparison exists. Scrolls without coordinates and waits without a recorded duration are also reported, rather than assigning fabricated values.

## Per-run report

Every finished run gets a report (in the run panel, and at `GET /api/runs/:id/report`): time spent split into step time versus startup/teardown, steps passed/failed/skipped, the slowest steps with their share of the runtime, time grouped by action, and a per-test breakdown for suites.

It also carries **insights learned from history** — whether a failure is new or long-standing, recovery after a failing streak, flakiness, and whether the run was unusually slow or fast. With `ANTHROPIC_API_KEY` set you can also ask for an AI summary of the whole run.

## Optional database (Docker)

```bash
docker compose up -d
```

Starts Postgres (host port **5433**) plus Adminer on http://localhost:8081. Finished runs are mirrored into it for durable history. This is **additive**: run records are always written to `./runs` as JSON, so with Docker stopped the app and all learning still work — it just logs that the database is unavailable. Check the state at `GET /api/db/status`; a site admin can backfill existing runs with `POST /api/db/import`.


### Branding

The UI carries Mindmatrix branding: navy `#081120`, the arc gradient running blue `#0F8EFB` through violet `#7A4FC8` into orange `#EF6B2A`, and Poppins type. The MMQA mark pairs that arc with a check for the QA half of the story; it lives in `ui/public/brand/` as `mark.svg` (square, also the favicon) and `logo.svg` (horizontal lockup). Poppins loads from Google Fonts with a system fallback, so the UI still looks right offline.

## AI usage and spend

Every call to the model provider is metered. Token counts come from the provider's own `usage` block, so they are reported rather than estimated, and each call is attributed to the person and the thing that triggered it. The **Reports** tab shows spend, tokens in and out, where it goes by feature, and who is spending it.

Prices change, so they are configuration rather than constants:

```bash
AI_PRICE_INPUT=3          # USD per million input tokens
AI_PRICE_OUTPUT=15        # USD per million output tokens
AI_DAILY_TOKEN_CAP=200000 # optional; 0 or unset means no cap
```

Open **Settings → Telemetry · AI usage** (also available from the account menu) to view token consumption, estimated USD spend, date ranges, feature/user breakdowns and daily totals. Site admins see workspace usage; other accounts see their own calls. Reports retains its existing usage panel. Overview now includes live project and user counts.

The limit blocks new calls once recorded usage reaches it. It does not reserve tokens for in-flight calls, so a call or concurrent calls can cross it. Failed provider calls are recorded; when the provider does not return usage, their token count is unknown and the ledger shows zero known tokens. The ledger retains the latest 2,000 calls, so long periods and daily-limit accounting are bounded by that retention. Costs use configured rates, not the provider invoice.

## Project workspace

**Run evidence:** Open **Inspect run** on a browser test/suite or use **Reports → Run history & evidence** for commands, searchable logs, network failures, video, metadata, timing, visual comparison and optional accessibility findings. Configure captures in **Settings → Run evidence**; AI usage remains under **Telemetry**. See [the LambdaTest Automation review and capture limits](docs/RUN_EVIDENCE_UPGRADE.md).

Projects now open in three tabs: **Test cases**, **Requirements**, and **Suites**, each showing its count. The project header remains visible while the selected content scrolls. Add acceptance criteria in Requirements and link the test cases that verify them. See [the project workflow](docs/PROJECTS_UPGRADE.md) for access, storage and navigation details.

## Agent Testing: manual, API and optional AI

Open **Agent Testing → New agent test** and choose a project, environment and testing method:

- **Manual:** describe expected behavior and scenario messages. Start a manual test, follow those messages in your agent's interface, paste the actual replies, then save the evidence and evaluate. No chat API is required. Reports identify these replies as manually entered; timing is not measured.
- **API:** supply the chat endpoint, JSON request template and dot-separated response path. Configure credentials as a server environment variable beginning `MMQA_AGENT_`, containing JSON headers, and reference its name in the form. Each scenario gets a fresh session ID and subsequent messages include the conversation history when configured in the template.
- **Optional AI:** generate draft scenarios from requirements, enable adaptive personas for API tests, or choose AI rubric checks for either testing method. These need `ANTHROPIC_API_KEY` and the `ai.analyze` feature. All evaluator calls use existing token telemetry. Scripted messages and text checks work without the evaluator key; the target API may have its own charges.

Runs retain the plan snapshot, transcript, checks, thresholds, evidence and outcome. Critical failures fail the run; advisory failures, uncertain AI judgments or unverifiable quotes need review. Run a single scenario or the complete saved group, stop an API run, inspect previous runs, and export JSON or JUnit. JUnit treats every non-pass as a failure so incomplete checks do not silently pass CI.

See [the LambdaTest review and supported scope](docs/LAMBDATEST_REVIEW.md) for the comparison, limits, API routes and remaining integrations.

## CI

`.github/workflows/playwright.yml` runs typechecking, JavaScript syntax checks, core regression tests, dependency auditing, and the Studio browser/API tests on every push and pull request to `main`. A failing check fails the job. Reports and traces are uploaded even on failure.

Live JSON tests target the applications configured in `json/`. Run them locally with `npm test`, or choose **run_target_tests** when manually dispatching the workflow. They are separate from Studio verification so routine app checks use disposable local data.

```bash
npm run check          # TypeScript, browser JS syntax, core/storage/server checks
npm run test:studio    # Local API and Chromium user journeys
npm audit             # Dependency advisories
```

Studio tests start a dedicated server on port 4187 with a fresh workspace in the OS temporary directory. They never modify the repository's users, customer tests, suites, or run history. Screenshots are saved under `test-results/`; the verification report is under `playwright-report/studio/`. Temporary workspaces are retained for failure investigation and can be removed after all test servers stop.

## Configuration and operations

See `.env.example`. `npm run ui` reads the process environment; it does not automatically load `.env`. You can explicitly load one with `node --env-file=.env --import tsx ui/server.ts`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface on which the Studio listens |
| `PORT` | `4173` | Studio port |
| `STUDIO_WORKSPACE` | Repository root | Root containing `json/`, `suites/`, `runs/`, and `ui/data/` |
| `MAX_ACTIVE_RUNS` | `2` | Concurrent run limit; excess requests return 429 |
| `RUN_TIMEOUT_MS` | `120000` | Single-test/suite time limit; CLI processes get 30 seconds of shutdown allowance |
| `COOKIE_SECURE` | Off | Set to `1` for HTTPS installations |
| `DB_DISABLED` | Off | Set to `1` to skip the optional Postgres connection |
| `TEST_JSON_DIR` | Workspace `json/` | CLI input override; the Studio uses it for run snapshots |

`GET /api/health` reports process liveness without authentication. Optional database status remains site-admin-only. The Docker database and Adminer ports bind to localhost. Back up `json/`, `suites/`, `ui/data/`, and `runs/` together while the server is stopped; database mirroring does not replace those files. If storage is corrupt, restore a valid backup rather than deleting user or permission files. The server refuses a second writer in the same workspace.

For the reviewed requirements, implemented fixes, verification evidence, and remaining deployment work, see [the upgrade review](docs/UPGRADE_REVIEW.md).
