# rem Extension Playbook

Use this guide when extending rem after Phase 2.

## Safe extension workflow

1. Add/adjust schema in `packages/schemas/src/index.ts`.
2. Extend canonical persistence (`packages/store-fs/src/index.ts`) if storage changes.
3. Extend derived indexing (`packages/index-sqlite/src/index.ts`).
4. Update core orchestration (`packages/core/src/index.ts`).
5. Expose interface changes in API (`apps/api/src/index.ts`) and CLI (`apps/cli/src/index.ts`).
6. Add tests:
   - unit tests for schema/store/index/core
   - contract tests for API/CLI behavior
7. Update docs (`docs/runbook.md`, `docs/api-cli-reference.md`, `docs/data-contracts.md`).

## Add a new proposal type

Checklist:
1. Add value to `proposalTypeSchema`.
2. Add apply logic in `RemCore.acceptProposal`.
3. Emit proposal and note update events with typed payload details.
4. Add tests:
   - proposal creation validation
   - acceptance behavior
   - event payload assertions
5. Add API/CLI support if new inputs are needed.

Guardrails:
- Never bypass section identity checks (`noteId + sectionId + fallbackPath`).
- Keep acceptance behavior deterministic and idempotent per proposal state.

## Add a new plugin capability

Checklist:
1. Define plugin manifest `payloadSchema`.
2. Register via `registerPlugin` core flow (canonical + indexed + event emission).
3. Validate note plugin payloads during note save.
4. Add API/CLI examples for registration and usage.
5. Update event catalog and data contract docs.

Guardrails:
- Reject note writes with unregistered plugin namespaces.
- Reject payloads that violate required fields/type contracts.

## UI plugin host contract

The UI exposes a lightweight plugin host contract in:
- `apps/ui/src/editor-plugins.ts`

Contract shape:
- `EditorPluginContext`
  - `plainText`
  - `tags`
  - `noteId`
  - `draftId`
- `EditorPluginDefinition`
  - `id`
  - `title`
  - `render(context) => string`

Extension workflow:
1. Add a plugin definition to `defaultEditorPlugins`.
2. Keep plugin output deterministic and side-effect free.
3. Add tests in `apps/ui/src/editor-plugins.test.ts`.

## Evolve schemas/events safely

Checklist:
1. Preserve backward compatibility where possible.
2. Add version-aware readers before changing writers.
3. Avoid destructive canonical rewrites by default.
4. Ensure `rebuild-index` can replay canonical files/events into a valid DB.
5. Add regression tests for old and new payload variants.

Event evolution:
- Add new event types rather than mutating semantics of existing types.
- Keep old payload keys stable for existing consumers.

## PRD to code traceability (V1 implemented scope)

| PRD capability | Primary implementation |
| --- | --- |
| Explicit note update API (`PUT /notes/:id`) | `apps/api/src/index.ts`, `docs/api-cli-reference.md`, `packages/core/src/phase2-contracts.test.ts` |
| Search facets (tags/created+updated time/noteTypes/pluginNamespaces) | `packages/index-sqlite/src/index.ts`, `packages/core/src/index.ts`, `apps/api/src/index.ts`, `apps/cli/src/index.ts`, `packages/core/src/core.test.ts` |
| Note write provenance parity (human/agent actor support) | `apps/api/src/index.ts`, `apps/cli/src/index.ts`, `packages/core/src/index.ts`, `packages/core/src/phase2-contracts.test.ts` |
| Durable section identity + migration/backfill | `packages/extractor-lexical/src/index.ts`, `packages/core/src/index.ts`, `apps/api/src/index.ts`, `apps/cli/src/index.ts`, `packages/core/src/core.test.ts` |
| Optional API token auth | `apps/api/src/index.ts`, `packages/core/src/phase2-contracts.test.ts`, `docs/api-cli-reference.md`, `docs/runbook.md` |
| Status observability (`lastIndexedEventAt`, `healthHints`) | `packages/core/src/index.ts`, `apps/cli/src/index.ts`, `docs/runbook.md`, `docs/api-cli-reference.md` |
| Event query interface | `packages/index-sqlite/src/index.ts`, `packages/core/src/index.ts`, `apps/api/src/index.ts`, `apps/cli/src/index.ts` |
| Draft first-class lifecycle | `packages/store-fs/src/index.ts`, `packages/index-sqlite/src/index.ts`, `packages/core/src/index.ts`, `apps/api/src/index.ts`, `apps/cli/src/index.ts`, `apps/ui/src/App.tsx` |
| Plugin registry and schema enforcement | `packages/schemas/src/index.ts`, `packages/store-fs/src/index.ts`, `packages/core/src/index.ts`, `apps/api/src/index.ts`, `apps/cli/src/index.ts`, `docs/data-contracts.md` |
| Proposal review with section context | `apps/ui/src/App.tsx`, `apps/ui/src/proposals.ts`, `apps/ui/src/proposals.test.ts` |
| Lexical editor baseline + plugin host hooks | `apps/ui/src/App.tsx`, `apps/ui/src/lexical.ts`, `apps/ui/src/editor-plugins.ts`, `apps/ui/src/editor-plugins.test.ts` |
| Contract coverage | `packages/core/src/phase2-contracts.test.ts`, `packages/core/src/core.test.ts` |

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
