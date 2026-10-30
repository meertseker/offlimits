# Changelog

## 0.3.1 - 2026-10-30

Added:

- `/offlimits start` (`team start [--print]`): a Claude session you opened yourself opens the coordinator in a new terminal window, in the main checkout. The window runs `team coordinator`, so the lock, the role and the `claude` spawn are the existing ones, in human context (the role and session variables of the calling session are not passed on). Launched workers and every subagent are still refused: by the CLI guard and by the `team-launch` gate rule (denied when the role is worker and does not come from `defaultRole`).
- `init` in a folder that is not a git repository runs `git init` first (never inside an existing repository, found by walking up for `.git` or `GIT_DIR`; never in your home directory or a drive root) and prints a `Next:` line that names the files to commit.

Fixed:

- Terminal launchers are now unwrapped by the gate (including a titled cmd `start` with switches, PowerShell `@(...)` and comma argument lists, `cmd /c "wt ; nt ..."`, prefix wrappers such as `nohup`/`sudo`, and `kitty`/`foot` options): `start` (cmd and PowerShell), `Start-Process`/`saps`, `wt` (with `nt`, `new-tab`, `sp`, `split-pane`), `x-terminal-emulator`, `xterm`, `konsole`, `gnome-terminal` and similar, and `osascript` `do script` bodies. The command they open is checked like a nested shell (`pwsh -Command`, `bash -c`, `cmd /c`), so a worker can no longer run a blocked command by opening it in a new window. Unreadable forms (an `osascript` script without `do script`, a `Start-Process` argument list built from variables) go through `opaque-shell`. This gap existed in 0.3.0.
- PowerShell reading: nested script blocks are walked once per state (a crafted 60 KB command took 20 s and is now decided in well under a second), the walk counts script blocks and nested text against the budget, deeply nested `"$(` is `opaque-shell` instead of a crash, `$${ ... }` runs its block, hash-table keys such as `(1)` or `'a''b'` no longer hide their value, `<# ... #>` comments, backtick escapes, here-strings and curly quotes are read as PowerShell reads them, and cmd lead-ins (`if`, `call`, `@`, `for ... do`, `else`, a nested `cmd /c`) no longer hide the command after them, also before `wt`. Most of these gaps existed in 0.3.0.
- A launched worker or subagent that hides the team subcommand behind a variable or substitution (`team $T`, `team $(echo start)`) is denied.
- The SessionStart banner now says to start the coordinator with `/offlimits start`.
- The environment scrub for launched terminals is case-insensitive on Windows and shared by `worker` and `start`.

Changed:

- `init` writes `"permissionMode": "bypassPermissions"` into a newly created `team` block, so unattended team windows do not stall on permission prompts. The gate keeps workers and subagents out of production. The coordinator is fully trusted: it keeps the configured `permissionMode` (bypass for a new team block), and it merges or deploys only on your explicit word, which is a skill rule, not a gate rule. If you want permission prompts on the coordinator, remove `permissionMode` from the `team` block or set it to `default`. An existing `team` block is never touched.
- The gate rule context carries `viaDefault`, so `team-launch` can tell a human's own session (worker only by `defaultRole`) from a launched worker.

## 0.3.0 - 2026-10-30

Repositioned: offlimits now turns Claude Code into a software team (one coordinator, workers in their own worktrees) and keeps the gate that holds it together.

Breaking:

- `scripts/worker.ps1` and `scripts/coordinator.ps1` are removed: they started sessions under names the `team-launch` rule did not know. Use `team worker <lane> --brief <file>` and `team coordinator` (or `node bin/team.mjs ...`).

Added:

- Team mode: `bin/team.mjs` (also `offlimits-team`, or `team` once the shell function from `init` is in your profile) with `init`, `coordinator`, `worker`, `board`, `stage`, `deliver`, `ask`, `reserve` and `done`, and exit codes 0 to 4.
- `init` writes `offlimits.json` (`defaultRole: worker`, a `team` block), a managed block in `CLAUDE.md`, a PR template and a `.gitignore` entry, and prints a `team` shell function. Safe to re-run.
- The `team` block in `offlimits.json`: `language`, `models`, `maxWorkers`, `base`, `worktreeDir`, `checks`, `deploy`, `rules`, `reservations`, `terminal`, `permissionMode`, validated without ever weakening the gate.
- `team.permissionMode` (`default`, `acceptEdits` or `bypassPermissions`): passed as `--permission-mode` to the coordinator and worker sessions. Unattended and night workers need `acceptEdits` or `bypassPermissions`, or they stall on the first permission prompt; the gate keeps that safe.
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
