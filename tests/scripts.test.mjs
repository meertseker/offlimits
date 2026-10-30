import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The v0.2 PowerShell wrappers started sessions under names the team-launch rule did not know; `team` replaced them.
test('no launcher wrappers outside bin/team.mjs', () => {
  for (const n of ['worker.ps1', 'coordinator.ps1']) assert.ok(!fs.existsSync(path.join(ROOT, 'scripts', n)), `scripts/${n} must stay deleted`);
});
