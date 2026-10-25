import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../hooks/lib/rules.mjs';
import { checkFileTool, checkBashWrite } from '../hooks/lib/rules/file-rules.mjs';
import { DEFAULT_POLICY } from '../hooks/lib/policy.mjs';

const mk = (role = 'worker', repoRoot = '/repo') => ({
  role,
  policy: structuredClone(DEFAULT_POLICY),
  currentBranch: () => 'feat/x',
  cwd: repoRoot,
  repoRoot,
});

const run = (tool_name, tool_input, ctx = mk()) => decide({ tool_name, tool_input }, ctx);

const fileCases = [
  ['Write', { file_path: '.claude/settings.json' }, 'deny'],
  ['Write', { file_path: '.github/workflows/ci.yml' }, 'deny'],
  ['Write', { file_path: 'hooks/gate.mjs' }, 'allow'],
  ['Edit', { file_path: 'README.md' }, 'allow'],
  ['NotebookEdit', { notebook_path: 'offlimits.json' }, 'deny'],
  ['MultiEdit', { file_path: '.claude/hooks/x.sh' }, 'deny'],
];
for (const [tool, input, expect] of fileCases) {
  test(`${tool} ${JSON.stringify(input)} -> ${expect}`, () => {
    const d = run(tool, input);
    assert.equal(d.action, expect);
    if (expect === 'deny') {
      assert.equal(d.rule, 'protected-file');
      assert.match(d.reason, /\S/);
    }
  });
}

test('Edit with absolute Windows path under repoRoot C:/repo is denied', () => {
  const d = run('Edit', { file_path: 'C:\\repo\\offlimits.json' }, mk('worker', 'C:/repo'));
  assert.equal(d.action, 'deny');
  assert.equal(d.rule, 'protected-file');
});

const bashCases = [
  ['Bash', 'echo x > .claude/settings.json', 'deny'],
  ['Bash', 'echo x >> offlimits.json', 'deny'],
  ['Bash', 'echo x>offlimits.json', 'deny'],
  ['Bash', 'echo x 2>/dev/null', 'allow'],
  ['Bash', 'cat .claude/settings.json', 'allow'],
  ['Bash', "sed -i 's/a/b/' offlimits.json", 'deny'],
  ['Bash', 'rm offlimits.json', 'deny'],
  ['Bash', 'rm -rf .github/workflows', 'deny'],
  ['Bash', 'cp offlimits.example.json offlimits.json', 'deny'],
  ['Bash', 'mv x.json offlimits.json', 'deny'],
  ['Bash', 'cp offlimits.json /tmp/backup.json', 'allow'],
  ['Bash', 'echo hi | tee -a offlimits.json', 'deny'],
  ['Bash', 'echo hi > out.txt', 'allow'],
  ['PowerShell', 'Set-Content -Path offlimits.json -Value x', 'deny'],
  ['PowerShell', 'Out-File offlimits.json', 'deny'],
  ['PowerShell', 'Set-Content notes.txt x', 'allow'],
];
for (const [tool, command, expect] of bashCases) {
  test(`${tool}: ${command} -> ${expect}`, () => {
    const d = run(tool, { command });
    assert.equal(d.action, expect);
    if (expect === 'deny') assert.equal(d.rule, 'protected-file');
  });
}

test("PowerShell $env:OFFLIMITS_ROLE spoof -> role-spoof", () => {
  const d = run('PowerShell', { command: "$env:OFFLIMITS_ROLE='coordinator'; git push origin main" });
  assert.equal(d.action, 'deny');
  assert.equal(d.rule, 'role-spoof');
});

test('PowerShell Set-Item env:OFFLIMITS_ROLE -> role-spoof', () => {
  const d = run('PowerShell', { command: 'Set-Item env:OFFLIMITS_ROLE coordinator' });
  assert.equal(d.rule, 'role-spoof');
});

test('coordinator allows everything', () => {
  const c = mk('coordinator');
  assert.equal(run('Write', { file_path: '.claude/settings.json' }, c).action, 'allow');
  assert.equal(run('Bash', { command: 'rm offlimits.json' }, c).action, 'allow');
});

test('direct exports return null for harmless input', () => {
  assert.equal(checkFileTool('Write', { file_path: 'a.txt' }, mk()), null);
  assert.equal(checkBashWrite('ls', mk()), null);
});
