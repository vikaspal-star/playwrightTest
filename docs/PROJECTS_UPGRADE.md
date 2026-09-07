# Projects, environments and browser recording

## Workflow

- **Projects** replaces Test library. Project cards lead to a single level of Sandbox or Production environments, each with a configurable application URL. The test list is flat and supports the existing search and status filters.
- **New project** creates a project and its first environment. **Add environment** adds another URL under that project. Environment names can distinguish different sandbox installations.
- **New test** asks for a name and destination. Filenames are allocated automatically (`new-test.json`, `new-test-2.json`, etc.). A configured environment URL becomes the first navigation step. An explicit filename supplied through the API still returns a conflict rather than overwriting a test.
- **Move** under the test name previews URL changes for the destination. The user chooses whether to apply them. Input values, selectors, assertions and external URLs are retained; query-bearing URLs and unmatched base paths require manual review. The move never executes the test.
- **Ask AI for a review** uses the existing Anthropic configuration and `ai.analyze` permission. It sends action types, counts and environment types only. It does not send input values, credentials, screenshots or full test definitions. The AI supplies a review checklist; it does not claim to have visited the destination or validated its selectors. Without a configured provider, the deterministic URL preview still works.
- **Add step** offers manual entry or screen recording. **Record after this step** selects an insertion position. Recording appears inside the larger right browser panel; click, type, scroll and use keyboard controls on the actual browser screen. Select menus can be controlled with arrows and Enter. **Capture screenshot step** adds a screenshot action to replay later.
- **Add to draft** inserts recorded steps at the selected position and preserves existing unsaved edits. The opening navigation can be omitted. Replacing all steps is an explicit option. Password steps are captured with an empty value and need configuration before replay.
- **Run** follows the application screen as the saved test executes, including long steps. Completed steps retain their normal screenshots and history. Selecting a completed step pauses following; **Follow live** resumes it. The left navigation can be hidden on desktop, and step details collapse to leave more space for the browser.

## Storage and compatibility

`ui/data/projects.json` contains project/environment IDs and filename assignments. On first access, existing folder roots become projects. A trailing “Sandbox” or “Production” label is separated from the project name. Saved navigation origins supply environment URLs; unfiled tests are grouped by hostname, or under General when no URL exists. Existing tests, folder metadata, sharing controls, suites and run history are not rewritten during this additive migration.

New environments have one level; legacy nested folder paths remain in `testMeta.json` for reference and rollback. Legacy folder APIs continue to accept existing integrations. JSON files stay flat in `json/`, so CLI discovery and suite references are preserved. Reports group tests by their current project assignment.

Each move retains a recovery copy of the original test and assignment under `ui/data/project-moves/` before making changes. Preview revisions include the test, metadata, source and destination; a concurrent change invalidates the preview. Provider responses never directly mutate saved tests. A failed assignment write restores the test content; the recovery copy also supports manual recovery from an interrupted process between filesystem writes. File storage remains a single-writer workspace, not a transactional database.

Back up `json/`, `suites/`, `runs/` and `ui/data/` together before upgrading. Rolling back the code leaves original folder metadata intact. Restore both the test and assignment from a move recovery copy when undoing a URL adaptation. Do not remove existing user data to apply this UI upgrade.

## Verification and limits

`npm run check` verifies TypeScript, browser JavaScript syntax, validation, migration, access control, move revision checks, automatic filenames and URL adaptation using disposable data. `npm run test:studio` exercises authenticated user journeys, responsive layouts, embedded mouse/keyboard recording, password redaction, draft preservation, run cancellation and live playback against a local fixture application.

The Studio fixture launches a direct server child so teardown does not depend on Windows shell `taskkill`. Customer JSON workflows and paid provider calls are separate acceptance checks and are not executed by these tests. The concurrent Projects/recording changes are retained: CDP streams supply browser frames, the existing screen API remains available with ownership checks, background clicks are ignored, and the navigation drawer remembers its setting (toggle with the menu button or `\` outside form fields).

The embedded browser supports the recorder's interaction actions. Complex iframe and popup journeys currently display a review warning and need explicit frame/tab actions from the manual action catalog. It is a Chromium screen with event recording, not a video editor or visual-baseline assertion system. Frame updates are transient; per-step run screenshots continue to persist as before. Screen/input APIs require the recording owner and same-origin authenticated requests. Two active recording sessions are allowed, including sessions still launching.

MMQA remains a trusted-team local browser automation tool. This upgrade does not turn existing browser/file access into public multi-tenant isolation. Optional PostgreSQL mirroring and the existing provider configuration remain unchanged.
