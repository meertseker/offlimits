import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'session.mjs');

function tmpRepo(branch) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offlimits-sess-')));
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir });
  // An unborn branch has no HEAD yet, so give it one commit.
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dir },
  );
  return dir;
}

function run(dir, role) {
  const env = { ...process.env };
  delete env.OFFLIMITS_ROLE;
  if (role) env.OFFLIMITS_ROLE = role;
  return spawnSync(process.execPath, [SESSION], {
    input: JSON.stringify({ cwd: dir, hook_event_name: 'SessionStart' }),
    env,
    cwd: dir,
    encoding: 'utf8',
  });
}

test('worker on main gets a warning', () => {
  const r = run(tmpRepo('main'), 'worker');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /WARNING/);
  assert.match(r.stdout, /protected branch/);
});

test('solo with no log and no production definition', () => {
  const r = run(tmpRepo('feat/x'));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /role: solo/);
  assert.match(r.stdout, /MCP writes will ask/);
});

test('log with errors is reported', () => {
  const dir = tmpRepo('feat/x');
  fs.mkdirSync(path.join(dir, '.offlimits'));
  fs.writeFileSync(
    path.join(dir, '.offlimits', 'log.jsonl'),
    JSON.stringify({ at: 'x', role: 'solo', tool: 'Bash', decision: 'error', rule: '', summary: 'boom' }) + '\n',
  );
  assert.match(run(dir).stdout, /hook errors/);
});

test('banner says why the role is worker when it comes from defaultRole', () => {
  const dir = tmpRepo('feat/x');
  fs.writeFileSync(path.join(dir, 'offlimits.json'), JSON.stringify({ defaultRole: 'worker' }));
  const r = run(dir);
  assert.match(r.stdout, /role: worker \(defaultRole\)/);
});

test('banner shows a plain worker role for the env variable', () => {
  const dir = tmpRepo('feat/x');
  fs.writeFileSync(path.join(dir, 'offlimits.json'), JSON.stringify({ defaultRole: 'worker' }));
  const r = run(dir, 'worker');
  assert.match(r.stdout, /role: worker;/);
  assert.doesNotMatch(r.stdout, /defaultRole/);
});

test('banner warns when an unreadable policy forces worker', () => {
  const dir = tmpRepo('feat/x');
  fs.writeFileSync(path.join(dir, 'offlimits.json'), '{"defaultRole":');
  const r = run(dir);
  assert.match(r.stdout, /role: worker \(defaultRole\)/);
  assert.match(r.stdout, /WARNING: offlimits\.json: invalid JSON/);
  assert.match(r.stdout, /defaultRole falls back to worker until offlimits\.json is fixed/);
});
