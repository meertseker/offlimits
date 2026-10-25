// Protected-file rule: blocks workers from writing hook config and policy files.

import { globMatch, normalizeRel } from '../paths.mjs';
import { tokens, stripAssignments } from '../shell.mjs';

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'nice', 'builtin']);

// commands whose every positional is removed or moved away (parents count too)
const REMOVERS = new Set(['rm', 'rmdir', 'unlink', 'del', 'erase', 'rd', 'ri', 'remove-item']);
const MOVERS = new Set(['mv', 'move', 'mi', 'move-item']);
const COPIERS = new Set(['cp', 'copy', 'cpi', 'copy-item']);
const LAST_POSITIONAL = new Set(['install', 'ln']);
const EVERY_POSITIONAL = new Set(['truncate', 'shred']);
const FIRST_POSITIONAL = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc']);
const PS_VALUE_PARAMS = new Set([
  'value', 'encoding', 'filter', 'include', 'exclude', 'itemtype', 'stream', 'width', 'delimiter',
  'name', 'credential', 'destination', 'path', 'filepath', 'literalpath', 'type',
]);

const base = (tok) => String(tok).replaceAll('\\', '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();

function parentChain(globs) {
  // literal directory prefix of each glob (up to the first wildcard segment), lower-cased
  return globs.map((g) => {
    const segs = g.replaceAll('\\', '/').split('/');
    const lit = [];
    for (const s of segs) {
      if (/[*?]/.test(s)) break;
      lit.push(s);
    }
    return lit.join('/').toLowerCase();
  });
}

/** The protected glob that `p` matches, or null. With `ancestors`, a parent directory of a protected path also counts. */
function hit(p, ctx, ancestors = false) {
  if (typeof p !== 'string' || p === '') return null;
  const rel = normalizeRel(ctx.repoRoot ?? ctx.cwd, p);
  const globs = ctx.policy.protectedPaths ?? [];
  const direct = globs.find((g) => globMatch(g, rel));
  if (direct) return direct;
  if (!ancestors) return null;
  const lits = parentChain(globs);
  const r = rel.toLowerCase();
  for (let k = 0; k < globs.length; k++) {
    if (r === '.' || (lits[k] && lits[k].startsWith(`${r}/`))) return globs[k];
  }
  return null;
}

function deny(p, how) {
  return {
    action: 'deny',
    rule: 'protected-file',
    reason: `${how} protected path "${p}" is not allowed for a worker (it holds hook or policy configuration).`,
  };
}

/**
 * @param {string} toolName
 * @param {object} toolInput
 * @param {{policy: object, cwd: string, repoRoot: string | null}} ctx
 */
export function checkFileTool(toolName, toolInput, ctx) {
  if (!FILE_TOOLS.has(toolName)) return null;
  const p = toolInput?.file_path ?? toolInput?.notebook_path ?? toolInput?.path;
  return hit(p, ctx) ? deny(p, `${toolName} on`) : null;
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
      pos.push(a);
      continue;
    }
    const key = m[1].toLowerCase();
    let val = m[2];
    if (val === undefined && PS_VALUE_PARAMS.has(key) && n + 1 < args.length) val = args[++n];
    if (val !== undefined) (named[key] ??= []).push(val);
  }
  return { named, pos };
}

const list = (v) => (v ?? []).flatMap((x) => String(x).split(',')).filter(Boolean);

/** Gather `{path, ancestors}` write targets for one segment. */
function writeTargets(segment) {
  const targets = redirectTargets(segment).map((path) => ({ path, ancestors: false }));
  const t = tokens(stripAssignments(segment).rest ?? segment);
  let i = 0;
  while (i < t.length && (WRAPPERS.has(base(t[i])) || t[i].startsWith('-'))) i++;
  const cmd = base(t[i] ?? '');
  const args = t.slice(i + 1);
  const add = (paths, ancestors = false) => {
    for (const path of paths) targets.push({ path, ancestors });
  };
  const flagless = args.filter((x) => !x.startsWith('-'));

  if (cmd === 'tee') add(flagless);
  else if (cmd === 'sed') {
    if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) && flagless.length) {
      add([flagless[flagless.length - 1]]);
    }
  } else if (cmd === 'dd') {
    add(args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
  } else if (cmd === 'git') {
    git(args, add);
  } else {
    const { named, pos } = parseArgs(args);
    if (REMOVERS.has(cmd)) add([...pos, ...list(named.path), ...list(named.literalpath)], true);
    else if (MOVERS.has(cmd)) {
      add([...pos, ...list(named.path), ...list(named.literalpath), ...list(named.destination)], true);
    } else if (COPIERS.has(cmd)) {
      if (named.destination) add(list(named.destination));
      else if (pos.length + list(named.path).length >= 2) add([pos[pos.length - 1]]);
    } else if (LAST_POSITIONAL.has(cmd)) {
      if (pos.length) add([pos[pos.length - 1]]);
    } else if (EVERY_POSITIONAL.has(cmd)) add(pos);
    else if (cmd === 'new-item' || cmd === 'ni') {
      const paths = [...pos.slice(0, 1), ...list(named.path)];
      const name = list(named.name)[0];
      add(name ? paths.map((p) => `${p}/${name}`) : paths);
    } else if (FIRST_POSITIONAL.has(cmd)) {
      const p = [...list(named.path), ...list(named.filepath), ...list(named.literalpath)];
      add(p.length ? p : pos.slice(0, 1));
    }
  }
  return targets;
}

/** `git checkout [ref] -- <path>` and `git restore <path>` overwrite the working-tree file. */
function git(args, add) {
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) k += args[k] === '-C' || args[k] === '-c' ? 2 : 1;
  const sub = (args[k] ?? '').toLowerCase();
  const rest = args.slice(k + 1);
  if (sub === 'restore') {
    const paths = [];
    for (let n = 0; n < rest.length; n++) {
      if (rest[n] === '-s' || rest[n] === '--source') n++;
      else if (!rest[n].startsWith('-')) paths.push(rest[n]);
    }
    add(paths);
  } else if (sub === 'checkout') {
    const d = rest.indexOf('--');
    if (d >= 0) add(rest.slice(d + 1));
  }
}

/**
 * @param {string} segment
 * @param {{policy: object, cwd: string, repoRoot: string | null}} ctx
 */
export function checkBashWrite(segment, ctx) {
  for (const { path, ancestors } of writeTargets(segment)) {
    if (hit(path, ctx, ancestors)) return deny(path, ancestors ? 'Writing to, moving or deleting' : 'Writing to');
  }
  return null;
}

/** Redirections over the whole command line (the segmenter splits `>|`, so segments alone miss it). */
export function checkRedirects(command, ctx) {
  for (const path of redirectTargets(String(command ?? ''))) {
    if (hit(path, ctx)) return deny(path, 'Writing to');
  }
  return null;
}
