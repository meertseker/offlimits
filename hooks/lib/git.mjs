import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Per-call timeout for git: a slow git must not push the hook past Claude Code's 10 s hook timeout. */
export const GIT_TIMEOUT_MS = 2000;

function run(cwd, args, exec) {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    const out = exec('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const text = String(out).trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/** Top-level directory of the working tree, or null. Never throws. */
export function repoRoot(cwd, exec = execFileSync) {
  return run(cwd, ['rev-parse', '--show-toplevel'], exec);
}

/** Parent of the common git dir (shared by all worktrees), absolute, or null. Never throws. */
export function commonRoot(cwd, exec = execFileSync) {
  const dir = run(cwd, ['rev-parse', '--git-common-dir'], exec);
  if (!dir) return null;
  return path.dirname(path.resolve(cwd, dir));
}

/** Current branch name, or '' on error or detached HEAD. Never throws. */
export function currentBranch(cwd, exec = execFileSync) {
  let name = run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], exec);
  // Unborn branch (no commits yet): rev-parse fails, symbolic-ref still knows the name.
  if (!name) name = run(cwd, ['symbolic-ref', '--short', 'HEAD'], exec);
  return name && name !== 'HEAD' ? name : '';
}

/**
 * Worktree root, common root and current branch from one git spawn
 * (`git rev-parse --show-toplevel --git-common-dir --abbrev-ref HEAD`). Fields are null / '' when
 * unknown; on an unborn branch or any partial failure it falls back to the single-purpose calls.
 * Never throws.
 * @returns {{root: string | null, common: string | null, branch: string}}
 */
export function repoInfo(cwd, exec = execFileSync) {
  const text = run(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD'], exec);
  const lines = text ? text.split(/\r?\n/).map((l) => l.trim()) : [];
  if (lines.length === 3 && lines.every(Boolean)) {
    return { root: lines[0], common: path.dirname(path.resolve(cwd, lines[1])), branch: lines[2] === 'HEAD' ? '' : lines[2] };
  }
  const root = repoRoot(cwd, exec);
  if (!root) return { root: null, common: null, branch: '' };
  return { root, common: commonRoot(cwd, exec), branch: currentBranch(cwd, exec) };
}
