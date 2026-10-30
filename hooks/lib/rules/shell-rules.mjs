// Shell command rules for Bash / PowerShell segments.
// Each rule is { id, test(c) -> reason | {action, reason} | null, action?(ctx), always? }, applied in order.

import os from 'node:os';
import path from 'node:path';
import { stripAssignments, tokenize, tokens, baseName, flagValue, skipWrapperArgs, WRAPPERS, OPAQUE_PREFIX, OPAQUE_DEEP, OPAQUE_EVAL } from '../shell.mjs';
import { globMatch } from '../paths.mjs';

const base = baseName;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clip = (s) => (s.length > 90 ? `${s.slice(0, 87)}...` : s);
const ASSIGN = /^[A-Za-z_]\w*=/;
const DYN = /[`$]|%\w+%/;

// ---------- command parsing ----------

// Wrappers (sudo, env, timeout, chrt, ...) come from the one table in shell.mjs: WRAPPERS.
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx']);
const RUNNER_VALUE = ['-p', '--package', '--prefix', '-w', '--workspace', '--cache', '--registry', '--userconfig', '--from', '--with', '--python', '--node-options', '--spec', '--index', '--index-url', '--extra-index-url', '--project', '--directory', '--env-file', '--group', '--extra', '-f'];
const PM_RUNNERS = new Set(['pnpm', 'yarn', 'npm', 'bun']);
const PM_SHORTCUT = new Set(['pnpm', 'yarn', 'bun']);
const PM_SUBCOMMANDS = new Set(['add', 'install', 'i', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'ci', 'test', 'build', 'init', 'link', 'publish', 'pack', 'exec', 'dlx', 'x', 'run', 'workspace', 'workspaces', 'npm', 'config', 'cache', 'info', 'list', 'ls', 'why', 'audit', 'outdated', 'create', 'start', 'dev', 'version', 'deploy', 'patch', 'store', 'prune', 'dedupe', 'import', 'rebuild', 'root', 'bin', 'setup', 'env', 'licenses', 'unlink', 'whoami', 'login', 'logout', 'help']);
const PM_VALUE = {
  npm: ['-w', '--workspace', '--prefix', '-C', '--loglevel', '--registry', '--userconfig', '--cache', '--tag', '--access', '--otp'],
  pnpm: ['--filter', '-F', '--dir', '-C', '--workspace-concurrency', '--reporter', '--loglevel', '--tag', '--access', '--otp', '--registry'],
  yarn: ['--cwd'],
  bun: ['--cwd', '--filter', '-F'],
};
const DASHDASH_RUNNERS = new Set(['dotenv', 'dotenvx', 'env-cmd', 'doppler', 'op', 'infisical', 'aws-vault', 'chamber', 'mise', 'with-env', 'direnv']);
const DOTENV_VALUE = ['-e', '-v', '-p', '-f', '--file', '--environments', '-r', '--rc-file', '--env-file', '--env', '--convention'];
const RUN_SUB = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye', 'pipx']);
const NAME_ALIAS = {
  vc: 'vercel', ntl: 'netlify', 'netlify-cli': 'netlify', flyctl: 'fly', 'aws-cdk': 'cdk', 'firebase-tools': 'firebase', sls: 'serverless',
  'dotenv-cli': 'dotenv', mvnw: 'mvn', gradlew: 'gradle', 'claude-code': 'claude', 'gemini-cli': 'gemini',
  'cross-env-shell': 'cross-env', 'twine.exe': 'twine', python3: 'python', py: 'python', pythonw: 'python',
};

function skipFlags(t, j, valueFlags, stopAt = []) {
  while (j < t.length && t[j].startsWith('-') && t[j] !== '--' && !stopAt.includes(t[j])) {
    const eq = t[j].indexOf('=');
    j += eq === -1 && valueFlags.includes(t[j]) ? 2 : 1;
  }
  return j;
}

/**
 * Parse the command a segment runs: name (basename, wrappers and runners removed, aliases resolved) and args.
 * Also collects K=V prefixes (`envs`), the directory set by `env -C`/`sudo -D` (`chdir`),
 * names unset by `env -u` (`unset`) and whether `xargs` supplies further arguments.
 */
function parseCommand(t, r = t) {
  let i = 0;
  const envs = [];
  const unset = [];
  let chdir = null;
  let xargs = false;
  const skipWrappers = () => {
    for (;;) {
      while (i < t.length && ASSIGN.test(t[i])) envs.push(t[i++]);
      if (i >= t.length) return;
      const w = base(t[i]);
      if (!Object.hasOwn(WRAPPERS, w)) return;
      if (w === 'xargs') xargs = true;
      i = skipWrapperArgs(t, i, {
        onValue: (flag, value) => {
          if (w === 'env' && (flag === '-u' || flag === '--unset')) unset.push(value);
          if ((w === 'env' && (flag === '-C' || flag === '--chdir')) || (w === 'sudo' && (flag === '-D' || flag === '--chdir'))) chdir = value;
        },
        onAssign: (a) => envs.push(a),
      });
    }
  };
  const afterRunner = (name) => {
    if (RUNNERS.has(name)) {
      const j = skipFlags(t, i + 1, RUNNER_VALUE, ['-c', '--call']);
      if (t[j] === '-c' || t[j] === '--call') return -1;
      return t[j] === '--' ? j + 1 : j;
    }
    if (PM_RUNNERS.has(name)) {
      let j = skipFlags(t, i + 1, PM_VALUE[name] ?? []);
      const sub = t[j];
      if (sub === 'exec' || sub === 'x' || sub === 'dlx') {
        j = skipFlags(t, j + 1, [...RUNNER_VALUE, ...(PM_VALUE[name] ?? [])], ['-c', '--call', '--shell-mode']);
        if (['-c', '--call', '--shell-mode'].includes(t[j])) return -1;
        return t[j] === '--' ? j + 1 : j;
      }
      if (!PM_SHORTCUT.has(name)) return -1;
      if (sub === 'run' || sub === 'run-script') {
        j = skipFlags(t, j + 1, []);
        if (t[j] === '--') j++;
      }
      return j < t.length && !PM_SUBCOMMANDS.has(t[j]) && !t[j].startsWith('.') && !t[j].startsWith('-') ? j : -1;
    }
    if (DASHDASH_RUNNERS.has(name)) {
      const dd = t.indexOf('--', i + 1);
      if (dd !== -1) return dd + 1;
      if (name === 'dotenv' || name === 'env-cmd') return skipFlags(t, i + 1, DOTENV_VALUE);
      if (name === 'dotenvx' && t[i + 1] === 'run') return skipFlags(t, i + 2, DOTENV_VALUE);
      return -1;
    }
    if (name === 'cross-env') {
      let j = i + 1;
      while (j < t.length && ASSIGN.test(t[j])) envs.push(t[j++]);
      return j;
    }
    if (name === 'python') {
      let j = i + 1;
      while (j < t.length && t[j].startsWith('-') && t[j] !== '-m') j++;
      return t[j] === '-m' && j + 1 < t.length ? j + 1 : -1;
    }
    if (RUN_SUB.has(name) && t[i + 1] === 'run') {
      const j = skipFlags(t, i + 2, RUNNER_VALUE);
      return t[j] === '--' ? j + 1 : j;
    }
    if (name === 'uv' && t[i + 1] === 'tool' && t[i + 2] === 'run') {
      const j = skipFlags(t, i + 3, RUNNER_VALUE);
      return t[j] === '--' ? j + 1 : j;
    }
    if ((name === 'bundle' || name === 'asdf') && t[i + 1] === 'exec') return i + 2;
    return -1;
  };
  for (let guard = 0; guard < 10; guard++) {
    skipWrappers();
    if (i >= t.length) break;
    let n = base(t[i]);
    if (n.lastIndexOf('@') > 0) n = n.slice(0, n.lastIndexOf('@'));
    const next = afterRunner(NAME_ALIAS[n] ?? n);
    if (next === -1 || next <= i) break;
    i = next;
  }
  let name = base(t[i]);
  if (name.lastIndexOf('@') > 0) name = name.slice(0, name.lastIndexOf('@'));
  name = NAME_ALIAS[name] ?? name;
  return { name, args: t.slice(i + 1), raws: r.slice(i + 1), toks: t, envs, unset, chdir, xargs };
}

function positionalIdx(args, valueFlags = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      for (let k = i + 1; k < args.length; k++) out.push(k);
      break;
    }
    if (a.length > 1 && a.startsWith('-')) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(i);
  }
  return out;
}

const positionals = (args, valueFlags = []) => positionalIdx(args, valueFlags).map((k) => args[k]);
const hasFlag = (args, ...names) => args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
const isDry = (args) => args.some((a) => /^--dry-?run(=(?!false$|none$|0$).*)?$/i.test(a));

const unsureAction = (ctx) => (ctx.role === 'worker' ? 'deny' : 'ask');
const unsure = (c, reason) => ({ action: unsureAction(c.ctx), reason, unsure: true });
const shown = (c) => `(matched "${clip(c.rest)}")`;

/** Resolve a directory argument against base; null when it is computed at run time or base is unknown. */
export function resolveDir(baseDir, p) {
  let s = String(p ?? '');
  if (DYN.test(s)) return null;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(1));
  if (process.platform === 'win32') {
    const m = /^\/([a-zA-Z])(\/.*|$)/.exec(s);
    if (m) s = `${m[1].toUpperCase()}:${m[2] || '/'}`;
  }
  if (path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) return s;
  if (baseDir === null || baseDir === undefined) return null;
  return path.resolve(baseDir, s);
}

/** Resolve a word that may reference a variable: {value} | {current} | {unknownVar} | {unsure}. */
const CURRENT_SUB = /^(?:\$\(|`)\s*git\s+(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+(?:HEAD|@)|symbolic-ref\s+(?:-q\s+)?--short\s+(?:-q\s+)?HEAD|name-rev\s+--name-only\s+HEAD)\s*(?:\)|`)$/;

function resolveWord(raw, value, env) {
  const r = String(raw ?? '');
  // single quotes and bash $'...' quoting are literal: only $VAR, $(...) and backticks are dynamic
  const literalParts = r.replace(/\$'(?:\\.|[^'\\])*'/g, '').replace(/'[^']*'/g, '');
  if (!DYN.test(literalParts)) return { value };
  const rr = r.replace(/^"([\s\S]*)"$/, '$1');
  if (CURRENT_SUB.test(rr)) return { current: true };
  const def = /^\$\{([A-Za-z_]\w*):?[-=]([^}]*)\}$/.exec(rr);
  if (def) {
    if (env[def[1]] !== undefined && env[def[1]] !== '') return DYN.test(env[def[1]]) ? { unsure: true } : { value: env[def[1]] };
    return DYN.test(def[2]) ? { unsure: true } : { value: def[2] };
  }
  const m = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(rr) ?? /^\$env:([A-Za-z_]\w*)$/i.exec(rr) ?? /^%([A-Za-z_]\w*)%$/.exec(rr);
  if (m) {
    const ci = !rr.startsWith('${') && (/^\$env:/i.test(rr) || rr.startsWith('%'));
    const key = Object.keys(env).find((k) => (ci ? k.toLowerCase() === m[1].toLowerCase() : k === m[1]));
    if (key !== undefined) return DYN.test(env[key]) ? { unsure: true } : { value: env[key] };
    return { unknownVar: m[1] };
  }
  return { unsure: true };
}

function isProtectedBranch(name, policy) {
  return (policy.protectedBranches ?? []).some((p) => p === name || (/[*?]/.test(p) && globMatch(p, name, 'linux')));
}

// ---------- git ----------

const GIT_VALUE_GLOBALS = new Set(['--namespace', '--exec-path', '--config-env', '--super-prefix', '--list-cmds', '--attr-source']);

function parseGit(info) {
  if (info.name !== 'git') return null;
  const a = info.args;
  const r = info.raws;
  const dirs = [];
  const configs = [];
  let gitDir;
  let workTree;
  let i = 0;
  for (; i < a.length; i++) {
    const x = a[i];
    if (x === '-C') {
      dirs.push(r[i + 1] ?? '');
      i++;
    } else if (x === '-c') {
      const kv = a[++i] ?? '';
      const eq = kv.indexOf('=');
      configs.push({ key: eq === -1 ? kv : kv.slice(0, eq), value: eq === -1 ? 'true' : kv.slice(eq + 1) });
    } else if (x === '--git-dir' || x === '--work-tree') {
      if (x === '--git-dir') gitDir = r[i + 1] ?? '';
      else workTree = r[i + 1] ?? '';
      i++;
    } else if (x.startsWith('--git-dir=')) gitDir = r[i].replace(/^--git-dir=/, '');
    else if (x.startsWith('--work-tree=')) workTree = r[i].replace(/^--work-tree=/, '');
    else if (GIT_VALUE_GLOBALS.has(x)) i++;
    else if (x.startsWith('-')) continue;
    else break;
  }
  let sub = a[i] ?? '';
  let args = a.slice(i + 1);
  let raws = r.slice(i + 1);
  let shellAlias = null;
  const alias = configs.find((c) => c.key.toLowerCase() === `alias.${sub.toLowerCase()}`);
  if (alias) {
    if (alias.value.startsWith('!')) shellAlias = alias.value;
    else {
      const at = tokens(alias.value);
      sub = at[0] ?? '';
      args = [...at.slice(1), ...args];
      raws = [...at.slice(1), ...raws];
    }
  }
  return { dirs, configs, gitDir, workTree, sub, args, raws, shellAlias };
}

/** The directory whose branch an implicit git command acts on; null when unknown. */
function lookupDir(c, g) {
  const { ctx } = c;
  let dir = ctx.segCwd === undefined ? ctx.cwd : ctx.segCwd;
  if (c.info.chdir !== null) dir = resolveDir(dir, c.info.chdir);
  for (const d of g.dirs) dir = resolveDir(dir, d);
  const gd = g.gitDir ?? c.env.GIT_DIR;
  const wt = g.workTree ?? c.env.GIT_WORK_TREE;
  if (wt !== undefined) return resolveDir(dir, wt);
  if (gd !== undefined) {
    const s = String(gd).replace(/\\/g, '/').replace(/\/+$/, '');
    return resolveDir(dir, /(^|\/)\.git$/.test(s) ? s.replace(/\/?\.git$/, '') || '.' : s);
  }
  return dir;
}

const headKey = (dir) => String(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function safeBranch(ctx, dir) {
  try {
    return String(ctx.currentBranch(dir) ?? '').trim();
  } catch {
    return '';
  }
}

/** Destination branch of a literal refspec ('' for HEAD-like specs that mean the current branch). */
function dstOf(spec) {
  let s = spec.replace(/^\+/, '');
  if (s.includes(':')) s = s.slice(s.lastIndexOf(':') + 1);
  return s.replace(/^refs\//, '').replace(/^heads\//, '');
}

function specHitsProtected(dst, policy) {
  if (!dst) return null;
  if (isProtectedBranch(dst, policy)) return dst;
  if (/[*?]/.test(dst)) {
    const hit = (policy.protectedBranches ?? []).find((b) => /[*?]/.test(b) || globMatch(dst, b, 'linux'));
    if (hit) return hit;
  }
  return null;
}

const PUSH_VALUE_FLAGS = ['-o', '--push-option', '--repo', '--receive-pack', '--exec'];
const SENSITIVE_CONFIG = /^(remote\..+\.(push|mirror)|branch\..+\.merge|push\.default|alias\..+)$/i;

function gitConfigWrite(c, g) {
  const a = g.args;
  const pos = positionals(a, ['--file', '-f', '--blob', '--type', '-t', '--default', '--comment', '--value']);
  let key;
  let write;
  if (['set', 'unset', 'rename-section', 'remove-section'].includes(pos[0])) {
    key = pos[1];
    write = true;
  } else if (['get', 'list', 'edit'].includes(pos[0])) return null;
  else {
    key = pos[0];
    write = pos.length >= 2 || hasFlag(a, '--add', '--replace-all', '--unset', '--unset-all', '--rename-section', '--remove-section');
    if (hasFlag(a, '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--get-color', '--get-colorbool')) write = false;
  }
  if (!write || !key || !SENSITIVE_CONFIG.test(key)) return null;
  return `git config writes "${key}", which can redirect pushes or define aliases ${shown(c)}.`;
}

function recordCheckout(c) {
  const heads = c.ctx.heads;
  if (!heads) return;
  const g = parseGit(c.info);
  if (!g || (g.sub !== 'checkout' && g.sub !== 'switch')) return;
  const a = g.args;
  if (g.sub === 'checkout' && a.includes('--')) return;
  if (hasFlag(a, '--detach') || (g.sub === 'switch' && a.includes('-d'))) return;
  const dir = lookupDir(c, g);
  let target;
  const create = a.findIndex((x) => ['-b', '-B', '-c', '-C', '--orphan', '--create', '--force-create'].includes(x));
  if (create !== -1) target = { raw: g.raws[create + 1], value: a[create + 1] };
  else {
    const k = positionalIdx(a, ['--conflict'])[0];
    if (k === undefined) return;
    target = { raw: g.raws[k], value: a[k] };
  }
  const rw = resolveWord(target.raw, target.value, c.env);
  let head = rw.value !== undefined ? rw.value : null;
  if (head === '-' || (head && head.startsWith('@{'))) head = null;
  heads.set(dir === null ? '*' : headKey(dir), head);
}

function gitPushProtected(c) {
  const g = parseGit(c.info);
  if (!g) return null;
  const { policy } = c.ctx;
  if (g.shellAlias) return unsure(c, `git alias "${clip(g.shellAlias)}" runs a shell command that cannot be inspected ${shown(c)}.`);
  if (g.sub === 'config') return gitConfigWrite(c, g);
  if (g.sub !== 'push' && g.sub !== 'send-pack') return null;
  for (const { key, value } of g.configs) {
    const k = key.toLowerCase();
    if (/^remote\..+\.push$/.test(k) || /^branch\..+\.merge$/.test(k)) {
      const hit = specHitsProtected(dstOf(value), policy);
      if (hit) return `git -c ${key}=${value} sends the push to protected branch "${hit}" ${shown(c)}.`;
    }
    if (/^remote\..+\.mirror$/.test(k) && /^(true|yes|on|1)$/i.test(value)) return `git -c ${key}=${value} mirrors every branch including protected ones ${shown(c)}.`;
    if (k === 'push.default' && /^(matching|upstream|tracking)$/i.test(value)) return `git -c push.default=${value} can push to a protected branch ${shown(c)}.`;
  }
  const all = g.args.find((x) => /^--(all|mirror|branches)(=|$)/.test(x));
  if (all) return `git ${g.sub} ${all.split('=')[0]} updates every branch including protected ones ${shown(c)}.`;
  const idx = positionalIdx(g.args, PUSH_VALUE_FLAGS);
  const specIdx = hasFlag(g.args, '--repo') ? idx : idx.slice(1);
  let implicit = specIdx.length === 0;
  let fallback = false;
  let unclear = null;
  for (const k of specIdx) {
    const raw = g.raws[k] ?? g.args[k];
    const val = g.args[k];
    let dRaw = raw;
    let dVal = val;
    const colon = raw.lastIndexOf(':');
    const inBraces = /\$\{[^}]*$/.test(raw.slice(0, colon));
    if (colon > 0 && !inBraces && !/\$env:[A-Za-z_]\w*$/i.test(raw) && !/[()`]/.test(raw.slice(colon + 1))) {
      dRaw = raw.slice(colon + 1);
      dVal = val.slice(val.lastIndexOf(':') + 1);
      if (/^\+/.test(raw)) dVal = dVal.replace(/^\+/, '');
    }
    const rw = resolveWord(dRaw, dVal, c.env);
    if (rw.current) {
      implicit = true;
      continue;
    }
    if (rw.unknownVar) {
      fallback = true; // historical contract: an unknown $VAR is assumed to name the current branch
      continue;
    }
    if (rw.unsure) {
      unclear ??= raw;
      continue;
    }
    const v = rw.value;
    if (v === 'HEAD' || v === '@' || v === '+HEAD') {
      implicit = true;
      continue;
    }
    const hit = specHitsProtected(dstOf(v), policy);
    if (hit) return `git ${g.sub} targets protected branch "${hit}" ${shown(c)}.`;
  }
  if (unclear) return unsure(c, `git push refspec "${clip(unclear)}" is computed at run time and may name a protected branch ${shown(c)}.`);
  if (c.info.xargs) return unsure(c, `git push gets further refspecs from xargs, cannot inspect them ${shown(c)}.`);
  if (!implicit && !fallback) return null;
  const dir = lookupDir(c, g);
  if (dir === null) return unsure(c, `git push destination unclear: the working directory is computed at run time ${shown(c)}.`);
  const heads = c.ctx.heads;
  if (heads) {
    if (heads.has('*')) return unsure(c, `git push follows a checkout in an unknown directory ${shown(c)}.`);
    const key = headKey(dir);
    if (heads.has(key)) {
      const h = heads.get(key);
      if (h === null) return unsure(c, `git push follows a checkout of a branch computed at run time ${shown(c)}.`);
      if (isProtectedBranch(h, policy)) return `git push after switching to protected branch "${h}" ${shown(c)}.`;
    }
  }
  const b = safeBranch(c.ctx, dir);
  if (!b) return unsure(c, `git push destination unclear and could not determine the current branch ${shown(c)}.`);
  if (isProtectedBranch(b, policy)) return `git push from protected branch "${b}" ${shown(c)}.`;
  return null;
}

function gitBranchProtected(c) {
  const g = parseGit(c.info);
  if (!g || g.sub !== 'branch') return null;
  const { policy } = c.ctx;
  const a = g.args;
  const letters = a.filter((x) => /^-[A-Za-z]+$/.test(x)).join('');
  const del = /[dD]/.test(letters) || a.includes('--delete');
  const move = /[mM]/.test(letters) || a.includes('--move');
  const copy = /[cC]/.test(letters) || a.includes('--copy');
  const force = /f/.test(letters) || a.includes('--force');
  const say = (b) => `git branch deletes, renames or resets protected branch "${b}" ${shown(c)}.`;
  const pos = positionals(a, ['-u', '--set-upstream-to', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format']);
  let check = [];
  if (del || move) check = pos;
  else if (copy) check = pos.slice(-1);
  else if (force) check = pos.slice(0, 1);
  const hit = check.find((p) => isProtectedBranch(p, policy));
  return hit ? say(hit) : null;
}

function gitClean(c) {
  const g = parseGit(c.info);
  if (!g || g.sub !== 'clean') return null;
  const x = g.args.find((a) => /^-[A-Za-z]*[xX][A-Za-z]*$/.test(a));
  if (!x) return null;
  if (g.args.some((a) => /^-[A-Za-z]*n[A-Za-z]*$/.test(a) || a === '--dry-run')) return null;
  return unsure(c, `git clean ${x} also deletes ignored files such as .env and local databases ${shown(c)}.`);
}

// ---------- gh ----------

const GH_VALUE = ['-R', '--repo', '-X', '--method', '-f', '-F', '--field', '--raw-field', '-H', '--header', '--input', '--jq', '-q', '-t', '--template', '--hostname', '--cache', '-p', '--preview', '-b', '--body', '-n', '--notes', '--title', '--target', '-m', '--message', '--default-branch', '--visibility', '--description', '--homepage', '-e', '--env', '--org', '-o', '--app'];
const GH_ANY_WRITE = /^repos\/[^/]+\/[^/]+\/(rulesets(\/.*)?|branches\/[^/]+\/protection(\/.*)?|merges|merge-upstream|pulls\/[^/]+\/merge|actions\/workflows\/[^/]+\/dispatches|dispatches|releases(\/.*)?|actions\/secrets(\/.*)?|actions\/variables(\/.*)?|environments\/[^/]+\/(secrets|variables)(\/.*)?|deployments(\/.*)?|transfer)$/;
const GQL_DANGER = /\b(merge\w*|updateRefs?|deleteRef|createRef|createCommitOnBranch|\w*BranchProtectionRule|delete\w+|enablePullRequestAutoMerge|updateRepository|archiveRepository|transferRepository|\w*Ruleset)\b/;

function ghApi(c, a, pos) {
  const { policy } = c.ctx;
  let endpoint = String(pos[1] ?? '')
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/^\/+/, '')
    .replace(/^api\/v3\//, '')
    .replace(/[?#].*$/, '');
  let method = '';
  const fields = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '-X' || x === '--method') method = a[i + 1] ?? '';
    else if (x.startsWith('--method=')) method = x.slice(9);
    else if (/^-X./.test(x)) method = x.slice(2);
    else if (['-f', '-F', '--field', '--raw-field'].includes(x)) fields.push(a[i + 1] ?? '');
    else if (/^--(field|raw-field)=/.test(x)) fields.push(x.slice(x.indexOf('=') + 1));
    else if (/^-[fF]./.test(x)) fields.push(x.slice(2));
  }
  const input = hasFlag(a, '--input');
  const m = method.toUpperCase();
  const write = m ? /^(POST|PUT|PATCH|DELETE)$/.test(m) : fields.length > 0 || input;
  const eff = m || (write ? 'POST' : 'GET');
  const say = `gh api ${eff} "${endpoint}" changes protected repository state ${shown(c)}.`;
  if (endpoint === 'graphql') {
    const q = fields.find((f) => /^query=/.test(f));
    const text = q ? q.slice(6) : '';
    if (text.startsWith('@') || (input && !q)) return unsure(c, `gh api graphql reads its query from a file, cannot inspect it ${shown(c)}.`);
    if (/\bmutation\b/i.test(text) && GQL_DANGER.test(text)) return `gh api graphql runs mutation "${GQL_DANGER.exec(text)[1]}" ${shown(c)}.`;
    return null;
  }
  if (!write) return null;
  if (GH_ANY_WRITE.test(endpoint)) return say;
  if (/^repos\/[^/]+\/[^/]+\/contents(\/.*)?$/.test(endpoint) && /^(PUT|DELETE)$/.test(eff)) return say;
  if (/^repos\/[^/]+\/[^/]+$/.test(endpoint) && /^(PATCH|DELETE)$/.test(eff)) return say;
  const ref = /^repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.+)$/.exec(endpoint);
  if (ref && isProtectedBranch(ref[1], policy)) return say;
  if (/^repos\/[^/]+\/[^/]+\/git\/refs$/.test(endpoint)) {
    const f = fields.find((x) => /^ref=/.test(x));
    if (f && isProtectedBranch(f.slice(4).replace(/^refs\/heads\//, ''), policy)) return say;
  }
  const ren = /^repos\/[^/]+\/[^/]+\/branches\/([^/]+)\/rename$/.exec(endpoint);
  if (ren && isProtectedBranch(ren[1], policy)) return say;
  return null;
}

function ghWrite(c) {
  if (c.info.name !== 'gh') return null;
  const a = c.info.args;
  const pos = positionals(a, GH_VALUE);
  const [p0, p1] = pos;
  const s = shown(c);
  if (p0 === 'pr' && p1 === 'merge') return `gh pr merge merges into a shared branch ${s}.`;
  if (p0 === 'workflow' && p1 === 'run') return `gh workflow run starts a CI workflow ${s}.`;
  if (p0 === 'release' && ['create', 'delete', 'upload', 'delete-asset'].includes(p1)) return `gh release ${p1} publishes or changes a release ${s}.`;
  if (p0 === 'release' && p1 === 'edit') {
    const v = flagValue(a, ['--draft']);
    if (a.includes('--draft=false') || (v !== undefined && /^false$/i.test(v))) return `gh release edit --draft=false publishes a release ${s}.`;
  }
  if (p0 === 'repo' && ['delete', 'archive', 'rename'].includes(p1)) return `gh repo ${p1} changes a repository ${s}.`;
  if (p0 === 'repo' && p1 === 'edit' && hasFlag(a, '--default-branch')) return `gh repo edit --default-branch changes the default branch ${s}.`;
  if ((p0 === 'secret' || p0 === 'variable') && ['set', 'delete', 'remove'].includes(p1)) return `gh ${p0} ${p1} changes CI ${p0}s ${s}.`;
  if (p0 === 'api') return ghApi(c, a, pos);
  return null;
}

// ---------- supabase ----------

const SB_VALUE = ['--workdir', '--db-url', '--project-ref', '-p', '--password', '--schema', '-s', '--output', '-o', '--file', '-f', '--include', '--version', '--name', '--region', '--org-id', '--env-file', '--import-map', '--status'];
const SB_ALWAYS = new Set(['db push', 'db link', 'migration repair', 'functions deploy', 'functions delete', 'secrets set', 'secrets unset', 'config push', 'projects delete', 'branches delete', 'storage rm', 'storage cp', 'storage mv', 'domains activate', 'domains delete', 'vanity-subdomains activate', 'vanity-subdomains delete', 'postgres-config update', 'postgres-config delete', 'network-restrictions update', 'network-bans remove', 'ssl-enforcement update', 'sso add', 'sso remove', 'sso update', 'backups restore', 'encryption update-root-key']);
const SB_READS = new Set(['inspect', 'gen', 'diff', 'db diff', 'migration list', 'db dump', 'db lint', 'status', 'projects list', 'secrets list', 'functions list', 'functions download', 'branches list', 'branches get', 'migration fetch', 'storage ls']);

function supabaseRemote(c) {
  if (c.info.name !== 'supabase') return null;
  const args = c.info.args;
  if (isDry(args)) return null;
  const pos = positionals(args, SB_VALUE);
  const key = `${pos[0] ?? ''} ${pos[1] ?? ''}`;
  const remoteFlag = hasFlag(args, '--linked', '--db-url', '--project-ref');
  const local = hasFlag(args, '--local');
  const hit =
    (SB_ALWAYS.has(key) && !(local && (key === 'db push' || key.startsWith('storage ')))) ||
    pos[0] === 'link' ||
    (remoteFlag && !SB_READS.has(pos[0] ?? '') && !SB_READS.has(key));
  return hit ? `supabase ${key.trim()} changes the linked remote project ${shown(c)}.` : null;
}

// ---------- remote databases ----------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);
const URI = /^(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/([^/?#]*)/i;
const DB_URL_NAME = (n) => /^DATABASE_URL$/i.test(n) || (/(URL|URI|DSN)$/i.test(n) && /(DATABASE|DB|POSTGRES|PG|MYSQL|MONGO|REDIS)/i.test(n));
const DB_SPEC = {
  psql: { v: ['-c', '--command', '-f', '--file', '-U', '--username', '-p', '--port', '-o', '--output', '-v', '--set', '--variable', '-L', '--log-file', '-F', '--field-separator', '-R', '--record-separator', '-T', '--table-attr', '-P', '--pset'], host: ['-h', '--host'], conn: ['-d', '--dbname'], positional: true },
  pg_dump: { v: ['-f', '--file', '-F', '--format', '-j', '--jobs', '-n', '--schema', '-N', '--exclude-schema', '-t', '--table', '-T', '--exclude-table', '-U', '--username', '-p', '--port', '-Z', '--compress', '-E', '--encoding', '-S', '--superuser', '--section', '-e', '--extension'], host: ['-h', '--host'], conn: ['-d', '--dbname'], positional: true },
  pg_dumpall: { v: ['-f', '--file', '-U', '--username', '-p', '--port', '-l', '--database'], host: ['-h', '--host'], conn: ['-d', '--dbname'] },
  pg_restore: { v: ['-f', '--file', '-F', '--format', '-j', '--jobs', '-n', '--schema', '-t', '--table', '-U', '--username', '-p', '--port', '-L', '--use-list', '-I', '--index', '-P', '--function', '-S', '--superuser', '-T', '--trigger', '--section'], host: ['-h', '--host'], conn: ['-d', '--dbname'] },
  mysql: { v: ['-u', '--user', '-P', '--port', '-e', '--execute', '-D', '--database', '-S', '--socket', '--default-character-set'], host: ['-h', '--host'], conn: [] },
  mysqldump: { v: ['-u', '--user', '-P', '--port', '-r', '--result-file', '-S', '--socket', '--where', '-w'], host: ['-h', '--host'], conn: [] },
  mongosh: { v: ['--eval', '-u', '--username', '-p', '--password', '--file', '-f', '--authenticationDatabase', '--port'], host: ['--host'], conn: [], positional: true },
  mongo: { v: ['--eval', '-u', '--username', '-p', '--password', '--authenticationDatabase', '--port'], host: ['--host'], conn: [], positional: true },
  mongodump: { v: ['-u', '--username', '-p', '--password', '-d', '--db', '-c', '--collection', '-o', '--out', '--port'], host: ['-h', '--host'], conn: ['--uri'] },
  mongorestore: { v: ['-u', '--username', '-p', '--password', '-d', '--db', '-c', '--collection', '--port', '--dir'], host: ['-h', '--host'], conn: ['--uri'] },
  'redis-cli': { v: ['-p', '-a', '-n', '--user', '--pass', '-s', '-r', '-i', '--eval'], host: ['-h'], conn: ['-u'] },
};

function hostsFromUri(authority) {
  const afterAt = authority.slice(authority.lastIndexOf('@') + 1);
  return afterAt.split(',').map((h) => {
    const m = /^\[([^\]]*)\]/.exec(h);
    return (m ? m[1] : h.replace(/:\d*$/, '')).toLowerCase();
  });
}

function isRemoteHost(host, policy) {
  const h = host.trim().toLowerCase();
  if ((policy.production?.hosts ?? []).some((x) => x.toLowerCase() === h)) return true;
  if (!h || h.startsWith('/')) return false; // unix socket / empty
  return !(LOCAL_HOSTS.has(h) || h.endsWith('.local'));
}

function remoteDb(c) {
  const spec = DB_SPEC[c.info.name];
  if (!spec) return null;
  const { policy } = c.ctx;
  const tool = c.info.name;
  const s = shown(c);
  const hosts = [];
  let unclear = null;
  const env = c.env;
  for (const k of ['PGHOST', 'PGHOSTADDR', 'MYSQL_HOST']) if (env[k] !== undefined) hosts.push(env[k]);
  for (const k of ['PGSERVICE', 'PGSERVICEFILE']) if (env[k] !== undefined) unclear ??= `${k}=${env[k]}`;
  if (env.PGDATABASE !== undefined && URI.test(env.PGDATABASE)) hosts.push(...hostsFromUri(URI.exec(env.PGDATABASE)[1]));
  const take = (raw, value, kind) => {
    const rw = resolveWord(raw, value, env);
    if (rw.unknownVar) {
      if (DB_URL_NAME(rw.unknownVar)) return `${tool} connects through $${rw.unknownVar}, which is treated as remote ${s}.`;
      unclear ??= raw;
      return null;
    }
    let v = rw.value;
    if (rw.unsure || rw.current) {
      // partly dynamic (for example only the password): use what is literal
      const u = URI.exec(String(value));
      if (u && !/[`$]/.test(hostsFromUri(u[1]).join(','))) v = String(value);
      else {
        unclear ??= raw;
        return null;
      }
    }
    if (kind === 'host') {
      hosts.push(v);
      return null;
    }
    const u = URI.exec(v) ?? URI.exec(v.replace(/^--?[\w-]+=/, ''));
    if (u) hosts.push(...hostsFromUri(u[1]));
    for (const m of v.matchAll(/(?:^|\s)(?:host|hostaddr)=([^\s'"]+)/g)) hosts.push(m[1]);
    if (/(?:^|\s)service=/.test(v)) unclear ??= v;
    return null;
  };
  const args = c.info.args;
  const raws = c.info.raws;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let r = null;
    if (spec.host.includes(a)) {
      r = take(raws[i + 1] ?? '', args[i + 1] ?? '', 'host');
      i++;
    } else if (a.startsWith('--host=')) r = take(raws[i].slice(7), a.slice(7), 'host');
    else if (spec.host.includes('-h') && /^-h./.test(a)) r = take(raws[i].slice(2), a.slice(2), 'host');
    else if (spec.conn.includes(a)) {
      r = take(raws[i + 1] ?? '', args[i + 1] ?? '', 'conn');
      i++;
    } else if (/^--(dbname|uri)=/.test(a)) r = take(raws[i].slice(raws[i].indexOf('=') + 1), a.slice(a.indexOf('=') + 1), 'conn');
    else if (a.length > 1 && a.startsWith('-')) {
      if (spec.v.includes(a)) i++;
    } else if (spec.positional) r = take(raws[i], a, 'conn');
    else if (URI.test(a)) r = take(raws[i], a, 'conn');
    if (r) return r;
  }
  const bad = hosts.find((h) => isRemoteHost(h, policy));
  if (bad !== undefined) return `${tool} targets remote database host "${bad}" ${s}.`;
  if (unclear) return unsure(c, `${tool} connection "${clip(unclear)}" is resolved at run time and may be remote ${s}.`);
  return null;
}

// ---------- migrations ----------

function dbMigrate(c) {
  const { name, args, toks } = c.info;
  const pos = positionals(args);
  const k2 = `${pos[0] ?? ''} ${pos[1] ?? ''}`;
  let what = null;
  if (name === 'prisma' && (k2 === 'migrate deploy' || k2 === 'db push')) what = `prisma ${k2}`;
  else if (name === 'drizzle-kit' && /^(push|migrate)(:|$)/.test(pos[0] ?? '')) what = `drizzle-kit ${pos[0]}`;
  else if (name === 'flyway' && pos[0] === 'migrate') what = 'flyway migrate';
  else if (name === 'alembic' && pos[0] === 'upgrade') what = 'alembic upgrade';
  else if (name === 'knex' && pos[0] === 'migrate:latest') what = 'knex migrate:latest';
  else if (toks.some((t) => /^db:migrate(:(up|down|redo))?$/.test(t))) {
    const prod = toks.some((t) => /^(RAILS_ENV|RACK_ENV)=production$/i.test(t)) || ['RAILS_ENV', 'RACK_ENV'].some((k) => /^production$/i.test(c.env[k] ?? ''));
    if (prod) what = 'rails db:migrate in production';
  } else if (toks.some((t) => base(t) === 'artisan') && toks.some((t) => /^migrate(:(fresh|refresh|reset|rollback))?$/.test(t)) && hasFlag(args, '--force')) {
    what = 'artisan migrate --force';
  }
  return what ? `${what} applies migrations to a database ${shown(c)}.` : null;
}

// ---------- deploys ----------

const DEPLOY_VALUE_FLAGS = ['-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user', '--project', '--region', '--profile', '--output', '-a', '--app', '-s', '--stage', '--org', '--config', '--chdir', '-r', '-e', '--scope', '--token', '-t', '--cwd', '-A', '--local-config', '-b', '--build-env', '-m', '--meta', '--archive', '-S', '--site', '--auth', '--env', '--environment', '-c', '--service', '--name', '--zone', '-l', '--selector', '--kube-context', '--kube-namespace'];
const VERCEL_SAFE = new Set(['build', 'pull', 'logs', 'inspect', 'ls', 'list', 'whoami', 'dev', 'link', 'login', 'logout', 'help', 'switch', 'telemetry', 'init', 'certs', 'dns', 'domains', 'project', 'projects', 'teams', 'git', 'integration', 'bisect', 'open']);
const DOCKER_GLOBAL_VALUE = ['-H', '--host', '-c', '--context', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey'];
const DOCKER_VALUE = ['-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory', '-t', '--tag', '--platform', '--build-arg', '-o', '--output', '--cache-from', '--cache-to', '--target', '--builder', '-e', '--env', '-v', '--volume', '--name', '-u', '--user', '-w', '--workdir', '--network', '--entrypoint', '--mount', '--label', '--secret', '--ssh', '--progress'];
const DOCKER_READS = new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'top', 'events', 'port', 'diff', 'history', 'search', 'context', 'help', 'login', 'image ls', 'image inspect', 'image history', 'container ls', 'container inspect', 'container logs', 'volume ls', 'volume inspect', 'network ls', 'network inspect', 'system df', 'system info', 'compose ps', 'compose logs', 'compose config', 'compose ls', 'compose images', 'compose top', 'compose version', 'buildx ls', 'buildx inspect', 'buildx version', 'manifest inspect']);
const LOCAL_CONTEXTS = new Set(['default', 'desktop-linux', 'desktop-windows', 'colima', 'orbstack', 'rootless', 'podman', 'rancher-desktop']);
const SERVER_PATH = /^\/(opt|srv|var|etc|usr\/share\/nginx)\//;
const TEMP_PATH = /^\/var\/(tmp|folders)\//;
const SSH_DEPLOY = /(\S*(?:deploy|rollback)\.sh|systemctl\s+(?:restart|reload|stop|start)\b[^'"]*|service\s+\S+\s+(?:restart|reload|stop)\b|caddy\s+reload|nginx\s+-s\s+reload|pm2\s+(?:restart|reload|start|stop|delete|deploy)\b[^'"]*|docker(?:-compose|\s+compose)\b[^'"]*?\bup\b[^'"]*|docker\s+(?:run|stop|rm|restart|kill|pull)\b[^'"]*|kubectl\s+(?:apply|delete|rollout|scale|patch|set|replace)\b[^'"]*|git\s+pull\b[^'"]*)/;

function hasTarget(args) {
  return args.some((a, i) => /^--target=production$/i.test(a) || (a === '--target' && /^production$/i.test(args[i + 1] ?? '')));
}

function dockerSplit(args) {
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) k += DOCKER_GLOBAL_VALUE.includes(args[k]) ? 2 : 1;
  return { globals: args.slice(0, k), rest: args.slice(k) };
}

function dockerRemote(c, globals) {
  const host = flagValue(globals, ['-H', '--host']) ?? c.env.DOCKER_HOST;
  if (host && !/^(unix|npipe):/i.test(host) && !/^(tcp:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(host)) return `remote Docker host "${host}"`;
  const name = flagValue(globals, ['--context', '-c']) ?? c.env.DOCKER_CONTEXT;
  if (name && !LOCAL_CONTEXTS.has(name.toLowerCase())) return `Docker context "${name}"`;
  return null;
}

function remoteCopyDest(args) {
  const pos = positionals(args, ['-e', '--rsh', '-i', '-P', '-o', '-F', '-c', '-l', '-S', '-J', '--exclude', '--include', '--filter', '--port', '--password-file', '--chmod', '--chown', '--rsync-path', '--exclude-from', '--include-from']);
  const dest = pos[pos.length - 1] ?? '';
  const m = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(.*)$/.exec(dest);
  if (!m || pos.length < 2) return null;
  return SERVER_PATH.test(m[2]) && !TEMP_PATH.test(m[2]) ? dest : null;
}

function deploy(c) {
  const { name, args } = c.info;
  const pos = positionals(args, DEPLOY_VALUE_FLAGS);
  const [p0, p1] = pos;
  const label = () => `${name} ${[p0, p1].filter(Boolean).join(' ')}`;
  const s = shown(c);
  const dry = isDry(args);
  let hit = false;
  switch (name) {
    case 'vercel':
      if (p0 === 'env') {
        hit = ['add', 'rm', 'remove', 'update'].includes(p1) && pos.slice(2).some((x) => /^production$/i.test(x));
        break;
      }
      if (VERCEL_SAFE.has(p0)) break;
      hit = hasFlag(args, '--prod', '--production') || hasTarget(args) || ['promote', 'rollback', 'rm', 'remove'].includes(p0) || (p0 === 'alias' && p1 === 'set');
      break;
    case 'netlify':
      hit = (p0 === 'deploy' && hasFlag(args, '--prod', '-p', '--prodIfUnlocked')) || p0 === 'sites:delete';
      break;
    case 'fly':
      hit = p0 === 'deploy' || p0 === 'destroy' || (p0 === 'secrets' && ['set', 'unset', 'import', 'deploy'].includes(p1)) || p0 === 'scale' || (p0 === 'apps' && p1 === 'destroy') || ((p0 === 'machine' || p0 === 'machines') && ['destroy', 'stop', 'kill', 'remove', 'restart'].includes(p1));
      break;
    case 'wrangler': {
      const remote = hasFlag(args, '--remote');
      hit = ['deploy', 'publish', 'rollback', 'delete'].includes(p0) || (p0 === 'versions' && p1 === 'deploy') || (p0 === 'pages' && (p1 === 'deploy' || p1 === 'publish')) || (p0 === 'secret' && ['put', 'delete', 'bulk'].includes(p1)) || (p0 === 'd1' && remote && (p1 === 'execute' || (p1 === 'migrations' && pos[2] === 'apply'))) || (['kv', 'r2'].includes(p0) && remote && pos.some((x) => ['put', 'delete'].includes(x)));
      break;
    }
    case 'firebase':
      hit = p0 === 'deploy' || p0 === 'functions:delete' || p0 === 'hosting:disable';
      break;
    case 'serverless':
    case 'sst':
      hit = p0 === 'deploy' || p0 === 'remove';
      break;
    case 'cdk':
      hit = p0 === 'deploy' || p0 === 'destroy';
      break;
    case 'railway':
      hit = ['up', 'redeploy', 'down'].includes(p0);
      break;
    case 'heroku':
      hit = /^(releases:rollback|rollback|apps:destroy|pg:reset|pg:push|config:(set|unset|add|remove)|ps:(restart|scale|stop)|restart|container:release)$/.test(p0 ?? '');
      break;
    case 'pulumi':
      hit = p0 === 'up' || p0 === 'destroy';
      break;
    case 'terraform':
    case 'tofu':
      hit = p0 === 'apply' || p0 === 'destroy';
      break;
    case 'terragrunt':
      hit = pos.includes('apply') || pos.includes('destroy');
      break;
    case 'kubectl':
      if (dry) break;
      hit = ['apply', 'delete', 'scale', 'patch', 'replace', 'set', 'edit', 'create', 'drain', 'cordon', 'taint'].includes(p0) || (p0 === 'rollout' && !['status', 'history'].includes(p1));
      break;
    case 'helm':
      if (dry) break;
      hit = ['install', 'upgrade', 'uninstall', 'rollback', 'delete'].includes(p0);
      break;
    case 'gcloud':
      hit = (['run', 'app', 'functions'].includes(p0) && p1 === 'deploy') || (p0 === 'functions' && p1 === 'delete') || (p0 === 'run' && p1 === 'services' && ['update', 'delete', 'replace', 'update-traffic'].includes(pos[2])) || (p0 === 'sql' && p1 === 'instances' && ['delete', 'patch', 'restart'].includes(pos[2]));
      break;
    case 'aws': {
      if (p0 === 's3') {
        if (hasFlag(args, '--dryrun')) break;
        const last = pos[pos.length - 1] ?? '';
        hit = (['sync', 'cp', 'mv'].includes(p1) && /^s3:\/\//i.test(last)) || ((p1 === 'rm' || p1 === 'rb') && pos.some((x) => /^s3:\/\//i.test(x)));
      } else {
        hit =
          (p0 === 'cloudformation' && ['deploy', 'update-stack', 'delete-stack'].includes(p1)) ||
          (p0 === 'lambda' && ['update-function-code', 'update-function-configuration', 'delete-function', 'publish-version', 'update-alias'].includes(p1)) ||
          (p0 === 'ecs' && ['update-service', 'delete-service', 'delete-cluster'].includes(p1)) ||
          (p0 === 'deploy' && p1 === 'create-deployment') ||
          (p0 === 'elasticbeanstalk' && p1 === 'update-environment') ||
          (p0 === 'apprunner' && p1 === 'start-deployment');
      }
      break;
    }
    case 'az':
      hit = (['webapp', 'functionapp'].includes(p0) && ['deploy', 'up'].includes(p1)) || (p0 === 'containerapp' && ['up', 'update'].includes(p1)) || (['webapp', 'functionapp'].includes(p0) && p1 === 'deployment' && pos[2] === 'source');
      break;
    case 'eas':
      hit = p0 === 'update' || p0 === 'submit';
      break;
    case 'ssh': {
      const m = SSH_DEPLOY.exec(c.rest);
      if (m) return `ssh runs a remote deploy action "${clip(m[1])}" ${s}.`;
      return null;
    }
    case 'rsync':
    case 'scp': {
      const d = remoteCopyDest(args);
      return d ? `${name} copies files to server path "${d}" ${s}.` : null;
    }
    case 'docker':
    case 'docker-compose':
    case 'podman': {
      const { globals, rest } = dockerSplit(args);
      const rpos = positionals(rest, DOCKER_VALUE);
      const sub = name === 'docker-compose' ? `compose ${rpos[0] ?? ''}` : `${rpos[0] ?? ''} ${rpos[1] ?? ''}`.trim();
      const remote = dockerRemote(c, globals);
      const read = DOCKER_READS.has(rpos[0] ?? '') || DOCKER_READS.has(sub);
      if (remote && !read && rpos.length) return `docker ${sub} runs against ${remote} ${s}.`;
      const compose = name === 'docker-compose' || rpos[0] === 'compose';
      if (!compose || !rpos.includes('up') || !hasFlag(rest, '-d', '--detach')) return null;
      const files = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '-f' || rest[i] === '--file') files.push(rest[i + 1] ?? '');
        else if (rest[i].startsWith('--file=')) files.push(rest[i].slice(7));
        else if (/^-f./.test(rest[i]) && !rest[i].startsWith('--')) files.push(rest[i].slice(2));
      }
      const f = files.find((x) => /^\/(opt|srv|var)\//.test(x) && !TEMP_PATH.test(x));
      return f ? `docker compose up -d on server path "${f}" starts live services ${s}.` : null;
    }
    default:
      return null;
  }
  return hit ? `${label()} deploys or changes live infrastructure ${s}.` : null;
}

function publish(c) {
  const { name, args } = c.info;
  const pos = positionals(args, PM_VALUE[name] ?? (name === 'docker' || name === 'podman' ? [...DOCKER_GLOBAL_VALUE, ...DOCKER_VALUE] : ['-r', '--repository', '--repository-url', '-u', '--username', '-p', '--password', '--token', '--index', '--publish-url', '-k', '--api-key', '-s', '--source']));
  const [p0, p1] = pos;
  const dry = isDry(args);
  let hit = false;
  switch (name) {
    case 'npm':
    case 'pnpm':
    case 'bun':
      hit = p0 === 'publish' && !dry;
      break;
    case 'yarn':
      hit = (p0 === 'publish' || (p0 === 'npm' && p1 === 'publish')) && !dry;
      break;
    case 'cargo':
    case 'uv':
    case 'poetry':
      hit = p0 === 'publish' && !dry;
      break;
    case 'flit':
    case 'hatch':
    case 'changeset':
    case 'lerna':
      hit = p0 === 'publish';
      break;
    case 'semantic-release':
      hit = !dry && !args.includes('-d');
      break;
    case 'twine':
      hit = p0 === 'upload';
      break;
    case 'gem':
      hit = p0 === 'push';
      break;
    case 'dotnet':
      hit = p0 === 'nuget' && p1 === 'push';
      break;
    case 'mvn':
      hit = pos.includes('deploy');
      break;
    case 'gradle':
      hit = pos.some((t) => /^(:[\w-]+:)*publish/.test(t) && !/publishToMavenLocal$/.test(t));
      break;
    case 'docker':
    case 'podman': {
      const sub = `${p0 ?? ''} ${p1 ?? ''}`;
      hit = p0 === 'push' || sub === 'image push' || sub === 'compose push' || (((p0 === 'buildx' && (p1 === 'build' || p1 === 'bake')) || p0 === 'build') && (hasFlag(args, '--push') || args.some((a, i) => /type=registry/.test(a) && (args[i - 1] === '-o' || args[i - 1] === '--output' || /^--output=/.test(a)))));
      break;
    }
    default:
      return null;
  }
  return hit ? `${[name, ...pos.slice(0, 2)].join(' ')} publishes a package or image ${shown(c)}.` : null;
}

// ---------- agents and role spoofing ----------

const AGENTS = new Set(['claude', 'codex', 'aider', 'gemini', 'opencode', 'cursor-agent', 'goose']);

function agentSpawn(c) {
  const { name, args } = c.info;
  if (!AGENTS.has(name)) return null;
  if (/disableAllHooks/i.test(c.rest)) return `${name} would start an agent with disableAllHooks, switching off every hook ${shown(c)}.`;
  if (args.length && args.every((a) => /^(--version|-v|-V|--help|-h|help|version)$/.test(a))) return null;
  // management subcommands that do not start a session
  if (name === 'claude' && ['mcp', 'config', 'doctor', 'update', 'plugin', 'install'].includes(args[0])) return null;
  return {
    action: c.ctx.role === 'worker' ? 'deny' : 'ask',
    reason: `${name} starts another coding agent, which would run without the subagent marker ${shown(c)}.`,
  };
}

const TEAM_SUBS = new Set(['worker', 'done', 'coordinator', 'init']);

function teamLaunch(c) {
  const { name, args, raws } = c.info;
  // bash-style parsing eats backslashes in Windows paths, so look at the raw tokens too
  const isTeam = (a) => /(^|[\\/])team\.mjs$/i.test(a ?? '');
  let rest;
  if (name === 'node') {
    const i = args.findIndex((a, k) => isTeam(a) || isTeam(raws[k]));
    if (i < 0) return null;
    rest = args.slice(i + 1);
  } else if (name === 'team' || name === 'offlimits-team' || isTeam(name)) {
    rest = args;
  } else return null;
  const sub = rest.find((a) => !a.startsWith('-'));
  const worker = c.ctx.role === 'worker';
  // a worker also hits when a launch word follows other arguments (rare false positive: "team board worker")
  const hit = TEAM_SUBS.has(sub) ? sub : worker ? rest.find((a) => TEAM_SUBS.has(a)) : undefined;
  if (!hit) return null;
  if (!worker && hit === 'init') return null;
  return {
    action: worker ? 'deny' : 'ask',
    reason: hit === 'init'
      ? `${name} init rewrites team configuration; re-run it from a terminal with: team init ${shown(c)}.`
      : `${name} ${hit} would start or remove team sessions, which only the coordinator does ${shown(c)}.`,
  };
}

const READ_ONLY = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'findstr', 'select-string', 'sls']);
const GIT_READ = new Set(['grep', 'log', 'show', 'diff', 'commit', 'blame']);

function readOnlyMention(c) {
  const unquoted = c.segment.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '');
  if (/>/.test(unquoted)) return false;
  if (READ_ONLY.has(c.info.name)) return true;
  const g = parseGit(c.info);
  return Boolean(g && GIT_READ.has(g.sub));
}

function roleSpoof(c) {
  const role = c.ctx.policy.roleEnv;
  const R = esc(role);
  const s = `(matched "${clip(c.segment)}")`;
  const say = `assigning ${role} would change the agent's own role ${s}.`;
  if (c.assignments.some((a) => a.split('=')[0].toLowerCase() === role.toLowerCase())) return say;
  if (c.info.envs.some((a) => a.split('=')[0].toLowerCase() === role.toLowerCase())) return say;
  if (c.info.unset.some((u) => u.toLowerCase() === role.toLowerCase())) return `unsetting ${role} would change the agent's own role ${s}.`;
  const t = c.info.toks;
  let i = 0;
  while (i < t.length && (Object.hasOwn(WRAPPERS, base(t[i])) || ASSIGN.test(t[i]) || t[i].startsWith('-'))) {
    if (t[i].toLowerCase().startsWith(`${role.toLowerCase()}=`)) return say;
    i++;
  }
  const patterns = [
    new RegExp(`\\b(export|set|setx|declare|typeset|readonly|local)\\s+(-\\w+\\s+)*${R}\\b`, 'i'),
    new RegExp(`\\$env:${R}\\s*=`, 'i'),
    new RegExp(`(set|new|remove|clear)-item\\s+.*\\benv:\\\\?${R}\\b`, 'i'),
    new RegExp(`\\b(ri|rm|del|erase|cli|rd|rmdir)\\s+(-\\w+\\s+)*['"]?env:\\\\?${R}\\b`, 'i'),
    new RegExp(`\\bunset\\s+(-\\w+\\s+)*${R}\\b`, 'i'),
    new RegExp(`SetEnvironmentVariable\\s*\\(?\\s*['"]${R}['"]`, 'i'),
    new RegExp(`^['"]${R}['"]\\s*,`, 'i'),
    new RegExp(`\\breg(\\.exe)?\\s+(add|delete)\\b.*\\b${R}\\b`, 'i'),
  ];
  if (patterns.some((p) => p.test(c.rest) || p.test(c.segment))) return say;
  if (readOnlyMention(c)) return null;
  if (new RegExp(`\\b${R}\\b`, 'i').test(c.segment) && /coordinator/i.test(c.segment)) {
    return `segment writes ${role} together with "coordinator", which would promote a later session ${s}.`;
  }
  return null;
}

export const RULES = [
  { id: 'role-spoof', test: roleSpoof, always: true },
  { id: 'git-push-protected', test: gitPushProtected },
  { id: 'git-branch-protected', test: gitBranchProtected },
  { id: 'gh-write', test: ghWrite },
  { id: 'supabase-remote', test: supabaseRemote },
  { id: 'remote-db', test: remoteDb },
  { id: 'db-migrate', test: dbMigrate, action: (ctx) => (ctx.role === 'solo' ? 'ask' : 'deny') },
  { id: 'deploy', test: deploy },
  { id: 'publish', test: publish },
  { id: 'agent-spawn', test: agentSpawn },
  { id: 'team-launch', test: teamLaunch },
  { id: 'git-clean', test: gitClean },
];

/** Every rule id checkSegment can return. */
export const SHELL_RULE_IDS = Object.freeze([...RULES.map((r) => r.id), 'opaque-shell', 'extra-deny']);

function compile(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/** Most bare `--` tails one segment may have; more makes the segment opaque. */
const MAX_DASH_TAILS = 32;

/**
 * Parsed variants of one segment: default, bash and PowerShell escaping, and what follows each bare `--`.
 * Returns null when the segment has more than MAX_DASH_TAILS bare `--` (too costly to parse every tail).
 */
function variants(rest) {
  const out = [];
  let tails = 0;
  const seen = new Set();
  for (const mode of ['default', 'bash', 'ps']) {
    const t = tokenize(rest, mode);
    const toks = t.toks;
    // in PowerShell a backtick escapes the next character instead of starting a substitution
    const raws = mode === 'ps' ? t.raws.map((r) => r.replace(/`([\s\S])/g, '$1')) : t.raws;
    const key = JSON.stringify(toks);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ info: parseCommand(toks, raws), primary: mode === 'default' });
    toks.forEach((tk, k) => {
      if (tk !== '--' || k === toks.length - 1 || tails > MAX_DASH_TAILS) return;
      if (++tails > MAX_DASH_TAILS) return;
      const tail = toks.slice(k + 1);
      const tkey = JSON.stringify(tail);
      if (seen.has(tkey)) return;
      seen.add(tkey);
      out.push({ info: parseCommand(tail, raws.slice(k + 1)), primary: false });
    });
  }
  return tails > MAX_DASH_TAILS ? null : out;
}

const kvObject = (list) => Object.fromEntries(list.map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));

/**
 * @param {string} segment one command segment
 * @param {{role: string, policy: object, currentBranch: (dir: string) => string, cwd: string,
 *   segCwd?: string | null, segEnvs?: Record<string, string>, heads?: Map<string, string | null>}} ctx
 *   segCwd: directory this segment runs in (absolute; null when unknown; undefined means ctx.cwd);
 *   segEnvs: variables set by earlier segments; heads: branches checked out by earlier segments.
 * @returns {{action: 'deny'|'ask', rule: string, reason: string} | null}
 */
export function checkSegment(segment, ctx) {
  const { assignments, rest } = stripAssignments(segment);
  const policy = ctx.policy;
  if (rest.startsWith(OPAQUE_PREFIX)) {
    return {
      action: ctx.role === 'solo' ? 'ask' : 'deny',
      rule: 'opaque-shell',
      reason: rest === OPAQUE_DEEP
        ? 'Command nests shells more than 8 levels deep, cannot inspect the innermost commands.'
        : rest === OPAQUE_EVAL
          ? 'Command evaluates text produced at run time (eval of a substitution), cannot inspect it.'
          : 'Shell reads its commands from stdin, cannot inspect them.',
    };
  }
  const env0 = { ...(ctx.segEnvs ?? {}), ...kvObject(assignments) };
  const vs = variants(rest);
  if (vs === null) {
    return {
      action: ctx.role === 'solo' ? 'ask' : 'deny',
      rule: 'opaque-shell',
      reason: `Command has more than ${MAX_DASH_TAILS} bare "--" separators in one segment, too costly to inspect.`,
    };
  }
  const cs = vs.map((v) => ({
    segment, rest, assignments, ctx, info: v.info, primary: v.primary, env: { ...env0, ...kvObject(v.info.envs) },
  }));
  const allowed = (policy.allow ?? []).some((p) => compile(p)?.test(rest));
  for (const rule of RULES) {
    if (allowed && !rule.always) continue;
    // A definite result from any variant wins; an "unsure" result counts only from the primary parse.
    let pending = null;
    for (const c of cs) {
      const r = rule.test(c);
      if (!r) continue;
      if (typeof r === 'object') {
        if (r.unsure) {
          if (c.primary) pending ??= r;
          continue;
        }
        return { action: r.action, rule: rule.id, reason: r.reason };
      }
      return { action: rule.action ? rule.action(ctx) : 'deny', rule: rule.id, reason: r };
    }
    if (pending) return { action: pending.action, rule: rule.id, reason: pending.reason };
  }
  recordCheckout(cs[0]);
  if (allowed) return null;
  for (const entry of policy.extraDeny ?? []) {
    const re = compile(entry.pattern);
    const m = re && (re.exec(rest) ?? re.exec(segment));
    if (m) return { action: 'deny', rule: 'extra-deny', reason: `${entry.reason} (matched "${clip(m[0] || rest)}").` };
  }
  return null;
}
