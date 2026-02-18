# rem Data Contracts

This document defines canonical and derived data contracts for Plugin Runtime v1.

## Canonical filesystem contracts

Canonical root (`REM_STORE_ROOT`, default `~/.rem`):

```text
~/.rem/
  notes/<noteId>/
    note.json
    meta.json
    sections.json
  proposals/<proposalId>/
    proposal.json
    content.json
    meta.json
  plugins/<namespace>/
    manifest.json
    meta.json
  entities/<namespace>.<entityType>/<entityId>/
    entity.json
    meta.json
  runtime/
    scheduler-ledger.json
  events/YYYY-MM/YYYY-MM-DD.jsonl
  index/rem.db
```

Contract rules:
- Canonical writes are atomic (`tmp -> fsync -> rename`).
- Canonical files are schema-validated before persist.
- Canonical events are append-only JSONL.
- SQLite is derived and rebuildable from canonical files/events.

## Plugin manifest and lifecycle contracts

Plugin manifest (`plugins/<namespace>/manifest.json`) is normalized to the v2 shape when possible.

Key fields:
- `manifestVersion` (`"v2"` for v2 manifests)
- `namespace`
- `schemaVersion`
- `remVersionRange`
- `capabilities` (`templates`, `scheduled_tasks`, `entities`, `cli_actions`, `ui_panels`)
- `permissions` (`notes.read`, `notes.write`, `search.read`, `events.read`, `proposals.create`, `proposals.review`, `entities.read`, `entities.write`)
- capability-specific sections (`templates`, `scheduledTasks`, `entityTypes`, `cli`, `ui`)

Plugin metadata (`plugins/<namespace>/meta.json`) fields:
- `namespace`
- `schemaVersion`
- `registeredAt`
- `updatedAt`
- `registrationKind` (`static` or `dynamic`)
- `lifecycleState` (`registered`, `installed`, `enabled`, `disabled`)
- optional lifecycle timestamps (`installedAt`, `enabledAt`, `disabledAt`)
- optional `disableReason`

Built-in plugin behavior:
- `daily-notes` is bootstrapped as a static plugin by the API host and transitioned to `enabled` by default.

Lifecycle semantics:
- `register` creates/updates manifest + metadata.
- `install` transitions plugin to `installed`.
- `enable` transitions plugin to `enabled`.
- `disable` transitions plugin to `disabled` with `disableReason`.
- `uninstall` transitions plugin back to `registered`.
- Expanding requested permissions on `register` forces `lifecycleState=disabled` with `disableReason=permissions_expanded` until explicit re-enable.

## Plugin-defined entity contracts

Entity record (`entities/<namespace>.<entityType>/<entityId>/entity.json`) fields:
- `id`
- `namespace`
- `entityType`
- `schemaVersion`
- `data` (validated against plugin-declared entity schema)

Entity metadata (`entities/<namespace>.<entityType>/<entityId>/meta.json`) fields:
- `createdAt`
- `updatedAt`
- `actor`
- optional `links`

`links` contract:
- note link: `{ "kind": "note", "noteId": "..." }`
- entity link: `{ "kind": "entity", "namespace": "...", "entityType": "...", "entityId": "..." }`

Mixed-version reads:
- entity `schemaVersion` may differ from plugin manifest `schemaVersion` during migration windows
- reads expose compatibility mode (`current` or `mixed`)

## Daily notes plugin payload contract

Daily-note records store plugin metadata under `notes/<noteId>/meta.json` at `plugins["daily-notes"]`:

```json
{
  "dateKey": "2026-01-15",
  "shortDate": "1-15-2026",
  "displayTitle": "Thursday Jan 15th 2026",
  "timezone": "UTC"
}
```

Contract semantics:
- canonical daily-note id is deterministic: `daily-YYYY-MM-DD`
- payload must satisfy registered plugin schema (`dateKey`, `shortDate`, `displayTitle`, `timezone`)
- id collisions with non-daily payloads return `daily_note_id_conflict` on get-or-create API flow

## Scheduler ledger contract

`runtime/scheduler-ledger.json` fields:
- `schemaVersion` (`"v1"`)
- `updatedAt`
- `entries[]` where each entry includes:
  - `dedupeKey`
  - `namespace`
  - `taskId`
  - `actionId`
  - `idempotencyKey` (`calendar_slot` or `action_input_hash`)
  - `scheduledFor`
  - `slotKey`
  - `timezone`
  - `executedAt`

Ledger semantics:
- scheduler execution is deduplicated by `dedupeKey`
- repeated runs for the same dedupe key are skipped idempotently

## Derived SQLite contracts

Primary tables:
- `notes`, `note_text`, `notes_fts`
- `sections`
- `proposals`
- `plugins`
- `entities`
- `entity_links`
- `entities_fts`
- `events`

Indexing constraints:
- notes, sections, proposals, plugins, and entities are upserted on successful canonical writes.
- `entity_links` is rebuilt from entity metadata `links`.
- event rows are append-only (`INSERT OR IGNORE` by `event_id`).
- `rebuild-index` recreates `index/rem.db` and repopulates from canonical source.

Search/index features:
- note search supports `tags`, `createdSince/Until`, `updatedSince/Until`, `noteTypes`, `pluginNamespaces`.
- API search normalizes supported date strings (`M-D-YYYY`, `MM-DD-YYYY`, `M/D/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`) into daily display-title search queries.
- malformed/punctuation-heavy note queries are sanitized/fallbacked instead of surfacing SQLite FTS parser failures.
- entity listing/search supports namespace/type/schemaVersion filters and entity FTS snippets.

## Event catalog (Plugin Runtime v1)

| Event type | Entity kind | Key payload fields |
| --- | --- | --- |
| `note.created` | `note` | `noteId`, `title`, `tags` |
| `note.updated` | `note` | `noteId`, `title`, `tags`, proposal apply metadata |
| `proposal.created` | `proposal` | `proposalId`, `noteId`, `sectionId`, `proposalType`, `status` |
| `proposal.accepted` | `proposal` | `proposalId`, `noteId`, `sectionId`, `proposalType`, `status`, apply metadata |
| `proposal.rejected` | `proposal` | `proposalId`, `noteId`, `sectionId`, `proposalType`, `status` |
| `plugin.registered` | `plugin` | `namespace`, `schemaVersion`, `registrationKind`, `lifecycleState` |
| `plugin.updated` | `plugin` | `namespace`, `schemaVersion`, `registrationKind`, `lifecycleState`, `permissionsExpanded` |
| `plugin.installed` | `plugin` | `namespace`, `lifecycleState`, `previousLifecycleState` |
| `plugin.activated` | `plugin` | `namespace`, `lifecycleState`, `previousLifecycleState` |
| `plugin.deactivated` | `plugin` | `namespace`, `lifecycleState`, `previousLifecycleState`, `disableReason` |
| `plugin.uninstalled` | `plugin` | `namespace`, `lifecycleState`, `previousLifecycleState` |
| `plugin.action_invoked` | `plugin` | `namespace`, `actionId`, `requestId`, `host`, `actorKind`, `durationMs`, `inputBytes`, `outputBytes`, `status=success` |
| `plugin.action_failed` | `plugin` | `namespace`, `actionId`, `requestId`, `host`, `actorKind`, `durationMs`, `status=failure`, `errorCode`, `errorMessage` |
| `plugin.task_ran` | `plugin` | `namespace`, `taskId`, `actionId`, `scheduledFor`, `status`, `durationMs`, optional error details |
| `entity.created` | `plugin` | `namespace`, `entityType`, `entityId`, `schemaVersion` |
| `entity.updated` | `plugin` | `namespace`, `entityType`, `entityId`, `schemaVersion`, `previousSchemaVersion` |
| `schema.migration_run` | `note` | `noteId`, `migration`, section-index version transition metadata |

## Plugin action error mapping contract

Guard/runtime failures map to stable action error codes in both CLI and API hosts:

| Runtime failure | Error code |
| --- | --- |
| timeout | `plugin_action_timeout` |
| input payload too large | `plugin_input_too_large` |
| output payload too large | `plugin_output_too_large` |
| per-plugin concurrency limit reached | `plugin_concurrency_limited` |
| unclassified runtime failure | `plugin_run_failed` |

## Proposal-first trust contract for agent plugin writes

For plugin runtime `core.saveNote`:
- agent actors must use `core.createProposal` for note mutations by default
- direct agent note writes require explicit override metadata (`overrideReason`)

## API auth contract

- If `REM_API_TOKEN` is unset, API accepts unauthenticated localhost requests.
- If `REM_API_TOKEN` is set, all API routes (including plugin action runtime routes) require `Authorization: Bearer <token>`.
- Missing/invalid token returns:
  - `401`
  - `{"error":{"code":"unauthorized","message":"Invalid or missing bearer token"}}`

## Rebuild invariants

After `rebuild-index`:
1. `notes`, `proposals`, `plugins`, and `entities` counts match canonical directories.
2. `events` count equals valid event JSONL lines (truncated final line tolerated).
3. section/proposal/entity lookup parity is preserved for stable corpus.
4. rebuilt index contains the same logical results as incremental indexing for existing data.

## Versioning expectations

- canonical objects include `schemaVersion`.
- event payloads are schema-versioned via `event.schemaVersion`.
- plugin manifest `schemaVersion` is independent per plugin namespace.
- entity `schemaVersion` may temporarily differ from manifest schemaVersion during planned migrations.
- migration posture remains non-destructive by default; `rebuild-index` is the primary repair path.
