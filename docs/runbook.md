# rem Operator Runbook

This runbook describes the local workflow for creating notes, reviewing proposals, rebuilding indexes, and troubleshooting common failures.

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

## Note and proposal lifecycle (CLI)

```bash
# 1) Save or update a note
bun run --cwd apps/cli src/index.ts notes save --input ./note.json --json

# 2) List sections to target
bun run --cwd apps/cli src/index.ts sections list --note <note-id> --json

# 3) Create an agent proposal
bun run --cwd apps/cli src/index.ts proposals create \
  --note <note-id> \
  --section <section-id> \
  --text "Replacement section content" \
  --json

# 4) Review queue and accept or reject
bun run --cwd apps/cli src/index.ts proposals list --status open --json
bun run --cwd apps/cli src/index.ts proposals accept <proposal-id> --json
bun run --cwd apps/cli src/index.ts proposals reject <proposal-id> --json
```

## Note and proposal lifecycle (API)

```bash
# Save note
curl -X POST "http://127.0.0.1:8787/notes" \
  -H "content-type: application/json" \
  -d @note.json

# List note sections
curl "http://127.0.0.1:8787/sections?noteId=<note-id>"

# Create proposal
curl -X POST "http://127.0.0.1:8787/proposals" \
  -H "content-type: application/json" \
  -d '{
    "target": { "noteId": "<note-id>", "sectionId": "<section-id>" },
    "proposalType": "replace_section",
    "content": { "format": "text", "content": "Replacement section content" },
    "actor": { "kind": "agent", "id": "api-agent" }
  }'

# Accept or reject
curl -X POST "http://127.0.0.1:8787/proposals/<proposal-id>/accept" -H "content-type: application/json" -d '{}'
curl -X POST "http://127.0.0.1:8787/proposals/<proposal-id>/reject" -H "content-type: application/json" -d '{}'
```

## Rebuild derived index

If SQLite data is stale or corrupted, rebuild from canonical files/events.

```bash
bun run --cwd apps/cli src/index.ts rebuild-index --json
```

Expected: note/proposal/event counts should match canonical filesystem state.

## Troubleshooting

### Schema validation failures

Symptoms:
- API returns `{"error":{"code":"bad_request",...}}`
- CLI returns `proposal_create_failed` or `invalid_format`

Checks:
- Ensure proposal actor is agent for creation.
- Ensure proposal target `noteId` and `sectionId` exist.
- Ensure proposal content shape matches `format` (`text` => string, `lexical` => lexical state).

### Missing section errors

Symptoms:
- `Target section not found`

Checks:
- Re-list sections and refresh IDs:
  `bun run --cwd apps/cli src/index.ts sections list --note <note-id> --json`
- Use fallback path if section IDs changed after note edits.

### Stale index symptoms

Symptoms:
- Proposal list/count mismatch
- Sections missing in API/CLI responses

Recovery:
- Run `rebuild-index`.
- Re-run status commands and confirm counts.

### Event log crash tail

The system tolerates truncated final JSONL lines caused by abrupt process termination. Rebuild should skip the malformed last line and recover valid prior events.

## Validation checklist

Run before shipping:

```bash
bun run lint
bun run typecheck
bun run test
```

Manual smoke checks:
1. Save note and read note text.
2. Create proposal and confirm it appears in open list.
3. Accept proposal and verify note text changed.
4. Rebuild index and confirm proposal/section counts remain consistent.
