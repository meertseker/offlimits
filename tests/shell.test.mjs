import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segments, unwrap, stripAssignments, tokens, expand } from '../hooks/lib/shell.mjs';

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
  assert.deepEqual(segments('echo "a\\";b" ; c'), ['echo "a\\";b"', 'c']);
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
