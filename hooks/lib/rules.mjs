// Decision entry point: dispatches a hook input to the shell or MCP rules.

import { expandWithState } from './shell.mjs';
import { checkSegment, resolveDir, SHELL_RULE_IDS } from './rules/shell-rules.mjs';
import { checkMcp } from './rules/mcp-rules.mjs';
import { checkFileTool, checkBashWrite, checkRedirects } from './rules/file-rules.mjs';

const ALLOW = Object.freeze({ action: 'allow' });

/** Every rule id a decision can carry. */
export const RULE_IDS = Object.freeze([
  ...new Set([
    ...SHELL_RULE_IDS,
    'protected-file',
    'supabase-mcp',
    'vercel-mcp',
    'mcp-write',
    'github-mcp',
    'mcp-destructive',
  ]),
]);

/**
 * Limits for one shell command. Beyond maxBytes, maxSegments, maxVars, maxBlockWalks (PowerShell script blocks
 * and hash tables walked) or maxNestedBytes (nested text walked in total) the command is opaque;
 * beyond maxBraceWords (all brace words judged), maxBranchLookups (distinct directories whose
 * branch is read with git) or branchLookupMs (time spent in those reads) the remaining checks
 * count as unsure.
 */
export const BUDGET = Object.freeze({
  maxBytes: 64 * 1024,
  maxSegments: 1000,
  maxVars: 200,
  maxBlockWalks: 8192,
  maxNestedBytes: 1024 * 1024,
  maxBraceWords: 4096,
  maxBranchLookups: 16,
  branchLookupMs: 3000,
});

/** currentBranch memoised per directory and capped, so one command cannot spawn git without bound. */
function branchLookup(currentBranch) {
  const cache = new Map();
  let spent = 0;
  return (dir) => {
    const key = String(dir);
    if (cache.has(key)) return cache.get(key);
    if (cache.size >= BUDGET.maxBranchLookups || spent > BUDGET.branchLookupMs) return '';
    const t = Date.now();
    let b = '';
    try {
      b = currentBranch(dir);
    } catch {
      b = '';
    }
    spent += Date.now() - t;
    cache.set(key, b);
    return b;
  };
}

function overBudget(ctx, what) {
  return {
    action: ctx.role === 'solo' ? 'ask' : 'deny',
    rule: 'opaque-shell',
    reason: `Command ${what}, too large to inspect in time.`,
  };
}

/** Absolute directory for a tracked segment cwd ('.' = ctx.cwd, null = unknown). */
function segmentCwd(base, cwd) {
  if (cwd === '.') return base;
  if (cwd === null) return null;
  return resolveDir(base, cwd);
}

/**
 * @param {{tool_name?: string, tool_input?: object}} input
 * @param {{role: 'coordinator'|'worker'|'solo', policy: object, currentBranch: (dir: string) => string, cwd: string, repoRoot: string | null}} ctx
 * @returns {{action: 'allow'|'deny'|'ask', rule?: string, reason?: string}}
 *
 * For shell tools every segment is checked with a ctx that also carries
 * `segCwd` (absolute directory the segment runs in, null when unknown),
 * `segEnvs` (variables set by earlier segments) and `heads` (branches checked out earlier).
 */
export function decide(input, ctx) {
  if (ctx.role === 'coordinator') return ALLOW;
  const tool = String(input?.tool_name ?? '');
  const toolInput = input?.tool_input ?? {};

  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(toolInput.command ?? '');
    // Input budget: the hook must answer well inside Claude Code's hook timeout, or the call proceeds.
    if (command.length > BUDGET.maxBytes) return overBudget(ctx, `is longer than ${BUDGET.maxBytes / 1024} KB`);
    const segs = expandWithState(command, BUDGET, { ps: tool === 'PowerShell' });
    if (segs.overBudget) return overBudget(ctx, `has ${segs.overBudget}`);
    const heads = new Map();
    const shared = { ...ctx, currentBranch: branchLookup(ctx.currentBranch), work: { words: BUDGET.maxBraceWords } };
    for (const { segment, cwd, envs } of segs) {
      const sctx = { ...shared, segCwd: segmentCwd(ctx.cwd, cwd), segEnvs: envs, heads };
      const d = checkSegment(segment, sctx) ?? checkBashWrite(segment, sctx);
      if (d) return { action: d.action, rule: d.rule, reason: d.reason };
    }
    return checkRedirects(command, shared) ?? ALLOW;
  }
  if (tool.startsWith('mcp__')) {
    return checkMcp(tool, toolInput, ctx) ?? ALLOW;
  }
  return checkFileTool(tool, toolInput, ctx) ?? ALLOW;
}
