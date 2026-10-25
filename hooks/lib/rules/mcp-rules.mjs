// MCP tool rules. Tool names look like mcp__<server>__<tool>.

const SUPABASE_WRITES = new Set([
  'apply_migration',
  'deploy_edge_function',
  'create_edge_function_secret',
  'merge_branch',
  'reset_branch',
  'rebase_branch',
  'delete_branch',
]);
const VERCEL_READ = /^(get|list|search|filter|count|aggregate|read|web_fetch)/;
const GENERIC_READ = /^(get|list|search|read|describe|query|fetch|find|count|aggregate|filter|show|check|lookup|retrieve|watch)_?/;
const SQL_WRITE = /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|comment\s+on|merge|call|copy|do)\b/i;
const REF_KEYS = new Set(['project_ref', 'projectref', 'project_id']);

export function parseToolName(toolName) {
  const rest = String(toolName ?? '').replace(/^mcp__/, '');
  const i = rest.indexOf('__');
  return i === -1 ? { server: rest, tool: '' } : { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

function stripSqlComments(sql) {
  return String(sql ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ');
}

function isProdServer(server, policy) {
  const s = server.toLowerCase();
  return (policy.production?.mcpServers ?? []).some((e) => {
    const x = e.toLowerCase();
    return s === x || s.endsWith(`_${x}`);
  });
}

/** Collect project ref values found under project_ref / projectRef / project_id keys, at any depth. */
function projectRefs(value, out = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return out;
  for (const [k, v] of Object.entries(value)) {
    if (REF_KEYS.has(k.toLowerCase()) && typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') projectRefs(v, out, depth + 1);
  }
  return out;
}

function prodRef(input, policy) {
  const prod = policy.production?.projectRefs ?? [];
  return projectRefs(input).find((r) => prod.includes(r));
}

function writeAction(server, input, ctx) {
  return ctx.role === 'worker' || isProdServer(server, ctx.policy) || prodRef(input, ctx.policy) ? 'deny' : 'ask';
}

/**
 * @returns {{action: 'deny'|'ask', rule: string, reason: string} | null}
 */
export function checkMcp(toolName, toolInput, ctx) {
  const { server, tool } = parseToolName(toolName);
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const lowerServer = server.toLowerCase();
  const { policy } = ctx;

  if (lowerServer.includes('supabase')) {
    if (SUPABASE_WRITES.has(tool)) {
      return {
        action: writeAction(server, input, ctx),
        rule: 'supabase-mcp',
        reason: `Supabase MCP tool "${tool}" changes a database or project.`,
      };
    }
    if (tool === 'execute_sql') {
      const m = SQL_WRITE.exec(stripSqlComments(input.query));
      if (m) {
        return {
          action: writeAction(server, input, ctx),
          rule: 'supabase-mcp',
          reason: `Supabase execute_sql query contains write statement "${m[0].toUpperCase()}".`,
        };
      }
    }
  }

  if (lowerServer.includes('vercel') && !VERCEL_READ.test(tool)) {
    return {
      action: writeAction(server, input, ctx),
      rule: 'vercel-mcp',
      reason: `Vercel MCP tool "${tool}" is not a read-only operation.`,
    };
  }

  if (isProdServer(server, policy) && !GENERIC_READ.test(tool)) {
    return {
      action: 'deny',
      rule: 'mcp-write',
      reason: `MCP tool "${tool}" on production server "${server}" is not a read-only operation.`,
    };
  }
  const ref = prodRef(input, policy);
  if (ref) {
    return {
      action: 'deny',
      rule: 'mcp-write',
      reason: `MCP tool "${tool}" targets production project "${ref}".`,
    };
  }
  return null;
}
