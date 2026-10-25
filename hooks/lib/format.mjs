/** Short, single-line description of a tool call for messages and the log. */
export function summarize(input) {
  const tool = String(input?.tool_name ?? '');
  const ti = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (tool === 'Bash' || tool === 'PowerShell') return String(ti.command ?? '').replace(/\s+/g, ' ').slice(0, 80);
  if (tool.startsWith('mcp__')) return tool;
  return String(ti.file_path ?? ti.notebook_path ?? ti.path ?? tool);
}

const NEXT_STEP = {
  worker: 'Commit your branch and hand over to the coordinator; do not work around this.',
  solo: 'Run it yourself outside Claude, or start the session with OFFLIMITS_ROLE=coordinator if this is intended.',
};

/** Four-line stderr message for a blocked call. */
export function denyMessage(d, role) {
  return [
    `offlimits: blocked ${d.summary ?? ''}`.trimEnd(),
    `rule: ${d.rule} - ${d.reason}`,
    `role: ${role}`,
    NEXT_STEP[role] ?? NEXT_STEP.solo,
  ].join('\n');
}

export function askReason(d) {
  const reason = String(d.reason ?? '').replace(/\.+$/, '');
  return `offlimits: ${reason}. No production definition in offlimits.json, so this asks instead of blocking. See /offlimits.`;
}

/** SessionStart context banner. */
export function banner(f) {
  const lines = [
    `offlimits active - role: ${f.role}; protected branches: ${f.protectedBranches.join(', ') || 'none'}; ` +
      (f.productionConfigured
        ? 'production definition found'
        : 'no production definition (MCP writes will ask instead of block)') +
      `; ${f.blocks} blocked in log. See /offlimits.`,
  ];
  if (f.role === 'worker' && f.branch && f.protectedBranches.includes(f.branch)) {
    lines.push(`WARNING: this worker is on protected branch "${f.branch}". Switch to a feat/* branch before editing.`);
  }
  if (f.errors > 0) {
    lines.push(`WARNING: ${f.errors} hook errors in .offlimits/log.jsonl. Run /offlimits to inspect them.`);
  }
  for (const p of f.problems ?? []) lines.push(`WARNING: ${p}`);
  return lines.join('\n');
}
