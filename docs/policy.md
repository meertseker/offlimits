# Policy reference

offlimits works with no configuration. To change it, create `offlimits.json` in the repository root. Every key is optional. Unknown keys, wrong types and invalid regular expressions do not stop the hook: the bad entry is ignored, the rest of the file is used, the problem is logged, and the session banner prints a warning.

A copy with every key set is in [`offlimits.example.json`](../offlimits.example.json).

All regular expressions are JavaScript regexes. `allow` and `extraDeny` patterns match case-insensitively against one command segment (see "Segments" below).

## Keys

### `protectedBranches`

- Type: array of strings
- Default: `["main", "master"]`
- Used by: `git-push-protected`, `git-branch-protected`

Branch names that agents may not push to, delete or rename. Setting it replaces the default list, so include `main` again if you still want it.

```json
{ "protectedBranches": ["main", "release", "production"] }
```

### `protectedPaths`

- Type: array of glob strings (`*`, `**`, `?`), relative to the repository root
- Default: `[".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/**", "offlimits.json", ".github/workflows/**"]`
- Used by: `protected-file`

Files that `Write`, `Edit`, `MultiEdit` and `NotebookEdit` may not touch, and that shell commands may not write to (`>`, `>>`, `tee`, `sed -i`, `cp`, `mv`, `rm`, `Set-Content`, `Out-File`, `git restore`, and similar). Setting it replaces the default list. Keep `offlimits.json` and `.claude/settings.json` in it, or an agent can edit the gate away.

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

MCP server names (the `<server>` part of `mcp__<server>__<tool>`). A name matches a server that equals it or ends with `_<name>`, case-insensitively. Every tool on a listed server is denied unless its name starts with a read verb: `get`, `list`, `search`, `read`, `describe`, `query`, `fetch`, `find`, `count`, `aggregate`, `filter`, `show`, `check`, `lookup`, `retrieve`, `watch`. This is the only way to cover MCP servers whose tool names offlimits does not know.

#### `production.projectRefs`

- Type: array of strings
- Default: `[]`
- Used by: `mcp-write`

Project identifiers. Any MCP tool call whose input contains `project_ref`, `projectRef` or `project_id` (at any depth, up to 7 levels) with one of these values is denied, whatever the tool is called.

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

A command segment that matches any pattern skips every shell rule except `role-spoof` and the file-write check. It does not affect MCP or `Write`/`Edit` calls. Anchor your patterns (`^...$`): an unanchored pattern such as `git push` would allow `git push origin main` too.

```json
{ "allow": ["^git push origin feat/[\\w./-]+$"] }
```

### `trustedAgentTypes`

- Type: array of strings
- Default: `[]`

Subagents of a coordinator session are workers by default. A subagent whose `agent_type` is listed here keeps the coordinator role. Use sparingly.

### `roleEnv`

- Type: non-empty string
- Default: `"OFFLIMITS_ROLE"`

Name of the environment variable that carries the role. Only two values are recognised: `coordinator` (trimmed, case-insensitive) and `worker`. Any other value counts as unset, which means solo. Any subagent (the hook input carries an `agent_id`) is a worker, unless its `agent_type` is in `trustedAgentTypes`. The `role-spoof` rule watches whatever name you set here.

### `onError`

- Type: `"auto"`, `"block"` or `"allow"`
- Default: `"auto"`

What the hook does when it crashes or cannot parse its input. `auto` blocks when the role is worker; a coordinator crash is allowed, and solo is allowed with a log entry. Every error is written to the log and shown in the next session banner.

## Roles and defaults

| Role | Set by | Hard rules | `db-migrate`, `opaque-shell`, `supabase-mcp`, `vercel-mcp` (no `production` section) |
|---|---|---|---|
| `coordinator` | `OFFLIMITS_ROLE=coordinator` in the environment, main session only | allowed | allowed |
| `worker` | `OFFLIMITS_ROLE=worker`, or any subagent (unless in `trustedAgentTypes`) | deny | deny |
| `solo` | variable not set, or any other value | deny | ask |

The hard rules are `git-push-protected`, `git-branch-protected`, `gh-write`, `supabase-remote`, `remote-db`, `deploy`, `publish`, `role-spoof`, `protected-file`, `extra-deny` and `mcp-write`. Solo mode denies `supabase-mcp` and `vercel-mcp` writes too when the server is in `production.mcpServers` or the call names a project in `production.projectRefs`.

## Unknown current branch

For `git-push-protected`, when a push has no explicit destination and the hook cannot determine the current branch, the decision is ask in solo mode and deny for a worker.

## Segments

Shell commands are split on `;`, `&&`, `||`, `|` and newlines. `bash -c`, `sh -c`, `pwsh -Command`, `cmd /c`, `eval`, `$(...)` and backticks are unwrapped, and leading `VAR=value` assignments, `sudo`, `env`, `time` and similar wrappers are stripped, before each segment is matched.

## Log

Every deny, ask and error is appended to `.offlimits/log.jsonl` at the repository root (shared by worktrees, capped at 200 lines). Add `.offlimits/` to `.gitignore`.
