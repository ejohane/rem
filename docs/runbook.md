# rem Operator Runbook

This runbook covers local operation of rem across notes, proposals, drafts, plugins, event history, and rebuild workflows.

## Prerequisites

```bash
bun install
bun run lint
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

Optional auth:

```bash
export REM_API_TOKEN="your-local-token"
```

When set, API requests must send `Authorization: Bearer <token>`.

## Core lifecycle (CLI)

```bash
# Save or update a note
bun run --cwd apps/cli src/index.ts notes save --input ./note.json --json

# Save, list, and reopen drafts
bun run --cwd apps/cli src/index.ts drafts save --input ./draft.json --json
bun run --cwd apps/cli src/index.ts drafts list --json
bun run --cwd apps/cli src/index.ts drafts get <draft-id> --json

# Register and inspect plugins
bun run --cwd apps/cli src/index.ts plugin register --manifest ./plugin-manifest.json --json
bun run --cwd apps/cli src/index.ts plugin list --json

# Search with metadata filters
bun run --cwd apps/cli src/index.ts search "deploy" \
  --tags ops \
  --note-types task \
  --plugin-namespaces tasks \
  --updated-since 2026-02-01T00:00:00.000Z \
  --json

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

# Draft create/list/get
curl -X POST "http://127.0.0.1:8787/drafts" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d @draft.json
curl -H "authorization: Bearer ${REM_API_TOKEN}" "http://127.0.0.1:8787/drafts?limit=20"
curl -H "authorization: Bearer ${REM_API_TOKEN}" "http://127.0.0.1:8787/drafts/<draft-id>"

# Plugin registration/listing
curl -X POST "http://127.0.0.1:8787/plugins/register" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d @plugin-register.json
curl -H "authorization: Bearer ${REM_API_TOKEN}" "http://127.0.0.1:8787/plugins?limit=50"

# Search with tags/time filters
curl -H "authorization: Bearer ${REM_API_TOKEN}" "http://127.0.0.1:8787/search?q=deploy&tags=ops&noteTypes=task&pluginNamespaces=tasks&updatedSince=2026-02-01T00:00:00.000Z"

# Event history
curl -H "authorization: Bearer ${REM_API_TOKEN}" "http://127.0.0.1:8787/events?limit=50"
curl -H "authorization: Bearer ${REM_API_TOKEN}" "http://127.0.0.1:8787/events?entityKind=draft&since=2026-02-01T00:00:00.000Z"
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

Expected: `notes`, `proposals`, `drafts`, `plugins`, and `events` counts match canonical filesystem state.

## Troubleshooting

### Schema validation failures

Symptoms:
- API returns `{"error":{"code":"bad_request",...}}`
- CLI returns `*_failed` errors

Checks:
- Plugin payload namespaces must be registered before note writes.
- Plugin payload must satisfy manifest `payloadSchema` required fields/types.
- Proposal content format must match payload shape.

### Unauthorized API responses

Symptoms:
- API returns `{"error":{"code":"unauthorized","message":"Missing or invalid bearer token"}}`

Checks:
- Confirm `REM_API_TOKEN` is set for the running API process.
- Include `Authorization: Bearer <token>` on requests.
- Verify the token value exactly matches API process env.

### Missing target references

Symptoms:
- `Target section not found`
- `Draft not found`

Checks:
- Re-list sections: `bun run --cwd apps/cli src/index.ts sections list --note <note-id> --json`
- Re-list drafts: `bun run --cwd apps/cli src/index.ts drafts list --json`

### Stale index symptoms

Symptoms:
- Event list misses recent writes
- Draft/plugin counts in `status` are wrong

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
bun run test
```

Manual smoke checks:
1. Register plugin and confirm `plugin.registered` appears in events.
2. Save note with valid plugin payload and verify filtered search by tags.
3. Save and reopen a draft via API and CLI.
4. Confirm `events list` returns note/draft/plugin activity.
5. Rebuild index and confirm status counts remain consistent.
