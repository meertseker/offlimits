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
    const redirect = checkRedirects(toolInput.command, ctx);
    const heads = new Map();
    for (const { segment, cwd, envs } of expandWithState(toolInput.command)) {
      const sctx = { ...ctx, segCwd: segmentCwd(ctx.cwd, cwd), segEnvs: envs, heads };
      const d = checkSegment(segment, sctx) ?? checkBashWrite(segment, sctx);
      if (d) return { action: d.action, rule: d.rule, reason: d.reason };
    }
    return redirect ?? ALLOW;
  }
  if (tool.startsWith('mcp__')) {
    return checkMcp(tool, toolInput, ctx) ?? ALLOW;
  }
  return checkFileTool(tool, toolInput, ctx) ?? ALLOW;
}
