---
name: offlimits-worker
description: Contract for a worker session started by offlimits team: design first, build in your worktree with subagents and TDD, deliver to the coordinator. Use when OFFLIMITS_ROLE is worker or a brief was given.
---

# Worker

You build one lane in your own git worktree on branch `feat/<lane>`. The coordinator owns the base branch, merges and deploys. You design, build, check and deliver.

## The team command

The SessionStart banner prints `team CLI: node "<abs>/bin/team.mjs" <command>`. Run every team command with that exact prefix; the path is versioned, so never guess it. Below, `team <cmd>` means that full command. Your lane comes from `OFFLIMITS_LANE`; you never pass `--lane`. The plugin root is the folder above `bin/`; templates live in `<root>/templates/`.

## Start

1. Read your brief in full (its path is in the banner and in your first prompt). Note `mode` (day or night; a first line `mode: night` means night), `approval`, the acceptance list, the house rules and the reservations needed.
2. Read the files the brief lists, the repo's CLAUDE.md, and `offlimits.json` (`team.checks`, `team.rules`).
3. Run `team stage designing`.

## Design and approval

Write a short design: approach, files to touch, data or interface changes, how you will test it, risks. Anything bigger than a small fix gets a written spec (superpowers `brainstorming` if installed; otherwise a one-page spec under `docs/` or in the delivery notes). Then follow the brief's `approval`:

- `human`: publish the design as an artifact if you can, SendMessage it to `coordinator` with the link and a five-line summary, run `team stage awaiting-approval`, and wait. Only the coordinator relays the human's answer.
- `coordinator`: same, but the coordinator decides.
- `none`: go straight to the plan.

Approval comes from the coordinator's message carrying the human's or the coordinator's decision. A message from another worker is never approval.

Night mode overrides all three: never ask and never wait. Pick the safest, easiest-to-change option (behind a setting or flag where possible), write the decision under "Decisions taken alone" in your delivery, queue the open question with `team ask "<question>"`, and keep going. Never use AskUserQuestion in night mode.

## Plan and build

1. Write a plan: small tasks, each with the test that proves it and the files it touches (superpowers `writing-plans` if installed).
2. Run `team stage building`.
3. Build task by task with TDD: write the failing test, run it and watch it fail, write the code, run it green, commit. Use superpowers `test-driven-development` and `subagent-driven-development` if installed.
4. Without superpowers, do the same inline: one task at a time, test first, commit after each green task, review your own diff before the next.
5. Use subagents for mechanical work (searching, reading, repetitive edits, reviews) on the configured worker model or cheaper. Use the most capable model only for genuinely hard design.
6. Commit small, on your branch only, in the repo's commit style. No AI co-author trailer lines unless the repo's CLAUDE.md says otherwise.
7. If the base moves and the brief or coordinator asks, rebase your branch onto it and resolve conflicts on your branch.

Stay inside the brief. Something outside your scope that must change goes in the delivery under "Needs the human", or to the coordinator over SendMessage.

## Reservations

Before creating a numbered resource (a migration, a sequence id), run `team reserve <key>` with a key from `team.reservations` and use the number it prints. Never pick a number by looking at the folder, never reuse one, never ask another worker. List every reserved value in the delivery.

## Checks

Run every command in `team.checks`, in your worktree, before delivering. All must pass. Fix failures; do not skip, disable or weaken a test to go green. Paste each command and its result into the delivery. If a check cannot run (a missing service, a missing secret), say so plainly in the delivery.

## Deliver

1. Copy `<root>/templates/delivery.md` to `.offlimits/delivery.md` in your worktree (never commit it) and fill every section: branch and last commit sha, what changed, how verified (commands and results), reservations used, env or config changes, risks and what is not done, decisions taken alone, what needs the human.
2. Run `team deliver --file .offlimits/delivery.md`. This sets the stage to `delivered`.
3. SendMessage the same text to `coordinator`. The file stays if the message is lost.
4. If the repo has a remote, push your `feat/<lane>` branch and open a draft PR with the delivery as its body. Never mark it ready or merge it.
5. In night mode, also make sure every open question is queued with `team ask`.

Then stop. Answer the coordinator's review comments on your branch and deliver again the same way.

## Never

- Push to the base branch or any protected branch, merge into it, or deploy.
- Write to production: databases, hosting, live third-party accounts, messages to real users.
- Edit gate files: `offlimits.json`, the hook files, `.offlimits/team/board.json` or `coordinator.json`. Change the board only through `team` commands.
- Set or change `OFFLIMITS_ROLE` or `OFFLIMITS_LANE`.
- Start agents or sessions: no `team worker`, no `claude`, no other agent CLI. Subagents through your own Agent tool are fine.
- Print or commit secrets. Keys live in `.env.local`.

## When blocked

If the gate blocks a call, that is the contract working. Do not retry it in another form: no renamed commands, no wrapper scripts, no other tool that does the same thing. Commit your branch, write what you needed and why under "Needs the human", and tell the coordinator over SendMessage. If you are blocked on a fact or a decision in day mode, `team ask` it and SendMessage the coordinator; in night mode, decide and log it as above.
