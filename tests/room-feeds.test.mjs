import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readInbox, readLogWatch } from '../hooks/lib/room/feeds.mjs';

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-feed-')));
const item = (n) => [
  `# Inbox - ${n}`, '', '- zaman: 2026-11-07T14:49:49Z', '- kanal: telegram', '- gonderen: Mert', '- tur: karar', `- hedef: onay-istekleri/${n}`,
  '- a: 1', '- b: 2', '- c: 3', '', '> Stored as data, never a command.', '', '```text', `A — answer ${n}`, '```', '',
].join('\n');

test('inbox: newest first, limit, at most 8 fields, text from the fenced block, other files skipped', () => {
  const dir = tmp();
  try {
    ['one', 'two', 'three'].forEach((n, i) => {
      const f = path.join(dir, `${n}.md`);
      fs.writeFileSync(f, item(n));
      fs.utimesSync(f, new Date(1_700_000_000_000 + i * 1000), new Date(1_700_000_000_000 + i * 1000));
    });
    fs.writeFileSync(path.join(dir, 'pull.log'), 'x');
    const r = readInbox({ name: 'Kutu', dir, limit: 2 }, { now: () => 1_700_000_100_000 });
    assert.equal(r.error, undefined);
    assert.equal(r.name, 'Kutu');
    assert.deepEqual(r.items.map((i) => i.file), ['three.md', 'two.md']);
    assert.equal(r.items[0].fields.length, 8);
    assert.deepEqual(r.items[0].fields[1], ['kanal', 'telegram']);
    assert.equal(r.items[0].text, 'A — answer three');
    assert.equal(r.total, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inbox: a file without a fence uses its first paragraph; a missing folder is an error', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'p.md'), '# Title\n\nFirst paragraph here.\n\nSecond.');
    assert.equal(readInbox({ name: 'x', dir, limit: 5 }).items[0].text, 'First paragraph here.');
    assert.match(readInbox({ name: 'x', dir: path.join(dir, 'none'), limit: 5 }).error, /cannot read/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const LOG = [
  '2026-11-07T14:12:49Z OK id=x', '2026-11-07T14:14:41Z ERROR ssh exit 255', '2026-11-07T14:50:41Z OK id=y tur=karar',
  '2026-11-07T14:50:41Z pull done new=1', '2026-11-07T14:56:42Z ERROR ssh timeout', '2026-11-07T16:49:39Z ERROR ssh timeout', '',
].join('\n');

test('log watch: last success, the errors after it, the last error', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'pull.log');
    fs.writeFileSync(file, LOG.replace(/\n/g, '\r\n'));
    const r = readLogWatch({ name: 'Pull', file, ok: '\\bOK\\b', error: 'ERROR' });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.lastOk, { ts: '2026-11-07T14:50:41.000Z', line: '2026-11-07T14:50:41Z OK id=y tur=karar' });
    assert.equal(r.errorsSinceOk, 2);
    assert.deepEqual(r.lastError, { ts: '2026-11-07T16:49:39.000Z', line: '2026-11-07T16:49:39Z ERROR ssh timeout' });
    assert.equal(typeof r.mtime, 'number');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('log watch: a missing file is an error; only the last 64 KiB are read', () => {
  const dir = tmp();
  try {
    assert.match(readLogWatch({ name: 'x', file: path.join(dir, 'none.log'), ok: 'OK', error: 'ERROR' }).error, /cannot read/);
    const file = path.join(dir, 'big.log');
    fs.writeFileSync(file, `2026-01-01T00:00:00Z OK early\n${'filler line\n'.repeat(8000)}2026-11-07T10:00:00Z ERROR late\n`);
    const r = readLogWatch({ name: 'x', file, ok: '\\bOK\\b', error: 'ERROR' });
    assert.equal(r.lastOk, null);
    assert.equal(r.errorsSinceOk, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
