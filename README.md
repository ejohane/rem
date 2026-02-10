# rem

Local-first human-agent memory system.

## Workspace

- Runtime/package manager: Bun
- Language: TypeScript
- Lint/format: Biome
- Testing: bun test

## Docs

- Product requirements: `docs/prd.md`
- Architecture/design: `docs/design.md`
- Canonical tech stack: `docs/tech-stack.md`
- Operator runbook: `docs/runbook.md`
- API/CLI reference: `docs/api-cli-reference.md`
- Data contracts: `docs/data-contracts.md`
- Extension playbook: `docs/extension-playbook.md`

## Quick start

```bash
bun install
bun run typecheck
bun run test
```

## macOS distribution (binary)

Create a distributable macOS package locally:

```bash
bun run package:macos
```

Package output:
- `dist/macos/rem-<version>-macos-<arch>.tar.gz`
- `dist/macos/rem-<version>-macos-<arch>.tar.gz.sha256`

Package contents:
- `rem` (CLI + `rem app` launcher)
- `rem-api` (API server binary)
- `ui-dist/` (built UI assets)

Run full REM from the package directory:

```bash
./rem app
```

## CLI proposal workflow

```bash
# Save a note from JSON payload
bun run --cwd apps/cli src/index.ts notes save --input ./note.json --json

# List sections for targeting
bun run --cwd apps/cli src/index.ts sections list --note <note-id> --json

# Create, list, and review proposals
bun run --cwd apps/cli src/index.ts proposals create \
  --note <note-id> \
  --section <section-id> \
  --text "Updated section content" \
  --json
bun run --cwd apps/cli src/index.ts proposals list --status open --json
bun run --cwd apps/cli src/index.ts proposals accept <proposal-id> --json
bun run --cwd apps/cli src/index.ts proposals reject <proposal-id> --json

# Filtered search and status hints
bun run --cwd apps/cli src/index.ts search "deploy" \
  --tags ops \
  --note-types task \
  --plugin-namespaces tasks \
  --created-since 2026-02-01T00:00:00.000Z \
  --json
bun run --cwd apps/cli src/index.ts status --json
bun run --cwd apps/cli src/index.ts migrate sections --json
```

## API proposal endpoints

```bash
# List sections for a note
curl "http://127.0.0.1:8787/sections?noteId=<note-id>"

# Create proposal
curl -X POST "http://127.0.0.1:8787/proposals" \
  -H "content-type: application/json" \
  -d '{
    "target": { "noteId": "<note-id>", "sectionId": "<section-id>" },
    "proposalType": "replace_section",
    "content": { "format": "text", "content": "Updated section content" },
    "actor": { "kind": "agent", "id": "api-agent" }
  }'

# List/get/review proposals
curl "http://127.0.0.1:8787/proposals?status=open"
curl "http://127.0.0.1:8787/proposals/<proposal-id>"
curl -X POST "http://127.0.0.1:8787/proposals/<proposal-id>/accept" -H "content-type: application/json" -d '{}'
curl -X POST "http://127.0.0.1:8787/proposals/<proposal-id>/reject" -H "content-type: application/json" -d '{}'

# Explicit note update route
curl -X PUT "http://127.0.0.1:8787/notes/<note-id>" \
  -H "content-type: application/json" \
  -d @note-update.json

# Section identity migration
curl -X POST "http://127.0.0.1:8787/migrations/sections"
```
