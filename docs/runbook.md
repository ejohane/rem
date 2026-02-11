# rem Operator Runbook

This runbook covers local operation of rem across notes, proposals, plugins, scheduler runtime, entities, and rebuild workflows.

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
- export `REM_API_TOKEN` before starting API
- send `Authorization: Bearer <token>` on requests when token is configured

## Plugin lifecycle workflow (CLI)

```bash
# Register manifest only
bun run --cwd apps/cli src/index.ts plugin register --manifest ./plugin-manifest.json --json

# Register + mark installed
bun run --cwd apps/cli src/index.ts plugin install --manifest ./plugin-manifest.json --json

# Inspect/list lifecycle state
bun run --cwd apps/cli src/index.ts plugin inspect <namespace> --json
bun run --cwd apps/cli src/index.ts plugin list --json

# Enable/disable/uninstall
bun run --cwd apps/cli src/index.ts plugin enable <namespace> --json
bun run --cwd apps/cli src/index.ts plugin disable <namespace> --reason maintenance --json
bun run --cwd apps/cli src/index.ts plugin uninstall <namespace> --json
```

Operational notes:
- plugin actions only run when plugin lifecycle state is `enabled`
- permission expansion on plugin re-register forces `disabled` with `disableReason=permissions_expanded`

## Plugin action runtime workflow (CLI)

```bash
bun run --cwd apps/cli src/index.ts plugin run <namespace> <action-id> \
  --input '{"example":true}' \
  --trusted-roots ./plugins \
  --timeout-ms 15000 \
  --max-input-bytes 65536 \
  --max-output-bytes 262144 \
  --max-concurrency 1 \
  --json
```

Expected:
- successful run emits `plugin.action_invoked` event with duration and payload-size metadata
- failure emits `plugin.action_failed` with mapped error code/message

## Templates and scheduler workflow (CLI)

```bash
# Templates
bun run --cwd apps/cli src/index.ts plugin templates list --json
bun run --cwd apps/cli src/index.ts plugin templates apply \
  --namespace <namespace> \
  --template <template-id> \
  --json

# Scheduler
bun run --cwd apps/cli src/index.ts plugin scheduler status --json
bun run --cwd apps/cli src/index.ts plugin scheduler run --json
```

Expected:
- scheduler run is idempotent per dedupe key
- task events recorded as `plugin.task_ran`
- runtime ledger persists at `~/.rem/runtime/scheduler-ledger.json`

## Entity workflow (CLI)

```bash
# Create/update entity
bun run --cwd apps/cli src/index.ts entities save \
  --namespace person \
  --type person \
  --id alice \
  --input '{"name":"Alice"}' \
  --json

# Get/list entities
bun run --cwd apps/cli src/index.ts entities get --namespace person --type person --id alice --json
bun run --cwd apps/cli src/index.ts entities list --namespace person --type person --json

# Deterministic schema migration
bun run --cwd apps/cli src/index.ts entities migrate \
  --namespace person \
  --type person \
  --action migrate_person \
  --from-schema-version v1 \
  --dry-run \
  --json
```

Migration notes:
- candidate order is deterministic (`entity.id` ascending)
- execute mode invokes plugin action per candidate and updates entity `schemaVersion` to target
- migration action invocations emit plugin action events

## Proposal review workflow

```bash
# List sections to target
bun run --cwd apps/cli src/index.ts sections list --note <note-id> --json

# Create proposal
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

UI behavior:
- proposal review surface renders declarative plugin panels for slot `proposal.review`
- entity-aware proposal context resolves person/meeting references from proposal + section context

## Core note/search/events lifecycle (CLI)

```bash
# Save notes
bun run --cwd apps/cli src/index.ts notes save --input ./note.json --json

# Search with metadata filters
bun run --cwd apps/cli src/index.ts search "deploy" \
  --tags ops \
  --note-types task \
  --plugin-namespaces tasks \
  --created-since 2026-02-01T00:00:00.000Z \
  --updated-since 2026-02-01T00:00:00.000Z \
  --json

# Events + status
bun run --cwd apps/cli src/index.ts events tail --limit 20 --json
bun run --cwd apps/cli src/index.ts events list --entity-kind plugin --json
bun run --cwd apps/cli src/index.ts status --json
```

## API equivalents

```bash
# Register plugin
curl -X POST "http://127.0.0.1:8787/plugins/register" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d @plugin-register.json

# Invoke plugin action
curl -X POST "http://127.0.0.1:8787/plugins/<namespace>/actions/<action-id>" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"input":{"example":true}}'

# Entity CRUD
curl -X POST "http://127.0.0.1:8787/entities" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"namespace":"person","entityType":"person","id":"alice","data":{"name":"Alice"}}'
curl "http://127.0.0.1:8787/entities/person/person/alice" \
  -H "authorization: Bearer ${REM_API_TOKEN}"

# Entity migration
curl -X POST "http://127.0.0.1:8787/entities/migrations/run" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"namespace":"person","entityType":"person","actionId":"migrate_person","dryRun":true}'
```

## Rebuild and migration recovery

```bash
# Rebuild derived index
bun run --cwd apps/cli src/index.ts rebuild-index --json

# Backfill durable section identity metadata
bun run --cwd apps/cli src/index.ts migrate sections --json
```

Expected:
- `rebuild-index` keeps note/proposal/plugin/entity/event counts consistent with canonical data
- section migration emits `schema.migration_run` for migrated notes

## Troubleshooting

### Plugin action fails with permission or lifecycle errors

Symptoms:
- `plugin_not_enabled`
- `plugin_permission_denied`

Checks:
- run `plugin inspect <namespace> --json` and verify `meta.lifecycleState`
- verify action `requiredPermissions` are declared and granted in manifest

### Plugin action guard failures

Symptoms:
- `plugin_action_timeout`
- `plugin_input_too_large`
- `plugin_output_too_large`
- `plugin_concurrency_limited`

Checks:
- tune runtime guard options on CLI/API invocation
- reduce payload size or action response size

### Trusted roots / runtime loading failures

Symptoms:
- `plugin_entrypoint_missing`
- `plugin_run_failed` with trusted-root or path traversal related message

Checks:
- verify plugin path is under trusted roots
- pass `--trusted-roots` and/or `--plugin-path` explicitly for local bundles

### API auth failures

Symptoms:
- `401 unauthorized`

Checks:
- confirm `REM_API_TOKEN` in API process environment
- send matching `Authorization: Bearer <token>`

### Stale index symptoms

Symptoms:
- status counts drift from canonical files
- events appear missing after crash/restart

Recovery:
- run `rebuild-index`
- verify with `status --json` and `events tail --json`

## Validation checklist

For full release gating and rollback criteria, use `docs/plugin-runtime-rollout-checklist.md`.

Run before shipping:

```bash
bun run lint
bun run typecheck
bun run test:ci
```

Manual smoke checks:
1. Install/enable plugin and verify lifecycle events (`plugin.installed`, `plugin.activated`).
2. Run plugin action and verify `plugin.action_invoked`/`plugin.action_failed` behavior.
3. Run scheduler and verify `plugin.task_ran` plus ledger updates.
4. Create/list/get entity and verify compatibility metadata.
5. Execute entity migration dry-run and one real run.
6. Open UI proposal review and verify entity-aware context appears for person/meeting references.
7. Rebuild index and verify status counters stay consistent.
