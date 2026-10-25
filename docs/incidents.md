# Incidents this would have caught

Public reports of coding agents damaging production, and an honest answer for each: would offlimits have caught it. Several of these come from a single source or are disputed; each entry says so. We have not verified the details beyond the sources listed.

offlimits blocks commands and MCP calls it recognises. It does not see platform-internal tools, and it does not stop an agent that holds credentials and finds a route we did not list. See [limits.md](limits.md).

## PocketOS, 25 April 2026

An agent in Cursor, running on Claude Opus 4.6, deleted the production database and its volume backups on Railway in a single API call.

Sources: AI Incident Database report 7311 (incidentdatabase.ai); OECD AI incident 2026-04-27-6153 (oecd.ai).

Would offlimits have caught it: partly. The destructive step was a Railway API or CLI call. If the agent went through the `railway` CLI, `railway up` is covered by `deploy`, but a volume or database deletion command is not in the built-in list. To cover it, add the command to `extraDeny` or list the API host under `production.hosts`. It was also a Cursor session, and offlimits is a Claude Code plugin: the same call from Claude Code would be gated, a Cursor session would not.

## Terraform run deleted a production database, March 2026

An agent ran Terraform against a production environment and a production database was deleted.

Sources: OECD AI incident 2026-03-07-79ec (oecd.ai). The founder disputes the account, so treat the details as unconfirmed.

Would offlimits have caught it: yes. `terraform apply` and `terraform destroy` (and `tofu`) are denied by `deploy` in worker and solo roles. A coordinator session is allowed, by design.

## Migration run against the live environment, July 2026

A developer reported that an agent ran a database migration against the live environment instead of a copy.

Source: a developer's account in a medium.com post (autonobotsai). Single source, not independently confirmed.

Would offlimits have caught it: yes for the standard tools, partly for custom ones. `prisma migrate deploy`, `prisma db push`, `drizzle-kit push|migrate`, `flyway migrate`, `alembic upgrade`, `knex migrate:latest`, `rails db:migrate` with `RAILS_ENV=production` and `artisan migrate --force` are covered by `db-migrate`: ask in solo mode, deny for workers. A hand-written migration script is not recognised; add it to `extraDeny`. A `psql -f migrate.sql` against a remote host is denied by `remote-db`.

## Claude Opus 5 with unrestricted Supabase access, August 2026

An agent with unrestricted access to a Supabase project made destructive changes to it.

Source: AI Incident Database citation 1676 (incidentdatabase.ai). Single source.

Would offlimits have caught it: yes. Through the Supabase MCP server, `execute_sql` with `insert`, `update`, `delete`, `alter`, `create`, `drop`, `truncate`, `grant` or `revoke` is asked (solo, no production section) or denied (worker, or when the server or project is listed under `production`), and `apply_migration`, `deploy_edge_function`, `merge_branch`, `reset_branch` and the other schema-changing tools are covered by `supabase-mcp`. Reads still work.

## Replit agent deleted a production database during a code freeze, July 2025

The Replit agent deleted a production database during a declared code freeze and then produced fabricated data to cover it.

Sources: eweek.com and getcoai.com coverage.

Would offlimits have caught it: partly. The deletion ran through Replit's own internal tooling, which a Claude Code hook never sees. The equivalent SQL sent through an MCP server (for example `execute_sql` on Supabase) or a remote `psql` would have been caught by `supabase-mcp` or `remote-db`. The fabricated data is outside what a gate can address.
