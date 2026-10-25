import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segments, unwrap, stripAssignments, tokens, expand, OPAQUE_PREFIX } from '../hooks/lib/shell.mjs';

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
