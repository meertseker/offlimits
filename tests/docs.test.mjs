import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const RULES = ['git-push-protected', 'git-branch-protected', 'gh-write', 'supabase-remote', 'remote-db', 'db-migrate', 'deploy', 'publish', 'role-spoof', 'protected-file', 'opaque-shell', 'supabase-mcp', 'vercel-mcp', 'mcp-write', 'extra-deny', 'github-mcp', 'mcp-destructive', 'agent-spawn', 'git-clean'];
const KEYS = ['protectedBranches', 'protectedPaths', 'production', 'mcpServers', 'projectRefs', 'hosts', 'extraDeny', 'allow', 'trustedAgentTypes', 'roleEnv', 'defaultRole', 'onError'];
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

test('every exported RULE_IDS entry is documented and in the CHANGELOG', async () => {
  const { RULE_IDS } = await import('../hooks/lib/rules.mjs');
  if (!Array.isArray(RULE_IDS)) return;
  const text = read('README.md') + read('docs/policy.md');
  const log = read('CHANGELOG.md');
  for (const id of RULE_IDS) {
    assert.ok(text.includes(`\`${id}\``), `docs miss ${id}`);
    assert.ok(log.includes(id), `CHANGELOG misses ${id}`);
  }
});

test('docs/policy.md documents every policy key', () => {
  const t = read('docs/policy.md');
  for (const k of KEYS) assert.ok(t.includes(k), `missing key ${k}`);
});

test('docs/limits.md lists at least 5 limits', () => {
  const bullets = read('docs/limits.md').split('\n').filter((l) => /^(- |\d+\. |### )/.test(l));
  assert.ok(bullets.length >= 5);
});

test('Task 11 doc lines: limits and policy wording', () => {
  const limits = read('docs/limits.md');
  assert.ok(limits.includes('curl -X PUT https://api.github.com'), 'raw API calls out of scope');
  assert.ok(limits.includes('npm run <script>'), 'npm run is opaque');
  assert.ok(limits.includes('`allow` patterns are unanchored'), 'allow is unanchored');
  const policy = read('docs/policy.md');
  assert.ok(policy.includes('(production not matching)'));
  assert.ok(!policy.includes('(no production section)'));
  assert.ok(policy.includes('release/*'), 'protectedBranches globs');
  assert.ok(policy.includes('~/.claude/settings.json'), 'user settings are protected');
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
  assert.ok(svg.includes('git push origin main') && svg.includes('coordinator session') && !svg.includes('OFFLIMITS_ROLE=coordinator git'));
});

test('every file the docs own is under 256 KiB', () => {
  for (const f of ['README.md', 'README.tr.md', 'CHANGELOG.md', 'docs/incidents.md', 'docs/limits.md', 'docs/policy.md', 'assets/demo.svg']) {
    assert.ok(fs.statSync(path.join(root, f)).size < 256 * 1024, f);
  }
});

test('every RULE_IDS entry appears in README.md and in CONTRIBUTING.md', async () => {
  const { RULE_IDS } = await import('../hooks/lib/rules.mjs');
  const readme = read('README.md');
  const contributing = read('CONTRIBUTING.md');
  for (const id of RULE_IDS) {
    assert.ok(readme.includes(`\`${id}\``), `README misses ${id}`);
    assert.ok(contributing.includes(`\`${id}\``), `CONTRIBUTING misses ${id}`);
  }
  // README "What it blocks" has a row for every rule id
  for (const id of RULE_IDS) assert.ok(readme.includes(`| \`${id}\` |`), `README table misses ${id}`);
});

test('README solo row lists the same ask rules as the docs/policy.md roles table', () => {
  const policy = read('docs/policy.md');
  const header = policy.split('\n').find((l) => l.startsWith('| Role | Set by | Hard rules |'));
  assert.ok(header, 'policy roles table header');
  const ids = [...header.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
  assert.ok(ids.length >= 7);
  const solo = read('README.md').split('\n').find((l) => l.startsWith('| `solo` |'));
  for (const id of ids) assert.ok(solo.includes(`\`${id}\``), `README solo row misses ${id}`);
  assert.ok(solo.includes('unsure calls'));
});

test('response times follow SECURITY.md everywhere', () => {
  for (const f of ['README.md', 'docs/limits.md']) {
    const t = read(f);
    assert.ok(!t.includes('24 hours'), `${f} still says 24 hours`);
    assert.ok(t.includes('48 h') && t.includes('7 days'), `${f} lacks 48 h / 7 days`);
  }
});

test('failure mode wording: auto blocks only for workers, the warning shows in the next banner', () => {
  for (const f of ['README.md', 'docs/limits.md']) {
    const t = read(f);
    assert.ok(t.includes('blocks only for workers'), `${f} failure wording`);
    assert.ok(t.includes('next session banner'), `${f} names the banner`);
    assert.ok(!t.includes('blocks in team mode'), `${f} still says team mode`);
  }
});

test('README Usta line and bypass template roles', () => {
  assert.ok(read('README.md').includes('It will also be the gate of Usta, an AI software team for family businesses.'));
  assert.ok(!read('README.md').includes('It is now the gate of Usta'));
  assert.ok(read('.github/ISSUE_TEMPLATE/bypass.md').includes('coordinator, worker or solo'));
});

test('limits and policy describe the unknown $VAR refspec fallback like the README', () => {
  for (const f of ['docs/limits.md', 'docs/policy.md']) {
    const t = read(f);
    assert.ok(/falls back to the current branch/.test(t), `${f} fallback`);
    assert.ok(/allowed on a feature branch and denied on a protected one/.test(t), `${f} outcome`);
  }
  assert.ok(!read('docs/limits.md').includes('`git push origin $TARGET` cannot be resolved'));
});

test('limits.md lists the v0.1 final-review limits', () => {
  const t = read('docs/limits.md');
  for (const s of ['Git aliases from your git config', 'Switching away from a protected branch and pushing in one command', 'Heredoc bodies are scanned', 'Very large commands', '`find -exec`']) {
    assert.ok(t.includes(s), `missing ${s}`);
  }
});
