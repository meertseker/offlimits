import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decide, RULE_IDS } from '../hooks/lib/rules.mjs';
import { RULES } from '../hooks/lib/rules/shell-rules.mjs';
import { DEFAULT_POLICY } from '../hooks/lib/policy.mjs';
import { resolveRole } from '../hooks/lib/role.mjs';

const dir = new URL('./fixtures/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const cases = files.flatMap((f) =>
  JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')).map((c) => ({ ...c, file: f })),
);

export function mergePolicy(override = {}) {
  return {
    ...structuredClone(DEFAULT_POLICY),
    ...override,
    production: { ...structuredClone(DEFAULT_POLICY.production), ...(override.production ?? {}) },
  };
}

/**
 * Stub for currentBranch(dir): `branches` maps a directory suffix ("/m", "other") to a branch;
 * otherwise `branch` (default "feat/x") answers for every directory.
 */
export function branchStub(c) {
  return (d) => {
    const norm = String(d ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    for (const [suffix, b] of Object.entries(c.branches ?? {})) {
      if (norm === suffix || norm.endsWith(suffix.startsWith('/') ? suffix : `/${suffix}`)) return b;
    }
    return c.branch ?? 'feat/x';
  };
}

test('fixture table has at least 40 cases', () => {
  assert.ok(cases.length >= 40, `only ${cases.length} cases`);
});

test('fixtures are loaded from every file in tests/fixtures', () => {
  assert.ok(files.includes('cases.json'));
  assert.ok(files.includes('cases-shell.json'));
});

for (const c of cases) {
  test(`fixture (${c.file}): ${c.name}`, () => {
    const policy = mergePolicy(c.policy);
    // Same resolution as the gate: a fixture role "solo" means no env variable, so defaultRole applies.
    const role = resolveRole(null, c.role && c.role !== 'solo' ? { [policy.roleEnv]: c.role } : {}, policy);
    const ctx = {
      role,
      policy,
      currentBranch: branchStub(c),
      cwd: '/repo',
      repoRoot: '/repo',
    };
    const d = decide({ tool_name: c.tool_name, tool_input: c.tool_input }, ctx);
    assert.equal(d.action, c.expect, JSON.stringify(d));
    if (c.rule) assert.equal(d.rule, c.rule);
    if (c.expect !== 'allow') {
      assert.equal(typeof d.reason, 'string');
      assert.ok(d.reason.length > 0);
    }
    if (c.tool_name === 'Bash' || c.tool_name === 'PowerShell') {
      assert.deepEqual(Object.keys(d).sort(), c.expect === 'allow' ? ['action'] : ['action', 'reason', 'rule']);
    }
  });
}

test('coordinator is allowed before any rule runs', () => {
  const ctx = { role: 'coordinator', policy: mergePolicy(), currentBranch: () => 'main', cwd: '/repo', repoRoot: '/repo' };
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, ctx).action, 'allow');
  assert.equal(decide({ tool_name: 'mcp__acme__x', tool_input: { project_ref: 'abc' } }, { ...ctx, policy: mergePolicy({ production: { projectRefs: ['abc'] } }) }).action, 'allow');
});

test('RULE_IDS lists every shell rule, the shared ids and every fixture rule', () => {
  for (const r of RULES) assert.ok(RULE_IDS.includes(r.id), r.id);
  for (const id of ['extra-deny', 'opaque-shell', 'agent-spawn', 'github-mcp', 'mcp-destructive', 'protected-file', 'supabase-mcp', 'vercel-mcp', 'mcp-write']) {
    assert.ok(RULE_IDS.includes(id), id);
  }
  for (const c of cases) if (c.rule) assert.ok(RULE_IDS.includes(c.rule), `${c.name}: ${c.rule}`);
  assert.equal(new Set(RULE_IDS).size, RULE_IDS.length);
});

// Per-directory cases that a temp-repo self-test cannot reproduce (the directories do not exist there),
// so they live here instead of in tests/fixtures: solo deny when that directory is on main, allow on a feature branch.
for (const [command, suffix] of [
  ['cd ../m && git push', '/m'],
  ['Set-Location ..\\m; git push', '/m'],
  ['env -C /srv/x git push', '/srv/x'],
  ['git --git-dir=/repos/main/.git push', '/repos/main'],
  ['GIT_DIR=/repos/main/.git git push', '/repos/main'],
  ['export GIT_WORK_TREE=/repos/main; git push', '/repos/main'],
]) {
  test(`per-directory branch lookup: ${command}`, () => {
    const run = (branch) => decide(
      { tool_name: 'Bash', tool_input: { command } },
      { role: 'solo', policy: mergePolicy(), currentBranch: branchStub({ branches: { [suffix]: branch } }), cwd: '/repo', repoRoot: '/repo' },
    );
    assert.equal(run('main').action, 'deny');
    assert.equal(run('main').rule, 'git-push-protected');
    assert.equal(run('feat/y').action, 'allow');
  });
}

test('segment ctx carries segCwd and segEnvs to the rules', () => {
  const seen = [];
  const ctx = {
    role: 'solo',
    policy: mergePolicy(),
    currentBranch: (d) => {
      seen.push(String(d).replace(/\\/g, '/'));
      return 'feat/x';
    },
    cwd: '/repo',
    repoRoot: '/repo',
  };
  decide({ tool_name: 'Bash', tool_input: { command: 'cd ../m && git push' } }, ctx);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /\/m$/);
  assert.doesNotMatch(seen[0], /repo/);
});
