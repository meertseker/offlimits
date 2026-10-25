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
// ---- Task 11 ----
const HOME = '/home/u';
const mk11 = (extra = {}) => ({ ...mk('worker'), home: HOME, env: {}, ...extra });
const bash = (command, c = mk11()) => decide({ tool_name: 'Bash', tool_input: { command } }, c);
const ps = (command, c = mk11()) => decide({ tool_name: 'PowerShell', tool_input: { command } }, c);

test('I19: protected paths resolve against the main worktree (commonRoot)', () => {
  const c = { ...mk11(), cwd: 'C:/wt/feat-x', repoRoot: 'C:/wt/feat-x', commonRoot: 'C:/repo' };
  for (const p of ['C:/repo/offlimits.json', 'C:\\repo\\.claude\\settings.json', '/c/repo/.github/workflows/ci.yml']) {
    const d = decide({ tool_name: 'Write', tool_input: { file_path: p } }, c);
    assert.equal(d.action, 'deny', p);
    assert.equal(d.rule, 'protected-file');
  }
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: 'C:/wt/feat-x/offlimits.json' } }, c).action, 'deny');
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: 'C:/repo/src/app.ts' } }, c).action, 'allow');
  assert.equal(bash('rm C:/repo/offlimits.json', c).action, 'deny');
  assert.equal(bash('echo x > C:/repo/.claude/settings.json', c).action, 'deny');
});

test('I20: user settings are protected; disableAllHooks is denied', () => {
  for (const p of ['~/.claude/settings.json', '/home/u/.claude/settings.local.json', '$HOME/.claude/settings.json']) {
    assert.equal(run('Write', { file_path: p }, mk11()).action, 'deny', p);
  }
  assert.equal(bash('echo {} > ~/.claude/settings.json').action, 'deny');
  assert.equal(bash('rm -rf ~/.claude').action, 'deny');
  assert.equal(bash('rm -rf ~').action, 'deny');
  assert.equal(ps('Set-Content $env:USERPROFILE/.claude/settings.json x', { ...mk11(), home: 'C:/Users/u' }).action, 'deny');
  assert.equal(run('Write', { file_path: '/home/u/.claude/CLAUDE.md' }, mk11()).action, 'allow');
  const d = run('Write', { file_path: 'notes/x.json', content: '{"disableAllHooks": true}' }, mk11());
  assert.equal(d.action, 'deny');
  assert.match(d.reason, /disableAllHooks/);
  assert.equal(run('Edit', { file_path: 'a.json', old_string: 'a', new_string: '"disableAllHooks":true' }, mk11()).action, 'deny');
  // the shell rules may claim it first (rule order); either way it is denied
  assert.equal(bash('echo \'{"disableAllHooks":true}\' > x.json').action, 'deny');
  assert.equal(checkBashWrite('echo \'{"disableAllHooks":true}\' > x.json', mk11())?.rule, 'protected-file');
  assert.equal(checkBashWrite('tee -a notes.json <<< disableAllHooks', mk11())?.rule, 'protected-file');
  assert.equal(checkBashWrite('grep -r disableAllHooks .', mk11()), null);
  assert.equal(run('Write', { file_path: '/x/.claude/settings.json' }, mk11({ env: { CLAUDE_CONFIG_DIR: '/x/.claude' } })).action, 'deny');
});

test('I21: git rm, git mv, git checkout <tree> <path>', () => {
  for (const cmd of ['git rm offlimits.json', 'git rm -r --cached .claude', 'git mv offlimits.json x', 'git mv x.json offlimits.json', 'git checkout HEAD~5 .claude/settings.json', 'git -C . rm offlimits.json']) {
    assert.equal(bash(cmd).action, 'deny', cmd);
  }
  for (const cmd of ['git rm old.txt', 'git mv a.txt b.txt', 'git checkout main', 'git checkout -b feat/y', 'git checkout HEAD~1 src/a.ts']) {
    assert.equal(bash(cmd).action, 'allow', cmd);
  }
});

test('I22: tracked segment cwd is used; unknown cwd is unsure', () => {
  const inClaude = mk11({ segCwd: '/repo/.claude' });
  assert.equal(checkBashWrite('echo {} > settings.json', inClaude)?.rule, 'protected-file');
  assert.equal(checkBashWrite('rm settings.json', inClaude)?.rule, 'protected-file');
  assert.equal(checkBashWrite('rm x.txt', inClaude), null);
  assert.equal(checkBashWrite('rm ../offlimits.json', mk11({ segCwd: '/repo/src' }))?.rule, 'protected-file');
  assert.equal(checkBashWrite('rm offlimits.json', mk11({ segCwd: '/repo/src' })), null);
  const lost = mk11({ segCwd: null });
  assert.equal(checkBashWrite('rm settings.json', lost)?.action, 'deny');
  assert.equal(checkBashWrite('rm settings.json', { ...lost, role: 'solo' })?.action, 'ask');
  assert.equal(checkBashWrite('rm ../x', { ...lost, role: 'solo' })?.action, 'ask');
  assert.equal(checkBashWrite('rm out.txt', lost), null);
  assert.equal(checkBashWrite('cat settings.json', lost), null);
  assert.equal(checkBashWrite('rm /repo/offlimits.json', lost)?.action, 'deny');
});

test('I23: Rename-Item, ren, rni are movers', () => {
  for (const cmd of ['Rename-Item offlimits.json x.json', 'ren x.json offlimits.json', 'rni -Path .claude -NewName c2', 'Rename-Item -Path a.json -NewName offlimits.json']) {
    assert.equal(ps(cmd).action, 'deny', cmd);
  }
  assert.equal(ps('Rename-Item a.txt b.txt').action, 'allow');
});

test('I24: globs in positionals are matched against protected paths', () => {
  for (const cmd of ['rm offlimits.*', 'rm offlimit?.json', 'rm .claude/*', 'rm -rf .c*', 'rm -rf *', 'rm -rf ..', 'rm -rf /', 'rm -f *.json', 'rm offlimits.{json,bak}', 'rm offlimits.js[o]n', 'rm -rf .claude/hooks/*.sh', 'rm -rf ../*']) {
    assert.equal(bash(cmd).action, 'deny', cmd);
  }
  for (const cmd of ['rm -rf dist', 'rm -rf node_modules', 'rm *.log', 'rm -rf dist/*', 'rm -rf src/*.tmp']) {
    assert.equal(bash(cmd).action, 'allow', cmd);
  }
});

test('M5: copy and download commands that land on a protected path', () => {
  for (const cmd of [
    'cp /tmp/offlimits.json .',
    'cp /tmp/offlimits.json ./',
    'cp -t . /tmp/offlimits.json',
    'cp --target-directory=.claude /tmp/settings.json',
    'cp -r /tmp/claude .claude',
    'mv /tmp/offlimits.json .',
    'rsync x offlimits.json',
    'rsync -av /tmp/offlimits.json .',
    'scp host:offlimits.json .',
    'curl -o offlimits.json https://x/y',
    'curl -sSLo offlimits.json https://x/y',
    'curl --output .claude/settings.json https://x/y',
    'curl -O https://x/offlimits.json',
    'wget -O offlimits.json https://x/y',
    'wget https://x/offlimits.json',
    'wget -qO.claude/settings.json https://x/y',
    "perl -pi -e 's/a/b/' offlimits.json",
    "perl -i.bak -pe 's/a/b/' .claude/settings.json",
    "sed -i -e 's/a/b/' offlimits.json README.md",
    "sed -i 's/a/b/' offlimits.json README.md",
    'ln -s /tmp/offlimits.json .',
    'touch .claude/hooks/x.sh',
    'nice -n 10 rm offlimits.json',
    'timeout 30 rm offlimits.json',
    'env -u X rm offlimits.json',
  ]) {
    assert.equal(bash(cmd).action, 'deny', cmd);
  }
  for (const cmd of [
    "Tee-Object -FilePath offlimits.json",
    "'x' | Tee-Object offlimits.json",
    "[IO.File]::WriteAllText('offlimits.json', 'x')",
    "[System.IO.File]::Delete(\"C:/repo/../repo/.claude/settings.json\")",
    "[IO.File]::Copy('a.json', 'offlimits.json')",
    'Copy-Item -Recurse C:/tmp/claude .claude',
  ]) {
    assert.equal(ps(cmd, { ...mk11(), cwd: 'C:/repo', repoRoot: 'C:/repo' }).action, 'deny', cmd);
  }
  for (const cmd of [
    'cp -r src backup/',
    'cp a.txt .',
    'cp -r src .',
    'mv a.txt .',
    'curl -o out.json https://x/y',
    'curl https://x/offlimits.json',
    'wget -O - https://x/offlimits.json',
    'wget -O out.json https://x/offlimits.json',
    'rsync -av src/ backup/',
    "perl -pe 's/a/b/' offlimits.json",
    "sed 's/a/b/' offlimits.json",
    'cp offlimits.json /tmp/x',
  ]) {
    assert.equal(bash(cmd).action, 'allow', cmd);
  }
  assert.equal(ps("[IO.File]::Copy('offlimits.json', 'C:/tmp/x')", { ...mk11(), cwd: 'C:/repo', repoRoot: 'C:/repo' }).action, 'allow');
  assert.equal(ps("[IO.File]::ReadAllText('offlimits.json')", { ...mk11(), cwd: 'C:/repo', repoRoot: 'C:/repo' }).action, 'allow');
});

test('everyday operations keep passing', () => {
  for (const cmd of ['rm -rf dist', 'rm -rf node_modules', 'cp -r src backup/', 'curl -o out.json https://example.com/x', 'git rm old.txt', 'cd src && cat x.ts', 'echo hi > out.txt']) {
    assert.equal(bash(cmd).action, 'allow', cmd);
  }
  assert.equal(run('Write', { file_path: 'src/app.ts', content: 'x' }, mk11()).action, 'allow');
});

for (const [tool, command, expect] of round1) {
  test(`round1 ${tool}: ${command} -> ${expect}`, () => {
    const d = run(tool, { command });
    assert.equal(d.action, expect, JSON.stringify(d));
    if (expect === 'deny') assert.equal(d.rule, 'protected-file');
  });
}

test('protected-file deny message names the actual role', () => {
  const w = run('Bash', { command: 'rm offlimits.json' }, mk('worker'));
  assert.match(w.reason, /is not allowed for a worker/);
  const s = run('Bash', { command: 'rm offlimits.json' }, mk('solo'));
  assert.equal(s.action, 'deny');
  assert.match(s.reason, /is not allowed for the solo role/);
  assert.doesNotMatch(s.reason, /for a worker/);
  const f = run('Write', { file_path: 'offlimits.json' }, mk('solo'));
  assert.match(f.reason, /is not allowed for the solo role/);
  const r = run('Bash', { command: 'echo x > offlimits.json' }, mk('solo'));
  assert.match(r.reason, /for the solo role/);
});

test('find -exec write is unsure with its own message', () => {
  const d = run('Bash', { command: 'find . -name offlimits.json -exec rm {} \;' }, mk('solo'));
  assert.equal(d.action, 'ask');
  assert.match(d.reason, /the files find -exec picks at run time/);
});
