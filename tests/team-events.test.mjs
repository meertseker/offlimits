import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EVENT_TYPES, TYPE_RE, appendEvent, eventsFile, makeEvent, parseChecks, readEvents } from '../hooks/lib/team/events.mjs';

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ev-')));

test('makeEvent fills v and ts', () => {
  assert.deepEqual(makeEvent({ type: 'note' }, () => 0), { v: 1, ts: '1970-01-01T00:00:00.000Z', type: 'note' });
});

test('makeEvent keeps every known field and lower-cases the sha', () => {
  const e = makeEvent({
    type: 'lane.delivered', project: 'shop', lane: 'cart', actor: 'worker', run: 'r1', model: 'sonnet', sha: 'ABC1234',
    tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 }, costUsd: 0.5, checks: [{ name: 'tests', ok: true }],
    verdict: 'pass', defects: 0, intervention: 'none', note: 'n', data: { k: 1 },
  }, () => 0);
  assert.equal(e.sha, 'abc1234');
  assert.deepEqual(e.tokens, { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 });
  assert.deepEqual(e.checks, [{ name: 'tests', ok: true }]);
  assert.deepEqual(e.data, { k: 1 });
  assert.equal(e.costUsd, 0.5);
});

test('makeEvent rejects bad input', () => {
  const bad = [
    { type: 'Lane.x' }, { type: 'a..b' }, { type: '' }, {}, { type: 'note', bogus: 1 }, { type: 'note', sha: 'zz' },
    { type: 'note', data: { x: 'y'.repeat(3000) } }, { type: 'note', data: [1] }, { type: 'note', checks: [{ name: 't' }] },
    { type: 'note', defects: -1 }, { type: 'note', defects: 1.5 }, { type: 'note', costUsd: Number.NaN },
    { type: 'note', tokens: { in: -1 } }, { type: 'note', tokens: { bogus: 1 } }, { type: 'note', lane: 'x'.repeat(121) },
    { type: 'note', checks: Array.from({ length: 33 }, () => ({ name: 't', ok: true })) },
  ];
  for (const b of bad) assert.throws(() => makeEvent(b), /invalid event/, JSON.stringify(b).slice(0, 80));
});

test('makeEvent cuts a long note to 500 characters and replaces control characters', () => {
  const e = makeEvent({ type: 'note', note: `a\u0007b\nc${'x'.repeat(600)}` });
  assert.equal(e.note.length, 500);
  assert.ok(e.note.startsWith('a b c'));
});

test('appendEvent creates the folder; readEvents keeps order, skips bad lines, filters and limits', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'nested', 'events.jsonl');
    appendEvent(file, { type: 'note', note: 'one' }, { now: () => 1000 });
    appendEvent(file, { type: 'note', note: 'two' }, { now: () => 2000 });
    fs.appendFileSync(file, '{not json\n\n');
    appendEvent(file, { type: 'note', note: 'three' }, { now: () => 3000 });
    assert.deepEqual(readEvents(file).map((e) => e.note), ['one', 'two', 'three']);
    assert.deepEqual(readEvents(file, { sinceMs: 2000 }).map((e) => e.note), ['two', 'three']);
    assert.deepEqual(readEvents(file, { limit: 2 }).map((e) => e.note), ['two', 'three']);
    assert.deepEqual(readEvents(path.join(dir, 'missing.jsonl')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parseChecks reads English and Turkish check lines', () => {
  assert.deepEqual(parseChecks('lane: x\nchecks: tests ✓ selftest ✓ validate ✗\n'), [
    { name: 'tests', ok: true }, { name: 'selftest', ok: true }, { name: 'validate', ok: false },
  ]);
  const tr = parseChecks('dal: feat/x\r\nkontroller: lint ✓ typecheck ✓ test ✓ web build ✓ panel build ✓\r\n');
  assert.equal(tr.length, 5);
  assert.deepEqual(tr[3], { name: 'web build', ok: true });
  assert.deepEqual(parseChecks('kontroller: vitest ✓ (1280 geçti, 107 dosya) · build ✓ · deploy RESULT=OK'), [
    { name: 'vitest', ok: true }, { name: 'build', ok: true },
  ]);
  assert.deepEqual(parseChecks('no checks here'), []);
});

test('eventsFile and the known types', () => {
  assert.equal(eventsFile(path.join('a', 'team')), path.join('a', 'team', 'events.jsonl'));
  for (const t of ['lane.briefed', 'lane.merged', 'approval.answered', 'loop.paused', 'deploy', 'review']) assert.ok(EVENT_TYPES.includes(t), t);
  for (const t of EVENT_TYPES) assert.ok(TYPE_RE.test(t), t);
  assert.ok(!TYPE_RE.test('Loop'));
});
