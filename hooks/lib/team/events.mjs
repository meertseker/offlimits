// Append-only team event log: one JSON object per line. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

/** Event types the team CLI and the control room write; `team event` may add others matching TYPE_RE. */
export const EVENT_TYPES = Object.freeze([
  'lane.briefed', 'lane.stage', 'lane.delivered', 'lane.question', 'lane.merged', 'lane.abandoned',
  'reserve', 'review', 'deploy', 'approval.answered', 'loop.paused', 'loop.resumed', 'note',
]);

export const TYPE_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

const SHORT = ['project', 'lane', 'actor', 'run', 'model', 'verdict', 'intervention'];
const TOKEN_KEYS = ['in', 'out', 'cacheRead', 'cacheWrite'];
const SHA_RE = /^[0-9a-f]{4,40}$/i;
const MAX_SHORT = 120;
const MAX_NOTE = 500;
const MAX_DATA = 2048;
const MAX_CHECKS = 32;
const MAX_CHECK_NAME = 60;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// C0 controls and DEL become spaces, so one event is always one line
const oneLine = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ');

function bad(why) {
  return new Error(`invalid event: ${why}`);
}

/**
 * A validated event object: `{v: 1, ts, type, ...}` with only the known fields.
 * @param {object} fields
 * @param {() => number} [now]
 * @returns {object}
 */
export function makeEvent(fields, now = Date.now) {
  if (!isObject(fields)) throw bad('fields must be an object');
  const { type } = fields;
  if (typeof type !== 'string' || type.length > 64 || !TYPE_RE.test(type)) throw bad(`type "${type}" must match ${TYPE_RE.source}`);
  const ev = { v: 1, ts: new Date(now()).toISOString(), type };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'type' || value === undefined || value === null) continue;
    if (SHORT.includes(key)) {
      if (typeof value !== 'string' || value.length > MAX_SHORT) throw bad(`${key} must be a string up to ${MAX_SHORT} characters`);
      ev[key] = oneLine(value);
    } else if (key === 'note') {
      if (typeof value !== 'string') throw bad('note must be a string');
      ev.note = oneLine(value).slice(0, MAX_NOTE);
    } else if (key === 'sha') {
      if (typeof value !== 'string' || !SHA_RE.test(value)) throw bad('sha must be 4 to 40 hex characters');
      ev.sha = value.toLowerCase();
    } else if (key === 'tokens') {
      if (!isObject(value)) throw bad('tokens must be an object');
      const t = {};
      for (const [k, n] of Object.entries(value)) {
        if (!TOKEN_KEYS.includes(k)) throw bad(`unknown tokens key "${k}"`);
        if (!Number.isInteger(n) || n < 0) throw bad(`tokens.${k} must be a non-negative integer`);
        t[k] = n;
      }
      ev.tokens = t;
    } else if (key === 'costUsd') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw bad('costUsd must be a number >= 0');
      ev.costUsd = value;
    } else if (key === 'checks') {
      if (!Array.isArray(value) || value.length > MAX_CHECKS) throw bad(`checks must be an array of at most ${MAX_CHECKS}`);
      ev.checks = value.map((c) => {
        if (!isObject(c) || typeof c.name !== 'string' || !c.name.trim() || typeof c.ok !== 'boolean') throw bad('each check is {name, ok}');
        return { name: oneLine(c.name).trim().slice(0, MAX_CHECK_NAME), ok: c.ok };
      });
    } else if (key === 'defects') {
      if (!Number.isInteger(value) || value < 0 || value > 10000) throw bad('defects must be an integer from 0 to 10000');
      ev.defects = value;
    } else if (key === 'data') {
      if (!isObject(value)) throw bad('data must be an object');
      let text;
      try { text = JSON.stringify(value); } catch { throw bad('data must be JSON'); }
      if (Buffer.byteLength(text, 'utf8') > MAX_DATA) throw bad(`data must be at most ${MAX_DATA} bytes of JSON`);
      ev.data = JSON.parse(text);
    } else if (key !== 'v' && key !== 'ts') {
      throw bad(`unknown key "${key}"`);
    }
  }
  return ev;
}

/** `<teamDir>/events.jsonl` */
export function eventsFile(teamDir) {
  return path.join(teamDir, 'events.jsonl');
}

/**
 * Validate and append one event as one line; creates the folder. Returns the event.
 * @param {string} file
 * @param {object} fields
 * @param {{now?: () => number}} [opts]
 */
export function appendEvent(file, fields, { now = Date.now } = {}) {
  const ev = makeEvent(fields, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(ev)}\n`);
  return ev;
}

/**
 * Events in file order. Lines that do not parse as an event are skipped; a missing file is empty.
 * @param {string} file
 * @param {{sinceMs?: number, limit?: number}} [opts] sinceMs keeps events at or after that time; limit keeps the newest N
 */
export function readEvents(file, { sinceMs = 0, limit = 5000 } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!isObject(ev) || typeof ev.type !== 'string' || typeof ev.ts !== 'string') continue;
    const t = Date.parse(ev.ts);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    out.push(ev);
  }
  return limit > 0 && out.length > limit ? out.slice(out.length - limit) : out;
}

const CHECK_LINE = /^\s*(?:[-*]\s*)?(?:checks|kontroller|kontrol)\s*:\s*(.*)$/im;
const MARK = /([^✓✔✗✘❌·,;()\r\n]+?)\s*(✓|✔|✗|✘|❌)/gu;

/**
 * Check results from a delivery note: the first `checks:` (or Turkish `kontroller:`) line, read as `name ✓` / `name ✗` pairs.
 * @param {string} text
 * @returns {{name: string, ok: boolean}[]}
 */
export function parseChecks(text) {
  const m = CHECK_LINE.exec(String(text ?? ''));
  if (!m) return [];
  const out = [];
  for (const [, name, mark] of m[1].matchAll(MARK)) {
    const n = name.replace(/\s+/g, ' ').trim();
    if (!n) continue;
    out.push({ name: n.slice(0, MAX_CHECK_NAME), ok: mark === '✓' || mark === '✔' });
    if (out.length >= MAX_CHECKS) break;
  }
  return out;
}
