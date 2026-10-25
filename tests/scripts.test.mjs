import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = (n) => path.join(ROOT, 'scripts', n);
const read = (n) => fs.readFileSync(script(n), 'utf8');
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
const pwsh = (file, args, cwd = ROOT) => spawnSync('pwsh', ['-NoProfile', '-File', file, ...args], { cwd, encoding: 'utf8' });

test('worker.ps1 calls git directly and validates -Base', () => {
  const s = read('worker.ps1');
  assert.ok(!s.includes('Invoke-Expression'), 'no Invoke-Expression');
  assert.ok(s.includes('& git @GitArgs'));
  assert.ok(s.includes(String.raw`'^[\w./-]+$'`));
});

test('worker.ps1 dry run and -Base validation', { skip: !hasPwsh && 'pwsh not installed' }, () => {
  const ok = pwsh(script('worker.ps1'), ['-Lane', 'test-lane', '-DryRun', '-NoLaunch']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /\[dry-run\] git worktree add -b feat\/test-lane \.\.\/offlimits-test-lane origin\/main/);
  const bad = pwsh(script('worker.ps1'), ['-Lane', 'test-lane', '-Base', 'x;Remove-Item y', '-DryRun']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /Invalid base/);
  const dash = pwsh(script('worker.ps1'), ['-Lane', 'test-lane', '-Base', '--upload-pack=x', '-DryRun']);
  assert.notEqual(dash.status, 0);
});

test('coordinator.ps1 fails clearly outside a git repository', { skip: !hasPwsh && 'pwsh not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offlimits-nonrepo-'));
  const r = pwsh(script('coordinator.ps1'), ['-DryRun'], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /Not inside a git repository/);
});
