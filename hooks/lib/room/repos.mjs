// Repositories for the control room: worktrees as lanes, their divergence, activity, delivery and ledger status.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseChecks } from '../team/events.mjs';
import { STAGES, readBoard } from '../team/state.mjs';

const DAY = 86_400_000;
const MAX_GIT = 6;
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'];
const SEP = '\x1f';
const DELIVERY_BYTES = 64 * 1024;

let active = 0;
const waiting = [];
function slot() {
  if (active < MAX_GIT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

function run(cwd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? { ok: false, out: '' } : { ok: true, out: String(stdout) });
    });
  });
}

/**
 * Run git with a concurrency limit. Trimmed stdout, or null when git fails or the folder is missing.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{timeoutMs?: number}} [opts]
 */
export async function gitAsync(cwd, args, { timeoutMs = 8000 } = {}) {
  if (!fs.existsSync(cwd)) return null;
  await slot();
  try {
    const r = await run(cwd, args, timeoutMs);
    return r.ok ? r.out.trim() : null;
  } finally { release(); }
}

async function gitOk(cwd, args) {
  if (!fs.existsSync(cwd)) return false;
  await slot();
  try { return (await run(cwd, args, 8000)).ok; } finally { release(); }
}

function parseCommit(text) {
  if (!text) return null;
  const [sha, ct, ...rest] = text.split(SEP);
  const ts = Number(ct) * 1000;
  return sha && Number.isFinite(ts) ? { sha, ts, subject: rest.join(SEP).slice(0, 200) } : null;
}

function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: path.resolve(line.slice(9)), head: null, branch: null, detached: false, bare: false, prunable: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The delivery note for a branch: `feat/a-b` matches `feat-a-b.md` and `a-b.md`. */
function findDelivery(branch, lane, files) {
  if (!files || !files.length) return null;
  const names = new Set();
  if (branch) {
    names.add(branch.replace(/\//g, '-').toLowerCase());
    names.add(branch.split('/').pop().toLowerCase());
  }
  if (lane) names.add(lane.toLowerCase());
  const hit = files.find((f) => names.has(f.name.replace(/\.md$/i, '').toLowerCase()));
  if (!hit) return null;
  let text = '';
  try {
    const fd = fs.openSync(hit.file, 'r');
    try {
      const buf = Buffer.alloc(DELIVERY_BYTES);
      text = buf.subarray(0, fs.readSync(fd, buf, 0, DELIVERY_BYTES, 0)).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { /* unreadable: no fields */ }
  const fence = /```[^\n]*\r?\n([\s\S]*?)```/.exec(text);
  const fields = [];
  for (const line of (fence ? fence[1] : text).split(/\r?\n/)) {
    const m = /^\s*([^:\n|`#>-][^:\n]{0,29}):\s*(.+)$/.exec(line);
    if (m && fields.length < 12) fields.push([m[1].trim(), m[2].trim().slice(0, 300)]);
  }
  return { file: hit.file, mtime: hit.mtime, fields, checks: parseChecks(text) };
}

/** The first ledger row that names the branch as a whole word; its status is the Durum/Status column. */
function findLedger(branch, rows) {
  if (!branch || !rows || !rows.length) return null;
  const re = new RegExp(`(^|[^\\w/.-])${esc(branch)}($|[^\\w/.-])`);
  for (const r of rows) {
    if (!r.cells.some((c) => re.test(c))) continue;
    const row = {};
    r.header.slice(0, 8).forEach((h, i) => { if (h) row[h] = String(r.cells[i] ?? '').slice(0, 300); });
    const k = r.header.findIndex((h) => /^(durum|status)$/i.test(h));
    return { status: k >= 0 ? String(r.cells[k] ?? '').slice(0, 300) : null, row };
  }
  return null;
}

async function resolveBase(repoPath, configured) {
  if (configured) return configured;
  for (const c of BASE_CANDIDATES) if (await gitAsync(repoPath, ['rev-parse', '--verify', '--quiet', c])) return c;
  return null;
}

/**
 * One repository's lanes.
 * @param {{name: string, path: string, base: string|null}} repo
 * @param {{now?: () => number, staleDays?: number, deliveryFiles?: {file: string, name: string, mtime: number}[], ledgerRows?: {header: string[], cells: string[]}[]}} [opts]
 */
export async function readRepo(repo, { now = Date.now, staleDays = 5, deliveryFiles = [], ledgerRows = [] } = {}) {
  const out = { name: repo.name, path: repo.path, base: repo.base, baseHead: null, todayCommits: [], lanes: [] };
  if (!(await gitAsync(repo.path, ['rev-parse', '--git-common-dir']))) return { ...out, error: `${repo.path} is not a git repository (or is missing)` };
  const base = await resolveBase(repo.path, repo.base);
  out.base = base;
  const t = now();
  const midnight = new Date(t);
  midnight.setHours(0, 0, 0, 0);
  const fmt = `--format=%H${SEP}%ct${SEP}%s`;
  const [headText, todayText, wtText] = await Promise.all([
    base ? gitAsync(repo.path, ['log', '-1', fmt, base, '--']) : null,
    base ? gitAsync(repo.path, ['log', '--first-parent', `--since=${midnight.toISOString()}`, '-n', '50', fmt, base, '--']) : null,
    gitAsync(repo.path, ['worktree', 'list', '--porcelain']),
  ]);
  out.baseHead = parseCommit(headText);
  out.todayCommits = (todayText || '').split(/\r?\n/).map(parseCommit).filter(Boolean);
  const board = readBoard(path.join(repo.path, '.offlimits', 'team')).lanes;
  const teamLanes = Object.entries(board).map(([lane, rec]) => ({ lane, ...rec }));
  const wts = parseWorktrees(wtText).filter((w) => !w.bare);
  out.lanes = await Promise.all(wts.map(async (w, i) => {
    const main = i === 0 || samePath(w.path, repo.path);
    const id = path.basename(w.path);
    const exists = !w.prunable && fs.existsSync(w.path);
    const ref = w.head || w.branch;
    const [status, counts, last, merged] = await Promise.all([
      exists ? gitAsync(w.path, ['status', '--porcelain']) : null,
      base && ref ? gitAsync(repo.path, ['rev-list', '--left-right', '--count', `${base}...${ref}`]) : null,
      ref ? gitAsync(repo.path, ['log', '-1', fmt, ref, '--']) : null,
      base && ref ? gitOk(repo.path, ['merge-base', '--is-ancestor', ref, base]) : false,
    ]);
    const [behind, ahead] = (counts || '0 0').split(/\s+/).map((n) => Number(n) || 0);
    const dirty = status ? status.split(/\r?\n/).filter(Boolean).length : 0;
    const lastCommit = parseCommit(last);
    const tl = teamLanes.find((l) => (typeof l.worktree === 'string' && samePath(l.worktree, w.path)) || (w.branch && l.branch === w.branch));
    const team = tl ? { lane: tl.lane, stage: STAGES.includes(tl.stage) ? tl.stage : null, note: tl.note ?? null, model: tl.model ?? null } : null;
    const delivery = main ? null : findDelivery(w.branch, team ? team.lane : null, deliveryFiles);
    const ledger = main ? null : findLedger(w.branch, ledgerRows);
    const quietDays = lastCommit ? Math.floor((t - lastCommit.ts) / DAY) : null;
    const isMerged = !main && ahead === 0 && merged && dirty === 0;
    const isDelivered = Boolean(delivery && (!lastCommit || delivery.mtime >= lastCommit.ts));
    let state = 'building';
    if (main) state = 'main';
    else if (!exists) state = 'missing';
    else if (team && (team.stage === 'merged' || team.stage === 'abandoned')) state = 'merged';
    else if (isMerged) state = 'merged';
    else if (isDelivered || (team && team.stage === 'delivered')) state = 'delivered';
    else if (quietDays !== null && quietDays >= staleDays) state = 'stale';
    let stage = null;
    if (team && team.stage) {
      const index = team.stage === 'abandoned' ? -1 : STAGES.indexOf(team.stage);
      stage = { index, name: team.stage, inferred: false };
    } else if (!main) {
      const name = isMerged ? 'merged' : isDelivered ? 'delivered' : ahead > 0 || dirty > 0 ? 'building' : 'briefed';
      stage = { index: STAGES.indexOf(name), name, inferred: true };
    }
    return {
      id, path: w.path, main, exists, branch: w.branch, sha: w.head, detached: w.detached, dirty, ahead, behind,
      merged: Boolean(merged), lastCommit, team, delivery, ledger, stage, state, quietDays,
    };
  }));
  return out;
}
