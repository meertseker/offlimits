import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRole } from '../hooks/lib/role.mjs';
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
