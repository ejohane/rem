# Daily Notes Plugin Spec

**Document status:** Draft (implementation-ready)
**Owner:** rem core/ui
**Last updated:** 2026-02-13
**Related docs:** `docs/plugin-runtime-spec.md`, `docs/data-contracts.md`, `docs/api-cli-reference.md`, `docs/runbook.md`

## 1) Scope and confirmed product decisions

This spec defines a new Daily Notes plugin capability that:

1. Creates one daily note per local calendar day.
2. Uses an English display title format exactly like `Monday Jan 15th 2026`.
3. Opens today's daily note by default on app startup, creating it if missing.
4. Adds a command palette `Today` command that opens today's note, creating it if missing.
5. Makes daily notes discoverable by:
   - full display title
   - date input formats:
     - `M-D-YYYY`
     - `MM-DD-YYYY`
     - `M/D/YYYY`
     - `MM/DD/YYYY`
     - `YYYY-MM-DD`

Confirmed decisions from product:

1. Timezone: local timezone.
2. Language/format: English only.
3. Note type: `note`.
4. Default tag: include `daily`.
5. Startup behavior: always open/create today's note.
6. Plugin lifecycle: auto-bootstrap and enable by default.
7. Command palette scope: only `Today` (no other commands in this feature).

## 2) Why this needs careful design

Current codebase constraints that materially affect implementation:

1. UI has no command palette implementation yet (`apps/ui/src/App.tsx`).
2. UI command host contracts exist (`apps/ui/src/plugin-commands.ts`) but are not wired into the app shell.
3. Search passes raw query directly to SQLite FTS (`packages/index-sqlite/src/index.ts`), and queries like `1-15-2026` currently throw SQL/FTS errors.
4. `applyPluginTemplate` creates a new note every call (not idempotent), so it cannot be used directly for "open today's note" behavior.

## 3) Functional requirements

## 3.1 Daily note identity

For each local day, there must be exactly one canonical daily note:

1. Date key format: `YYYY-MM-DD` in local timezone.
2. Deterministic note id: `daily-YYYY-MM-DD`.
3. Deterministic title: `Monday Jan 15th 2026` style with ordinal suffix.
4. If a daily note already exists for the date key, open it.
5. If it does not exist, create it once and reuse it thereafter.

## 3.2 Entry points that must share one code path

All of the following must use the same get-or-create logic:

1. App startup.
2. Command palette `Today`.
3. API route for daily-note open/create.

## 3.3 Search behavior

Searching must support:

1. Full display title text.
2. Numeric date input formats listed above.
3. No hard errors on hyphen/slash date queries.

## 4) Data and contract design

## 4.1 Plugin namespace and metadata

Plugin namespace: `daily-notes`.

Daily metadata is stored in note meta under `plugins["daily-notes"]`:

```json
{
  "dateKey": "2026-01-15",
  "shortDate": "1-15-2026",
  "displayTitle": "Monday Jan 15th 2026",
  "timezone": "America/New_York"
}
```

Notes:

1. This metadata is used for deterministic behavior and diagnostics.
2. It is not currently indexed by note FTS, so date-format search support requires query normalization logic (see section 6).

## 4.2 Plugin manifest

Implement as a built-in static plugin manifest (`manifestVersion: v2`):

1. `namespace`: `daily-notes`
2. `capabilities`: `["templates"]` minimum (optionally `["templates", "cli_actions"]` if runtime action is added later)
3. `permissions`: `["notes.read", "notes.write", "search.read"]`
4. `templates`: one `daily` template with lightweight starter lexical content

## 4.3 Note defaults

1. `noteType`: `note`
2. `tags`: include `daily`
3. `title`: generated display title

## 5) Core service design

Add a dedicated core method (single source of truth), for example:

1. `getOrCreateDailyNote({ timezone?, actor? })`

Responsibilities:

1. Resolve timezone (`input.timezone` if provided, otherwise host-local timezone).
2. Compute local date key and title.
3. Resolve deterministic note id.
4. Attempt read by note id:
   - if exists, return existing record (`created=false`)
   - if missing, save new note with daily defaults (`created=true`)
5. Always return stable response payload:
   - `noteId`, `created`, `title`, `dateKey`, `shortDate`, `timezone`

## 5.1 Race/idempotency guard

Potential race: two simultaneous calls for the same day can both observe "missing" before write.

To avoid duplicate `note.created` events:

1. Add an in-process keyed mutex around daily get-or-create by `noteId`.
2. Re-check existence inside the critical section before create.

This is required for deterministic behavior across startup and command invocation bursts.

## 5.2 Collision handling

If a note already exists at deterministic id but does not carry valid daily metadata:

1. Return an explicit conflict error (`daily_note_id_conflict`) instead of silently overwriting.
2. Include the conflicting `noteId` and current title in error payload.

This prevents accidental takeover of manually created notes.

## 6) Search design

## 6.1 Date query normalization

Before executing normal note search:

1. Try parse input as one of supported date formats.
2. If parse succeeds:
   - compute the expected daily title for that date in local timezone
   - search using safe FTS title tokens (not raw `1-15-2026`)
3. Return matching notes normally.

## 6.2 FTS safety hardening

Current raw `MATCH` input can error for punctuation-heavy queries.

Add a search query sanitizer/fallback path in `packages/index-sqlite`:

1. Keep current behavior for normal queries.
2. If raw query triggers SQLite/FTS parse error, retry with sanitized token query.
3. Ensure API returns empty results (or best-effort matches), never a runtime failure, for malformed FTS expressions.

This hardening is required beyond Daily Notes because it protects global search stability.

## 7) API/UI design

## 7.1 API endpoint

Add endpoint:

1. `POST /daily-notes/today`

Request body (optional):

```json
{
  "timezone": "America/New_York",
  "actor": { "kind": "human", "id": "ui" }
}
```

Response:

```json
{
  "noteId": "daily-2026-01-15",
  "created": true,
  "title": "Monday Jan 15th 2026",
  "dateKey": "2026-01-15",
  "shortDate": "1-15-2026",
  "timezone": "America/New_York"
}
```

## 7.2 UI startup behavior

On initial app load:

1. Resolve client local timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
2. Call `POST /daily-notes/today`.
3. Open returned `noteId`.

By product decision, this always overrides draft-first startup behavior.

## 7.3 Command palette and Today command

Implement a minimal command palette in app shell:

1. Keyboard shortcut: `Cmd/Ctrl + K`.
2. Single command item: `Today`.
3. On run: call `POST /daily-notes/today` with local timezone and open returned note.
4. If call fails, surface actionable error state in UI.

## 8) Plugin bootstrap policy

At API startup (or core boot boundary), ensure built-in plugin is present and active:

1. Register if missing.
2. Install if still `registered`.
3. Enable if `installed` or `disabled` (subject to normal lifecycle rules).

Bootstrap must be idempotent and should not emit redundant lifecycle events on every startup.

## 9) Documentation updates required

The following docs should be updated in the same feature PR:

1. `docs/api-cli-reference.md`
   - new `POST /daily-notes/today` route contract
   - date-query normalization behavior in search notes section
2. `docs/data-contracts.md`
   - `plugins["daily-notes"]` payload contract
   - any new error code (`daily_note_id_conflict`) and route behavior
3. `docs/runbook.md`
   - operational validation steps for daily-note creation/open path
   - startup bootstrap verification steps
4. `docs/plugin-consumer-guide.md`
   - built-in daily-notes plugin behavior and expectations
5. `docs/design.md`
   - reference that daily notes are now first-class implemented plugin capability, not just example

## 10) Test plan and coverage strategy

## 10.1 Unit coverage

### Core (`packages/core/src/core.test.ts`)

1. `getOrCreateDailyNote` creates note when missing.
2. Repeated call returns same note id with `created=false`.
3. Title formatting correctness for ordinal days:
   - `1st`, `2nd`, `3rd`, `4th`, `11th`, `12th`, `13th`, `21st`, `22nd`, `23rd`, `31st`
4. Timezone correctness across boundary times (same UTC instant, different local day).
5. Conflict path when deterministic id exists with non-daily metadata.
6. Concurrency test: two concurrent requests produce one created event.

### Index/search (`packages/index-sqlite/src/index.test.ts`)

1. Hyphen date query no longer throws.
2. Slash date query no longer throws.
3. Sanitized fallback returns deterministic empty-or-results behavior without exception.

### Date parser utility tests (new small unit module)

1. All accepted input formats parse correctly.
2. Invalid dates rejected (`2/30/2026`, bad tokens).
3. Leap-day valid/invalid behavior (`2/29/2024` valid, `2/29/2025` invalid).

## 10.2 API integration coverage (`apps/api/src/index.test.ts`)

1. `POST /daily-notes/today` create path.
2. `POST /daily-notes/today` existing path (idempotent).
3. Startup bootstrap ensures plugin active.
4. Search endpoint with numeric date formats returns daily notes.
5. Search endpoint date-format queries never return server error.

## 10.3 UI coverage (`apps/ui/src/app.test.tsx` + new UI tests)

1. App startup requests/open today note.
2. Command palette opens with shortcut.
3. `Today` command opens existing note.
4. `Today` command creates note when missing.
5. Error state visible when daily-note API call fails.

## 10.4 End-to-end matrix additions

Extend existing fixture matrix coverage to include:

1. Startup -> today note open/create.
2. Command palette -> today open/create.
3. Search by:
   - full title
   - `M-D-YYYY`
   - `MM-DD-YYYY`
   - `M/D/YYYY`
   - `MM/DD/YYYY`
   - `YYYY-MM-DD`

## 10.5 Quality gates

For this feature to be accepted:

1. `bun run lint`
2. `bun run typecheck`
3. `bun run test`

Coverage is considered adequate only if all four layers pass:

1. core logic
2. index/search safety
3. API contracts
4. UI entry points

## 11) Implementation phases

1. Add date/title utility + parser + tests.
2. Add core daily get-or-create API + mutex + tests.
3. Add API route + bootstrap wiring + tests.
4. Add search normalization/sanitization + tests.
5. Add UI startup flow + command palette Today command + tests.
6. Update documentation listed in section 9.

## 12) Risks and mitigations

1. **Risk:** timezone mismatch between browser and API host.
   - **Mitigation:** UI passes timezone explicitly on request.
2. **Risk:** deterministic-id collision with manual notes.
   - **Mitigation:** explicit conflict error and no overwrite.
3. **Risk:** FTS query regressions from sanitization.
   - **Mitigation:** fallback-only sanitization plus regression tests for current successful queries.
4. **Risk:** startup behavior feels surprising for users expecting previous note.
   - **Mitigation:** intentional by product decision; document in release notes and runbook.

## 13) Acceptance criteria

1. Launching app always opens today's daily note.
2. Missing daily note is created exactly once and reused.
3. `Today` command always opens/creates today's note.
4. Full display-title search finds daily note.
5. All supported numeric date formats find daily note.
6. Hyphen/slash date searches do not throw runtime search errors.
7. Full quality gates pass with added coverage in core/index/api/ui layers.
