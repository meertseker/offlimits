import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLog } from '../hooks/lib/log.mjs';

test('appendLog does not create a missing root tree', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'offlimits-log-'));
  const bogus = path.join(base, 'no', 'such', 'root');
  appendLog(bogus, { decision: 'deny' });
  assert.equal(fs.existsSync(path.join(base, 'no')), false);
});
