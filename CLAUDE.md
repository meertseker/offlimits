# offlimits

Zero-dependency Claude Code plugin: a PreToolUse hook that keeps coding agents out of production.
Product design: `docs/superpowers/specs/2026-10-25-offlimits-design.md`.

## Roles

- `OFFLIMITS_ROLE=coordinator` merges, tags and releases. One coordinator per repo.
- Everyone else is a worker: work on `feat/<lane>` in `../offlimits-<lane>`.
- Open a draft PR on your first commit. Never push `main`.
- Start workers with `scripts/worker.ps1 -Lane <name>`, the coordinator with `scripts/coordinator.ps1`.
- If the gate blocks you, hand over to the coordinator. Do not work around it.
- Never set or export `OFFLIMITS_ROLE` yourself.

## Workflow

1. Brainstorm with the `superpowers:brainstorming` skill.
2. Write the spec in `docs/superpowers/specs/`.
3. Write the plan with `superpowers:writing-plans` in `docs/superpowers/plans/`.
4. Execute with `superpowers:subagent-driven-development`, TDD per task.
5. Do not implement anything beyond the current task.

## Before delivery

Run all three and paste the result into the delivery template:

```
node --test
node hooks/selftest.mjs
claude plugin validate --strict .
```

## Delivery template

Use this as the PR description (identical to `.github/pull_request_template.md`):

```delivery
lane: <name>
branch / sha: feat/<name> @ <sha>
touched: <files or areas>
checks: tests ✓ selftest ✓ validate ✓
new dependency: none (must stay none)
limits added to docs/limits.md: <yes / no / n/a>
risks: <what could break, what is unverified>
decision needed from Mert: <none / question>

Tasks
- [ ] <task 1>
- [ ] <task 2>
```

## Code rules

- Node >= 20 built-ins only (`node:` imports). No dependencies, no lockfile.
- Every rule has at least one deny test and one allow test.
- Rule ids come from the spec; do not invent new ones without a decision.
- All user-facing messages and docs are English (`README.tr.md` is the only exception).
- No network calls, no telemetry. Every file stays under 256 KiB.
- Tests use `node --test` only.

## Where state lives

- `DECISIONS.md`: Pending and Decided questions.
- `docs/ledger/lanes.md`: which lane owns which files.
- Open pull requests: work in flight.

## Compact instruction

When compacting, keep: your lane and branch, the current task, files you own in `docs/ledger/lanes.md`, failing tests, and any open question for Mert.
