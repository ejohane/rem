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
  drafts/<draftId>/
    note.json
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
- `drafts`
- `plugins`
- `events`

Indexing constraints:
- Notes, sections, proposals, drafts, plugins are upserted on successful canonical writes.
- Event rows are append-only (`INSERT OR IGNORE` by `event_id`).
- `rebuild-index` recreates `index/rem.db` and repopulates from canonical source.
- Search supports filters on:
  - `tags` (from `notes.tags_json`)
  - `updatedSince` / `updatedUntil` (from `notes.updated_at`)
  - `noteTypes` (from `notes.meta_json.noteType`)
  - `pluginNamespaces` (from `notes.meta_json.plugins` keys)

## Rebuild invariants

After `rebuild-index`:
1. `notes`, `proposals`, `drafts`, `plugins` counts match canonical directories.
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
| `draft.created` | `draft` | `draftId`, `title`, `targetNoteId?`, `tags` |
| `draft.updated` | `draft` | `draftId`, `title`, `targetNoteId?`, `tags` |
| `plugin.registered` | `plugin` | `namespace`, `schemaVersion`, `registrationKind` |
| `plugin.updated` | `plugin` | `namespace`, `schemaVersion`, `registrationKind` |

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

These fields back note-type and plugin-facet search filters.

## Versioning expectations

- Canonical objects include `schemaVersion`.
- Event payloads are schema-versioned via `event.schemaVersion`.
- Plugin manifest `schemaVersion` is independent per plugin namespace.
- Migration posture remains non-destructive by default; `rebuild-index` is the primary repair path.
