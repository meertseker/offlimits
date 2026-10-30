import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const LANE_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

const BASE_RE = /^[\w./-]+$/;
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'];

function git(cwd, args, exec) {
  return String(exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
}

function ok(cwd, args, exec) {
  try { git(cwd, args, exec); return true; } catch { return false; }
}

/** Base ref for new lanes: the configured one (validated) or the first existing of origin/main, origin/master, main, master. */
export function resolveBase(mainRoot, configured, exec = execFileSync) {
  if (configured) {
    if (typeof configured !== 'string' || !BASE_RE.test(configured) || configured.startsWith('-')) {
      throw new Error(`invalid base "${configured}"`);
    }
    return configured;
  }
  for (const c of BASE_CANDIDATES) {
    if (ok(mainRoot, ['rev-parse', '--verify', '--quiet', c], exec)) return c;
  }
  throw new Error('no base branch found');
}

/** Absolute worktree path for a lane, beside the repo by default. */
export function lanePath(mainRoot, team, lane) {
  const dir = path.resolve(mainRoot, team?.worktreeDir ?? '..');
  const p = path.join(dir, `${path.basename(mainRoot)}-${lane}`);
  if (/['"]/.test(p)) throw new Error(`worktree path must not contain a quote: ${p}`);
  return p;
}

function checkLane(lane) {
  if (typeof lane !== 'string' || !LANE_RE.test(lane)) throw new Error(`invalid lane name "${lane}"`);
}

/** Create branch feat/<lane> and its worktree from `base`. */
export function addLane(mainRoot, team, lane, { base }, exec = execFileSync) {
  checkLane(lane);
  if (typeof base !== 'string' || !BASE_RE.test(base) || base.startsWith('-')) throw new Error(`invalid base "${base}"`);
  const worktree = lanePath(mainRoot, team, lane);
  const branch = `feat/${lane}`;
  let remotes = '';
  try { remotes = git(mainRoot, ['remote'], exec); } catch { /* no remotes */ }
  if (remotes.split(/\r?\n/).map((s) => s.trim()).includes('origin')) {
    try {
      git(mainRoot, ['fetch', 'origin'], exec);
    } catch (e) {
      process.stderr.write(`offlimits: git fetch origin failed, continuing: ${String(e.message || e).split('\n')[0]}\n`);
    }
  }
  git(mainRoot, ['worktree', 'add', '-b', branch, worktree, base], exec);
  return { branch, worktree, base };
}

/** Inspect a lane: existence, divergence from base, dirtiness, last commit age (s), merged into base. */
export function laneStatus(mainRoot, lane, base, exec = execFileSync) {
  const out = { exists: false, ahead: 0, behind: 0, dirty: false, lastCommitAge: null, merged: false };
  out.exists = fs.existsSync(lane.worktree);
  try {
    const [behind, ahead] = git(mainRoot, ['rev-list', '--left-right', '--count', `${base}...${lane.branch}`], exec).trim().split(/\s+/).map(Number);
    out.behind = behind || 0;
    out.ahead = ahead || 0;
  } catch { /* branch missing */ }
  if (out.exists) {
    try { out.dirty = git(lane.worktree, ['status', '--porcelain'], exec).trim() !== ''; } catch { /* ignore */ }
  }
  try {
    const ct = Number(git(mainRoot, ['log', '-1', '--format=%ct', lane.branch], exec).trim());
    if (Number.isFinite(ct) && ct > 0) out.lastCommitAge = Math.max(0, Math.floor(Date.now() / 1000) - ct);
  } catch { /* ignore */ }
  out.merged = ok(mainRoot, ['merge-base', '--is-ancestor', lane.branch, base], exec);
  return out;
}

/** Remove worktree then branch. Without force, git refuses dirty trees and unmerged branches (throws). */
export function removeLane(mainRoot, lane, { force } = {}, exec = execFileSync) {
  git(mainRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), lane.worktree], exec);
  git(mainRoot, ['branch', force ? '-D' : '-d', lane.branch], exec);
}
