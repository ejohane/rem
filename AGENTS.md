# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Project Commands

```bash
bun install
bun run dev           # Run API + UI together
bun run dev:api       # API only
bun run dev:ui        # UI only
bun run typecheck
bun run test
bun run lint
bun run format
```

## Documentation Contract

Documentation must match shipped behavior in code. If docs and code disagree, code wins and docs must be updated in the same session.

### Path rules

- Use repo-relative paths in documentation and handoff notes.
- Do not use absolute filesystem paths in docs (worktrees differ per session).

### Required doc updates by change type

1. API routes, request/response shapes, CLI commands/options:
   - `docs/api-cli-reference.md`
2. Canonical storage layout, schemas, events, lifecycle/data contracts:
   - `docs/data-contracts.md`
3. Operator workflows and smoke checks:
   - `docs/runbook.md`
4. Architecture/spec intent docs:
   - `docs/design.md`
   - `docs/plugin-runtime-spec.md`
   - Clearly label statements as `implemented` vs `planned`.

### Guardrails

1. Do not document a UI capability unless it is wired in `apps/ui/src/App.tsx` (or mark it as planned).
2. Keep command examples aligned with actual CLI command names/options.
3. Update each touched doc's `Last updated` date.
4. If behavior changed and no docs changed, work is not complete.
5. Session handoff must list docs updated and any remaining doc debt as beads.

## CLI Proposal Workflow

```bash
bun run --cwd apps/cli src/index.ts notes save --input ./note.json --json
bun run --cwd apps/cli src/index.ts sections list --note <note-id> --json
bun run --cwd apps/cli src/index.ts proposals create --note <note-id> --section <section-id> --text "Updated section content" --json
bun run --cwd apps/cli src/index.ts proposals list --status open --json
bun run --cwd apps/cli src/index.ts proposals accept <proposal-id> --json
bun run --cwd apps/cli src/index.ts proposals reject <proposal-id> --json
bun run --cwd apps/cli src/index.ts search "deploy" --tags ops --note-types task --plugin-namespaces tasks --json
bun run --cwd apps/cli src/index.ts status --json
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
