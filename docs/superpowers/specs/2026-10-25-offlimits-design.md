# offlimits — design

**Date:** 2026-10-25 · **Status:** approved for v0.1 · **Owner:** Mert Seker

## Intent

Coding agents keep touching production: pushing to `main`, applying migrations to the live database, deploying, writing SQL through MCP servers that happen to point at prod. Prompts and CLAUDE.md rules ask the agent not to; nothing enforces it. `offlimits` is a Claude Code plugin whose PreToolUse hook enforces it at the tool boundary, in every permission mode including `bypassPermissions`.

One line: **the hook that keeps your coding agent out of production.**

The hook was first written for a production SaaS (a school management platform) where many Claude Code sessions worked in parallel: one *coordinator* session merges and deploys, every other *worker* session is physically blocked from doing so. This plugin is that hook, generalised.

## Goals

1. Zero-config safety for a solo user: install, and pushes to protected branches, remote DB pushes, deploy commands and dangerous MCP calls are blocked; MCP writes with no production definition *ask* instead of blocking.
2. Role model for teams of sessions: `OFFLIMITS_ROLE=coordinator` lifts the gate; every other session, and every subagent, is a worker.
3. The agent cannot promote itself: role comes only from the environment the human set; the policy file and the hook config are write-protected from workers.
4. Honest failure behaviour: fail-closed for workers; coordinator and solo sessions allow the call, log the error and warn in the next session banner. Never silent.
5. Zero dependencies, Node ≥ 20 built-ins only, no network, no telemetry, readable source. Runs on Windows (Git Bash and PowerShell tool), macOS, Linux.
6. Every rule has at least one blocking and one allowing test; a self-test command shows the gate working in the user's own session.

## Non-goals and anti-goals

- Not an orchestrator: it does not open sessions, assign tasks or manage worktrees. It is a policy layer over Claude Code's native primitives.
- Not a general "dangerous command" collection (`rm -rf`, fork bombs): the focus is production and shared branches. The README links to projects that cover the rest.
- No SaaS, API key, LLM call or telemetry. Ever, in v0.x.
- No claim of being unbypassable. The README has a *Limits* section listing known bypasses (for example inline interpreters such as `node -e` that call git). A limit found by a user becomes an issue, and it is triaged within 48 h and gets either a fix or a line in that section within 7 days (SECURITY.md).

## Behaviour

### Roles

| Role | How it is determined | Gate |
|---|---|---|
| `coordinator` | `OFFLIMITS_ROLE` (configurable name) equals `coordinator` (trimmed, case-insensitive) **and** the hook is not running inside a subagent (`agent_id` absent), unless `agent_type` is in `trustedAgentTypes` | everything allowed |
| `worker` | `OFFLIMITS_ROLE=worker`, or any subagent of a coordinator | hard rules deny; MCP writes deny |
| `solo` | no role variable | hard rules deny; MCP writes deny when the server or project matches `production`, otherwise *ask* |

The old "add your session id to a roster file" flow is gone on purpose: an agent with a Write tool could promote itself.

### Rules (applied to `Bash` and `PowerShell` commands, split into segments on `;`, `&&`, `||`, `|`, newlines, with `bash -c`, `sh -c`, `pwsh -c/-Command`, `powershell -Command`, `cmd /c`, `eval`, `$(...)` and backticks unwrapped one level, and leading `VAR=value` assignments stripped)

| Rule id | Blocks |
|---|---|
| `git-push-protected` | `git push` whose destination is a protected branch: explicit refspecs (`main`, `HEAD:main`, `+main`, `:main`, `refs/heads/main`), `--all`, `--mirror`, `--delete main`, or no refspec while the current branch (`git -C <dir>` honoured) is protected; `--force*` included |
| `git-branch-protected` | `git branch -D|-d|-M|-m <protected>` |
| `gh-write` | `gh pr merge`, `gh workflow run`, `gh release create|delete|upload`, `gh repo delete`, `gh api` with `-X|--method POST|PUT|PATCH|DELETE` or `-f/-F` fields on `repos/*/rulesets`, `repos/*/branches/*/protection`, `repos/*/merges`, `repos/*/pulls/*/merge` |
| `supabase-remote` | `supabase db push`, `supabase db reset --linked`, `supabase db link`, `supabase migration repair`, `supabase functions deploy`, `supabase secrets set|unset` |
| `remote-db` | `psql`/`pg_dump`/`pg_restore`/`mysql`/`mongosh` with a connection URI or `-h/--host` that is not `localhost`, `127.0.0.1`, `::1`, `host.docker.internal` or a `*.local` name; `$DATABASE_URL`/`$env:DATABASE_URL` counts as remote |
| `db-migrate` | `prisma migrate deploy`, `prisma db push`, `drizzle-kit push|migrate`, `flyway migrate`, `alembic upgrade`, `knex migrate:latest`, `rails db:migrate` with `RAILS_ENV=production`, `artisan migrate --force`. *Solo: ask. Worker: deny.* |
| `deploy` | `vercel --prod|promote|rollback|alias set`, `netlify deploy --prod`, `fly|flyctl deploy`, `railway up`, `wrangler deploy|publish`, `firebase deploy`, `serverless|sls deploy`, `sst deploy`, `cdk deploy`, `pulumi up|destroy`, `terraform apply|destroy`, `kubectl apply|delete|rollout|scale`, `helm install|upgrade|uninstall|rollback`, `gcloud run deploy|app deploy`, `aws cloudformation deploy|update-stack|delete-stack`, `az webapp deploy`, `eas update|submit`, `ssh … (deploy|rollback)\.sh|systemctl restart|caddy reload`, `docker compose … up -d` when the compose file path starts with `/opt/`, `/srv/`, `/var/` |
| `publish` | `npm publish`, `pnpm publish`, `yarn npm publish`, `cargo publish`, `twine upload`, `gem push`, `dotnet nuget push` |
| `role-spoof` | any segment that assigns the role variable: `OFFLIMITS_ROLE=…`, `export OFFLIMITS_ROLE`, `$env:OFFLIMITS_ROLE =`, `set OFFLIMITS_ROLE=` |
| `protected-file` | `Write`, `Edit`, `MultiEdit`, `NotebookEdit` on a protected path, and Bash/PowerShell segments that write to one (`>`/`>>` redirection, `tee`, `sed -i`, `cp|mv|rm … <path>`, `Set-Content|Out-File|Add-Content … <path>`) |

Default protected paths: `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/**`, `offlimits.json`, `.github/workflows/**`.

### MCP rules (tool names `mcp__<server>__<tool>`)

| Rule id | Blocks |
|---|---|
| `supabase-mcp` | `apply_migration`, `deploy_edge_function`, `create_edge_function_secret`, `merge_branch`, `reset_branch`, `rebase_branch`, `delete_branch` on any server whose name contains `supabase`; `execute_sql` whose `query` matches `\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|comment\s+on)\b` (case-insensitive). Reads (`list_*`, `get_*`, `search_docs`, `execute_sql` selects) allowed |
| `vercel-mcp` | any tool on a server whose name contains `vercel` and whose tool name does not match `^(get|list|search|filter|count|aggregate|read|web_fetch)` |
| `mcp-write` | any tool on a server listed in `production.mcpServers` whose tool name does not match the read prefix `^(get|list|search|read|describe|query|fetch|find|count|aggregate|filter|show|check|lookup|retrieve|watch)_?` ; any MCP tool whose input contains a `project_ref`/`projectRef`/`project_id` listed in `production.projectRefs` |

Solo mode with no `production` section: `supabase-mcp` and `vercel-mcp` write calls **ask**; worker mode denies.

### Policy file `offlimits.json` (repo root; all keys optional)

```json
{
  "protectedBranches": ["main", "master"],
  "protectedPaths": [".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/**", "offlimits.json", ".github/workflows/**"],
  "production": { "mcpServers": [], "projectRefs": [], "hosts": [] },
  "extraDeny": [{ "pattern": "regex over a command segment", "reason": "shown to the agent" }],
  "allow": ["regex over a command segment; matching segments skip the rules"],
  "trustedAgentTypes": [],
  "roleEnv": "OFFLIMITS_ROLE",
  "defaultRole": "solo",
  "onError": "auto"
}
```

`defaultRole` (`solo` or `worker`, default `solo`) is the role of a session whose role variable is unset or unrecognised and that is not a subagent; `coordinator` is refused (problem, fallback `solo`) because a default coordinator would lift the gate for everyone. If `offlimits.json` exists but is not valid JSON, `defaultRole` falls back to `worker` (fail closed) until it is fixed; a missing file keeps `solo`. `production.hosts` adds hostnames to the `remote-db` rule. `onError`: `auto` (block only for workers; coordinator and solo allow and log), `block`, `allow`. Invalid JSON or unknown keys: the hook uses defaults, logs the problem and the session banner warns.

### Hook contract

- `PreToolUse` matcher: `Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*`; command `node ${CLAUDE_PLUGIN_ROOT}/hooks/gate.mjs`, timeout 10 s.
- Deny: exit code 2, stderr message (English): what was blocked, which rule, the role, and the next step (worker: "commit your branch and hand over to the coordinator"; solo: "run it yourself outside Claude, or start the session with `OFFLIMITS_ROLE=coordinator` if you really mean it").
- Ask: exit 0 with `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"…"}}`.
- Allow: exit 0, no output.
- Error (unparseable stdin, exception): coordinator → exit 0; worker → exit 2 "offlimits: hook error, blocking because the role is worker"; solo → exit 0 and a log entry. `onError` overrides.
- Log: `.offlimits/log.jsonl` at the repo root (parent of the git common dir, so worktrees share it); one line per deny/ask/error: `{at, role, tool, decision, rule, summary}`; capped at 200 lines.
- `SessionStart` (matchers `startup|resume|clear|compact`): one banner line with role, protected branches, production definition state, count of blocks in the log, a warning if a worker sits on a protected branch, a warning if the log holds hook errors, and a pointer to `/offlimits`.

### Skills

- `offlimits` — `/offlimits` shows status (role, active rules, policy source, last 10 log lines); `/offlimits test` runs the self-test, which feeds fixture tool calls through the real hook in a temp git repo with `OFFLIMITS_ROLE=worker` and prints a pass/fail table; `/offlimits explain <command>` prints the decision for a command without running it.
- `offlimits-roles` — the coordinator/worker contract as a short, agent-agnostic skill (also published on skills.sh): one coordinator per repo, workers in worktrees on `feat/*` branches, early draft PRs, delivery template, "if the gate blocks you, do not work around it, hand over".

## Constraints

- Plugin at the repository root (`.claude-plugin/plugin.json`), hook commands as plain `node ${CLAUDE_PLUGIN_ROOT}/…` paths, no `npx`, no lockfile, every file under 256 KiB, README ≥ 40 words, MIT `LICENSE`. These are the Anthropic directory's validation rules.
- Name `offlimits` is permanent. `displayName` "Off Limits".
- All user-facing text English; `README.tr.md` is the only Turkish file.
- Tests with `node --test` only.

## Left to the builder

Exact regular expressions and their test tables within the rule definitions above, the glob matcher for protected paths, the banner's wording, the self-test's output format, the SVG demo, CI matrix details.
