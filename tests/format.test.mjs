import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denyMessage, askReason, banner, summarize } from '../hooks/lib/format.mjs';

const d = { action: 'deny', rule: 'git-push-protected', reason: 'Pushing to main is off limits.', summary: 'git push origin main' };

test('deny message has the four lines (worker)', () => {
  const lines = denyMessage(d, 'worker').split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'offlimits: blocked git push origin main');
  assert.equal(lines[1], 'rule: git-push-protected - Pushing to main is off limits.');
  assert.equal(lines[2], 'role: worker');
  assert.match(lines[3], /Commit your branch and hand over to the coordinator/);
});

test('deny message next step for solo', () => {
  assert.match(denyMessage(d, 'solo'), /OFFLIMITS_ROLE=coordinator/);
});

test('ask reason mentions /offlimits', () => {
  const r = askReason({ reason: 'Supabase write' });
  assert.match(r, /\/offlimits/);
  assert.match(r, /^offlimits: Supabase write\./);
});

test('summarize per tool', () => {
  assert.equal(summarize({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(100) } }).length, 80);
  assert.equal(summarize({ tool_name: 'mcp__a__b', tool_input: {} }), 'mcp__a__b');
  assert.equal(summarize({ tool_name: 'Write', tool_input: { file_path: 'a/b.txt' } }), 'a/b.txt');
  assert.equal(summarize(null), '');
});

test('banner warns for worker on protected branch', () => {
  const b = banner({
    role: 'worker', protectedBranches: ['main'], productionConfigured: false,
    blocks: 2, errors: 1, branch: 'main', policySource: 'default', problems: ['p1'],
  });
  assert.match(b, /WARNING/);
  assert.match(b, /protected branch/);
  assert.match(b, /hook errors/);
  assert.match(b, /p1/);
  assert.match(b, /\/offlimits/);
});

test('banner first line carries role, branches, production state and blocks', () => {
  const b = banner({
    role: 'solo', protectedBranches: ['main', 'master'], productionConfigured: true,
    blocks: 3, errors: 0, branch: 'feat/x', policySource: 'default', problems: [],
  });
  assert.equal(b.split('\n').length, 1);
  assert.match(b, /role: solo.*main, master.*production definition found.*3 blocked/);
});
