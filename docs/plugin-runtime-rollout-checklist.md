# Plugin Runtime v1 Rollout Checklist

This document is the operational gate checklist for releasing Plugin Runtime v1.

Related docs:
- `docs/runbook.md`
- `docs/api-cli-reference.md`
- `docs/data-contracts.md`
- `docs/plugin-consumer-guide.md`

## Release objective

Enable Plugin Runtime v1 surfaces in production with:
- lifecycle-safe plugin operations (`register/install/enable/disable/uninstall`)
- guarded action runtime in CLI and API hosts
- templates/scheduler support
- plugin-defined entities with deterministic migration workflows
- UI editor stability with deferred plugin command/panel runtime integration

## Exit criteria (must all be true)

- all Plugin Runtime v1 epic children are closed
- quality gates pass (`lint`, `typecheck`, full `test`)
- docs are updated and linked
- migration guidance is documented and dry-run validated
- operational smoke checks pass in both CLI and API hosts
- risk mitigations and rollback steps are confirmed

## Phase gates

## Gate 0: Build and test parity

- [ ] `bun run lint` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run test` passes
- [ ] E2E fixture matrix coverage includes daily/templates/person/meeting flows
- [ ] no unresolved P0/P1 findings in code review

## Gate 1: Contract and security validation

- [ ] plugin manifest v1/v2 compatibility tests pass
- [ ] permission expansion disables plugin until explicit re-enable
- [ ] trusted-root + traversal hardening tests pass
- [ ] API auth parity is verified for plugin action invocation route
- [ ] action error mapping parity verified (`plugin_action_timeout`, `plugin_input_too_large`, `plugin_output_too_large`, `plugin_concurrency_limited`, `plugin_run_failed`)

## Gate 2: Runtime and host validation

- [ ] CLI plugin lifecycle commands succeed end-to-end
- [ ] API lifecycle routes succeed end-to-end
- [ ] CLI `plugin run` and API `/plugins/:namespace/actions/:actionId` emit action events
- [ ] templates list/apply work in CLI and API
- [ ] scheduler run/status work and ledger updates idempotently
- [ ] UI editor remains stable while plugin panel/command runtime surfaces are deferred

## Gate 3: Entity migration readiness

- [ ] section identity migration (`migrate sections`) dry-run behavior validated
- [ ] entity migration dry-run validated (`entities migrate --dry-run` or `/entities/migrations/run` with `dryRun=true`)
- [ ] execute-mode migration validated on fixture/test data
- [ ] deterministic ordering (`entity.id` ascending) verified
- [ ] mixed-version reads remain compatible during migration window
- [ ] `rebuild-index` parity validated after migration

## Gate 4: Operational rollout sign-off

- [ ] runbook and on-call troubleshooting links are current
- [ ] release notes include plugin lifecycle + runtime guardrails + migration guidance
- [ ] owner sign-off recorded for runtime, API, CLI, UI, and docs

## Migration guidance

## Section identity migration

Use when upgrading legacy notes:

```bash
bun run --cwd apps/cli src/index.ts migrate sections --json
```

Expect:
- `migration = section_identity_v2`
- `migrated + skipped = scanned`
- `schema.migration_run` events present for migrated notes

## Entity schema migration

Dry-run first:

```bash
bun run --cwd apps/cli src/index.ts entities migrate \
  --namespace <namespace> \
  --type <entity-type> \
  --action <migration-action-id> \
  --dry-run \
  --json
```

Execute after review:

```bash
bun run --cwd apps/cli src/index.ts entities migrate \
  --namespace <namespace> \
  --type <entity-type> \
  --action <migration-action-id> \
  --json
```

Expect:
- deterministic candidate order
- per-entity result status (`migrated` or `failed`)
- action events emitted for each migration invocation
- updated entities carry target schemaVersion

## Operational validation matrix

| Check | Command/API | Expected |
| --- | --- | --- |
| plugin lifecycle | `plugin install`, `plugin enable`, `plugin inspect` | state transitions and lifecycle events |
| action runtime success | `plugin run <ns> <action>` | result payload + `plugin.action_invoked` |
| action runtime failure | run with intentional timeout/size breach | mapped guard code + `plugin.action_failed` |
| API action parity | `POST /plugins/:namespace/actions/:actionId` | auth parity and equivalent event contracts |
| templates | `plugin templates list/apply` and `/templates*` | deterministic template outputs |
| scheduler | `plugin scheduler run/status` and `/scheduler*` | idempotent ledger/task event behavior |
| entities CRUD | `entities save/get/list` and `/entities*` | schema validation + compatibility metadata |
| entity migration | `entities migrate` and `/entities/migrations/run` | deterministic planning/execution |
| proposal context helpers | unit tests for proposal/entity parsing helpers | deterministic extraction behavior |
| rebuild parity | `rebuild-index` + `status` | canonical/derived counts remain consistent |

## Known risks and mitigations

| Risk | Signal | Mitigation |
| --- | --- | --- |
| plugin action runtime overload | timeout or concurrency guard errors spike | lower concurrency, tune action logic, increase limits only with review |
| trusted-root misconfiguration | runtime load failures from valid plugin roots | set explicit trusted roots in deployment env, verify canonical paths |
| permission drift after manifest update | plugin unexpectedly disabled | expected behavior; re-approve by explicit `enable` after review |
| scheduler duplicate concerns | repeated run attempts for same slot | validate dedupe keys and ledger; idempotency by design |
| entity migration data regressions | failed migration result rows | dry-run first, review outputs, keep rollback snapshot of canonical entities |
| API auth mismatch | unauthorized action route access attempts | enforce `REM_API_TOKEN` uniformly and validate bearer usage |
| UI runtime regressions | command/panel rendering failures | fallback to metadata-only panel rendering and disable blocked commands |

## Rollback and abort criteria

Abort rollout if any of the following occurs:
- repeated action runtime failures without clear guard tuning path
- migration failures above agreed threshold for critical entity types
- rebuild parity fails (count/lookup divergence)
- API auth or trusted-root controls fail to enforce expected policy

Rollback actions:
1. Disable affected plugins:

```bash
bun run --cwd apps/cli src/index.ts plugin disable <namespace> --reason rollback --json
```

2. Revert to previous manifest/runtime bundle.
3. Re-run `rebuild-index`.
4. Re-run smoke checks on notes/proposals core flows.
5. Re-enable only after root-cause fix and targeted validation.

## Release sign-off template

```text
Plugin Runtime v1 Rollout Sign-off
Date:
Environment:

Gate 0 (build/test): PASS/FAIL
Gate 1 (contract/security): PASS/FAIL
Gate 2 (runtime/hosts): PASS/FAIL
Gate 3 (migrations): PASS/FAIL
Gate 4 (ops sign-off): PASS/FAIL

Known exceptions:
-

Approvers:
- Runtime:
- API:
- CLI:
- UI:
- Docs/Ops:
```
