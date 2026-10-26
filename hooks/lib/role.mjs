/**
 * Resolve the acting role for a hook invocation and say whether it came from `policy.defaultRole`.
 * @param {object | null} input parsed hook stdin (may carry agent_id / agent_type)
 * @param {NodeJS.ProcessEnv} env
 * @param {import('./policy.mjs').Policy} policy
 * @returns {{role: 'coordinator' | 'worker' | 'solo', viaDefault: boolean}}
 */
export function roleDetail(input, env, policy) {
  const raw = env?.[policy.roleEnv];
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const inSubagent = Boolean(input?.agent_id);

  if (value === 'coordinator') {
    const trusted = (policy.trustedAgentTypes ?? []).includes(input?.agent_type);
    return { role: !inSubagent || trusted ? 'coordinator' : 'worker', viaDefault: false };
  }
  if (value === 'worker') return { role: 'worker', viaDefault: false };
  if (inSubagent) return { role: 'worker', viaDefault: false };
  const role = policy.defaultRole === 'worker' ? 'worker' : 'solo';
  return { role, viaDefault: role === 'worker' };
}

/**
 * Resolve the acting role for a hook invocation.
 * @returns {'coordinator' | 'worker' | 'solo'}
 */
export function resolveRole(input, env, policy) {
  return roleDetail(input, env, policy).role;
}
