/** Which team CLI commands a caller may run, decided from its environment. */

export const PRIVILEGED = ['coordinator', 'worker', 'done', 'init', 'start'];
export const LANE_CMDS = ['stage', 'deliver', 'ask'];

// A solo Claude session (no recognised role) has no lane: only these.
const SOLO_ALLOWED = ['init', 'start', 'board', 'reserve', 'ask'];

/**
 * @param {string} cmd
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [roleEnv]
 * @returns {string | null} refusal message, or null when allowed
 */
export function guard(cmd, env, roleEnv = 'OFFLIMITS_ROLE') {
  if (!env.CLAUDECODE) return null;
  const role = String(env[roleEnv] || '').toLowerCase();
  let allowed;
  if (role === 'coordinator') allowed = true;
  else if (role === 'worker') allowed = !PRIVILEGED.includes(cmd);
  else allowed = SOLO_ALLOWED.includes(cmd);
  return allowed ? null : `offlimits team: "${cmd}" is for the coordinator (or a human terminal). Hand over instead of working around this.`;
}
