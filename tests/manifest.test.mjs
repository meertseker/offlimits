import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const plugin = read('.claude-plugin/plugin.json');
const market = read('.claude-plugin/marketplace.json');
const pkg = read('package.json');
const example = read('offlimits.example.json');

test('plugin.json has required fields', () => {
  assert.equal(plugin.name, 'offlimits');
  assert.equal(plugin.displayName, 'Off Limits');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.license, 'MIT');
  assert.equal(plugin.author.name, 'Mert Seker');
  assert.equal(plugin.homepage, 'https://github.com/meertseker/offlimits');
  assert.equal(plugin.repository, 'https://github.com/meertseker/offlimits');
  assert.ok(plugin.description.length > 40);
  for (const k of ['hooks', 'safety', 'guardrails', 'production', 'git', 'supabase', 'vercel', 'multi-agent']) {
    assert.ok(plugin.keywords.includes(k), k);
  }
});

test('plugin.json has no hooks field (hooks.json loads automatically)', () => {
  assert.equal('hooks' in plugin, false);
});

test('marketplace entry matches the manifest', () => {
  assert.equal(market.name, 'offlimits');
  assert.equal(market.owner.name, 'Mert Seker');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, './');
  assert.equal(market.plugins[0].description, plugin.description);
});

test('example policy holds spec defaults and a filled production block', () => {
  assert.deepEqual(example.protectedBranches, ['main', 'master']);
  assert.ok(example.protectedPaths.includes('.github/workflows/**'));
  assert.ok(example.production.mcpServers.length > 0);
  assert.ok(example.production.projectRefs.length > 0);
  assert.ok(example.production.hosts.length > 0);
  assert.equal(example.extraDeny.length, 1);
  assert.ok(example.extraDeny[0].pattern && example.extraDeny[0].reason);
  assert.equal(example.allow.length, 2);
  assert.deepEqual(example.trustedAgentTypes, []);
  assert.equal(example.roleEnv, 'OFFLIMITS_ROLE');
  assert.equal(example.onError, 'auto');
});

test('every skill has name and description frontmatter, name equals its folder', () => {
  const dirs = readdirSync(new URL('../skills/', import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const want of ['offlimits', 'offlimits-roles', 'offlimits-coordinator', 'offlimits-worker']) assert.ok(dirs.includes(want), `skills/${want} missing`);
  for (const dir of dirs) {
    const text = readFileSync(new URL(`../skills/${dir}/SKILL.md`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(m, `${dir}: frontmatter present`);
    const fm = Object.fromEntries(m[1].split('\n').map((l) => /^([a-z-]+):\s*(.+)$/.exec(l)).filter(Boolean).map((kv) => [kv[1], kv[2].trim()]));
    assert.equal(fm.name, dir, `${dir}: name equals folder`);
    assert.ok(fm.description && fm.description.length > 40, `${dir}: description present`);
    assert.ok(text.split('\n').length < 150, `${dir}: under 150 lines`);
  }
});
