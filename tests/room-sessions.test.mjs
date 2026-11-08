import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeProjectDir, readHistory, readSessionTail, readSessions } from '../hooks/lib/room/sessions.mjs';

const MIN = 60_000;
const NOW = Date.now();
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const L = {
  assistant: (msAgo, stop, extra = {}) => ({ type: 'assistant', timestamp: at(msAgo), gitBranch: 'feat/x', cwd: 'c', message: { model: 'claude-opus-5-5', stop_reason: stop, content: [{ type: stop === 'tool_use' ? 'tool_use' : 'text', text: 't' }] }, ...extra }),
  synthetic: (msAgo, text) => ({ type: 'assistant', timestamp: at(msAgo), message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] } }),
  prompt: (msAgo, text) => ({ type: 'user', timestamp: at(msAgo), message: { role: 'user', content: text } }),
  result: (msAgo) => ({ type: 'user', timestamp: at(msAgo), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
  title: (t) => ({ type: 'ai-title', aiTitle: t }),
  last: (t) => ({ type: 'last-prompt', lastPrompt: t }),
  away: (msAgo, t) => ({ type: 'system', subtype: 'away_summary', content: t, timestamp: at(msAgo) }),
  turn: (msAgo) => ({ type: 'system', subtype: 'turn_duration', timestamp: at(msAgo) }),
};
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

test('encodeProjectDir turns every character outside A-Z, a-z, 0-9 and - into -', () => {
  assert.equal(encodeProjectDir('C:\\Users\\me\\Desktop\\a-b'), 'C--Users-me-Desktop-a-b');
  assert.equal(encodeProjectDir('/home/me/x'), '-home-me-x');
  assert.equal(encodeProjectDir('C:\\Users\\me\\Desktop\\Bahce Sulama Projesi'), 'C--Users-me-Desktop-Bahce-Sulama-Projesi');
  assert.equal(encodeProjectDir('C:\\x\\şube_1.2'), 'C--x--ube-1-2');
});

function world() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cc-')));
  const dirA = 'C:\\Work\\Bahce Sulama Projesi';
  const dirB = 'C:\\Work\\şube-gece';
  const pa = path.join(root, 'projects', encodeProjectDir(dirA));
  const pb = path.join(root, 'projects', encodeProjectDir(dirB));
  fs.mkdirSync(pa, { recursive: true });
  fs.mkdirSync(pb, { recursive: true });
  fs.writeFileSync(path.join(pa, 'aaaaaaaa-0001.jsonl'), jsonl([
    L.title('Koordinasyon defteri'), L.prompt(40 * MIN, 'durum ne'), L.last('durum ne'), L.assistant(39 * MIN, 'tool_use'), L.result(39 * MIN),
    L.assistant(38 * MIN, 'end_turn'), L.turn(38 * MIN), L.away(35 * MIN, 'Koordine ediyorum; yayın bekliyor. (disable recaps in /config)'),
  ]));
  fs.writeFileSync(path.join(pa, 'bbbbbbbb-0002.jsonl'), jsonl([L.prompt(10 * MIN, 'build it'), L.assistant(5 * MIN, 'tool_use'), L.result(5 * MIN)]));
  fs.writeFileSync(path.join(pa, 'ffffffff-0006.jsonl'), jsonl([L.prompt(9 * MIN, 'q'), L.assistant(8 * MIN, 'end_turn')]));
  fs.writeFileSync(path.join(pa, 'cccccccc-0003.jsonl'), jsonl([L.prompt(30 * MIN, 'go'), L.assistant(20 * MIN, 'tool_use'), L.result(20 * MIN)]));
  fs.writeFileSync(path.join(pa, 'dddddddd-0004.jsonl'), jsonl([L.prompt(5 * 60 * MIN, 'old'), L.assistant(4 * 60 * MIN, 'tool_use'), L.result(4 * 60 * MIN)]));
  fs.writeFileSync(path.join(pb, 'eeeeeeee-0005.jsonl'), jsonl([
    L.prompt(70 * MIN, 'x'), L.synthetic(60 * MIN, "You've hit your weekly limit · resets 2pm (Europe/London)"), L.prompt(50 * MIN, 'again'), L.synthetic(49 * MIN, 'No response requested.'),
  ]));
  fs.writeFileSync(path.join(pb, 'notes.txt'), 'x');
  return { root, dirA, dirB, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('readSessionTail: title, last prompt, summary, ended turn', () => {
  const w = world();
  try {
    const t = readSessionTail(path.join(w.root, 'projects', encodeProjectDir(w.dirA), 'aaaaaaaa-0001.jsonl'));
    assert.equal(t.id, 'aaaaaaaa-0001');
    assert.equal(t.title, 'Koordinasyon defteri');
    assert.equal(t.lastPrompt, 'durum ne');
    assert.equal(t.summary, 'Koordine ediyorum; yayın bekliyor.');
    assert.equal(t.ended, true);
    assert.equal(t.model, 'claude-opus-5-5');
    assert.equal(t.branch, 'feat/x');
    assert.equal(t.lastTs, at(38 * MIN));
  } finally { w.done(); }
});

test('readSessions: waiting, working, stalled, quiet; coordinator label; newest limit notice', () => {
  const w = world();
  try {
    const r = readSessions(w.root, [{ dir: w.dirA, project: 'p', lane: null }, { dir: w.dirB, project: 'p', lane: 'gece' }], {
      now: () => NOW, liveMinutes: 30, coordinatorIds: ['aaaaaaaa-0001'],
    });
    const by = Object.fromEntries(r.sessions.map((s) => [s.shortId, s]));
    assert.equal(by.aaaaaaaa.state, 'waiting');
    assert.equal(by.aaaaaaaa.role, 'coordinator');
    assert.equal(by.aaaaaaaa.summary, 'Koordine ediyorum; yayın bekliyor.');
    assert.equal(by.bbbbbbbb.state, 'working');
    assert.equal(by.bbbbbbbb.stalled, false);
    assert.equal(by.bbbbbbbb.role, 'main');
    assert.equal(by.cccccccc.state, 'working');
    assert.equal(by.cccccccc.stalled, true);
    assert.equal(by.dddddddd.state, 'quiet');
    assert.equal(by.eeeeeeee.lane, 'gece');
    assert.equal(by.eeeeeeee.role, 'lane');
    assert.equal(by.eeeeeeee.state, 'waiting');
    assert.deepEqual(r.sessions.map((s) => s.shortId), ['aaaaaaaa', 'ffffffff', 'eeeeeeee', 'bbbbbbbb', 'cccccccc', 'dddddddd'], 'waiting first (coordinator first), then working and quiet; newest first within each');
    assert.deepEqual(r.limitNotice, { ts: at(60 * MIN), text: "You've hit your weekly limit · resets 2pm (Europe/London)", project: 'p' });
  } finally { w.done(); }
});

test('readSessions matches folder names case-insensitively on Windows only', () => {
  const w = world();
  try {
    const lower = [{ dir: w.dirA.toLowerCase(), project: 'p', lane: null }];
    assert.equal(readSessions(w.root, lower, { now: () => NOW, liveMinutes: 30, coordinatorIds: [], platform: 'win32' }).sessions.length, 5);
    assert.equal(readSessions(w.root, lower, { now: () => NOW, liveMinutes: 30, coordinatorIds: [], platform: 'linux' }).sessions.length, 0);
    assert.deepEqual(readSessions(path.join(w.root, 'missing'), lower, { now: () => NOW, liveMinutes: 30, coordinatorIds: [] }).sessions, []);
  } finally { w.done(); }
});

test('readSessionTail reads at most the last 256 KiB of a big transcript', () => {
  const w = world();
  try {
    const file = path.join(w.root, 'big.jsonl');
    const head = jsonl([L.last('from the far beginning')]);
    const filler = `${JSON.stringify({ type: 'progress', data: 'x'.repeat(900) })}\n`.repeat(5500);
    fs.writeFileSync(file, head + filler + jsonl([L.assistant(MIN, 'end_turn')]));
    assert.ok(fs.statSync(file).size > 5_000_000);
    const t0 = Date.now();
    const t = readSessionTail(file);
    assert.ok(Date.now() - t0 < 1500, 'tail read is fast');
    assert.equal(t.lastPrompt, null);
    assert.equal(t.ended, true);
  } finally { w.done(); }
});

test('readHistory: per day and per project for 14 days, slash commands skipped, orchestration share by week', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-hist-')));
  // local noon, so "hours ago" never crosses midnight
  const NOW = new Date(2026, 10, 7, 12, 0, 0).getTime();
  try {
    const DAY = 86_400_000;
    const rows = [
      { display: 'durum ne', timestamp: NOW - 1 * 60 * MIN, project: 'C:\\Work\\Shop' },
      { display: 'build the cart', timestamp: NOW - 2 * 60 * MIN, project: 'C:\\Work\\Shop-cart' },
      { display: 'onay veriyorum', timestamp: NOW - 3 * 60 * MIN, project: 'c:\\work\\shop' },
      { display: '/model', timestamp: NOW - 60 * MIN, project: 'C:\\Work\\Shop' },
      { display: 'other project', timestamp: NOW - 60 * MIN, project: 'C:\\Elsewhere' },
      { display: 'durum?', timestamp: NOW - 9 * DAY, project: 'C:\\Work\\Shop' },
      { display: 'too old', timestamp: NOW - 20 * DAY, project: 'C:\\Work\\Shop' },
    ];
    fs.writeFileSync(path.join(root, 'history.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\nnot json\n`);
    const h = readHistory(root, [{ id: 'shop', dirs: ['C:\\Work\\Shop', 'C:\\Work\\Shop-cart'] }], {
      now: () => NOW, days: 14, patterns: ['durum', 'onay'], platform: 'win32',
    });
    assert.equal(h.days.length, 14);
    assert.equal(h.days.at(-1).total, 4);
    assert.equal(h.days.at(-1).byProject.shop, 3);
    assert.equal(h.days.at(-1).byProject.other, 1);
    assert.deepEqual(h.byProject, { shop: 4, other: 1 });
    assert.deepEqual(h.thisWeek, { prompts: 4, orchestration: 0.5 });
    assert.deepEqual(h.lastWeek, { prompts: 1, orchestration: 1 });
    const none = readHistory(root, [], { now: () => NOW, days: 14, patterns: [] });
    assert.equal(none.thisWeek.orchestration, null);
    assert.equal(readHistory(path.join(root, 'missing'), [], { now: () => NOW }), null, 'no history file means no data');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
