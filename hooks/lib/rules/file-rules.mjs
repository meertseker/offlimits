// Protected-file rule: blocks workers from writing hook config and policy files.

import os from 'node:os';
import { globMatch, normalizeRel, resolvePath, isAbsolutePath, isAncestorOrSelf, expandHome } from '../paths.mjs';
import { tokens, stripAssignments, baseName, skipWrapperArgs, WRAPPERS } from '../shell.mjs';

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// commands whose every positional is removed or moved away (parents count too)
const REMOVERS = new Set(['rm', 'rmdir', 'unlink', 'del', 'erase', 'rd', 'ri', 'remove-item']);
const MOVERS = new Set(['mv', 'move', 'mi', 'move-item']);
const RENAMERS = new Set(['rename-item', 'ren', 'rni']);
const COPIERS = new Set(['cp', 'copy', 'cpi', 'copy-item', 'install', 'ln', 'rsync', 'scp']);
const EVERY_POSITIONAL = new Set(['truncate', 'shred', 'touch']);
const FIRST_POSITIONAL = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'tee-object']);
const PS_VALUE_PARAMS = new Set([
  'value', 'encoding', 'filter', 'include', 'exclude', 'itemtype', 'stream', 'width', 'delimiter',
  'name', 'credential', 'destination', 'path', 'filepath', 'literalpath', 'type', 'newname', 'inputobject', 'variable',
]);
// POSIX value flags per copier (the value is not a path we care about, or it is the target dir)
const COPY_VALUES = {
  cp: ['-S', '--suffix'],
  install: ['-m', '--mode', '-o', '--owner', '-g', '--group', '-S', '--suffix'],
  ln: ['-S', '--suffix'],
  rsync: ['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--files-from', '--exclude-from', '--include-from',
    '--password-file', '--log-file', '--backup-dir', '--temp-dir', '-T', '--partial-dir', '--chmod', '--chown', '--suffix', '-B', '--block-size'],
  scp: ['-P', '-i', '-o', '-F', '-l', '-S', '-c', '-J'],
};
const GLOB = /[*?[{]/;
const DISABLE_HOOKS = /disableAllHooks/i;

const base = baseName;
const isRemote = (p) => /^[^/\\]{2,}:/.test(p) && !/^[A-Za-z]:[\\/]?/.test(p);

function parentChain(globs) {
  // literal directory prefix of each glob (up to the first wildcard segment)
  return globs.map((g) => {
    const segs = g.replaceAll('\\', '/').split('/');
    const lit = [];
    for (const s of segs) {
      if (/[*?]/.test(s)) break;
      lit.push(s);
    }
    return lit.join('/');
  });
}

const homeOf = (ctx) => ctx.home ?? os.homedir();
const envOf = (ctx) => ctx.env ?? process.env;

/** Repository roots a relative protected glob is anchored at: the worktree and the main worktree. */
function roots(ctx) {
  const out = [];
  for (const r of [ctx.repoRoot ?? ctx.cwd, ctx.commonRoot]) {
    if (typeof r === 'string' && r && !out.some((x) => isAncestorOrSelf(x, r) && isAncestorOrSelf(r, x))) out.push(r);
  }
  return out;
}

/** Absolute user-level files that are always protected (Claude Code user settings). */
function userFiles(ctx) {
  const dirs = [`${homeOf(ctx)}/.claude`];
  const cfg = envOf(ctx).CLAUDE_CONFIG_DIR;
  if (typeof cfg === 'string' && cfg) dirs.push(cfg);
  return dirs.flatMap((d) => [`${d}/settings.json`, `${d}/settings.local.json`]);
}

/** The protected entry that absolute `abs` hits, or null. With `ancestors`, a parent directory counts. */
function hitAbs(abs, ctx, ancestors) {
  const globs = ctx.policy.protectedPaths ?? [];
  const lits = parentChain(globs);
  for (const root of roots(ctx)) {
    const rel = normalizeRel(root, abs);
    const direct = globs.find((g) => globMatch(g, rel));
    if (direct) return direct;
    if (!ancestors) continue;
    // "/" counts as above every root (on Windows it is a drive root or the Git Bash install dir)
    if (abs === '/' || isAncestorOrSelf(abs, root)) return globs[0] ?? root;
    const r = rel.toLowerCase();
    for (let k = 0; k < globs.length; k++) {
      if (lits[k] && lits[k].toLowerCase().startsWith(`${r}/`)) return globs[k];
    }
  }
  for (const f of userFiles(ctx)) {
    if (ancestors ? isAncestorOrSelf(abs, f) : isAncestorOrSelf(abs, f) && isAncestorOrSelf(f, abs)) return f;
  }
  return null;
}

/** Concrete paths a glob target could reach: protected literals, their parents, the roots and their parents. */
function candidates(ctx, ancestors) {
  const out = [];
  const globs = ctx.policy.protectedPaths ?? [];
  for (const root of roots(ctx)) {
    for (const lit of parentChain(globs)) {
      if (!lit) continue;
      const segs = lit.split('/');
      // the literal itself, and with ancestors every parent of it too
      for (let n = ancestors ? 1 : segs.length; n <= segs.length; n++) out.push(resolvePath(root, segs.slice(0, n).join('/')));
    }
    if (ancestors) {
      let r = resolvePath(root, '.');
      for (;;) {
        out.push(r);
        const up = resolvePath(r, '..');
        if (up === r) break;
        r = up;
      }
    }
  }
  for (const f of userFiles(ctx)) {
    let p = resolvePath(f, '.');
    out.push(p);
    if (ancestors) {
      for (;;) {
        const up = resolvePath(p, '..');
        if (up === p) break;
        out.push((p = up));
      }
    }
  }
  return out;
}

/** Most words one brace expansion may produce before the target counts as unsure. */
export const MAX_BRACE_WORDS = 256;
/** Most distinct write targets judged per segment or command line before the rest count as unsure. */
export const MAX_TARGETS = 256;

/** Distinct targets (by path and options), and whether the list was cut at MAX_TARGETS. */
function distinct(targets) {
  const seen = new Map();
  for (const t of targets) {
    const key = `${t.path}\0${t.ancestors ? 1 : 0}${t.dest ? 1 : 0}\0${t.dir ?? ''}`;
    if (!seen.has(key)) seen.set(key, t);
  }
  const list = [...seen.values()];
  return { list: list.slice(0, MAX_TARGETS), cut: list.length > MAX_TARGETS ? list[MAX_TARGETS] : null };
}

/** `{a,b}` brace expansion, in order; null when it would produce more than MAX_BRACE_WORDS words. */
function braces(p) {
  const out = [];
  const stack = [p];
  while (stack.length) {
    const s = stack.pop();
    const m = /\{([^{}]*,[^{}]*)\}/.exec(s);
    if (!m) {
      out.push(s);
      if (out.length > MAX_BRACE_WORDS) return null;
      continue;
    }
    const alts = m[1].split(',');
    if (stack.length + alts.length > MAX_BRACE_WORDS * 4) return null;
    for (let k = alts.length - 1; k >= 0; k--) stack.push(s.slice(0, m.index) + alts[k] + s.slice(m.index + m[0].length));
  }
  return out;
}

const globSafe = (p) => p.replace(/\[[^\]/]*\]/g, '?');

/** Literal leading directories of a glob path. */
const globPrefix = (p) => {
  const segs = p.split('/');
  const k = segs.findIndex((s) => /[*?]/.test(s));
  return segs.slice(0, k === -1 ? segs.length : k).join('/');
};

/** Segments of protected globs and user files; a relative target naming one of them is risky when the cwd is unknown. */
function riskySegments(ctx) {
  const set = new Set(['.claude', 'settings.json', 'settings.local.json']);
  for (const g of ctx.policy.protectedPaths ?? []) {
    for (const s of g.replaceAll('\\', '/').split('/')) if (s && !/[*?]/.test(s)) set.add(s.toLowerCase());
  }
  return set;
}

/**
 * Judge one write target.
 * @param {{path: string, ancestors?: boolean, dest?: boolean, dir?: string}} t
 * @returns {{hit: string, path: string, ancestors: boolean} | {unsure: string} | null}
 */
function judge(t, ctx, baseDir) {
  const home = homeOf(ctx);
  const words = braces(expandHome(t.path, home));
  if (words === null) return { unsure: t.path, why: 'braces' };
  // a decision-wide budget (ctx.work, set by decide) caps the brace words judged over all targets
  if (ctx.work && words.length > 1 && (ctx.work.words -= words.length) < 0) return { unsure: t.path, why: 'brace-budget' };
  for (const raw of words) {
    let p = raw;
    if (t.dir) p = `${expandHome(t.dir, home)}/${p}`;
    const abs = isAbsolutePath(p);
    if (!abs && baseDir === null) {
      const segs = p.replaceAll('\\', '/').split('/');
      const risky = riskySegments(ctx);
      if (segs.some((s) => s === '..' || GLOB.test(s) || risky.has(s.toLowerCase()))) return { unsure: raw, why: raw.includes('{}') ? 'find' : 'cwd' };
      continue;
    }
    const full = resolvePath(baseDir ?? ctx.cwd, globSafe(p));
    let ancestors = Boolean(t.ancestors);
    // a destination directory that is a repo root (or above it) must already exist: only its children are written
    if (t.dest && ancestors && roots(ctx).some((r) => isAncestorOrSelf(full, r))) ancestors = false;
    if (/[*?]/.test(full)) {
      const hitC = candidates(ctx, ancestors).find((c) => globMatch(full, c));
      if (hitC) return { hit: hitC, path: raw, ancestors };
      const pre = globPrefix(full);
      const h = pre && hitAbs(pre, ctx, false);
      if (h) return { hit: h, path: raw, ancestors };
      continue;
    }
    const h = hitAbs(full, ctx, ancestors);
    if (h) return { hit: h, path: raw, ancestors };
  }
  return null;
}

function deny(p, how, covers, ctx) {
  const extra = covers && GLOB.test(p) ? ` (it covers "${covers}")` : '';
  const who = ctx?.role === 'worker' ? 'a worker' : `the ${ctx?.role ?? 'solo'} role`;
  return {
    action: 'deny',
    rule: 'protected-file',
    reason: `${how} protected path "${p}"${extra} is not allowed for ${who} (it holds hook or policy configuration).`,
  };
}

function disableHooks(where) {
  return {
    action: 'deny',
    rule: 'protected-file',
    reason: `${where} mentions "disableAllHooks", which would switch the gate off.`,
  };
}

function unsureDecision(p, ctx, why) {
  const what = {
    braces: `Writing to "${p}", whose brace expansion has more than ${MAX_BRACE_WORDS} words`,
    'brace-budget': `Writing to "${p}" after the brace expansions of this command passed the hook's budget`,
    find: `Writing to "${p}", the files find -exec picks at run time`,
    targets: `Writing to more than ${MAX_TARGETS} paths (from "${p}" on)`,
  }[why] ?? `Writing to "${p}" after a directory change the hook cannot follow`;
  return {
    action: ctx.role === 'solo' ? 'ask' : 'deny',
    rule: 'protected-file',
    reason: `${what}; it may be a protected path.`,
  };
}

/** The directory relative segment paths resolve against: tracked `cd` cwd when known, null when unknown. */
function segmentBase(ctx) {
  if (ctx.segCwd === undefined) return ctx.cwd;
  if (ctx.segCwd === null) return null;
  let seg = String(ctx.segCwd);
  // On Windows, node's path.resolve('/repo', 'x') adds the current drive ("C:\repo\x"); a POSIX-style
  // session cwd ('/repo', '/c/repo') must keep its own form so it still compares with the roots.
  const drive = /^([A-Za-z]):[\\/]/.exec(seg);
  if (drive && process.platform === 'win32' && /^\//.test(String(ctx.cwd ?? ''))) {
    const cur = /^([A-Za-z]):/.exec(process.cwd())?.[1];
    if (cur && cur.toLowerCase() === drive[1].toLowerCase()) {
      const rest = seg.slice(2).replaceAll('\\', '/');
      const cwd = String(ctx.cwd).replaceAll('\\', '/');
      if (rest === cwd || rest.startsWith(`${cwd}/`) || cwd.startsWith(`${rest}/`) || rest.split('/')[1] === cwd.split('/')[1]) seg = rest;
    }
  }
  return resolvePath(ctx.cwd, seg);
}

/**
 * @param {string} toolName
 * @param {object} toolInput
 * @param {{policy: object, cwd: string, repoRoot: string | null, commonRoot?: string | null}} ctx
 */
export function checkFileTool(toolName, toolInput, ctx) {
  if (!FILE_TOOLS.has(toolName)) return null;
  const p = toolInput?.file_path ?? toolInput?.notebook_path ?? toolInput?.path;
  if (typeof p === 'string' && p !== '') {
    const abs = resolvePath(ctx.cwd ?? ctx.repoRoot, expandHome(p, homeOf(ctx)));
    if (hitAbs(abs, ctx, false)) return deny(p, `${toolName} on`, undefined, ctx);
  }
  let text = '';
  try {
    text = JSON.stringify(toolInput ?? {});
  } catch {
    text = '';
  }
  return DISABLE_HOOKS.test(text) ? disableHooks(`${toolName} input`) : null;
}

/** Targets of `>`, `>>`, `>|`, `&>`, `&>>`, `>&file` outside quotes. */
function redirectTargets(s) {
  const out = [];
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c !== '>') continue;
    let j = i + 1;
    if (s[j] === '>') j++;
    if (s[j] === '|') j++;
    else if (s[j] === '&') {
      if (/[\d-]/.test(s[j + 1] ?? '')) {
        i = j;
        continue;
      }
      j++;
    }
    while (j < s.length && /\s/.test(s[j])) j++;
    let wq = null;
    let k = j;
    for (; k < s.length; k++) {
      const d = s[k];
      if (wq) {
        if (d === wq) wq = null;
        continue;
      }
      if (d === "'" || d === '"') wq = d;
      else if (/[\s;&|<>()]/.test(d)) break;
    }
    const w = tokens(s.slice(j, k))[0];
    if (w) out.push(w);
    i = k - 1;
  }
  return out;
}

/** Split args into named parameters (lower-cased, `-Path:value` supported) and positionals. */
function parseArgs(args) {
  const named = {};
  const pos = [];
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    const m = /^-([A-Za-z][\w-]*)(?::(.*))?$/.exec(a);
    if (!m) {
      if (a !== '--') pos.push(a);
      continue;
    }
    const key = m[1].toLowerCase();
    let val = m[2];
    if (val === undefined && PS_VALUE_PARAMS.has(key) && n + 1 < args.length) val = args[++n];
    if (val !== undefined) (named[key] ??= []).push(val);
    else (named[key] ??= []).push(true);
  }
  return { named, pos };
}

const list = (v) => (v ?? []).filter((x) => typeof x === 'string').flatMap((x) => x.split(',')).filter(Boolean);

/** Index of the real command after wrappers, env assignments and their flags. */
function skipWrappers(t) {
  let i = 0;
  while (i < t.length) {
    if (/^[A-Za-z_]\w*=/.test(t[i])) {
      i++;
      continue;
    }
    if (!Object.hasOwn(WRAPPERS, base(t[i]))) break;
    i = skipWrapperArgs(t, i);
  }
  return i;
}

/** POSIX positionals, skipping the values of `values` flags; returns {pos, flags, valueOf}. */
function posix(args, values = []) {
  const pos = [];
  const flags = [];
  const vals = {};
  let end = false;
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    if (end || !a.startsWith('-') || a === '-') {
      pos.push(a);
      continue;
    }
    if (a === '--') {
      end = true;
      continue;
    }
    flags.push(a);
    const [flag, eq] = a.split(/=(.*)/s);
    if (values.includes(flag)) {
      const v = eq !== undefined ? eq : args[++n];
      (vals[flag] ??= []).push(v);
    }
  }
  return { pos, flags, vals };
}

const basenameOf = (p) => String(p).replace(/[?#].*$/, '').replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop();

/** Gather write targets for one segment. */
function writeTargets(segment) {
  const targets = redirectTargets(segment).map((path) => ({ path }));
  const t = tokens(stripAssignments(segment).rest ?? segment);
  const i = skipWrappers(t);
  const cmd = base(t[i] ?? '');
  const args = t.slice(i + 1);
  const add = (paths, opts = {}) => {
    for (const path of paths) if (typeof path === 'string' && path !== '') targets.push({ path, ...opts });
  };
  // copy-like: `sources` land in `dest` itself or in dest/<basename(source)>
  const copyTo = (dest, sources, recursive) => {
    if (typeof dest !== 'string' || !dest || isRemote(dest)) return;
    add([dest], { ancestors: recursive, dest: true });
    for (const s of sources) {
      const b = basenameOf(isRemote(s) ? s.slice(s.indexOf(':') + 1) : s);
      if (b && b !== '.' && b !== '..') add([`${dest.replace(/[\\/]+$/, '')}/${b}`], { ancestors: recursive, dest: true });
    }
  };

  if (cmd === 'tee') add(posix(args, ['-p']).pos);
  else if (cmd === 'sed') sed(args, add);
  else if (cmd === 'perl' || cmd === 'ruby') perl(args, add);
  else if (cmd === 'dd') {
    add(args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
  } else if (cmd === 'git') {
    git(args, add);
  } else if (cmd === 'curl') {
    curl(args, add);
  } else if (cmd === 'wget') {
    wget(args, add);
  } else if (COPY_VALUES[cmd]) {
    const { pos, flags, vals } = posix(args, [...COPY_VALUES[cmd], '-t', '--target-directory']);
    const recursive = cmd === 'rsync' ? flags.some((f) => /^-[a-zA-Z]*[ra]/.test(f) || f === '--recursive' || f === '--archive')
      : flags.some((f) => /^-[a-zA-Z]*[rRa]/.test(f) || f === '--recursive' || f === '--archive');
    const tdir = [...(vals['-t'] ?? []), ...(vals['--target-directory'] ?? [])];
    if (tdir.length) copyTo(tdir[0], pos, recursive);
    else if (pos.length >= 2) copyTo(pos[pos.length - 1], pos.slice(0, -1), recursive);
    else if (cmd === 'ln' && pos.length === 1) copyTo('.', pos, false);
  } else {
    const { named, pos } = parseArgs(args);
    const paths = [...list(named.path), ...list(named.literalpath)];
    if (REMOVERS.has(cmd)) add([...pos, ...paths], { ancestors: true });
    else if (MOVERS.has(cmd)) {
      const dest = list(named.destination)[0] ?? (pos.length >= 2 ? pos[pos.length - 1] : undefined);
      const sources = named.destination ? [...pos, ...paths] : [...pos.slice(0, dest === undefined ? pos.length : -1), ...paths];
      add(sources, { ancestors: true });
      copyTo(dest, sources, true);
    } else if (RENAMERS.has(cmd)) {
      const src = paths[0] ?? pos[0];
      const name = list(named.newname)[0] ?? (paths.length ? pos[0] : pos[1]);
      add([src], { ancestors: true });
      if (src && name) {
        const dir = String(src).replaceAll('\\', '/').replace(/\/+$/, '').split('/').slice(0, -1).join('/');
        add([dir ? `${dir}/${name}` : name], { ancestors: true, dest: true });
      }
    } else if (cmd === 'copy-item' || cmd === 'cpi' || cmd === 'copy') {
      const dest = list(named.destination)[0] ?? (pos.length + paths.length >= 2 ? pos[pos.length - 1] : undefined);
      const sources = named.destination ? [...pos, ...paths] : [...paths, ...pos.slice(0, -1)];
      copyTo(dest, sources, Boolean(named.recurse || named.r));
    } else if (EVERY_POSITIONAL.has(cmd)) add(pos);
    else if (cmd === 'new-item' || cmd === 'ni') {
      const ps = [...pos.slice(0, 1), ...paths];
      const name = list(named.name)[0];
      add(name ? ps.map((p) => `${p}/${name}`) : ps);
    } else if (FIRST_POSITIONAL.has(cmd)) {
      const p = [...paths, ...list(named.filepath)];
      add(p.length ? p : pos.slice(0, 1));
    }
  }
  dotnet(segment, add);
  return targets;
}

/** `[IO.File]::WriteAllText('x', ...)`, `[System.IO.Directory]::Delete('x')` and friends. */
function dotnet(segment, add) {
  const re = /\[(?:System\.)?IO\.(File|Directory)\]::(\w+)\s*\(([^)]*)\)/gi;
  for (const m of segment.matchAll(re)) {
    const method = m[2].toLowerCase();
    if (/^(read|exists|get|open(read|text)$|enumerate)/.test(method)) continue;
    const argsQ = [...m[3].matchAll(/'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"/g)].map((x) => (x[1] ?? x[2]).replaceAll("''", "'"));
    if (!argsQ.length) continue;
    if (method === 'copy') add(argsQ.slice(1, 2));
    else if (method === 'move' || method === 'replace') add(argsQ.slice(0, 2), { ancestors: true });
    else if (method === 'delete') add(argsQ.slice(0, 1), { ancestors: true });
    else add(argsQ.slice(0, 1));
  }
}

function sed(args, add) {
  const { pos, flags } = posix(args, ['-e', '--expression', '-f', '--file', '-l', '--line-length']);
  if (!flags.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return;
  const scripted = flags.some((a) => /^(-e|--expression|-f|--file)/.test(a) || /^-[a-zA-Z]*[ef]$/.test(a));
  add(scripted ? pos : pos.slice(1));
}

function perl(args, add) {
  let inplace = false;
  let code = false;
  const pos = [];
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    if (a === '--') {
      pos.push(...args.slice(n + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (/^-[a-zA-Z]*i/.test(a)) inplace = true;
      if (/^-[a-zA-Z]*[eE]$/.test(a)) {
        code = true;
        n++;
      } else if (/^-[IMm]$/.test(a)) n++;
      continue;
    }
    pos.push(a);
  }
  if (inplace) add(code ? pos : pos.slice(1));
}

function curl(args, add) {
  let remoteName = false;
  let dir = '';
  const urls = [];
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    if (a === '-o' || a === '--output') add([args[++n]].filter((x) => x !== '-'));
    else if (a.startsWith('--output=')) add([a.slice(9)].filter((x) => x !== '-'));
    else if (a === '--output-dir') dir = args[++n] ?? '';
    else if (a === '-O' || a === '--remote-name' || a === '--remote-name-all') remoteName = true;
    else if (/^-[a-zA-Z]/.test(a)) {
      // short-option cluster: -sSLo FILE, -oFILE, -sSO
      const m = /^-([a-np-zA-Z]*)o(.*)$/s.exec(a);
      if (/^-[a-zA-Z]*O/.test(a) && !m) remoteName = true;
      if (m) {
        if (m[1].includes('O')) remoteName = true;
        const v = m[2] !== '' ? m[2] : args[++n];
        add([v].filter((x) => x !== '-'));
      }
    } else if (!a.startsWith('-')) urls.push(a);
  }
  if (remoteName) add(urls.map((u) => basenameOf(u.replace(/^\w+:\/\/[^/]*/, ''))).filter(Boolean).map((b) => (dir ? `${dir}/${b}` : b)));
}

function wget(args, add) {
  let out = null;
  let prefix = '';
  let spider = false;
  const urls = [];
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    if (a === '-O' || a === '--output-document') out = args[++n] ?? '';
    else if (a.startsWith('--output-document=')) out = a.slice(18);
    else if (a === '-P' || a === '--directory-prefix') prefix = args[++n] ?? '';
    else if (a.startsWith('--directory-prefix=')) prefix = a.slice(19);
    else if (a === '--spider') spider = true;
    else if (/^-[a-zA-Z]/.test(a)) {
      // short-option cluster: -qO FILE, -qOFILE, -OFILE
      const m = /^-([a-zA-NP-Z]*)O(.*)$/s.exec(a);
      if (m) out = m[2] !== '' ? m[2] : (args[++n] ?? '');
      const p = /^-([a-zA-OQ-Z]*)P(.*)$/s.exec(a);
      if (!m && p) prefix = p[2] !== '' ? p[2] : (args[++n] ?? '');
    } else if (!a.startsWith('-')) urls.push(a);
  }
  if (spider) return;
  if (out !== null) {
    if (out !== '-') add([out]);
    return;
  }
  for (const u of urls) {
    const b = basenameOf(u.replace(/^\w+:\/\/[^/]*/, '')) || 'index.html';
    add([prefix ? `${prefix}/${b}` : b]);
  }
}

/** git subcommands that write, move or delete working-tree files. */
function git(args, add) {
  let k = 0;
  const dirs = [];
  while (k < args.length && args[k].startsWith('-')) {
    if (args[k] === '-C') dirs.push(args[k + 1]);
    k += args[k] === '-C' || args[k] === '-c' ? 2 : 1;
  }
  const dir = dirs.filter(Boolean).join('/') || undefined;
  const at = (opts = {}) => ({ ...opts, ...(dir ? { dir } : {}) });
  const put = (paths, opts) => {
    for (const p of paths) add([p], at(opts));
  };
  const sub = (args[k] ?? '').toLowerCase();
  const rest = args.slice(k + 1);
  const dd = rest.indexOf('--');
  if (sub === 'restore') {
    const paths = [];
    for (let n = 0; n < rest.length; n++) {
      if (rest[n] === '-s' || rest[n] === '--source') n++;
      else if (!rest[n].startsWith('-')) paths.push(rest[n]);
    }
    put(paths);
  } else if (sub === 'checkout') {
    if (dd >= 0) put(rest.slice(dd + 1));
    else {
      const pos = [];
      for (let n = 0; n < rest.length; n++) {
        if (/^(-b|-B|--orphan|--conflict)$/.test(rest[n])) n++;
        else if (!rest[n].startsWith('-')) pos.push(rest[n]);
      }
      put(pos); // the tree-ish is checked too; a branch name never matches a protected path
    }
  } else if (sub === 'rm') {
    put(rest.filter((a) => !a.startsWith('-')), { ancestors: true });
  } else if (sub === 'mv') {
    const pos = rest.filter((a) => !a.startsWith('-'));
    put(pos.slice(0, -1), { ancestors: true });
    if (pos.length >= 2) {
      const dest = pos[pos.length - 1];
      put([dest], { ancestors: true, dest: true });
      for (const s of pos.slice(0, -1)) put([`${dest.replace(/[\\/]+$/, '')}/${basenameOf(s)}`], { ancestors: true, dest: true });
    }
  }
}

/**
 * @param {string} segment
 * @param {{policy: object, cwd: string, repoRoot: string | null, commonRoot?: string | null, segCwd?: string | null}} ctx
 */
export function checkBashWrite(segment, ctx) {
  const targets = writeTargets(String(segment ?? ''));
  // a command that writes anything while mentioning disableAllHooks (reads such as grep pass)
  if (targets.length && DISABLE_HOOKS.test(String(segment ?? ''))) return disableHooks('Command');
  const baseDir = segmentBase(ctx);
  const { list: todo, cut } = distinct(targets);
  let pending = cut && { unsure: cut.path, why: 'targets' };
  for (const t of todo) {
    const j = judge(t, ctx, baseDir);
    if (!j) continue;
    if (j.hit) return deny(j.path, j.ancestors ? 'Writing to, moving or deleting' : 'Writing to', j.hit, ctx);
    pending ??= j;
  }
  return pending !== null ? unsureDecision(pending.unsure, ctx, pending.why) : null;
}

/** Redirections over the whole command line (the segmenter splits `>|`, so segments alone miss it). */
export function checkRedirects(command, ctx) {
  const s = String(command ?? '');
  const targets = redirectTargets(s).map((path) => ({ path }));
  // .NET calls span parentheses the segmenter splits on, so read them from the whole line too
  dotnet(s, (paths, opts = {}) => targets.push(...paths.map((path) => ({ path, ...opts }))));
  const { list: todo, cut } = distinct(targets);
  let pending = cut && { unsure: cut.path, why: 'targets' };
  for (const t of todo) {
    const j = judge(t, ctx, ctx.cwd);
    if (j?.hit) return deny(t.path, j.ancestors ? 'Writing to, moving or deleting' : 'Writing to', undefined, ctx);
    if (j?.unsure !== undefined) pending ??= j;
  }
  return pending !== null ? unsureDecision(pending.unsure, ctx, pending.why) : null;
}
