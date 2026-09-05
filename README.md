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

- See test counts, last-run outcomes, and recent activity in the workspace overview. Browse tests in `json/`, search/filter by status, create new ones, and edit steps in a form driven by the action catalog.
- Run a test and watch each step go green (or red) live, with a screenshot captured after every step (click it to zoom), the error text when a step fails, and console log tail.
- Run history is kept under `runs/<runId>/` (git-ignored). Each single-test run has its own HTML report at `/runs/<runId>/report/`, linked from its run panel. `/report/` is reserved for admin access to legacy CLI reports.

The UI uses the same Playwright JSON runner as the CLI. It sets `RUN_DIR`, which makes `src/JsonRunner.ts` write per-step screenshots and emit `@@STEP` progress lines; plain CLI runs are unaffected.

The UI supplies a private input snapshot and separate output directories to the same JSON runner used by the CLI. Concurrent tests cannot overwrite one another's reports. An empty test can be saved as a draft; running requires at least one valid step. Saving and execution both validate actions against the catalog, including required fields and bounded timeouts. Intentional empty input values are preserved.

### Folders

Tests can be organised into nested folders of any depth. Folders are **virtual**: the JSON files stay flat in `json/`, and the folder path is stored as metadata, so `npm test` and CI discover tests exactly as before. Create folders from the sidebar, and move a test with the folder button under its name.

### Sharing

Every test is visible to the whole team by default (unchanged from before). The **Share** button gives you a direct link to the test and lets the creator (or an admin) restrict it to specific people, each granted either "can view & run" or "can edit". Restricted tests disappear from other people's lists entirely, and the server enforces this on every route, not just in the UI.

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

Feature access is granular. The site admin opens the gear next to a user in **Manage users** and ticks the features that account may use: creating, editing, deleting or running tests, managing folders and suites, viewing reports, using AI analysis, and managing users. Every one of those is enforced server-side.

This is good local-tool hygiene, not a hardened multi-tenant auth system — don't expose this server beyond your own machine/network without more thought.

The server binds to `127.0.0.1` by default. Passwords can be changed from **Password** in the account area; a change revokes other sessions and renews the current one. Authentication attempts are rate limited, browser mutations require the same origin, and responses include security headers. Restricted-test access also governs related suites, historical runs, event streams, screenshots, reports, and AI routes. Recordings belong to their creator; applying them requires test-edit access. Only a run's starter or an admin with the run feature can stop it.

File storage supports one server process per workspace. Writes replace complete JSON files atomically. Invalid account or sharing storage fails closed rather than silently resetting access. On restart, interrupted runs are marked failed with an explanation. Retained sharing metadata protects history after a test is deleted or its filename is reused.

### Reports

The **Reports** tab aggregates every stored run over a chosen window: pass rate, steps executed, average duration, a per-day pass/fail trend, and the most recent failures with the step and error that caused them. Clicking a row opens that test or suite.

Three breakdowns are included:

- **By project** — one row per folder, since folders are how tests are grouped into projects. Shows how many tests it holds, runs, pass rate, average duration, and a **never run** count so untested work in a project is visible. Suite runs are excluded here: a suite spans tests and so has no single folder.
- **By user** — runs started, split by test vs suite, passed/failed, pass rate, steps executed, average duration, and last activity. Runs recorded before attribution existed appear as "unattributed".
- **Tests** and **Suites** — the same per-subject stats.

A run still in flight counts toward "Runs" but not toward pass or fail, and its pass rate shows as a dash rather than a misleading 0%.

### Notifications

The bell in the sidebar shows unread notifications: when a run you started finishes (with the failing step named if it failed), when someone shares a test with you, and when your access changes. Clicking one jumps to the relevant test or suite.

### AI failure analysis

On a failed step, an **Analyze with AI** button calls Anthropic's Claude API with the step definition, the error, and the failure screenshot, and returns a likely cause and suggested fix. It requires an API key:

```bash
ANTHROPIC_API_KEY=sk-ant-...  npm run ui
# optional: ANTHROPIC_MODEL (default claude-sonnet-5), ANTHROPIC_API_BASE
```

Without the key set, the button is replaced by a note explaining how to enable it — nothing else in the app is affected. Each analysis is cached on the run record, so revisiting a step doesn't re-call the API (use **Re-analyze** to force a fresh call).

## Recording, importing, and exporting

- **Record** (test toolbar): enter a URL and a real browser opens. Clicks, typing, dropdowns, checkboxes, and Enter/Escape/Tab become steps, streamed into the panel live. Password fields are recorded as a step but their value is never captured. Selectors prefer `id`, then test ids, `name`, `aria-label`, placeholder, a unique class, then visible text; a positional fallback is flagged **fragile**. Set `RECORDER_HEADLESS=1` on a machine with no display.
- **Import JSON** (sidebar): accepts a Test Studio export or a **Reflect** export. Reflect steps are mapped to the equivalent actions and their descriptions are kept as notes; anything with no faithful equivalent is reported rather than silently dropped.
- **Export** (test toolbar): downloads the open test as JSON.

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
