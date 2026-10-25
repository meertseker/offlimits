# Decisions

## Pending

- Anthropic plugin directory submission (needs a browser session).
- English X account for the project.
- Migrate the Şeker platform to use the plugin instead of its in-repo hook.

## Decided

- 2026-10-25: Name is `offlimits` (English). The Turkish working name was bekci.
- 2026-10-25: Published under the personal GitHub account `meertseker`.
- 2026-10-25: License is MIT.
- 2026-10-25: Supabase and Vercel MCP rules live in core. With no production definition, writes ask instead of deny.
- 2026-10-25: Fail-closed in team mode (a role is set); fail-open with a log in solo mode. (Narrowed in the final review below: only workers fail closed.)
- 2026-10-25: Role comes only from the environment. No roster file.
- 2026-10-25: Subagents default to worker.
- 2026-10-25: The first real user is the Şeker platform, then Usta.
- 2026-10-25 (final review): `onError: "auto"` blocks only for workers; coordinator and solo allow and log, and the warning shows in the next session banner. Worker message: "offlimits: hook error, blocking because the role is worker".
- 2026-10-25 (final review): Input budget so the hook always answers inside the 10 s hook timeout: a shell command over 64 KB, 1000 segments or 200 tracked variables is `opaque-shell` (deny for a worker, ask in solo mode). Brace expansion is capped at 256 words per target.
- 2026-10-25 (final review): The default `/offlimits test` runs a deterministic sample of about 60 fixtures; `--all` (CI, `npm run selftest`) runs every one.
