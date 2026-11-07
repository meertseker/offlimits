// One snapshot of every configured source for the control room page. Each source fails on its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEvents } from '../team/events.mjs';
import { listRequests } from './approvals.mjs';
import { roomHome } from './config.mjs';
import { readInbox, readLogWatch } from './feeds.mjs';
import { strings } from './i18n.mjs';
import { readLoop } from './loops.mjs';
import { extractFact, pickSections, tableRows } from './markdown.mjs';
import { computeMetrics } from './metrics.mjs';
import { readRepo } from './repos.mjs';
import { readHistory, readSessions } from './sessions.mjs';

const DAY = 86_400_000;
const MAX_TEXT = 1024 * 1024;
const UUID = /^\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function readText(file, cache) {
  if (cache.has(file)) return cache.get(file);
  let result;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, MAX_TEXT));
      fs.readSync(fd, buf, 0, buf.length, 0);
      result = { text: buf.toString('utf8') };
    } finally { fs.closeSync(fd); }
  } catch (e) {
    result = { error: `cannot read ${file} (${e.code || e.message})` };
  }
  cache.set(file, result);
  return result;
}

function listMd(dir) {
  const names = fs.readdirSync(dir);
  const out = [];
  for (const name of names) {
    if (!/\.md$/i.test(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) out.push({ file: path.join(dir, name), name, mtime: st.mtimeMs });
    } catch { /* gone */ }
  }
  return out;
}

function coordinatorIds(file, cache) {
  const r = readText(file, cache);
  if (r.error) return { ids: [], error: r.error };
  const ids = [];
  for (const line of r.text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = UUID.exec(line);
    if (m) ids.push(m[1].toLowerCase());
  }
  return { ids };
}

function teamQuestions(repoPath, project) {
  const dir = path.join(repoPath, '.offlimits', 'team', 'questions');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!/\.md$/.test(name)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = /^- \[([^\]]+)\]\s*(.+)$/.exec(line);
      if (m) out.push({ project, lane: name.replace(/\.md$/, ''), ts: m[1], text: m[2].slice(0, 500) });
    }
  }
  return out;
}

const shortSha = (s) => (s ? String(s).slice(0, 8) : null);

async function readProject(p, ctx) {
  const { now, staleDays, cache, problems, readRepoFn } = ctx;
  const say = (msg) => problems.push(`${p.name}: ${msg}`);
  const out = { id: p.id, name: p.name, repos: [], facts: [], ledgers: [], decisions: [], approvals: null, loops: [], inbox: [], logs: [], questions: [], coordinator: { ids: [], current: null, session: null }, sessions: [] };

  const rows = [];
  for (const g of p.ledgers) {
    const r = readText(g.file, cache);
    if (r.error) {
      out.ledgers.push({ name: g.name, file: g.file, sections: [], error: r.error });
      say(r.error);
      continue;
    }
    const sections = pickSections(r.text, g.sections);
    const decisions = pickSections(r.text, g.decisions);
    for (const s of [...sections, ...decisions]) rows.push(...tableRows(s.blocks));
    out.ledgers.push({ name: g.name, file: g.file, sections });
    for (const d of decisions) out.decisions.push({ project: p.id, ledger: g.name, ...d });
  }
  for (const f of p.facts) {
    const r = readText(f.file, cache);
    if (r.error) {
      out.facts.push({ label: f.label, value: null, error: r.error });
      say(r.error);
    } else out.facts.push({ label: f.label, value: extractFact(r.text, f.regex) });
  }
  let deliveryFiles = [];
  if (p.deliveries) {
    try { deliveryFiles = listMd(p.deliveries.dir); } catch (e) {
      say(`cannot read ${p.deliveries.dir} (${e.code || e.message})`);
    }
  }
  out.repos = await Promise.all(p.repos.map(async (repo) => {
    let teamDeliveries = [];
    try { teamDeliveries = listMd(path.join(repo.path, '.offlimits', 'team', 'deliveries')); } catch { /* no team mode */ }
    const r = await readRepoFn(repo, { now, staleDays, deliveryFiles: [...deliveryFiles, ...teamDeliveries], ledgerRows: rows })
      .catch((e) => ({ name: repo.name, path: repo.path, base: repo.base, baseHead: null, todayCommits: [], lanes: [], error: `cannot read ${repo.path} (${e && e.message ? e.message : e})` }));
    if (r.error) say(r.error);
    out.questions.push(...teamQuestions(repo.path, p.id));
    return r;
  }));
  if (p.approvals) {
    const r = listRequests(p.approvals, { now });
    if (r.error) say(r.error);
    out.approvals = {
      error: r.error,
      items: r.items.map((i) => ({
        id: i.id, project: p.id, projectName: p.name, file: path.basename(i.file), title: i.header.title, from: i.header.from,
        date: i.header.date, impact: i.header.impact, reversible: i.header.reversible, due: i.header.due,
        options: i.options, answers: i.answers, answered: i.answered, requestedAt: i.requestedAt, ageMs: i.ageMs, mtime: i.mtime,
      })),
    };
  }
  out.loops = p.loops.map((cfg) => {
    const r = readLoop(cfg, { now });
    if (r.error) say(`${cfg.name}: ${r.error}`);
    return { ...r, project: p.id, runValue: cfg.status.run, pauseValue: cfg.status.pause };
  });
  out.inbox = p.inbox.map((cfg) => {
    const r = readInbox(cfg);
    if (r.error) say(r.error);
    return r;
  });
  out.logs = p.logs.map((cfg) => {
    const r = readLogWatch(cfg);
    if (r.error) say(r.error);
    return r;
  });
  if (p.coordinatorFile) {
    const c = coordinatorIds(p.coordinatorFile, cache);
    if (c.error) say(c.error);
    out.coordinator.ids = c.ids;
    out.coordinator.current = c.ids[0] ?? null;
  }
  out.deliveryFiles = deliveryFiles;
  return out;
}

/**
 * @param {object} config room config
 * @param {{now?: () => number, env?: object, homedir?: () => string, problems?: string[], platform?: string}} [opts]
 */
export async function buildSnapshot(config, { now = Date.now, env = process.env, homedir = os.homedir, problems: given = [], platform = process.platform, readRepo: readRepoFn = readRepo } = {}) {
  const started = Date.now();
  const t = now();
  const problems = [...given];
  const cache = new Map();
  const projects = await Promise.all(config.projects.map((p) => readProject(p, { now, staleDays: config.staleDays, cache, problems, readRepoFn })));

  const dirs = [];
  for (const p of projects) for (const r of p.repos) for (const l of r.lanes) dirs.push({ dir: l.path, project: p.id, lane: l.main ? null : l.id });
  const coordinators = projects.flatMap((p) => p.coordinator.ids);
  const { sessions, limitNotice } = readSessions(config.claude.dir, dirs, { now, liveMinutes: config.claude.liveMinutes, coordinatorIds: coordinators, platform });
  const allLanes = [];
  for (const p of projects) {
    p.sessions = sessions.filter((s) => s.project === p.id);
    p.coordinator.session = p.sessions.find((s) => s.id === p.coordinator.current) ?? null;
    for (const r of p.repos) for (const l of r.lanes) {
      l.sessions = p.sessions.filter((s) => s.dir === l.path);
      if (l.state === 'stale' && l.sessions.some((s) => s.state !== 'quiet')) l.state = 'building';
      if (!l.main) allLanes.push(l);
    }
  }

  const history = config.claude.history
    ? readHistory(config.claude.dir, projects.map((p) => ({ id: p.id, dirs: p.repos.flatMap((r) => [r.path, ...r.lanes.map((l) => l.path)]) })), { now, days: 14, patterns: config.claude.orchestration, platform })
    : null;

  const since = t - 14 * DAY;
  const events = [];
  for (const p of projects) for (const r of p.repos) {
    for (const e of readEvents(path.join(r.path, '.offlimits', 'team', 'events.jsonl'), { sinceMs: since })) events.push({ ...e, project: e.project ?? p.id });
  }
  events.push(...readEvents(path.join(roomHome(env, homedir), 'events.jsonl'), { sinceMs: since }));
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const requests = projects.flatMap((p) => (p.approvals ? p.approvals.items : []));
  const midnight = new Date(t);
  midnight.setHours(0, 0, 0, 0);
  const m0 = midnight.getTime();
  const today = [];
  for (const e of events) {
    const ts = Date.parse(e.ts);
    if (ts >= m0) today.push({ ts, kind: 'event', project: e.project ?? null, text: `${e.type}${e.lane ? ` ${e.lane}` : ''}${e.note ? `: ${e.note}` : ''}`, source: 'events' });
  }
  for (const p of projects) {
    for (const r of p.repos) for (const c of r.todayCommits) today.push({ ts: c.ts, kind: 'commit', project: p.id, text: c.subject, sha: shortSha(c.sha), source: r.name });
    for (const q of p.approvals ? p.approvals.items : []) for (const a of q.answers) {
      const ts = a.at ? Date.parse(a.at) : NaN;
      if (ts >= m0) today.push({ ts, kind: 'approval', project: p.id, text: `${q.id}: ${a.text}`, source: q.file });
    }
    for (const d of p.deliveryFiles) if (d.mtime >= m0) today.push({ ts: d.mtime, kind: 'delivery', project: p.id, text: d.name, source: 'deliveries' });
    for (const box of p.inbox) for (const it of box.items) if (it.mtime >= m0) today.push({ ts: it.mtime, kind: 'inbox', project: p.id, text: it.text || it.file, source: box.name });
    delete p.deliveryFiles;
  }
  today.sort((a, b) => a.ts - b.ts);

  const metrics = computeMetrics({ events, requests, lanes: allLanes, history, now });
  const open = requests.filter((r) => !r.answered);
  const waiting = sessions.filter((s) => s.state === 'waiting');
  const loopsAttention = projects.flatMap((p) => p.loops.filter((l) => l.error || (l.status === l.runValue && l.running === false)).map((l) => ({ project: p.id, id: l.id, name: l.name, status: l.status, running: l.running, error: l.error ?? null })));
  return {
    v: 1,
    generatedAt: new Date(t).toISOString(),
    lang: config.language,
    strings: strings(config.language),
    summary: {
      projects: projects.length,
      lanes: metrics.openLanes,
      approvals: open.length,
      waiting: waiting.length,
      working: sessions.filter((s) => s.state === 'working').length,
      stale: metrics.staleLanes,
      cleanup: metrics.cleanupLanes,
      problems: problems.length,
    },
    needsYou: {
      approvals: open,
      sessions: waiting,
      questions: projects.flatMap((p) => p.questions),
      decisions: projects.flatMap((p) => p.decisions),
      loops: loopsAttention,
    },
    projects,
    claude: { live: sessions.filter((s) => s.state !== 'quiet').length, limitNotice, history },
    today,
    metrics,
    problems,
    timings: { totalMs: Date.now() - started },
  };
}
