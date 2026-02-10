# Design Doc: rem — Architecture & Technical Design

**Document status:** Draft (v1)  
**Owner:** Erik  
**Last updated:** 2026-02-06  
**Project:** rem

---

## 1) Architecture Overview

rem is a single local-first product composed of:
1) **rem UI** — human-facing note-taking app (Lexical + plugin architecture)
2) **rem Core** — canonical data manager, schema gatekeeper, event emitter, proposal manager
3) **rem Index** — derived SQLite store for search and fast querying (rebuildable)
4) **Agent interfaces** — `rem` CLI and localhost HTTP API

Key design posture:
- Canonical truth is in **files**.
- History is an append-only **event log** (files).
- SQLite is derived and rebuildable (FTS + indexes).
- Agents never directly mutate canonical notes — they create proposals.

---

## 2) Non-Negotiable Decisions (from product)

1) Files are canonical for notes and events  
2) Core owns all canonical writes (strict)  
3) Agents propose; humans accept  
4) Explicit append-only event log (filesystem JSONL)  
5) SQLite indexes are derived  
6) Strict schema validation; reject invalid writes  
7) Hybrid plugin registry (static + dynamic)  
8) Migrations are non-destructive by default (optional compaction)  
9) Drafts/proposals are first-class objects  
10) Proposal granularity is section-level  
11) Sections have stable IDs + fallback path

---

## 3) System Components

### 3.1 rem UI (Lexical App)
Responsibilities:
- editor UX (Lexical)
- plugin UX surfaces
- proposal review UX (at least list + accept/reject in v1)
- authentication is local-only (no multi-user in v1)

Non-responsibilities:
- writing canonical files directly (Core owns writes)
- schema validation logic (Core does)

### 3.2 rem Core
Responsibilities:
- canonical note CRUD (filesystem)
- canonical proposal CRUD (filesystem)
- schema validation gate for all writes
- event emission (append-only JSONL)
- plaintext extraction pipeline trigger (or inline extraction)
- orchestrating updates to derived SQLite index

### 3.3 rem Index (SQLite)
Responsibilities:
- full-text search (FTS5)
- indexed metadata facets
- event index for fast temporal queries
- proposal index and status tracking
- artifact registry (extracted text status, etc.)

Rebuild requirement:
- delete DB → rebuild from canonical files + events

### 3.4 Agent Interfaces
**CLI (primary):** `rem`  
**HTTP API (secondary):** localhost only, mirrors CLI

---

## 4) Data Model

## 4.1 Canonical Filesystem Layout (proposed)

```
~/.rem/
  config.json

  notes/
    <noteId>/
      note.json            # Lexical editor state
      meta.json            # typed metadata
      sections.json        # stable section IDs + path map (optional derived)
      revisions/           # optional snapshots / accepted revisions
        <revId>.json

  proposals/
    <proposalId>/
      proposal.json        # typed proposal object
      content.json         # proposed Lexical subtree or normalized payload
      meta.json            # provenance, timestamps

  events/
    2026-02/
      2026-02-06.jsonl     # append-only event stream

  attachments/
    <sha256>.<ext>

  index/
    rem.db                 # derived, rebuildable
```

Default canonical root is `~/.rem` (override with `REM_STORE_ROOT`).

Notes:
- Core writes atomically (temp + rename).
- Events are append-only. If rotation is daily/monthly, indexing must handle multiple files.

## 4.2 Canonical Object Schemas (high level)

### 4.2.1 Note Meta (`meta.json`)
Core fields (strict):
- `id: string`
- `schemaVersion: string`
- `title: string`
- `createdAt: ISO string`
- `updatedAt: ISO string`
- `author: { kind: "human" | "agent", id?: string }`
- `tags: string[]`
- `plugins: Record<pluginNamespace, pluginPayload>` (validated per plugin schema)
- `sectionIndexVersion: string` (if applicable)

### 4.2.2 Proposal (`proposal.json`)
- `id`
- `schemaVersion`
- `status: "open" | "accepted" | "rejected" | "superseded"`
- `createdAt`, `updatedAt`
- `actor: { kind: "agent", id: string }`
- `target: { noteId: string, sectionId: string, fallbackPath?: string[] }`
- `proposalType: "replace_section" | "annotate" | ...`
- `contentRef` (points to `content.json` or inline content)
- `rationale?: string`
- `confidence?: number` (optional)
- `source?: string` (which harness/tool produced it)

### 4.2.3 Event (JSONL line)
Strict schema, versioned. Core fields:
- `eventId`
- `schemaVersion`
- `timestamp`
- `type`
- `actor`
- `entity` (note/proposal/plugin)
- `payload` (typed, versioned)

Examples:
- `note.created`
- `note.updated`
- `proposal.created`
- `proposal.accepted`
- `proposal.rejected`
- `plugin.registered`

---

## 5) Section Identity & Addressing (critical)

Since proposals are section-level, rem must provide stable references.

### 5.1 Decision: Stable section IDs + fallback paths
- Each section has a stable `sectionId` (UUID-like).
- Stored in Lexical node attributes (or a parallel mapping file if needed).
- Also stored with a fallback human-readable path:
  - heading hierarchy path, used for debugging and as a secondary locator.

### 5.2 Section boundaries
Define “section” as:
- heading node + all content until next same/higher-level heading
- OR explicitly marked section nodes if you choose a plugin approach

Implementation approach:
- On note write, Core runs a deterministic “section indexer” over Lexical JSON:
  - ensures section nodes have IDs
  - computes fallbackPath[] from headings
  - stores mapping in `sections.json` and indexes in SQLite

This allows proposals to target:
- `noteId` + `sectionId` (primary)
- optional `fallbackPath` (secondary)

---

## 6) Write Paths and Trust Model

### 6.1 Canonical write ownership
All writes flow through Core:
- UI calls Core APIs for note saves.
- Agent calls CLI/API for proposals/annotations.

No direct filesystem mutation by clients.

### 6.2 Agent proposal lifecycle
1) Agent creates proposal:
   - `proposal.created` event emitted
   - canonical `proposals/<id>/...` created
   - SQLite index updated

2) Human reviews in UI:
   - list of open proposals
   - view target note section + proposed content

3) Accept proposal:
   - Core applies change to canonical note section
   - emits `proposal.accepted` + `note.updated`
   - updates derived indexes

4) Reject proposal:
   - emits `proposal.rejected`
   - proposal status updated

### 6.3 Why this model works
- Prevents silent corruption
- Establishes provenance chain
- Enables future merge/diff features safely

---

## 7) Indexing & Search

## 7.1 Plaintext extraction (v1 core requirement)
- Core extracts deterministic plaintext from Lexical JSON:
  - preserve headings with newline separators
  - convert lists to readable text
  - ignore non-text nodes except meaningful labels (e.g., link text)

Store extracted text:
- canonical? optional (artifact)
- derived in SQLite `document_text` table
- enough to power FTS and agent prompting via `GET /notes/:id/text`

## 7.2 SQLite schema (proposed)

Tables:
- `notes`
  - `id`, `title`, `created_at`, `updated_at`, `tags_json`, `meta_json`
- `note_text`
  - `note_id`, `plain_text`, `hash`, `extracted_at`
- `notes_fts` (FTS5)
  - `title`, `plain_text`

- `sections`
  - `note_id`, `section_id`, `fallback_path_json`, `heading_text`, `position`
- `proposals`
  - `id`, `status`, `created_at`, `updated_at`, `actor_id`, `note_id`, `section_id`, `proposal_type`, `rationale`
- `events`
  - `event_id`, `timestamp`, `type`, `actor_kind`, `actor_id`, `entity_kind`, `entity_id`, `payload_json`

- `plugins`
  - `namespace`, `schema_version`, `registration_kind (static|dynamic)`, `schema_json`

- `artifacts`
  - `entity_kind`, `entity_id`, `artifact_type`, `status`, `hash`, `updated_at`, `error`

## 7.3 Search strategies (v1)
- Keyword search via FTS5
- Filters via metadata fields (tags, plugin facets)
- Rank:
  - FTS rank + mild recency boost (optional)
- Explain:
  - matched terms + matched fields (title/body) for trust

## 7.4 V2: hybrid search (planned)
- Add chunking table + embedding artifacts
- Hybrid candidate generation:
  - FTS candidates + semantic candidates
- Rerank pass (optional) using lightweight local model

---

## 8) Plugin System

## 8.1 Plugin registry model (hybrid)
- Static plugins: shipped with rem
- Dynamic plugins: installed/registered locally by user

All plugins must register:
- `namespace` (unique)
- `schemaVersion`
- schema definition (JSON schema or equivalent)
- optional index hints (facets, searchable fields)

Strict validation means:
- plugin payload written into note meta must validate against the plugin schema

## 8.2 Plugin data storage strategy
- Small plugin payloads live in `meta.json` under `plugins[namespace]`
- Larger plugin state:
  - stored in plugin-owned canonical files
  - referenced from meta
  - still validated by plugin schema rules

## 8.3 Example plugins
- daily notes (date-based note creation helpers)
- tasks (task extraction + tracking)
- meetings (structured meeting note templates)
- people (person entity registry)
- templates (note templates)

---

## 9) Event Log Design

## 9.1 Canonical events: JSONL files
- Stored under `events/YYYY-MM/<YYYY-MM-DD>.jsonl`
- Each line is a strict-schema event
- Append-only, never rewritten automatically

## 9.2 Derived event index in SQLite
- On startup / rebuild:
  - scan JSONL files
  - validate event schemas
  - insert into SQLite `events` table
- Provide fast queries:
  - events since timestamp
  - last N events
  - events by actor/type/entity

## 9.3 Migration and compatibility
- Events are versioned.
- Non-destructive by default:
  - readers support older versions
  - optional compaction tool can rewrite canonical files/events after explicit approval

---

## 10) APIs

## 10.1 CLI (`rem`) — primary agent interface
Design goals:
- stable commands
- `--json` output for automation
- composable with shells and harnesses

Suggested commands:
- `rem search "<query>" [--tags a,b] [--limit N] --json`
- `rem get note <id> --format lexical|text|md --json`
- `rem propose section --note <id> --section <sid> --content <path|stdin> --rationale "..."`
- `rem proposals list --status open --json`
- `rem proposals accept <pid> --json`
- `rem proposals reject <pid> --json`
- `rem events tail --limit 50 --json`
- `rem status --json`
- `rem rebuild-index --json`
- `rem plugin register <manifest.json> --json`

## 10.2 HTTP API — localhost mirror
- Bind to `127.0.0.1` by default
- Optional token auth

Endpoints:
- `GET /search?q=...`
- `GET /notes/:id`
- `GET /notes/:id/text`
- `POST /notes` (UI uses this; creates note)
- `PUT /notes/:id` (UI uses this; updates note)
- `GET /sections?noteId=...`
- `POST /proposals`
- `POST /proposals/:id/accept`
- `POST /proposals/:id/reject`
- `GET /proposals?status=open`
- `GET /events?since=...`
- `GET /status`

---

## 11) Reliability & Atomicity

### 11.1 Atomic file writes
- write temp file → fsync → rename
- avoid partial writes for canonical objects

### 11.2 Crash recovery
- canonical store is authoritative
- on startup:
  - validate canonical objects
  - rebuild/repair derived index as needed

### 11.3 Rebuild strategy
- `rem rebuild-index`:
  - delete `index/rem.db`
  - re-scan notes/proposals/events
  - re-extract plaintext
  - rebuild FTS and indexes

---

## 12) Security Posture
- local-only by default (`127.0.0.1`)
- no telemetry by default
- optional API token
- attachments stored locally with content hashing

---

## 13) Testing Strategy

### 13.1 Schema tests
- golden fixtures for:
  - note meta
  - proposals
  - events
  - plugin schemas

### 13.2 Extraction tests
- Lexical JSON fixtures → expected plaintext
- ensure deterministic behavior

### 13.3 Proposal application tests
- apply section replacement correctly
- ensure stable section IDs
- verify events emitted

### 13.4 Index rebuild tests
- delete DB → rebuild yields same search results for stable corpus

---

## 14) Observability
- structured logs (JSON) for:
  - indexing
  - schema failures
  - proposal acceptance/rejection
- `rem status` surfaces:
  - counts (notes, proposals, events)
  - last indexing time
  - schema validation failures
  - rebuild hints

---

## 15) Performance Considerations

- Use incremental indexing since Core owns writes:
  - update note_text + FTS on save
- Keep FTS queries fast via:
  - normalized plaintext storage
  - limited joins in hot paths
- Consider caching:
  - last N note texts in memory for `get text` calls

---

## 16) Implementation Notes (suggested stack)

Constraints-driven default:
- Local runtime (Node or Bun)
- SQLite + FTS5
- HTTP server (small; Hono works well)
- CLI framework (yargs/cmd-ts/etc.)
- JSON schema validation (Ajv or equivalent)

---

## 17) V2 Extension Points

### 17.1 Semantic artifacts
- add chunking pipeline as artifacts
- embedding generation as artifacts
- hybrid search in index

### 17.2 Graph layer
- entities + links tables
- infer backlinks, shared people/projects
- “related notes” recommendations

### 17.3 Rich proposal UX
- diff rendering for Lexical subtrees
- partial acceptance of proposals
- merge assistance

### 17.4 Policy & permissions
- agent capability limits
- proposal rate limits
- approval workflows

---

## 18) Open Technical Questions (intentionally deferred)
- Exact schema format (JSON Schema vs Zod-derived schemas)
- Best section boundary definition in Lexical for long-term stability
- Proposal diff visualization approach
- Embeddings model + local runtime approach
- Backup/sync recommendations (git vs other)

---
