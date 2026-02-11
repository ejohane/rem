# rem Extension Playbook

Use this guide when extending rem Plugin Runtime v1.

Related docs:
- Consumer and integration onboarding: `docs/plugin-consumer-guide.md`
- API/CLI contracts: `docs/api-cli-reference.md`
- Data contracts: `docs/data-contracts.md`

## Safe extension workflow

1. Add/adjust schema in `packages/schemas/src/index.ts`.
2. Extend canonical persistence in `packages/store-fs/src/index.ts`.
3. Extend derived indexing in `packages/index-sqlite/src/index.ts`.
4. Update core orchestration in `packages/core/src/index.ts`.
5. Expose interface changes in API (`apps/api/src/index.ts`) and CLI (`apps/cli/src/index.ts`).
6. Add tests:
   - schema/store/index/core unit coverage
   - API/CLI contract coverage
   - UI host coverage when applicable
7. Update docs (`docs/data-contracts.md`, `docs/api-cli-reference.md`, `docs/runbook.md`).

## Add a new plugin capability

Checklist:
1. Extend manifest schema + capability consistency checks in `packages/schemas/src/index.ts`.
2. Normalize capability in plugin manifest parse/transform path.
3. Add/adjust core behavior and lifecycle/event semantics.
4. Expose capability through API/CLI surfaces.
5. Add regression coverage for v1/v2 manifest compatibility.

Guardrails:
- capability declarations and capability payload sections must remain mutually consistent.
- required permissions on actions/panels must be declared in manifest `permissions`.
- permission expansion on re-register must preserve re-approval semantics (auto-disable until re-enable).

## Add or change plugin lifecycle behavior

Primary files:
- `packages/core/src/index.ts`
- `apps/cli/src/index.ts`
- `apps/api/src/index.ts`

Checklist:
1. Keep lifecycle transitions explicit (`registered -> installed -> enabled -> disabled`).
2. Preserve transition validation (`invalid_transition` on illegal state changes).
3. Emit lifecycle events with `previousLifecycleState`, `lifecycleState`, and `disableReason` where relevant.
4. Keep CLI and API lifecycle operations behaviorally aligned.

## Add or change plugin action runtime behavior

Primary files:
- `packages/plugins/src/index.ts`
- `packages/core/src/index.ts`
- `apps/cli/src/index.ts`
- `apps/api/src/index.ts`

Checklist:
1. Keep trusted-root resolution and runtime asset discovery hardened against traversal/symlink escapes.
2. Keep guardrails enforced (`timeout`, input/output byte limits, per-plugin concurrency).
3. Keep action error mapping stable (`plugin_action_timeout`, `plugin_input_too_large`, `plugin_output_too_large`, `plugin_concurrency_limited`, `plugin_run_failed`).
4. Emit `plugin.action_invoked` and `plugin.action_failed` with request/actor/host metadata.
5. Preserve proposal-first trust policy for agent-originated note mutations.

## Add a plugin-defined entity type

Primary files:
- schemas: `packages/schemas/src/index.ts`
- storage: `packages/store-fs/src/index.ts`
- index: `packages/index-sqlite/src/index.ts`
- core: `packages/core/src/index.ts`
- hosts: `apps/cli/src/index.ts`, `apps/api/src/index.ts`

Checklist:
1. Add entity definition to plugin manifest `entityTypes`.
2. Enforce schema validation on create/update writes.
3. Persist canonical entity/meta files under `entities/<namespace>.<entityType>/<entityId>/`.
4. Upsert `entities`, `entities_fts`, and `entity_links` derived records.
5. Emit `entity.created`/`entity.updated` events.
6. Expose CRUD via both CLI and API.

Guardrails:
- entity IDs and types must satisfy schema-level constraints.
- mixed schema versions must remain readable (compatibility mode surface).
- `rebuild-index` must preserve entity parity with incremental indexing.

## Add an entity migration workflow

Primary files:
- `apps/cli/src/index.ts` (`entities migrate`)
- `apps/api/src/index.ts` (`POST /entities/migrations/run`)

Checklist:
1. Keep candidate selection deterministic (`entity.id` ascending).
2. Support dry-run planning without mutation.
3. Require plugin action-based transformations.
4. Keep migration target schema aligned to plugin manifest schemaVersion.
5. Emit plugin action events for migration action invocations.

## UI plugin host contract

The UI host uses declarative contracts (runtime-isolated) in:
- `apps/ui/src/plugin-panels.ts`
- `apps/ui/src/plugin-commands.ts`
- `apps/ui/src/proposals.ts`
- `apps/ui/src/App.tsx`

### Panel slots

Supported slots:
- `note.sidebar`
- `note.toolbar`
- `proposal.review`

Rules:
- only installed/enabled plugins with `ui_panels` capability are hosted
- panel rendering is metadata-only in isolation mode

### Command surfaces

Rules:
- commands are derived from enabled plugin `cli.actions`
- required permissions are evaluated before enabling command execution
- UI invocation payload includes actor/request/context snapshot

### Proposal review integration

Rules:
- proposal review surface resolves section context by stable section identity (`sectionId` + fallback path)
- entity-aware context resolves `person`/`meeting` references from proposal and section content
- unresolved entity lookups are surfaced explicitly in UI state

## Evolve schemas and events safely

Checklist:
1. Preserve backward compatibility where possible.
2. Add version-aware readers before changing writers.
3. Avoid destructive canonical rewrites by default.
4. Ensure `rebuild-index` can replay canonical files/events into a valid DB.
5. Add regression tests for old and new payload variants.

Event evolution:
- add new event types rather than mutating semantics of existing types
- keep existing payload keys stable for downstream consumers

## PRD to code traceability (runtime v1 scope)

| Capability | Primary implementation |
| --- | --- |
| Plugin manifest v2 + lifecycle state model | `packages/schemas/src/index.ts`, `packages/core/src/index.ts`, `apps/cli/src/index.ts`, `apps/api/src/index.ts` |
| Plugin action runtime with guardrails + event/error contracts | `packages/plugins/src/index.ts`, `packages/core/src/index.ts`, `apps/cli/src/index.ts`, `apps/api/src/index.ts` |
| Scheduler runtime + ledger + task events | `packages/core/src/index.ts`, `apps/cli/src/index.ts`, `apps/api/src/index.ts`, `docs/data-contracts.md` |
| Declarative templates (list/apply) | `packages/core/src/index.ts`, `apps/cli/src/index.ts`, `apps/api/src/index.ts` |
| Plugin-defined entities + links + FTS | `packages/schemas/src/index.ts`, `packages/store-fs/src/index.ts`, `packages/index-sqlite/src/index.ts`, `packages/core/src/index.ts` |
| Entity migration workflow (CLI/API) | `apps/cli/src/index.ts`, `apps/api/src/index.ts`, `packages/core/src/index.ts` |
| UI panel slots + commands + entity-aware proposal context | `apps/ui/src/plugin-panels.ts`, `apps/ui/src/plugin-commands.ts`, `apps/ui/src/proposals.ts`, `apps/ui/src/App.tsx` |
| Security hardening (trusted roots, traversal protection, auth parity) | `packages/plugins/src/index.ts`, `apps/api/src/index.ts`, `apps/cli/src/index.ts` |

## Future session handoff template

Copy/paste this at session end:

```text
Session Hand-off
Date:
Branch:
Related bead IDs:

What shipped:
-

What remains:
-

Acceptance criteria status:
- [ ] rem-...

Validation run:
- Tests:
- Manual checks:

Known risks/deviations:
-

Next recommended starting issue:
-
```

## Session handoff checklist

1. Update relevant bead statuses (`in_progress` -> `closed`) with notes.
2. Confirm docs touched for any new interface/contract changes.
3. Run tests and at least one manual smoke workflow on changed surfaces.
4. Sync issue state (`bd sync`) and verify git branch status.
5. Include explicit next step recommendation tied to a bead ID.
