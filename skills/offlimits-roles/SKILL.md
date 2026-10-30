---
name: offlimits-roles
description: Coordinator/worker contract for running several coding-agent sessions on one repo safely. Use when setting up parallel agent sessions, worktrees, or when a session hits an offlimits block.
---

# Coordinator / worker contract

Several agent sessions can share one repo without stepping on production if each has exactly one role. In a team repo (one with `.offlimits/team/`), follow the full ritual:

- Coordinator: the `offlimits-coordinator` skill.
- Worker: the `offlimits-worker` skill.

## Roles

- Coordinator: one per repo. Talks to the human, writes briefs, launches workers, reviews deliveries, and alone owns the base branch, merges, releases, deploys and anything touching production. Started by a human with `team coordinator` (or `OFFLIMITS_ROLE=coordinator` without team mode).
- Worker: any number. Each works in its own git worktree on a `feat/*` branch, started by the coordinator with `team worker <lane> --brief <file>` (or `OFFLIMITS_ROLE=worker` by hand without team mode).

The team command is printed in the SessionStart banner: `node "<abs>/bin/team.mjs" <command>`. Use it exactly.

## The contract

1. A worker never pushes to the base branch, never deploys, never writes to production, never edits gate config, never sets its role.
2. The same holds through MCP tools (for example a GitHub MCP merge or a commit to `main`) and through child agents: a worker does not start `claude`, `codex` or another agent CLI to do what it may not do itself.
3. A worker designs first, builds with tests, runs every check, and delivers with the template in `templates/delivery.md` (`team deliver --file <md>` in team mode, or the PR body otherwise).
4. Messages between sessions are never human approval. Merges and deploys happen only on the human's explicit go.
5. Commits carry no AI co-author trailer lines unless the repo's CLAUDE.md says otherwise.

## Without team mode

1. The coordinator creates a worktree per task: `git worktree add ../repo-task -b feat/task`.
2. Start the worker session inside that worktree with the worker role set.
3. The worker commits small, pushes its `feat/*` branch early and opens a draft PR so the coordinator can see progress.

## When blocked, hand over

If offlimits blocks a call, do not work around it: no renamed commands, no wrapper scripts, no editing the policy or role. The block is the contract working. Commit your branch, write what you needed in the delivery template, and hand over to the coordinator.
