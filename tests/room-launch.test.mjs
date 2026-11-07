import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { runRoom } from '../hooks/lib/room/launch.mjs';
import { readEvents } from '../hooks/lib/team/events.mjs';

function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function world({ port }) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-launch-')));
  const home = path.join(tmp, 'home');
  const repo = path.join(tmp, 'shop');
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: repo, stdio: 'ignore' });
  const approvals = path.join(tmp, 'approvals');
  fs.mkdirSync(approvals);
  fs.writeFileSync(path.join(approvals, 'q1.md'), 'subject: Ship?\n- A: yes\n- B: no\nANSWER:\n');
  const loop = path.join(tmp, 'loop');
  fs.mkdirSync(loop);
  fs.writeFileSync(path.join(loop, 'status.json'), '{"status":"run"}');
  fs.writeFileSync(path.join(home, 'room.json'), JSON.stringify({
    port, claude: { dir: path.join(tmp, 'claude') },
    projects: [{ name: 'Shop', repo, approvals: { dir: approvals, actor: 'Mert', channel: 'room' }, loops: [{ name: 'Loop', dir: loop }] }],
  }));
  return { tmp, home, approvals, loop, env: { OFFLIMITS_HOME: home }, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('room starts, prints a one-time link, serves the snapshot, answers and pauses, then stops cleanly', async () => {
  const port = await freePort();
  const w = await world({ port });
  const out = [];
  const errs = [];
  const opened = [];
  try {
    const code = await runRoom({
      flags: {}, env: w.env, cwd: w.tmp, out: (s) => out.push(s), err: (s) => errs.push(s), platform: process.platform,
      deps: {
        homedir: () => w.home,
        openUrl: (u) => opened.push(u),
        waitForExit: async () => {
          assert.ok(fs.existsSync(path.join(w.home, 'room.pid')));
          const link = out.find((l) => l.startsWith('open: ')).slice(6);
          assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${port}/login\\?t=`));
          const login = await req(port, { path: link.slice(link.indexOf('/login')) });
          const cookie = login.headers['set-cookie'][0].split(';')[0];
          const state = JSON.parse((await req(port, { path: '/api/state', headers: { Cookie: cookie } })).body);
          assert.equal(state.projects[0].id, 'shop');
          assert.equal(state.needsYou.approvals[0].id, 'q1');
          const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'X-Offlimits-Room': '1' };
          const a = await req(port, { method: 'POST', path: '/api/answer', headers, body: JSON.stringify({ project: 'shop', id: 'q1', option: 'B', note: 'not yet' }) });
          assert.equal(a.status, 200, a.body);
          assert.equal(JSON.parse(a.body).file, 'q1.md');
          assert.match(fs.readFileSync(path.join(w.approvals, 'q1.md'), 'utf8'), /\nANSWER: B — not yet - Mert, \S+Z, room\n$/);
          const again = await req(port, { method: 'POST', path: '/api/answer', headers, body: JSON.stringify({ project: 'shop', id: 'q1', option: 'A' }) });
          assert.equal(again.status, 409);
          const l = await req(port, { method: 'POST', path: '/api/loop', headers, body: JSON.stringify({ project: 'shop', loop: 'loop', action: 'pause' }) });
          assert.equal(l.status, 200, l.body);
          assert.equal(JSON.parse(fs.readFileSync(path.join(w.loop, 'status.json'), 'utf8')).status, 'paused');
          assert.ok(fs.existsSync(path.join(w.loop, 'STOP')));
          const missing = await req(port, { method: 'POST', path: '/api/loop', headers, body: JSON.stringify({ project: 'shop', loop: 'nope', action: 'pause' }) });
          assert.equal(missing.status, 404);
          const after = JSON.parse((await req(port, { path: '/api/state', headers: { Cookie: cookie } })).body);
          assert.equal(after.needsYou.approvals.length, 0, 'the snapshot cache is dropped after a write');
        },
      },
    });
    assert.equal(code, 0, errs.join('\n'));
    assert.equal(opened.length, 1);
    assert.ok(!fs.existsSync(path.join(w.home, 'room.pid')));
    const ev = readEvents(path.join(w.home, 'events.jsonl'));
    assert.deepEqual(ev.map((e) => e.type), ['approval.answered', 'loop.paused']);
    assert.equal(ev[0].project, 'shop');
  } finally { w.done(); }
});

test('a busy port moves to the next one and says so; --no-open opens nothing', async () => {
  const port = await freePort();
  const w = await world({ port });
  const blocker = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const out = [];
  const opened = [];
  try {
    const code = await runRoom({
      flags: { 'no-open': true }, env: w.env, cwd: w.tmp, out: (s) => out.push(s), err: () => {}, platform: process.platform,
      deps: { homedir: () => w.home, openUrl: (u) => opened.push(u), waitForExit: async () => {} },
    });
    assert.equal(code, 0);
    assert.ok(out.some((l) => l.includes(`port ${port} is busy`)), out.join('\n'));
    assert.ok(out.some((l) => l.includes(`127.0.0.1:${port + 1}/login`)) || out.some((l) => /127\.0\.0\.1:\d+\/login/.test(l)));
    assert.equal(opened.length, 0);
  } finally {
    blocker.close();
    w.done();
  }
});

test('config problems are printed; a missing --config file stops with exit 2', async () => {
  const port = await freePort();
  const w = await world({ port });
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(w.home, 'room.json'), 'utf8'));
    cfg.bogus = 1;
    fs.writeFileSync(path.join(w.home, 'room.json'), JSON.stringify(cfg));
    const errs = [];
    const code = await runRoom({
      flags: { 'no-open': true }, env: w.env, cwd: w.tmp, out: () => {}, err: (s) => errs.push(s), platform: process.platform,
      deps: { homedir: () => w.home, waitForExit: async () => {} },
    });
    assert.equal(code, 0);
    assert.ok(errs.some((e) => e.includes('"bogus"')), errs.join('\n'));
    const missing = await runRoom({
      flags: { config: path.join(w.tmp, 'nope.json') }, env: w.env, cwd: w.tmp, out: () => {}, err: (s) => errs.push(s), platform: process.platform,
      deps: { homedir: () => w.home, waitForExit: async () => {} },
    });
    assert.equal(missing, 2);
  } finally { w.done(); }
});
