---
name: offlimits
description: Show offlimits gate status, run its self-test, or explain what the gate would do with a command. Use when the user types /offlimits, asks why a command was blocked, or wants to verify the gate.
---

# offlimits

Inspect the offlimits gate that keeps coding agents out of production.

## Locate the plugin root

When the plugin is installed in Claude Code, use `${CLAUDE_PLUGIN_ROOT}` as `<root>`. Otherwise `<root>` is the parent of the `skills/` directory that contains this file's folder (the directory that also contains `hooks/`); resolve it from the path of the file you are reading.

## Commands

- `/offlimits` or `/offlimits status` (default): run `node "<root>/hooks/status.mjs"`. Shows role, policy source and problems, protected branches, production state, active rules and the last 10 log lines.
- `/offlimits test`: run `node "<root>/hooks/selftest.mjs"`. Feeds a deterministic sample of about 60 fixture tool calls (every rule, blocked and allowed) through the real hook in temp git repos and prints a pass/fail table; it takes about 10 seconds. Exit code 1 means a mismatch.
- `/offlimits test --all`: run `node "<root>/hooks/selftest.mjs" --all` with a 10-minute timeout (pass `timeout: 600000` to the shell tool). Runs every fixture, which takes a few minutes.
- `/offlimits explain <command>`: run `node "<root>/hooks/explain.mjs" '<command>'`, passing the whole command as one single-quoted argument (write each `'` inside it as `'\''`). Do not pass it as separate words after `--`: the gate would then check those words as a real command and may block the explain call itself. Prints the decision (`DECISION: deny (<rule>) - <reason>`, `ask`, or `allow`) as if the current role ran the command. Nothing is executed. Without arguments the script reads the command from stdin.

Team mode (see the `offlimits-coordinator` and `offlimits-worker` skills):

- `/offlimits init`: run `node "<root>/bin/team.mjs" init`. Turns the repo into a team repo: writes or merges `offlimits.json`, the managed CLAUDE.md block, the PR template, the `.gitignore` entry and `.offlimits/team/`. Safe to re-run. Show the shell function line it prints and say the human may add it to their shell profile; do not edit the profile. If the gate denies it (after the first `init` this session is a worker by `defaultRole`), tell the human to run `team init` from a terminal.
- `/offlimits board`: run `node "<root>/bin/team.mjs" board`. Shows every lane: stage, branch, ahead/behind, dirty, last commit, delivery, questions.
- `/offlimits team <args>`: run `node "<root>/bin/team.mjs" <args>`, passing each argument as its own quoted word. Without arguments it prints the team usage. Commands that start sessions or remove lanes (`coordinator`, `worker`, `done`) are for the coordinator or a human terminal; if the gate refuses, report that and stop.

Run from the user's project directory so the right `offlimits.json` and git repo are used. Report the script output verbatim in a code block, then add at most two sentences of interpretation. If a call was blocked, do not suggest a workaround; tell the user to run it themselves or hand over to the coordinator.
