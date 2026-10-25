// Decision entry point: dispatches a hook input to the shell or MCP rules.

import { expand } from './shell.mjs';
import { checkSegment } from './rules/shell-rules.mjs';
import { checkMcp } from './rules/mcp-rules.mjs';
import { checkFileTool, checkBashWrite, checkRedirects } from './rules/file-rules.mjs';

const ALLOW = Object.freeze({ action: 'allow' });

/**
 * @param {{tool_name?: string, tool_input?: object}} input
 * @param {{role: 'coordinator'|'worker'|'solo', policy: object, currentBranch: (dir: string) => string, cwd: string, repoRoot: string | null}} ctx
 * @returns {{action: 'allow'|'deny'|'ask', rule?: string, reason?: string}}
 */
export function decide(input, ctx) {
  if (ctx.role === 'coordinator') return ALLOW;
  const tool = String(input?.tool_name ?? '');
  const toolInput = input?.tool_input ?? {};

  if (tool === 'Bash' || tool === 'PowerShell') {
    const redirect = checkRedirects(toolInput.command, ctx);
    for (const segment of expand(toolInput.command)) {
      const d = checkSegment(segment, ctx) ?? checkBashWrite(segment, ctx);
      if (d) return d;
    }
    return redirect ?? ALLOW;
  }
  if (tool.startsWith('mcp__')) {
    return checkMcp(tool, toolInput, ctx) ?? ALLOW;
  }
  return checkFileTool(tool, toolInput, ctx) ?? ALLOW;
}
