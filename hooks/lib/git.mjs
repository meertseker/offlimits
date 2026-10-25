import { execFileSync } from 'node:child_process';
import path from 'node:path';

function run(cwd, args, exec) {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    const out = exec('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
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
  const name = run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], exec);
  return name && name !== 'HEAD' ? name : '';
}
