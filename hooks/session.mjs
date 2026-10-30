#!/usr/bin/env node
// SessionStart entry point: prints a short status banner as context. Never fails the session.
import { readStdin } from './lib/input.mjs';
import { loadPolicy, productionConfigured } from './lib/policy.mjs';
import { roleDetail } from './lib/role.mjs';
import { repoRoot, commonRoot, currentBranch } from './lib/git.mjs';
import { readLog } from './lib/log.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { banner, teamBanner } from './lib/format.mjs';
import { teamDir, readBoard } from './lib/team/state.mjs';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** Team section, or '' when this is not a team repo. Never throws. */
function teamSection(cwd, role) {
  try {
    const dir = teamDir(cwd);
    if (!dir || !fs.existsSync(dir)) return '';
    const board = readBoard(dir);
    const lane = (process.env.OFFLIMITS_LANE ?? '').trim() || null;
    const entries = Object.entries(board.lanes);
    const live = entries.filter(([, l]) => l.stage !== 'merged' && l.stage !== 'abandoned');
    let otherCoordinatorPid = null;
    try {
      const pid = JSON.parse(readText(path.join(dir, 'coordinator.json'))).pid;
      if (pidAlive(pid) && String(pid) !== (process.env.OFFLIMITS_TEAM_LAUNCHER_PID ?? '').trim()) otherCoordinatorPid = pid;
    } catch { /* no lock */ }
    const cli = `team CLI: node "${fileURLToPath(new URL('../bin/team.mjs', import.meta.url))}" <command>`;
    return '\n' + teamBanner({
      role,
      lane,
      board,
      deliveriesWaiting: live.filter(([, l]) => l.stage === 'delivered').map(([n]) => n),
      questionsWaiting: live.filter(([n]) => readText(path.join(dir, 'questions', `${n}.md`)).trim()).map(([n]) => n),
      staleLanes: entries
        .filter(([, l]) => (l.stage === 'merged' || l.stage === 'abandoned') && l.worktree && fs.existsSync(l.worktree))
        .map(([n]) => n),
      otherCoordinatorPid,
      briefPath: lane ? path.join(dir, 'briefs', `${lane}.md`) : null,
      stage: lane ? (board.lanes[lane]?.stage ?? null) : null,
      cli,
    });
  } catch {
    return '';
  }
}

try {
  const input = readStdin();
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const root = repoRoot(cwd);
  const { policy, source, problems } = loadPolicy(root ?? cwd);
  const { role, viaDefault } = roleDetail(input, process.env, policy);
  const log = readLog(commonRoot(cwd) ?? root ?? cwd);
  process.stdout.write(
    banner({
      role,
      roleViaDefault: viaDefault,
      protectedBranches: policy.protectedBranches,
      productionConfigured: productionConfigured(policy),
      blocks: log.filter((e) => e.decision === 'deny').length,
      errors: log.filter((e) => e.decision === 'error').length,
      branch: currentBranch(cwd),
      policySource: source,
      problems,
    }) + teamSection(cwd, role) + '\n',
  );
} catch {
  /* a banner must never break a session */
}
