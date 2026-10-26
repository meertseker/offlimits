# offlimits

**The hook that keeps your coding agent out of production.**

Production is off limits. Prompts ask, hooks enforce. Runs in every permission mode, including --dangerously-skip-permissions.

![A worker session's git push to main is blocked; in a separate coordinator session, started by the human with the role set, the same push goes through](assets/demo.svg)

offlimits is a Claude Code plugin with one PreToolUse hook. It reads every shell command, file write and MCP call the agent is about to make, and refuses the ones that touch production: pushes to `main`, live database changes, deploys, package publishes, and SQL sent through MCP servers that happen to point at prod. No dependencies, no network, no account, no telemetry.

## Install

Requires Claude Code 2.1.292 or newer for the one-command install (per the Claude Code plugin docs, install page) and Node 20 or newer.

```sh
claude plugin install offlimits --marketplace meertseker/offlimits
```

Or in two steps:

```sh
claude plugin marketplace add meertseker/offlimits
claude plugin install offlimits@offlimits
```

Inside a session: `/plugin install offlimits --marketplace meertseker/offlimits`.

Then run `/offlimits test` to watch the gate block a set of fixture calls in your own session. If you only want the coordinator and worker conventions as a skill, without the hook: `npx skills add meertseker/offlimits`.

This is what an agent sees when it tries. We started a real Claude Code 2.1.310 session with `--dangerously-skip-permissions` and `OFFLIMITS_ROLE=worker` and asked it to push to main:

```text
offlimits: blocked git push origin main
rule: git-push-protected - git push targets protected branch "main" (matched "git push origin main").
role: worker
Commit your branch and hand over to the coordinator; do not work around this.
```

(Abridged: Claude Code prefixes the first line with `PreToolUse:Bash hook error:`.)

The agent reported that it had been blocked and did not try a workaround.

## What it blocks

Shell rules apply to `Bash` and `PowerShell` calls. Commands are split on `;`, `&&`, `||`, `|` and newlines, and `bash -c`, `pwsh -Command`, `cmd /c`, `eval`, `$(...)` and backticks are unwrapped before matching.

| Rule | Blocks |
|---|---|
| `git-push-protected` | `git push` to a protected branch: explicit refspecs, `--all`, `--mirror`, `--delete main`, force pushes, or no refspec while the current branch is protected |
| `git-branch-protected` | `git branch -D`, `-d`, `-M`, `-m` on a protected branch |
| `gh-write` | `gh pr merge`, `gh workflow run`, `gh release create\|delete\|upload`, `gh repo delete`, and `gh api` writes to rulesets, branch protection and merges |
| `supabase-remote` | `supabase db push`, `db reset --linked`, `db link`, `link`, `migration repair`, `functions deploy`, `secrets set\|unset` |
| `remote-db` | `psql`, `pg_dump`, `pg_restore`, `mysql`, `mongosh` and friends against any host that is not local, or through `$DATABASE_URL` |
| `db-migrate` | `prisma migrate deploy`, `prisma db push`, `drizzle-kit push\|migrate`, `flyway migrate`, `alembic upgrade`, `knex migrate:latest`, production `rails db:migrate`, `artisan migrate --force` |
| `deploy` | `vercel` with `--prod`, `--target production`, `promote`, `rollback` or `alias set`; `netlify deploy --prod`; Fly, Railway, Wrangler, Firebase, Serverless, SST, CDK, Pulumi, Terraform and `tofu`, kubectl, Helm, gcloud, AWS CloudFormation, Azure, EAS; remote deploy scripts over SSH; `docker compose up -d` against compose files under `/opt`, `/srv` or `/var` |
| `publish` | `npm publish`, `pnpm publish`, `yarn npm publish`, `cargo publish`, `twine upload`, `gem push`, `dotnet nuget push` |
| `role-spoof` | any command that assigns `OFFLIMITS_ROLE`, so an agent cannot promote itself |
| `protected-file` | writes to `.claude/settings.json`, `.claude/hooks/**`, `offlimits.json` and `.github/workflows/**`, by file tools or by `>`, `tee`, `sed -i`, `cp`, `mv`, `rm`, `Set-Content` and similar |
| `agent-spawn` | a worker starting another agent CLI (`claude`, `codex`, `aider`, `gemini`), which would run without the worker marker; solo asks |
| `git-clean` | `git clean -x` or `-X`, which also deletes ignored files such as `.env` and local databases; solo asks, `-n` passes |
| `opaque-shell` | a shell that reads its commands from stdin, `eval` of generated text, nesting deeper than 8 levels, and commands too large to inspect in time (over 64 KB, 1000 segments or 200 variables); solo asks |
| `extra-deny` | your own regexes from `offlimits.json` |
| `supabase-mcp` | Supabase MCP `apply_migration`, `deploy_edge_function`, `create_edge_function_secret`, branch merge, reset, rebase and delete, and `execute_sql` containing write keywords, for example INSERT, UPDATE, DELETE, ALTER, DROP, TRUNCATE, GRANT, COPY, MERGE |
| `vercel-mcp` | any Vercel MCP tool that is not a read |
| `github-mcp` | GitHub MCP `merge_pull_request`, and `push_files`, `create_or_update_file`, `delete_file`, `update_ref` on a protected branch |
| `mcp-write` | any non-read tool on a server listed in `production.mcpServers`, and any MCP call that names a project in `production.projectRefs` |
| `mcp-destructive` | on other MCP servers, tools named `delete_*`, `deploy_*`, `drop_*`, `push_*`, `merge_*` and similar, and SQL tools sending write SQL; solo asks |

Read-only MCP tools and SELECT queries through `execute_sql` pass unless the call names a project in `projectRefs`; pushes to non-protected branches pass.

## Roles

The role comes only from the `OFFLIMITS_ROLE` environment variable that you set before starting the session. An agent cannot change its own environment, and the `role-spoof` rule blocks it from trying.

| Role | How | What it can do |
|---|---|---|
| `coordinator` | `OFFLIMITS_ROLE=coordinator`, main session only | Everything. This is the one session that merges and deploys |
| `worker` | `OFFLIMITS_ROLE=worker`, any subagent (the hook input carries an `agent_id`) unless its `agent_type` is in `trustedAgentTypes`, and a session whose variable is unset or unrecognised when `defaultRole` is `worker` | Every rule above denies |
| `solo` | variable not set, or set to anything other than `coordinator` or `worker`, while `defaultRole` is `solo` (the default) | Hard rules deny. `db-migrate`, `opaque-shell`, `agent-spawn`, `git-clean`, `mcp-destructive`, unsure calls, and `supabase-mcp` and `vercel-mcp` writes ask; those MCP writes deny when the server or project is listed under `production` |

If the hook itself fails, `onError: "auto"` blocks only for workers (fail closed). Coordinator and solo sessions allow the call and log the error; the warning appears in the next session banner and in `/offlimits`, not at the moment of the call. Change this with `onError`.

## Why a hook and not a prompt

- A line in CLAUDE.md is a request. The model can misread it, forget it after compaction, or be talked out of it by a tool result.
- A permission prompt asks a human who is often not watching, and does not exist at all under `--dangerously-skip-permissions`.
- A PreToolUse hook runs outside the model, in every permission mode, before the call executes. Exit code 2 is a refusal the agent cannot argue with.
- The deny message tells the agent what to do next (hand over, do not work around), so a blocked agent usually stops instead of improvising.

## Compared with

We summarise the other projects only from what their own READMEs state. Check them yourself, they may have changed.

| | Native `permissions.deny` | [karanb192/claude-code-hooks](https://github.com/karanb192/claude-code-hooks) | [rulebricks/claude-code-guardrails](https://github.com/rulebricks/claude-code-guardrails) | offlimits |
|---|---|---|---|---|
| Works in bypass mode | Deny rules override every permission mode (Claude Code SDK permissions doc) | Not stated | Not stated | Yes, verified on 2.1.310 |
| Role-aware (coordinator and workers) | No | Not stated | Not stated | Yes |
| MCP SQL inspection | No | Not stated | Not stated | Yes (Supabase `execute_sql`) |
| Nested shell parsing | Compound commands, subshells and $(...) yes; sh -c / bash -c no | In one guard only | Not stated | Yes, recursive (`bash -c`, `eval`, `$(...)`) |
| Zero dependencies | Built in | No npm dependencies (Node >= 18); some plugins need uv/npx | Not stated | Yes, Node built-ins only |
| No account | Yes | Not stated | Needs a Rulebricks account and API key | Yes |

karanb192/claude-code-hooks is a broader collection (force pushes to main, secrets via a separate plugin, `rm -rf`); if you want those checks, run it next to offlimits. Native deny rules are the right tool for exact, static patterns. offlimits is for the production boundary and for teams of sessions.

## Configuration

No configuration is needed. To tune it, add `offlimits.json` to the repository root. Every key is optional:

```json
{
  "protectedBranches": ["main", "release"],
  "production": {
    "mcpServers": ["supabase"],
    "projectRefs": ["abcdefghijklmnop"],
    "hosts": ["db.example.com"]
  },
  "extraDeny": [
    { "pattern": "\\bterraform\\s+apply\\b", "reason": "Infrastructure changes go through the coordinator." }
  ],
  "allow": ["^git push origin feat/[\\w./-]+$"]
}
```

In a team repository, set `defaultRole` so that every session not explicitly started as coordinator is a worker:

```json
{ "defaultRole": "worker" }
```

Every key, type and default is in [docs/policy.md](docs/policy.md). Listing a server in `production.mcpServers`, or a project in `production.projectRefs`, turns MCP write asks into denies for solo users; `production.hosts` only affects `remote-db`. Blocks are logged to `.offlimits/log.jsonl`; run `/offlimits` to see the last ten, and `/offlimits explain <command>` to see what the gate would do with a command without running it.

## Limits

offlimits reads the text of a tool call. It is not a sandbox, and it does not claim to be unbypassable. The first five known limits:

- Inline interpreters (`node -e`, `python -c`) that call git or write files are not inspected.
- Wrapper scripts and shell aliases that run a blocked command are invisible.
- A refspec built from a variable that resolves to a protected branch, while the session sits on a feature branch, is not caught.
- Wrapper chains deeper than 8 levels stop expanding.
- `git push --dry-run` to a protected branch is denied (conservative), and `git push <url>` with no refspec falls back to the current branch.

The full list, with mitigations, is in [docs/limits.md](docs/limits.md). A limit you report is triaged within 48 h and gets a fix or a line there within 7 days (see [SECURITY.md](SECURITY.md)). For a boundary that holds against a determined agent, also give it credentials that cannot touch production.

## Built in production

The hook started as the gate of a school-management SaaS where up to 37 Claude Code sessions worked in parallel on one repository, with a single coordinator session merging and deploying. Every other session was physically blocked from doing either. This plugin is that hook, generalised. It will also be the gate of Usta, an AI software team for family businesses.

## Incidents this would have caught

Five public cases, from the Replit database deletion in 2025 to an agent with unrestricted Supabase access in 2026, with an honest yes, partly or no for each: [docs/incidents.md](docs/incidents.md). Two of the five are "partly", because the destructive call went through a platform tool the hook never sees.

## FAQ

**Does it work with `--dangerously-skip-permissions`?** Yes. Hooks run before the permission system and in every mode. We checked in Claude Code 2.1.310: a worker session started with the flag was blocked from `git push origin main`.

**What about false positives?** They exist; see the false-positive section of [docs/limits.md](docs/limits.md). A blocked command is never lost: run it yourself outside the agent, or add an anchored `allow` regex to `offlimits.json`.

**How do I allow one command?** Add an anchored pattern to `allow`, for example `"^git push origin feat/[\\w./-]+$"`. Do not use a loose pattern like `git push`, which would also allow `git push origin main`. For a one-off, run the command yourself, or start a session with `OFFLIMITS_ROLE=coordinator`.

**Does it run on Windows?** Yes. It is Node only, handles the `PowerShell` tool as well as `Bash`, and is tested on Windows, macOS and Linux.

**Does it send telemetry?** No. It makes no network calls. The only thing it writes is `.offlimits/log.jsonl` in your repository, capped at 200 lines. Add `.offlimits/` to your `.gitignore`.

## Contributing, security, license

- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Every rule needs at least one blocking and one allowing test.
- Security: report a bypass privately as described in [SECURITY.md](SECURITY.md). Known bypasses are listed in [docs/limits.md](docs/limits.md).
- License: MIT, see [LICENSE](LICENSE).

Turkce ozet: [README.tr.md](README.tr.md).
