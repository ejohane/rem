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
