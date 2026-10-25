#!/usr/bin/env node
// Prints gate status for the current directory. Always exits 0.
import { loadPolicy, productionConfigured } from './lib/policy.mjs';
import { resolveRole } from './lib/role.mjs';
import { repoRoot, commonRoot, currentBranch } from './lib/git.mjs';
import { readLog } from './lib/log.mjs';
import { RULE_IDS } from './lib/rules.mjs';

try {
  const cwd = process.cwd();
  const root = repoRoot(cwd);
  const { policy, source, problems } = loadPolicy(root ?? cwd);
  const role = resolveRole(null, process.env, policy);
  const p = policy.production;
  const configured = productionConfigured(policy);
  const out = [
    `role: ${role}`,
    `policy source: ${source}`,
    problems.length ? 'policy problems:' : 'policy problems: none',
    ...problems.map((x) => `  - ${x}`),
    `branch: ${currentBranch(cwd) || '(none)'}`,
    `protected branches: ${policy.protectedBranches.join(', ') || 'none'}`,
    `production: ${
      configured
        ? `configured (mcpServers: ${p.mcpServers.join(', ') || '-'}; projectRefs: ${p.projectRefs.join(', ') || '-'}; hosts: ${p.hosts.join(', ') || '-'})`
        : 'not configured: MCP writes ask'
    }`,
    `active rules: ${RULE_IDS.join(', ')}`,
    '',
    'last log lines:',
  ];
  const log = readLog(commonRoot(cwd) ?? root ?? cwd).slice(-10);
  if (!log.length) out.push('  (empty)');
  for (const e of log) {
    out.push(`  ${e.at ?? '?'}  ${e.decision ?? '?'}  ${e.role ?? '?'}  ${e.rule || '-'}  ${e.summary ?? ''}`);
  }
  console.log(out.join('\n'));
} catch (err) {
  console.log(`offlimits status failed: ${err instanceof Error ? err.message : String(err)}`);
}
