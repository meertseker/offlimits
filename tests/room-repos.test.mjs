import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitAsync, readRepo } from '../hooks/lib/room/repos.mjs';

const DAY = 86_400_000;
const git = (cwd, args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();

function fixture() {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-repo-')));
  const root = path.join(tmp, 'repo');
  fs.mkdirSync(root);
  git(root, ['-c', 'init.defaultBranch=main', 'init']);
  for (const [k, v] of [['user.name', 'T'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false']]) git(root, ['config', k, v]);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  const add = (name, branch) => {
    const wt = path.join(tmp, name);
    git(root, ['worktree', 'add', '-b', branch, wt, 'main']);
    return wt;
  };
  const cleanup = () => {
    try {
      for (const l of git(root, ['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
        if (l.startsWith('worktree ') && path.resolve(l.slice(9)) !== path.resolve(root)) {
          try { git(root, ['worktree', 'remove', '--force', l.slice(9)]); } catch { /* best effort */ }
        }
      }
    } catch { /* best effort */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { tmp, root, add, cleanup };
}

const opts = (extra = {}) => ({ now: () => Date.now(), staleDays: 5, deliveryFiles: [], ledgerRows: [], ...extra });
const byId = (r) => Object.fromEntries(r.lanes.map((l) => [l.id, l]));

test('gitAsync returns trimmed output, or null on failure', async () => {
  const f = fixture();
  try {
    assert.equal(await gitAsync(f.root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(await gitAsync(f.root, ['rev-parse', '--verify', 'nope']), null);
    assert.equal(await gitAsync(path.join(f.tmp, 'missing'), ['status']), null);
  } finally { f.cleanup(); }
});

test('lanes: the main checkout, a lane with work, a lane with nothing beyond the base', async () => {
  const f = fixture();
  try {
    const a = f.add('repo-a', 'feat/a');
    fs.writeFileSync(path.join(a, 'b.txt'), 'b');
    git(a, ['add', '.']);
    git(a, ['commit', '-m', 'work on a']);
    fs.writeFileSync(path.join(a, 'untracked.txt'), 'u');
    f.add('repo-b', 'feat/b');
    const r = await readRepo({ name: 'repo', path: f.root, base: 'main' }, opts());
    assert.equal(r.error, undefined);
    assert.equal(r.base, 'main');
    assert.equal(r.baseHead.subject, 'init');
    const l = byId(r);
    assert.equal(l.repo.main, true);
    assert.equal(l.repo.state, 'main');
    assert.equal(l.repo.branch, 'main');
    assert.equal(l['repo-a'].branch, 'feat/a');
    assert.deepEqual([l['repo-a'].state, l['repo-a'].ahead, l['repo-a'].behind, l['repo-a'].dirty, l['repo-a'].merged], ['building', 1, 0, 1, false]);
    assert.equal(l['repo-a'].lastCommit.subject, 'work on a');
    assert.deepEqual(l['repo-a'].stage, { index: 3, name: 'building', inferred: true });
    assert.equal(l['repo-b'].state, 'merged');
    assert.deepEqual(l['repo-b'].stage, { index: 5, name: 'merged', inferred: true });
  } finally { f.cleanup(); }
});

test('a delivery note newer than the last commit marks the lane delivered, with fields and checks', async () => {
  const f = fixture();
  try {
    const a = f.add('repo-a', 'feat/a');
    fs.writeFileSync(path.join(a, 'b.txt'), 'b');
    git(a, ['add', '.']);
    git(a, ['commit', '-m', 'work']);
    const note = path.join(f.tmp, 'feat-a.md');
    fs.writeFileSync(note, '# Teslim\n\n```\ndal: feat/a     sha: 123\nkontroller: lint ✓ test ✗\nriskler: none\n```\n');
    const later = Date.now() + 60_000;
    fs.utimesSync(note, new Date(later), new Date(later));
    const r = await readRepo({ name: 'repo', path: f.root, base: 'main' }, opts({ deliveryFiles: [{ file: note, name: 'feat-a.md', mtime: later }] }));
    const lane = byId(r)['repo-a'];
    assert.equal(lane.state, 'delivered');
    assert.deepEqual(lane.stage, { index: 4, name: 'delivered', inferred: true });
    assert.deepEqual(lane.delivery.checks, [{ name: 'lint', ok: true }, { name: 'test', ok: false }]);
    assert.ok(lane.delivery.fields.some(([k, v]) => k === 'riskler' && v === 'none'));
  } finally { f.cleanup(); }
});

test('a lane quiet for longer than staleDays is stale', async () => {
  const f = fixture();
  try {
    const c = f.add('repo-c', 'feat/c');
    fs.writeFileSync(path.join(c, 'c.txt'), 'c');
    git(c, ['add', '.']);
    const old = new Date(Date.now() - 9 * DAY).toISOString();
    git(c, ['commit', '-m', 'old work'], { GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old });
    const lane = byId(await readRepo({ name: 'repo', path: f.root, base: 'main' }, opts()))['repo-c'];
    assert.equal(lane.state, 'stale');
    assert.equal(lane.quietDays, 9);
  } finally { f.cleanup(); }
});

test('a ledger row that names the branch gives the lane its status', async () => {
  const f = fixture();
  try {
    f.add('repo-a', 'feat/a');
    const ledgerRows = [
      { header: ['Oturum', 'Dal', 'Durum'], cells: ['x', 'feat/abc', 'NOT THIS'] },
      { header: ['Oturum', 'Dal', 'Durum'], cells: ['y', 'magaza / feat/a (taban `main`)', 'BAŞLADI'] },
    ];
    const lane = byId(await readRepo({ name: 'repo', path: f.root, base: 'main' }, opts({ ledgerRows })))['repo-a'];
    assert.equal(lane.ledger.status, 'BAŞLADI');
    assert.equal(lane.ledger.row.Oturum, 'y');
  } finally { f.cleanup(); }
});

test('a team board stage wins over the inferred one', async () => {
  const f = fixture();
  try {
    const a = f.add('repo-a', 'feat/a');
    const dir = path.join(f.root, '.offlimits', 'team');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ lanes: { a: { stage: 'designing', branch: 'feat/a', worktree: a, model: 'sonnet' } } }));
    const lane = byId(await readRepo({ name: 'repo', path: f.root, base: 'main' }, opts()))['repo-a'];
    assert.deepEqual(lane.team, { lane: 'a', stage: 'designing', note: null, model: 'sonnet' });
    assert.deepEqual(lane.stage, { index: 1, name: 'designing', inferred: false });
  } finally { f.cleanup(); }
});

test('today: base commits since local midnight, first parent only', async () => {
  const f = fixture();
  try {
    const old = new Date(Date.now() - 3 * DAY).toISOString();
    fs.writeFileSync(path.join(f.root, 'o.txt'), 'o');
    git(f.root, ['add', '.']);
    git(f.root, ['commit', '-m', 'three days ago'], { GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old });
    fs.writeFileSync(path.join(f.root, 'n.txt'), 'n');
    git(f.root, ['add', '.']);
    git(f.root, ['commit', '-m', 'today work']);
    const r = await readRepo({ name: 'repo', path: f.root, base: 'main' }, opts());
    assert.deepEqual(r.todayCommits.map((c) => c.subject).filter((s) => s !== 'init'), ['today work']);
  } finally { f.cleanup(); }
});

test('a missing repository is an error, not a crash; the base is found when not configured', async () => {
  const f = fixture();
  try {
    const bad = await readRepo({ name: 'nope', path: path.join(f.tmp, 'nope'), base: null }, opts());
    assert.match(bad.error, /not a git repository/);
    assert.deepEqual(bad.lanes, []);
    assert.equal((await readRepo({ name: 'repo', path: f.root, base: null }, opts())).base, 'main');
  } finally { f.cleanup(); }
});
