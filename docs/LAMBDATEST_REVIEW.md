# LambdaTest Agent Testing review and MMQA upgrade

The later Automation dashboard review and run-detail upgrade are documented in [Run evidence upgrade](RUN_EVIDENCE_UPGRADE.md), covering every tab in the user's shared Automation run.

Reviewed 2026-09-07. Local `feat/test-studio` and the remote branch both started at `15dbf01`. Existing Projects, environments, embedded recording, departments and usage metering were retained. The missing `src/liveScreen.ts` dependency is included in the upgrade so a fresh checkout can start the current server.

## What was reviewed

The exact shared [LambdaTest Agent Testing page](https://agent-to-agent.lambdatest.com/agent-ui) was inspected in the signed-in browser. It displayed the Agent Testing introduction and Upgrade Now / Schedule a Demo gate. No purchase, demo booking or paid LambdaTest run was performed. Hidden workflows were not inspected.

The current public documentation is branded TestMu AI (formerly LambdaTest). Its [architecture guide, updated August 25](https://www.testmuai.com/support/docs/architecture-and-how-evaluation-works/) describes a requirements → scenarios → conversations → evaluation → verdict workflow. This is testing the behavior of a conversational agent, distinct from using AI to author browser tests.

The [chat testing guide, updated August 25](https://www.testmuai.com/support/docs/chat-agent/) documents scenario goals/personas, custom validation, reusable test data, endpoint configuration, suites and historical results. The [chat API integration guide, updated August 18](https://www.testmuai.com/support/docs/chat-agent-api-integration/) describes HTTP POST with adaptable JSON requests, authentication headers and response extraction. The [evaluation guide](https://www.testmuai.com/support/docs/ai-agent-testing-platform-overview/) describes configurable scores, thresholds, evidence and aggregate readiness. These documents guided the implementation; they are not evidence of paid-account feature availability.

## Delivered behavior

| Requirement | MMQA implementation |
| --- | --- |
| Dedicated workflow | Agent Testing navigation, saved agent library, Connection / Scenarios / Results sections |
| Project context | Existing project and environment IDs validated on save and execution |
| Manual testing | Tester follows saved messages and enters observed replies; no endpoint needed; evidence explicitly marked manual |
| API testing | Exact HTTPS endpoint (HTTP allowed for localhost), POST JSON templates, nested response extraction |
| Authentication | Server-side JSON header variables named `MMQA_AGENT_…`; credentials are not returned by the configuration API |
| Data and session continuity | Typed `{{message}}`, `{{messages}}`, `{{sessionId}}`, `{{profile.key}}` values; separate session per scenario/iteration |
| Reusable scenarios | Name, persona, goal, scripted messages and expected behavior; save/edit with revision conflicts |
| Optional AI generation | Requirements produce draft scenarios for human review; user explicitly starts generation |
| Optional AI conversation | API scenarios can use bounded adaptive follow-ups; manual scenarios use recorded scripted turns |
| Optional AI evaluation | Rubric checks scored against configurable thresholds; provider output and transcript quotes validated |
| Non-AI checks | Case-insensitive reply contains/excludes checks across assistant replies; no evaluator tokens |
| Evidence and history | Saved plan snapshots, transcripts, checks and errors; API response latency; last 50 runs listed |
| Regression execution | Run one scenario or all scenarios in the agent test; API iterations 1–3; manual entry once per evaluation |
| Controls | Stop active runs, request/run timeouts, per-server agent concurrency limit and bounded response size |
| Export | JSON evidence and JUnit; non-passes fail JUnit, including review/cancelled/incomplete results |
| Access | `agents.manage` controls entry; plans and results private to owner/site admin; AI additionally requires `ai.analyze` |
| Telemetry | Settings menu and account-menu shortcut; token/spend cards including zero state, period/refresh, feature/user/day breakdowns |
| Overview | Live project and account totals alongside the existing test health metrics |

AI generation and evaluation send the entered requirements and relevant conversation to the configured model provider. Target authentication headers are only used to call the configured agent. API tests can reach the host's network within MMQA's existing trusted-team boundary. Redirects are rejected; the server does not forward authentication through a redirected URL. No customer endpoint was supplied for live acceptance, so automated verification uses an isolated local fixture and mocked evaluator responses.

## Verdict semantics

All configured checks passing produces **Passed** for the tested scenario. A critical check failure produces **Failed**. Advisory failures, low-confidence AI scores, missing checks and invented/mismatched evidence produce **Needs review**. Transport/provider failures produce **Error**. Cancellation or the whole-run timeout produces **Cancelled**. Incomplete runs never pass.

AI evidence must quote an actual assistant transcript entry. This guards structural integrity, not model judgment quality: even a valid quote can be interpreted incorrectly. Results describe the sampled conversations, not production certification or parity with LambdaTest's aggregate confidence model. Manual timestamps are entry/evaluation times, not original chat timestamps.

## Limits and remaining gaps

- Chat conversations only. Voice, real phone calls, video avatars and image analysis are not implemented.
- No PDF/DOCX knowledge ingestion, Jira/Confluence synchronization, Postman import, multi-phase login/session-setup endpoints, WebSocket/SSE target transports, or automatic extraction of server-created session tokens. A custom adapter is needed if the target does not accept the configured POST template and client session/history.
- Test data is reusable within a saved agent test. A separate cross-agent profile library, named threshold profiles, cross-agent suite management, scheduled runs and a standalone agent CLI remain future work. Authenticated HTTP routes and JUnit export are available now.
- No automatic claim to all vendor quality dimensions. Users define observable text checks or AI rubrics appropriate to their requirements. AI-generated scenarios must be reviewed.
- Maximum 12 scenarios, 8 turns and 8 checks each; API iterations 1–3; 1–30-second target timeout; 10-minute whole-run timeout; 256 KB response body and 12,000-character reply limit. `MAX_ACTIVE_RUNS` independently limits agent runs (default 2).
- Plans and runs use local JSON storage, protected by the existing single-writer workspace lock. There is no new database mirroring, distributed worker isolation or immutable audit log. Back up `ui/data/` with the rest of the workspace.
- Telemetry records provider-reported input/output tokens. It retains 2,000 calls; configured prices are estimates. Missing usage is not proof of zero cost. The existing daily guard checks recorded totals before a call and can be exceeded by in-flight requests or undercount after retention truncation. Target API charges are separate from evaluator usage.

## HTTP routes

All routes require the Studio session and same-origin checks on writes. Agent routes also require `agents.manage` and enforce owner/site-admin access.

| Route | Purpose |
| --- | --- |
| `GET/POST /api/agent-tests` | List accessible plans / create a plan |
| `PUT /api/agent-tests/:id` | Save `{revision, plan}`; stale revision returns 409 |
| `POST /api/agent-tests/generate` | Generate scenario drafts from `{requirements}`; AI permission required |
| `POST /api/agent-tests/:id/run` | Start with `{revision, scenarioIndex?}`; manual plans also require `manualReplies: string[][]` matching the selected scenarios/messages |
| `GET /api/agent-tests/:id/runs` | Recent execution summaries |
| `GET /api/agent-tests/runs/:runId` | Plan snapshot and full conversation results |
| `POST /api/agent-tests/runs/:runId/cancel` | Abort an active run |
| `GET /api/agent-tests/runs/:runId/export?format=json\|junit` | Download completed evidence |
| `GET /api/overview/counts` | Aggregate project/account totals only |
| `GET /api/ai/usage?days=30` | Workspace telemetry for site admins; personal telemetry for other users; no subjects, prompts, replies or provider error text |

## Verification

`npm run check` covers TypeScript, both frontend scripts, existing regression tests and the new engine/transport tests. The Studio browser journey checks creation, real multi-turn POST requests against a disposable local fixture, export, owner isolation, revision conflicts, cancellation, manual testing without API calls, overview counts and telemetry privacy. Desktop and mobile screenshots are inspected. Paid provider calls and the customer's actual agent remain deployment acceptance checks.

Restart `npm run ui` after backend updates. Seeing the new navigation with “API route not found” means an older server process is still serving the newly changed static UI. The local server must load the upgraded routes too.
