import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guard, PRIVILEGED, LANE_CMDS } from '../hooks/lib/team/guard.mjs';

const CMDS = ['init', 'coordinator', 'worker', 'done', 'board', 'stage', 'deliver', 'ask', 'reserve', 'start'];
const SOLO_OK = ['init', 'start', 'board', 'reserve', 'ask'];

function expected(claude, role, cmd) {
  if (!claude) return true;
  if (role === 'coordinator') return true;
  if (role === 'worker') return !PRIVILEGED.includes(cmd);
  return SOLO_OK.includes(cmd);
}

for (const claude of [false, true]) {
  for (const role of ['coordinator', 'worker', undefined]) {
    for (const cmd of CMDS) {
      test(`claude=${claude} role=${role} cmd=${cmd}`, () => {
        const env = {};
        if (claude) env.CLAUDECODE = '1';
        if (role) env.OFFLIMITS_ROLE = role;
        const r = guard(cmd, env);
        if (expected(claude, role, cmd)) assert.equal(r, null);
        else assert.equal(r, `offlimits team: "${cmd}" is for the coordinator (or a human terminal). Hand over instead of working around this.`);
      });
    }
  }
}

test('role is case-insensitive', () => {
  assert.equal(guard('worker', { CLAUDECODE: '1', OFFLIMITS_ROLE: 'Coordinator' }), null);
});

test('unrecognised role is solo', () => {
  assert.notEqual(guard('stage', { CLAUDECODE: '1', OFFLIMITS_ROLE: 'bogus' }), null);
});

test('custom roleEnv', () => {
  const env = { CLAUDECODE: '1', MY_ROLE: 'coordinator' };
  assert.equal(guard('worker', env, 'MY_ROLE'), null);
  assert.notEqual(guard('worker', env), null);
});

test('constants', () => {
  assert.deepEqual(PRIVILEGED, ['coordinator', 'worker', 'done', 'init', 'start']);
  assert.deepEqual(LANE_CMDS, ['stage', 'deliver', 'ask']);
});
