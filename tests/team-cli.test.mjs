import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../hooks/lib/team/cli.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(repoName = 'repo') {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cli-')));
  const root = path.join(tmp, repoName);
  fs.mkdirSync(root);
  git(root, '-c', 'init.defaultBranch=main', 'init');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  fs.writeFileSync(path.join(tmp, 'b.md'), '# brief\nDo the thing.\n');
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
  const sink = () => ({ s: '', write(x) { this.s += x; return true; } });
  const calls = { open: [], spawn: [] };
  /** run main in `cwd` (default root) */
  const run = async (argv, { env = {}, cwd = root, spawnSession, extra = {} } = {}) => {
    const stdout = sink();
    const stderr = sink();
    const code = await main(argv, {
      env, cwd, stdout, stderr,
      has: () => true,
      openTerminal: (spec) => calls.open.push(spec),
      spawnSession: spawnSession || ((file, args, o) => { calls.spawn.push({ file, args, ...o }); return 0; }),
      ...extra,
    });
    return { code, out: stdout.s, err: stderr.s };
  };
  const dir = path.join(root, '.offlimits', 'team');
  const setTeam = (team) => fs.writeFileSync(path.join(root, 'offlimits.json'), JSON.stringify({ defaultRole: 'worker', team }));
  return { tmp, root, dir, run, calls, cleanup, setTeam };
}

test('init then worker then board', async () => {
  const f = fixture();
  try {
    const i = await f.run(['init']);
    assert.equal(i.code, 0, i.err);
    assert.match(i.out, /team/);
    const w = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    assert.equal(w.code, 0, w.err);
    assert.match(w.out, /claude --model sonnet -n demo/);
    assert.ok(fs.existsSync(path.join(f.dir, 'briefs', 'demo.md')));
    assert.equal(f.calls.open.length, 0);
    const b = await f.run(['board']);
    assert.equal(b.code, 0, b.err);
    assert.match(b.out, /demo {2}briefed/);
    const j = await f.run(['board', '--json']);
    assert.equal(JSON.parse(j.out)[0].lane, 'demo');
  } finally { f.cleanup(); }
});

test('board with no lanes', async () => {
  const f = fixture();
  try {
    assert.match((await f.run(['board'])).out, /no lanes yet/);
  } finally { f.cleanup(); }
});

test('worker prompt names the absolute brief path', async () => {
  const f = fixture();
  try {
    const w = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    assert.ok(w.out.includes(`You are worker demo. Read ${path.join(f.dir, 'briefs', 'demo.md')} and follow it.`), w.out);
  } finally { f.cleanup(); }
});

test('worker opens a terminal when not --print', async () => {
  const f = fixture();
  try {
    const w = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md')]);
    assert.equal(w.code, 0, w.err);
    assert.equal(f.calls.open.length, 1);
    assert.ok(f.calls.open[0].args.join(' ').includes(path.join(f.tmp, 'repo-demo')), JSON.stringify(f.calls.open[0]));
  } finally { f.cleanup(); }
});

test('terminal none prints instead of opening', async () => {
  const f = fixture();
  try {
    f.setTeam({ terminal: 'none' });
    const w = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md')]);
    assert.equal(w.code, 0, w.err);
    assert.equal(f.calls.open.length, 0);
    assert.match(w.out, /claude --model sonnet -n demo/);
  } finally { f.cleanup(); }
});

test('worker refused inside Claude for worker role', async () => {
  const f = fixture();
  try {
    const w = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print'], { env: { CLAUDECODE: '1', OFFLIMITS_ROLE: 'worker' } });
    assert.equal(w.code, 3);
    assert.ok(!fs.existsSync(path.join(f.dir, 'briefs', 'demo.md')));
  } finally { f.cleanup(); }
});

test('--print inside Claude never prints the role assignment', async () => {
  const f = fixture();
  try {
    const w = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print'], { env: { CLAUDECODE: '1', OFFLIMITS_ROLE: 'coordinator' } });
    assert.equal(w.code, 0, w.err);
    assert.ok(!/OFFLIMITS_ROLE|OFFLIMITS_LANE/.test(w.out + w.err), w.out);
    assert.match(w.out, /claude --model sonnet -n demo/);
    assert.match(w.out, /role is set by the launcher/);
    const human = await f.run(['worker', 'demo2', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    assert.match(human.out, /OFFLIMITS_ROLE/);
  } finally { f.cleanup(); }
});

test('maxWorkers enforced', async () => {
  const f = fixture();
  try {
    f.setTeam({ maxWorkers: 1 });
    const brief = path.join(f.tmp, 'b.md');
    assert.equal((await f.run(['worker', 'one', '--brief', brief, '--print'])).code, 0);
    const second = await f.run(['worker', 'two', '--brief', brief, '--print']);
    assert.notEqual(second.code, 0);
    assert.match(second.err, /maxWorkers/);
  } finally { f.cleanup(); }
});

test('worker requires --brief and a valid lane', async () => {
  const f = fixture();
  try {
    assert.equal((await f.run(['worker', 'demo'])).code, 2);
    assert.equal((await f.run(['worker', 'Bad_Lane', '--brief', path.join(f.tmp, 'b.md')])).code, 2);
  } finally { f.cleanup(); }
});

test('night brief', async () => {
  const f = fixture();
  try {
    await f.run(['worker', 'x1', '--brief', path.join(f.tmp, 'b.md'), '--night', '--print']);
    assert.ok(fs.readFileSync(path.join(f.dir, 'briefs', 'x1.md'), 'utf8').startsWith('mode: night'));
  } finally { f.cleanup(); }
});

test('unsafe model is refused before any git or board change', async () => {
  const f = fixture();
  try {
    const w = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--model', 'a b;c', '--print']);
    assert.equal(w.code, 1);
    assert.ok(w.err.includes("--model must match"), w.err);
    assert.equal(f.calls.open.length, 0);
    assert.ok(!fs.existsSync(path.join(f.tmp, 'repo-demo')));
    assert.equal(git(f.root, 'branch', '--list', 'feat/demo'), '');
    assert.ok(!fs.existsSync(path.join(f.dir, 'board.json')));
  } finally { f.cleanup(); }
});

test('unsafe brief path names the path and leaves nothing behind', async () => {
  const f = fixture('re+po');
  try {
    const w = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    assert.equal(w.code, 1);
    assert.match(w.err, /the brief path contains characters a terminal command cannot carry safely: .*demo.md; move the repo to a path without/);
    assert.ok(!fs.existsSync(path.join(f.tmp, 're+po-demo')));
    assert.equal(git(f.root, 'branch', '--list', 'feat/demo'), '');
    assert.ok(!fs.existsSync(path.join(f.dir, 'board.json')));
  } finally { f.cleanup(); }
});

test('non-object team refuses worker and coordinator', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'offlimits.json'), JSON.stringify({ team: 'yes' }));
    const w = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    assert.equal(w.code, 2);
    assert.match(w.err, /"team" must be an object/);
    assert.equal((await f.run(['coordinator', '--print'])).code, 2);
  } finally { f.cleanup(); }
});

async function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  await new Promise((r) => child.once('spawn', r));
  return child;
}

test('coordinator refuses second live coordinator', async () => {
  const f = fixture();
  const child = await liveChild();
  try {
    ensure(f.dir);
    fs.writeFileSync(path.join(f.dir, 'coordinator.json'), JSON.stringify({ pid: child.pid, startedAt: 'x' }));
    const r = await f.run(['coordinator']);
    assert.equal(r.code, 4);
    assert.match(r.err, /a coordinator is already running \(pid \d+\)/);
    assert.equal(f.calls.spawn.length, 0);
    const t = await f.run(['coordinator', '--takeover']);
    assert.equal(t.code, 0, t.err);
    assert.equal(f.calls.spawn.length, 1);
    const s = f.calls.spawn[0];
    assert.equal(s.file, 'claude');
    assert.deepEqual(s.args.slice(0, 4), ['--model', 'opus', '-n', 'coordinator']);
    assert.equal(s.env.OFFLIMITS_ROLE, 'coordinator');
    assert.equal(s.env.OFFLIMITS_TEAM_LAUNCHER_PID, String(process.pid));
  } finally { child.kill(); f.cleanup(); }
});

function ensure(dir) { fs.mkdirSync(dir, { recursive: true }); }

test('coordinator --resume adds --continue; stale pid does not block', async () => {
  const f = fixture();
  try {
    ensure(f.dir);
    fs.writeFileSync(path.join(f.dir, 'coordinator.json'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    const r = await f.run(['coordinator', '--resume']);
    assert.equal(r.code, 0, r.err);
    assert.ok(f.calls.spawn[0].args.includes('--continue'));
  } finally { f.cleanup(); }
});

test('coordinator removes its lock after exit', async () => {
  const f = fixture();
  try {
    let during = null;
    const r = await f.run(['coordinator'], {
      spawnSession: () => { during = JSON.parse(fs.readFileSync(path.join(f.dir, 'coordinator.json'), 'utf8')); return 0; },
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(during.pid, process.pid);
    assert.ok(!fs.existsSync(path.join(f.dir, 'coordinator.json')));
  } finally { f.cleanup(); }
});

test('coordinator keeps a lock another process took over', async () => {
  const f = fixture();
  try {
    await f.run(['coordinator'], {
      spawnSession: () => { fs.writeFileSync(path.join(f.dir, 'coordinator.json'), JSON.stringify({ pid: 1 })); return 0; },
    });
    assert.ok(fs.existsSync(path.join(f.dir, 'coordinator.json')));
  } finally { f.cleanup(); }
});

test('coordinator refuses to run from a worktree', async () => {
  const f = fixture();
  try {
    await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    const r = await f.run(['coordinator'], { cwd: path.join(f.tmp, 'repo-demo') });
    assert.equal(r.code, 2);
    assert.match(r.err, /main checkout/);
  } finally { f.cleanup(); }
});

test('coordinator --print shows no role assignment', async () => {
  const f = fixture();
  try {
    const r = await f.run(['coordinator', '--print']);
    assert.equal(r.code, 0);
    assert.ok(!/OFFLIMITS_ROLE/.test(r.out));
    assert.match(r.out, /claude --model opus -n coordinator/);
  } finally { f.cleanup(); }
});

test('reserve scans worktrees', async () => {
  const f = fixture();
  try {
    f.setTeam({ reservations: { migration: { scan: 'migrations', pattern: '^(\\d+)_.*\\.sql$', width: 4 } } });
    fs.mkdirSync(path.join(f.root, 'migrations'));
    fs.writeFileSync(path.join(f.root, 'migrations', '0005_y.sql'), '');
    await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    const wt = path.join(f.tmp, 'repo-demo');
    fs.mkdirSync(path.join(wt, 'migrations'));
    fs.writeFileSync(path.join(wt, 'migrations', '0007_x.sql'), '');
    const r = await f.run(['reserve', 'migration']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), '0008');
    assert.equal((await f.run(['reserve', 'migration'])).out.trim(), '0009');
    const bad = await f.run(['reserve', 'nope']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /no reservation "nope" in offlimits.json team.reservations/);
  } finally { f.cleanup(); }
});

test('done refuses unmerged', async () => {
  const f = fixture();
  try {
    await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    const wt = path.join(f.tmp, 'repo-demo');
    fs.writeFileSync(path.join(wt, 'new.txt'), 'n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'work');
    const r = await f.run(['done', 'demo']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /not merged/);
    assert.ok(fs.existsSync(wt));
  } finally { f.cleanup(); }
});

test('done removes a merged lane', async () => {
  const f = fixture();
  try {
    await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    const wt = path.join(f.tmp, 'repo-demo');
    fs.writeFileSync(path.join(wt, 'new.txt'), 'n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'work');
    git(f.root, 'merge', '--no-edit', 'feat/demo');
    const r = await f.run(['done', 'demo']);
    assert.equal(r.code, 0, r.err);
    assert.ok(!fs.existsSync(wt));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'board.json'), 'utf8')).lanes.demo.stage, 'merged');
  } finally { f.cleanup(); }
});

test('done --abandon removes', async () => {
  const f = fixture();
  try {
    await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    const wt = path.join(f.tmp, 'repo-demo');
    fs.writeFileSync(path.join(wt, 'new.txt'), 'n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'work');
    const r = await f.run(['done', 'demo', '--abandon']);
    assert.equal(r.code, 0, r.err);
    assert.ok(!fs.existsSync(wt));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'board.json'), 'utf8')).lanes.demo.stage, 'abandoned');
  } finally { f.cleanup(); }
});

test('deliver sets delivered and stores file', async () => {
  const f = fixture();
  try {
    await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    const d = path.join(f.tmp, 'd.md');
    fs.writeFileSync(d, '# delivery');
    const r = await f.run(['deliver', '--file', d], { env: { OFFLIMITS_LANE: 'demo' } });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(path.join(f.dir, 'deliveries', 'demo.md'), 'utf8'), '# delivery');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'board.json'), 'utf8')).lanes.demo.stage, 'delivered');
    assert.match((await f.run(['board'])).out, /demo {2}delivered/);
  } finally { f.cleanup(); }
});

test('ask appends', async () => {
  const f = fixture();
  try {
    const env = { OFFLIMITS_LANE: 'demo' };
    assert.equal((await f.run(['ask', 'one?'], { env })).code, 0);
    assert.equal((await f.run(['ask', 'two?'], { env })).code, 0);
    const text = fs.readFileSync(path.join(f.dir, 'questions', 'demo.md'), 'utf8');
    assert.match(text, /one\?/);
    assert.match(text, /two\?/);
    assert.equal((await f.run(['ask', 'x'])).code, 2);
  } finally { f.cleanup(); }
});

test('stage uses OFFLIMITS_LANE; --lane only for coordinator or human; bad stage rejected', async () => {
  const f = fixture();
  try {
    const s = await f.run(['stage', 'building', '--note', 'go'], { env: { OFFLIMITS_LANE: 'demo' } });
    assert.equal(s.code, 0, s.err);
    const lanes = () => JSON.parse(fs.readFileSync(path.join(f.dir, 'board.json'), 'utf8')).lanes;
    assert.equal(lanes().demo.stage, 'building');
    assert.equal(lanes().demo.note, 'go');
    assert.equal((await f.run(['stage', 'designing', '--lane', 'other'], { env: { CLAUDECODE: '1', OFFLIMITS_ROLE: 'coordinator' } })).code, 0);
    assert.equal(lanes().other.stage, 'designing');
    const w = await f.run(['stage', 'merged', '--lane', 'other'], { env: { CLAUDECODE: '1', OFFLIMITS_ROLE: 'worker', OFFLIMITS_LANE: 'demo' } });
    assert.equal(lanes().other.stage, 'designing');
    assert.equal(lanes().demo.stage, 'merged');
    assert.equal(w.code, 0);
    assert.equal((await f.run(['stage', 'nope'], { env: { OFFLIMITS_LANE: 'demo' } })).code, 2);
    assert.equal((await f.run(['stage', 'building'], { env: { OFFLIMITS_LANE: '../x' } })).code, 2);
    assert.equal((await f.run(['stage', 'building'], { env: { CLAUDECODE: '1' } })).code, 3);
  } finally { f.cleanup(); }
});

test('init prints the profile line; help and unknown command', async () => {
  const f = fixture();
  try {
    const r = await f.run(['init', '--language', 'tr']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, process.platform === 'win32' ? /function team \{ node ".*team\.mjs" @args \}/ : /team\(\) \{ node ".*team\.mjs" "\$@"; \}/);
    assert.match(fs.readFileSync(path.join(f.root, 'offlimits.json'), 'utf8'), /"tr"/);
    assert.match((await f.run(['help'])).out, /coordinator/);
    assert.match((await f.run([])).out, /worker/);
    assert.equal((await f.run(['bogus'])).code, 2);
  } finally { f.cleanup(); }
});

test('done refuses a dirty merged lane and keeps the file', async () => {
  const f = fixture();
  try {
    await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    const wt = path.join(f.tmp, 'repo-demo');
    fs.writeFileSync(path.join(wt, 'new.txt'), 'n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'work');
    git(f.root, 'merge', '--no-edit', 'feat/demo');
    fs.writeFileSync(path.join(wt, 'precious.txt'), 'unsaved');
    const r = await f.run(['done', 'demo']);
    assert.equal(r.code, 1);
    assert.match(r.err, /lane demo has uncommitted changes; commit or use --abandon/);
    assert.ok(fs.existsSync(path.join(wt, 'precious.txt')));
  } finally { f.cleanup(); }
});

test('done refuses a zero-commit lane; --abandon removes it', async () => {
  const f = fixture();
  try {
    await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    const wt = path.join(f.tmp, 'repo-demo');
    const rec = JSON.parse(fs.readFileSync(path.join(f.dir, 'board.json'), 'utf8')).lanes.demo;
    assert.equal(rec.startSha, git(f.root, 'rev-parse', 'feat/demo'));
    assert.equal(rec.base, 'main');
    const r = await f.run(['done', 'demo']);
    assert.equal(r.code, 1);
    assert.match(r.err, /lane demo has no commits; use --abandon to drop it/);
    assert.ok(fs.existsSync(wt));
    assert.equal((await f.run(['done', 'demo', '--abandon'])).code, 0);
    assert.ok(!fs.existsSync(wt));
  } finally { f.cleanup(); }
});

test('done with a hand-deleted worktree prunes and drops the branch', async () => {
  const f = fixture();
  try {
    await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    const wt = path.join(f.tmp, 'repo-demo');
    fs.rmSync(wt, { recursive: true, force: true });
    assert.match((await f.run(['board'])).out, /demo {2}briefed.* yes$/m);
    const r = await f.run(['done', 'demo', '--abandon']);
    assert.equal(r.code, 0, r.err);
    assert.equal(git(f.root, 'branch', '--list', 'feat/demo'), '');
    assert.match((await f.run(['board'])).out, /demo {2}abandoned.* -$/m);
  } finally { f.cleanup(); }
});

test('coordinator child env uses the configured roleEnv; terminal env is scrubbed', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'offlimits.json'), JSON.stringify({ roleEnv: 'MY_ROLE', team: {} }));
    const r = await f.run(['coordinator']);
    assert.equal(r.code, 0, r.err);
    assert.equal(f.calls.spawn[0].env.MY_ROLE, 'coordinator');
    const seen = [];
    const w = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md')], {
      env: { KEEP: '1', MY_ROLE: 'coordinator', OFFLIMITS_LANE: 'y', OFFLIMITS_TEAM_LAUNCHER_PID: '1', CLAUDECODE: '1', CLAUDE_PID: '9', AI_AGENT: 'claude', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1', CLAUDE_CONFIG_DIR: 'keep' },
      extra: { openTerminal: (spec, fn, env) => seen.push({ spec, fn, env }) },
    });
    assert.equal(w.code, 0, w.err);
    assert.deepEqual(seen[0].env, { KEEP: '1', CLAUDE_CONFIG_DIR: 'keep' });
    assert.ok(seen[0].spec.args.join(' ').includes('MY_ROLE'));
  } finally { f.cleanup(); }
});

test('another lane can update the board while a slow addLane runs, and it survives', async () => {
  const f = fixture();
  try {
    const { addLane } = await import('../hooks/lib/team/lanes.mjs');
    const { updateLane } = await import('../hooks/lib/team/state.mjs');
    let seenDuring = null;
    const slow = (...a) => {
      updateLane(f.dir, 'other', { stage: 'building' }); // throws "team state is locked" if the launcher holds the lock
      seenDuring = JSON.parse(fs.readFileSync(path.join(f.dir, 'board.json'), 'utf8')).lanes.demo;
      return addLane(...a);
    };
    const w = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print'], { extra: { addLane: slow } });
    assert.equal(w.code, 0, w.err);
    assert.equal(seenDuring.note, 'creating');
    const lanes = JSON.parse(fs.readFileSync(path.join(f.dir, 'board.json'), 'utf8')).lanes;
    assert.equal(lanes.other.stage, 'building');
    assert.equal(lanes.demo.branch, 'feat/demo');
    assert.equal(lanes.demo.note, undefined);
    assert.ok(lanes.demo.startSha);
  } finally { f.cleanup(); }
});

test('a failing addLane removes the placeholder; a failing finalise rolls the worktree back', async () => {
  const f = fixture();
  try {
    const boom = () => { throw new Error('git exploded'); };
    const r = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print'], { extra: { addLane: boom } });
    assert.equal(r.code, 1);
    assert.match(r.err, /git exploded/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'board.json'), 'utf8')).lanes, {});
    // brief write fails (a directory sits where the brief file goes): worktree and branch are rolled back
    fs.mkdirSync(path.join(f.dir, 'briefs', 'demo.md'), { recursive: true });
    const r2 = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    assert.equal(r2.code, 1);
    assert.ok(!fs.existsSync(path.join(f.tmp, 'repo-demo')));
    assert.equal(git(f.root, 'branch', '--list', 'feat/demo'), '');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'board.json'), 'utf8')).lanes, {});
  } finally { f.cleanup(); }
});

function shortPath(p) {
  try {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, windowsVerbatimArguments: true }).trim();
  } catch { return ''; }
}

test('a cwd given as an 8.3 short path still launches', { skip: process.platform !== 'win32' }, async (t) => {
  const f = fixture('repository-with-a-long-name');
  try {
    const short = shortPath(f.root);
    if (!short.includes('~')) { t.skip('8.3 names are disabled on this volume'); return; }
    const w = await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print'], { cwd: short });
    assert.equal(w.code, 0, w.err);
    assert.ok(!w.out.includes('~'), w.out);
    assert.ok(w.out.includes(path.join(f.dir, 'briefs', 'demo.md')), w.out);
    assert.ok(fs.existsSync(path.join(f.dir, 'briefs', 'demo.md')));
  } finally { f.cleanup(); }
});

test('a lane stuck in "creating" can be abandoned, with or without git leftovers', async () => {
  const f = fixture();
  try {
    const stuck = { stage: 'briefed', note: 'creating', model: 'sonnet' };
    fs.mkdirSync(f.dir, { recursive: true });
    fs.writeFileSync(path.join(f.dir, 'board.json'), JSON.stringify({ lanes: { demo: stuck, bare: stuck } }));
    // demo: the launcher died after git made the worktree and branch; bare: it died before git ran
    const wt = path.join(f.tmp, 'repo-demo');
    git(f.root, 'worktree', 'add', '-b', 'feat/demo', wt, 'main');
    assert.notEqual((await f.run(['done', 'demo'])).code, 0);
    const r = await f.run(['done', 'demo', '--abandon']);
    assert.equal(r.code, 0, r.err);
    assert.ok(!fs.existsSync(wt));
    assert.equal(git(f.root, 'branch', '--list', 'feat/demo'), '');
    const b = await f.run(['done', 'bare', '--abandon']);
    assert.equal(b.code, 0, b.err);
    const lanes = JSON.parse(fs.readFileSync(path.join(f.dir, 'board.json'), 'utf8')).lanes;
    assert.equal(lanes.demo.stage, 'abandoned');
    assert.equal(lanes.bare.stage, 'abandoned');
  } finally { f.cleanup(); }
});

test('done --abandon prints the branch tip so the abandon can be undone', async () => {
  const f = fixture();
  try {
    await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    const wt = path.join(f.tmp, 'repo-demo');
    fs.writeFileSync(path.join(wt, 'new.txt'), 'n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'work');
    const sha = git(f.root, 'rev-parse', 'feat/demo');
    const r = await f.run(['done', 'demo', '--abandon']);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`git branch feat/demo ${sha}`), r.out);
  } finally { f.cleanup(); }
});

test('done tells the human to close the worker session when the worktree cannot be removed', async () => {
  const f = fixture();
  try {
    await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    const busy = () => { throw new Error("Command failed: git worktree remove --force -- x\nerror: failed to delete 'x': Permission denied"); };
    const r = await f.run(['done', 'demo', '--abandon'], { extra: { removeLane: busy } });
    assert.equal(r.code, 1);
    assert.match(r.err, /close the worker session in demo first, then re-run team done demo/);
    assert.ok(!/Permission denied/.test(r.err), r.err);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'board.json'), 'utf8')).lanes.demo.stage, 'briefed');
  } finally { f.cleanup(); }
});

test('re-running done after a half-finished worktree remove finishes the job', async () => {
  const f = fixture();
  try {
    await f.run(['worker', 'demo', '--brief', path.join(f.tmp, 'b.md'), '--print']);
    const wt = path.join(f.tmp, 'repo-demo');
    // what a failed `git worktree remove` on Windows leaves: git's record gone, an empty folder still there
    for (const n of fs.readdirSync(wt)) fs.rmSync(path.join(wt, n), { recursive: true, force: true });
    git(f.root, 'worktree', 'prune');
    const r = await f.run(['done', 'demo', '--abandon']);
    assert.equal(r.code, 0, r.err);
    assert.ok(!fs.existsSync(wt));
    assert.equal(git(f.root, 'branch', '--list', 'feat/demo'), '');
  } finally { f.cleanup(); }
});
