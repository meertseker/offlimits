# Decisions

## Pending

Published 2026-10-25: https://github.com/meertseker/offlimits, release v0.1.0, CI green on Windows, macOS and Linux (Node 20 and 22), `main` ruleset active. Verified end to end: installed from GitHub with `claude plugin install offlimits --marketplace meertseker/offlimits`, a real `--dangerously-skip-permissions` session with `OFFLIMITS_ROLE=worker` was blocked on `git push origin main`.

- [ ] Tag and release v0.3.0 (Mert's go).
- [ ] Şeker platform: migrate to team mode (`init`, `team.rules`, `reservations.migration`).
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
- 2026-10-29: Team mode lives in offlimits itself; supersedes the 26 Oct offlimits-crew decision.
- 2026-10-29: Team state lives in `<main checkout>/.offlimits/team/` (gitignored), not in a sibling ledgers folder.
- 2026-10-29: Launcher privileged commands are double-guarded: the CLI guard (`CLAUDECODE` plus role) and the gate rule `team-launch` (subagents resolve to worker).
- 2026-10-30: `done` refuses dirty or zero-commit lanes without `--abandon`; lanes are never squash-merged (the merged check is git ancestry).
- 2026-10-30: Night mode with unanswered approvals: lanes still launch with `--night` and `approval: none`, decisions are logged, and nothing is merged or deployed without an explicit go.
- 2026-10-30: Agents learn the exact `team` invocation from the SessionStart banner, because the plugin path is versioned.
- 2026-10-30: File lock: a timestamped token, a breaker lock (`lock.break`) for stale locks, and a token-checked release.
