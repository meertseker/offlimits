import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMcp } from '../hooks/lib/rules/mcp-rules.mjs';
import { DEFAULT_POLICY } from '../hooks/lib/policy.mjs';

function ctx(role = 'solo', production = {}) {
  return {
    role,
    policy: { ...structuredClone(DEFAULT_POLICY), production: { mcpServers: [], projectRefs: [], hosts: [], ...production } },
    currentBranch: () => 'feat/x',
    cwd: '/r',
    repoRoot: '/r',
  };
}

test('supabase reads are allowed', () => {
  assert.equal(checkMcp('mcp__supabase__list_tables', {}, ctx()), null);
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: 'select 1' }, ctx()), null);
});

test('execute_sql comments do not hide or fake writes', () => {
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: '-- delete everything\nselect 1' }, ctx()), null);
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: '/* drop */ select 1' }, ctx()), null);
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: 'select 1; /* x */ drop table t' }, ctx()).rule, 'supabase-mcp');
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: 'with a as (select 1) select * from a' }, ctx()), null);
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: 'with a as (select 1) delete from t' }, ctx()).rule, 'supabase-mcp');
});

test('execute_sql write: solo ask, worker deny, production deny', () => {
  const q = { query: 'INSERT INTO t VALUES (1)' };
  assert.equal(checkMcp('mcp__supabase__execute_sql', q, ctx('solo')).action, 'ask');
  assert.equal(checkMcp('mcp__supabase__execute_sql', q, ctx('worker')).action, 'deny');
  assert.equal(checkMcp('mcp__supabase__execute_sql', q, ctx('solo', { mcpServers: ['supabase'] })).action, 'deny');
});

test('supabase apply_migration asks in solo', () => {
  const d = checkMcp('mcp__supabase__apply_migration', { name: 'x' }, ctx());
  assert.equal(d.action, 'ask');
  assert.equal(d.rule, 'supabase-mcp');
});

test('plugin-style supabase server names match', () => {
  assert.equal(checkMcp('mcp__plugin_x_supabase__merge_branch', {}, ctx()).rule, 'supabase-mcp');
});

test('vercel: reads allowed, writes ask', () => {
  assert.equal(checkMcp('mcp__plugin_vercel_vercel__list_projects', {}, ctx()), null);
  const d = checkMcp('mcp__plugin_vercel_vercel__create_deployment', {}, ctx());
  assert.equal(d.action, 'ask');
  assert.equal(d.rule, 'vercel-mcp');
  assert.equal(checkMcp('mcp__plugin_vercel_vercel__create_deployment', {}, ctx('worker')).action, 'deny');
});

test('mcp-write on production servers', () => {
  const prod = { mcpServers: ['acme'] };
  assert.equal(checkMcp('mcp__acme__get_thing', {}, ctx('solo', prod)), null);
  const d = checkMcp('mcp__acme__update_thing', {}, ctx('solo', prod));
  assert.equal(d.action, 'deny');
  assert.equal(d.rule, 'mcp-write');
  assert.equal(checkMcp('mcp__acme__update_thing', {}, ctx()), null);
});

test('mcp-write on production project refs, including nested input', () => {
  const prod = { projectRefs: ['abc'] };
  assert.equal(checkMcp('mcp__x__do', { project_ref: 'abc' }, ctx('solo', prod)).rule, 'mcp-write');
  assert.equal(checkMcp('mcp__x__do', { opts: { projectId: 'q', projectRef: 'abc' } }, ctx('solo', prod)).rule, 'mcp-write');
  assert.equal(checkMcp('mcp__x__do', { project_ref: 'other' }, ctx('solo', prod)), null);
});

test('SQL comment markers inside strings do not hide writes', () => {
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: "select '--'; delete from t" }, ctx()).rule, 'supabase-mcp');
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: "select '/*'; delete from t; select '*/'" }, ctx()).rule, 'supabase-mcp');
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: 'select $$ -- $$; delete from t' }, ctx()).rule, 'supabase-mcp');
});

test('do is a write only as a PL/pgSQL block', () => {
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: "select 'to do'" }, ctx()), null);
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: 'DO $$ begin null; end $$' }, ctx()).rule, 'supabase-mcp');
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: 'do language plpgsql $$ begin null; end $$' }, ctx()).rule, 'supabase-mcp');
});

test('read-only execute_sql is allowed on a production server; names are case-insensitive', () => {
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: 'select 1' }, ctx('solo', { mcpServers: ['supabase'] })), null);
  assert.equal(checkMcp('mcp__Supabase__Apply_Migration', {}, ctx()).rule, 'supabase-mcp');
  assert.equal(checkMcp('mcp__Plugin_Vercel_Vercel__Create_Deployment', {}, ctx()).rule, 'vercel-mcp');
});

// ---- Task 11 ----
const sql = (query, c = ctx()) => checkMcp('mcp__supabase__execute_sql', { project_id: 'abc', query }, c);

test('C4 github-mcp: merge_pull_request is denied in solo and worker', () => {
  for (const role of ['solo', 'worker']) {
    const d = checkMcp('mcp__github__merge_pull_request', { owner: 'a', repo: 'b', pull_number: 3 }, ctx(role));
    assert.equal(d.action, 'deny');
    assert.equal(d.rule, 'github-mcp');
    assert.match(d.reason, /merge_pull_request/);
  }
  assert.equal(checkMcp('mcp__plugin_github_github__merge_pull_request', {}, ctx()).rule, 'github-mcp');
});

test('C4 github-mcp: branch writes to protected branches are denied', () => {
  for (const tool of ['push_files', 'create_or_update_file', 'delete_file']) {
    const d = checkMcp(`mcp__github__${tool}`, { owner: 'a', repo: 'b', branch: 'main', path: 'x' }, ctx());
    assert.equal(d.action, 'deny', tool);
    assert.equal(d.rule, 'github-mcp');
    assert.match(d.reason, /"main"/);
  }
  assert.equal(checkMcp('mcp__github__update_ref', { ref: 'refs/heads/master', sha: 'x' }, ctx()).rule, 'github-mcp');
  assert.equal(checkMcp('mcp__github__update_ref', { ref: 'heads/main', sha: 'x' }, ctx()).rule, 'github-mcp');
});

test('C4 github-mcp: glob protected branches and missing branch', () => {
  const c = ctx();
  c.policy.protectedBranches = ['main', 'release/*'];
  assert.equal(checkMcp('mcp__github__push_files', { branch: 'release/1.2' }, c).action, 'deny');
  assert.equal(checkMcp('mcp__github__push_files', { branch: 'feat/x' }, c), null);
  assert.equal(checkMcp('mcp__github__create_or_update_file', { path: 'a' }, ctx('solo')).action, 'ask');
  assert.equal(checkMcp('mcp__github__create_or_update_file', { path: 'a' }, ctx('worker')).action, 'deny');
});

test('C4 github-mcp: everyday github tools pass', () => {
  assert.equal(checkMcp('mcp__github__get_pull_request', { owner: 'a', repo: 'b', pull_number: 1 }, ctx('worker')), null);
  assert.equal(checkMcp('mcp__github__create_pull_request', { owner: 'a', repo: 'b', head: 'feat/x', base: 'main' }, ctx('worker')), null);
  assert.equal(checkMcp('mcp__github__push_files', { branch: 'feat/x', files: [] }, ctx('worker')), null);
  assert.equal(checkMcp('mcp__github__delete_file', { branch: 'feat/x', path: 'a' }, ctx('worker')), null);
});

test('I14: read verbs need a word boundary', () => {
  const prod = { mcpServers: ['acme'] };
  assert.equal(checkMcp('mcp__acme__checkout_and_deploy', {}, ctx('solo', prod)).rule, 'mcp-write');
  assert.equal(checkMcp('mcp__acme__show_drop', {}, ctx('solo', prod)).rule, 'mcp-write');
  assert.equal(checkMcp('mcp__acme__getaway_now', {}, ctx('solo', prod)).rule, 'mcp-write');
  assert.equal(checkMcp('mcp__acme__check_status', {}, ctx('solo', prod)), null);
  assert.equal(checkMcp('mcp__acme__getThing', {}, ctx('solo', prod)), null);
  assert.equal(checkMcp('mcp__acme__show', {}, ctx('solo', prod)), null);
  assert.equal(checkMcp('mcp__vercel__getaway', {}, ctx()).rule, 'vercel-mcp');
  assert.equal(checkMcp('mcp__vercel__get_project', {}, ctx()), null);
});

test('I14: query and sql tools on production servers get the SQL check', () => {
  const prod = { mcpServers: ['pg'] };
  assert.equal(checkMcp('mcp__pg__query', { sql: 'select 1' }, ctx('solo', prod)), null);
  const d = checkMcp('mcp__pg__query', { sql: 'drop table users' }, ctx('solo', prod));
  assert.equal(d.rule, 'mcp-write');
  assert.match(d.reason, /DROP/);
  assert.equal(checkMcp('mcp__pg__run_sql', { statement: 'select * from t' }, ctx('solo', prod)), null);
  assert.equal(checkMcp('mcp__pg__run_sql', { statement: 'vacuum full' }, ctx('solo', prod)).rule, 'mcp-write');
  assert.equal(checkMcp('mcp__pg__query_database', { filter: { text: 'Status update' } }, ctx('solo', prod)), null);
});

test('I15: only read statements pass execute_sql', () => {
  for (const q of [
    'select 1',
    'with a as (select 1) select * from a',
    'explain select * from t',
    'show search_path',
    'values (1)',
    'table t',
    '(select 1) union (select 2)',
    'select 1;',
  ]) {
    assert.equal(sql(q), null, q);
  }
  for (const q of [
    'select * into backup from t',
    'refresh materialized view mv',
    'import foreign schema s from server x into y',
    "security label on table t is 'x'",
    'vacuum t',
    'reindex table t',
    'cluster t',
    'lock table t',
    'set statement_timeout = 0',
    'reset all',
    "select setval('s', 1)",
    'select pg_terminate_backend(123)',
    'select pg_cancel_backend(1)',
    'select lo_unlink(1)',
    "select pg_drop_replication_slot('x')",
    'select pg_reload_conf()',
    "select set_config('a', 'b', false)",
    'select pg_switch_wal()',
    "select pg_create_restore_point('x')",
    'select "pg_terminate_backend"(1)',
    'select 1; analyze',
    'explain analyze delete from t',
    'notify x',
  ]) {
    const d = sql(q);
    assert.ok(d, q);
    assert.equal(d.rule, 'supabase-mcp', q);
  }
});

test('I15: every string value of execute_sql is checked', () => {
  assert.equal(checkMcp('mcp__supabase__execute_sql', { sql: 'drop table t' }, ctx()).rule, 'supabase-mcp');
  assert.equal(checkMcp('mcp__supabase__execute_sql', { statement: 'delete from t' }, ctx()).rule, 'supabase-mcp');
  assert.equal(checkMcp('mcp__supabase__execute_sql', { query: { text: 'truncate t' } }, ctx()).rule, 'supabase-mcp');
  assert.equal(checkMcp('mcp__supabase__execute_sql', { statements: ['select 1', 'drop table t'] }, ctx()).rule, 'supabase-mcp');
});

test('FD: literals and quoted identifiers are blanked before the keyword match', () => {
  assert.equal(sql("select * from pg_stat_activity where query like '%insert%'"), null);
  assert.equal(sql("select * from notes where note = 'please delete me'"), null);
  assert.equal(sql('select * from "Update"'), null);
  assert.equal(sql("select * from t where x = 'do $$'"), null);
  assert.equal(sql("select $tag$ drop table t $tag$"), null);
  assert.equal(sql("select E'it\\'s update time'"), null);
  // escapes cannot be used to hide a write
  assert.equal(sql("select E'\\''; drop table t; --'").rule, 'supabase-mcp');
  assert.equal(sql("select 'a''b'; delete from t").rule, 'supabase-mcp');
});

test('I16: more supabase write tools', () => {
  for (const t of ['pause_project', 'restore_project', 'update_storage_config']) {
    assert.equal(checkMcp(`mcp__supabase__${t}`, {}, ctx()).rule, 'supabase-mcp', t);
  }
});

test('I17: project refs match projectId, any key, case-insensitively', () => {
  const prod = { projectRefs: ['AbcDefGhiJkl'] };
  assert.equal(checkMcp('mcp__x__get', { projectId: 'abcdefghijkl' }, ctx('solo', prod)).rule, 'mcp-write');
  assert.equal(checkMcp('mcp__x__get', { target: 'ABCDEFGHIJKL' }, ctx('solo', prod)).rule, 'mcp-write');
  assert.equal(checkMcp('mcp__x__get', { list: [{ ref: 'abcdefghijkl' }] }, ctx('solo', prod)).rule, 'mcp-write');
  assert.equal(checkMcp('mcp__x__get', { url: 'postgres://db.abcdefghijkl.supabase.co/x' }, ctx('solo', prod)).rule, 'mcp-write');
  assert.equal(checkMcp('mcp__x__get', { projectId: 'other' }, ctx('solo', prod)), null);
});

test('I18 mcp-destructive: destructive tool names ask in solo, deny for workers', () => {
  for (const t of ['delete_thing', 'destroy', 'drop_table', 'deploy_app', 'reset_db', 'merge_branch', 'promote', 'rollback_release', 'pause_service', 'push', 'publish_package', 'truncate_table', 'remove_user', 'deleteThing']) {
    const solo = checkMcp(`mcp__acme__${t}`, {}, ctx('solo'));
    assert.equal(solo?.rule, 'mcp-destructive', t);
    assert.equal(solo.action, 'ask', t);
    assert.equal(checkMcp(`mcp__acme__${t}`, {}, ctx('worker')).action, 'deny', t);
  }
  for (const t of ['get_thing', 'create_issue', 'deletion_report_get', 'pushover', 'update_issue']) {
    assert.equal(checkMcp(`mcp__acme__${t}`, {}, ctx('worker')), null, t);
  }
});

test('I18: non-production sql tools with write SQL ask/deny', () => {
  assert.equal(checkMcp('mcp__pg__execute_sql', { sql: 'drop table t' }, ctx('solo')).action, 'ask');
  assert.equal(checkMcp('mcp__pg__execute_sql', { sql: 'drop table t' }, ctx('worker')).rule, 'mcp-destructive');
  assert.equal(checkMcp('mcp__pg__execute_sql', { sql: 'select 1' }, ctx('worker')), null);
});

test('I18: web_fetch_vercel_url with a write method', () => {
  const t = 'mcp__plugin_vercel_vercel__web_fetch_vercel_url';
  assert.equal(checkMcp(t, { url: 'https://x.vercel.app' }, ctx('worker')), null);
  assert.equal(checkMcp(t, { url: 'https://x.vercel.app', method: 'GET' }, ctx('worker')), null);
  assert.equal(checkMcp(t, { url: 'https://x.vercel.app', method: 'head' }, ctx('worker')), null);
  assert.equal(checkMcp(t, { url: 'https://x.vercel.app', method: 'POST' }, ctx('solo')).action, 'ask');
  const d = checkMcp(t, { url: 'https://x.vercel.app', method: 'DELETE' }, ctx('worker'));
  assert.equal(d.action, 'deny');
  assert.match(d.reason, /DELETE/);
});
