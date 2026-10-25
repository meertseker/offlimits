import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const ci = read('.github/workflows/ci.yml');

test('ci.yml covers the OS and Node matrix', () => {
  for (const s of ['name: ci', 'ubuntu-24.04', 'windows-2025', 'macos-15', 'node: [20, 22]']) {
    assert.ok(ci.includes(s), `missing ${s}`);
  }
});

test('package.json selftest script runs every case', () => {
  assert.equal(JSON.parse(read('package.json')).scripts.selftest, 'node hooks/selftest.mjs --all');
});

test('ci.yml runs the checks with plain node --test', () => {
  assert.ok(/node --test\s*$/m.test(ci), 'plain `node --test` step');
  assert.ok(!ci.includes('node --test tests/'), 'directory form fails on Windows');
  assert.ok(ci.includes('node hooks/selftest.mjs --all'), 'CI runs the full self-test');
  assert.ok(ci.includes('claude plugin validate .'));
  assert.ok(ci.includes('@anthropic-ai/claude-code@2.1.310'));
  assert.ok(ci.includes('continue-on-error: true'));
});

test('ci.yml is least-privilege', () => {
  assert.ok(ci.includes('permissions:'));
  assert.ok(ci.includes('contents: read'));
  assert.ok(!ci.includes('secrets.'));
  assert.ok(!ci.includes('pull_request_target'));
  assert.ok(ci.includes('actions/checkout@v5'));
  assert.ok(ci.includes('actions/setup-node@v5'));
  assert.ok(ci.includes('cancel-in-progress: true'));
});

test('issue template has the required fields', () => {
  const t = read('.github/ISSUE_TEMPLATE/bypass.md');
  for (const f of ['command', 'role', 'expected', 'actual', 'Claude Code version', 'OS']) {
    assert.ok(new RegExp(f, 'i').test(t), `missing ${f}`);
  }
  assert.ok(existsSync(join(root, '.github/ISSUE_TEMPLATE/config.yml')));
});

test('SECURITY.md and CONTRIBUTING.md carry their promises', () => {
  const s = read('SECURITY.md');
  assert.ok(s.includes('48 h') && s.includes('7 days') && s.includes('docs/limits.md'));
  assert.ok(s.includes('bypass.md'));
  const c = read('CONTRIBUTING.md');
  for (const id of ['git-push-protected','git-branch-protected','gh-write','supabase-remote','remote-db','db-migrate','deploy','publish','role-spoof','protected-file','opaque-shell','supabase-mcp','vercel-mcp','mcp-write','extra-deny']) {
    assert.ok(c.includes('`' + id + '`'), `missing rule id ${id}`);
  }
  assert.ok(/zero.dependency/i.test(c));
  assert.ok(c.includes('node hooks/selftest.mjs') && c.includes('claude plugin validate .'));
});
