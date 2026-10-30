import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LANE_RE, resolveBase, lanePath, addLane, laneStatus, removeLane } from '../hooks/lib/team/lanes.mjs';
import { TEAM_DEFAULTS } from '../hooks/lib/team/config.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(repoName = 'repo') {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-lanes-')));
  const root = path.join(tmp, repoName);
  fs.mkdirSync(root);
  git(root, '-c', 'init.defaultBranch=main', 'init');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  const cleanup = () => {
    try {
      for (const l of git(root, 'worktree', 'list', '--porcelain').split(/\r?\n/)) {
        if (l.startsWith('worktree ') && path.resolve(l.slice(9)) !== path.resolve(root)) {
          try { git(root, 'worktree', 'remove', '--force', l.slice(9)); } catch {}
        }
      }
    } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { tmp, root, cleanup };
}

const team = TEAM_DEFAULTS;

test('LANE_RE shape', () => {
  assert.ok(LANE_RE.test('demo'));
  assert.ok(!LANE_RE.test('Demo_1'));
  assert.ok(!LANE_RE.test('a'));
});

test('resolveBase with no remote falls back to local main', () => {
  const f = fixture();
  try { assert.equal(resolveBase(f.root, null), 'main'); } finally { f.cleanup(); }
});

test('resolveBase uses configured and no base found throws', () => {
  const f = fixture();
  try {
    assert.equal(resolveBase(f.root, 'release/1.0'), 'release/1.0');
    git(f.root, 'branch', '-m', 'main', 'trunk');
    assert.throws(() => resolveBase(f.root, null), /no base branch found/);
  } finally { f.cleanup(); }
});

test('resolveBase rejects "--upload-pack=x" and "a;b"', () => {
  const f = fixture();
  try {
    assert.throws(() => resolveBase(f.root, '--upload-pack=x'));
    assert.throws(() => resolveBase(f.root, 'a;b'));
  } finally { f.cleanup(); }
});

test('addLane creates branch and worktree beside the repo', () => {
  const f = fixture();
  try {
    const r = addLane(f.root, team, 'demo', { base: 'main' });
    assert.equal(r.branch, 'feat/demo');
    assert.equal(r.worktree, path.join(f.tmp, 'repo-demo'));
    assert.equal(git(r.worktree, 'branch', '--show-current'), 'feat/demo');
  } finally { f.cleanup(); }
});

test('addLane works when the repo path has a space', () => {
  const f = fixture('my repo');
  try {
    const r = addLane(f.root, team, 'demo', { base: 'main' });
    assert.equal(r.worktree, path.join(f.tmp, 'my repo-demo'));
    assert.equal(git(r.worktree, 'branch', '--show-current'), 'feat/demo');
  } finally { f.cleanup(); }
});

test('lanePath refuses a quote', () => {
  assert.throws(() => lanePath('/tmp/repo', { ...team, worktreeDir: "x'y" }, 'demo'), /quote/);
  assert.throws(() => lanePath('/tmp/repo', { ...team, worktreeDir: 'x"y' }, 'demo'), /quote/);
});

test('addLane rejects bad lane "Demo_1"', () => {
  const f = fixture();
  try { assert.throws(() => addLane(f.root, team, 'Demo_1', { base: 'main' }), /lane/); } finally { f.cleanup(); }
});

test('laneStatus reports ahead 1 and dirty after a commit plus an untracked file', () => {
  const f = fixture();
  try {
    const r = addLane(f.root, team, 'demo', { base: 'main' });
    fs.writeFileSync(path.join(r.worktree, 'b.txt'), 'b');
    git(r.worktree, 'add', '.');
    git(r.worktree, 'commit', '-m', 'work');
    fs.writeFileSync(path.join(r.worktree, 'u.txt'), 'u');
    const s = laneStatus(f.root, { branch: r.branch, worktree: r.worktree }, 'main');
    assert.equal(s.exists, true);
    assert.equal(s.ahead, 1);
    assert.equal(s.behind, 0);
    assert.equal(s.dirty, true);
    assert.equal(s.merged, false);
    assert.ok(s.lastCommitAge >= 0 && s.lastCommitAge < 120);
  } finally { f.cleanup(); }
});

test('laneStatus merged true after fast-forward merge into main', () => {
  const f = fixture();
  try {
    const r = addLane(f.root, team, 'demo', { base: 'main' });
    fs.writeFileSync(path.join(r.worktree, 'b.txt'), 'b');
    git(r.worktree, 'add', '.');
    git(r.worktree, 'commit', '-m', 'work');
    git(f.root, 'merge', '--ff-only', r.branch);
    const s = laneStatus(f.root, { branch: r.branch, worktree: r.worktree }, 'main');
    assert.equal(s.merged, true);
    assert.equal(s.ahead, 0);
    assert.equal(s.dirty, false);
  } finally { f.cleanup(); }
});

test('laneStatus on missing worktree', () => {
  const f = fixture();
  try {
    const s = laneStatus(f.root, { branch: 'feat/none', worktree: path.join(f.tmp, 'nope') }, 'main');
    assert.equal(s.exists, false);
  } finally { f.cleanup(); }
});

test('removeLane removes worktree and branch', () => {
  const f = fixture();
  try {
    const r = addLane(f.root, team, 'demo', { base: 'main' });
    removeLane(f.root, { branch: r.branch, worktree: r.worktree }, {});
    assert.equal(fs.existsSync(r.worktree), false);
    assert.equal(git(f.root, 'branch', '--list', 'feat/demo'), '');
  } finally { f.cleanup(); }
});

test('removeLane force removes unmerged dirty lane', () => {
  const f = fixture();
  try {
    const r = addLane(f.root, team, 'demo', { base: 'main' });
    fs.writeFileSync(path.join(r.worktree, 'b.txt'), 'b');
    git(r.worktree, 'add', '.');
    git(r.worktree, 'commit', '-m', 'work');
    fs.writeFileSync(path.join(r.worktree, 'u.txt'), 'u');
    assert.throws(() => removeLane(f.root, { branch: r.branch, worktree: r.worktree }, {}));
    removeLane(f.root, { branch: r.branch, worktree: r.worktree }, { force: true });
    assert.equal(git(f.root, 'branch', '--list', 'feat/demo'), '');
  } finally { f.cleanup(); }
});
