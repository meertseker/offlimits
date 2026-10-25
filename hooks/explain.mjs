#!/usr/bin/env node
// Prints what the gate would decide for a shell command. Nothing is executed. Always exits 0.
// Usage:
//   node explain.mjs '<command>'            one single-quoted argument (the form the skill uses)
//   echo '<command>' | node explain.mjs     no arguments: the command is read from stdin
//   node explain.mjs -- <command words...>  words are joined with spaces
import fs from 'node:fs';
import { loadPolicy } from './lib/policy.mjs';
import { resolveRole } from './lib/role.mjs';
import { repoRoot, commonRoot, currentBranch } from './lib/git.mjs';
import { decide } from './lib/rules.mjs';

function readCommand() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  if (argv.length) return argv.join(' ');
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8').replace(/^﻿/, '').replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}

try {
  const command = readCommand();
  if (!command.trim()) {
    console.log("DECISION: unknown - no command given; pass it as one single-quoted argument or on stdin");
  } else {
    const cwd = process.cwd();
    const root = repoRoot(cwd);
    const { policy } = loadPolicy(root ?? cwd);
    const input = { tool_name: 'Bash', tool_input: { command }, cwd };
    const role = resolveRole(input, process.env, policy);
    const d = decide(input, { role, policy, currentBranch, cwd, repoRoot: root, commonRoot: commonRoot(cwd) });
    console.log(d.action === 'allow' ? 'DECISION: allow' : `DECISION: ${d.action} (${d.rule}) - ${d.reason}`);
  }
} catch (err) {
  console.log(`DECISION: unknown - ${err instanceof Error ? err.message : String(err)}`);
}
