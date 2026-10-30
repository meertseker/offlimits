import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { teamBanner } from '../hooks/lib/format.mjs';

const SESSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'session.mjs');
const lane = (stage) => ({ branch: 'b', worktree: 'w', stage, model: 'm', mode: 'x', note: '' });
const base = { board: { lanes: {} }, deliveriesWaiting: [], questionsWaiting: [], staleLanes: [], otherCoordinatorPid: null, briefPath: null, stage: null, cli: 'team CLI: node "/p/bin/team.mjs" <command>' };

test('coordinator banner', () => {
  const out = teamBanner({ ...base, role: 'coordinator', lane: null,
    board: { lanes: { a: lane('building'), b: lane('delivered'), c: lane('building') } },
    deliveriesWaiting: ['b'], questionsWaiting: ['c'], staleLanes: ['d'], otherCoordinatorPid: 42 });
  assert.match(out, /^team: 3 lanes \(2 building, 1 delivered\)$/m);
  assert.match(out, /^waiting for your review: b$/m);
  assert.match(out, /^questions for the human: c$/m);
  assert.match(out, /^merged but not cleaned \(run team done\): d$/m);
  assert.match(out, /^WARNING: another coordinator is running \(pid 42\)$/m);
  assert.match(out, /^team CLI: node /m);
});

test('worker banner', () => {
  const out = teamBanner({ ...base, role: 'worker', lane: 'demo', briefPath: '/x/demo.md', stage: 'building' });
  assert.match(out, /You are worker demo\. Brief: \/x\/demo\.md\. Stage: building\. Next: build, run checks, deliver/);
  assert.match(out, /If the gate blocks you, hand over to the coordinator\./);
  assert.match(teamBanner({ ...base, role: 'worker', lane: null }), /You are a worker without a lane; ask the coordinator for a brief\./);
});

test('solo banner', () => {
  assert.match(teamBanner({ ...base, role: 'solo', lane: null }),
    /This is a team repo\. Start the coordinator from a terminal with: team coordinator/);
});

test('at most 25 lines with 30 lanes', () => {
  const lanes = {};
  for (let i = 0; i < 30; i++) lanes[`l${i}`] = lane('building');
  const names = Object.keys(lanes);
  const out = teamBanner({ ...base, role: 'coordinator', board: { lanes }, deliveriesWaiting: names, questionsWaiting: names, staleLanes: names, otherCoordinatorPid: 1 });
  assert.ok(out.split('\n').length <= 25);
  assert.match(out, /and \d+ more/);
});

// Every temp dir made here is removed when the file finishes; worktrees first, so git's records go too.
const made = [];
after(() => {
  for (const d of made) {
    try {
      const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const l of list.split(/\r?\n/)) {
        if (l.startsWith('worktree ') && path.resolve(l.slice(9)) !== path.resolve(d)) {
          try { execFileSync('git', ['worktree', 'remove', '--force', l.slice(9)], { cwd: d, stdio: 'ignore' }); } catch { /* best effort */ }
        }
      }
    } catch { /* not a repo */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function teamRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'offlimits-tb-')));
  made.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@e.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.offlimits', 'team', 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.offlimits', 'team', 'board.json'), JSON.stringify({ lanes: { demo: lane('designing') } }));
  return dir;
}
function run(dir, env) {
  const e = { ...process.env, OFFLIMITS_ROLE: '', OFFLIMITS_LANE: '', OFFLIMITS_TEAM_LAUNCHER_PID: '', ...env };
  return spawnSync(process.execPath, [SESSION], { input: JSON.stringify({ cwd: dir }), env: e, cwd: dir, encoding: 'utf8' });
}

test('session prints worker banner in a team repo', () => {
  const r = run(teamRepo(), { OFFLIMITS_ROLE: 'worker', OFFLIMITS_LANE: 'demo' });
  assert.match(r.stdout, /You are worker demo/);
  assert.match(r.stdout, /Stage: designing/);
  assert.match(r.stdout, /team CLI: node ".*team\.mjs"/);
});

test('coordinator warns on a live foreign pid, not on the launcher pid', () => {
  const dir = teamRepo();
  fs.writeFileSync(path.join(dir, '.offlimits', 'team', 'coordinator.json'), JSON.stringify({ pid: process.pid }));
  assert.match(run(dir, { OFFLIMITS_ROLE: 'coordinator' }).stdout, /another coordinator is running \(pid \d+\)/);
  assert.doesNotMatch(run(dir, { OFFLIMITS_ROLE: 'coordinator', OFFLIMITS_TEAM_LAUNCHER_PID: String(process.pid) }).stdout, /another coordinator/);
});

test('no team dir means no team section', () => {
  const dir = teamRepo();
  fs.rmSync(path.join(dir, '.offlimits'), { recursive: true });
  assert.doesNotMatch(run(dir, { OFFLIMITS_ROLE: 'worker', OFFLIMITS_LANE: 'demo' }).stdout, /worker demo|team CLI/);
});

test('a worker by defaultRole with no lane gets the solo team lines', () => {
  const out = teamBanner({ ...base, role: 'worker', lane: null, viaDefault: true });
  assert.doesNotMatch(out, /worker without a lane/);
  assert.match(out, /^This is a team repo\. Start the coordinator from a terminal with: team coordinator$/m);
  assert.match(out, /^team CLI: node /m);
  assert.match(teamBanner({ ...base, role: 'worker', lane: null, viaDefault: false }), /worker without a lane/);
});

test('the human\'s plain claude session in an init-ed repo shows the solo team line', () => {
  const dir = teamRepo();
  fs.writeFileSync(path.join(dir, 'offlimits.json'), JSON.stringify({ defaultRole: 'worker', team: {} }));
  const r = run(dir, {});
  assert.match(r.stdout, /This is a team repo\. Start the coordinator from a terminal with: team coordinator/);
  assert.match(r.stdout, /team CLI: node ".*team\.mjs"/);
  assert.doesNotMatch(r.stdout, /worker without a lane/);
});
