# Decisions

## Pending

Published 2026-10-25: https://github.com/meertseker/offlimits, release v0.1.0, CI green on Windows, macOS and Linux (Node 20 and 22), `main` ruleset active. Verified end to end: installed from GitHub with `claude plugin install offlimits --marketplace meertseker/offlimits`, a real `--dangerously-skip-permissions` session with `OFFLIMITS_ROLE=worker` was blocked on `git push origin main`.

- [ ] Anthropic directory submission (Mert, browser): claude.ai/directory/manage, Submit new, Plugin bundle, repo `meertseker/offlimits`, folder root, press Validate first. Icon is `.claude-plugin/icon.png` and is fixed on first save.
- [ ] English X account for launch posts (Mert).
- [ ] Şeker platform: install the plugin at project scope next to the old hook, run both for a week, then remove the old hook.
- [ ] Usta: write the Wave 0 gate task as "install offlimits" instead of a new hook.
- [ ] Launch: Show HN and X thread on a Tuesday to Thursday afternoon (UK), drafts per the strategy doc; keep the incident-day kit ready.
- [ ] Decide whether to keep `CLAUDE.md` at the plugin root (directory review shows a warning) or move it to a skill.

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
