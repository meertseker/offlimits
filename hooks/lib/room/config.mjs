// Control room configuration: <home>/room.json (or --config), else the current repository. Never throws.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commonRoot } from '../git.mjs';
import { expandHome } from '../paths.mjs';

export const ROOM_DEFAULTS = Object.freeze({ language: 'en', port: 4747, staleDays: 5, liveMinutes: 30 });
export const LANGUAGES = Object.freeze(['en', 'tr']);

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const BASE_RE = /^[\w./-]+$/;
const TOP_KEYS = ['language', 'port', 'staleDays', 'claude', 'projects'];
const CLAUDE_KEYS = ['dir', 'liveMinutes', 'history', 'orchestration'];
const PROJECT_KEYS = ['id', 'name', 'repo', 'repos', 'deliveries', 'approvals', 'loops', 'ledgers', 'facts', 'coordinatorFile', 'inbox', 'logs'];
const LOOP_KEYS = ['id', 'name', 'dir', 'status', 'stopFile', 'markers', 'tasks', 'log', 'liveMinutes', 'startHint'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** `$OFFLIMITS_HOME`, else `~/.offlimits`. */
export function roomHome(env = process.env, homedir = os.homedir) {
  return env.OFFLIMITS_HOME ? path.resolve(env.OFFLIMITS_HOME) : path.join(homedir(), '.offlimits');
}

/** `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeHome(env = process.env, homedir = os.homedir) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(homedir(), '.claude');
}

const FOLD = { ş: 's', ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ü: 'u', â: 'a', î: 'i', û: 'u' };

/** A lower-case ASCII id from a display name: "Şehir pazarı" gives "sehir-pazari". */
export function slug(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[şçğıöüâîû]/g, (c) => FOLD[c])
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function compiles(source, flags = '') {
  try { new RegExp(source, flags); return true; } catch { return false; }
}

function captureGroups(source) {
  try { return new RegExp(`${source}|`).exec('').length - 1; } catch { return -1; }
}

function osUser() {
  try { return os.userInfo().username || 'human'; } catch { return 'human'; }
}

function uniqueId(base, taken) {
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base.slice(0, 36)}-${i}`;
  taken.add(id);
  return id;
}

/**
 * Validate a parsed room.json. Bad entries become problems and are skipped or defaulted.
 * @returns {{config: object, problems: string[]}}
 */
function validate(data, { baseDir, env, homedir }) {
  const problems = [];
  const say = (where, what) => problems.push(`room.json: ${where} ${what}`);
  const home = homedir();
  const at = (p) => path.resolve(baseDir, expandHome(p, home));
  const config = {
    language: ROOM_DEFAULTS.language,
    port: ROOM_DEFAULTS.port,
    staleDays: ROOM_DEFAULTS.staleDays,
    claude: { dir: claudeHome(env, homedir), liveMinutes: ROOM_DEFAULTS.liveMinutes, history: true, orchestration: [] },
    projects: [],
  };
  if (!isObject(data)) {
    say('top level', 'must be an object');
    return { config, problems };
  }
  for (const key of Object.keys(data)) if (!TOP_KEYS.includes(key)) say(`unknown key "${key}"`, 'ignored');
  if ('language' in data) {
    if (LANGUAGES.includes(data.language)) config.language = data.language;
    else say('"language"', `must be one of ${LANGUAGES.join(', ')}`);
  }
  if ('port' in data) {
    if (intIn(data.port, 1024, 65535)) config.port = data.port;
    else say('"port"', 'must be an integer from 1024 to 65535');
  }
  if ('staleDays' in data) {
    if (intIn(data.staleDays, 1, 365)) config.staleDays = data.staleDays;
    else say('"staleDays"', 'must be an integer from 1 to 365');
  }
  if ('claude' in data) {
    const c = data.claude;
    if (!isObject(c)) say('"claude"', 'must be an object');
    else {
      for (const key of Object.keys(c)) if (!CLAUDE_KEYS.includes(key)) say(`unknown key "claude.${key}"`, 'ignored');
      if ('dir' in c) {
        if (nonEmpty(c.dir)) config.claude.dir = at(c.dir);
        else say('claude.dir', 'must be a path');
      }
      if ('liveMinutes' in c) {
        if (intIn(c.liveMinutes, 1, 1440)) config.claude.liveMinutes = c.liveMinutes;
        else say('claude.liveMinutes', 'must be an integer from 1 to 1440');
      }
      if ('history' in c) {
        if (typeof c.history === 'boolean') config.claude.history = c.history;
        else say('claude.history', 'must be true or false');
      }
      if ('orchestration' in c) {
        if (!isStringArray(c.orchestration)) say('claude.orchestration', 'must be an array of regular expressions');
        else c.orchestration.forEach((s, i) => {
          if (s && compiles(s, 'i')) config.claude.orchestration.push(s);
          else say(`claude.orchestration[${i}]`, 'is not a valid regular expression; skipped');
        });
      }
    }
  }
  if ('projects' in data && !Array.isArray(data.projects)) say('"projects"', 'must be an array');
  const taken = new Set();
  (Array.isArray(data.projects) ? data.projects : []).forEach((raw, pi) => {
    const where = `projects[${pi}]`;
    if (!isObject(raw)) {
      say(where, 'must be an object; skipped');
      return;
    }
    const p = project(raw, where, { at, say, taken });
    if (p) config.projects.push(p);
  });
  return { config, problems };
}

function project(raw, where, { at, say, taken }) {
  for (const key of Object.keys(raw)) if (!PROJECT_KEYS.includes(key)) say(`${where}: unknown key "${key}"`, 'ignored');
  const repos = [];
  const repoList = [...(raw.repo !== undefined ? [raw.repo] : []), ...(Array.isArray(raw.repos) ? raw.repos : [])];
  if (raw.repos !== undefined && !Array.isArray(raw.repos)) say(`${where}.repos`, 'must be an array');
  repoList.forEach((r, ri) => {
    const rw = raw.repo !== undefined && ri === 0 ? `${where}.repo` : `${where}.repos[${raw.repo !== undefined ? ri - 1 : ri}]`;
    const spec = typeof r === 'string' ? { path: r } : r;
    if (!isObject(spec) || !nonEmpty(spec.path)) {
      say(rw, 'must be a path or {path, name?, base?}; skipped');
      return;
    }
    let base = null;
    if (spec.base !== undefined && spec.base !== null) {
      if (typeof spec.base !== 'string' || !BASE_RE.test(spec.base) || spec.base.startsWith('-')) {
        say(`${rw}.base`, 'must be a branch or ref name; repository skipped');
        return;
      }
      base = spec.base;
    }
    const full = at(spec.path);
    repos.push({ name: nonEmpty(spec.name) ? spec.name.trim() : path.basename(full), path: full, base });
  });
  const name = nonEmpty(raw.name) ? raw.name.trim() : nonEmpty(raw.id) ? raw.id : repos[0] ? repos[0].name : '';
  if (!name) {
    say(where, 'needs a "name" or a repository; skipped');
    return null;
  }
  let idBase = nonEmpty(raw.id) && ID_RE.test(raw.id) ? raw.id : slug(name);
  if (nonEmpty(raw.id) && !ID_RE.test(raw.id)) say(`${where}.id`, `must match ${ID_RE.source}; derived from the name`);
  if (!idBase) idBase = `project-${taken.size + 1}`;
  const out = {
    id: uniqueId(idBase, taken), name, repos,
    deliveries: null, approvals: null, loops: [], ledgers: [], facts: [], coordinatorFile: null, inbox: [], logs: [],
  };

  if (raw.deliveries !== undefined) {
    const d = typeof raw.deliveries === 'string' ? { dir: raw.deliveries } : raw.deliveries;
    if (isObject(d) && nonEmpty(d.dir)) out.deliveries = { dir: at(d.dir) };
    else say(`${where}.deliveries`, 'must be a folder or {dir}');
  }
  if (raw.approvals !== undefined) {
    const a = typeof raw.approvals === 'string' ? { dir: raw.approvals } : raw.approvals;
    if (!isObject(a) || !nonEmpty(a.dir)) say(`${where}.approvals`, 'must be a folder or {dir, answerPrefix?, actor?, channel?, ignore?}');
    else {
      const prefix = a.answerPrefix === undefined ? 'ANSWER:' : a.answerPrefix;
      const okPrefix = typeof prefix === 'string' && prefix.trim() && prefix.length <= 20 && !/[\r\n]/.test(prefix);
      if (!okPrefix) say(`${where}.approvals.answerPrefix`, 'must be a short one-line text; using ANSWER:');
      out.approvals = {
        dir: at(a.dir),
        answerPrefix: okPrefix ? prefix.trim() : 'ANSWER:',
        actor: nonEmpty(a.actor) ? a.actor.trim().slice(0, 64) : osUser(),
        channel: nonEmpty(a.channel) ? a.channel.trim().slice(0, 32) : 'room',
        ignore: isStringArray(a.ignore) ? [...a.ignore] : ['TEMPLATE.md', 'README.md'],
      };
    }
  }
  const list = (key) => {
    if (raw[key] === undefined) return [];
    if (!Array.isArray(raw[key])) {
      say(`${where}.${key}`, 'must be an array');
      return [];
    }
    return raw[key];
  };
  const loopIds = new Set();
  list('loops').forEach((l, i) => {
    const lw = `${where}.loops[${i}]`;
    if (!isObject(l) || !nonEmpty(l.dir)) {
      say(lw, 'needs a "dir"; skipped');
      return;
    }
    for (const key of Object.keys(l)) if (!LOOP_KEYS.includes(key)) say(`${lw}: unknown key "${key}"`, 'ignored');
    const st = isObject(l.status) ? l.status : {};
    const pick = (v, d) => (nonEmpty(v) ? v.trim() : d);
    const lname = nonEmpty(l.name) ? l.name.trim() : path.basename(at(l.dir));
    let tasks = null;
    if (l.tasks !== undefined && l.tasks !== null) {
      if (isObject(l.tasks) && nonEmpty(l.tasks.file)) {
        tasks = { file: l.tasks.file.trim(), done: pick(l.tasks.done, 'done'), blocked: pick(l.tasks.blocked, 'blocked'), id: pick(l.tasks.id, 'id'), title: pick(l.tasks.title, 'title') };
      } else say(`${lw}.tasks`, 'must be {file, done?, blocked?, id?, title?}; ignored');
    }
    let live = ROOM_DEFAULTS.liveMinutes;
    if (l.liveMinutes !== undefined) {
      if (intIn(l.liveMinutes, 1, 1440)) live = l.liveMinutes;
      else say(`${lw}.liveMinutes`, 'must be an integer from 1 to 1440');
    }
    out.loops.push({
      id: uniqueId(nonEmpty(l.id) && ID_RE.test(l.id) ? l.id : slug(lname) || `loop-${i + 1}`, loopIds),
      name: lname,
      dir: at(l.dir),
      status: { file: pick(st.file, 'status.json'), field: pick(st.field, 'status'), run: pick(st.run, 'run'), pause: pick(st.pause, 'paused') },
      stopFile: l.stopFile === null ? null : pick(l.stopFile, 'STOP'),
      markers: isStringArray(l.markers) ? l.markers.filter(nonEmpty) : [],
      tasks,
      log: nonEmpty(l.log) ? l.log.trim() : null,
      liveMinutes: live,
      startHint: nonEmpty(l.startHint) ? l.startHint.trim().slice(0, 200) : null,
    });
  });
  list('ledgers').forEach((g, i) => {
    if (!isObject(g) || !nonEmpty(g.file)) {
      say(`${where}.ledgers[${i}]`, 'needs a "file"; skipped');
      return;
    }
    const file = at(g.file);
    out.ledgers.push({
      name: nonEmpty(g.name) ? g.name.trim() : path.basename(file),
      file,
      sections: isStringArray(g.sections) ? g.sections.filter(nonEmpty) : [],
      decisions: isStringArray(g.decisions) ? g.decisions.filter(nonEmpty) : [],
    });
  });
  list('facts').forEach((f, i) => {
    const fw = `${where}.facts[${i}]`;
    if (!isObject(f) || !nonEmpty(f.label) || !nonEmpty(f.file) || typeof f.regex !== 'string') {
      say(fw, 'needs "label", "file" and "regex"; skipped');
      return;
    }
    const groups = captureGroups(f.regex);
    if (groups < 0 || groups > 1) {
      say(fw, 'regex must be valid with at most one capture group; skipped');
      return;
    }
    out.facts.push({ label: f.label.trim(), file: at(f.file), regex: f.regex });
  });
  if (raw.coordinatorFile !== undefined) {
    if (nonEmpty(raw.coordinatorFile)) out.coordinatorFile = at(raw.coordinatorFile);
    else say(`${where}.coordinatorFile`, 'must be a path');
  }
  list('inbox').forEach((b, i) => {
    const bw = `${where}.inbox[${i}]`;
    if (!isObject(b) || !nonEmpty(b.dir)) {
      say(bw, 'needs a "dir"; skipped');
      return;
    }
    let limit = 5;
    if (b.limit !== undefined) {
      if (intIn(b.limit, 1, 20)) limit = b.limit;
      else say(`${bw}.limit`, 'must be an integer from 1 to 20; using 5');
    }
    const dir = at(b.dir);
    out.inbox.push({ name: nonEmpty(b.name) ? b.name.trim() : path.basename(dir), dir, limit });
  });
  list('logs').forEach((g, i) => {
    const gw = `${where}.logs[${i}]`;
    if (!isObject(g) || !nonEmpty(g.file)) {
      say(gw, 'needs a "file"; skipped');
      return;
    }
    const ok = g.ok === undefined ? '\\bOK\\b' : g.ok;
    const error = g.error === undefined ? 'ERROR' : g.error;
    if (typeof ok !== 'string' || typeof error !== 'string' || !compiles(ok) || !compiles(error)) {
      say(gw, '"ok" and "error" must be valid regular expressions; skipped');
      return;
    }
    const file = at(g.file);
    out.logs.push({ name: nonEmpty(g.name) ? g.name.trim() : path.basename(file), file, ok, error });
  });
  return out;
}

/** A one-project config for the repository `cwd` is in, or null. */
function repoConfig(cwd, env, homedir) {
  const root = commonRoot(cwd);
  if (!root) return null;
  let full = root;
  try { full = fs.realpathSync.native(root); } catch { /* keep git's form */ }
  const name = path.basename(full);
  const { config } = validate({ projects: [{ name, repo: full }] }, { baseDir: full, env, homedir });
  return config;
}

/**
 * Load the control room configuration. Never throws.
 * @param {{file?: string, cwd?: string, env?: object, homedir?: () => string, readFile?: Function}} [opts]
 * @returns {{config: object, problems: string[], source: 'file'|'repo'|null, file: string|null}}
 */
export function loadRoomConfig({ file, cwd = process.cwd(), env = process.env, homedir = os.homedir, readFile = fs.readFileSync } = {}) {
  const target = file ? path.resolve(cwd, file) : path.join(roomHome(env, homedir), 'room.json');
  let text = null;
  try { text = String(readFile(target, 'utf8')); } catch (e) {
    if (file) {
      const { config } = validate({}, { baseDir: cwd, env, homedir });
      return { config, problems: [`cannot read ${target} (${e.code || e.message})`], source: null, file: target };
    }
  }
  if (text !== null) {
    let data;
    try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
      const { config } = validate({}, { baseDir: cwd, env, homedir });
      return { config, problems: [`${target} is not valid JSON (${e.message})`], source: null, file: target };
    }
    const { config, problems } = validate(data, { baseDir: path.dirname(target), env, homedir });
    return { config, problems, source: 'file', file: target };
  }
  const repo = repoConfig(cwd, env, homedir);
  if (repo) return { config: repo, problems: [], source: 'repo', file: null };
  const { config } = validate({}, { baseDir: cwd, env, homedir });
  return { config, problems: [`no room.json at ${target} and ${cwd} is not inside a git repository`], source: null, file: null };
}
