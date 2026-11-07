// Claude Code sessions and prompt history, read from the Claude config folder. Read-only, bounded reads.
import fs from 'node:fs';
import path from 'node:path';

const TAIL_BYTES = 256 * 1024;
const HISTORY_BYTES = 8 * 1024 * 1024;
const DAY = 86_400_000;
const RECENT_MS = DAY;
const WAITING_MAX_MS = 12 * 3600_000;
const STALLED_MS = 15 * 60_000;
const LIMIT_TEXT = /limit|credits|resets/i;
const LOCAL_COMMAND = /^\s*<(command-name|command-message|local-command-stdout|local-command-caveat|local-command-stderr)>/;

/** Claude Code's folder name for a project directory: every character outside A-Z, a-z, 0-9 and - becomes -. */
export function encodeProjectDir(dir) {
  return String(dir).replace(/[^A-Za-z0-9-]/g, '-');
}

const str = (v, n = 300) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, n) : null);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ');
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString('utf8').split('\n');
    if (size > n) lines.shift();
    return lines;
  } finally { fs.closeSync(fd); }
}

/**
 * What the end of one transcript says: title, last prompt, the away summary, model, branch, last activity,
 * whether the last turn ended (the session waits for the human), and a usage-limit notice.
 * @param {string} file
 * @param {{bytes?: number}} [opts]
 */
export function readSessionTail(file, { bytes = TAIL_BYTES } = {}) {
  const out = { id: path.basename(file).replace(/\.jsonl$/i, ''), lastTs: null, model: null, branch: null, title: null, lastPrompt: null, summary: null, ended: false, limitNotice: null };
  let custom = null;
  for (const line of readTail(file, bytes)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    switch (o.type) {
      case 'ai-title': out.title = str(o.aiTitle, 120) ?? out.title; break;
      case 'custom-title': custom = str(o.customTitle ?? o.title, 120) ?? custom; break;
      case 'last-prompt': out.lastPrompt = str(o.lastPrompt, 200) ?? out.lastPrompt; break;
      case 'system':
        // Claude Code appends a settings hint to its recaps; the room shows only the recap itself
        if (o.subtype === 'away_summary') out.summary = str(typeof o.content === 'string' ? o.content.replace(/\s*\([^()]*\/config\)\s*$/i, '') : o.content) ?? out.summary;
        break;
      case 'assistant': {
        const m = o.message || {};
        if (o.timestamp) out.lastTs = o.timestamp;
        if (o.gitBranch) out.branch = o.gitBranch;
        if (m.model === '<synthetic>') {
          out.ended = true;
          const text = textOf(m.content);
          if (LIMIT_TEXT.test(text)) out.limitNotice = { ts: o.timestamp ?? null, text: str(text, 200) };
        } else {
          if (m.model) out.model = m.model;
          out.ended = m.stop_reason === 'end_turn' || m.stop_reason === 'max_tokens' || m.stop_reason === 'refusal';
        }
        break;
      }
      case 'user': {
        const m = o.message || {};
        if (o.isMeta || LOCAL_COMMAND.test(textOf(m.content))) break;
        if (o.timestamp) out.lastTs = o.timestamp;
        if (o.gitBranch) out.branch = o.gitBranch;
        out.ended = false;
        break;
      }
      default:
    }
  }
  if (custom) out.title = custom;
  return out;
}

const ci = (platform) => platform === 'win32' || platform === 'darwin';

/**
 * Sessions of the given directories that were active in the last 24 hours.
 * @param {string} claudeDir
 * @param {{dir: string, project: string, lane: string|null}[]} dirs
 * @param {{now?: () => number, liveMinutes?: number, coordinatorIds?: string[], platform?: string}} [opts]
 */
export function readSessions(claudeDir, dirs, { now = Date.now, liveMinutes = 30, coordinatorIds = [], platform = process.platform } = {}) {
  const root = path.join(claudeDir, 'projects');
  let folders;
  try { folders = fs.readdirSync(root); } catch { return { sessions: [], limitNotice: null }; }
  const fold = ci(platform) ? (s) => s.toLowerCase() : (s) => s;
  const byName = new Map(folders.map((f) => [fold(f), f]));
  const coordinators = new Set(coordinatorIds);
  const t = now();
  const seen = new Set();
  const sessions = [];
  let limitNotice = null;
  for (const { dir, project, lane } of dirs) {
    const folder = byName.get(fold(encodeProjectDir(dir)));
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    let files;
    try { files = fs.readdirSync(path.join(root, folder)); } catch { continue; }
    for (const name of files) {
      if (!/\.jsonl$/i.test(name)) continue;
      const file = path.join(root, folder, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || t - st.mtimeMs > RECENT_MS) continue;
      let tail;
      try { tail = readSessionTail(file); } catch { continue; }
      const last = tail.lastTs ? Date.parse(tail.lastTs) : st.mtimeMs;
      const ageMs = Math.max(0, t - (Number.isFinite(last) ? last : st.mtimeMs));
      let state = 'quiet';
      if (tail.ended && ageMs <= WAITING_MAX_MS) state = 'waiting';
      else if (!tail.ended && ageMs <= liveMinutes * 60_000) state = 'working';
      sessions.push({
        id: tail.id, shortId: tail.id.slice(0, 8), project, lane: lane ?? null, dir,
        role: coordinators.has(tail.id) ? 'coordinator' : lane ? 'lane' : 'main',
        title: tail.title, lastPrompt: tail.lastPrompt, summary: tail.summary, model: tail.model, branch: tail.branch,
        lastTs: tail.lastTs, ageMs, state, stalled: state === 'working' && ageMs > STALLED_MS,
      });
      if (tail.limitNotice && (!limitNotice || String(tail.limitNotice.ts) > String(limitNotice.ts))) limitNotice = { ...tail.limitNotice, project };
    }
  }
  const rank = { waiting: 0, working: 1, quiet: 2 };
  sessions.sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    if (a.state === 'waiting') {
      const ca = a.role === 'coordinator' ? 0 : 1;
      const cb = b.role === 'coordinator' ? 0 : 1;
      if (ca !== cb) return ca - cb;
    }
    return a.ageMs - b.ageMs;
  });
  return { sessions, limitNotice };
}

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Prompts per local day and per project from `history.jsonl`, and the share matching `patterns` this week and last week.
 * @param {string} claudeDir
 * @param {{id: string, dirs: string[]}[]} projects
 * @param {{now?: () => number, days?: number, patterns?: string[], platform?: string}} [opts]
 */
export function readHistory(claudeDir, projects, { now = Date.now, days = 14, patterns = [], platform = process.platform } = {}) {
  const t = now();
  const norm = (p) => {
    const s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    return ci(platform) ? s.toLowerCase() : s;
  };
  const dirs = projects.flatMap((p) => p.dirs.map((d) => ({ id: p.id, dir: norm(d) })));
  const res = patterns.map((p) => { try { return new RegExp(p, 'i'); } catch { return null; } }).filter(Boolean);
  const today = new Date(t);
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 12).getTime()));
  const byDate = new Map(dates.map((d) => [d, { date: d, total: 0, byProject: {} }]));
  const byProject = {};
  const week = (i) => ({ prompts: 0, hits: 0, i });
  const weeks = [week(0), week(1)];
  let lines = [];
  try { lines = readTail(path.join(claudeDir, 'history.jsonl'), HISTORY_BYTES); } catch {
    return null;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o.display !== 'string' || typeof o.timestamp !== 'number') continue;
    const text = o.display.trim();
    if (!text || text.startsWith('/')) continue;
    const day = byDate.get(localDate(o.timestamp));
    if (!day) continue;
    const p = norm(o.project);
    let id = 'other';
    let best = -1;
    for (const d of dirs) {
      if ((p === d.dir || p.startsWith(`${d.dir}/`)) && d.dir.length > best) {
        id = d.id;
        best = d.dir.length;
      }
    }
    day.total++;
    day.byProject[id] = (day.byProject[id] || 0) + 1;
    byProject[id] = (byProject[id] || 0) + 1;
    const age = dates.length - 1 - dates.indexOf(day.date);
    const w = age < 7 ? weeks[0] : age < 14 ? weeks[1] : null;
    if (w) {
      w.prompts++;
      if (res.some((r) => r.test(text))) w.hits++;
    }
  }
  const share = (w) => ({ prompts: w.prompts, orchestration: res.length && w.prompts ? w.hits / w.prompts : null });
  return { days: dates.map((d) => byDate.get(d)), byProject, thisWeek: share(weeks[0]), lastWeek: share(weeks[1]) };
}
