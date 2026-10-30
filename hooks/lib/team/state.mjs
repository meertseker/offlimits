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

/**
 * Synchronous exclusive lock on `dir/lock`. The lock file holds a unique token; release deletes it only if it
 * still holds ours. A lock older than staleMs is broken by renaming it aside (only one waiter wins the rename).
 */
export function withLock(dir, fn, { timeoutMs = 2000, staleMs = 10000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'lock');
  const token = process.pid + '-' + randomBytes(8).toString('hex');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(p, 'wx');
      try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > staleMs) {
          const seen = readToken(p);
          const aside = p + '.stale-' + token;
          fs.renameSync(p, aside);
          // We may have renamed a fresh lock that replaced the stale one between stat and rename: put it back.
          let fresh = false;
          try { fresh = Date.now() - fs.statSync(aside).mtimeMs <= staleMs || readToken(aside) !== seen; } catch { /* gone */ }
          if (fresh && !fs.existsSync(p)) {
            try { fs.renameSync(aside, p); } catch { fs.rmSync(aside, { force: true }); }
          } else {
            fs.rmSync(aside, { force: true });
          }
          continue;
        }
      } catch { /* lock vanished or lost the rename: retry */ }
      if (Date.now() >= deadline) throw new Error('team state is locked');
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    try { if (readToken(p) === token) fs.rmSync(p, { force: true }); } catch { /* best effort */ }
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

export function readBoard(dir) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8'));
    if (b && typeof b === 'object' && b.lanes && typeof b.lanes === 'object') return b;
  } catch { /* missing or unreadable */ }
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
    const board = readBoard(dir);
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
