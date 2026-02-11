# rem Plugin Consumer and Integration Guide

This guide covers how to use, operate, and author plugins in rem Plugin Runtime v1.

Related docs:
- API/CLI contract details: `docs/api-cli-reference.md`
- Data/storage contracts: `docs/data-contracts.md`
- Operational runbook: `docs/runbook.md`
- Extension implementation playbook: `docs/extension-playbook.md`

## Audience and outcomes

This guide is for two audiences:
- plugin consumers/operators: install, enable, run, and troubleshoot plugins
- plugin integrators/authors: build manifests/runtime modules and integrate with rem hosts

By the end you should be able to:
- install and lifecycle-manage plugins safely
- invoke actions from CLI/API with correct guardrails
- use templates, scheduler tasks, and entity flows (person/meeting)
- understand the permissions and trust model
- author a valid v2 manifest and runtime module

## Concepts at a glance

- plugin manifest: declarative contract (`manifest.json`) describing capabilities, permissions, and interfaces
- plugin lifecycle state: `registered`, `installed`, `enabled`, `disabled`
- runtime hosts: CLI and API (UI currently hosts declarative metadata and command surfaces)
- plugin entities: schema-validated records managed under namespace/type (`person`, `meeting`, etc.)
- proposal-first trust model: agent-originated note mutations should use proposals by default

## Quick start for plugin consumers

### 1) Install and enable a plugin

```bash
# Register + install
bun run --cwd apps/cli src/index.ts plugin install --manifest ./plugin-manifest.json --json

# Enable
bun run --cwd apps/cli src/index.ts plugin enable <namespace> --json

# Inspect resulting state
bun run --cwd apps/cli src/index.ts plugin inspect <namespace> --json
```

### 2) Discover what the plugin exposes

```bash
# List plugins and manifests
bun run --cwd apps/cli src/index.ts plugin list --json

# List templates
bun run --cwd apps/cli src/index.ts plugin templates list --json

# Inspect scheduler state
bun run --cwd apps/cli src/index.ts plugin scheduler status --json
```

### 3) Run actions safely

```bash
bun run --cwd apps/cli src/index.ts plugin run <namespace> <action-id> \
  --input '{"example":true}' \
  --timeout-ms 15000 \
  --max-input-bytes 65536 \
  --max-output-bytes 262144 \
  --max-concurrency 1 \
  --json
```

### 4) Use templates and scheduler

```bash
# Apply template
bun run --cwd apps/cli src/index.ts plugin templates apply \
  --namespace <namespace> \
  --template <template-id> \
  --json

# Run scheduler tick
bun run --cwd apps/cli src/index.ts plugin scheduler run --json
```

### 5) Use entity flows (`person`, `meeting`)

```bash
# Create person
bun run --cwd apps/cli src/index.ts entities save \
  --namespace person \
  --type person \
  --id alice \
  --input '{"name":"Alice","bio":"Platform"}' \
  --json

# Create meeting that references people
bun run --cwd apps/cli src/index.ts entities save \
  --namespace meeting \
  --type meeting \
  --id weekly-retro \
  --input '{"title":"Weekly Retro","attendees":["alice"],"agenda":"Wins and risks"}' \
  --json

# Query entities
bun run --cwd apps/cli src/index.ts entities list --namespace person --type person --json
bun run --cwd apps/cli src/index.ts entities list --namespace meeting --type meeting --json
```

## Plugin lifecycle operations

Lifecycle commands:

```bash
bun run --cwd apps/cli src/index.ts plugin register --manifest ./plugin-manifest.json --json
bun run --cwd apps/cli src/index.ts plugin install --manifest ./plugin-manifest.json --json
bun run --cwd apps/cli src/index.ts plugin enable <namespace> --json
bun run --cwd apps/cli src/index.ts plugin disable <namespace> --reason manual_disable --json
bun run --cwd apps/cli src/index.ts plugin uninstall <namespace> --json
```

Lifecycle semantics:
- `register`: create/update manifest + metadata
- `install`: transition to `installed`
- `enable`: transition to `enabled` (required before action execution)
- `disable`: transition to `disabled`, preserving reason metadata
- `uninstall`: transition back to `registered`

Important behavior:
- if a manifest update expands requested permissions, rem auto-disables the plugin with `disableReason=permissions_expanded`; explicit `enable` is required again

## Permissions model

Manifest permissions are explicit and host-enforced.

Available permission keys:
- `notes.read`
- `notes.write`
- `search.read`
- `events.read`
- `proposals.create`
- `proposals.review`
- `entities.read`
- `entities.write`

Rules:
- action/panel `requiredPermissions` must be declared in top-level `permissions`
- action invocation is blocked when required permissions are missing
- UI command surfaces show blocked actions with missing permissions

## Trust and security model

### Runtime loading/trust roots

Plugin runtime modules load only from trusted roots.

Inputs:
- CLI: `--trusted-roots`, `--plugin-path`
- API: request fields `trustedRoots`, `pluginPath`
- env: `REM_PLUGIN_TRUSTED_ROOTS`

Hardening behavior:
- plugin root and runtime entrypoints are resolved with symlink-aware canonical path checks
- path traversal and out-of-root entrypoint escapes are rejected

### Guardrails

Action invocations enforce:
- timeout (`timeoutMs`)
- max input bytes (`maxInputBytes`)
- max output bytes (`maxOutputBytes`)
- per-plugin max concurrency (`maxConcurrentInvocationsPerPlugin`)

Mapped runtime error codes:
- `plugin_action_timeout`
- `plugin_input_too_large`
- `plugin_output_too_large`
- `plugin_concurrency_limited`
- `plugin_run_failed`

### Proposal-first mutation policy for agents

When a plugin action runs as actor kind `agent`:
- note mutation should go through `core.createProposal` by default
- direct `core.saveNote` from agent flows requires explicit override metadata

## API usage patterns

Auth (when configured):

```bash
-H "authorization: Bearer ${REM_API_TOKEN}"
```

### Invoke plugin action via API

```bash
curl -X POST "http://127.0.0.1:8787/plugins/<namespace>/actions/<action-id>" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d '{
    "input": {"example": true},
    "actor": {"kind": "human", "id": "api-runner"},
    "timeoutMs": 10000,
    "maxInputBytes": 65536,
    "maxOutputBytes": 262144,
    "maxConcurrentInvocationsPerPlugin": 1
  }'
```

### Apply template via API

```bash
curl -X POST "http://127.0.0.1:8787/templates/apply" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"namespace":"daily-note","templateId":"daily"}'
```

### Run scheduler via API

```bash
curl -X POST "http://127.0.0.1:8787/scheduler/run" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d '{}'
```

### Entity CRUD via API

```bash
curl -X POST "http://127.0.0.1:8787/entities" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d '{
    "namespace": "person",
    "entityType": "person",
    "id": "alice",
    "data": {"name": "Alice", "bio": "Platform"}
  }'

curl "http://127.0.0.1:8787/entities?namespace=person&entityType=person" \
  -H "authorization: Bearer ${REM_API_TOKEN}"
```

## Manifest walkthrough (author/integrator)

A v2 manifest with actions, templates, scheduler, entities, and UI panels:

```json
{
  "manifestVersion": "v2",
  "namespace": "team-workflows",
  "schemaVersion": "v1",
  "remVersionRange": ">=0.1.0",
  "displayName": "Team Workflows",
  "description": "Daily notes, meetings, and people workflows",
  "capabilities": [
    "cli_actions",
    "templates",
    "scheduled_tasks",
    "entities",
    "ui_panels"
  ],
  "permissions": [
    "notes.read",
    "notes.write",
    "proposals.create",
    "entities.read",
    "entities.write"
  ],
  "notePayloadSchema": {
    "type": "object",
    "required": [],
    "properties": {},
    "additionalProperties": true
  },
  "cli": {
    "entrypoint": "dist/cli.mjs",
    "actions": [
      {
        "id": "create_daily",
        "title": "Create Daily",
        "requiredPermissions": ["notes.write"]
      },
      {
        "id": "migrate_person",
        "title": "Migrate Person",
        "requiredPermissions": ["entities.write"]
      }
    ]
  },
  "templates": [
    {
      "id": "daily",
      "title": "Daily Note",
      "defaultNoteType": "task",
      "defaultTags": ["daily"],
      "lexicalTemplate": {
        "root": {
          "type": "root",
          "version": 1,
          "children": []
        }
      }
    }
  ],
  "scheduledTasks": [
    {
      "id": "daily-note",
      "title": "Daily note scheduler",
      "actionId": "create_daily",
      "idempotencyKey": "calendar_slot",
      "runWindowMinutes": 20,
      "schedule": {
        "kind": "daily",
        "hour": 8,
        "minute": 30,
        "timezone": "UTC"
      }
    }
  ],
  "entityTypes": [
    {
      "id": "person",
      "title": "Person",
      "schema": {
        "type": "object",
        "required": ["name"],
        "properties": {
          "name": {"type": "string"},
          "bio": {"type": "string"}
        },
        "additionalProperties": false
      },
      "indexes": {
        "textFields": ["name", "bio"]
      }
    },
    {
      "id": "meeting",
      "title": "Meeting",
      "schema": {
        "type": "object",
        "required": ["title", "attendees"],
        "properties": {
          "title": {"type": "string"},
          "attendees": {"type": "array", "items": {"type": "string"}},
          "agenda": {"type": "string"}
        },
        "additionalProperties": false
      },
      "indexes": {
        "textFields": ["title", "agenda"]
      }
    }
  ],
  "ui": {
    "panels": [
      {"id": "daily-sidebar", "title": "Daily", "slot": "note.sidebar"},
      {
        "id": "review-context",
        "title": "Review Context",
        "slot": "proposal.review",
        "requiredPermissions": ["proposals.review"]
      }
    ]
  }
}
```

Manifest validation guarantees:
- capability sections must match declared capabilities
- scheduled task `actionId` must reference declared CLI action IDs
- action/panel required permissions must exist in top-level permissions

## Runtime module contract (author/integrator)

A minimal CLI runtime module (`dist/cli.mjs`):

```js
export const cli = {
  actions: {
    create_daily: async (_input, ctx) => {
      return ctx.core.saveNote({
        title: "Daily",
        noteType: "task",
        tags: ["daily"],
        lexicalState: {
          root: {
            type: "root",
            version: 1,
            children: []
          }
        }
      });
    },
    migrate_person: async (input) => {
      return {
        data: {
          ...input.entity.data,
          migratedAt: new Date().toISOString()
        }
      };
    }
  }
};
```

Action context includes:
- plugin identity (`namespace`, `schemaVersion`)
- invocation metadata (`host`, `requestId`, actor info)
- granted permissions set
- core bridge (`saveNote`, `searchNotes`, `createProposal`, `listEvents`)

## End-to-end onboarding examples

### A) Consumer/operator onboarding

1. Install and enable the plugin.
2. Run `plugin inspect` to verify lifecycle state and permissions.
3. Apply a template and verify note creation.
4. Run a CLI action and check events for `plugin.action_invoked`.
5. Create `person` and `meeting` entities.
6. Open UI and verify proposal review shows entity-aware context for person/meeting references.
7. Run scheduler and verify `plugin.task_ran` events.

### B) Integrator/author onboarding

1. Create `manifest.json` with v2 contract and explicit permissions.
2. Implement `dist/cli.mjs` with declared action IDs.
3. Install plugin with `plugin install --manifest`.
4. Enable plugin and run each action with representative inputs.
5. Add templates/scheduled tasks and validate host behavior.
6. Add entity schemas and validate CRUD + list + compatibility mode.
7. Add migration action and verify dry-run + execute workflows.
8. Confirm API host parity by invoking corresponding routes.

## Entity integration guidance (person/meeting)

Recommended patterns:
- keep `person` and `meeting` as plugin-defined entity types
- store meeting attendees as stable identifiers and/or explicit links
- use entity metadata `links` for note/entity relationship materialization in `entity_links`
- use deterministic IDs for cross-note references when possible

Migration strategy:
- bump plugin manifest `schemaVersion`
- keep mixed-version reads enabled during migration window
- migrate with deterministic ordering and dry-run first
- rerun `rebuild-index` if recovery/parity checks are needed

## Troubleshooting and FAQ

### Why is my action blocked?

- plugin may not be `enabled`
- action permissions may be missing from manifest grant set
- required permissions may not have been re-approved after manifest update

### Why did action execution fail with guard codes?

- `plugin_action_timeout`: action exceeded runtime timeout
- `plugin_input_too_large`: serialized input exceeded configured max bytes
- `plugin_output_too_large`: serialized output exceeded configured max bytes
- `plugin_concurrency_limited`: concurrent invocation count exceeded configured cap

### Why does API action work locally but not in deployment?

- `REM_API_TOKEN` may be required and missing
- trusted roots may not include plugin runtime path
- plugin lifecycle may be `disabled`

### How do I debug plugin runtime behavior?

1. Run with `--json` to capture structured outputs and codes.
2. Inspect recent events:

```bash
bun run --cwd apps/cli src/index.ts events tail --limit 50 --json
```

3. Confirm plugin state:

```bash
bun run --cwd apps/cli src/index.ts plugin inspect <namespace> --json
```

### How do I recover from index drift?

```bash
bun run --cwd apps/cli src/index.ts rebuild-index --json
bun run --cwd apps/cli src/index.ts status --json
```

## Checklist before shipping a plugin integration

1. Manifest validates and capability/permission consistency checks pass.
2. Lifecycle operations (`install/enable/disable/uninstall`) behave as expected.
3. Action runtime guardrails are validated with at least one failure-path test.
4. Templates and scheduler workflows are exercised.
5. Entity CRUD and migration workflows are tested.
6. UI proposal-review context renders expected person/meeting references.
7. API host parity is verified for critical workflows.
