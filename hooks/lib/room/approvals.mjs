// Approval requests: Markdown/text files in a folder; an answer is one appended line. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { RoomError } from './errors.mjs';

const KEYS = {
  id: ['id'],
  title: ['konu', 'subject', 'title', 'question', 'soru'],
  from: ['isteyen oturum', 'isteyen', 'from', 'requested by', 'session', 'oturum'],
  date: ['tarih', 'date', 'created', 'zaman'],
  impact: ['etki', 'impact'],
  reversible: ['geri alınabilir mi', 'geri alinabilir mi', 'reversible'],
  due: ['son tarih', 'due', 'deadline'],
};
const ALIAS = new Map(Object.entries(KEYS).flatMap(([field, names]) => names.map((n) => [n, field])));
const HEADER = /^([^:\-*\s][^:]{0,40}):\s*(.*)$/;
const OPTION = /^\s*[-*]\s*([A-Z])\s*[:)]\s*(.*\S)\s*$/;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/;
const ID_RE = /^[\w.-]{1,80}$/;
const MAX_READ = 256 * 1024;
const MAX_NOTE = 300;

/**
 * @param {string} text
 * @param {{prefix: string}} opts
 */
export function parseRequest(text, { prefix }) {
  const lines = String(text ?? '').split(/\r?\n/);
  const header = { id: null, title: null, from: null, date: null, impact: null, reversible: null, due: null };
  const options = [];
  const answers = [];
  let firstLine = null;
  let inAnswers = false;
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      inAnswers = true;
      const rest = line.slice(prefix.length).trim();
      if (rest) answers.push({ text: rest, option: null, at: null });
      continue;
    }
    if (inAnswers) continue;
    const o = OPTION.exec(line);
    if (o) {
      if (!options.some((x) => x.key === o[1])) options.push({ key: o[1], text: o[2].trim() });
      continue;
    }
    const h = HEADER.exec(line);
    const field = h ? ALIAS.get(h[1].trim().toLowerCase()) : undefined;
    if (field) {
      if (header[field] === null && h[2].trim()) header[field] = h[2].trim();
      continue;
    }
    if (firstLine === null && line.trim()) firstLine = line.trim().replace(/^#+\s*/, '');
  }
  if (header.title === null && firstLine) header.title = firstLine;
  for (const a of answers) {
    const m = /^([A-Z])(?=$|[\s—–:,.)-])/.exec(a.text);
    if (m && (!options.length || options.some((x) => x.key === m[1]))) a.option = m[1];
    const t = ISO.exec(a.text);
    if (t) a.at = new Date(t[0]).toISOString();
  }
  return { header, options, answers, answered: answers.length > 0 };
}

/** Local time from `2026-11-07 14:40`, `04.11.2026 21:05` or an ISO string; null when unknown. */
function parseDate(s) {
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?!:\d{2}(?:\.\d+)?Z)/.exec(s);
  if (m && !/Z$/.test(s)) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_READ);
    const n = fs.readSync(fd, buf, 0, MAX_READ, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

const ignored = (cfg, name) => (cfg.ignore || []).some((x) => x.toLowerCase() === name.toLowerCase());

/**
 * Every request file in the folder, newest first.
 * @param {{dir: string, answerPrefix: string, ignore?: string[]}} cfg
 * @param {{now?: () => number}} [opts]
 */
export function listRequests(cfg, { now = Date.now } = {}) {
  let names;
  try { names = fs.readdirSync(cfg.dir); } catch (e) {
    return { items: [], error: `cannot read ${cfg.dir} (${e.code || e.message})` };
  }
  const items = [];
  for (const name of names) {
    if (!/\.md$/i.test(name) || name.startsWith('.') || ignored(cfg, name)) continue;
    const file = path.join(cfg.dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      const r = parseRequest(readHead(file), { prefix: cfg.answerPrefix });
      const requestedAt = parseDate(r.header.date);
      items.push({ id: name.replace(/\.md$/i, ''), file, mtime: st.mtimeMs, requestedAt, ageMs: Math.max(0, now() - (requestedAt ?? st.mtimeMs)), ...r });
    } catch { /* unreadable file: skipped */ }
  }
  items.sort((a, b) => (b.requestedAt ?? b.mtime) - (a.requestedAt ?? a.mtime));
  return { items };
}

/** `<prefix> <option>[ — <note>] - <actor>, <at>, <channel>` */
export function answerLine({ prefix, option, note, actor, channel, at }) {
  return `${prefix} ${option}${note ? ` — ${note}` : ''} - ${actor}, ${at}, ${channel}`;
}

const oneLine = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s{2,}/g, ' ').trim();

/**
 * Append the answer line to request `id`. Re-reads the file first; refuses when it is already answered.
 * @param {{dir: string, answerPrefix: string, actor: string, channel: string, ignore?: string[]}} cfg
 * @param {{id: string, option: string, note?: string}} answer
 * @param {{now?: () => number}} [opts]
 * @returns {{line: string, file: string}}
 */
export function answerRequest(cfg, { id, option, note }, { now = Date.now } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id) || /^\.+$/.test(id)) throw new RoomError(400, 'bad-id', 'request id is not valid');
  const name = `${id}.md`;
  const file = path.join(cfg.dir, name);
  if (path.dirname(path.resolve(file)) !== path.resolve(cfg.dir) || ignored(cfg, name)) throw new RoomError(404, 'not-found', `no request ${id}`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    throw new RoomError(404, 'not-found', `no request ${id}`);
  }
  const r = parseRequest(text, { prefix: cfg.answerPrefix });
  if (r.answered) throw new RoomError(409, 'already-answered', `request ${id} is already answered`, { answer: r.answers[r.answers.length - 1].text });
  if (typeof option !== 'string' || !r.options.some((o) => o.key === option)) throw new RoomError(400, 'bad-option', `request ${id} has no option ${option}`);
  const cleanNote = oneLine(note).slice(0, MAX_NOTE);
  const line = answerLine({ prefix: cfg.answerPrefix, option, note: cleanNote, actor: oneLine(cfg.actor), channel: oneLine(cfg.channel), at: new Date(now()).toISOString() });
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lead = text.length && !text.endsWith('\n') ? eol : '';
  fs.appendFileSync(file, `${lead}${line}${eol}`);
  return { line, file };
}
