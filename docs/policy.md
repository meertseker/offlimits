# Policy reference

offlimits works with no configuration. To change it, create `offlimits.json` in the repository root. Every key is optional. Unknown keys, wrong types and invalid regular expressions do not stop the hook: the bad entry is ignored, the rest of the file is used, the problem is logged, and the session banner prints a warning. One exception fails closed: if `offlimits.json` exists but cannot be parsed at all (invalid JSON), the whole file is ignored and `defaultRole` becomes `worker` until you fix it, so a typo cannot turn a team repository into solo mode. A missing file keeps `solo`.

A copy with every key set is in [`offlimits.example.json`](../offlimits.example.json).

All regular expressions are JavaScript regexes. `allow` and `extraDeny` patterns match case-insensitively against one command segment (see "Segments" below).

## Keys

### `protectedBranches`

- Type: array of strings
- Default: `["main", "master"]`
- Used by: `git-push-protected`, `git-branch-protected`

Branch names that agents may not push to, delete or rename, through git or through a GitHub MCP server (`github-mcp`). Entries may be globs: `*` matches within one path segment and `?` one character, so `release/*` covers `release/1.2` but not `release/1/hotfix`. Setting it replaces the default list, so include `main` again if you still want it.

```json
{ "protectedBranches": ["main", "release/*", "production"] }
```

### `protectedPaths`

- Type: array of glob strings (`*`, `**`, `?`), relative to the repository root
- Default: `[".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/**", "offlimits.json", ".github/workflows/**"]`
- Used by: `protected-file`

Files that `Write`, `Edit`, `MultiEdit` and `NotebookEdit` may not touch, and that shell commands may not write to (`>`, `>>`, `tee`, `sed -i`, `perl -i`, `cp`, `mv`, `rm`, `rsync`, `curl -o`, `wget -O`, `git rm`, `git mv`, `git checkout`, `git restore`, `Set-Content`, `Out-File`, `Rename-Item`, `Tee-Object`, `[IO.File]::WriteAllText`, and similar). Globs in shell arguments (`rm offlimits.*`, `rm -rf .c*`) count when they could match a protected path, and deleting or moving a parent directory (`rm -rf .claude`, `rm -rf ..`) counts too. Patterns are matched against both the current worktree and the main worktree, so a worker in a linked worktree cannot write the main checkout's `offlimits.json` by absolute path. Setting it replaces the default list. Keep `offlimits.json` and `.claude/settings.json` in it, or an agent can edit the gate away.

Always protected, whatever this key says: the user-level Claude Code settings `~/.claude/settings.json` and `~/.claude/settings.local.json` (and the same files under `$CLAUDE_CONFIG_DIR` when it is set). Any file-tool input that contains `disableAllHooks`, and any shell command that mentions it and writes, is denied.

```json
{ "protectedPaths": [".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/**", "offlimits.json", ".github/workflows/**", "infra/**"] }
```

### `production`

- Type: object with the three keys below
- Default: `{ "mcpServers": [], "projectRefs": [], "hosts": [] }`

Solo mode asks, rather than denies, for write calls on Supabase and Vercel MCP servers. Those calls are denied only when the server is listed in `production.mcpServers` or the call names a project listed in `production.projectRefs`. `production.hosts` affects `remote-db` only. Lists are merged with duplicates removed.

#### `production.mcpServers`

- Type: array of strings
- Default: `[]`
- Used by: `mcp-write`, `supabase-mcp`, `vercel-mcp`

MCP server names (the `<server>` part of `mcp__<server>__<tool>`). A name matches a server that equals it or ends with `_<name>`, case-insensitively. Every tool on a listed server is denied unless its name is a read verb followed by `_`, `-`, a capital letter or the end of the name (`get_project`, `getProject`, `show`; not `checkout_and_deploy`): `get`, `list`, `search`, `read`, `describe`, `query`, `fetch`, `find`, `count`, `aggregate`, `filter`, `show`, `check`, `lookup`, `retrieve`, `watch`. A read-verb name that also contains a write word (`show_drop`, `get_and_delete`) is not a read. Tools named `query*` or containing `sql` are judged by the SQL they carry instead: read SQL passes, write SQL is denied. This is the only way to cover MCP servers whose tool names offlimits does not know.

#### `production.projectRefs`

- Type: array of strings
- Default: `[]`
- Used by: `mcp-write`

Project identifiers. Any MCP tool call whose input holds one of these values in any string field (`project_ref`, `projectRef`, `project_id`, `projectId` or any other key, at any depth up to 8 levels) is denied, whatever the tool is called. The comparison ignores case, and a ref of 8 or more characters also counts inside a longer string such as `db.<ref>.supabase.co`.

#### `production.hosts`

- Type: array of strings
- Default: `[]`
- Used by: `remote-db`

Hostnames that always count as remote for `psql`, `pg_dump`, `pg_restore`, `mysql`, `mongosh` and friends. Without this key, any host other than `localhost`, `127.0.0.1`, `::1`, `host.docker.internal`, a `*.local` name or a unix socket is already remote, so you only need it for a name that would otherwise look local, for example an SSH tunnel alias.

```json
{ "production": { "mcpServers": ["supabase"], "projectRefs": ["abcdefghijklmnop"], "hosts": ["db.example.com"] } }
```

### `extraDeny`

- Type: array of `{ "pattern": string, "reason": string }`
- Default: `[]`
- Rule id: `extra-deny`

Your own deny rules. `pattern` is a regex tested against each command segment of `Bash` and `PowerShell` calls; a match is denied in worker and solo roles, and `reason` is shown to the agent. Entries with an invalid regex are dropped with a warning. Use this to cover tools offlimits does not know, for example `railway` volume commands or an internal deploy script.

```json
{ "extraDeny": [{ "pattern": "\\bterraform\\s+apply\\b", "reason": "Infrastructure changes go through the coordinator." }] }
```

### `allow`

- Type: array of regex strings
- Default: `[]`

A command segment that matches any pattern skips every shell rule except `role-spoof` and the file-write check. It does not affect MCP or `Write`/`Edit` calls. Patterns are unanchored, case-insensitive regexes: `"allow": ["vercel"]` lets `vercel --prod` through, and `git push` would allow `git push origin main` too. Anchor your patterns (`^...$`, or `^...( |$)` for a command prefix).

```json
{ "allow": ["^git push origin feat/[\\w./-]+$", "^vercel env pull( |$)"] }
```

### `trustedAgentTypes`

- Type: array of strings
- Default: `[]`

Subagents of a coordinator session are workers by default. A subagent whose `agent_type` is listed here keeps the coordinator role. Use sparingly.

### `roleEnv`

- Type: non-empty string
- Default: `"OFFLIMITS_ROLE"`

Name of the environment variable that carries the role. Only two values are recognised: `coordinator` (trimmed, case-insensitive) and `worker`. Any other value counts as unset, which means `defaultRole` (solo by default). Any subagent (the hook input carries an `agent_id`) is a worker, unless its `agent_type` is in `trustedAgentTypes`. The `role-spoof` rule watches whatever name you set here.

### `defaultRole`

- Type: `"solo"` or `"worker"`
- Default: `"solo"`

The role of a session when the role variable (`roleEnv`) is unset or holds an unrecognised value and the call does not come from a subagent. `solo` is the normal single-user behaviour. `worker` makes every session a worker unless the human explicitly starts it with `OFFLIMITS_ROLE=coordinator`, so a forgotten variable never downgrades MCP writes from deny to ask. The session banner and `/offlimits` print `role: worker (defaultRole)` when the role comes from this key.

`"coordinator"` is refused on purpose: a default coordinator would disable the gate for everyone. Any value other than `solo` or `worker` is reported as the policy problem `offlimits.json: defaultRole must be "solo" or "worker"`, and the hook falls back to `solo`.

The one fail-closed case: when `offlimits.json` exists but is not valid JSON, `defaultRole` is `worker` (problem text: `offlimits.json: invalid JSON (...). defaultRole falls back to worker until offlimits.json is fixed`). The banner and `/offlimits` show `role: worker (defaultRole)` plus the warning. A missing file keeps `solo`.

Team repository example:

```json
{ "defaultRole": "worker" }
```

Order of resolution: the role variable `coordinator` (outside a subagent) gives coordinator; `worker` gives worker; any untrusted subagent is a worker; otherwise `defaultRole`. A hook error for a `defaultRole` worker fails closed exactly like an env worker.

### `onError`

- Type: `"auto"`, `"block"` or `"allow"`
- Default: `"auto"`

What the hook does when it crashes or cannot parse its input. `auto` blocks when the role is worker; a coordinator crash is allowed, and solo is allowed with a log entry. Every error is written to the log and shown in the next session banner.

### `team`

- Type: object
- Default: none (team mode is off until `team init`)

Settings for team mode: models, `maxWorkers`, base branch, checks, deploy steps, house rules, reservations and terminal. A bad value is ignored and reported, and never weakens the gate. Every key, type and default is in [team.md](team.md).

## Roles and defaults

| Role | Set by | Hard rules | `db-migrate`, `opaque-shell`, `agent-spawn`, `git-clean`, `mcp-destructive`, unsure calls, and `supabase-mcp`, `vercel-mcp` writes (production not matching) |
|---|---|---|---|
| `coordinator` | `OFFLIMITS_ROLE=coordinator` in the environment, main session only | allowed | allowed |
| `worker` | `OFFLIMITS_ROLE=worker`, any subagent (unless in `trustedAgentTypes`), or variable unset or unrecognised while `defaultRole` is `worker` | deny | deny |
| `solo` | variable not set, or any other value, while `defaultRole` is `solo` (the default) | deny | ask |

The hard rules are `git-push-protected`, `git-branch-protected`, `gh-write`, `supabase-remote`, `remote-db`, `deploy`, `publish`, `role-spoof`, `protected-file`, `github-mcp`, `extra-deny` and `mcp-write`. Solo mode denies `supabase-mcp` and `vercel-mcp` writes too when the server is in `production.mcpServers` or the call names a project in `production.projectRefs`.

"Unsure" means the hook cannot tell whether a call is safe: a push whose destination is computed by `$(...)`, backticks or another complex form, or that follows a checkout of such a branch in the same command, a relative write after a `cd` it cannot follow, a write command run by `find -exec`, or a GitHub MCP file write that names no branch. An unknown plain `$VAR` refspec (`git push origin $TARGET`) is not unsure: it falls back to the current branch, so it is allowed on a feature branch and denied on a protected one. Unsure calls carry the id of the rule they would fall under.

## GitHub MCP, destructive MCP tools and child agents

- `github-mcp`: on any MCP server whose name contains `github`, `merge_pull_request` is denied, and `push_files`, `create_or_update_file`, `delete_file`, `update_ref` and `delete_branch` are denied when their `branch` or `ref` input names a protected branch (`main`, `refs/heads/main`, `heads/main`, or a `protectedBranches` glob). The same tools with no branch are unsure. Writes to other branches pass, like `git push origin feat/x`.
- `mcp-destructive`: on an MCP server that is not in `production.mcpServers`, a tool whose name starts with `delete`, `destroy`, `drop`, `deploy`, `reset`, `merge`, `promote`, `rollback`, `pause`, `push`, `publish`, `truncate` or `remove` (followed by `_`, `-`, a capital letter or the end of the name), and a `*sql*` or `query*` tool that carries write SQL, ask in solo mode and are denied for a worker. The Supabase, Vercel and GitHub rules run first. Vercel `web_fetch_vercel_url` with a `method` other than `GET` or `HEAD` is handled the same way under `vercel-mcp`.
- `team-launch`: a worker or subagent may not run the team CLI's `worker`, `done`, `coordinator`, `init` or `start` subcommands (they start or remove team sessions, which only the coordinator does; `init` rewrites team configuration and is re-run from a terminal with `team init`); solo mode asks, except for `init` and `start`. `start` is also allowed to a worker whose role comes only from `defaultRole` (the human's own session); an explicit `OFFLIMITS_ROLE=worker` or a subagent is denied.
- `agent-spawn`: a worker may not start another agent CLI (`claude`, `codex`, `aider`, `gemini`), because the child inherits the role variable but not the subagent marker; solo mode asks.
- `git-clean`: `git clean` with `-x` or `-X` (it also deletes ignored files such as `.env` and local databases) asks in solo mode and is denied for a worker; `-n`/`--dry-run` passes.

## Unknown current branch

For `git-push-protected`, when a push has no explicit destination and the hook cannot determine the current branch, the decision is ask in solo mode and deny for a worker.

## Segments

Shell commands are split on `;`, `&&`, `||`, `|` and newlines. `bash -c`, `sh -c`, `pwsh -Command`, `cmd /c`, `eval`, `$(...)` and backticks are unwrapped, and leading `VAR=value` assignments, `sudo`, `env`, `time`, `timeout`, `nice`, `chrt`, `taskset`, `chronic` and similar wrappers are stripped, before each segment is matched. All rules share one wrapper table (`WRAPPERS` in `hooks/lib/shell.mjs`).

So that the hook always answers inside Claude Code's hook timeout, a command longer than 64 KB, with more than 1000 distinct segments or more than 200 tracked variables is not inspected and falls under `opaque-shell` (ask in solo mode, deny for a worker). The smaller per-command limits are listed in [limits.md](limits.md).

## Log

Every deny, ask and error is appended to `.offlimits/log.jsonl` at the repository root (shared by worktrees, capped at 200 lines). Add `.offlimits/` to `.gitignore`.
