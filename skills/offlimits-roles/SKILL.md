---
name: offlimits-roles
description: Coordinator/worker contract for running several coding-agent sessions on one repo safely. Use when setting up parallel agent sessions, worktrees, or when a session hits an offlimits block.
---

# Coordinator / worker contract

Several agent sessions can share one repo without stepping on production if each has exactly one role.

## Roles

- Coordinator: one per repo. Owns `main`, merges, releases, deploys and anything touching production. Start it with `OFFLIMITS_ROLE=coordinator`.
- Worker: any number. Each works in its own git worktree on a `feat/*` branch. Start with `OFFLIMITS_ROLE=worker`.

## Setup

1. Coordinator creates a worktree per task: `git worktree add ../repo-task -b feat/task`.
2. Start the worker session inside that worktree with the worker role set.
3. A worker never pushes to `main`, never deploys, never writes to production, never edits gate config.
4. The same holds through MCP tools (for example a GitHub MCP merge or a commit to `main`) and through child agents: a worker does not start `claude`, `codex` or another agent CLI to do what it may not do itself.

## While working

- Commit small and push the `feat/*` branch early.
- Open a draft PR as soon as the first commit lands so the coordinator can see progress.
- Keep the branch rebased on `main`; resolve conflicts on your branch only.

## Delivery template

Post this in the PR when ready:

```
What changed:
How I verified it (commands + results):
Not done / risks:
Needs the coordinator: (migrations, deploys, secrets, merges)
```

## When blocked, hand over

If offlimits blocks a call, do not work around it: no renamed commands, no wrapper scripts, no editing the policy or role. The block is the contract working. Commit your branch, write what you needed in the delivery template, and hand over to the coordinator.
