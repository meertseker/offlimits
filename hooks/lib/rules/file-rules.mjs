// Protected-file rule: blocks workers from writing hook config and policy files.

import { globMatch, normalizeRel } from '../paths.mjs';
import { tokens, stripAssignments } from '../shell.mjs';

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PS_WRITERS = new Set(['set-content', 'out-file', 'add-content']);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'nice', 'builtin']);

/** The protected glob that `p` matches, or null. */
function matchedGlob(p, ctx) {
  if (typeof p !== 'string' || p === '') return null;
  const rel = normalizeRel(ctx.repoRoot ?? ctx.cwd, p);
  return (ctx.policy.protectedPaths ?? []).find((g) => globMatch(g, rel)) ?? null;
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
  return matchedGlob(p, ctx) ? deny(p, `${toolName} on`) : null;
}

const positional = (t) => t.filter((x) => !x.startsWith('-'));

/** Paths a segment writes to, as raw tokens. */
function writeTargets(segment) {
  const targets = [];
  const t = tokens(stripAssignments(segment).rest ?? segment);

  // redirections anywhere in the segment: `> f`, `>> f`, `>f`, `x>f`, `2>f`
  const re = /(?:^|[^>&])>>?\s*(?!&)("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g;
  for (const m of segment.matchAll(re)) targets.push(...tokens(m[1]));

  let i = 0;
  while (i < t.length && (WRAPPERS.has(base(t[i])) || t[i].startsWith('-'))) i++;
  const cmd = base(t[i] ?? '');
  const args = t.slice(i + 1);
  const pos = positional(args);

  if (cmd === 'tee') targets.push(...pos);
  else if (cmd === 'sed') {
    if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
      if (pos.length) targets.push(pos[pos.length - 1]);
    }
  } else if (cmd === 'cp' || cmd === 'mv') {
    if (pos.length >= 2) targets.push(pos[pos.length - 1]);
  } else if (cmd === 'rm') targets.push(...pos);
  else if (PS_WRITERS.has(cmd)) {
    const named = args.findIndex((a) => /^-(path|filepath|literalpath)$/i.test(a));
    if (named >= 0 && args[named + 1]) targets.push(args[named + 1]);
    else if (pos.length) targets.push(pos[0]);
  }
  return targets;
}

function base(tok) {
  return String(tok).replaceAll('\\', '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
}

/**
 * @param {string} segment
 * @param {{policy: object, cwd: string, repoRoot: string | null}} ctx
 */
export function checkBashWrite(segment, ctx) {
  for (const target of writeTargets(segment)) {
    if (matchedGlob(target, ctx)) return deny(target, 'Writing to');
  }
  return null;
}
