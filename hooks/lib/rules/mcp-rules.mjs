// MCP tool rules. Tool names look like mcp__<server>__<tool>.

import { globMatch } from '../paths.mjs';

const SUPABASE_WRITES = new Set([
  'apply_migration',
  'deploy_edge_function',
  'create_edge_function_secret',
  'merge_branch',
  'reset_branch',
  'rebase_branch',
  'delete_branch',
  'pause_project',
  'restore_project',
  'update_storage_config',
]);
// GitHub MCP tools that write a commit or move a ref on the branch named in `branch` / `ref`.
const GITHUB_BRANCH_WRITES = new Set(['push_files', 'create_or_update_file', 'delete_file', 'update_ref', 'delete_branch']);

const VERCEL_READ = /^(get|list|search|filter|count|aggregate|read|web_fetch)(_|-|$)/;
const READ_VERBS = 'get|list|search|read|describe|query|fetch|find|count|aggregate|filter|show|check|lookup|retrieve|watch';
const GENERIC_READ = new RegExp(`^(${READ_VERBS})(_|-|$)`);
const GENERIC_READ_CAMEL = new RegExp(`^(${READ_VERBS})([A-Z0-9]|$)`);
const DESTRUCTIVE_VERBS = 'delete|destroy|drop|deploy|reset|merge|promote|rollback|pause|push|publish|truncate|remove';
const DESTRUCTIVE = new RegExp(`^(${DESTRUCTIVE_VERBS})(_|-|$)`);
const DESTRUCTIVE_CAMEL = new RegExp(`^(${DESTRUCTIVE_VERBS})([A-Z0-9]|$)`);
// a "read" tool whose name also carries one of these words is not trusted as a read (show_drop)
const WRITE_WORDS = new Set([
  ...DESTRUCTIVE_VERBS.split('|'),
  'create', 'update', 'insert', 'write', 'set', 'put', 'patch', 'exec', 'execute', 'kill', 'revoke', 'grant',
]);

// ---- SQL ----
const READ_FIRST = new Set(['select', 'with', 'explain', 'show', 'values', 'table']);
const SQL_FIRST = new Set([
  ...READ_FIRST,
  'insert', 'update', 'delete', 'alter', 'create', 'drop', 'truncate', 'grant', 'revoke', 'comment', 'merge',
  'call', 'copy', 'do', 'refresh', 'import', 'security', 'vacuum', 'reindex', 'cluster', 'lock', 'set', 'reset',
  'analyze', 'begin', 'commit', 'rollback', 'declare', 'execute', 'prepare', 'discard', 'listen', 'notify',
  'load', 'reassign', 'checkpoint',
]);
const SQL_WRITE_WORD =
  /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|comment\s+on|merge|call|copy|into|refresh\s+materialized|import\s+foreign|security\s+label|vacuum|reindex|cluster|lock\s+table)\b|\bdo\s+(e?'|\$\w*\$|language\b)/i;
const SQL_WRITE_FN =
  /\b(setval|nextval|pg_terminate_backend|pg_cancel_backend|lo_unlink|lo_import|lo_export|lo_put|lo_from_bytea|pg_drop_replication_slot|pg_create_physical_replication_slot|pg_create_logical_replication_slot|pg_reload_conf|set_config|pg_switch_wal|pg_create_restore_point|pg_promote|pg_rotate_logfile|pg_file_write|pg_logical_emit_message|dblink_exec|dblink)\s*\(/i;
const SQL_KEYS = new Set(['sql', 'query', 'statement', 'statements', 'text']);

export function parseToolName(toolName) {
  const rest = String(toolName ?? '').replace(/^mcp__/, '');
  const i = rest.indexOf('__');
  return i === -1 ? { server: rest, tool: '' } : { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/**
 * Two views of a SQL text with comments removed: `blank` has string literals, dollar-quoted bodies and
 * quoted identifiers replaced by spaces; `idents` blanks literals but keeps identifier text unquoted.
 * With `backslash`, a backslash escapes the next character inside every '...' literal (legacy
 * standard_conforming_strings=off); E'...' literals always honour backslash escapes.
 */
function blankSql(sql, backslash) {
  const s = String(sql ?? '');
  let blank = '';
  let idents = '';
  const put = (b, id = b) => {
    blank += b;
    idents += id;
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "'") {
      const esc = backslash || (/[eE]/.test(s[i - 1] ?? '') && !/[\w$]/.test(s[i - 2] ?? ''));
      let j = i + 1;
      while (j < s.length) {
        if (esc && s[j] === '\\') j += 2;
        else if (s[j] === "'" && s[j + 1] === "'") j += 2;
        else if (s[j] === "'") break;
        else j++;
      }
      const fill = `'${' '.repeat(Math.max(0, Math.min(j, s.length) - i - 1))}'`;
      put(fill);
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let name = '';
      while (j < s.length) {
        if (s[j] === '"' && s[j + 1] === '"') {
          name += '"';
          j += 2;
        } else if (s[j] === '"') break;
        else name += s[j++];
      }
      put(`"${' '.repeat(name.length)}"`, ` ${name} `);
      i = j + 1;
    } else if (c === '$' && /^\$([A-Za-z_]\w*)?\$/.test(s.slice(i)) && !/\w/.test(s[i - 1] ?? '')) {
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(s.slice(i))[0];
      const end = s.indexOf(tag, i + tag.length);
      const stop = end === -1 ? s.length : end;
      put(`${tag}${' '.repeat(stop - i - tag.length)}${end === -1 ? '' : tag}`);
      i = end === -1 ? s.length : end + tag.length;
    } else if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
      put(' ');
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      put(' ');
    } else {
      put(c);
      i++;
    }
  }
  return { blank, idents };
}

const firstWord = (stmt) => (/^[\s(]*([A-Za-z_]+)/.exec(stmt)?.[1] ?? '').toLowerCase();

/**
 * Why `sql` is not a read, or null. `strict`: the text is known to be SQL (unknown first words are
 * writes); otherwise only text that starts a statement with a SQL keyword is judged.
 * @returns {string | null} the matched text, upper-cased
 */
export function sqlWrite(sql, strict = true) {
  for (const backslash of [false, true]) {
    const { blank, idents } = blankSql(sql, backslash);
    const words = blank.split(';').map(firstWord).filter(Boolean);
    if (!strict && !words.some((w) => SQL_FIRST.has(w))) continue;
    const bad = words.find((w) => !READ_FIRST.has(w));
    if (bad) return bad.toUpperCase();
    const m = SQL_WRITE_WORD.exec(blank) ?? SQL_WRITE_FN.exec(idents);
    if (m) return m[0].replace(/\s*\($/, '').replace(/\s+/g, ' ').toUpperCase();
  }
  return null;
}

/** [lower-cased key, string value] pairs at any depth (arrays inherit their key). */
function strings(value, key = '', out = [], depth = 0) {
  if (depth > 8) return out;
  if (typeof value === 'string') out.push([key, value]);
  else if (Array.isArray(value)) for (const v of value) strings(v, key, out, depth + 1);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) strings(v, k.toLowerCase(), out, depth + 1);
  }
  return out;
}

/** First write found in the SQL-looking string values of `input`, or null. */
function inputSqlWrite(input, strictKeys) {
  for (const [k, v] of strings(input)) {
    const w = sqlWrite(v, strictKeys && SQL_KEYS.has(k));
    if (w) return w;
  }
  return null;
}

const nameWords = (raw) =>
  String(raw)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);

function isRead(rawTool) {
  const tool = rawTool.toLowerCase();
  if (!GENERIC_READ.test(tool) && !GENERIC_READ_CAMEL.test(rawTool)) return false;
  return !nameWords(rawTool).slice(1).some((w) => WRITE_WORDS.has(w));
}

const isDestructive = (rawTool) => DESTRUCTIVE.test(rawTool.toLowerCase()) || DESTRUCTIVE_CAMEL.test(rawTool);

/** Tools that carry SQL: a name with "sql", or a query verb; the SQL check decides for them. */
function sqlTool(tool) {
  if (!/sql/.test(tool) && !/^query(_|-|$)/.test(tool)) return null;
  const runs = /^query(_|-|$)/.test(tool) || /(^|_)(execute|exec|run|query)(_|$)/.test(tool) || GENERIC_READ.test(tool);
  return runs ? { strict: /sql/.test(tool) } : null;
}

function isProdServer(server, policy) {
  const s = server.toLowerCase();
  return (policy.production?.mcpServers ?? []).some((e) => {
    const x = e.toLowerCase();
    return s === x || s.endsWith(`_${x}`);
  });
}

/** A listed production project ref found anywhere in the input (equal, or inside a longer string). */
function prodRef(input, policy) {
  const prod = (policy.production?.projectRefs ?? []).filter(Boolean);
  if (!prod.length) return undefined;
  for (const [, v] of strings(input)) {
    const lv = v.toLowerCase();
    for (const ref of prod) {
      const lr = ref.toLowerCase();
      if (lv === lr) return ref;
      if (lr.length >= 8) {
        const i = lv.indexOf(lr);
        if (i !== -1 && !/[a-z0-9]/.test(lv[i - 1] ?? '') && !/[a-z0-9]/.test(lv[i + lr.length] ?? '')) return ref;
      }
    }
  }
  return undefined;
}

function writeAction(server, input, ctx) {
  return ctx.role === 'worker' || isProdServer(server, ctx.policy) || prodRef(input, ctx.policy) ? 'deny' : 'ask';
}

const unsure = (ctx) => (ctx.role === 'solo' ? 'ask' : 'deny');

function protectedBranch(name, list) {
  const b = String(name).trim().replace(/^refs\//, '').replace(/^heads\//, '');
  return (list ?? []).find((p) => p === b || (/[*?]/.test(p) && globMatch(p, b, 'linux')));
}

/** Value of the first `method` key at any depth. */
function methodOf(input) {
  return strings(input).find(([k]) => k === 'method')?.[1];
}

function github(tool, input, ctx) {
  if (tool === 'merge_pull_request') {
    const n = input.pull_number ?? input.pullNumber;
    return {
      action: 'deny',
      rule: 'github-mcp',
      reason: `GitHub MCP tool "merge_pull_request"${n !== undefined ? ` (pull request ${n})` : ''} merges into a shared branch.`,
    };
  }
  if (/branch_protection|ruleset/.test(tool) && !isRead(tool)) {
    return { action: 'deny', rule: 'github-mcp', reason: `GitHub MCP tool "${tool}" changes branch protection.` };
  }
  if (!GITHUB_BRANCH_WRITES.has(tool)) return undefined;
  const raw = [input.branch, input.ref].find((v) => typeof v === 'string' && v.trim());
  if (!raw) {
    return {
      action: unsure(ctx),
      rule: 'github-mcp',
      reason: `GitHub MCP tool "${tool}" names no branch, so it may write to the default branch.`,
    };
  }
  const hit = protectedBranch(raw, ctx.policy.protectedBranches);
  if (hit) {
    return { action: 'deny', rule: 'github-mcp', reason: `GitHub MCP tool "${tool}" writes to protected branch "${raw}".` };
  }
  return null; // a feature-branch write, like `git push origin feat/x`
}

/**
 * @returns {{action: 'deny'|'ask', rule: string, reason: string} | null}
 */
export function checkMcp(toolName, toolInput, ctx) {
  const parsed = parseToolName(toolName);
  const server = parsed.server.toLowerCase();
  const rawTool = parsed.tool;
  const tool = rawTool.toLowerCase();
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const { policy } = ctx;
  const prod = isProdServer(server, policy);

  if (server.includes('supabase')) {
    if (SUPABASE_WRITES.has(tool)) {
      return {
        action: writeAction(server, input, ctx),
        rule: 'supabase-mcp',
        reason: `Supabase MCP tool "${tool}" changes a database or project.`,
      };
    }
    if (tool === 'execute_sql') {
      const w = inputSqlWrite(input, true);
      if (w) {
        return {
          action: writeAction(server, input, ctx),
          rule: 'supabase-mcp',
          reason: `Supabase execute_sql query contains write statement "${w}".`,
        };
      }
    }
  }

  if (server.includes('vercel')) {
    if (/^web_fetch(_|$)/.test(tool)) {
      const m = methodOf(input);
      if (m && !/^(get|head)$/i.test(m.trim())) {
        return {
          action: writeAction(server, input, ctx),
          rule: 'vercel-mcp',
          reason: `Vercel MCP tool "${tool}" sends a ${m.trim().toUpperCase()} request, which is not a read.`,
        };
      }
    } else if (!VERCEL_READ.test(tool)) {
      return {
        action: writeAction(server, input, ctx),
        rule: 'vercel-mcp',
        reason: `Vercel MCP tool "${tool}" is not a read-only operation.`,
      };
    }
  }

  let handled = false;
  if (server.includes('github')) {
    const d = github(tool, input, ctx);
    if (d) return d;
    handled = d === null;
  }

  const supabaseSql = server.includes('supabase') && tool === 'execute_sql';
  const sqlish = supabaseSql ? null : sqlTool(tool);
  if (sqlish) {
    const w = inputSqlWrite(input, sqlish.strict);
    if (w) {
      return prod
        ? { action: 'deny', rule: 'mcp-write', reason: `MCP tool "${tool}" on production server "${server}" runs write SQL "${w}".` }
        : { action: unsure(ctx), rule: 'mcp-destructive', reason: `MCP tool "${tool}" on server "${server}" runs write SQL "${w}".` };
    }
  }

  if (prod && !supabaseSql && !sqlish && !isRead(rawTool)) {
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
  if (!prod && !handled && isDestructive(rawTool)) {
    return {
      action: unsure(ctx),
      rule: 'mcp-destructive',
      reason: `MCP tool "${tool}" on server "${server}" looks destructive (its name starts with "${DESTRUCTIVE.exec(tool)?.[1] ?? DESTRUCTIVE_CAMEL.exec(rawTool)?.[1]}").`,
    };
  }
  return null;
}
