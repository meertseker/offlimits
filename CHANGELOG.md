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
- `protected-file`: writes to hook config and policy files, through file tools and shell commands
- `opaque-shell`: shells that read commands from stdin (ask in solo, deny for workers)
- `extra-deny`: your own patterns from `offlimits.json`

Rules for MCP tools:

- `supabase-mcp`: schema-changing tools and write SQL through `execute_sql`
- `vercel-mcp`: any non-read tool on a Vercel server
- `mcp-write`: any non-read tool on servers listed in `production.mcpServers`, and any call that names a project in `production.projectRefs`

Also in this release:

- Roles: coordinator, worker (including subagents) and solo, from `OFFLIMITS_ROLE`
- Policy file `offlimits.json` with optional keys, see `docs/policy.md`
- Session banner, `.offlimits/log.jsonl`, the `/offlimits` skill with `test` and `explain`
- Zero dependencies, Node 20 or newer, no network, no telemetry
