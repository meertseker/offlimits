import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const RULES = ['git-push-protected', 'git-branch-protected', 'gh-write', 'supabase-remote', 'remote-db', 'db-migrate', 'deploy', 'publish', 'role-spoof', 'protected-file', 'opaque-shell', 'supabase-mcp', 'vercel-mcp', 'mcp-write', 'extra-deny'];
const KEYS = ['protectedBranches', 'protectedPaths', 'production', 'mcpServers', 'projectRefs', 'hosts', 'extraDeny', 'allow', 'trustedAgentTypes', 'roleEnv', 'onError'];
const outsideCode = (s) => s.replace(/```[\s\S]*?```/g, '');

test('README has enough prose, the install command and a Limits section', () => {
  const md = read('README.md');
  const words = outsideCode(md).split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 400, `only ${words} words`);
  assert.ok(md.includes('claude plugin install offlimits --marketplace meertseker/offlimits'));
  assert.ok(md.includes('npx skills add meertseker/offlimits'));
  assert.ok(md.includes('## Limits'));
  assert.ok(md.includes('assets/demo.svg'));
});

test('README follows the agreed section order', () => {
  const md = read('README.md');
  const heads = ['## Install', '## What it blocks', '## Roles', '## Why a hook and not a prompt', '## Compared with', '## Configuration', '## Limits', '## Built in production', '## Incidents this would have caught', '## FAQ'];
  let at = -1;
  for (const h of heads) {
    const i = md.indexOf(h);
    assert.ok(i > at, `${h} missing or out of order`);
    at = i;
  }
});

test('no em-dashes or exclamation marks in English docs', () => {
  for (const f of ['README.md', 'CHANGELOG.md', 'docs/incidents.md', 'docs/limits.md', 'docs/policy.md']) {
    const t = read(f);
    assert.ok(!t.includes('—'), `${f} has an em-dash`);
    assert.ok(!t.split('![').join('[').includes('!'), `${f} has an exclamation mark`);
  }
});

test('every rule id appears in the README or docs/policy.md', () => {
  const text = read('README.md') + read('docs/policy.md');
  for (const id of RULES) assert.ok(text.includes(`\`${id}\``), `missing ${id}`);
});

test('docs/policy.md documents every policy key', () => {
  const t = read('docs/policy.md');
  for (const k of KEYS) assert.ok(t.includes(k), `missing key ${k}`);
});

test('docs/limits.md lists at least 5 limits', () => {
  const bullets = read('docs/limits.md').split('\n').filter((l) => /^(- |\d+\. |### )/.test(l));
  assert.ok(bullets.length >= 5);
});

test('docs/incidents.md labels each incident honestly', () => {
  const t = read('docs/incidents.md');
  assert.ok((t.match(/Would offlimits have caught it: (yes|partly|no)/gi) ?? []).length >= 5);
});

test('CHANGELOG has the 0.1.0 entry with every rule', () => {
  const t = read('CHANGELOG.md');
  assert.ok(t.includes('## 0.1.0 - 2026-10-26'));
  for (const id of RULES) assert.ok(t.includes(id), `missing ${id}`);
});

test('README.tr.md is short and links to the English README', () => {
  const t = read('README.tr.md');
  assert.ok(t.split('\n').length <= 60);
  assert.ok(t.includes('README.md'));
});

test('demo.svg is well-formed, small and self-contained', () => {
  const p = path.join(root, 'assets/demo.svg');
  const svg = fs.readFileSync(p, 'utf8');
  assert.ok(fs.statSync(p).size < 16 * 1024);
  assert.match(svg, /^\s*(<\?xml[^>]*\?>\s*)?<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>\s*$/);
  assert.ok(svg.includes('#0b0f14'));
  assert.ok(!/(href|src)=["']https?:/i.test(svg) && !/@import|url\(http/i.test(svg));
  // balanced tags (poor man's XML check)
  const stack = [];
  for (const m of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g)) {
    if (m[4]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2]);
    else stack.push(m[2]);
  }
  assert.equal(stack.length, 0);
  assert.ok(svg.includes('git push origin main') && svg.includes('OFFLIMITS_ROLE=coordinator'));
});

test('every file the docs own is under 256 KiB', () => {
  for (const f of ['README.md', 'README.tr.md', 'CHANGELOG.md', 'docs/incidents.md', 'docs/limits.md', 'docs/policy.md', 'assets/demo.svg']) {
    assert.ok(fs.statSync(path.join(root, f)).size < 256 * 1024, f);
  }
});
