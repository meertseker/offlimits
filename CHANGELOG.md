# Changelog

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
