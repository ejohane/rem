# rem Operator Runbook

This runbook covers local operation of rem across notes, proposals, plugins, event history, and rebuild workflows.

## Prerequisites

```bash
bun install
bun run lint
bun run typecheck
bun run test
```

## Start local services

```bash
# Terminal 1
bun run --cwd apps/api dev

# Terminal 2
bun run --cwd apps/ui dev
```

Default API: `http://127.0.0.1:8787`

Optional API auth:
- Export `REM_API_TOKEN` before starting API.
- Send `Authorization: Bearer <token>` on requests when token is configured.

## Core lifecycle (CLI)

```bash
# Save or update a note
bun run --cwd apps/cli src/index.ts notes save --input ./note.json --json
bun run --cwd apps/cli src/index.ts notes save --input ./note.json --actor-kind agent --actor-id harness-1 --json

# Register and inspect plugins
bun run --cwd apps/cli src/index.ts plugin register --manifest ./plugin-manifest.json --json
bun run --cwd apps/cli src/index.ts plugin list --json

# Search with metadata filters
bun run --cwd apps/cli src/index.ts search "deploy" \
  --tags ops \
  --note-types task \
  --plugin-namespaces tasks \
  --created-since 2026-02-01T00:00:00.000Z \
  --updated-since 2026-02-01T00:00:00.000Z \
  --json

# Backfill durable section identity metadata
bun run --cwd apps/cli src/index.ts migrate sections --json

# Event history
bun run --cwd apps/cli src/index.ts events tail --limit 20 --json
bun run --cwd apps/cli src/index.ts events list --entity-kind plugin --json

# Status now includes index recency + health hints
bun run --cwd apps/cli src/index.ts status --json
```

## Core lifecycle (API)

```bash
# Save note with plugin payload
curl -X POST "http://127.0.0.1:8787/notes" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d @note.json

# Explicit update for existing note id
curl -X PUT "http://127.0.0.1:8787/notes/<note-id>" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d @note-update.json

# Plugin registration/listing
curl -X POST "http://127.0.0.1:8787/plugins/register" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d @plugin-register.json
curl -H "authorization: Bearer ${REM_API_TOKEN}" "http://127.0.0.1:8787/plugins?limit=50"

# Search with tags/time filters
curl -H "authorization: Bearer ${REM_API_TOKEN}" "http://127.0.0.1:8787/search?q=deploy&tags=ops&noteTypes=task&pluginNamespaces=tasks&createdSince=2026-02-01T00:00:00.000Z&updatedSince=2026-02-01T00:00:00.000Z"

# Event history
curl -H "authorization: Bearer ${REM_API_TOKEN}" "http://127.0.0.1:8787/events?limit=50"
curl -H "authorization: Bearer ${REM_API_TOKEN}" "http://127.0.0.1:8787/events?entityKind=proposal&since=2026-02-01T00:00:00.000Z"
curl -X POST "http://127.0.0.1:8787/migrations/sections" -H "authorization: Bearer ${REM_API_TOKEN}"
```

## Proposal review workflow

```bash
# List sections to target
bun run --cwd apps/cli src/index.ts sections list --note <note-id> --json

# Create a proposal
bun run --cwd apps/cli src/index.ts proposals create \
  --note <note-id> \
  --section <section-id> \
  --text "Replacement content" \
  --json

# Review queue
bun run --cwd apps/cli src/index.ts proposals list --status open --json
bun run --cwd apps/cli src/index.ts proposals accept <proposal-id> --json
bun run --cwd apps/cli src/index.ts proposals reject <proposal-id> --json
```

## Rebuild derived index

If SQLite is stale or removed, rebuild from canonical files/events:

```bash
bun run --cwd apps/cli src/index.ts rebuild-index --json
```

Expected: `notes`, `proposals`, `plugins`, and `events` counts match canonical filesystem state.

## Section identity migration

Run migration when upgrading legacy notes to durable section IDs:

```bash
bun run --cwd apps/cli src/index.ts migrate sections --json
```

Expected:
- `migration` is `section_identity_v2`
- `scanned` equals note count
- `migrated + skipped` equals `scanned`
- `schema.migration_run` events appear for migrated notes

## Troubleshooting

### Schema validation failures

Symptoms:
- API returns `{"error":{"code":"bad_request",...}}`
- CLI returns `*_failed` errors

Checks:
- Plugin payload namespaces must be registered before note writes.
- Plugin payload must satisfy manifest `payloadSchema` required fields/types.
- Proposal content format must match payload shape.
- Agent actors must include an id when using `kind: "agent"`.

### API auth failures

Symptoms:
- API returns `401` with `{"error":{"code":"unauthorized",...}}`

Checks:
- Confirm `REM_API_TOKEN` is set in API process environment.
- Send `Authorization: Bearer <token>` with the exact configured token.

### Missing target references

Symptoms:
- `Target section not found`

Checks:
- Re-list sections: `bun run --cwd apps/cli src/index.ts sections list --note <note-id> --json`

### Stale index symptoms

Symptoms:
- Event list misses recent writes
- Note/proposal/plugin counts in `status` are wrong

Recovery:
- Run `rebuild-index`.
- Re-check via:
  `bun run --cwd apps/cli src/index.ts status --json`
  `bun run --cwd apps/cli src/index.ts events tail --json`

### Event log crash tail

Truncated final JSONL lines are tolerated during rebuild. Recovery keeps prior valid events and skips only the malformed final line.

## Validation checklist

Run before shipping:

```bash
bun run lint
bun run typecheck
bun run test:ci
```

Coverage gate defaults:
- Line coverage minimum: `75%`
- Function coverage minimum: `75%`
- Override in CI or local runs with `MIN_LINE_COVERAGE` and `MIN_FUNCTION_COVERAGE`

Manual smoke checks:
1. Register plugin and confirm `plugin.registered` appears in events.
2. Save note with valid plugin payload and verify filtered search by created+updated windows.
3. Save an agent-authored note via API/CLI and verify persisted actor metadata.
4. Run `migrate sections` and confirm `schema.migration_run` events.
5. Rebuild index and confirm status counts remain consistent.

## Binary packaging (macOS)

Build release artifacts:

```bash
bun run package:macos
```

Artifact layout:
- `rem` compiled CLI executable
- `rem-api` compiled API executable
- `ui-dist/` static UI build

Start full REM from the extracted package:

```bash
./rem app
```

## Release process (semantic versioning)

1. Merge your change to `main`.
2. CI validates semver format + quality gates.
3. On successful CI for that `main` commit, release workflow computes the next semantic version and publishes macOS artifacts under tag `v<version>`.

Notes:
- If tag `v<version>` already exists, release publish is skipped.
- Version bump rules are commit-message based since the last release tag:
  - `major`: commit body contains `BREAKING CHANGE` or subject contains `!:`
  - `minor`: commit subject starts with `feat:`
  - `patch`: all other commits
