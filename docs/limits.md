# Known limits

offlimits is a PreToolUse hook that reads the text of a tool call. It is not a sandbox and it does not claim to be unbypassable. This page lists every bypass and false positive we know of. If you find another, open an issue; it becomes either a fix or a line here within 24 hours.

For a boundary that holds against a determined agent, give it credentials that cannot touch production in the first place. offlimits is the second line, for the common case where the agent has the access and does the obvious thing.

## Ways around the gate

- **Inline interpreters.** `node -e "require('child_process').execSync('git push origin main')"`, `python -c "import subprocess; ..."` and similar run git (or write files) from inside a program. The hook sees an interpreter call, not a push. Mitigation: add an `extraDeny` pattern for `node -e` and `python -c` in worker sessions if your agents have no reason to use them.
- **Wrapper scripts and shell aliases.** A script `./ship.sh` that runs `git push origin main`, or an alias for it, is invisible. The hook only sees the script name. Mitigation: add the script to `extraDeny`, and put it under `protectedPaths` so an agent cannot rewrite it.
- **Refspecs built from variables.** `git push origin $TARGET` cannot be resolved. The push is treated as unsure: ask in solo mode, deny for a worker.
- **Remote URL instead of remote name.** `git push git@github.com:acme/app.git main` is judged by its refspec (`main`), which works, but `git push <url>` with no refspec cannot tell which remote it is and falls back to the current branch.
- **Wrapper chains deeper than 8 levels** (`bash -c "bash -c \"...\""` and so on) stop being expanded. The innermost command is not inspected; the call counts as opaque (`opaque-shell`: ask in solo mode, deny for a worker).
- **Redirect targets that are not literal.** `echo x > $(pwd)/offlimits.json` or `> $FILE` cannot be resolved, so a write to a protected file through them is not caught.
- **`xargs` and `find -exec`.** `find . -name offlimits.json -exec rm {} \;` and `... | xargs rm` write or delete files without naming them in the command.
- **SQL inside `psql -c`.** A `psql -c "DROP TABLE ..."` against a remote host is blocked because the host is remote (`remote-db`), but the SQL itself is never inspected. Only SQL sent through the Supabase MCP `execute_sql` tool is read. Against a local database, `psql -c` is always allowed.
- **MCP servers with unusual tool names.** The built-in MCP rules know the Supabase, Vercel and GitHub servers. On any other server, `mcp-destructive` only catches tool names that start with a destructive verb (`delete`, `deploy`, `drop`, `push`, `merge` and so on), and SQL tools that run write SQL. A write tool with a mild name (`update_record`, `apply_changes`) is covered only if you list the server in `production.mcpServers`. Reads are recognised by a name prefix (`get_`, `list_`, `search_`, and so on); anything else on a listed server is denied.
- **Raw HTTP calls to an API.** `curl -X PUT https://api.github.com/repos/acme/app/contents/x`, or a `fetch` from a script, changes a repository or a production service without any CLI the hook knows. HTTP clients are out of scope: give the agent a token that cannot write to protected branches.
- **`npm run <script>` and other task runners.** `npm run ship`, `make deploy` or `just release` run whatever the script says. The hook sees the script name, not its body. Mitigation: add the script name to `extraDeny`, and protect the file that defines it (`package.json`, `Makefile`) with `protectedPaths` if it matters.
- **Paths the hook cannot spell out.** Write targets built from variables (`rm $F`), from `find -exec` or `xargs`, Windows 8.3 short names (`OFFLIM~1.JSO`), NTFS alternate data streams other than `::$DATA`, symlinks that point into a protected directory, and archive extraction (`tar -x`, `unzip`) are not resolved.
- **Directory changes the hook cannot follow.** After `cd -`, `popd` or `cd $DIR`, the working directory is unknown. A relative write target that names a protected segment (`settings.json`, `.claude`, `..`) or a glob then asks (solo) or is denied (worker); any other relative target, for example `ci.yml` after `cd $DIR` into `.github/workflows`, is not caught.
- **The hook has to run.** Hooks do not run inside a `claude -p` subprocess that was started without the plugin, in a session where the plugin is disabled, or in another tool that does not read Claude Code's hook configuration. An agent that can start such a process can act outside the gate.
- **The human can change the policy.** The policy file and hook config are write-protected from the agent, but not from you. Editing `offlimits.json` or `.claude/settings.json` mid-session changes what the gate enforces, by design.
- **The role comes from the environment.** Anyone who can start the session decides its role. The `role-spoof` rule stops an agent from assigning the variable in a command, but cannot stop a parent process that is not the agent.

## False positives

- **`git push --dry-run` to a protected branch is denied.** The hook does not special-case dry runs. It is conservative on purpose; run it yourself, or add an anchored `allow` pattern.
- **Unusual read tools on a listed server.** On a server in `production.mcpServers`, any tool that does not start with a read verb is denied, including harmless ones with unusual names.
- **SQL is judged lexically, not parsed.** An `execute_sql` call passes only when every statement starts with `select`, `with`, `explain`, `show`, `values` or `table` and no write keyword or write function (`setval`, `pg_terminate_backend`, `set_config` and others) appears outside comments, string literals and quoted identifiers. `select ... for update`, `nextval(...)` or a column named `copy` without quotes count as writes.
- **`disableAllHooks` anywhere.** Any `Write`, `Edit`, `MultiEdit` or `NotebookEdit` input that contains the text `disableAllHooks` is denied, whatever the file, and so is a shell command that mentions it and writes anything. Read-only commands such as `grep disableAllHooks` pass.
- **Glob targets are judged broadly.** `rm *.json` or `rm -rf *` is denied when the glob could match a protected path, even if the shell would not expand it that way (bash `*` skips dotfiles; the hook does not).
- **Copies into a directory.** `cp x .github` (a directory that is not the repository root) is judged as if `.github` might be replaced, so a recursive copy onto a parent of a protected path is denied.
- **`allow` patterns are unanchored regexes.** `"allow": ["vercel"]` matches every segment that contains `vercel`, so `vercel --prod` passes too. Anchor them: `"^vercel env pull( |$)"`, `"^git push origin feat/[\\w./-]+$"`.
- **Opaque shells.** `bash`, `sh` or `pwsh` reading commands from stdin cannot be inspected, so the call asks (solo) or is denied (worker). This is rule `opaque-shell`.

## Platform notes

- The hook needs Node 20 or newer on the PATH of the machine running Claude Code.
- If the hook itself crashes, `onError: "auto"` blocks in team mode and allows in solo mode. A solo user who wants fail-closed sets `"onError": "block"`.
