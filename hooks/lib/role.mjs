/**
 * Resolve the acting role for a hook invocation.
 * @param {object | null} input parsed hook stdin (may carry agent_id / agent_type)
 * @param {NodeJS.ProcessEnv} env
 * @param {import('./policy.mjs').Policy} policy
 * @returns {'coordinator' | 'worker' | 'solo'}
 */
export function resolveRole(input, env, policy) {
  const raw = env?.[policy.roleEnv];
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const inSubagent = Boolean(input?.agent_id);

  if (value === 'coordinator') {
    const trusted = (policy.trustedAgentTypes ?? []).includes(input?.agent_type);
    return !inSubagent || trusted ? 'coordinator' : 'worker';
  }
  if (value === 'worker') return 'worker';
  if (inSubagent) return 'worker';
  return 'solo';
}
