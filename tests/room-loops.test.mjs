import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLoop, setLoop } from '../hooks/lib/room/loops.mjs';
import { RoomError } from '../hooks/lib/room/errors.mjs';

const NOW = Date.parse('2026-11-07T18:00:00Z');

function world({ status = '{"durum":"DURAKLATILDI","not":"x"}', log = true } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-loop-')));
  if (status !== null) fs.writeFileSync(path.join(dir, 'durum.json'), status);
  fs.writeFileSync(path.join(dir, 'features.json'), JSON.stringify([
    { id: 'A', title: 'a', passes: true }, { id: 'B', passes: true }, { id: 'C', passes: false, blocked: true }, { id: 'D', title: 'd', passes: false, blocked: false },
  ]));
  fs.writeFileSync(path.join(dir, 'DUR'), '');
  fs.writeFileSync(path.join(dir, 'BEKCI-DUR'), '');
  if (log) {
    fs.mkdirSync(path.join(dir, 'log'));
    fs.writeFileSync(path.join(dir, 'log', 'dongu.txt'), 'one\ntwo\n\nthree\nfour\n');
    fs.utimesSync(path.join(dir, 'log', 'dongu.txt'), new Date(NOW - 60_000), new Date(NOW - 60_000));
  }
  const cfg = {
    id: 'gece', name: 'Gece', dir,
    status: { file: 'durum.json', field: 'durum', run: 'DEVAM', pause: 'DURAKLATILDI' },
    stopFile: 'DUR', markers: ['BEKCI-DUR', 'BLOCKED.md'],
    tasks: { file: 'features.json', done: 'passes', blocked: 'blocked', id: 'id', title: 'title' },
    log: log ? 'log/dongu.txt' : null, liveMinutes: 30, startHint: '.dongu\\baslat.cmd',
  };
  return { dir, cfg, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('readLoop: status, note, markers, tasks and log freshness', () => {
  const w = world();
  try {
    const r = readLoop(w.cfg, { now: () => NOW });
    assert.equal(r.id, 'gece');
    assert.equal(r.status, 'DURAKLATILDI');
    assert.equal(r.note, 'x');
    assert.equal(r.paused, true);
    assert.equal(r.stopped, true);
    assert.deepEqual(r.markers.map((m) => m.name), ['DUR', 'BEKCI-DUR']);
    assert.deepEqual(r.tasks, { done: 2, total: 4, blocked: 1, next: { id: 'D', title: 'd' } });
    assert.equal(r.running, true);
    assert.deepEqual(r.logTail, ['two', 'three', 'four']);
    assert.equal(r.startHint, '.dongu\\baslat.cmd');
    fs.utimesSync(path.join(w.dir, 'log', 'dongu.txt'), new Date(NOW - 2 * 3600_000), new Date(NOW - 2 * 3600_000));
    assert.equal(readLoop(w.cfg, { now: () => NOW }).running, false);
  } finally { w.done(); }
});

test('readLoop without a log says running is unknown; a task list object is read too', () => {
  const w = world({ log: false });
  try {
    fs.writeFileSync(path.join(w.dir, 'features.json'), JSON.stringify({ features: [{ id: 'X', passes: true }] }));
    const r = readLoop(w.cfg, { now: () => NOW });
    assert.equal(r.running, null);
    assert.deepEqual(r.tasks, { done: 1, total: 1, blocked: 0, next: null });
  } finally { w.done(); }
});

test('resume: run value, other keys kept, stop marker removed, other markers kept, compact stays compact', () => {
  const w = world();
  try {
    const r = setLoop(w.cfg, 'resume', { now: () => NOW });
    assert.equal(fs.readFileSync(path.join(w.dir, 'durum.json'), 'utf8'), '{"durum":"DEVAM","not":"x"}');
    assert.ok(!fs.existsSync(path.join(w.dir, 'DUR')));
    assert.ok(fs.existsSync(path.join(w.dir, 'BEKCI-DUR')));
    assert.equal(r.status, 'DEVAM');
    assert.equal(r.paused, false);
    assert.equal(r.stopped, false);
  } finally { w.done(); }
});

test('pause: pause value and the stop marker; pretty JSON stays pretty', () => {
  const w = world({ status: '{\n  "durum": "DEVAM",\n  "not": "y"\n}\n' });
  try {
    fs.rmSync(path.join(w.dir, 'DUR'));
    setLoop(w.cfg, 'pause', { now: () => NOW });
    assert.equal(fs.readFileSync(path.join(w.dir, 'durum.json'), 'utf8'), '{\n  "durum": "DURAKLATILDI",\n  "not": "y"\n}\n');
    assert.ok(fs.existsSync(path.join(w.dir, 'DUR')));
  } finally { w.done(); }
});

test('a bad action is refused; a missing status file is created on resume', () => {
  const w = world({ status: null });
  try {
    assert.throws(() => setLoop(w.cfg, 'restart', { now: () => NOW }), (e) => e instanceof RoomError && e.status === 400 && e.code === 'bad-action');
    setLoop(w.cfg, 'resume', { now: () => NOW });
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'durum.json'), 'utf8')).durum, 'DEVAM');
  } finally { w.done(); }
});

test('a status file that is not an object is refused, not replaced', () => {
  const w = world({ status: '[1,2]' });
  try {
    assert.throws(() => setLoop(w.cfg, 'resume', { now: () => NOW }), (e) => e instanceof RoomError && e.status === 409);
    assert.equal(fs.readFileSync(path.join(w.dir, 'durum.json'), 'utf8'), '[1,2]');
  } finally { w.done(); }
});

test('paths that leave the loop folder are not used', () => {
  const w = world();
  try {
    const cfg = { ...w.cfg, stopFile: '../escape', log: '../../x.log', tasks: { ...w.cfg.tasks, file: '../f.json' } };
    const r = readLoop(cfg, { now: () => NOW });
    assert.equal(r.stopped, false);
    assert.equal(r.running, null);
    assert.equal(r.tasks, null);
    assert.ok(r.error && /outside/.test(r.error));
    setLoop(cfg, 'pause', { now: () => NOW });
    assert.ok(!fs.existsSync(path.join(w.dir, '..', 'escape')));
  } finally { w.done(); }
});
