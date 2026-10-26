import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRole, roleDetail } from '../hooks/lib/role.mjs';
import { DEFAULT_POLICY } from '../hooks/lib/policy.mjs';

const P = DEFAULT_POLICY;
const trusted = { ...P, trustedAgentTypes: ['Explore'] };
const rows = [
  ['coordinator env, no agent', { session_id: 's' }, { OFFLIMITS_ROLE: 'coordinator' }, P, 'coordinator'],
  ['padded mixed case', {}, { OFFLIMITS_ROLE: ' Coordinator ' }, P, 'coordinator'],
  ['coordinator env inside subagent', { agent_id: 'a1' }, { OFFLIMITS_ROLE: 'coordinator' }, P, 'worker'],
  ['worker env', {}, { OFFLIMITS_ROLE: 'worker' }, P, 'worker'],
  ['agent_id, no env', { agent_id: 'a1' }, {}, P, 'worker'],
  ['nothing', {}, {}, P, 'solo'],
  ['null input, no env', null, {}, P, 'solo'],
  ['trusted agent type', { agent_id: 'x', agent_type: 'Explore' }, { OFFLIMITS_ROLE: 'coordinator' }, trusted, 'coordinator'],
  ['untrusted agent type', { agent_id: 'x', agent_type: 'Other' }, { OFFLIMITS_ROLE: 'coordinator' }, trusted, 'worker'],
  ['custom roleEnv', {}, { MY_ROLE: 'worker' }, { ...P, roleEnv: 'MY_ROLE' }, 'worker'],
  ['unknown env value', {}, { OFFLIMITS_ROLE: 'boss' }, P, 'solo'],
];
for (const [name, input, env, policy, want] of rows) {
  test(`role: ${name}`, () => assert.equal(resolveRole(input, env, policy), want));
}

const dw = { ...P, defaultRole: 'worker' };
const drows = [
  ['defaultRole worker, nothing set', {}, {}, dw, 'worker'],
  ['defaultRole worker, unknown env value', {}, { OFFLIMITS_ROLE: 'boss' }, dw, 'worker'],
  ['defaultRole worker, coordinator env wins', {}, { OFFLIMITS_ROLE: 'coordinator' }, dw, 'coordinator'],
  ['defaultRole worker, coordinator env in untrusted subagent', { agent_id: 'a' }, { OFFLIMITS_ROLE: 'coordinator' }, dw, 'worker'],
  ['defaultRole solo, nothing set', {}, {}, { ...P, defaultRole: 'solo' }, 'solo'],
  ['defaultRole solo, subagent', { agent_id: 'a' }, {}, { ...P, defaultRole: 'solo' }, 'worker'],
  ['defaultRole worker, null input', null, {}, dw, 'worker'],
];
for (const [name, input, env, policy, want] of drows) {
  test(`role: ${name}`, () => assert.equal(resolveRole(input, env, policy), want));
}

test('roleDetail marks a role that came from defaultRole', () => {
  assert.deepEqual(roleDetail({}, {}, dw), { role: 'worker', viaDefault: true });
  assert.deepEqual(roleDetail({}, { OFFLIMITS_ROLE: 'worker' }, dw), { role: 'worker', viaDefault: false });
  assert.deepEqual(roleDetail({ agent_id: 'a' }, {}, dw), { role: 'worker', viaDefault: false });
  assert.deepEqual(roleDetail({}, {}, P), { role: 'solo', viaDefault: false });
});
