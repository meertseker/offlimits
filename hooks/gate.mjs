#!/usr/bin/env node
// PreToolUse entry point. Must never throw out of the top level.
import { readStdin } from './lib/input.mjs';
import { loadPolicy, DEFAULT_POLICY } from './lib/policy.mjs';
import { resolveRole } from './lib/role.mjs';
import { repoRoot, commonRoot, currentBranch } from './lib/git.mjs';
import { decide } from './lib/rules.mjs';
import { denyMessage, askReason, summarize } from './lib/format.mjs';
import { appendLog } from './lib/log.mjs';

function record(cwd, input, role, decision, rule, summary) {
  try {
    appendLog(commonRoot(cwd) ?? repoRoot(cwd) ?? cwd, {
      at: new Date().toISOString(),
      role,
      tool: String(input?.tool_name ?? ''),
      decision,
      rule: rule ?? '',
      summary: summary ?? '',
    });
  } catch {
    /* ignore */
  }
}

function fail(err, input) {
  // Fail closed first: if anything below throws, a set worker role still blocks.
  const envRole = String(process.env.OFFLIMITS_ROLE ?? '').trim().toLowerCase();
  let code = envRole === 'worker' || input?.agent_id ? 2 : 0;
  try {
    const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    let policy = DEFAULT_POLICY;
    try {
      policy = loadPolicy(repoRoot(cwd) ?? cwd).policy;
    } catch {
      /* defaults */
    }
    const role = resolveRole(input, process.env, policy);
    const message = err instanceof Error ? err.message : String(err);
    const block = policy.onError === 'block' || (policy.onError === 'auto' && role === 'worker');
    code = block ? 2 : 0;
    record(cwd, input, role, 'error', '', message);
    if (block) {
      const why = role === 'solo' ? 'blocking because policy.onError is block' : 'blocking because a role is set';
      process.stderr.write(`offlimits: hook error, ${why}: ${message}\n`);
    }
  } catch {
    /* never throw */
  }
  process.exitCode = code;
}

function main() {
  const input = readStdin();
  try {
    if (!input || typeof input.tool_name !== 'string') {
      throw new Error('could not read hook input (empty, invalid, or missing tool_name)');
    }
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const root = repoRoot(cwd);
    const { policy } = loadPolicy(root ?? cwd);
    const role = resolveRole(input, process.env, policy);
    const d = decide(input, { role, policy, currentBranch, cwd, repoRoot: root, commonRoot: commonRoot(cwd) });
    if (d.action === 'allow') return;
    const summary = summarize(input);
    record(cwd, input, role, d.action, d.rule, summary);
    if (d.action === 'deny') {
      process.stderr.write(denyMessage({ ...d, summary }, role) + '\n');
      process.exitCode = 2;
    } else {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: askReason(d),
          },
        }),
      );
    }
  } catch (err) {
    fail(err, input);
  }
}

try {
  main();
} catch (err) {
  fail(err, null);
}
