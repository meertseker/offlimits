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

const PROD_ASK_RULES = new Set(['supabase-mcp', 'vercel-mcp']);

/**
 * permissionDecisionReason for an ask. The "no production definition" hint applies only to the
 * Supabase and Vercel MCP rules, and only while offlimits.json defines no production.
 * @param {{rule?: string, reason?: string}} d
 * @param {{productionConfigured?: boolean}} [opts]
 */
export function askReason(d, opts = {}) {
  const reason = String(d.reason ?? '').replace(/\.+$/, '');
  const tail = PROD_ASK_RULES.has(d.rule) && !opts.productionConfigured
    ? 'No production definition in offlimits.json, so this asks instead of blocking. See /offlimits.'
    : 'This asks in solo mode and is denied for workers. See /offlimits.';
  return `offlimits: ${reason}. ${tail}`;
}

/** SessionStart context banner. */
export function banner(f) {
  const lines = [
    `offlimits active - role: ${f.role}${f.roleViaDefault ? ' (defaultRole)' : ''}; protected branches: ${f.protectedBranches.join(', ') || 'none'}; ` +
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

const STAGE_NEXT = {
  briefed: 'read the brief and start the design',
  designing: 'finish the design; if approval is human, send it and wait',
  'awaiting-approval': 'wait for approval',
  building: 'build, run checks, deliver',
  delivered: 'wait for coordinator review',
};
const TEAM_MAX_LINES = 25;

/** Team-mode section of the SessionStart banner; never more than 25 lines. */
export function teamBanner(f) {
  const lines = [];
  if (f.role === 'coordinator') {
    const lanes = Object.entries(f.board?.lanes ?? {});
    const counts = {};
    for (const [, l] of lanes) counts[l.stage] = (counts[l.stage] ?? 0) + 1;
    const parts = Object.entries(counts).map(([s, n]) => `${n} ${s}`);
    lines.push(`team: ${lanes.length} lanes${parts.length ? ` (${parts.join(', ')})` : ''}`);
    const lists = [
      ['waiting for your review', f.deliveriesWaiting],
      ['questions for the human', f.questionsWaiting],
      ['merged but not cleaned (run team done)', f.staleLanes],
    ];
    const tail = [];
    if (f.otherCoordinatorPid) tail.push(`WARNING: another coordinator is running (pid ${f.otherCoordinatorPid})`);
    if (f.cli) tail.push(f.cli);
    const fixed = 1 + lists.filter(([, a]) => a?.length).length + tail.length;
    const laneRoom = Math.max(0, TEAM_MAX_LINES - fixed);
    const perList = 60;
    for (const [label, arr] of lists) {
      if (!arr?.length) continue;
      let shown = arr;
      let text = arr.join(', ');
      if (text.length > perList) {
        let n = 0, len = 0;
        while (n < arr.length && len + arr[n].length + 2 <= perList) len += arr[n++].length + 2;
        shown = arr.slice(0, n);
        text = `${shown.join(', ')}${shown.length ? ' ' : ''}...and ${arr.length - n} more`;
      }
      lines.push(`${label}: ${text}`);
    }
    // One line per lane while room remains, leaving a line for the overflow summary.
    if (lanes.length && laneRoom > 0) {
      const fit = lanes.length <= laneRoom ? lanes.length : laneRoom - 1;
      for (const [name, l] of lanes.slice(0, fit)) lines.push(`  ${name}: ${l.stage}`);
      if (fit < lanes.length) lines.push(`  ...and ${lanes.length - fit} more`);
    }
    lines.push(...tail);
  } else if (f.role === 'worker') {
    if (f.lane) {
      lines.push(
        `You are worker ${f.lane}. Brief: ${f.briefPath ?? 'none'}. Stage: ${f.stage ?? 'unknown'}. Next: ${STAGE_NEXT[f.stage] ?? 'ask the coordinator'}`,
        'If the gate blocks you, hand over to the coordinator.',
      );
    } else {
      lines.push('You are a worker without a lane; ask the coordinator for a brief.');
    }
    if (f.cli) lines.push(f.cli);
  } else {
    lines.push('This is a team repo. Start the coordinator from a terminal with: team coordinator');
    if (f.cli) lines.push(f.cli);
  }
  return lines.slice(0, TEAM_MAX_LINES).join('\n');
}
