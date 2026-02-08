# PRD: rem — Local-First Human↔Agent Memory System

**Document status:** Draft (v1)  
**Owner:** Erik  
**Last updated:** 2026-02-06  
**Product codename/name:** rem

---

## 1) Summary

### 1.1 What is rem?
**rem** is a **local-first memory system** that acts as the glue between:
- a **human-driven note-taking UI** (Lexical-based editor + plugins), and
- **agent-driven workflows** (retrieval, suggestions, proposals) via CLI + localhost API.

rem stores notes locally, indexes them for retrieval, tracks provenance and history via an append-only event log, and provides a controlled collaboration model: **agents propose, humans accept**.

### 1.2 Why rem exists
In a corporate environment, you need a “second brain” that:
- runs entirely **locally** with minimal setup,
- avoids protocols that are blocked (e.g., **no MCP**),
- supports both human note taking and agent augmentation,
- maintains **trust** and **auditability** when agents contribute,
- scales to multiple use cases (daily notes, tasks, people, meetings) via plugins.

rem is not “just a notes app” and not “just a vector DB.” It’s a **memory substrate + collaboration contract** between human and agent.

---

## 2) Goals and Non-Goals

### 2.1 Goals
1) **Local-first, offline-first**
   - rem must run fully on a single machine without external infrastructure.

2) **Corporate-friendly deployment**
   - minimal dependencies, local files + SQLite, no privileged setup.

3) **One integrated solution**
   - The Lexical UI is part of the rem solution.
   - The Memory Core owns canonical writes (strict).

4) **Agent integration without MCP**
   - Primary interface: **CLI**.
   - Secondary interface: **localhost HTTP API**.

5) **Trustworthy human↔agent collaboration**
   - Agents never directly mutate canonical human content.
   - Agents propose edits; humans accept or reject.

6) **Strong provenance and history**
   - Every meaningful action emits a schema-validated append-only event.
   - Event log is canonical; DB is derived.

7) **Extensible with plugins**
   - Plugins can extend the UI and data model safely via registered schemas.
   - Strict schema enforcement prevents drift.

### 2.2 Non-Goals (V1)
- Cloud hosting / remote sync owned by rem
- Collaboration/multi-user permissions
- Real-time multi-device sync (optional external file sync is allowed but not owned)
- Full embedding-based semantic search (optional experiment only)
- Block/operation-level editor proposals (too complex for early versions)

---

## 3) Users, Personas, and Jobs-to-be-Done

### 3.1 Personas
**P1: Erik (power user / staff engineer)**
- Wants a reliable local knowledge store.
- Wants agents to recall context, suggest connections, draft summaries, extract tasks.
- Needs corporate constraints respected.

**P2: Human note-taker (UI user)**
- Wants fast, pleasant note-taking and retrieval.
- Wants plugins (daily notes, meetings, tasks, templates).

**P3: Agents / harnesses / automations**
- Need stable CLI/API for:
  - searching memory,
  - retrieving note content,
  - creating proposals,
  - adding annotations (tags/links/entities),
  - asking “what changed recently?”

### 3.2 Primary JTBD
- “Capture my thoughts quickly and retrieve them later.”
- “Let an agent find relevant past context for my current task.”
- “Let an agent propose improvements or summaries without messing up my notes.”
- “Track provenance: what did I write vs what did an agent produce?”
- “Extend note workflows with plugins without breaking the system.”

---

## 4) Product Principles

1) **Files are canonical**
   - Note documents and event logs live on the filesystem.

2) **SQLite is derived**
   - Used for indexing, retrieval acceleration, and artifact tracking.
   - Must be rebuildable from canonical files.

3) **Strict schema validation**
   - Invalid canonical writes are rejected.
   - Schemas are versioned and migrations are explicit.

4) **Agents propose; humans accept**
   - Agent contributions are proposals/annotations; never silent edits.

5) **Append-only history**
   - An explicit event log captures intent and provenance.

6) **Local-only by default**
   - Bind network services to `127.0.0.1` by default.
   - No telemetry by default.

---

## 5) Scope and Phasing

## 5.1 V1 — “Local searchable note system + proposal primitives”
### V1 must include
- Lexical-based UI:
  - create/edit notes
  - basic plugin mechanism
  - ability to review proposals at a coarse level (at least list + accept/reject)
- Memory Core:
  - canonical store for notes and metadata (filesystem)
  - canonical event log (filesystem JSONL)
  - strict schema enforcement for:
    - notes
    - meta
    - proposals
    - events
    - plugin registration
  - derived SQLite index:
    - full-text search (FTS)
    - metadata facets
    - event index
    - proposal index
- Agent interfaces:
  - `rem` CLI with JSON output for automation
  - localhost HTTP API mirroring CLI
- Proposal system:
  - first-class proposal objects
  - section-level proposals (not whole-note only)
  - section identity strategy (stable IDs + fallback path)
- Provenance:
  - event log records actor (human/agent), source, timestamps
  - proposals record agent identity and target note/section
- Indexing:
  - plaintext extraction from Lexical JSON for FTS
  - incremental indexing on write (since core owns writes)

### V1 explicitly does NOT require
- embeddings / vector search (optional behind a flag)
- automatic entity extraction
- connection recommendations
- advanced diff UX (inline editor diffs)
- multi-device sync

## 5.2 V2 — “Second brain: hybrid retrieval + graph + richer proposal UX”
- hybrid search: keyword + semantic + rerank
- connection suggestions:
  - related notes
  - shared people/projects
  - suggested backlinks
- first-class entities and relationships:
  - people, meetings, tasks, templates, etc.
- richer proposal UX:
  - structured diffs for sections
  - partial acceptance
  - merge assistance
- event replay / timelines / analytics (“what changed last week?”)
- plugin ecosystem growth:
  - more dynamic schema registration
  - plugin-specific indexes and views

---

## 6) Key Decisions (locked)

1) **Canonical source of truth:** filesystem for notes and events  
2) **Memory Core owns all writes (strict)**  
3) **Agent write model:** propose changes; humans accept  
4) **Event log:** explicit append-only, canonical on filesystem  
5) **Event indexing:** derived SQLite index  
6) **Schema policy:** strict schemas; reject invalid writes  
7) **Plugin registry:** hybrid (static core + dynamic experimental)  
8) **Migrations:** non-destructive by default + optional explicit compaction  
9) **Proposals:** first-class objects, not just notes-with-flags  
10) **Proposal granularity:** section-level proposals  
11) **Section identity:** stable section IDs + fallback human-readable path  

---

## 7) Functional Requirements

### 7.1 Note Management (UI + Core)
- Create note (title optional; can be derived)
- Edit note content (Lexical)
- Save note with strict schema validation
- Tag notes
- Basic organization (collections optional; not required v1)

### 7.2 Plugin System (UI + Core)
- Plugins can extend UI features (daily notes, templates, tasks, meetings)
- Plugins must register:
  - namespace
  - schema version
  - data shape
- Plugin data must be stored in canonical meta or plugin-owned canonical files managed by the core

### 7.3 Proposals (Agent + UI)
- Agents can:
  - create new notes (agent-authored notes)
  - propose a section-level change to an existing note
  - propose annotations (tags, links, metadata)
- Humans can:
  - view proposals
  - accept or reject proposals
- Acceptance generates:
  - updated canonical note content
  - events capturing the acceptance and resulting revision

### 7.4 Search & Retrieval
- Full-text search across extracted plaintext and titles
- Filters:
  - tags
  - note types
  - plugin facets (as registered)
  - updated/created time ranges (v1 can be basic)
- Retrieval:
  - get note by ID (Lexical JSON)
  - get extracted text for agent prompting
  - get proposal details

### 7.5 Event History & Provenance
- All meaningful actions create events:
  - note_created, note_updated
  - proposal_created, proposal_accepted, proposal_rejected
  - plugin_registered, plugin_updated
  - schema_migration_run (if applicable)
- Event log stored as JSONL; indexed in SQLite

### 7.6 Interfaces
**CLI:**
- `rem search "query" --json`
- `rem get note <id> --format lexical|text|md --json`
- `rem propose section --note <id> --section <sid> --content <file|stdin> --json`
- `rem proposals list --status open --json`
- `rem proposals accept <pid> --json`
- `rem proposals reject <pid> --json`
- `rem events tail --json`
- `rem status --json`

**HTTP API (localhost):**
- `GET /search?q=...`
- `GET /notes/:id`
- `GET /notes/:id/text`
- `POST /proposals`
- `POST /proposals/:id/accept`
- `POST /proposals/:id/reject`
- `GET /proposals?status=open`
- `GET /events?since=...`
- `GET /status`

---

## 8) Non-Functional Requirements

### 8.1 Local-first & Reliability
- Works offline
- Canonical store is just files; easy to back up
- SQLite can be deleted and rebuilt from canonical store
- Crash-safe writes:
  - atomic file writes (write temp + rename)
  - fsync strategy appropriate to platform

### 8.2 Performance Targets (initial)
- Create/update note: < 200ms typical
- Search: < 250ms warm cache typical for reasonable corpus
- Proposal create: < 200ms typical

### 8.3 Security
- HTTP binds to `127.0.0.1` by default
- Optional API token
- No telemetry by default

### 8.4 Maintainability
- Strict schemas
- Versioned migrations
- Clear module boundaries

---

## 9) Data & Storage (conceptual)

### 9.1 Canonical filesystem
- Notes stored as Lexical JSON + meta, managed by core
- Events stored as JSONL, canonical
- Proposals stored canonically as their own objects (files), indexed in DB

### 9.2 Derived SQLite DB
- Full-text index (FTS)
- Materialized views of metadata facets
- Event index (time, actor, type)
- Proposal index (status, target note/section, actor)

---

## 10) Dependencies & Constraints
- Must not rely on MCP
- Must be runnable on developer workstation
- Must support being used in a corporate environment (minimal infra)

---

## 11) MVP Success Metrics
- Retrieval usefulness:
  - user can find past context quickly
  - agent can retrieve relevant notes via CLI
- Trust:
  - user can see and control agent contributions
  - clear provenance
- Stability:
  - schema enforcement prevents corruption
  - rebuild is reliable

---

## 12) Risks & Mitigations

- **Risk:** Proposal UX complexity (section-level diffs)
  - Mitigation: start with section replacement comparisons; add inline diffs later

- **Risk:** Lexical plaintext extraction correctness
  - Mitigation: test fixtures; deterministic extraction; store extracted text artifacts

- **Risk:** Plugin schema churn
  - Mitigation: versioned schemas; non-destructive migrations; hybrid registry

- **Risk:** Too much scope in v1
  - Mitigation: keep semantic search and entity extraction out of v1

---

## 13) Open Questions (intentionally deferred)
- Exact UI for proposal review (inline diff vs side-by-side)
- Semantic search approach and local model choice
- Entity extraction strategy and ontology design
- Backup/sync guidance (git vs filesystem sync)
- Policy controls (agent permissions granularity)

---
