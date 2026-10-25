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
  assert.deepEqual(r.policy, DEFAULT_POLICY);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^offlimits\.json: invalid JSON \(.+\)$/);
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
