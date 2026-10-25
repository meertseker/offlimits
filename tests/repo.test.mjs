import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));

test('package.json has no dependencies and node --test script', () => {
  const pkg = json('package.json');
  assert.equal(pkg.name, 'offlimits');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.scripts.test, 'node --test');
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(pkg[k], undefined, `${k} must not exist`);
  }
});

test('settings.json wires both hooks with the spec matchers', () => {
  const s = json('.claude/settings.json');
  assert.equal(s.enabledPlugins['superpowers@claude-plugins-official'], true);
  const expect = {
    SessionStart: ['startup|resume|clear|compact', 'hooks/session.mjs'],
    PreToolUse: ['Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*', 'hooks/gate.mjs'],
  };
  for (const [event, [matcher, file]] of Object.entries(expect)) {
    const entry = s.hooks[event][0];
    assert.equal(entry.matcher, matcher);
    const h = entry.hooks[0];
    assert.equal(h.command, `node "\${CLAUDE_PROJECT_DIR}/${file}"`);
    assert.equal(h.shell, 'bash');
    assert.equal(h.timeout, 10);
  }
});

test('CLAUDE.md delivery block equals PR template', () => {
  const m = read('CLAUDE.md').match(/```delivery\r?\n([\s\S]*?)```/);
  assert.ok(m, 'delivery block missing');
  assert.equal(m[1].trim(), read('.github/pull_request_template.md').trim());
});

test('CLAUDE.md under 120 lines and names the superpowers workflow', () => {
  const text = read('CLAUDE.md');
  assert.ok(text.split('\n').length <= 120);
  for (const w of ['brainstorming', 'writing-plans', 'subagent-driven-development', 'docs/superpowers/specs/', 'docs/superpowers/plans/']) {
    assert.ok(text.includes(w), `missing ${w}`);
  }
});

test('.gitattributes forces LF', () => {
  assert.match(read('.gitattributes'), /^\* text=auto eol=lf$/m);
});

test('offlimits.json parses and protects .claude/**', () => {
  const p = json('offlimits.json');
  assert.deepEqual(p.protectedBranches, ['main']);
  assert.ok(p.protectedPaths.includes('.claude/**'));
});
