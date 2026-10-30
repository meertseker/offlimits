import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  teamDir, ensureTeamDir, withLock, readBoard, writeBoard, updateLane, reserve, STAGES,
} from '../hooks/lib/team/state.mjs';

const STATE_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'lib', 'team', 'state.mjs')).href;
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-team-')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('STAGES lists the lifecycle', () => {
  assert.equal(STAGES[0], 'briefed');
  assert.equal(STAGES.length, 7);
});

test('updateLane creates and merges', () => {
  const d = tmp();
  ensureTeamDir(d);
  assert.ok(fs.existsSync(path.join(d, 'briefs')) && fs.existsSync(path.join(d, 'deliveries')) && fs.existsSync(path.join(d, 'questions')));
  const a = updateLane(d, 'auth', { stage: 'briefed', branch: 'lane/auth' });
  const b = updateLane(d, 'auth', { note: 'hello' });
  assert.equal(b.createdAt, a.createdAt);
  assert.ok(b.updatedAt >= b.createdAt);
  assert.equal(b.note, 'hello');
  assert.equal(b.stage, 'briefed');
  assert.equal(readBoard(d).lanes.auth.note, 'hello');
});

test('updateLane rejects unknown stage', () => {
  const d = tmp();
  assert.throws(() => updateLane(d, 'x', { stage: 'shipping' }), /unknown stage/);
});

test('readBoard tolerates missing and corrupt files', () => {
  const d = tmp();
  assert.deepEqual(readBoard(d), { lanes: {} });
  fs.writeFileSync(path.join(d, 'board.json'), '{nope');
  assert.deepEqual(readBoard(d), { lanes: {} });
});

test('writeBoard is atomic', () => {
  const d = tmp();
  writeBoard(d, { lanes: { a: { stage: 'briefed' } } });
  assert.ok(!fs.existsSync(path.join(d, 'board.json.tmp')));
  assert.equal(readBoard(d).lanes.a.stage, 'briefed');
});

test('stale lock is broken', () => {
  const d = tmp();
  const lock = path.join(d, 'lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const t = Date.now();
  assert.equal(withLock(d, () => 42), 42);
  assert.ok(Date.now() - t < 500);
  assert.ok(!fs.existsSync(lock));
});

test('live lock times out', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'lock'), '');
  assert.throws(() => withLock(d, () => 1, { timeoutMs: 100 }), /locked/);
  assert.ok(fs.existsSync(path.join(d, 'lock')));
});

test('lock is released when fn throws', () => {
  const d = tmp();
  assert.throws(() => withLock(d, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(path.join(d, 'lock')));
});

test('reserve pads and increments', () => {
  const d = tmp();
  assert.equal(reserve(d, 'migration', { floor: 12 }), '0013');
  assert.equal(reserve(d, 'migration', { lane: 'auth' }), '0014');
  const r = JSON.parse(fs.readFileSync(path.join(d, 'reservations.json'), 'utf8'));
  assert.equal(r.migration.last, 14);
  assert.equal(r.migration.history[1].lane, 'auth');
});

test('reserve is safe across processes', async () => {
  const d = tmp();
  const code = `import(${JSON.stringify(STATE_URL)}).then(m=>{const o=[];for(let i=0;i<20;i++)o.push(m.reserve(${JSON.stringify(d)},'k',{}));console.log(o.join(','))})`;
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.on('close', (n) => (n === 0 ? resolve(out.trim()) : reject(new Error('child exit ' + n))));
  });
  const outs = await Promise.all([run(), run()]);
  const all = outs.flatMap((o) => o.split(','));
  assert.equal(new Set(all).size, 40);
  assert.deepEqual([...all].sort(), Array.from({ length: 40 }, (_, i) => String(i + 1).padStart(4, '0')));
});

test('teamDir from a worktree points to the main checkout', () => {
  const base = tmp();
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  git(main, '-c', 'init.defaultBranch=main', 'init');
  git(main, 'config', 'user.name', 't');
  git(main, 'config', 'user.email', 't@example.com');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a');
  git(main, 'add', '.');
  git(main, 'commit', '-m', 'init');
  const wt = path.join(base, 'x-lane');
  git(main, 'worktree', 'add', wt, '-b', 'lane/x');
  assert.equal(teamDir(wt), teamDir(main));
  assert.equal(teamDir(main), path.join(main, '.offlimits', 'team'));
  assert.equal(teamDir(''), null);
});

test('release does not delete a lock another holder re-created', () => {
  const d = tmp();
  const lock = path.join(d, 'lock');
  withLock(d, () => { fs.rmSync(lock, { force: true }); fs.writeFileSync(lock, 'other-holder'); });
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other-holder');
});

test('a stale lock is broken by rename and leaves no debris', () => {
  const d = tmp();
  const lock = path.join(d, 'lock');
  fs.writeFileSync(lock, 'dead');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.equal(withLock(d, () => 7), 7);
  assert.deepEqual(fs.readdirSync(d), []);
});

test('two processes breaking the same stale lock never both enter', async () => {
  for (let round = 0; round < 3; round++) {
    const d = tmp();
    const lock = path.join(d, 'lock');
    fs.writeFileSync(lock, 'dead');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);
    const code = `import(${JSON.stringify(STATE_URL)}).then(m=>{const fs=require('node:fs');const inside=${JSON.stringify(path.join(d, 'inside'))};let bad=0;
      for(let i=0;i<10;i++)m.withLock(${JSON.stringify(d)},()=>{try{fs.writeFileSync(inside,'x',{flag:'wx'})}catch{bad++}
        const t=Date.now();while(Date.now()-t<15);try{fs.rmSync(inside)}catch{}},{timeoutMs:10000});
      console.log(bad)})`;
    const run = () => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      c.stdout.on('data', (b) => { out += b; });
      c.on('close', (n) => (n === 0 ? resolve(Number(out.trim())) : reject(new Error('child exit ' + n))));
    });
    const bad = await Promise.all([run(), run()]);
    assert.deepEqual(bad, [0, 0]);
  }
});

test('reserve refuses an unreadable reservations.json and keeps it', () => {
  const d = tmp();
  const f = path.join(d, 'reservations.json');
  fs.writeFileSync(f, '{not json');
  assert.throws(() => reserve(d, 'k', {}), /reservations\.json is unreadable; fix or delete it/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{not json');
});

const staleToken = (ageMs = 60000) => `4242-${Date.now() - ageMs}-deadbeef`;

test('4 processes contending on a stale lock never overlap and all finish', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'lock'), staleToken());
  const log = path.join(d, 'log.txt');
  const code = `import(${JSON.stringify(STATE_URL)}).then(m=>{const fs=require('node:fs');
    for(let i=0;i<5;i++)m.withLock(${JSON.stringify(d)},()=>{fs.appendFileSync(${JSON.stringify(log)},'enter|');
      const t=Date.now();while(Date.now()-t<10);fs.appendFileSync(${JSON.stringify(log)},'exit|')},{timeoutMs:20000});
    console.log('ok')})`;
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.on('close', (n) => (n === 0 ? resolve(out.trim()) : reject(new Error('child exit ' + n))));
  });
  const res = await Promise.all([run(), run(), run(), run()]);
  assert.deepEqual(res, ['ok', 'ok', 'ok', 'ok']);
  const lines = fs.readFileSync(log, 'utf8').split('|').filter(Boolean);
  assert.equal(lines.length, 40);
  lines.forEach((l, i) => assert.equal(l, i % 2 === 0 ? 'enter' : 'exit'));
  assert.ok(!fs.existsSync(path.join(d, 'lock')) && !fs.existsSync(path.join(d, 'lock.break')));
});

test('a breaker never deletes a lock that was re-created after it observed the stale one', () => {
  const d = tmp();
  const lock = path.join(d, 'lock');
  fs.writeFileSync(lock, staleToken());
  const fresh = `999-${Date.now()}-cafebabe`;
  assert.throws(() => withLock(d, () => 1, {
    timeoutMs: 300,
    hooks: { afterObserve: () => fs.writeFileSync(lock, fresh) },
  }), /locked/);
  assert.equal(fs.readFileSync(lock, 'utf8'), fresh);
  assert.ok(!fs.existsSync(path.join(d, 'lock.break')));
});

test('a stale lock.break is cleared and a live one is respected', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'lock'), staleToken());
  fs.writeFileSync(path.join(d, 'lock.break'), staleToken(120000));
  assert.equal(withLock(d, () => 5, { timeoutMs: 3000 }), 5);
  fs.writeFileSync(path.join(d, 'lock'), staleToken());
  fs.writeFileSync(path.join(d, 'lock.break'), `1-${Date.now()}-aa`);
  assert.throws(() => withLock(d, () => 1, { timeoutMs: 200 }), /locked/);
  assert.ok(fs.existsSync(path.join(d, 'lock.break')));
});
