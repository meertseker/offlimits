import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = (name) => path.join(ROOT, 'hooks', name);
const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', ...opts });

test('self-test --json passes every fixture through the real gate', () => {
  const r = node([script('selftest.mjs'), '--json'], { cwd: ROOT });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const results = JSON.parse(r.stdout);
  assert.ok(results.length >= 100);
  for (const x of results) assert.equal(x.ok, true, `${x.name}: expected ${x.expect} got ${x.got}`);
});

test('self-test table prints a summary line', () => {
  const r = node([script('selftest.mjs')], { cwd: ROOT });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ blocked/);
  assert.match(r.stdout, /\d+\/\d+ passed/);
});

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offlimits-st-')));
  execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: dir });
  return dir;
}

test('explain prints a deny decision', () => {
  const r = node([script('explain.mjs'), '--', 'git', 'push', 'origin', 'main'], { cwd: repo() });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^DECISION: deny \(git-push-protected\) — /);
});

test('explain prints allow', () => {
  const r = node([script('explain.mjs'), '--', 'ls', '-la'], { cwd: repo() });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'DECISION: allow');
});

test('explain honours OFFLIMITS_ROLE', () => {
  const dir = repo();
  const env = { ...process.env, OFFLIMITS_ROLE: 'worker' };
  const r = node([script('explain.mjs'), '--', 'git push origin feat/x'], { cwd: dir, env });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^DECISION: /);
});

test('status reports role, policy, branches, production and rules', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'offlimits.json'), JSON.stringify({ protectedBranches: ['release'], bogus: 1 }));
  const env = { ...process.env, OFFLIMITS_ROLE: 'worker' };
  const r = node([script('status.mjs')], { cwd: dir, env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /role: worker/);
  assert.match(r.stdout, /offlimits\.json/);
  assert.match(r.stdout, /unknown key "bogus"/);
  assert.match(r.stdout, /protected branches: release/);
  assert.match(r.stdout, /not configured: MCP writes ask/);
  assert.match(r.stdout, /git-push-protected/);
  assert.match(r.stdout, /last log lines/i);
});

test('status shows recent log entries', () => {
  const dir = repo();
  const env = { ...process.env, OFFLIMITS_ROLE: 'worker' };
  const input = { cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' } };
  node([script('gate.mjs')], { cwd: dir, env, input: JSON.stringify(input) });
  const r = node([script('status.mjs')], { cwd: dir, env });
  assert.match(r.stdout, /deny/);
  assert.match(r.stdout, /git-push-protected/);
});
