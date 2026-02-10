# rem Technical Stack (Canonical Reference)

**Document status:** Draft (v1)
**Owner:** Erik
**Last updated:** 2026-02-06
**Purpose:** Canonical source of truth for stack and structural decisions before implementation.

---

## 1) Scope and Intent

This document defines the agreed technical stack and package boundaries for V1.

- It is the primary reference for implementation decisions.
- It should be updated before major stack changes are made.
- It intentionally avoids implementation details and code-level conventions.

---

## 2) Locked V1 Stack Decisions

## 2.1 Runtime and Language
- Runtime and package manager: **Bun**
- Bun baseline: **1.3.x**
- Language: **TypeScript** (strict mode)
- Project shape: **Monorepo** using Bun workspaces
- TypeScript baseline config:
  - `target: ES2022`
  - `module: ESNext`
  - `moduleResolution: Bundler`

## 2.2 API and CLI
- HTTP server: **Hono**
- HTTP bind default: `127.0.0.1` (local-only)
- CLI framework: **Commander**
- API and CLI behavior: both are thin adapters over the same Core service layer

## 2.3 Validation and Schemas
- Validation library: **Zod** (source of truth)
- Canonical objects must include explicit `schemaVersion`
- All canonical writes must pass schema validation before persistence

## 2.4 Storage and Indexing
- Canonical source of truth: **filesystem**
- Derived index: **SQLite** via `bun:sqlite`
- Full-text search: **SQLite FTS5**
- SQLite is non-canonical and rebuildable from canonical files/events

## 2.5 Logging and Testing
- Structured logging: **Bun native logging** (no external logging dependency in V1)
- Test runner: **bun test**
- Vitest: **not used in V1**
- Style/lint tooling: **Biome**
- Type checking: **TypeScript `tsc --noEmit` with project references**

---

## 3) Locked Architecture Boundaries

- `core` is the only layer allowed to mutate canonical files.
- `ui`, `api`, and `cli` must not write canonical files directly.
- `index-sqlite` is derived-only and must be rebuildable.
- `schemas` is the validation gate used by all write paths.
- Agent contributions are proposals/annotations; no silent direct note edits.

---

## 4) Monorepo Structure (Initial)

```txt
rem/
  apps/
    ui/
    cli/
    api/
  packages/
    core/
    schemas/
    store-fs/
    index-sqlite/
    extractor-lexical/
    plugins/
    shared/
  rem_store/   # optional local dev data root
  docs/
```

Notes:
- This structure is locked as the starting point, but folder names may be refined before first implementation commit.
- Runtime default store root is `~/.rem` (override with `REM_STORE_ROOT`).
- `rem_store/` remains available for local development workflows in this repo.

---

## 5) Dependency Direction Rules (Locked)

These rules define which app/package layers may depend on which others.

## 5.1 Allowed imports by layer
- `apps/ui` -> `packages/core`, `packages/shared`, `packages/schemas`, `packages/plugins`, `packages/extractor-lexical`
- `apps/api` -> `packages/core`, `packages/shared`, `packages/schemas`
- `apps/cli` -> `packages/core`, `packages/shared`, `packages/schemas`
- `packages/core` -> `packages/store-fs`, `packages/index-sqlite`, `packages/schemas`, `packages/plugins`, `packages/extractor-lexical`, `packages/shared`
- `packages/index-sqlite` -> `packages/shared` (and SQL/runtime deps only)
- `packages/store-fs` -> `packages/shared` (and Node/Bun fs/path deps only)
- `packages/plugins` -> `packages/schemas`, `packages/shared`
- `packages/extractor-lexical` -> `packages/shared`
- `packages/schemas` -> `packages/shared`
- `packages/shared` -> no internal package dependencies

## 5.2 Forbidden dependency patterns
- No app may import another app.
- `packages/shared` must never import from any other internal package.
- `packages/schemas` must not import from `packages/core` or runtime adapters.
- `packages/index-sqlite` must not import from `packages/store-fs`.
- `packages/store-fs` must not import from `packages/index-sqlite`.
- `apps/ui`, `apps/api`, and `apps/cli` must not import `bun:sqlite` or perform canonical file writes directly.

## 5.3 Boundary intent
- `core` is the orchestrator and only canonical write entrypoint.
- adapters (`ui`, `api`, `cli`) stay thin and transport-focused.
- lower-level packages (`store-fs`, `index-sqlite`, `extractor-lexical`) remain single-purpose and side-effect scoped.

## 5.4 Rule change policy
- Any new cross-package dependency must be added here before implementation.
- If a needed dependency breaks layering, prefer moving interfaces into `packages/shared` over adding reverse imports.

---

## 6) Public API Surface by Package (Locked)

These rules define what each package is allowed to expose as its stable public API.

## 6.1 `packages/shared`
- May export: common types, error/result types, constants, utility helpers with no side effects
- Must not export: runtime singletons, filesystem/database clients, app-specific adapters

## 6.2 `packages/schemas`
- May export: Zod schemas, parse/validate helpers, schema-version constants, migration adapters
- Must not export: filesystem/database access, transport-specific request/response models

## 6.3 `packages/store-fs`
- May export: canonical path resolver, atomic write/read APIs, event append APIs, store bootstrap/check APIs
- Must not export: business orchestration, CLI/API handlers, SQL/index concerns

## 6.4 `packages/index-sqlite`
- May export: DB bootstrap/migration APIs, index upsert/query APIs, rebuild APIs, health/status APIs
- Must not export: canonical write APIs, direct schema ownership, transport handlers

## 6.5 `packages/extractor-lexical`
- May export: lexical-to-text extractors, section indexers, deterministic normalization helpers
- Must not export: canonical persistence APIs, proposal lifecycle orchestration

## 6.6 `packages/plugins`
- May export: plugin manifest/types, plugin registration APIs, plugin payload validators, plugin capability descriptors
- Must not export: direct note mutation APIs outside Core orchestration

## 6.7 `packages/core`
- May export: domain service APIs for notes/proposals/events/search/status/rebuild, transaction-orchestration entrypoints
- Must not export: transport-bound handlers (HTTP route handlers or CLI command definitions)

## 6.8 App packages
- `apps/api` may export: API server bootstrap and route wiring only
- `apps/cli` may export: CLI command wiring and process entrypoint only
- `apps/ui` may export: UI bootstrap and feature composition only
- Apps must treat package internals as private and import only documented public entrypoints

## 6.9 API stability rule
- Every package must define a single public entrypoint (`index.ts`) for stable imports.
- Deep imports into internal files are disallowed across package boundaries.
- Breaking public API changes require updating this document before implementation.

---

## 7) Naming and Import Conventions (Locked)

## 7.1 Workspace package naming
- Internal packages use the `@rem/*` namespace.
- Canonical package names:
  - `@rem/shared`
  - `@rem/schemas`
  - `@rem/store-fs`
  - `@rem/index-sqlite`
  - `@rem/extractor-lexical`
  - `@rem/plugins`
  - `@rem/core`

## 7.2 App package naming
- App packages use `@rem-app/*` namespace.
- Canonical app names:
  - `@rem-app/ui`
  - `@rem-app/api`
  - `@rem-app/cli`

## 7.3 Import style
- Cross-package imports must use package names (for example `@rem/core`), never relative parent paths.
- Cross-package deep imports are disallowed (for example `@rem/core/internal/*`).
- Relative imports are allowed only within the same package/app.

## 7.4 Path alias policy
- TypeScript path aliases, if used, must mirror workspace package names exactly.
- Do not create alternate aliases for the same target package.
- If aliases are introduced, they are configuration-only and must not bypass package boundaries.

---

## 8) Versioning Policy (Locked)

## 8.1 Repository versioning model
- The repository uses a single unified workspace version for V1 (lockstep versioning).
- Internal packages are not published externally during V1.
- Package versions exist for traceability, but releases are coordinated at repo level.
- Release artifacts use semantic versioning tags (`vMAJOR.MINOR.PATCH`) sourced from root `package.json` `version`.

## 8.2 Internal package visibility
- All `@rem/*` and `@rem-app/*` packages are private.
- No public registry publishing is allowed without an explicit policy update in this document.

## 8.3 Breaking change policy
- Breaking changes to internal package public APIs are allowed only when all dependents in this repo are updated in the same change set.
- Any breaking boundary change must also update sections 5-7 of this file before implementation.

## 8.4 Dependency pinning policy
- Runtime dependencies: use exact versions.
- Tooling dependencies: use exact versions.
- Default policy: exact versions across the workspace unless explicitly approved in this document.

## 8.5 Upgrade cadence
- Dependency upgrades are batched and intentional, not ad hoc.
- Upgrade PRs/changelists should include compatibility checks for CLI/API output and index rebuild behavior.

---

## 9) Data and Interface Posture (V1)

- Canonical events remain append-only JSONL on filesystem.
- API and CLI must expose stable machine-readable JSON output.
- Core must enforce the trust model: agents propose, humans accept/reject.
- Rebuild flow (`rebuild-index`) is a first-class operation in Core and exposed in CLI/API.
- Configuration must be schema-validated (Zod-based) before use.
- Bun is the only supported runtime and package manager for V1 workflows.

## 9.1 UI stack scope (current)
- UI implementation is in scope as **React + Lexical** only.
- Additional web app stack choices (framework/router/styling/state libraries) are intentionally out of scope for this document revision.

---

## 10) Deferred / Open Stack Decisions

- Test coverage thresholds and CI quality gates
- JSON schema export strategy from Zod (if needed for tooling/docs)

---

## 11) Change Policy for This File

- Changes should be additive and explicit.
- When a decision moves from "deferred" to "locked," update this file first.
- If another document conflicts with this one on stack choice, this file wins for implementation planning.
