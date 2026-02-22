# rem API and CLI Reference
**Last updated:** 2026-02-22

**Last updated:** 2026-02-22

This reference documents the implemented Plugin Runtime v1 interfaces.

Related docs:
- Contracts: `docs/data-contracts.md`
- Operations: `docs/runbook.md`

## API auth

- Optional bearer token auth is controlled by `REM_API_TOKEN`.
- When `REM_API_TOKEN` is set, all API routes require:
  - `Authorization: Bearer <token>`
- Missing/invalid token returns `401 unauthorized`.

## API endpoint matrix

| Area | Method | Path | Purpose |
| --- | --- | --- | --- |
| Status | `GET` | `/status` | Indexed counts + health hints |
| Config | `GET` | `/config` | Read active store-root configuration |
| Config | `PUT` | `/config` | Update store-root configuration |
| Daily notes | `POST` | `/daily-notes/today` | Get-or-create today's daily note |
| Search | `GET` | `/search` | Note search with filters |
| Notes | `POST` | `/notes` | Create/update canonical note |
| Notes | `PUT` | `/notes/:id` | Update existing canonical note |
| Notes | `GET` | `/notes/:id` | Canonical note payload |
| Notes | `GET` | `/notes/:id/text` | Extracted plaintext |
| Sections | `GET` | `/sections?noteId=...` | Indexed note sections |
| Events | `GET` | `/events` | Query event history |
| Proposals | `POST` | `/proposals` | Create proposal |
| Proposals | `GET` | `/proposals` | List proposals |
| Proposals | `GET` | `/proposals/:id` | Get proposal |
| Proposals | `POST` | `/proposals/:id/accept` | Accept proposal |
| Proposals | `POST` | `/proposals/:id/reject` | Reject proposal |
| Plugins | `POST` | `/plugins/register` | Register/update manifest |
| Plugins | `POST` | `/plugins/install` | Register + install plugin |
| Plugins | `GET` | `/plugins` | List plugins |
| Plugins | `GET` | `/plugins/:namespace` | Inspect plugin |
| Plugins | `POST` | `/plugins/:namespace/enable` | Enable plugin |
| Plugins | `POST` | `/plugins/:namespace/disable` | Disable plugin |
| Plugins | `POST` | `/plugins/:namespace/uninstall` | Uninstall plugin |
| Plugin runtime | `POST` | `/plugins/:namespace/actions/:actionId` | Invoke plugin action in API host |
| Templates | `GET` | `/templates` | List plugin templates |
| Templates | `POST` | `/templates/apply` | Apply template to create note |
| Scheduler | `GET` | `/scheduler/status` | Scheduler ledger/task status |
| Scheduler | `POST` | `/scheduler/run` | Execute due scheduled tasks |
| Entities | `POST` | `/entities` | Create plugin entity |
| Entities | `GET` | `/entities` | List plugin entities |
| Entities | `GET` | `/entities/:namespace/:entityType/:id` | Get plugin entity |
| Entities | `PUT` | `/entities/:namespace/:entityType/:id` | Update plugin entity |
| Entity migration | `POST` | `/entities/migrations/run` | Deterministic entity schema migration |
| Migration | `POST` | `/migrations/sections` | Backfill durable section identity metadata |
| Index | `POST` | `/rebuild-index` | Rebuild derived index |

## Key API request contracts

### `GET /search`
Query params:
- `q` (required)
- `limit?` (default `20`, max `200`)
- `tags?` (comma-separated)
- `noteTypes?` (comma-separated)
- `pluginNamespaces?` (comma-separated)
- `createdSince?`, `createdUntil?`, `updatedSince?`, `updatedUntil?` (ISO datetimes)

Daily-note date normalization:
- when `q` matches one of:
  - `M-D-YYYY`
  - `MM-DD-YYYY`
  - `M/D/YYYY`
  - `MM/DD/YYYY`
  - `YYYY-MM-DD`
- API normalizes query to daily display-title form (`Weekday Mon Dth YYYY`) before search.
- punctuation-heavy/malformed FTS queries are sanitized/fallbacked rather than returning server errors.

### `POST /daily-notes/today`
Body:
- `timezone?` (IANA timezone; defaults to host local timezone)
- `now?` (ISO datetime override for deterministic testing)
- `actor?`

Response:
- `noteId`, `created`, `title`, `dateKey`, `shortDate`, `timezone`

### `POST /notes`
Body:
- `id?`, `title`, `noteType?`, `lexicalState`, `tags?`, `plugins?`, `actor?`

### `PUT /notes/:id`
Body:
- `title`, `noteType?`, `lexicalState`, `tags?`, `plugins?`, `actor?`

### `GET /events`
Query params:
- `since?`, `limit?`, `type?`
- `actorKind?`, `actorId?`
- `entityKind?`, `entityId?`

### `POST /plugins/register`
Body:
- `manifest` (v1 or v2 plugin manifest)
- `registrationKind?` (`static` or `dynamic`)
- `actor?`

### `POST /plugins/:namespace/actions/:actionId`
Body:
- `input?` (JSON payload)
- `pluginPath?` (explicit runtime plugin path)
- `trustedRoots?` (string array or comma-separated string)
- `requestId?`
- `timeoutMs?`, `maxInputBytes?`, `maxOutputBytes?`, `maxConcurrentInvocationsPerPlugin?`
- `actor?` (`{ kind: "human"|"agent", id?: string }`)

Response includes:
- `namespace`, `actionId`, `requestId`, `eventId`, `actor`
- `durationMs`, `inputBytes`, `outputBytes`
- `result`

### `POST /templates/apply`
Body:
- `namespace`, `templateId`
- optional `title`, `noteType`, `tags`, `actor`

### `POST /scheduler/run`
Body:
- optional `now` (ISO datetime)
- optional `namespaces` (array or comma-separated)
- optional `actor`

### `POST /entities`
Body:
- `namespace`, `entityType`
- optional `id`, `schemaVersion`, `links`, `actor`
- `data` (object)

### `GET /entities`
Query params:
- `namespace` (required)
- `entityType` (required)
- `schemaVersion?`

### `POST /entities/migrations/run`
Body:
- `namespace` (required)
- `entityType` (required)
- `actionId` (required)
- `targetSchemaVersion?` (must match manifest schemaVersion)
- `fromSchemaVersion?`
- `dryRun?`
- optional runtime options mirroring action invocation (`pluginPath`, `trustedRoots`, guard limits, `actor`, `requestId`)

## CLI command matrix

Use `bun run --cwd apps/cli src/index.ts ...` in source checkouts.

| Area | Command | Purpose |
| --- | --- | --- |
| Status | `status --json` | Service status + indexed counts + hints |
| Search | `search "<query>" ... --json` | Filtered note search |
| Notes | `notes save --input <path> --json` | Save note payload |
| Read | `get note <id> --format lexical|text|md --json` | Read note |
| Sections | `sections list --note <id> --json` | List section identities |
| Proposals | `proposals create/list/get/accept/reject ... --json` | Proposal lifecycle |
| Events | `events list|tail ... --json` | Event history |
| Plugins | `plugin register --manifest <path> --json` | Register/update plugin |
| Plugins | `plugin install --manifest <path> --json` | Register + install plugin |
| Plugins | `plugin list --json` | List plugins |
| Plugins | `plugin inspect <namespace> --json` | Inspect plugin manifest/meta |
| Plugins | `plugin enable|disable|uninstall <namespace> --json` | Lifecycle transitions |
| Plugin runtime | `plugin run <namespace> <action-id> ... --json` | Invoke plugin action in CLI host |
| Templates | `plugin templates list|apply ... --json` | Template discovery and apply |
| Scheduler | `plugin scheduler status|run ... --json` | Scheduler status and execution |
| Entities | `entities save|get|list ... --json` | Entity CRUD/list |
| Entity migration | `entities migrate ... --json` | Deterministic entity schema migration |
| Migration | `migrate sections --json` | Backfill section identity metadata |
| Index | `rebuild-index --json` | Rebuild derived index |
| Skills | `skill list` / `skill install <skill-id> --json` | List/install bundled canned agent skills |
| Runtime | `api` / `app` | Launch API-only or API+UI runtime |
| Runtime | `update ... [--check|--force] [--json]` | Update macOS binary install from GitHub releases |

## CLI binary update (macOS)

`update` installs release tarballs in place by downloading:
- `rem-<version>-macos-<arch>.tar.gz`
- `rem-<version>-macos-<arch>.tar.gz.sha256`

Behavior:
- resolves target version from `--version` or latest release
- verifies checksum before extraction/install
- runs package `install.sh` with selected install options
- checks installed version (from `REM_VERSION`, `VERSION`, or `package.json`) and skips when already current unless `--force`

Options:
- `--repo <owner/repo>` (default: `ejohane/rem`)
- `--version <MAJOR.MINOR.PATCH>` (optional)
- `--arch <arm64|x64>` (optional override)
- `--install-dir <path>` and `--bin-dir <path>` (optional installer overrides)
- `--local` (install to `$HOME/.local/...`; cannot be combined with custom dirs)
- `--check` (no install; report availability)
- `--force` (reinstall even when current version matches target)
- `--json` (machine-readable output)

## Runtime guardrails and trust options

`plugin run` and `entities migrate` support:
- `--trusted-roots <csv>`
- `--plugin-path <path>`
- `--timeout-ms <n>`
- `--max-input-bytes <n>`
- `--max-output-bytes <n>`
- `--max-concurrency <n>`

Guard defaults:
- timeout: `15000ms`
- max input: `65536` bytes
- max output: `262144` bytes
- max concurrency per plugin: `1`

## Error mapping reference

Standard API error envelope:

```json
{
  "error": {
    "code": "...",
    "message": "..."
  }
}
```

Common API error codes:
- `unauthorized` (missing/invalid bearer token)
- `bad_request` (validation/runtime contract violations)
- `not_found` (missing note/proposal/plugin/entity)
- `invalid_transition` (proposal status or plugin lifecycle transition conflict)
- `internal_error` / `storage_error`

Plugin action runtime error codes (API and CLI parity):
- `plugin_action_timeout`
- `plugin_input_too_large`
- `plugin_output_too_large`
- `plugin_concurrency_limited`
- `plugin_run_failed`

CLI update command error codes:
- `update_unsupported_platform`
- `update_invalid_repo`
- `update_invalid_version`
- `update_invalid_arch`
- `update_release_fetch_failed`
- `update_asset_not_found`
- `update_download_failed`
- `update_invalid_checksum`
- `update_checksum_mismatch`
- `update_extract_failed`
- `update_installer_missing`
- `update_install_failed`

## Examples

### Install bundled umbrella canned skill (CLI)

```bash
bun run --cwd apps/cli src/index.ts skill list --json
bun run --cwd apps/cli src/index.ts skill install rem-cli-memory --json
```

### Install and enable plugin (CLI)

```bash
bun run --cwd apps/cli src/index.ts plugin install --manifest ./plugin-manifest.json --json
bun run --cwd apps/cli src/index.ts plugin enable my-plugin --json
```

### Check and apply binary update (CLI)

```bash
bun run --cwd apps/cli src/index.ts update --check --json
bun run --cwd apps/cli src/index.ts update --json
```

### Run plugin action with runtime guards (CLI)

```bash
bun run --cwd apps/cli src/index.ts plugin run my-plugin sync_people \
  --input '{"team":"core"}' \
  --timeout-ms 10000 \
  --max-input-bytes 32768 \
  --max-output-bytes 131072 \
  --max-concurrency 1 \
  --json
```

### Run entity migration (CLI)

```bash
bun run --cwd apps/cli src/index.ts entities migrate \
  --namespace person \
  --type person \
  --action migrate_person \
  --from-schema-version v1 \
  --dry-run \
  --json
```

### Invoke plugin action (API)

```bash
curl -X POST "http://127.0.0.1:8787/plugins/my-plugin/actions/sync_people" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d '{
    "input": {"team": "core"},
    "actor": {"kind": "human", "id": "api-runner"},
    "timeoutMs": 10000
  }'
```

### Create and fetch plugin entities (API)

```bash
curl -X POST "http://127.0.0.1:8787/entities" \
  -H "authorization: Bearer ${REM_API_TOKEN}" \
  -H "content-type: application/json" \
  -d '{
    "namespace": "person",
    "entityType": "person",
    "id": "alice",
    "data": {"name": "Alice"}
  }'

curl "http://127.0.0.1:8787/entities/person/person/alice" \
  -H "authorization: Bearer ${REM_API_TOKEN}"
```
