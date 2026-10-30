import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { commonRoot } from '../git.mjs';

export const STAGES = ['briefed', 'designing', 'awaiting-approval', 'building', 'delivered', 'merged', 'abandoned'];

/** `<commonRoot>/.offlimits/team`, or null outside a git repo. */
export function teamDir(cwd) {
  const root = commonRoot(cwd);
  return root ? path.join(root, '.offlimits', 'team') : null;
}

export function ensureTeamDir(dir) {
  for (const sub of ['briefs', 'deliveries', 'questions']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readToken(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** Age in ms of a lock file: from the timestamp inside its token, else its mtime. */
function lockAge(p, content) {
  const m = /^\d+-(\d{10,})-[0-9a-f]+$/.exec(content || '');
  if (m) return Date.now() - Number(m[1]);
  try { return Date.now() - fs.statSync(p).mtimeMs; } catch { return 0; }
}

function tryCreate(p, token) {
  const fd = fs.openSync(p, 'wx');
  try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
}

const BUSY = ['EEXIST', 'EPERM', 'EACCES'];

/**
 * Remove the stale lock whose token we observed. Never moves or deletes a lock that might be live:
 * only the holder of `lock.break` may remove `lock`, and only if it still holds the stale token we saw.
 */
function breakStale(p, seen, token, breakStaleMs, hooks) {
  if (hooks && hooks.afterObserve) hooks.afterObserve();
  const bp = p + '.break';
  try {
    tryCreate(bp, token);
  } catch (e) {
    if (!BUSY.includes(e.code)) throw e;
    const held = readToken(bp);
    if (held !== null && lockAge(bp, held) > breakStaleMs && readToken(bp) === held) fs.rmSync(bp, { force: true });
    return;
  }
  try {
    if (readToken(p) === seen) fs.rmSync(p, { force: true });
  } finally {
    if (readToken(bp) === token) fs.rmSync(bp, { force: true });
  }
}

/**
 * Synchronous exclusive lock on `dir/lock`. The file holds a token `<pid>-<ms>-<random>`; release deletes it only
 * if it still holds ours. A lock older than staleMs is broken through `lock.break` (see breakStale).
 */
export function withLock(dir, fn, { timeoutMs = 2000, staleMs = 10000, breakStaleMs = 30000, hooks } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const token = process.pid + '-' + Date.now() + '-' + randomBytes(8).toString('hex');
    let got = false;
    try {
      tryCreate(p, token);
      got = true;
    } catch (e) {
      if (!BUSY.includes(e.code)) throw e;
    }
    if (got) {
      try {
        return fn();
      } finally {
        try { if (readToken(p) === token) fs.rmSync(p, { force: true }); } catch { /* best effort */ }
      }
    }
    const seen = readToken(p);
    if (seen !== null && lockAge(p, seen) > staleMs) {
      breakStale(p, seen, token, breakStaleMs, hooks);
      if (Date.now() >= deadline) throw new Error('team state is locked');
      sleep(5);
      continue;
    }
    if (Date.now() >= deadline) throw new Error('team state is locked');
    sleep(25);
  }
}

function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 10 || (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY')) throw e;
      sleep(10);
    }
  }
}

/**
 * The board. Lenient by default (banner, `board`): missing or unreadable reads as empty.
 * `strict` (every locked write path) throws on a file that exists but does not parse, so a write never
 * replaces a damaged board with an empty one.
 */
export function readBoard(dir, { strict = false } = {}) {
  let text;
  try { text = fs.readFileSync(path.join(dir, 'board.json'), 'utf8'); } catch (e) {
    if (strict && e.code !== 'ENOENT') throw e;
    return { lanes: {} };
  }
  try {
    const b = JSON.parse(text);
    if (b && typeof b === 'object' && !Array.isArray(b) && b.lanes && typeof b.lanes === 'object' && !Array.isArray(b.lanes)) return b;
  } catch { /* unreadable */ }
  if (strict) throw new Error('board.json is unreadable; fix or delete it');
  return { lanes: {} };
}

export function writeBoard(dir, board) {
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'board.json'), board);
}

export function updateLane(dir, lane, patch) {
  if (patch && patch.stage !== undefined && !STAGES.includes(patch.stage)) {
    throw new Error(`unknown stage: ${patch.stage}`);
  }
  return withLock(dir, () => {
    const board = readBoard(dir, { strict: true });
    const now = new Date().toISOString();
    const prev = board.lanes[lane];
    const next = { ...(prev || { createdAt: now }), ...patch, createdAt: prev ? prev.createdAt : now, updatedAt: now };
    board.lanes[lane] = next;
    writeBoard(dir, board);
    return next;
  });
}

/** Reserve the next zero-padded number for `key`. */
export function reserve(dir, key, { floor = 0, width = 4, lane = '' } = {}) {
  return withLock(dir, () => {
    const file = path.join(dir, 'reservations.json');
    let all = {};
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (text !== null) {
      try { all = JSON.parse(text); } catch { all = null; }
      if (all === null || typeof all !== 'object' || Array.isArray(all)) throw new Error('reservations.json is unreadable; fix or delete it');
    }
    const entry = all[key] || { last: 0, history: [] };
    const value = Math.max(Number(entry.last) || 0, floor) + 1;
    entry.last = value;
    entry.history = [...(entry.history || []), { value, lane, at: new Date().toISOString() }];
    all[key] = entry;
    writeJsonAtomic(file, all);
    return String(value).padStart(width, '0');
  });
}
