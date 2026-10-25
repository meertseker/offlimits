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
