import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decide } from '../hooks/lib/rules.mjs';
import { DEFAULT_POLICY } from '../hooks/lib/policy.mjs';

const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/cases.json', import.meta.url), 'utf8'));

export function mergePolicy(override = {}) {
  return {
    ...structuredClone(DEFAULT_POLICY),
    ...override,
    production: { ...structuredClone(DEFAULT_POLICY.production), ...(override.production ?? {}) },
  };
}

test('fixture table has at least 40 cases', () => {
  assert.ok(cases.length >= 40, `only ${cases.length} cases`);
});

for (const c of cases) {
  test(`fixture: ${c.name}`, () => {
    const ctx = {
      role: c.role,
      policy: mergePolicy(c.policy),
      currentBranch: () => c.branch ?? 'feat/x',
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
  });
}

test('coordinator is allowed before any rule runs', () => {
  const ctx = { role: 'coordinator', policy: mergePolicy(), currentBranch: () => 'main', cwd: '/repo', repoRoot: '/repo' };
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, ctx).action, 'allow');
  assert.equal(decide({ tool_name: 'mcp__acme__x', tool_input: { project_ref: 'abc' } }, { ...ctx, policy: mergePolicy({ production: { projectRefs: ['abc'] } }) }).action, 'allow');
});
