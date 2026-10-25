// Decision entry point: dispatches a hook input to the shell or MCP rules.

import { expand } from './shell.mjs';
import { checkSegment } from './rules/shell-rules.mjs';
import { checkMcp } from './rules/mcp-rules.mjs';

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
    for (const segment of expand(toolInput.command)) {
      const d = checkSegment(segment, ctx);
      if (d) return d;
    }
    return ALLOW;
  }
  if (tool.startsWith('mcp__')) {
    return checkMcp(tool, toolInput, ctx) ?? ALLOW;
  }
  // File tools (Write/Edit/MultiEdit/NotebookEdit) are wired in by a later task.
  return ALLOW;
}
