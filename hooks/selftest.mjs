#!/usr/bin/env node
// Feeds every fixture (tests/fixtures/*.json) through the REAL hooks/gate.mjs in temp git repos.
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, 'gate.mjs');
const FIXTURES = path.join(HERE, '..', 'tests', 'fixtures');
const json = process.argv.includes('--json');
const DEFAULT_BRANCH = 'feat/selftest';

function loadCases() {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
  return files.flatMap((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8')));
}

function initRepo(dir, branch) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', timeout: 10000 });
  git('init', '-q', '-b', branch || DEFAULT_BRANCH);
  git('-c', 'user.email=selftest@offlimits.invalid', '-c', 'user.name=selftest', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (branch === '') git('checkout', '-q', '--detach'); // empty branch means detached HEAD
}

function main(base) {
  const repos = new Map();

  // One temp repo per distinct branch/policy pair, with a sibling ../other on the same branch.
  function repoFor(branch, policy) {
    const key = JSON.stringify([branch, policy ?? null]);
    if (repos.has(key)) return repos.get(key);
    const holder = fs.realpathSync(fs.mkdtempSync(path.join(base, 'case-')));
    const dir = path.join(holder, 'repo');
    initRepo(dir, branch);
    initRepo(path.join(holder, 'other'), branch);
    if (policy) fs.writeFileSync(path.join(dir, 'offlimits.json'), JSON.stringify(policy));
    repos.set(key, dir);
    return dir;
  }

  function run(c) {
    const dir = repoFor(c.branch ?? DEFAULT_BRANCH, c.policy);
    const env = { ...process.env };
    delete env.OFFLIMITS_ROLE;
    if (c.role && c.role !== 'solo') env.OFFLIMITS_ROLE = c.role;
    const stdin = JSON.stringify({
      session_id: 'selftest',
      cwd: dir,
      hook_event_name: 'PreToolUse',
      tool_name: c.tool_name,
      tool_input: c.tool_input,
    });
    const r = spawnSync(process.execPath, [GATE], { input: stdin, env, cwd: dir, encoding: 'utf8', timeout: 10000 });
    if (r.error) return `error ${r.error.code ?? r.error.message}`;
    if (r.status === 2) return 'deny';
    if (r.status === 0) {
      if (!r.stdout.trim()) return 'allow';
      try {
        return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === 'ask' ? 'ask' : 'unexpected';
      } catch {
        return 'unexpected';
      }
    }
    return `exit ${r.status}`;
  }

  return loadCases().map((c) => {
    const got = run(c);
    return { name: c.name, expect: c.expect, got, ok: got === c.expect };
  });
}

let results = [];
let crash = null;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'offlimits-selftest-'));
try {
  results = main(base);
} catch (err) {
  crash = err instanceof Error ? err.message : String(err);
} finally {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const failed = results.filter((r) => !r.ok);
if (json) {
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
} else {
  const label = { deny: 'blocked', ask: 'asked', allow: 'allowed' };
  for (const r of results) {
    console.log(
      r.ok
        ? `✓ ${(label[r.got] ?? r.got).padEnd(7)} ${r.name}`
        : `✗ MISMATCH ${r.name}: expected ${r.expect} got ${r.got}`,
    );
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} MISMATCH` : ''}`);
}
if (crash) process.stderr.write(`offlimits self-test failed: ${crash}\n`);
process.exitCode = failed.length || crash ? 1 : 0;
