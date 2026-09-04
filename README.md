# playwright-json-framework

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

## Test Studio (web UI)

A local, Reflect-style UI for building and running the JSON tests:

```bash
npm run ui               # http://localhost:4173
```

- Browse every test in `json/`, search/filter by status, create new ones, and edit steps in a form driven by the action catalog.
- Run a test and watch each step go green (or red) live, with a screenshot captured after every step (click it to zoom), the error text when a step fails, and console log tail.
- Run history is kept under `runs/<runId>/` (git-ignored). The Playwright HTML report for the last run is served at `/report/`.

The UI runs the exact same Playwright command as CI. It sets `RUN_DIR`, which makes `src/JsonRunner.ts` write per-step screenshots and emit `@@STEP` progress lines; plain CLI runs are unaffected.

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
| Member | Only what the site admin grants. Defaults to running tests and suites and viewing reports. |

Feature access is granular. The site admin opens the gear next to a user in **Manage users** and ticks the features that account may use: creating, editing, deleting or running tests, managing folders and suites, viewing reports, using AI analysis, and managing users. Every one of those is enforced server-side.

This is good local-tool hygiene, not a hardened multi-tenant auth system — don't expose this server beyond your own machine/network without more thought.

### Reports

The **Reports** tab aggregates every stored run over a chosen window: pass rate, steps executed, average duration, a per-day pass/fail trend, and the most recent failures with the step and error that caused them. Clicking a row opens that test or suite.

Three breakdowns are included:

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

## Per-run report

Every finished run gets a report (in the run panel, and at `GET /api/runs/:id/report`): time spent split into step time versus startup/teardown, steps passed/failed/skipped, the slowest steps with their share of the runtime, time grouped by action, and a per-test breakdown for suites.

It also carries **insights learned from history** — whether a failure is new or long-standing, recovery after a failing streak, flakiness, and whether the run was unusually slow or fast. With `ANTHROPIC_API_KEY` set you can also ask for an AI summary of the whole run.

## Optional database (Docker)

```bash
docker compose up -d
```

Starts Postgres (host port **5433**) plus Adminer on http://localhost:8081. Finished runs are mirrored into it for durable history. This is **additive**: run records are always written to `./runs` as JSON, so with Docker stopped the app and all learning still work — it just logs that the database is unavailable. Check the state at `GET /api/db/status`; a site admin can backfill existing runs with `POST /api/db/import`.

## CI

`.github/workflows/playwright.yml` runs the suite on every push and pull request to `main` and uploads the Playwright and Allure reports as artifacts.
