import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadTeam } from './config.mjs';
import { teamDir, ensureTeamDir } from './state.mjs';

const START = '<!-- offlimits:team:start -->';
const END = '<!-- offlimits:team:end -->';
const TEMPLATES = new URL('../../../templates/', import.meta.url);

/**
 * Is `dir` inside a git repository? Looks only at the filesystem (a `.git` folder or file in dir or a parent, or GIT_DIR),
 * so a failing git call can never make an existing repository look missing.
 */
export function insideGitRepo(dir, env = process.env) {
  if (env.GIT_DIR) return true;
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

/** The home directory or a drive/filesystem root: never somewhere to auto-`git init`. */
export function isUnsafeInitDir(dir, home = os.homedir(), platform = process.platform) {
  const d = path.resolve(dir);
  const norm = (p) => (platform === 'win32' ? p.toLowerCase() : p);
  return d === path.parse(d).root || norm(d) === norm(path.resolve(home));
}

/** Run `git init` in `dir` (argument array). Caller has already checked that no repository contains it. */
export function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
}

/** Render `templates/<name>`, replacing `{{key}}`. Unknown keys stay as written. */
export function renderTemplate(name, vars = {}) {
  const text = fs.readFileSync(new URL(name, TEMPLATES), 'utf8').replace(/\r\n/g, '\n');
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? vars[k] : m));
}

const bullets = (items, none, wrap = (s) => s) => (items.length ? items.map((s) => `- ${wrap(s)}`).join('\n') : none);

// Mert's choice: unattended team windows stall on permission prompts; the gate is what keeps bypass safe.
const newTeam = (language) => ({ language: language || 'en', permissionMode: 'bypassPermissions' });

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * Turn `root` into a team repository. Idempotent; never touches text outside the managed markers.
 * @returns {{changed: string[], notes: string[]}}
 */
export function runInit(root, { language } = {}) {
  const changed = [];
  const notes = [];
  const write = (rel, text) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    changed.push(rel.split(path.sep).join('/'));
  };

  // offlimits.json
  const cfgText = readIfExists(path.join(root, 'offlimits.json'));
  if (cfgText === null) {
    write('offlimits.json', JSON.stringify({ defaultRole: 'worker', team: newTeam(language) }, null, 2) + '\n');
  } else {
    let data = null;
    try { data = JSON.parse(cfgText.replace(/^\uFEFF/, '')); } catch { /* reported below */ }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      notes.push('offlimits.json is not valid JSON; fix it and run init again');
    } else {
      let dirty = false;
      if (!('defaultRole' in data)) { data.defaultRole = 'worker'; dirty = true; }
      if (!('team' in data)) { data.team = newTeam(language); dirty = true; }
      if (dirty) write('offlimits.json', JSON.stringify(data, null, 2) + '\n');
    }
  }

  // CLAUDE.md managed block
  const { team } = loadTeam(root);
  const block = renderTemplate('claude-block.md', {
    rules: bullets(team.rules, '- (none yet)'),
    checks: bullets(team.checks, '- (none configured)', (c) => `\`${c}\``),
  }).replace(/\n+$/, '');
  const mdText = readIfExists(path.join(root, 'CLAUDE.md'));
  let next;
  if (mdText === null) {
    next = block + '\n';
  } else {
    const count = (m) => mdText.split(m).length - 1;
    const s = mdText.indexOf(START);
    const e = mdText.indexOf(END);
    if (count(START) === 0 && count(END) === 0) {
      const sep = mdText === '' ? '' : mdText.endsWith('\n') ? '\n' : '\n\n';
      next = mdText + sep + block + '\n';
    } else if (count(START) === 1 && count(END) === 1 && s < e) {
      // The managed block itself is always written with LF; bytes outside the markers are untouched.
      next = mdText.slice(0, s) + block + mdText.slice(e + END.length);
    } else {
      notes.push('CLAUDE.md has an unpaired or duplicated offlimits:team marker; fix it and run init again');
      next = mdText;
    }
  }
  if (next !== mdText) write('CLAUDE.md', next);

  // .gitignore
  const gi = readIfExists(path.join(root, '.gitignore'));
  if (gi === null || !gi.split(/\r?\n/).some((l) => l.trim() === '.offlimits/')) {
    write('.gitignore', (gi ?? '') + (gi && !gi.endsWith('\n') ? '\n' : '') + '.offlimits/\n');
  }

  // PR template
  const pr = path.join('.github', 'pull_request_template.md');
  if (!fs.existsSync(path.join(root, pr))) write(pr, renderTemplate('pull_request_template.md'));

  ensureTeamDir(teamDir(root) ?? path.join(root, '.offlimits', 'team'));
  return { changed, notes };
}
