// Shell command rules for Bash / PowerShell segments.
// Each rule is { id, test(c) -> reason | null, action?(ctx) }, applied in order.

import { stripAssignments, tokens, OPAQUE_PREFIX } from '../shell.mjs';

const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'nice', 'builtin']);
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const PM_RUNNERS = new Set(['pnpm', 'yarn', 'npm', 'bun']);
const PM_SHORTCUT = new Set(['pnpm', 'yarn', 'bun']);
const PM_SUBCOMMANDS = new Set(['add', 'install', 'i', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'ci', 'test', 'build', 'init', 'link', 'publish', 'pack', 'exec', 'dlx', 'x', 'run', 'workspace', 'workspaces', 'npm', 'config', 'cache', 'info', 'list', 'ls', 'why', 'audit', 'outdated']);
const PM_VALUE_FLAGS = ['--filter', '-F', '--dir', '-C', '--cwd', '--workspace'];

const base = (t) => String(t ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clip = (s) => (s.length > 90 ? `${s.slice(0, 87)}...` : s);

/** Parse the command a segment runs: name (basename, wrappers and npx/dlx runners removed) and args. */
function parseCommand(rest) {
  const t = tokens(rest);
  let i = 0;
  const envs = [];
  const skipPrefix = () => {
    for (;;) {
      if (i >= t.length) return;
      const prev = i > 0 ? base(t[i - 1]) : '';
      if (/^[A-Za-z_]\w*=/.test(t[i])) envs.push(t[i++]);
      else if (WRAPPERS.has(base(t[i]))) i++;
      else if (prev === 'sudo' && (t[i] === '-u' || t[i] === '-g')) i += 2;
      else if (WRAPPERS.has(prev) && t[i].startsWith('-')) i++;
      else return;
    }
  };
  for (let guard = 0; guard < 6; guard++) {
    skipPrefix();
    const name = base(t[i]);
    if (RUNNERS.has(name)) {
      i++;
      while (i < t.length && t[i].startsWith('-')) i += t[i] === '-p' || t[i] === '--package' ? 2 : 1;
    } else if (PM_RUNNERS.has(name) && ['dlx', 'exec', 'x'].includes(t[i + 1])) {
      i += 2;
      while (i < t.length && t[i].startsWith('-')) i++;
    } else if (PM_SHORTCUT.has(name)) {
      let j = i + 1;
      while (j < t.length && t[j].startsWith('-')) j += PM_VALUE_FLAGS.includes(t[j]) ? 2 : 1;
      if (t[j] === 'run') {
        j++;
        while (j < t.length && t[j].startsWith('-')) j++;
      }
      if (j < t.length && !PM_SUBCOMMANDS.has(t[j]) && !t[j].startsWith('.')) i = j;
      else break;
    } else break;
  }
  let name = base(t[i]);
  if (name.lastIndexOf('@') > 0) name = name.slice(0, name.lastIndexOf('@'));
  return { name, args: t.slice(i + 1), toks: t, envs };
}

function positionals(args, valueFlags = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.length > 1 && a.startsWith('-')) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const hasFlag = (args, ...names) => args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));

// ---------- git ----------

function parseGit(info) {
  if (info.name !== 'git') return null;
  const a = info.args;
  let dir = null;
  let i = 0;
  for (; i < a.length; i++) {
    const x = a[i];
    if (x === '-C') dir = a[++i] ?? null;
    else if (x === '-c' || x === '--namespace' || x === '--git-dir' || x === '--work-tree') i++;
    else if (x.startsWith('-')) continue;
    else break;
  }
  return { dir, sub: a[i] ?? '', args: a.slice(i + 1) };
}

function branchRegex(branches) {
  const names = branches.filter(Boolean).map(esc);
  return names.length ? new RegExp(`(^|:|\\+)(refs/heads/)?(${names.join('|')})$`) : null;
}

const GIT_DYNAMIC = /[`$]/;
const PUSH_VALUE_FLAGS = ['-o', '--push-option', '--repo', '--receive-pack', '--exec'];

function safeBranch(ctx, dir) {
  try {
    return String(ctx.currentBranch(dir || ctx.cwd) ?? '').trim();
  } catch {
    return '';
  }
}

const unsureAction = (ctx) => (ctx.role === 'worker' ? 'deny' : 'ask');

function gitPushProtected(c) {
  const g = parseGit(c.info);
  if (!g || g.sub !== 'push') return null;
  const { policy } = c.ctx;
  const quoted = `(matched "${clip(c.rest)}")`;
  if (hasFlag(g.args, '--all', '--mirror')) {
    return `git push ${g.args.find((x) => x.startsWith('--all') || x.startsWith('--mirror')).split('=')[0]} updates every branch including protected ones ${quoted}.`;
  }
  const pos = positionals(g.args, PUSH_VALUE_FLAGS);
  const refspecs = hasFlag(g.args, '--repo') ? pos : pos.slice(1);
  const re = branchRegex(policy.protectedBranches);
  if (re) {
    for (const r of refspecs) {
      const m = re.exec(r);
      if (m) return `git push targets protected branch "${m[3]}" ${quoted}.`;
    }
  }
  const dynamic = GIT_DYNAMIC.test(c.rest.slice(c.rest.indexOf('push')));
  const implicit = dynamic || refspecs.length === 0 || refspecs.some((r) => r === 'HEAD' || r === '@');
  if (implicit) {
    const b = safeBranch(c.ctx, g.dir);
    if (!b) return { action: unsureAction(c.ctx), reason: `git push destination unclear and could not determine the current branch ${quoted}.` };
    if (policy.protectedBranches.includes(b)) return `git push from protected branch "${b}" ${quoted}.`;
  }
  return null;
}

function gitBranchProtected(c) {
  const g = parseGit(c.info);
  if (!g || g.sub !== 'branch') return null;
  const mutating = g.args.some((a) => /^-[a-zA-Z]*[DdMmf][a-zA-Z]*$/.test(a) || a === '--delete' || a === '--move' || a === '--force');
  if (!mutating) return null;
  const hit = positionals(g.args).find((p) => c.ctx.policy.protectedBranches.includes(p));
  return hit ? `git branch deletes or renames protected branch "${hit}" (matched "${clip(c.rest)}").` : null;
}

// ---------- gh ----------

const GH_SENSITIVE = /^\/?repos\/[^/]+\/[^/]+\/(rulesets(\/.*)?|branches\/[^/]+\/protection(\/.*)?|merges|pulls\/[^/]+\/merge)$/;

function ghWrite(c) {
  if (c.info.name !== 'gh') return null;
  const a = c.info.args;
  const pos = positionals(a, ['-R', '--repo', '-X', '--method', '-f', '-F', '-H', '--header', '--input', '--jq', '-q', '-t', '--template', '--hostname']);
  const [p0, p1] = pos;
  const shown = `(matched "${clip(c.rest)}")`;
  if (p0 === 'pr' && p1 === 'merge') return `gh pr merge merges into a shared branch ${shown}.`;
  if (p0 === 'workflow' && p1 === 'run') return `gh workflow run starts a CI workflow ${shown}.`;
  if (p0 === 'release' && ['create', 'delete', 'upload'].includes(p1)) return `gh release ${p1} publishes or changes a release ${shown}.`;
  if (p0 === 'repo' && p1 === 'delete') return `gh repo delete removes a repository ${shown}.`;
  if (p0 === 'api') {
    const endpoint = pos[1] ?? '';
    let method = '';
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-X' || a[i] === '--method') method = a[i + 1] ?? '';
      else if (a[i].startsWith('--method=')) method = a[i].slice(9);
      else if (/^-X./.test(a[i])) method = a[i].slice(2);
    }
    const write = /^(POST|PUT|PATCH|DELETE)$/i.test(method) || hasFlag(a, '-f', '-F', '--field', '--raw-field');
    if (write && GH_SENSITIVE.test(endpoint)) return `gh api writes to protected endpoint "${endpoint}" ${shown}.`;
  }
  return null;
}

// ---------- supabase ----------

function supabaseRemote(c) {
  if (c.info.name !== 'supabase') return null;
  const pos = positionals(c.info.args, ['--workdir', '--db-url', '--project-ref']);
  const key = `${pos[0] ?? ''} ${pos[1] ?? ''}`;
  const shown = `(matched "${clip(c.rest)}")`;
  const hit =
    key === 'db push' ||
    key === 'db link' ||
    pos[0] === 'link' ||
    key === 'migration repair' ||
    key === 'functions deploy' ||
    key === 'secrets set' ||
    key === 'secrets unset' ||
    (key === 'db reset' && hasFlag(c.info.args, '--linked', '--db-url'));
  return hit ? `supabase ${key} changes the linked remote project ${shown}.` : null;
}

// ---------- remote databases ----------

const DB_TOOLS = new Set(['psql', 'pg_dump', 'pg_dumpall', 'pg_restore', 'mysql', 'mysqldump', 'mongosh', 'mongo', 'mongodump', 'mongorestore']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);
const URI = /^(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/([^/?#]*)/i;
const DB_URL_VAR = /\$(?:env:)?\{?DATABASE_URL\b/i;

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
  if (!DB_TOOLS.has(c.info.name)) return null;
  const { policy } = c.ctx;
  const shown = `(matched "${clip(c.rest)}")`;
  const hosts = [];
  for (const a of [...c.assignments, ...c.info.envs]) {
    const m = /^PGHOST=(.*)$/.exec(a);
    if (m) hosts.push(m[1]);
  }
  const args = c.info.args;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (DB_URL_VAR.test(a)) return `${c.info.name} connects through $DATABASE_URL, which is treated as remote ${shown}.`;
    const u = URI.exec(a) ?? URI.exec(a.replace(/^--?[\w-]+=/, ''));
    if (u) hosts.push(...hostsFromUri(u[1]));
    if (a === '-h' || a === '--host') hosts.push(args[i + 1] ?? '');
    else if (a.startsWith('--host=')) hosts.push(a.slice(7));
    else if (/^-h./.test(a)) hosts.push(a.slice(2));
    for (const m of a.matchAll(/(?:^|\s)host=([^\s'"]+)/g)) hosts.push(m[1]);
  }
  const bad = hosts.find((h) => isRemoteHost(h, policy));
  return bad !== undefined ? `${c.info.name} targets remote database host "${bad}" ${shown}.` : null;
}

// ---------- migrations ----------

function dbMigrate(c) {
  const { name, args, toks } = c.info;
  const pos = positionals(args);
  const shown = `(matched "${clip(c.rest)}")`;
  const k2 = `${pos[0] ?? ''} ${pos[1] ?? ''}`;
  let what = null;
  if (name === 'prisma' && (k2 === 'migrate deploy' || k2 === 'db push')) what = `prisma ${k2}`;
  else if (name === 'drizzle-kit' && (pos[0] === 'push' || pos[0] === 'migrate')) what = `drizzle-kit ${pos[0]}`;
  else if (name === 'flyway' && pos[0] === 'migrate') what = 'flyway migrate';
  else if (name === 'alembic' && pos[0] === 'upgrade') what = 'alembic upgrade';
  else if (name === 'knex' && pos[0] === 'migrate:latest') what = 'knex migrate:latest';
  else if (toks.some((t) => /^db:migrate(:(up|down|redo))?$/.test(t))) {
    const prod = [...c.assignments, ...toks].some((t) => /^(RAILS_ENV|RACK_ENV)=production$/i.test(t));
    if (prod) what = 'rails db:migrate in production';
  } else if (toks.some((t) => base(t) === 'artisan') && toks.some((t) => /^migrate(:(fresh|refresh|reset|rollback))?$/.test(t)) && hasFlag(args, '--force')) {
    what = 'artisan migrate --force';
  }
  return what ? `${what} applies migrations to a database ${shown}.` : null;
}

// ---------- deploys ----------

const DEPLOY_VALUE_FLAGS = ['-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user', '--project', '--region', '--profile', '--output', '-a', '--app', '-s', '--stage', '--org', '--config', '--chdir', '-r', '-e'];

function hasTarget(args) {
  return args.some((a, i) => /^--target=production$/i.test(a) || (a === '--target' && /^production$/i.test(args[i + 1] ?? '')));
}

function deploy(c) {
  const { name, args } = c.info;
  const pos = positionals(args, DEPLOY_VALUE_FLAGS);
  const [p0, p1] = pos;
  const label = () => `${name} ${[p0, p1].filter(Boolean).join(' ')}`;
  let hit = false;
  switch (name) {
    case 'vercel':
      hit = hasFlag(args, '--prod', '--production') || hasTarget(args) || p0 === 'promote' || p0 === 'rollback' || (p0 === 'alias' && p1 === 'set');
      break;
    case 'netlify':
      hit = p0 === 'deploy' && hasFlag(args, '--prod', '-p', '--prodIfUnlocked');
      break;
    case 'fly':
    case 'flyctl':
    case 'wrangler':
    case 'firebase':
    case 'serverless':
    case 'sls':
    case 'sst':
    case 'cdk':
      hit = p0 === 'deploy' || (name === 'wrangler' && p0 === 'publish');
      break;
    case 'railway':
      hit = p0 === 'up';
      break;
    case 'pulumi':
      hit = p0 === 'up' || p0 === 'destroy';
      break;
    case 'terraform':
    case 'tofu':
      hit = p0 === 'apply' || p0 === 'destroy';
      break;
    case 'kubectl':
      hit = ['apply', 'delete', 'rollout', 'scale'].includes(p0);
      break;
    case 'helm':
      hit = ['install', 'upgrade', 'uninstall', 'rollback'].includes(p0);
      break;
    case 'gcloud':
      hit = (p0 === 'run' || p0 === 'app') && p1 === 'deploy';
      break;
    case 'aws':
      hit = p0 === 'cloudformation' && ['deploy', 'update-stack', 'delete-stack'].includes(p1);
      break;
    case 'az':
      hit = p0 === 'webapp' && p1 === 'deploy';
      break;
    case 'eas':
      hit = p0 === 'update' || p0 === 'submit';
      break;
    case 'ssh': {
      const m = /(\S*(?:deploy|rollback)\.sh|systemctl\s+restart[^'"]*|caddy\s+reload)/.exec(c.rest);
      if (m) return `ssh runs a remote deploy action "${clip(m[1])}" (matched "${clip(c.rest)}").`;
      return null;
    }
    case 'docker':
    case 'docker-compose': {
      const compose = name === 'docker-compose' || p0 === 'compose';
      if (!compose || !pos.includes('up') || !hasFlag(args, '-d', '--detach')) return null;
      const files = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-f' || args[i] === '--file') files.push(args[i + 1] ?? '');
        else if (args[i].startsWith('--file=')) files.push(args[i].slice(7));
        else if (/^-f./.test(args[i]) && !args[i].startsWith('--')) files.push(args[i].slice(2));
      }
      const f = files.find((x) => /^\/(opt|srv|var)\//.test(x));
      return f ? `docker compose up -d on server path "${f}" starts live services (matched "${clip(c.rest)}").` : null;
    }
    default:
      return null;
  }
  return hit ? `${label()} deploys or changes live infrastructure (matched "${clip(c.rest)}").` : null;
}

function publish(c) {
  const { name, args } = c.info;
  const pos = positionals(args, name === 'npm' ? ['-w', '--workspace', '--prefix'] : name === 'pnpm' ? ['--filter', '-F', '-C', '--dir'] : []);
  const [p0, p1] = pos;
  const hit =
    ((name === 'npm' || name === 'pnpm') && p0 === 'publish') ||
    (name === 'yarn' && (p0 === 'publish' || (p0 === 'npm' && p1 === 'publish'))) ||
    (name === 'cargo' && p0 === 'publish') ||
    (name === 'twine' && p0 === 'upload') ||
    (name === 'gem' && p0 === 'push') ||
    (name === 'dotnet' && p0 === 'nuget' && p1 === 'push');
  return hit ? `${name} ${pos.slice(0, 2).join(' ')} publishes a package (matched "${clip(c.rest)}").` : null;
}

// ---------- role spoofing ----------

function roleSpoof(c) {
  const role = c.ctx.policy.roleEnv;
  const R = esc(role);
  const shown = `(matched "${clip(c.segment)}")`;
  if (c.assignments.some((a) => a.split('=')[0].toLowerCase() === role.toLowerCase())) {
    return `assigning ${role} would change the agent's own role ${shown}.`;
  }
  const t = c.info.toks;
  let i = 0;
  while (i < t.length && (WRAPPERS.has(base(t[i])) || /^[A-Za-z_]\w*=/.test(t[i]) || t[i].startsWith('-'))) {
    if (t[i].toLowerCase().startsWith(`${role.toLowerCase()}=`)) return `assigning ${role} would change the agent's own role ${shown}.`;
    i++;
  }
  const patterns = [
    new RegExp(`\\b(export|set|setx|declare|typeset|readonly)\\s+(-\\w+\\s+)*${R}\\b`, 'i'),
    new RegExp(`\\$env:${R}\\s*=`, 'i'),
    new RegExp(`(set|new)-item\\s+.*\\benv:${R}\\b`, 'i'),
  ];
  return patterns.some((p) => p.test(c.rest)) ? `assigning ${role} would change the agent's own role ${shown}.` : null;
}

export const RULES = [
  { id: 'role-spoof', test: roleSpoof },
  { id: 'git-push-protected', test: gitPushProtected },
  { id: 'git-branch-protected', test: gitBranchProtected },
  { id: 'gh-write', test: ghWrite },
  { id: 'supabase-remote', test: supabaseRemote },
  { id: 'remote-db', test: remoteDb },
  { id: 'db-migrate', test: dbMigrate, action: (ctx) => (ctx.role === 'solo' ? 'ask' : 'deny') },
  { id: 'deploy', test: deploy },
  { id: 'publish', test: publish },
];

function compile(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * @param {string} segment one command segment
 * @param {{role: string, policy: object, currentBranch: (dir: string) => string, cwd: string}} ctx
 * @returns {{action: 'deny'|'ask', rule: string, reason: string} | null}
 */
export function checkSegment(segment, ctx) {
  const { assignments, rest } = stripAssignments(segment);
  const policy = ctx.policy;
  if (rest.startsWith(OPAQUE_PREFIX)) {
    return {
      action: ctx.role === 'solo' ? 'ask' : 'deny',
      rule: 'opaque-shell',
      reason: 'Shell reads its commands from stdin, cannot inspect them.',
    };
  }
  const c = { segment, rest, assignments, ctx, info: parseCommand(rest) };
  const allowed = (policy.allow ?? []).some((p) => compile(p)?.test(rest));
  for (const rule of RULES) {
    if (allowed && rule.id !== 'role-spoof') continue;
    const r = rule.test(c);
    if (!r) continue;
    if (typeof r === 'object') return { action: r.action, rule: rule.id, reason: r.reason };
    return { action: rule.action ? rule.action(ctx) : 'deny', rule: rule.id, reason: r };
  }
  if (allowed) return null;
  for (const entry of policy.extraDeny ?? []) {
    const re = compile(entry.pattern);
    const m = re && (re.exec(rest) ?? re.exec(segment));
    if (m) return { action: 'deny', rule: 'extra-deny', reason: `${entry.reason} (matched "${clip(m[0] || rest)}").` };
  }
  return null;
}
