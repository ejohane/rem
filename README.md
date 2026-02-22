# rem

Local-first human-agent memory system.

## Workspace

- Runtime/package manager: Bun
- Language: TypeScript
- Lint/format: Biome
- Testing: `bun test` (local) and `bun run test:ci` (CI coverage gate)

## Docs

- Product requirements: `docs/prd.md`
- Architecture/design: `docs/design.md`
- Canonical tech stack: `docs/tech-stack.md`
- Operator runbook: `docs/runbook.md`
- API/CLI reference: `docs/api-cli-reference.md`
- Data contracts: `docs/data-contracts.md`
- Extension playbook: `docs/extension-playbook.md`
- Plugin consumer/integration guide: `docs/plugin-consumer-guide.md`
- Plugin runtime rollout checklist: `docs/plugin-runtime-rollout-checklist.md`

## Quick start

```bash
bun install
bun run typecheck
bun run test
bun run test:ci
```

## Binary distribution packages

Create platform packages locally:

```bash
bun run package:macos
bun run package:linux
bun run package:windows
```

Package outputs:
- macOS: `dist/macos/rem-<version>-macos-<arch>.tar.gz` (+ `.sha256`)
- Linux: `dist/linux/rem-<version>-linux-<arch>.tar.gz` (+ `.sha256`)
- Windows: `dist/windows/rem-<version>-windows-<arch>.zip` (+ `.sha256`)

Package contents:
- runtime binaries (`rem`, `rem-api`, or `rem.exe`, `rem-api.exe`)
- `ui-dist/` (built UI assets)
- platform installer (`install.sh` on macOS/Linux, `install.ps1` on Windows)
- `VERSION` (installed version marker used by `rem update`)

Install from extracted package:

```bash
# macOS/Linux
tar -xzf rem-<version>-<platform>-<arch>.tar.gz
cd rem-<version>-<platform>-<arch>
./install.sh

# Windows (PowerShell)
Expand-Archive rem-<version>-windows-<arch>.zip -DestinationPath .
cd rem-<version>-windows-<arch>
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Upgrade an installed binary in place:

```bash
rem update --check
rem update
```

## Release versioning

- Releases use semantic version tags: `vMAJOR.MINOR.PATCH`.
- CI validates that `package.json` `version` is present and semver-formatted.
- Release workflow auto-computes the next version on successful `main` CI:
  - `major`: any commit message since last release contains `BREAKING CHANGE` or `!:`
  - `minor`: any commit message since last release starts with `feat:`
  - `patch`: otherwise
- Release workflow publishes artifacts only when CI passes on `main` and the computed tag does not already exist.

`bun run test:ci` runs tests with LCOV coverage output and enforces minimum line/function coverage thresholds.

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

# Install bundled canned umbrella skill for rem memory, notes, and plugin workflows
bun run --cwd apps/cli src/index.ts skill list --json
bun run --cwd apps/cli src/index.ts skill install rem-cli-memory --json
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
