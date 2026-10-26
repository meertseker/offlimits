import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, loadPolicy } from '../hooks/lib/policy.mjs';

const reader = (text) => () => text;
const missing = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

test('defaults when file is missing', () => {
  const r = loadPolicy('/repo', missing);
  assert.deepEqual(r.policy, DEFAULT_POLICY);
  assert.equal(r.source, 'default');
  assert.deepEqual(r.problems, []);
});

test('defaults when root is null', () => {
  const r = loadPolicy(null, reader('{}'));
  assert.deepEqual(r.policy, DEFAULT_POLICY);
  assert.equal(r.source, 'default');
});

test('default values match the spec', () => {
  assert.deepEqual(DEFAULT_POLICY.protectedBranches, ['main', 'master']);
  assert.equal(DEFAULT_POLICY.roleEnv, 'OFFLIMITS_ROLE');
  assert.equal(DEFAULT_POLICY.onError, 'auto');
  assert.deepEqual(DEFAULT_POLICY.production, { mcpServers: [], projectRefs: [], hosts: [] });
});

test('invalid JSON gives defaults and a problem', () => {
  const r = loadPolicy('/repo', reader('{nope'));
  assert.deepEqual(r.policy, { ...DEFAULT_POLICY, defaultRole: 'worker' });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^offlimits\.json: invalid JSON \(.+\)/);
});

test('unparseable policy fails closed: defaultRole worker and a problem sentence', () => {
  for (const text of ['{"defaultRole": "solo", "allow": [', '[]', '']) {
    const r = loadPolicy('/repo', reader(text));
    assert.equal(r.policy.defaultRole, 'worker', text);
    assert.match(r.problems[0], /defaultRole falls back to worker until offlimits\.json is fixed/);
  }
});

test('missing policy file keeps defaultRole solo', () => {
  assert.equal(loadPolicy('/repo', missing).policy.defaultRole, 'solo');
});

test('BOM does not make a valid file unparseable', () => {
  const r = loadPolicy('/repo', reader('﻿{}'));
  assert.equal(r.policy.defaultRole, 'solo');
  assert.deepEqual(r.problems, []);
});

test('unknown key is reported and ignored', () => {
  const r = loadPolicy('/repo', reader('{"bogus": 1}'));
  assert.deepEqual(r.problems, ['offlimits.json: unknown key "bogus"']);
  assert.equal(r.policy.bogus, undefined);
});

test('protectedBranches replaces defaults', () => {
  const r = loadPolicy('/repo', reader('{"protectedBranches":["release"]}'));
  assert.deepEqual(r.policy.protectedBranches, ['release']);
  assert.match(r.source, /offlimits\.json$/);
  assert.deepEqual(r.problems, []);
});

test('protectedPaths replaces defaults', () => {
  const r = loadPolicy('/repo', reader('{"protectedPaths":["x/**"]}'));
  assert.deepEqual(r.policy.protectedPaths, ['x/**']);
});

test('production arrays merge with defaults', () => {
  const r = loadPolicy('/repo', reader('{"production":{"mcpServers":["supabase"]}}'));
  assert.deepEqual(r.policy.production.mcpServers, ['supabase']);
  assert.deepEqual(r.policy.production.hosts, []);
});

test('invalid onError gives problem and auto', () => {
  const r = loadPolicy('/repo', reader('{"onError":"nonsense"}'));
  assert.equal(r.policy.onError, 'auto');
  assert.equal(r.problems.length, 1);
});

test('wrong type gives problem and default for that key', () => {
  const r = loadPolicy('/repo', reader('{"protectedBranches":"main","roleEnv":5}'));
  assert.deepEqual(r.policy.protectedBranches, ['main', 'master']);
  assert.equal(r.policy.roleEnv, 'OFFLIMITS_ROLE');
  assert.equal(r.problems.length, 2);
});

test('extraDeny entries are validated', () => {
  const r = loadPolicy('/repo', reader('{"extraDeny":[{"pattern":"foo","reason":"no"},{"pattern":1}]}'));
  assert.deepEqual(r.policy.extraDeny, [{ pattern: 'foo', reason: 'no' }]);
  assert.equal(r.problems.length, 1);
});

test('loadPolicy does not mutate DEFAULT_POLICY', () => {
  const r = loadPolicy('/repo', missing);
  r.policy.protectedBranches.push('x');
  assert.deepEqual(DEFAULT_POLICY.protectedBranches, ['main', 'master']);
});

test('invalid regex in allow and extraDeny is dropped with a problem', () => {
  const r = loadPolicy('/repo', reader('{"allow":["ok","("],"extraDeny":[{"pattern":"[","reason":"x"},{"pattern":"fine","reason":"y"}]}'));
  assert.deepEqual(r.policy.allow, ['ok']);
  assert.deepEqual(r.policy.extraDeny, [{ pattern: 'fine', reason: 'y' }]);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /^offlimits\.json: invalid regex in allow: .+/);
  assert.match(r.problems[1], /^offlimits\.json: invalid regex in extraDeny: .+/);
});

test('leading BOM is stripped', () => {
  const r = loadPolicy('/repo', reader('\uFEFF{"protectedBranches":["rel"]}'));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.policy.protectedBranches, ['rel']);
});

test('defaultRole defaults to solo', () => {
  assert.equal(DEFAULT_POLICY.defaultRole, 'solo');
  assert.equal(loadPolicy('/repo', reader('{}')).policy.defaultRole, 'solo');
});

for (const v of ['solo', 'worker']) {
  test(`defaultRole accepts ${v}`, () => {
    const r = loadPolicy('/repo', reader(JSON.stringify({ defaultRole: v })));
    assert.equal(r.policy.defaultRole, v);
    assert.deepEqual(r.problems, []);
  });
}

for (const v of ['coordinator', 'boss', '', 1, null, ['worker']]) {
  test(`defaultRole rejects ${JSON.stringify(v)}`, () => {
    const r = loadPolicy('/repo', reader(JSON.stringify({ defaultRole: v })));
    assert.equal(r.policy.defaultRole, 'solo');
    assert.deepEqual(r.problems, ['offlimits.json: defaultRole must be "solo" or "worker"']);
  });
}
