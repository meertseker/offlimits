/** Which team CLI commands a caller may run, decided from its environment. */

export const PRIVILEGED = ['coordinator', 'worker', 'done', 'init', 'start', 'event'];
export const LANE_CMDS = ['stage', 'deliver', 'ask'];
// The control room answers approvals for the human: never from inside Claude Code, in any role.
export const HUMAN_ONLY = ['room'];

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
  if (HUMAN_ONLY.includes(cmd)) return `offlimits team: "${cmd}" answers approvals for the human; start it yourself from a terminal.`;
  const role = String(env[roleEnv] || '').toLowerCase();
  let allowed;
  if (role === 'coordinator') allowed = true;
  else if (role === 'worker') allowed = !PRIVILEGED.includes(cmd);
  else allowed = SOLO_ALLOWED.includes(cmd);
  return allowed ? null : `offlimits team: "${cmd}" is for the coordinator (or a human terminal). Hand over instead of working around this.`;
}
