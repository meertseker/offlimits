// Night loops: a folder with a status JSON, a stop marker, other markers, a task list and a log. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { RoomError } from './errors.mjs';

const TAIL_BYTES = 16 * 1024;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Absolute path of `rel` inside `dir`, or null when it would leave the folder. */
function inside(dir, rel) {
  if (!rel) return null;
  const base = path.resolve(dir);
  const full = path.resolve(base, rel);
  return full.startsWith(base + path.sep) ? full : null;
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function tail(file, lines) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-lines).map((l) => l.slice(0, 300));
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readStatus(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { obj: null, text: null };
    throw e;
  }
  try { return { obj: JSON.parse(text.replace(/^﻿/, '')), text }; } catch { return { obj: undefined, text }; }
}

/**
 * The state of one loop. Never throws; a problem is reported in `error`.
 * @param {object} cfg loop config (room config Loop)
 * @param {{now?: () => number}} [opts]
 */
export function readLoop(cfg, { now = Date.now } = {}) {
  const errors = [];
  const out = {
    id: cfg.id, name: cfg.name, dir: cfg.dir, status: null, note: null, paused: false, running: null, logAgeMs: null,
    logTail: [], markers: [], stopped: false, tasks: null, startHint: cfg.startHint ?? null,
  };
  const loc = (rel, what) => {
    const p = inside(cfg.dir, rel);
    if (rel && !p) errors.push(`${what} ${rel} is outside the loop folder`);
    return p;
  };
  const statusFile = loc(cfg.status.file, 'status file');
  if (statusFile) {
    try {
      const { obj } = readStatus(statusFile);
      if (isObject(obj)) {
        const v = obj[cfg.status.field];
        out.status = v === undefined || v === null ? null : String(v);
        const note = obj.note ?? obj.not;
        out.note = note === undefined || note === null ? null : String(note).slice(0, 500);
      } else if (obj === undefined) errors.push(`${cfg.status.file} is not valid JSON`);
    } catch (e) { errors.push(`cannot read ${cfg.status.file} (${e.code || e.message})`); }
  }
  out.paused = out.status === cfg.status.pause;
  const stop = loc(cfg.stopFile, 'stop file');
  for (const name of [...(cfg.stopFile ? [cfg.stopFile] : []), ...(cfg.markers || [])]) {
    const p = name === cfg.stopFile ? stop : loc(name, 'marker');
    const t = p ? mtimeOf(p) : null;
    if (t !== null) out.markers.push({ name, mtime: t });
  }
  out.stopped = Boolean(stop && mtimeOf(stop) !== null);
  if (cfg.tasks) {
    const tf = loc(cfg.tasks.file, 'task list');
    if (tf) {
      try {
        const data = JSON.parse(fs.readFileSync(tf, 'utf8').replace(/^﻿/, ''));
        const list = Array.isArray(data) ? data : isObject(data) ? (Array.isArray(data.features) ? data.features : Object.values(data).find(Array.isArray)) : null;
        if (Array.isArray(list)) {
          const done = list.filter((t) => t && t[cfg.tasks.done] === true).length;
          const blocked = list.filter((t) => t && t[cfg.tasks.done] !== true && t[cfg.tasks.blocked] === true).length;
          const next = list.find((t) => t && t[cfg.tasks.done] !== true && t[cfg.tasks.blocked] !== true);
          out.tasks = {
            done, total: list.length, blocked,
            next: next ? { id: String(next[cfg.tasks.id] ?? ''), title: next[cfg.tasks.title] === undefined ? null : String(next[cfg.tasks.title]).slice(0, 200) } : null,
          };
        } else errors.push(`${cfg.tasks.file} has no task list`);
      } catch (e) { errors.push(`cannot read ${cfg.tasks.file} (${e.code || e.message})`); }
    }
  }
  if (cfg.log) {
    const lf = loc(cfg.log, 'log');
    const t = lf ? mtimeOf(lf) : null;
    if (t !== null) {
      out.logAgeMs = Math.max(0, now() - t);
      out.running = out.logAgeMs <= (cfg.liveMinutes ?? 30) * 60_000;
      out.logTail = tail(lf, 3);
    } else if (lf) out.running = false;
  }
  if (errors.length) out.error = errors.join('; ');
  return out;
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Pause (pause value + stop marker) or resume (run value, stop marker removed). Other keys and markers are kept.
 * @param {object} cfg loop config
 * @param {'pause'|'resume'} action
 * @param {{now?: () => number}} [opts]
 */
export function setLoop(cfg, action, { now = Date.now } = {}) {
  if (action !== 'pause' && action !== 'resume') throw new RoomError(400, 'bad-action', 'action must be pause or resume');
  const statusFile = inside(cfg.dir, cfg.status.file);
  if (!statusFile) throw new RoomError(409, 'bad-status-file', 'the status file is outside the loop folder');
  let current;
  try { current = readStatus(statusFile); } catch (e) {
    throw new RoomError(409, 'unreadable', `cannot read ${cfg.status.file} (${e.code || e.message})`);
  }
  if (current.obj !== null && !isObject(current.obj)) throw new RoomError(409, 'not-an-object', `${cfg.status.file} is not a JSON object; fix it by hand`);
  const obj = isObject(current.obj) ? current.obj : {};
  obj[cfg.status.field] = action === 'pause' ? cfg.status.pause : cfg.status.run;
  const pretty = typeof current.text === 'string' && /\n\s+"/.test(current.text);
  fs.mkdirSync(cfg.dir, { recursive: true });
  writeAtomic(statusFile, pretty ? `${JSON.stringify(obj, null, 2)}\n` : JSON.stringify(obj));
  const stop = inside(cfg.dir, cfg.stopFile);
  if (stop) {
    if (action === 'pause') fs.writeFileSync(stop, '');
    else fs.rmSync(stop, { force: true });
  }
  return readLoop(cfg, { now });
}
