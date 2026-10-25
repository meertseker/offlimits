import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { repoRoot, commonRoot, currentBranch } from '../hooks/lib/git.mjs';

const boom = () => { throw new Error('git missing'); };
const out = (s) => () => s;

test('repoRoot', () => {
  assert.equal(repoRoot('/x', out('/x/repo\n')), '/x/repo');
  assert.equal(repoRoot('/x', boom), null);
  assert.equal(repoRoot('/x', out('')), null);
});
test('commonRoot', () => {
  assert.equal(commonRoot('/x', boom), null);
  assert.equal(commonRoot('/x', out('')), null);
  assert.equal(commonRoot('/x', out('/main/repo/.git\n')), path.dirname(path.resolve('/main/repo/.git')));
  assert.equal(commonRoot('/x/wt', out('../.git')), path.dirname(path.resolve('/x/wt', '../.git')));
});
test('commonRoot never throws on bad cwd', () => {
  assert.equal(commonRoot(undefined, out('.git')), null);
  assert.equal(repoRoot(undefined, out('/r')), null);
  assert.equal(currentBranch(undefined, out('main')), '');
});
test('currentBranch', () => {
  assert.equal(currentBranch('/x', out('feat/a\n')), 'feat/a');
  assert.equal(currentBranch('/x', boom), '');
  assert.equal(currentBranch('/x', out('HEAD\n')), '');
});
