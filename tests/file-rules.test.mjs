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

// ---- fix round 1 ----
const round1 = [
  // 1 mv sources
  ['Bash', 'mv offlimits.json offlimits.bak', 'deny'],
  ['Bash', 'mv offlimits.json /tmp/x', 'deny'],
  ['Bash', 'mv .claude/settings.json elsewhere', 'deny'],
  ['Bash', 'mv a.txt b.txt', 'allow'],
  ['Bash', 'cp offlimits.json /tmp/x', 'allow'],
  // 2 parents
  ['Bash', 'rm -rf .claude', 'deny'],
  ['Bash', 'rm -rf .github', 'deny'],
  ['Bash', 'mv .claude .claude2', 'deny'],
  ['Bash', 'rm -rf .', 'deny'],
  ['Bash', 'rm -rf node_modules', 'allow'],
  ['PowerShell', 'Remove-Item -Recurse -Force .claude', 'deny'],
  ['PowerShell', 'Move-Item .github .github2', 'deny'],
  // 3 redirect forms
  ['Bash', 'echo x >| offlimits.json', 'deny'],
  ['Bash', 'echo x &> offlimits.json', 'deny'],
  ['Bash', 'echo x &>> offlimits.json', 'deny'],
  ['Bash', 'echo x >&offlimits.json', 'deny'],
  ['Bash', 'echo x >offlimits.json', 'deny'],
  ['Bash', 'ls 2>&1', 'allow'],
  ['Bash', 'ls >&2', 'allow'],
  // 4 PowerShell
  ['PowerShell', 'Remove-Item offlimits.json', 'deny'],
  ['PowerShell', 'del offlimits.json', 'deny'],
  ['PowerShell', 'ri -Path:offlimits.json', 'deny'],
  ['PowerShell', 'Remove-Item -LiteralPath offlimits.json', 'deny'],
  ['PowerShell', 'Move-Item x.json offlimits.json', 'deny'],
  ['PowerShell', 'Move-Item -Path a.txt -Destination offlimits.json', 'deny'],
  ['PowerShell', 'Copy-Item x.json offlimits.json', 'deny'],
  ['PowerShell', 'Copy-Item -Path x.json -Destination:offlimits.json', 'deny'],
  ['PowerShell', 'Copy-Item offlimits.json C:/tmp/x.json', 'allow'],
  ['PowerShell', 'New-Item offlimits.json', 'deny'],
  ['PowerShell', 'ni -Path .claude -Name settings.json', 'deny'],
  ['PowerShell', 'Set-Content -Path:offlimits.json -Value x', 'deny'],
  ['PowerShell', 'sc -LiteralPath offlimits.json x', 'deny'],
  ['PowerShell', 'Add-Content offlimits.json x', 'deny'],
  ['PowerShell', 'ac offlimits.json x', 'deny'],
  ['PowerShell', 'Clear-Content offlimits.json', 'deny'],
  ['PowerShell', 'Set-Content -Value offlimits.json notes.txt', 'allow'],
  // 5 other writers
  ['Bash', 'truncate -s 0 offlimits.json', 'deny'],
  ['Bash', 'install -m 644 x.json offlimits.json', 'deny'],
  ['Bash', 'ln -sf /tmp/evil offlimits.json', 'deny'],
  ['Bash', 'dd if=/dev/zero of=offlimits.json', 'deny'],
  ['Bash', 'dd if=/dev/zero of=out.bin', 'allow'],
  ['Bash', 'git checkout -- offlimits.json', 'deny'],
  ['Bash', 'git checkout HEAD~1 -- .claude/settings.json', 'deny'],
  ['Bash', 'git restore offlimits.json', 'deny'],
  ['Bash', 'git restore --source=HEAD~1 offlimits.json', 'deny'],
  ['Bash', 'git checkout feat/x', 'allow'],
  ['Bash', 'git restore README.md', 'allow'],
  // 6 quote awareness
  ['Bash', 'echo "a > offlimits.json"', 'allow'],
  ['Bash', 'git commit -m "x > offlimits.json"', 'allow'],
  ["Bash", "echo 'a >> .claude/settings.json'", 'allow'],
];
for (const [tool, command, expect] of round1) {
  test(`round1 ${tool}: ${command} -> ${expect}`, () => {
    const d = run(tool, { command });
    assert.equal(d.action, expect, JSON.stringify(d));
    if (expect === 'deny') assert.equal(d.rule, 'protected-file');
  });
}
