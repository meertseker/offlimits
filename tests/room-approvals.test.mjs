import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answerLine, answerRequest, listRequests, parseRequest } from '../hooks/lib/room/approvals.mjs';
import { RoomError } from '../hooks/lib/room/errors.mjs';

const TR_OPEN = [
  'id: 0711-150000', 'tarih: 2026-11-07 14:40', 'isteyen oturum: koordinator',
  'konu: Formdaki kutu kalkınca başvurular ölçüme gitsin mi?', 'seçenekler:',
  '- A: Hepsi gitsin', '- B: Yalnız kabul edenler', '- C: Hiçbiri',
  'etki: yalnız yeni başvurular', 'geri alınabilir mi: evet', 'son tarih: yok', '', 'CEVAP:', '',
].join('\n');
const TR_ANSWERED = `${TR_OPEN}CEVAP: A — not burada - Mert, 2026-11-07T14:49:49Z, telegram\n`;
const EN_OPEN = ['id: q-1', 'date: 2026-11-07 09:00', 'from: lane cart', 'subject: Ship the cart?', 'options:', '- A: yes', '- B: no', '', 'ANSWER:', ''].join('\n');
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ap-')));
const cfg = (dir, extra = {}) => ({ dir, answerPrefix: 'CEVAP:', actor: 'Mert', channel: 'kumanda', ignore: ['SABLON.md'], ...extra });
const NOW = () => Date.parse('2026-11-07T17:41:00.000Z');

test('parse an open Turkish request: header, options, a bare answer prefix is not an answer', () => {
  const r = parseRequest(TR_OPEN, { prefix: 'CEVAP:' });
  assert.deepEqual(r.header, {
    id: '0711-150000', title: 'Formdaki kutu kalkınca başvurular ölçüme gitsin mi?', from: 'koordinator', date: '2026-11-07 14:40',
    impact: 'yalnız yeni başvurular', reversible: 'evet', due: 'yok',
  });
  assert.deepEqual(r.options, [{ key: 'A', text: 'Hepsi gitsin' }, { key: 'B', text: 'Yalnız kabul edenler' }, { key: 'C', text: 'Hiçbiri' }]);
  assert.deepEqual(r.answers, []);
  assert.equal(r.answered, false);
});

test('parse an answered request: the option letter and the answer time', () => {
  const r = parseRequest(TR_ANSWERED, { prefix: 'CEVAP:' });
  assert.equal(r.answered, true);
  assert.deepEqual(r.answers, [{ text: 'A — not burada - Mert, 2026-11-07T14:49:49Z, telegram', option: 'A', at: '2026-11-07T14:49:49.000Z' }]);
  const odd = parseRequest(`${TR_OPEN}\nCEVAP: geçersiz - koordinatör kendi uyguladı\n`, { prefix: 'CEVAP:' });
  assert.equal(odd.answered, true);
  assert.equal(odd.answers[0].option, null);
  assert.equal(odd.answers[0].at, null);
});

test('CRLF files parse the same', () => {
  assert.deepEqual(parseRequest(TR_ANSWERED.replace(/\n/g, '\r\n'), { prefix: 'CEVAP:' }), parseRequest(TR_ANSWERED, { prefix: 'CEVAP:' }));
});

test('a UTF-8 BOM does not hide the first header line', () => {
  const r = parseRequest(`\uFEFF${TR_OPEN.replace(/\n/g, '\r\n')}`, { prefix: 'CEVAP:' });
  assert.equal(r.header.id, '0711-150000');
  assert.equal(r.options.length, 3);
});

test('UTF-16LE request files (PowerShell 5.1 Out-File) are listed and answered in UTF-16LE', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'u16.md');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TR_OPEN.replace(/\n/g, '\r\n'), 'utf16le')]));
    const { items } = listRequests(cfg(dir), { now: NOW });
    assert.equal(items[0].header.title, 'Formdaki kutu kalkınca başvurular ölçüme gitsin mi?');
    answerRequest(cfg(dir), { id: 'u16', option: 'A', note: 'şimdi' }, { now: NOW });
    const buf = fs.readFileSync(file);
    assert.deepEqual([buf[0], buf[1]], [0xff, 0xfe]);
    assert.ok(buf.subarray(2).toString('utf16le').endsWith('CEVAP:\r\nCEVAP: A — şimdi - Mert, 2026-11-07T17:41:00.000Z, kumanda\r\n'));
    assert.equal(listRequests(cfg(dir), { now: NOW }).items[0].answered, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a request named with spaces and Turkish letters can be answered; separators cannot', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'onay şube 2.md'), TR_OPEN);
    const { items } = listRequests(cfg(dir), { now: NOW });
    assert.equal(items[0].id, 'onay şube 2');
    assert.ok(answerRequest(cfg(dir), { id: 'onay şube 2', option: 'B' }, { now: NOW }).line.startsWith('CEVAP: B'));
    for (const bad of ['a/b', 'a\\b', '..', ' lead', 'x\u0007y', 'C:x']) {
      assert.throws(() => answerRequest(cfg(dir), { id: bad, option: 'A' }, { now: NOW }), (e) => e instanceof RoomError && e.status === 400, JSON.stringify(bad));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('English keys and the ANSWER prefix', () => {
  const r = parseRequest(EN_OPEN, { prefix: 'ANSWER:' });
  assert.equal(r.header.title, 'Ship the cart?');
  assert.equal(r.header.from, 'lane cart');
  assert.equal(r.options.length, 2);
  assert.equal(r.answered, false);
});

test('a file with no header keys takes its first line as the title', () => {
  assert.equal(parseRequest('Please decide X\n- A: one\n- B: two\n', { prefix: 'ANSWER:' }).header.title, 'Please decide X');
});

test('list: ignored names and non-Markdown files are skipped, newest first, request time parsed', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, '0711-150000.md'), TR_OPEN);
    fs.writeFileSync(path.join(dir, '0411-x.md'), TR_OPEN.replace('2026-11-07 14:40', '04.11.2026 21:05').replace('0711-150000', '0411-x'));
    fs.writeFileSync(path.join(dir, 'SABLON.md'), 'id:\nCEVAP:\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.utimesSync(path.join(dir, '0411-x.md'), new Date('2026-11-04T21:05:00Z'), new Date('2026-11-04T21:05:00Z'));
    const { items, error } = listRequests(cfg(dir), { now: NOW });
    assert.equal(error, undefined);
    assert.deepEqual(items.map((i) => i.id), ['0711-150000', '0411-x']);
    assert.equal(items[0].requestedAt, new Date(2026, 10, 7, 14, 40).getTime());
    assert.equal(items[1].requestedAt, new Date(2026, 10, 4, 21, 5).getTime());
    assert.equal(items[0].ageMs, NOW() - items[0].requestedAt);
    assert.equal(items[0].answered, false);
    assert.match(listRequests(cfg(path.join(dir, 'missing')), { now: NOW }).error, /ENOENT|cannot read/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('answerLine follows the protocol format', () => {
  assert.equal(answerLine({ prefix: 'CEVAP:', option: 'B', note: '', actor: 'Mert', channel: 'kumanda', at: '2026-11-07T17:41:00.000Z' }), 'CEVAP: B - Mert, 2026-11-07T17:41:00.000Z, kumanda');
  assert.equal(answerLine({ prefix: 'ANSWER:', option: 'A', note: 'ok', actor: 'me', channel: 'room', at: 'T' }), 'ANSWER: A — ok - me, T, room');
});

test('answerRequest appends exactly one line, adding a missing final newline first', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, '0711-150000.md'), TR_OPEN);
    const r = answerRequest(cfg(dir), { id: '0711-150000', option: 'B', note: 'later' }, { now: NOW });
    assert.equal(r.line, 'CEVAP: B — later - Mert, 2026-11-07T17:41:00.000Z, kumanda');
    assert.equal(fs.readFileSync(path.join(dir, '0711-150000.md'), 'utf8'), `${TR_OPEN}CEVAP: B — later - Mert, 2026-11-07T17:41:00.000Z, kumanda\n`);
    fs.writeFileSync(path.join(dir, 'q.md'), 'konu: x\n- A: a\n- B: b\nCEVAP:');
    answerRequest(cfg(dir), { id: 'q', option: 'A' }, { now: NOW });
    assert.equal(fs.readFileSync(path.join(dir, 'q.md'), 'utf8'), 'konu: x\n- A: a\n- B: b\nCEVAP:\nCEVAP: A - Mert, 2026-11-07T17:41:00.000Z, kumanda\n');
    fs.writeFileSync(path.join(dir, 'w.md'), 'konu: x\r\n- A: a\r\nCEVAP:\r\n');
    answerRequest(cfg(dir), { id: 'w', option: 'A' }, { now: NOW });
    assert.ok(fs.readFileSync(path.join(dir, 'w.md'), 'utf8').endsWith('CEVAP:\r\nCEVAP: A - Mert, 2026-11-07T17:41:00.000Z, kumanda\r\n'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('answerRequest refuses a second answer, unknown options, bad ids, ignored and missing files; notes become one short line', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), TR_ANSWERED);
    fs.writeFileSync(path.join(dir, 'b.md'), TR_OPEN);
    fs.writeFileSync(path.join(dir, 'SABLON.md'), TR_OPEN);
    const code = (fn) => { try { fn(); return 'none'; } catch (e) { assert.ok(e instanceof RoomError, String(e)); return `${e.status} ${e.code}`; } };
    assert.equal(code(() => answerRequest(cfg(dir), { id: 'a', option: 'B' }, { now: NOW })), '409 already-answered');
    assert.equal(code(() => answerRequest(cfg(dir), { id: 'b', option: 'Z' }, { now: NOW })), '400 bad-option');
    assert.equal(code(() => answerRequest(cfg(dir), { id: '../b', option: 'A' }, { now: NOW })), '400 bad-id');
    assert.equal(code(() => answerRequest(cfg(dir), { id: 'SABLON', option: 'A' }, { now: NOW })), '404 not-found');
    assert.equal(code(() => answerRequest(cfg(dir), { id: 'nope', option: 'A' }, { now: NOW })), '404 not-found');
    const r = answerRequest(cfg(dir), { id: 'b', option: 'C', note: `line1\nline2\t${'x'.repeat(400)}` }, { now: NOW });
    assert.ok(!/[\r\n\t]/.test(r.line));
    assert.ok(r.line.includes('line1 line2 '));
    assert.ok(r.line.length < 400);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
