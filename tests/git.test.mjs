import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { repoRoot, commonRoot, currentBranch, repoInfo } from '../hooks/lib/git.mjs';

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
test('currentBranch falls back to symbolic-ref on an unborn branch', () => {
  const exec = (_cmd, args) => {
    if (args[0] === 'rev-parse') throw new Error('unknown revision HEAD');
    return 'main\n';
  };
  assert.equal(currentBranch('/x', exec), 'main');
});
test('currentBranch', () => {
  assert.equal(currentBranch('/x', out('feat/a\n')), 'feat/a');
  assert.equal(currentBranch('/x', boom), '');
  assert.equal(currentBranch('/x', out('HEAD\n')), '');
});
test('git calls use a 2 s timeout', () => {
  let opts;
  repoRoot('/x', (_c, _a, o) => {
    opts = o;
    return '/x';
  });
  assert.equal(opts.timeout, 2000);
});
test('repoInfo reads root, common root and branch from one spawn', () => {
  let calls = 0;
  const exec = (_c, args) => {
    calls++;
    assert.deepEqual(args, ['rev-parse', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD']);
    return '/x/repo\n.git\nfeat/a\n';
  };
  const info = repoInfo('/x/repo', exec);
  assert.equal(calls, 1);
  assert.equal(info.root, '/x/repo');
  assert.equal(info.common, path.dirname(path.resolve('/x/repo', '.git')));
  assert.equal(info.branch, 'feat/a');
  assert.equal(repoInfo('/x', out('/x\n.git\nHEAD\n')).branch, '');
});
test('repoInfo falls back on an unborn branch and outside a repo', () => {
  const unborn = (_c, args) => {
    if (args.includes('--abbrev-ref')) throw new Error('unknown revision HEAD');
    if (args.includes('--show-toplevel')) return '/x\n';
    if (args.includes('--git-common-dir')) return '.git\n';
    return 'main\n'; // symbolic-ref
  };
  assert.deepEqual(repoInfo('/x', unborn), { root: '/x', common: path.dirname(path.resolve('/x', '.git')), branch: 'main' });
  assert.deepEqual(repoInfo('/x', boom), { root: null, common: null, branch: '' });
});
