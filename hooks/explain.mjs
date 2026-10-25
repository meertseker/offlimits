#!/usr/bin/env node
// Usage: node explain.mjs -- <command...>   Prints what the gate would decide. Always exits 0.
import { loadPolicy } from './lib/policy.mjs';
import { resolveRole } from './lib/role.mjs';
import { repoRoot, commonRoot, currentBranch } from './lib/git.mjs';
import { decide } from './lib/rules.mjs';

try {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const command = argv.join(' ');
  const cwd = process.cwd();
  const root = repoRoot(cwd);
  const { policy } = loadPolicy(root ?? cwd);
  const input = { tool_name: 'Bash', tool_input: { command }, cwd };
  const role = resolveRole(input, process.env, policy);
  const d = decide(input, { role, policy, currentBranch, cwd, repoRoot: root, commonRoot: commonRoot(cwd) });
  console.log(d.action === 'allow' ? 'DECISION: allow' : `DECISION: ${d.action} (${d.rule}) - ${d.reason}`);
} catch (err) {
  console.log(`DECISION: unknown - ${err instanceof Error ? err.message : String(err)}`);
}
