# Design Spec: rem Plugin Runtime and Extension Model

**Document status:** Draft (v1)
**Owner:** Erik
**Last updated:** 2026-02-11
**Related docs:** `docs/prd.md`, `docs/design.md`, `docs/data-contracts.md`, `docs/extension-playbook.md`

---

## 1) Purpose

Define how rem evolves from a **plugin registry + payload validation** model into a full **plugin runtime** that can extend:
- rem CLI behavior
- rem client/UI behavior
- rem data model (including plugin-defined entity primitives such as `person` and `meeting`)

This spec does not implement the runtime. It defines architecture, contracts, and rollout.

---

## 2) Current Baseline (as of 2026-02-11)

Already implemented:
- Plugin manifest registration (`namespace`, `schemaVersion`, `payloadSchema`)
- Note write-time validation of `meta.plugins[namespace]` against registered plugin schema
- Plugin registry surfaces in API/CLI (`/plugins`, `/plugins/register`, `rem plugin register/list`)
- Search facet filtering by plugin namespace
- Minimal UI-only editor plugin surface (`apps/ui/src/editor-plugins.ts`)

Key limitation:
- No first-class plugin runtime for executable behavior (actions/hooks/jobs).

---

## 3) Goals and Non-Goals

### Goals

1. Keep Core deterministic and auditable.
2. Let plugins add behavior in CLI and UI through stable host APIs.
3. Support both declarative and executable plugin capabilities.
4. Allow plugin-defined entity primitives without hardcoding each primitive in core.
5. Preserve trust model: all canonical writes still flow through core.
6. Make plugin execution lifecycle explicit (`registered`, `installed`, `enabled`, `disabled`).
7. Keep plugin behavior reproducible with deterministic scheduling and idempotency rules.

### Non-Goals (initial phases)

1. Managed plugin ecosystem operations (ratings, publishing workflows, moderation).
2. Arbitrary remote code execution.
3. Multi-tenant permission system.
4. Cloud sync policy for plugins.
5. Remote third-party plugin marketplace/installation UX.

---

## 4) Design Principles

1. **Core never executes untrusted plugin code directly.**
2. **Hosts execute plugins; core validates and persists.**
3. **Plugin capabilities are explicit in manifest and permission-gated.**
4. **All plugin side effects are observable via events.**
5. **Plugin-defined data is namespaced and schema-validated.**
6. **Backwards compatibility for existing plugin manifests is preserved.**
7. **Plugin runtime failures should degrade features, not availability of core note/proposal flows.**
8. **Agent-originated plugin mutations must respect the proposal-review trust model.**

---

## 5) Architecture Overview

### 5.1 Layered model

1. **Registry layer (core)**
   - Stores plugin manifests/meta canonically.
   - Enforces schema and version compatibility.

2. **Host runtime layer (CLI/UI)**
   - Loads plugin modules and declarative capabilities.
   - Enforces permissions and execution boundaries.
   - Calls core APIs for all writes.

3. **Data layer (core + index)**
   - Persists plugin-owned data and plugin-defined entities canonically.
   - Indexes facets/events/entities for search and retrieval.

### 5.2 Package boundaries

- `packages/schemas`
  - Add `pluginManifestV2Schema`, capability schemas, permission schemas, entity schemas.
- `packages/plugins`
  - Add host/runtime contracts (CLI and UI hook types, execution context types, helpers).
- `packages/core`
  - Extend registry/read APIs and generic plugin data/entity persistence APIs.
  - Keep core as the canonical writer and validation gate.
- `apps/cli`
  - Add plugin host runtime and plugin actions entrypoint.
- `apps/ui`
  - Add UI plugin host slots and capability-driven rendering.

### 5.3 Plugin lifecycle model

Plugin lifecycle states are distinct:

1. **Registered**
   - Manifest accepted by core and stored canonically.
2. **Installed**
   - Plugin runtime assets are available to a host (bundled or local package path).
3. **Enabled**
   - Plugin can execute capabilities in a host.
4. **Disabled**
   - Plugin remains registered/installed but host refuses execution.

State transitions:
- `registered -> installed -> enabled`
- `enabled -> disabled`
- `disabled -> enabled` (only if permissions/version checks pass)
- Any manifest update that expands permissions forces `enabled -> disabled` until explicit re-enable.

Persistence rule for this spec:
- `registered` is canonical (core-owned).
- `installed`/`enabled`/`disabled` are host-runtime states by default until a global cross-host policy is decided.

---

## 6) Manifest v2 Contract

### 6.1 Compatibility posture

- Existing manifest shape remains valid as v1.
- v2 introduces new optional fields.
- Core stores `manifestVersion` and validates accordingly.

### 6.2 Proposed manifest interface

```ts
export type PluginCapability =
  | "templates"
  | "scheduled_tasks"
  | "entities"
  | "cli_actions"
  | "ui_panels";

export type PluginPermission =
  | "notes.read"
  | "notes.write"
  | "search.read"
  | "events.read"
  | "proposals.create"
  | "proposals.review"
  | "entities.read"
  | "entities.write";

export interface PluginManifestV2 {
  manifestVersion: "v2";
  namespace: string;
  schemaVersion: string;
  remVersionRange: string;
  displayName?: string;
  description?: string;
  capabilities: PluginCapability[];
  permissions: PluginPermission[];

  // Existing v1 note payload contract (renamed but backwards-compatible alias supported)
  notePayloadSchema?: {
    type: "object";
    required?: string[];
    properties?: Record<string, { type: "string" | "number" | "boolean" | "object" | "array"; items?: { type: "string" | "number" | "boolean" | "object" | "array" } }>;
    additionalProperties?: boolean;
  };

  templates?: TemplateDefinition[];
  scheduledTasks?: ScheduledTaskDefinition[];
  entityTypes?: EntityTypeDefinition[];
  cli?: { actions: CliActionDefinition[]; entrypoint?: string };
  ui?: { panels: UiPanelDefinition[]; entrypoint?: string };

  lifecycle?: {
    defaultEnabled?: boolean;
    updatePolicy?: "manual" | "auto_minor";
  };
}
```

### 6.3 Semantics and validation rules

1. `manifestVersion`
   - Omitted value is interpreted as v1.
   - `"v2"` enables capability/permission/lifecycle fields.
2. `schemaVersion`
   - Version of plugin-owned data contracts (note payload + entities), independent from rem core schema.
3. `remVersionRange`
   - Semver range evaluated by host before enabling or running plugin actions.
   - Version mismatch means plugin stays disabled with a reason surfaced in CLI/API.
4. `payloadSchema` aliasing
   - v1 field `payloadSchema` is accepted.
   - Core normalizes to `notePayloadSchema` when persisting v2 manifests.
5. capability consistency checks
   - `templates` capability requires `templates.length > 0`.
   - `entities` capability requires `entityTypes.length > 0`.
   - `cli_actions` capability requires `cli.actions.length > 0`.
   - `ui_panels` capability requires `ui.panels.length > 0`.
6. permission consistency checks
   - Runtime host denies invocation when required permission is missing.
   - Sensitive permissions (`notes.write`, `entities.write`) trigger explicit enable-time confirmation.

### 6.4 Capability-specific definitions

```ts
export interface TemplateDefinition {
  id: string;
  title: string;
  description?: string;
  defaultNoteType?: string;
  defaultTags?: string[];
  lexicalTemplate: unknown;
}

export interface ScheduledTaskDefinition {
  id: string;
  title: string;
  schedule: {
    kind: "daily" | "weekly" | "hourly";
    hour?: number;
    minute?: number;
    weekday?: "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
    timezone?: string; // IANA TZ, defaults to host local timezone
  };
  actionId: string;
  idempotencyKey: "calendar_slot" | "action_input_hash";
  runWindowMinutes?: number; // default 15
  maxRuntimeSeconds?: number; // default host policy
}

export interface EntityTypeDefinition {
  id: string; // e.g. "person" or "meeting" (namespaced by plugin)
  title: string;
  description?: string;
  schema: {
    type: "object";
    required?: string[];
    properties?: Record<string, { type: "string" | "number" | "boolean" | "object" | "array"; items?: { type: "string" | "number" | "boolean" | "object" | "array" } }>;
    additionalProperties?: boolean;
  };
  indexes?: {
    textFields?: string[];
    facetFields?: string[];
  };
}

export interface CliActionDefinition {
  id: string;
  title: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  requiredPermissions?: PluginPermission[];
}

export interface UiPanelDefinition {
  id: string;
  title: string;
  slot: "note.sidebar" | "note.toolbar" | "proposal.review";
  requiredPermissions?: PluginPermission[];
}
```

### 6.5 Runtime asset and loading model

For executable capabilities, hosts resolve plugin code from explicit roots:

1. Built-in bundled plugins (shipped with rem binaries).
2. Local development plugins (explicit `--plugin-path` or configured local path).

Canonical metadata remains under:

```text
~/.rem/plugins/<namespace>/
  manifest.json
  meta.json
```

Host runtime metadata (non-canonical, host-managed) is kept separately, for example:

```text
~/.rem/runtime/plugins/<namespace>.json
```

Runtime metadata examples:
- resolved entrypoint path
- host compatibility result
- enabled/disabled status
- disable reason (permissions changed, version mismatch, load failure)

Core should not persist host-specific runtime file paths in canonical plugin metadata.

---

## 7) Runtime Hook Contracts

### 7.1 CLI host runtime (proposed)

```ts
export interface CliPluginContext {
  plugin: { namespace: string; version: string };
  invocation: {
    actorKind: "human" | "agent";
    actorId?: string;
    host: "cli" | "api";
    requestId: string;
  };
  permissions: Set<PluginPermission>;
  core: {
    saveNote: typeof saveNoteViaCore;
    searchNotes: typeof searchNotesViaCore;
    createProposal: typeof createProposalViaCore;
    listEvents: typeof listEventsViaCore;
    // future: entities API
  };
  log: (event: { level: "info" | "warn" | "error"; message: string; data?: unknown }) => void;
}

export interface CliPluginEntrypoint {
  actions: Record<string, (input: unknown, ctx: CliPluginContext) => Promise<unknown>>;
}
```

Execution constraints:
- Action execution gets timeout and payload size limits.
- Action execution gets per-plugin concurrency limits.
- Permissions are checked before action invocation.
- Host emits plugin action events (success/failure).

### 7.2 UI host runtime (proposed)

```ts
export interface UiPluginContext {
  noteId: string | null;
  lexicalState: unknown;
  tags: string[];
  pluginPayload: Record<string, unknown>;
  invocation: {
    actorKind: "human" | "agent";
    actorId?: string;
    requestId: string;
  };
  permissions: Set<PluginPermission>;
  coreApi: {
    search: (query: string, filters?: Record<string, unknown>) => Promise<unknown>;
    saveNote: (payload: unknown) => Promise<unknown>;
    createProposal: (payload: unknown) => Promise<unknown>;
  };
}

export interface UiPluginEntrypoint {
  renderPanel?: (panelId: string, ctx: UiPluginContext) => unknown;
  getCommands?: (ctx: UiPluginContext) => Array<{ id: string; title: string; run: () => Promise<void> }>;
}
```

UI constraints:
- No direct filesystem access.
- No direct canonical writes.
- Mutations go through core API endpoints.

### 7.3 Mutation trust policy

To preserve rem's trust model ("agents propose; humans accept"):

1. Plugin actions invoked as `actorKind=agent`:
   - MUST use proposal APIs for note content mutation.
   - MUST NOT call direct note overwrite APIs except for explicitly whitelisted automation flows.
2. Plugin actions invoked as `actorKind=human`:
   - MAY call note/entity write APIs when permissioned.
3. Scheduled tasks default to `actorKind=agent` unless configured otherwise.
4. Any direct-write override must emit explicit event metadata:
   - `overrideReason`
   - `approvedBy` (if present)
   - `sourcePlugin`

### 7.4 Core boundary rule

Core does not execute plugin modules. Core only:
- validates manifests and payload/entity schemas
- persists canonical plugin/entity data
- emits events
- updates index

---

## 8) Data Model Extensions for Plugin-Defined Entities

### 8.1 Motivation

`person` and `meeting` should be plugin-defined primitives, not hardcoded in core.

### 8.2 Canonical layout (proposed)

```text
~/.rem/
  entities/
    <namespace>.<entityType>/
      <entityId>/
        entity.json
        meta.json
```

Notes:
- `entityType` is namespaced at storage level to avoid collisions.
- Plugin manifests define validation schema for each entity type.

### 8.3 Entity canonical contracts (proposed)

`entity.json`:
- `id`
- `namespace`
- `entityType`
- `schemaVersion`
- `data` (schema-validated payload)

`meta.json`:
- `createdAt`
- `updatedAt`
- `actor`
- optional `links` (to notes/entities)

### 8.4 Index extensions (proposed)

Add derived table(s):
- `entities` (`id`, `namespace`, `entity_type`, `schema_version`, `data_json`, `created_at`, `updated_at`)
- `entity_text` / `entities_fts` for text fields
- `entity_links` for note/entity references

### 8.5 Entity references and schema migration

Entity reference contract:
- Use structured references instead of free-form strings where possible:
  - `{ namespace, entityType, entityId }`
- Meeting attendees should use structured refs to person entities.

Entity schema evolution:
1. Plugin may bump `schemaVersion` for an entity type.
2. Core stores per-entity `schemaVersion` and permits mixed-version reads during migration windows.
3. Plugins may provide migration handlers or explicit one-time migration actions.
4. Rebuild-index must remain valid with mixed entity schema versions.

---

## 9) Event Contract Extensions

Add event types:
- `plugin.activated`
- `plugin.deactivated`
- `plugin.action_invoked`
- `plugin.action_failed`
- `plugin.task_ran`
- `entity.created`
- `entity.updated`
- `entity.deleted`

All events remain append-only and schema-versioned.

Event payload minimums:
- plugin action events include:
  - `namespace`
  - `actionId`
  - `requestId`
  - `actorKind`
  - `durationMs`
  - `status` (`success` | `failure`)
  - `errorCode` (if failure)
- scheduled task events include:
  - `taskId`
  - `scheduledFor`
  - `startedAt`
  - `finishedAt`
  - `idempotencyKey`

CLI/API runtime error mapping (must stay identical across hosts):
- guard `timeout` -> `plugin_action_timeout`
- guard `payload_too_large` -> `plugin_input_too_large`
- guard `output_too_large` -> `plugin_output_too_large`
- guard `concurrency_limit` -> `plugin_concurrency_limited`
- all other runtime failures -> `plugin_run_failed`

Host observability requirement:
- each successful action invocation emits exactly one `plugin.action_invoked`
- each failed action invocation emits exactly one `plugin.action_failed`

Event volume guardrail:
- `plugin.action_invoked` SHOULD be emitted once per completed invocation (not per internal step).

---

## 10) API and CLI Surface (proposed additions)

### 10.1 CLI

- `rem plugin run <namespace> <action> --input <json-or-path> --json`
- `rem plugin install --manifest <path> [--plugin-path <path>] --json`
- `rem plugin uninstall <namespace> --json`
- `rem plugin enable <namespace>`
- `rem plugin disable <namespace>`
- `rem plugin inspect <namespace> --json`

Entity-oriented:
- `rem entities save --namespace <ns> --type <entityType> --input <path> --json`
- `rem entities list --namespace <ns> --type <entityType> --json`
- `rem entities get --namespace <ns> --type <entityType> --id <id> --json`
- `rem entities migrate --namespace <ns> --type <entityType> --action <actionId> [--from-schema-version <v>] [--dry-run] --json`

### 10.2 API

- `POST /plugins/:namespace/actions/:actionId`
- `POST /plugins/install`
- `POST /plugins/:namespace/uninstall`
- `POST /plugins/:namespace/enable`
- `POST /plugins/:namespace/disable`
- `GET /plugins/:namespace`

Entity endpoints:
- `POST /entities`
- `GET /entities`
- `GET /entities/:namespace/:entityType/:id`
- `PUT /entities/:namespace/:entityType/:id`
- `POST /entities/migrations/run`

All write routes remain core-gated and schema-validated.

Install surfaces in this phase are local-path based only; no remote registry resolution.

---

## 11) Security and Trust Model

1. Plugin permissions are declared in manifest and enforced by host.
2. Plugins are disabled by default when permissions expand after update.
3. Hosts apply allowlists per command/action for sensitive operations.
4. Plugin runtime failures are isolated and do not corrupt core state.
5. Core schema validation remains final protection layer.
6. Hosts only load plugins from trusted roots (bundled paths or explicitly configured local paths).
7. Plugin entrypoint path traversal is rejected (resolved path must stay under allowed root).
8. API-triggered plugin actions require auth parity with existing API token controls.

Optional future hardening:
- signed plugin bundles
- execution isolation via worker process with memory/time quotas

### 11.1 Scheduler semantics and reliability

1. Schedule evaluation uses host local timezone unless task declares `schedule.timezone`.
2. Task execution is idempotent per `(taskId, scheduled slot, idempotencyKey)`.
3. Host records run ledger entries so restarts do not duplicate the same schedule slot.
4. Missed run policy defaults to "run once on next startup if within runWindowMinutes".
5. Concurrent runs of the same task are rejected unless explicitly configured.

### 11.2 Known gaps not covered yet

The design intentionally leaves these topics unresolved for later phases:
- plugin dependency graph management (plugin A requiring plugin B)
- plugin-to-plugin API contracts and cross-plugin data coupling rules
- uninstall data retention policy (delete vs retain plugin-owned entities/data)
- rollback semantics for failed plugin updates
- backup/restore interactions for runtime state (`enabled/disabled`, scheduler ledger)

---

## 12) Example Mappings

### 12.1 Daily note plugin

Capabilities:
- `templates`
- `scheduled_tasks`
- `cli_actions`

Behavior:
- Provides daily note template
- Schedules note creation each morning
- Supports `create_for_date` CLI action

### 12.2 Templates plugin

Capabilities:
- `templates`
- optional `ui_panels`

Behavior:
- Registers template catalog
- Exposes “Insert Template” UI panel/command

### 12.3 Person plugin

Capabilities:
- `entities`
- optional `ui_panels`

Entity type:
- `person` with fields such as `name`, `emails`, `team`, `aliases`

### 12.4 Meeting plugin

Capabilities:
- `entities`
- `templates`
- optional `cli_actions`

Entity type:
- `meeting` with fields such as `title`, `startAt`, `attendees[]` (entity references)

---

## 13) Phased Delivery Plan

### Phase 1: Declarative plugin capabilities

- Add manifest v2 schema and compatibility support.
- Add template and scheduled-task declarations.
- Add plugin enable/disable state and events.
- Add lifecycle persistence (`registered`/`installed`/`enabled`/`disabled`).
- Add host compatibility checks (`remVersionRange`) and disable reasons.
- Keep runtime code execution limited.

### Phase 2: CLI action runtime

- Add plugin action host in CLI.
- Add permission checks and action event logging.
- Add `rem plugin run` contract.
- Enforce agent mutation trust policy (proposal-first for agent actors).

### Phase 3: Generic entity runtime

- Add core entity persistence/index/event APIs.
- Add CLI/API entity commands and routes.
- Implement `person`/`meeting` as plugin-defined entity types.
- Add mixed-version entity read compatibility and migration pathway.

### Phase 4: UI runtime expansion

- Add UI panel slots + command surfaces.
- Bind declarative and executable UI plugin entrypoints.
- Add proposal-review integrations for entity-aware workflows.

### 13.1 Intentional deferrals (to keep first epic tractable)

The first epic should defer:
- third-party plugin signing and trust-chain infrastructure
- remote plugin catalog/discovery UX
- fully dynamic UI executable entrypoints (start with declarative panel metadata)
- cross-machine plugin sync semantics

---

## 14) Testing Strategy

1. Schema tests
   - Manifest v1/v2 compatibility
   - Capability-specific schema validation
   - Capability/permission consistency validation
2. Permission tests
   - Deny unauthorized action attempts
   - Ensure correct error contracts
   - Verify permission expansion forces plugin disable until re-approved
3. Runtime tests
   - Plugin action success/failure event emission
   - Timeout and isolation behavior
   - Path traversal and untrusted-root loading rejection
4. Entity tests
   - Schema enforcement for entity writes
   - Rebuild-index parity for entities
   - Mixed schemaVersion reads during migration windows
5. End-to-end tests
   - Daily note task creates deterministic note
   - Person/meeting entity flows via CLI and API
   - Scheduler idempotency across process restart
   - Agent-invoked plugin mutation path uses proposals by default

---

## 15) Open Questions

1. Should scheduled tasks run only through CLI host, or via API daemon mode too?
2. Do we require signed plugins before enabling executable runtime beyond local bundles?
3. Should plugin-permission approval be persisted globally or per host (CLI vs UI)?
4. What is the minimum viable UI plugin slot set for Phase 4?
5. Should entity references be normalized in core (`entity_links`) at write time or rebuild time?
6. Should API action execution be allowed when UI/CLI hosts are unavailable, or remain host-local only?
7. What plugin package format should be canonical for install (`tar.gz`, folder path, npm-style package)?

---

## 16) Acceptance Criteria for First Implementation Slice

1. Manifest v2 is supported with backwards-compatible v1 handling.
2. Manifest validation enforces capability and permission consistency rules.
3. Plugins can be enabled/disabled with events emitted and disable reasons surfaced.
4. Declarative templates are loadable from manifest and usable by host.
5. Scheduler executes tasks idempotently across restart for the same schedule slot.
6. Agent-invoked plugin actions mutate note content through proposals by default.
7. No regression in current v1 plugin payload validation on note writes.
8. Data contracts and API/CLI references are updated to include new plugin contracts.
