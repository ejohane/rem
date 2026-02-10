# rem V1 API and CLI Reference

This reference documents the V1 interface contracts added/updated in Phase 2.

Related docs:
- Operational workflows: `docs/runbook.md`
- Product requirements traceability: `docs/prd.md`

## API auth

- Optional bearer token auth is controlled by `REM_API_TOKEN`.
- When `REM_API_TOKEN` is set, API requests must include:
  - `Authorization: Bearer <token>`
- When `REM_API_TOKEN` is unset, auth is not required.

## API endpoint matrix

| Area | Method | Path | Purpose |
| --- | --- | --- | --- |
| Status | `GET` | `/status` | Service health and indexed counts |
| Search | `GET` | `/search` | FTS with optional tags/time filters |
| Notes | `POST` | `/notes` | Create/update canonical note |
| Notes | `PUT` | `/notes/:id` | Update existing canonical note |
| Notes | `GET` | `/notes/:id` | Canonical note payload |
| Notes | `GET` | `/notes/:id/text` | Extracted plaintext |
| Sections | `GET` | `/sections?noteId=...` | Indexed note sections |
| Proposals | `POST` | `/proposals` | Create proposal |
| Proposals | `GET` | `/proposals` | List proposals |
| Proposals | `GET` | `/proposals/:id` | Get proposal |
| Proposals | `POST` | `/proposals/:id/accept` | Accept proposal |
| Proposals | `POST` | `/proposals/:id/reject` | Reject proposal |
| Plugins | `POST` | `/plugins/register` | Register/update plugin manifest |
| Plugins | `GET` | `/plugins` | List plugin manifests |
| Events | `GET` | `/events` | Query event history |
| Migration | `POST` | `/migrations/sections` | Backfill durable section identity metadata |
| Index | `POST` | `/rebuild-index` | Rebuild derived index |

## API query and body parameters

### `GET /search`
- Query params:
  - `q` (string, required)
  - `limit` (number, optional, default `20`)
  - `tags` (comma-separated string, optional)
  - `noteTypes` (comma-separated string, optional)
  - `pluginNamespaces` (comma-separated string, optional)
  - `createdSince` (ISO datetime, optional)
  - `createdUntil` (ISO datetime, optional)
  - `updatedSince` (ISO datetime, optional)
  - `updatedUntil` (ISO datetime, optional)

### `POST /notes`
- Body:
  - `id?`, `title`, `noteType?`, `lexicalState`, `tags?`, `plugins?`, `actor?`

### `PUT /notes/:id`
- Body:
  - `title`, `noteType?`, `lexicalState`, `tags?`, `plugins?`, `actor?`

### `GET /events`
- Query params:
  - `since?`, `limit?`, `type?`
  - `actorKind?`, `actorId?`
  - `entityKind?`, `entityId?`

### `GET /status`
- Response adds:
  - `lastIndexedEventAt` (`string | null`)
  - `healthHints` (`string[]`)

### `POST /plugins/register`
- Body:
  - `manifest`:
    - `namespace`
    - `schemaVersion`
    - `payloadSchema` (object schema subset)
  - `registrationKind?` (`static` or `dynamic`)
  - `actor?`

### Auth behavior
- When `REM_API_TOKEN` is set, API requests require:
  - `Authorization: Bearer <token>`
- Missing/invalid bearer token returns:
  - `401` with `{"error":{"code":"unauthorized","message":"Invalid or missing bearer token"}}`
- When `REM_API_TOKEN` is unset, auth is not required.

## CLI command matrix

| Area | Command | Purpose |
| --- | --- | --- |
| Status | `rem status --json` | Service status + indexed counts + index hints |
| Search | `rem search "<query>" --tags <csv> --note-types <csv> --plugin-namespaces <csv> --created-since <iso> --created-until <iso> --updated-since <iso> --updated-until <iso> --json` | Filtered search |
| Notes | `rem notes save --input <path> [--actor-kind human|agent --actor-id <id>] --json` | Save note payload |
| Get note | `rem get note <id> --format lexical|text|md --json` | Read note |
| Sections | `rem sections list --note <id> --json` | Section list |
| Proposals | `rem proposals create/list/get/accept/reject ... --json` | Proposal lifecycle |
| Plugins | `rem plugin register --manifest <path> --json` | Register plugin |
| Plugins | `rem plugin list --limit <n> --json` | List plugins |
| Events | `rem events tail --limit <n> --json` | Recent events |
| Events | `rem events list --since <iso> --entity-kind <kind> --json` | Filtered events |
| Migration | `rem migrate sections --json` | Backfill durable section identity metadata |
| Index | `rem rebuild-index --json` | Rebuild derived index |
| Runtime | `rem api --host <host> --port <port> [--ui-dist <path>]` | Run the packaged API binary |
| Runtime | `rem app --host <host> --port <port> [--ui-dist <path>]` | Run full app (API + UI) |

## Request/response examples

### Register plugin (API)

```bash
curl -X POST "http://127.0.0.1:8787/plugins/register" \
  -H "content-type: application/json" \
  -d '{
    "manifest": {
      "namespace": "tasks",
      "schemaVersion": "v1",
      "payloadSchema": {
        "type": "object",
        "required": ["board"],
        "properties": {
          "board": { "type": "string" },
          "done": { "type": "boolean" }
        },
        "additionalProperties": false
      }
    },
    "actor": { "kind": "human", "id": "operator" }
  }'
```

Example response:

```json
{
  "namespace": "tasks",
  "eventId": "...",
  "created": true,
  "manifest": { "...": "..." },
  "meta": { "...": "..." }
}
```

### Search with tags/note-type/plugin filters (CLI)

```bash
bun run --cwd apps/cli src/index.ts search "deploy" \
  --tags ops \
  --note-types task \
  --plugin-namespaces tasks \
  --created-since 2026-02-01T00:00:00.000Z \
  --updated-since 2026-02-01T00:00:00.000Z \
  --json
```

### Run section identity migration (CLI)

```bash
bun run --cwd apps/cli src/index.ts migrate sections --json
```

### Update note by id (API)

```bash
curl -X PUT "http://127.0.0.1:8787/notes/<note-id>" \
  -H "content-type: application/json" \
  -d @note-update.json
```

### Event query (API)

```bash
curl "http://127.0.0.1:8787/events?entityKind=plugin&limit=20"
```

## Error mapping reference

API errors use:

```json
{
  "error": {
    "code": "unauthorized|bad_request|not_found|invalid_transition|internal_error",
    "message": "..."
  }
}
```

Common cases:
- `unauthorized`: missing or invalid bearer token when `REM_API_TOKEN` is configured
- `bad_request`: schema/payload validation failures (including `PUT /notes/:id` id mismatch)
- `not_found`: missing notes/proposals
- `invalid_transition`: proposal status transition violations
