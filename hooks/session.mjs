#!/usr/bin/env node
// SessionStart entry point: prints a short status banner as context. Never fails the session.
import { readStdin } from './lib/input.mjs';
import { loadPolicy, productionConfigured } from './lib/policy.mjs';
import { resolveRole } from './lib/role.mjs';
import { repoRoot, commonRoot, currentBranch } from './lib/git.mjs';
import { readLog } from './lib/log.mjs';
import { banner } from './lib/format.mjs';

try {
  const input = readStdin();
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const root = repoRoot(cwd);
  const { policy, source, problems } = loadPolicy(root ?? cwd);
  const role = resolveRole(input, process.env, policy);
  const log = readLog(commonRoot(cwd) ?? root ?? cwd);
  process.stdout.write(
    banner({
      role,
      protectedBranches: policy.protectedBranches,
      productionConfigured: productionConfigured(policy),
      blocks: log.filter((e) => e.decision === 'deny').length,
      errors: log.filter((e) => e.decision === 'error').length,
      branch: currentBranch(cwd),
      policySource: source,
      problems,
    }) + '\n',
  );
} catch {
  /* a banner must never break a session */
}
