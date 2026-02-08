# rem Data Contracts

This document defines canonical and derived data contracts for V1/Phase 2.

## Canonical filesystem contracts

Canonical root (`REM_STORE_ROOT`, default `./rem_store`):

```text
rem_store/
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
  events/YYYY-MM/YYYY-MM-DD.jsonl
  index/rem.db
```

Contract rules:
- Canonical writes are atomic (`tmp -> fsync -> rename`).
- Canonical files are schema-validated before persist.
- Canonical events are append-only JSONL.
- SQLite is derived and rebuildable from canonical files/events.

## Derived SQLite contracts

Primary tables:
- `notes`, `note_text`, `notes_fts`
- `sections`
- `proposals`
- `plugins`
- `events`

Indexing constraints:
- Notes, sections, proposals, and plugins are upserted on successful canonical writes.
- Event rows are append-only (`INSERT OR IGNORE` by `event_id`).
- `rebuild-index` recreates `index/rem.db` and repopulates from canonical source.
- Search supports filters on:
  - `tags` (from `notes.tags_json`)
  - `createdSince` / `createdUntil` (from `notes.created_at`)
  - `updatedSince` / `updatedUntil` (from `notes.updated_at`)
  - `noteTypes` (from `notes.meta_json.noteType`)
  - `pluginNamespaces` (from `notes.meta_json.plugins` keys)

## Rebuild invariants

After `rebuild-index`:
1. `notes`, `proposals`, and `plugins` counts match canonical directories.
2. `events` count equals valid event JSONL lines (truncated final line tolerated).
3. Search and section/proposal lookup parity is preserved for stable corpus.
4. Rebuilt index contains same logical results as incremental indexing for existing data.

## Event catalog (Phase 2)

| Event type | Entity kind | Key payload fields |
| --- | --- | --- |
| `note.created` | `note` | `noteId`, `title`, `tags` |
| `note.updated` | `note` | `noteId`, `title`, `tags`, proposal apply metadata |
| `proposal.created` | `proposal` | `proposalId`, `noteId`, `sectionId`, `proposalType`, `status` |
| `proposal.accepted` | `proposal` | `proposalId`, `noteId`, `sectionId`, `proposalType`, `status`, apply metadata |
| `proposal.rejected` | `proposal` | `proposalId`, `noteId`, `sectionId`, `proposalType`, `status` |
| `plugin.registered` | `plugin` | `namespace`, `schemaVersion`, `registrationKind` |
| `plugin.updated` | `plugin` | `namespace`, `schemaVersion`, `registrationKind` |
| `schema.migration_run` | `note` | `noteId`, `migration`, section-index version transition metadata |

## Plugin manifest contract

Plugin manifest (`plugins/<namespace>/manifest.json`) fields:
- `namespace`
- `schemaVersion`
- `payloadSchema`
  - `type` must be `"object"`
  - `required` string array
  - `properties` map of `{ type, items? }`
  - `additionalProperties` boolean

Plugin metadata (`plugins/<namespace>/meta.json`) fields:
- `namespace`
- `schemaVersion`
- `registeredAt`
- `updatedAt`
- `registrationKind` (`static` or `dynamic`)

### Note payload validation rule

On note writes, every key in `meta.plugins`:
1. Must have a registered plugin manifest.
2. Must satisfy that plugin’s `payloadSchema` required fields and property types.

### Note metadata contract additions

`notes/<noteId>/meta.json` includes:
- `noteType` (string, defaults to `"note"`)
- `plugins` object keyed by plugin namespace
- `sectionIndexVersion` (`"v2"` for durable section identity model)

These fields back note-type and plugin-facet search filters.

### Section identity durability contract

- `notes/<noteId>/sections.json` is canonical for section identity.
- Section IDs are preserved across heading renames/re-parenting through content-fingerprint carry-forward.
- `fallbackPath` remains a secondary locator for proposal resolution/debugging.
- Section migrations use:
  - CLI: `rem migrate sections --json`
  - API: `POST /migrations/sections`
- Migration emits `schema.migration_run` events for migrated notes.

### API auth contract

- If `REM_API_TOKEN` is unset, API accepts unauthenticated localhost requests.
- If `REM_API_TOKEN` is set:
  - Requests must include `Authorization: Bearer <token>`
  - Missing/invalid token returns:
    - `401`
    - `{"error":{"code":"unauthorized","message":"Invalid or missing bearer token"}}`

## Versioning expectations

- Canonical objects include `schemaVersion`.
- Event payloads are schema-versioned via `event.schemaVersion`.
- Plugin manifest `schemaVersion` is independent per plugin namespace.
- Migration posture remains non-destructive by default; `rebuild-index` is the primary repair path.
