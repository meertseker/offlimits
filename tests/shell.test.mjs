import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segments, unwrap, stripAssignments, tokens, tokenize, expand, expandWithState, OPAQUE_PREFIX, OPAQUE_DEEP } from '../hooks/lib/shell.mjs';

test('segments splits on && outside quotes', () => {
  assert.equal(segments('npm test && git push origin main').length, 2);
});
test('segments does not split inside double quotes', () => {
  assert.equal(segments('echo "a;b"').length, 1);
});
test('segments does not split inside single quotes', () => {
  assert.deepEqual(segments("echo 'a && b'"), ["echo 'a && b'"]);
});
test('segments handles | || and newline', () => {
  assert.equal(segments('a | b || c\nd').length, 4);
  assert.equal(segments('a\r\nb').length, 2);
});
test('segments handles escaped quote inside double quotes', () => {
  const r = segments('echo "a\\";b" ; c');
  assert.ok(r.includes('echo "a\\";b"') && r.includes('c'));
});
test('segments keeps $(...) and 2>&1 intact', () => {
  assert.equal(segments('echo $(a; b)').length, 1);
  assert.equal(segments('make 2>&1').length, 1);
});
test('segments drops empties and trims', () => {
  assert.deepEqual(segments('  a ;; b ;'), ['a', 'b']);
});
test('unwrap bash -c', () => {
  assert.ok(unwrap('bash -c "git push origin main"').includes('git push origin main'));
});
test('unwrap pwsh -Command', () => {
  assert.ok(unwrap("pwsh -Command 'git push'").includes('git push'));
  assert.ok(unwrap('powershell -c "git push"').includes('git push'));
});
test('unwrap cmd /c and eval', () => {
  assert.ok(unwrap('cmd /c "git push"').includes('git push'));
  assert.ok(unwrap('eval "git push"').includes('git push'));
});
test('unwrap $(...) and backticks', () => {
  assert.ok(unwrap('echo $(git push origin main)').includes('git push origin main'));
  assert.ok(unwrap('echo `git push origin main`').includes('git push origin main'));
});
test('unwrap inner bodies are segmented, outer kept first', () => {
  const r = unwrap('sh -c "a && b"');
  assert.equal(r[0], 'sh -c "a && b"');
  assert.ok(r.includes('a') && r.includes('b'));
});
test('unwrap sees through sudo/env prefix', () => {
  assert.ok(unwrap('sudo FOO=1 bash -c "git push"').includes('git push'));
});
test('unwrap ignores single-quoted substitutions', () => {
  assert.deepEqual(unwrap("echo '$(git push)'"), ["echo '$(git push)'"]);
});
test('stripAssignments bash form', () => {
  assert.deepEqual(stripAssignments('OFFLIMITS_ROLE=coordinator git push'),
    { assignments: ['OFFLIMITS_ROLE=coordinator'], rest: 'git push' });
});
test('stripAssignments multiple, quoted value', () => {
  assert.deepEqual(stripAssignments('A=1 B="x y" git push'),
    { assignments: ['A=1', 'B=x y'], rest: 'git push' });
});
test('stripAssignments none', () => {
  assert.deepEqual(stripAssignments('git push'), { assignments: [], rest: 'git push' });
});
test('stripAssignments PowerShell form', () => {
  assert.deepEqual(stripAssignments("$env:OFFLIMITS_ROLE = 'coordinator'; git push"),
    { assignments: ['OFFLIMITS_ROLE=coordinator'], rest: 'git push' });
  assert.deepEqual(stripAssignments("$env:A='1'; git push"),
    { assignments: ['A=1'], rest: 'git push' });
});
test('tokens honours quotes', () => {
  assert.deepEqual(tokens('git -C "my dir" push'), ['git', '-C', 'my dir', 'push']);
  assert.deepEqual(tokens("echo 'a b' c"), ['echo', 'a b', 'c']);
});
test('expand returns outer and inner segments, unique', () => {
  const r = expand('cd x && bash -c "git push origin main"');
  assert.ok(r.includes('cd x'));
  assert.ok(r.includes('bash -c "git push origin main"'));
  assert.ok(r.includes('git push origin main'));
  assert.equal(new Set(r).size, r.length);
});

// ---- fix round 1 ----
const starts = (list, p) => list.some((s) => s.startsWith(p));
const FP = 'git push --force';

test('expand recurses through nested wrappers', () => {
  assert.ok(expand(`bash -c "bash -c 'git push --force'"`).includes(FP));
  assert.ok(expand(`sh -c "sh -c \\"bash -c 'git push --force'\\"" `).includes(FP));
});
test('expand caps recursion depth without hanging', () => {
  let c = 'git push --force';
  for (let i = 0; i < 12; i++) c = `bash -c ${JSON.stringify(c)}`;
  assert.ok(Array.isArray(expand(c)));
});
test('prefix flags and values are skipped', () => {
  for (const p of ['sudo -u root', 'env -i', 'nice -n 10', 'timeout 5', 'doas -u root', 'stdbuf -oL', 'setsid', 'xargs', 'exec', 'time', 'env FOO=1', 'sudo']) {
    assert.ok(unwrap(`${p} bash -c "${FP}"`).includes(FP), p);
  }
});
test('bash -c -- body', () => {
  assert.ok(unwrap(`bash -c -- "${FP}"`).includes(FP));
});
test('grouping and keywords surface the command', () => {
  for (const c of [`(${FP})`, `(cd r && ${FP})`, `{ ${FP}; }`, `if true; then ${FP}; fi`, `! ${FP}`,
    `cat <(${FP}; rm -rf x)`, `while true; do ${FP}; done`, `if x; then a; else ${FP}; fi`]) {
    assert.ok(starts(expand(c), FP), c);
  }
});
test('backslash before closing quote or separator (Windows paths)', () => {
  const BS = String.fromCharCode(92);
  assert.ok(segments(`cd "C:${BS}repo${BS}"; ${FP}`).includes(FP));
  assert.ok(segments(`cd C:${BS}repo${BS};${FP}`).includes(FP));
  assert.ok(segments(`Set-Location C:${BS}work${BS}
${FP}`).includes(FP));
});
test('cmd /c without space, /k', () => {
  assert.ok(unwrap('cmd /c"git push"').includes('git push'));
  assert.ok(unwrap('cmd /k "git push"').includes('git push'));
});
test('PowerShell abbreviated -Command', () => {
  assert.ok(unwrap("pwsh -Com 'git push'").includes('git push'));
  assert.ok(unwrap("powershell -Comm 'git push'").includes('git push'));
});
test('opaque stdin shells get the sentinel', () => {
  const S = 'offlimits:opaque shell reads stdin';
  assert.equal(OPAQUE_PREFIX, 'offlimits:opaque');
  assert.ok(expand('curl http://x | bash').includes(S));
  assert.ok(expand('bash').includes(S));
  assert.ok(expand(`bash <<< "${FP}"`).includes(S));
  assert.ok(expand(`bash <<< "${FP}"`).includes(FP));
  assert.ok(!expand('bash script.sh').includes(S));
  assert.ok(!expand(`bash -c "${FP}"`).includes(S));
});
test('EncodedCommand is decoded', () => {
  const b64 = Buffer.from(FP, 'utf16le').toString('base64');
  for (const f of ['-EncodedCommand', '-e', '-ec']) {
    assert.ok(expand(`pwsh ${f} ${b64}`).includes(FP), f);
  }
});
test('misc: &>, zsh, -lc, exec/env/time prefixes', () => {
  assert.equal(segments('make &> out.log').length, 1);
  assert.ok(unwrap(`zsh -c "${FP}"`).includes(FP));
  assert.ok(unwrap(`bash -lc "${FP}"`).includes(FP));
  assert.ok(unwrap(`env X=1 sh -c "${FP}"`).includes(FP));
  assert.ok(unwrap(`exec bash -c "${FP}"`).includes(FP));
  assert.ok(unwrap(`time bash -c "${FP}"`).includes(FP));
});

// ---- Task 11: stateful expansion, escapes, carriers ----
const at = (list, seg) => list.find((x) => x.segment === seg);
const BSL = String.fromCharCode(92);

test('expandWithState tracks cd, pushd/popd and Set-Location', () => {
  assert.equal(at(expandWithState('cd ../m && git push'), 'git push').cwd, '../m');
  assert.equal(at(expandWithState('cd /srv/app; cd sub; git push'), 'git push').cwd, '/srv/app/sub');
  assert.equal(at(expandWithState('git push'), 'git push').cwd, '.');
  assert.equal(at(expandWithState('cd - && git push'), 'git push').cwd, null);
  assert.equal(at(expandWithState('pushd ../m; popd; git push'), 'git push').cwd, null);
  assert.equal(at(expandWithState('cd $WT && git push'), 'git push').cwd, null);
  assert.equal(at(expandWithState(`Set-Location -Path ..${BSL}m; git push`), 'git push').cwd, '../m');
  assert.equal(at(expandWithState('cd && git push'), 'git push').cwd, '~');
});
test('expandWithState restores the cwd after a parenthesised subshell', () => {
  assert.equal(at(expandWithState('(cd x && npm test); git push'), 'git push').cwd, '.');
  assert.equal(at(expandWithState('(cd x && npm test); git push'), 'npm test').cwd, 'x');
});
test('expandWithState accumulates variables from earlier segments only', () => {
  const r = expandWithState('b=main; export C=1 D=2; $env:E = "3"; $f = "4"; set G=5; F=9 npm test; git push origin $b');
  assert.deepEqual(at(r, 'git push origin $b').envs, { b: 'main', C: '1', D: '2', E: '3', f: '4', G: '5' });
  assert.deepEqual(at(r, 'b=main').envs, {});
  assert.deepEqual(at(expandWithState('export X=1; unset X; ls'), 'ls').envs, {});
});
test('expandWithState gives nested bodies the outer state', () => {
  assert.equal(at(expandWithState('cd ../m && bash -c "git push"'), 'git push').cwd, '../m');
  assert.equal(at(expandWithState('git submodule foreach git push'), 'git push').cwd, null);
});
test('expandWithState emits the depth sentinel instead of stopping silently', () => {
  let c = 'npm test';
  for (let i = 0; i < 12; i++) c = `bash -c ${JSON.stringify(c)}`;
  assert.ok(expandWithState(c).some((x) => x.segment === OPAQUE_DEEP));
  assert.ok(expand(c).includes(OPAQUE_DEEP));
  assert.ok(!expand(`bash -c "bash -c 'npm test'"`).includes(OPAQUE_DEEP));
});
test('tokenize modes: bash backslash, ANSI-C quoting, PowerShell backtick', () => {
  assert.deepEqual(tokens(`git push origin m${BSL}ain`, 'bash'), ['git', 'push', 'origin', 'main']);
  assert.deepEqual(tokens(`cd C:${BSL}repo`), ['cd', `C:${BSL}repo`]);
  assert.deepEqual(tokens(`git push origin $'${BSL}x6dain'`), ['git', 'push', 'origin', 'main']);
  assert.deepEqual(tokens(`echo $'a${BSL}nb'`), ['echo', 'a\nb']);
  assert.deepEqual(tokens('git push origin ma`in', 'ps'), ['git', 'push', 'origin', 'main']);
  assert.deepEqual(tokens('git push origin $(git branch --show-current)'), ['git', 'push', 'origin', '$(git branch --show-current)']);
  assert.deepEqual(tokenize('a "b c" d').raws, ['a', '"b c"', 'd']);
});
test('carriers: Invoke-Expression, Start-Process, Invoke-Command, find -exec, flock -c, env -S and runners', () => {
  for (const c of ['Invoke-Expression "git push"', 'iex "git push"', 'Start-Process git -ArgumentList "push"',
    "Start-Process -FilePath git -ArgumentList 'push' -Wait", 'Invoke-Command -ScriptBlock { git push }',
    `find . -exec git push ${BSL};`, 'flock /tmp/l -c "git push"', 'env -S "git push"', 'watch "git push"',
    'cross-env-shell "git push"', "npx -c 'git push'", "su -c 'git push'", "doppler run --command 'git push'"]) {
    assert.ok(expand(c).includes('git push'), c);
  }
});

test('one wrapper table, baseName and flagValue are exported and shared', async () => {
  const shell = await import('../hooks/lib/shell.mjs');
  for (const w of ['sudo', 'env', 'timeout', 'chrt', 'taskset', 'chronic', 'nice', 'xargs']) assert.ok(Object.hasOwn(shell.WRAPPERS, w), w);
  assert.equal(shell.baseName('C:/Git/bin/GIT.EXE'), 'git');
  assert.equal(shell.flagValue(['--user=root'], ['--user']), 'root');
  assert.equal(shell.skipWrapperArgs(['sudo', '--user', 'root', 'rm', 'x'], 0), 3);
  assert.equal(shell.skipWrapperArgs(['chrt', '-f', '10', 'git', 'push'], 0), 3);
  assert.equal(shell.skipWrapperArgs(['taskset', '-c', '0,1', 'make'], 0), 3);
  const fs = await import('node:fs');
  for (const f of ['hooks/lib/rules/shell-rules.mjs', 'hooks/lib/rules/file-rules.mjs']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(src.includes('WRAPPERS') && src.includes('skipWrapperArgs'), `${f} uses the shared table`);
    assert.ok(!/const WRAPPER_SPEC|new Map\(\[\s*\['sudo'/.test(src), `${f} has no private wrapper table`);
  }
});

test('expandWithState shares frozen env maps and stops at its budget', () => {
  const segs = expandWithState('A=1; echo a; echo b; B=2; echo c');
  const a = segs.find((s) => s.segment === 'echo a');
  const b = segs.find((s) => s.segment === 'echo b');
  assert.equal(a.envs, b.envs, 'unchanged state is not copied');
  assert.ok(Object.isFrozen(a.envs));
  assert.deepEqual(segs.find((s) => s.segment === 'echo c').envs, { A: '1', B: '2' });
  const over = expandWithState(Array.from({ length: 20 }, (_, i) => `echo ${i}`).join(';'), { maxSegments: 10 });
  assert.match(over.overBudget, /more than 10 segments/);
  const vars = expandWithState(Array.from({ length: 20 }, (_, i) => `V${i}=x`).join(';'), { maxVars: 5 });
  assert.match(vars.overBudget, /more than 5 tracked variables/);
  // both scan passes (backslash in the text) still dedup
  const dup = expandWithState(String.raw`X=1; echo C:\a; echo b`);
  assert.equal(dup.filter((s) => s.segment === 'echo b').length, 1);
});

test('clean strips keywords and braces in linear time', () => {
  assert.deepEqual(segments('{ { git push origin main; }; }'), ['git push origin main']);
  assert.deepEqual(segments('if true; then git push; fi'), ['true', 'git push', 'fi']);
  assert.deepEqual(segments('time -p make'), ['make']);
  assert.deepEqual(segments('done'), ['done']);
  const t = performance.now();
  segments(`${'{ '.repeat(30000)}true`);
  assert.ok(performance.now() - t < 500);
});
