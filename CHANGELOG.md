# Changelog

## 0.3.0 - 2026-10-30

Repositioned: offlimits now turns Claude Code into a software team (one coordinator, workers in their own worktrees) and keeps the gate that holds it together.

Added:

- Team mode: `bin/team.mjs` (also `offlimits-team`, `scripts/coordinator.ps1`, `scripts/worker.ps1`) with `init`, `coordinator`, `worker`, `board`, `stage`, `deliver`, `ask`, `reserve` and `done`, and exit codes 0 to 4.
- `init` writes `offlimits.json` (`defaultRole: worker`, a `team` block), a managed block in `CLAUDE.md`, a PR template and a `.gitignore` entry, and prints a `team` shell function. Safe to re-run.
- The `team` block in `offlimits.json`: `language`, `models`, `maxWorkers`, `base`, `worktreeDir`, `checks`, `deploy`, `rules`, `reservations`, `terminal`, validated without ever weakening the gate.
- Team state in `.offlimits/team/` (board, coordinator lock, reservations, briefs, deliveries, questions) under a file lock with timestamped tokens and a breaker lock.
- Workers in new terminals (Windows Terminal, Terminal.app, `x-terminal-emulator`, or a printed command), each in a git worktree on `feat/<lane>`, with role, lane and model set by the launcher.
- Atomic reservations such as migration numbers: `team reserve <key>`.
- `done` refuses dirty lanes, lanes with no commits and lanes not merged by ancestry unless `--abandon`.
- Night mode: lanes launch with `--night` and `approval: none`; nothing is merged or deployed without an explicit go.
- A team section in the SessionStart banner (role, lane, board, and the exact `team` command with the plugin path), and `/offlimits init`, `board` and `team`.
- Skills `offlimits-coordinator` and `offlimits-worker`, and templates for briefs, deliveries and the PR description.
- `team-launch`: a worker or subagent is denied `team worker|done|coordinator|init` (also via `node bin/team.mjs`, `offlimits-team`, `npx`); solo asks for worker, done and coordinator.
- `docs/team.md`, and team-mode entries in `docs/limits.md`.

## 0.2.0 - 2026-10-26

Added:

- `defaultRole` policy key (`solo` or `worker`): the role of a session whose role variable is unset or unrecognised. `coordinator` is refused.
- An `offlimits.json` that exists but cannot be parsed sets `defaultRole` to `worker` until it is fixed (fail closed); the banner and `/offlimits` warn.

## 0.1.0 - 2026-10-26

First release.

Rules for `Bash` and `PowerShell` calls:

- `git-push-protected`: pushes to protected branches, `--all`, `--mirror`, `--delete`, and pushes from a protected branch with no refspec
- `git-branch-protected`: deleting or renaming a protected branch
- `gh-write`: `gh pr merge`, `gh workflow run`, `gh release create|delete|upload`, `gh repo delete`, and `gh api` writes to rulesets, branch protection, merges
- `supabase-remote`: `supabase db push`, `db reset --linked`, `db link`, `migration repair`, `functions deploy`, `secrets set|unset`
- `remote-db`: `psql`, `pg_dump`, `pg_restore`, `mysql`, `mongosh` and friends against a non-local host or `$DATABASE_URL`
- `db-migrate`: Prisma, Drizzle, Flyway, Alembic, Knex, Rails and Artisan migrations (ask in solo, deny for workers)
- `deploy`: Vercel, Netlify, Fly, Railway, Wrangler, Firebase, Serverless, SST, CDK, Pulumi, Terraform, kubectl, Helm, gcloud, AWS CloudFormation, Azure, EAS, remote deploy scripts over SSH
- `publish`: `npm`, `pnpm`, `yarn`, `cargo`, `twine`, `gem`, `dotnet nuget` publishing
- `role-spoof`: assigning the role variable from inside a command
- `agent-spawn`: a worker starting another agent CLI (ask in solo)
- `git-clean`: `git clean -x|-X`, which also deletes ignored files (ask in solo, deny for workers)
- `protected-file`: writes to hook config, policy files and the user-level Claude Code settings, through file tools and shell commands (including globs, parent directories, copies, downloads and `git rm`/`git mv`), and any call that mentions `disableAllHooks`
- `opaque-shell`: shells that read commands from stdin, `eval` of generated text, nesting deeper than 8 levels, and commands too large to inspect in time (over 64 KB, 1000 segments or 200 variables) (ask in solo, deny for workers)
- `extra-deny`: your own patterns from `offlimits.json`

Rules for MCP tools:

- `supabase-mcp`: schema- and project-changing tools and any `execute_sql` that is not a read statement
- `vercel-mcp`: any non-read tool on a Vercel server, and `web_fetch_vercel_url` with a write method
- `github-mcp`: GitHub MCP pull request merges and file or ref writes on protected branches
- `mcp-write`: any non-read tool on servers listed in `production.mcpServers`, and any call that names a project in `production.projectRefs`
- `mcp-destructive`: destructive tool names and write SQL on other MCP servers (ask in solo, deny for workers)

Also in this release:

- Roles: coordinator, worker (including subagents) and solo, from `OFFLIMITS_ROLE`
- Policy file `offlimits.json` with optional keys, see `docs/policy.md`
- Session banner, `.offlimits/log.jsonl`, the `/offlimits` skill with `test` (a sample of about 60 fixtures; `--all` for every one) and `explain`
- Zero dependencies, Node 20 or newer, no network, no telemetry
