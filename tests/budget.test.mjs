// B1: crafted commands must not push the hook past Claude Code's hook timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { decide } from '../hooks/lib/rules.mjs';
import { DEFAULT_POLICY } from '../hooks/lib/policy.mjs';

const ctx = (role) => ({ role, policy: structuredClone(DEFAULT_POLICY), currentBranch: () => 'feat/x', cwd: '/repo', repoRoot: '/repo' });
const run = (command, role = 'worker') => {
  const t = performance.now();
  const d = decide({ tool_name: 'Bash', tool_input: { command } }, ctx(role));
  return { d, ms: performance.now() - t };
};

const cases = {
  'push with a redirect and 20 brace groups': `git push origin main > /tmp/x${'{a,b}'.repeat(20)}`,
  'redirect with 20 brace groups only': `echo hi > /tmp/x${'{a,b}'.repeat(20)}`,
  '6000 variable assignments': Array.from({ length: 6000 }, (_, i) => `V${i}=x;`).join(' '),
  '200 KB command': `echo ${'a'.repeat(200 * 1024)}`,
};

for (const [name, command] of Object.entries(cases)) {
  test(`budget: ${name} returns within 1 s and denies for worker`, () => {
    const { d, ms } = run(command);
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
    assert.equal(d.action, 'deny', JSON.stringify(d));
  });
}

test('budget: over-budget command asks in solo mode with rule opaque-shell', () => {
  const { d } = run(`echo ${'a'.repeat(70 * 1024)}`, 'solo');
  assert.equal(d.action, 'ask');
  assert.equal(d.rule, 'opaque-shell');
  const many = run(Array.from({ length: 1200 }, (_, i) => `true ${i}`).join('; '), 'solo');
  assert.equal(many.d.rule, 'opaque-shell');
  const vars = run(Array.from({ length: 250 }, (_, i) => `export V${i}=x`).join('; '), 'worker');
  assert.equal(vars.d.action, 'deny');
  assert.equal(vars.d.rule, 'opaque-shell');
});

test('budget: everyday commands stay allowed', () => {
  for (const c of ['npm test && git status', 'ls -la {src,tests}/*.mjs', `cp a{1,2,3}.txt /tmp/`, 'A=1 B=2 C=3 node x.js', Array.from({ length: 50 }, (_, i) => `echo ${i}`).join('; ')]) {
    assert.equal(run(c).d.action, 'allow', c);
  }
});

test('budget: brace expansion over the cap is unsure, under it is checked', () => {
  const over = run(`echo x > ${'{a,b}'.repeat(9)}offlimits.json`, 'solo');
  assert.equal(over.d.action, 'ask');
  assert.equal(over.d.rule, 'protected-file');
  const under = run('echo x > {a,offlimits}.json', 'worker');
  assert.equal(under.d.action, 'deny');
  assert.equal(under.d.rule, 'protected-file');
});

const adversarial = {
  'many leading braces': `${'{ '.repeat(30000)}true`,
  'many keywords': `${'then '.repeat(12000)}true`,
  'many redirects': `true ${'>a '.repeat(20000)}`,
  'deep substitutions': `${'$('.repeat(5000)}true${')'.repeat(5000)}`,
  'many backslashes': `echo ${'\\a'.repeat(30000)}`,
  'many backslashes and assignments': Array.from({ length: 199 }, (_, i) => `V${i}=C:\\x${i}`).join('; '),
  'many quotes': `echo ${'"a" '.repeat(15000)}`,
  'many dashes': `git push ${'-- '.repeat(20000)}`,
  'many pipes': `${'a|'.repeat(30000)}b`,
};
for (const [name, command] of Object.entries(adversarial)) {
  test(`budget: ${name} (64 KB) returns within 1 s`, () => {
    const { ms } = run(command);
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  });
}

test('budget: more than 32 bare "--" in one segment is opaque', () => {
  const { d, ms } = run(`git push ${'-- '.repeat(20000)}`);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  assert.equal(d.rule, 'opaque-shell');
  assert.equal(run('dotenv -- -- git status').d.action, 'allow');
});

test('budget: more than 256 distinct write targets is unsure', () => {
  const cmd = `rm ${Array.from({ length: 300 }, (_, i) => `f${i}`).join(' ')}`;
  assert.equal(run(cmd, 'worker').d.action, 'deny');
  assert.equal(run(cmd, 'solo').d.action, 'ask');
  assert.equal(run(`rm ${Array.from({ length: 100 }, (_, i) => `f${i}`).join(' ')}`).d.action, 'allow');
});

test('budget: brace words are capped across the whole command', () => {
  const g8 = '{a,b}'.repeat(8);
  const cmd = Array.from({ length: 900 }, (_, i) => `true >${g8}${i}`).join(';');
  const { d, ms } = run(cmd);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  assert.equal(d.action, 'deny');
  assert.equal(d.rule, 'protected-file');
});

test('budget: branch lookups are memoised per directory and capped', () => {
  let calls = 0;
  const c = { ...ctx('worker'), currentBranch: () => (calls++, 'feat/x') };
  const same = Array.from({ length: 50 }, (_, i) => `git push origin HEAD:feat/a${i} && git push`).join('; ');
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: same } }, c).action, 'allow');
  assert.equal(calls, 1);
  calls = 0;
  const many = Array.from({ length: 999 }, (_, i) => `git -C d${i} push`).join(';');
  const d = decide({ tool_name: 'Bash', tool_input: { command: many } }, c);
  assert.equal(d.action, 'deny');
  assert.ok(calls <= 16, `${calls} lookups`);
});

// PowerShell script blocks: crafted nesting must not multiply the work, deep nesting must not throw.
const psRun = (command, role = 'worker') => {
  const t = performance.now();
  const d = decide({ tool_name: 'PowerShell', tool_input: { command } }, ctx(role));
  return { d, ms: performance.now() - t };
};
const BS = String.fromCharCode(92); // a backslash
const psNest = (n, body) => '& { '.repeat(n) + body + ' }'.repeat(n);
const fill = (unit, len) => unit.repeat(Math.floor(len / unit.length));

test('budget: 60 KB of nested PowerShell blocks with backslashes decides within 2 s', () => {
  for (const command of [
    psNest(7, fill(`&{a${BS}}`, 60000)),
    psNest(7, fill(`& { a${BS}b } `, 60000)),
    psNest(7, `Write-Host ${fill(`a${BS}b `, 60000)}`),
    fill(`& { & { & { & { & { & { & { a${BS}b } } } } } } } `, 60000),
  ]) {
    for (const role of ['worker', 'solo']) {
      const { d, ms } = psRun(command, role);
      assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
      assert.ok(d.action === 'allow' || d.rule === 'opaque-shell', JSON.stringify(d));
    }
  }
  const push = psRun(`${psNest(7, fill(`&{a${BS}}`, 60000))}; git push origin main`);
  assert.ok(push.ms < 2000, `took ${push.ms.toFixed(0)} ms`);
  assert.equal(push.d.action, 'deny');
});

test('budget: deeply nested "$( in PowerShell is opaque, never a throw', () => {
  for (const unit of ['"$(', '"$( ', '$("$(']) {
    const command = `${fill(unit, 36000)}; git push origin main`;
    const w = psRun(command, 'worker');
    assert.ok(w.ms < 2000, `took ${w.ms.toFixed(0)} ms`);
    assert.equal(w.d.action, 'deny');
    assert.equal(w.d.rule, 'opaque-shell');
    const s = psRun(command, 'solo');
    assert.equal(s.d.action, 'ask');
    assert.equal(s.d.rule, 'opaque-shell');
  }
});
