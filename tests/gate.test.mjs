import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'gate.mjs');

function tmpRepo(policy) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offlimits-gate-')));
  execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: dir });
  if (policy) fs.writeFileSync(path.join(dir, 'offlimits.json'), JSON.stringify(policy));
  return dir;
}

function run(dir, input, role) {
  const env = { ...process.env };
  delete env.OFFLIMITS_ROLE;
  if (role) env.OFFLIMITS_ROLE = role;
  const stdin = typeof input === 'string' ? input : JSON.stringify({ cwd: dir, hook_event_name: 'PreToolUse', ...input });
  return spawnSync(process.execPath, [GATE], { input: stdin, env, cwd: dir, encoding: 'utf8' });
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const logLines = (dir) => {
  const f = path.join(dir, '.offlimits', 'log.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('worker push to main is blocked', () => {
  const dir = tmpRepo();
  const r = run(dir, bash('git push origin main'), 'worker');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /rule: git-push-protected/);
  const log = logLines(dir);
  assert.equal(log.length, 1);
  assert.equal(log[0].decision, 'deny');
  assert.equal(log[0].role, 'worker');
});

test('worker npm test is allowed silently', () => {
  const r = run(tmpRepo(), bash('npm test'), 'worker');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('solo supabase write asks', () => {
  const dir = tmpRepo();
  const r = run(dir, { tool_name: 'mcp__supabase__execute_sql', tool_input: { query: 'insert into t values (1)' } });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(logLines(dir)[0].decision, 'ask');
});

test('coordinator push to main passes', () => {
  const r = run(tmpRepo(), bash('git push origin main'), 'coordinator');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('unparseable stdin with a role set blocks', () => {
  const r = run(tmpRepo(), 'not json', 'worker');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^offlimits: hook error, blocking because the role is worker/);
});

test('unparseable stdin for coordinator passes', () => {
  assert.equal(run(tmpRepo(), 'not json', 'coordinator').status, 0);
});

test('unparseable stdin solo passes and logs one error', () => {
  const dir = tmpRepo();
  const r = run(dir, 'not json');
  assert.equal(r.status, 0);
  const log = logLines(dir);
  assert.equal(log.length, 1);
  assert.equal(log[0].decision, 'error');
});

test('onError block makes solo fail closed', () => {
  const dir = tmpRepo({ onError: 'block' });
  const r = run(dir, 'not json');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /hook error/);
});

test('log is capped at 200 lines', () => {
  const dir = tmpRepo();
  for (let i = 0; i < 205; i++) {
    assert.equal(run(dir, bash('git push origin main'), 'worker').status, 2);
  }
  assert.equal(logLines(dir).length, 200);
});

test('array and tool_name-less input are malformed', () => {
  const dir = tmpRepo();
  assert.equal(run(dir, '[1,2]', 'worker').status, 2);
  assert.equal(run(dir, { tool_input: {} }, 'worker').status, 2);
  assert.equal(run(dir, { tool_input: {} }).status, 0);
  assert.equal(logLines(dir).filter((e) => e.decision === 'error').length, 3);
});

test('solo and coordinator onError block name the policy, worker keeps the role wording', () => {
  const dir = tmpRepo({ onError: 'block' });
  assert.match(run(dir, 'not json').stderr, /^offlimits: hook error, blocking because policy\.onError is block/);
  assert.match(run(dir, 'not json', 'worker').stderr, /^offlimits: hook error, blocking because the role is worker/);
  const c = run(dir, 'not json', 'coordinator');
  assert.equal(c.status, 2);
  assert.match(c.stderr, /^offlimits: hook error, blocking because policy.onError is block/);
});

test('ask reasons: production hint only for MCP asks without a production definition', () => {
  const sql = { tool_name: 'mcp__supabase__execute_sql', tool_input: { query: 'insert into t values (1)' } };
  const reason = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason(run(tmpRepo(), sql)), /No production definition in offlimits\.json/);
  const configured = reason(run(tmpRepo({ production: { projectRefs: ['prodref123'] } }), sql));
  assert.doesNotMatch(configured, /No production definition/);
  assert.match(configured, /This asks in solo mode and is denied for workers\. See \/offlimits\./);
  const shell = reason(run(tmpRepo(), bash('git clean -fdx')));
  assert.doesNotMatch(shell, /No production definition/);
  assert.match(shell, /This asks in solo mode and is denied for workers/);
});

test('worker hook error says the role is worker; solo error allows and logs', () => {
  const dir = tmpRepo();
  const w = run(dir, 'not json', 'worker');
  assert.equal(w.status, 2);
  assert.equal(w.stderr.split('\n')[0].startsWith('offlimits: hook error, blocking because the role is worker'), true);
  const s = run(dir, 'not json');
  assert.equal(s.status, 0);
  assert.equal(s.stderr, '');
});
