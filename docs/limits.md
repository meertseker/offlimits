# Known limits

offlimits is a PreToolUse hook that reads the text of a tool call. It is not a sandbox and it does not claim to be unbypassable. This page lists every bypass and false positive we know of. If you find another, open an issue; it becomes either a fix or a line here within 24 hours.

For a boundary that holds against a determined agent, give it credentials that cannot touch production in the first place. offlimits is the second line, for the common case where the agent has the access and does the obvious thing.

## Ways around the gate

- **Inline interpreters.** `node -e "require('child_process').execSync('git push origin main')"`, `python -c "import subprocess; ..."` and similar run git (or write files) from inside a program. The hook sees an interpreter call, not a push. Mitigation: add an `extraDeny` pattern for `node -e` and `python -c` in worker sessions if your agents have no reason to use them.
- **Wrapper scripts and shell aliases.** A script `./ship.sh` that runs `git push origin main`, or an alias for it, is invisible. The hook only sees the script name. Mitigation: add the script to `extraDeny`, and put it under `protectedPaths` so an agent cannot rewrite it.
- **Refspecs built from variables.** `git push origin $TARGET` is treated as "destination unclear": the hook checks the current branch instead. If `$TARGET` resolves to `main` while the session is on a feature branch, the push is not caught.
- **Remote URL instead of remote name.** `git push git@github.com:acme/app.git main` is judged by its refspec (`main`), which works, but `git push <url>` with no refspec cannot tell which remote it is and falls back to the current branch.
- **Wrapper chains deeper than 8 levels** (`bash -c "bash -c \"...\""` and so on) stop being expanded. The innermost command is not inspected.
- **Redirect targets that are not literal.** `echo x > $(pwd)/offlimits.json` or `> $FILE` cannot be resolved, so a write to a protected file through them is not caught.
- **`xargs` and `find -exec`.** `find . -name offlimits.json -exec rm {} \;` and `... | xargs rm` write or delete files without naming them in the command.
- **SQL inside `psql -c`.** A `psql -c "DROP TABLE ..."` against a remote host is blocked because the host is remote (`remote-db`), but the SQL itself is never inspected. Only SQL sent through the Supabase MCP `execute_sql` tool is read. Against a local database, `psql -c` is always allowed.
- **MCP servers with unusual tool names.** The built-in MCP rules know the Supabase and Vercel servers. A server whose write tools do not look like writes, or whose server name does not contain `supabase` or `vercel`, is covered only if you list it in `production.mcpServers`. Reads are recognised by a name prefix (`get`, `list`, `search`, and so on); anything else on a listed server is denied.
- **The hook has to run.** Hooks do not run inside a `claude -p` subprocess that was started without the plugin, in a session where the plugin is disabled, or in another tool that does not read Claude Code's hook configuration. An agent that can start such a process can act outside the gate.
- **The human can change the policy.** The policy file and hook config are write-protected from the agent, but not from you. Editing `offlimits.json` or `.claude/settings.json` mid-session changes what the gate enforces, by design.
- **The role comes from the environment.** Anyone who can start the session decides its role. The `role-spoof` rule stops an agent from assigning the variable in a command, but cannot stop a parent process that is not the agent.

## False positives

- **`git push --dry-run` to a protected branch is denied.** The hook does not special-case dry runs. It is conservative on purpose; run it yourself, or add an anchored `allow` pattern.
- **Unusual read tools on a listed server.** On a server in `production.mcpServers`, any tool that does not start with a read verb is denied, including harmless ones with unusual names.
- **SQL keyword matching is lexical.** A Supabase `execute_sql` query that contains the word `update` or `create` in a string literal is treated as a write. Comments are stripped; quoted text is not.
- **Opaque shells.** `bash`, `sh` or `pwsh` reading commands from stdin cannot be inspected, so the call asks (solo) or is denied (worker). This is rule `opaque-shell`.

## Platform notes

- The hook needs Node 20 or newer on the PATH of the machine running Claude Code.
- If the hook itself crashes, `onError: "auto"` blocks in team mode and allows in solo mode. A solo user who wants fail-closed sets `"onError": "block"`.
