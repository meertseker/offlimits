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
const pwsh = (file, args, cwd = ROOT) => spawnSync('pwsh', ['-NoProfile', '-File', file, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '' } });

test('wrappers only delegate to bin/team.mjs', () => {
  for (const [file, cmd] of [['worker.ps1', 'worker'], ['coordinator.ps1', 'coordinator']]) {
    const s = read(file);
    assert.ok(!s.includes('Invoke-Expression'), 'no Invoke-Expression');
    assert.ok(s.includes(`node "$PSScriptRoot/../bin/team.mjs" ${cmd} @args`), file);
    assert.ok(s.includes('exit $LASTEXITCODE'), file);
    assert.ok(!/claudes/.test(s.replace(/^#.*$/gm, '')), 'wrapper must not start claude itself');
  }
});

test('worker.ps1 passes arguments through and validates the lane', { skip: !hasPwsh && 'pwsh not installed' }, () => {
  const r = pwsh(script('worker.ps1'), ['Bad_Lane', '--brief', 'x.md']);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /lane name must match/);
});

test('coordinator.ps1 fails clearly outside a git repository', { skip: !hasPwsh && 'pwsh not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offlimits-nonrepo-'));
  const r = pwsh(script('coordinator.ps1'), ['--print'], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /not inside a git repository/);
});
