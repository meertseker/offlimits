import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from '../hooks/lib/policy.mjs';
import { loadTeam, TEAM_DEFAULTS } from '../hooks/lib/team/config.mjs';

const reader = (text) => () => text;

test('policy accepts team key without problems', () => {
  assert.deepEqual(loadPolicy('/repo', reader('{"team":{}}')).problems, []);
});

test('policy still flags unknown keys', () => {
  const r = loadPolicy('/repo', reader('{"teamz":1}'));
  assert.ok(r.problems.some((p) => /unknown key "teamz"/.test(p)));
});

test('loadTeam defaults', () => {
  const r = loadTeam('/repo', reader('{}'));
  assert.equal(r.enabled, false);
  assert.deepEqual(r.team, TEAM_DEFAULTS);
  assert.deepEqual(r.problems, []);
  assert.equal(loadTeam(null, reader('{}')).enabled, false);
});

test('loadTeam merges and validates', () => {
  const r = loadTeam('/repo', reader('{"team":{"maxWorkers":2,"checks":["npm test"],"models":{"worker":"haiku"}}}'));
  assert.equal(r.enabled, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.team.maxWorkers, 2);
  assert.deepEqual(r.team.checks, ['npm test']);
  assert.equal(r.team.models.coordinator, 'opus');
  assert.equal(r.team.models.worker, 'haiku');
});

test('loadTeam reports bad values and keeps defaults', () => {
  const cases = [
    [{ maxWorkers: 0 }, (t) => t.maxWorkers === 4],
    [{ checks: 'x' }, (t) => t.checks.length === 0],
    [{ reservations: { m: { scan: 'a', pattern: '(' } } }, (t) => Object.keys(t.reservations).length === 0],
    [{ terminal: 'x' }, (t) => t.terminal === 'auto'],
  ];
  for (const [team, kept] of cases) {
    const r = loadTeam('/repo', reader(JSON.stringify({ team })));
    assert.equal(r.problems.length, 1, JSON.stringify(team) + ' ' + r.problems);
    assert.match(r.problems[0], /^offlimits\.json: /);
    assert.ok(kept(r.team));
  }
});

test('loadTeam accepts reservations and defaults width', () => {
  const r = loadTeam('/repo', reader(JSON.stringify({ team: { reservations: { m: { scan: 'db/*.sql', pattern: '(\\d+)' } } } })));
  assert.deepEqual(r.problems, []);
  assert.equal(r.team.reservations.m.width, 4);
});

test('loadTeam strips BOM and never throws', () => {
  assert.equal(loadTeam('/repo', reader('﻿{"team":{}}')).enabled, true);
  assert.equal(loadTeam('/repo', reader('{nope')).enabled, false);
  assert.equal(loadTeam('/repo', () => { throw new Error('x'); }).enabled, false);
});

test('bad team block never changes gate policy', () => {
  const r = loadPolicy('/repo', reader('{"defaultRole":"worker","team":5}'));
  assert.equal(r.policy.defaultRole, 'worker');
  assert.deepEqual(r.problems, []);
  assert.equal(loadTeam('/repo', reader('{"team":5}')).problems.length, 1);
});

test('team.permissionMode defaults to default, accepts three modes, refuses the rest', () => {
  assert.equal(loadTeam('/repo', reader('{"team":{}}')).team.permissionMode, 'default');
  for (const m of ['default', 'acceptEdits', 'bypassPermissions']) {
    const r = loadTeam('/repo', reader(JSON.stringify({ team: { permissionMode: m } })));
    assert.deepEqual(r.problems, []);
    assert.equal(r.team.permissionMode, m);
  }
  for (const m of ['plan', 'dontAsk', 'bypass', '', 1, null]) {
    const r = loadTeam('/repo', reader(JSON.stringify({ team: { permissionMode: m } })));
    assert.deepEqual(r.problems, ['offlimits.json: "team.permissionMode" must be one of default, acceptEdits, bypassPermissions']);
    assert.equal(r.team.permissionMode, 'default');
  }
});
