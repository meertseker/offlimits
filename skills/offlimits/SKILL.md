---
name: offlimits
description: Show offlimits gate status, run its self-test, or explain what the gate would do with a command. Use when the user types /offlimits, asks why a command was blocked, or wants to verify the gate.
---

# offlimits

Inspect the offlimits gate that keeps coding agents out of production.

## Locate the plugin root

When the plugin is installed in Claude Code, use `${CLAUDE_PLUGIN_ROOT}` as `<root>`. Otherwise `<root>` is the parent of the `skills/` directory that contains this file's folder (the directory that also contains `hooks/`); resolve it from the path of the file you are reading.

## Commands

- `/offlimits` or `/offlimits status` (default): run `node <root>/hooks/status.mjs`. Shows role, policy source and problems, protected branches, production state, active rules and the last 10 log lines.
- `/offlimits test`: run `node <root>/hooks/selftest.mjs`. Feeds fixture tool calls through the real hook in a temp git repo and prints a pass/fail table. Exit code 1 means a mismatch.
- `/offlimits explain <command>`: run `node <root>/hooks/explain.mjs -- <command>`. Prints the decision (`DECISION: deny (<rule>) - <reason>`, `ask`, or `allow`) as if the current role ran the command. Nothing is executed.

Run from the user's project directory so the right `offlimits.json` and git repo are used. Report the script output verbatim in a code block, then add at most two sentences of interpretation. If a call was blocked, do not suggest a workaround; tell the user to run it themselves or hand over to the coordinator.
