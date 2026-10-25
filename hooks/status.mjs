#!/usr/bin/env node
// Prints gate status for the current directory. Always exits 0.
import { loadPolicy } from './lib/policy.mjs';
import { resolveRole } from './lib/role.mjs';
import { repoRoot, commonRoot, currentBranch } from './lib/git.mjs';
import { readLog } from './lib/log.mjs';
import * as rules from './lib/rules.mjs';

// Used only if rules.mjs does not export RULE_IDS.
const FALLBACK_RULES = [
  'git-push-protected', 'git-branch-protected', 'gh-write', 'supabase-remote', 'remote-db', 'db-migrate',
  'deploy', 'publish', 'role-spoof', 'agent-spawn', 'protected-file', 'supabase-mcp', 'vercel-mcp', 'github-mcp',
  'mcp-write', 'mcp-destructive', 'extra-deny', 'opaque-shell',
];
const RULES = Array.isArray(rules.RULE_IDS) && rules.RULE_IDS.length ? rules.RULE_IDS : FALLBACK_RULES;

try {
  const cwd = process.cwd();
  const root = repoRoot(cwd);
  const { policy, source, problems } = loadPolicy(root ?? cwd);
  const role = resolveRole(null, process.env, policy);
  const p = policy.production;
  const configured = p.mcpServers.length || p.projectRefs.length || p.hosts.length;
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
    `active rules: ${RULES.join(', ')}`,
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
