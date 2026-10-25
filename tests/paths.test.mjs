import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRel, globMatch } from '../hooks/lib/paths.mjs';

test('windows backslashes', () => {
  assert.equal(normalizeRel('C:/repo', 'C:\\repo\\.claude\\settings.json', 'win32'), '.claude/settings.json');
});
test('git bash form', () => {
  assert.equal(normalizeRel('/c/repo', '/c/repo/offlimits.json', 'win32'), 'offlimits.json');
});
test('mixed forms of root and path', () => {
  assert.equal(normalizeRel('C:\\repo', '/c/repo/a/b.txt', 'win32'), 'a/b.txt');
});
test('drive letter case', () => {
  assert.equal(normalizeRel('c:/repo', 'C:/repo/x', 'win32'), 'x');
});
test('trailing slashes', () => {
  assert.equal(normalizeRel('C:/repo/', 'C:/repo/dir/', 'win32'), 'dir');
});
test('relative input', () => {
  assert.equal(normalizeRel('C:/repo', '.\\a\\..\\b.txt', 'win32'), 'b.txt');
});
test('outside root returns absolute', () => {
  assert.equal(normalizeRel('C:/repo', 'c:\\other\\f.txt', 'win32'), 'C:/other/f.txt');
});
test('sibling with shared prefix is outside', () => {
  assert.equal(normalizeRel('C:/repo', 'C:/repo2/f', 'win32'), 'C:/repo2/f');
});
test('root itself', () => {
  assert.equal(normalizeRel('C:/repo', 'C:/repo', 'win32'), '.');
});
test('posix paths', () => {
  assert.equal(normalizeRel('/home/u/repo', '/home/u/repo/a.txt', 'win32'), 'a.txt');
});

test('globMatch ** any depth', () => {
  assert.equal(globMatch('.claude/hooks/**', '.claude/hooks/a/b.mjs'), true);
});
test('globMatch /** matches dir itself', () => {
  assert.equal(globMatch('.claude/**', '.claude'), true);
});
test('globMatch * stays within segment', () => {
  assert.equal(globMatch('*.json', 'a/b.json'), false);
  assert.equal(globMatch('*.json', 'b.json'), true);
});
test('globMatch ?', () => {
  assert.equal(globMatch('a?.txt', 'ab.txt'), true);
  assert.equal(globMatch('a?.txt', 'a/.txt'), false);
});
test('globMatch literal and regex chars', () => {
  assert.equal(globMatch('offlimits.json', 'offlimits.json'), true);
  assert.equal(globMatch('offlimits.json', 'offlimitsxjson'), false);
});
test('globMatch **/ prefix', () => {
  assert.equal(globMatch('**/x.js', 'x.js'), true);
  assert.equal(globMatch('**/x.js', 'a/b/x.js'), true);
});
test('globMatch no prefix leak', () => {
  assert.equal(globMatch('.claude/**', '.claudeX/a'), false);
});

test('case-insensitive on win32 and darwin, original case kept', () => {
  for (const plat of ['win32', 'darwin']) {
    assert.equal(normalizeRel('C:/repo', 'C:/Repo/.CLAUDE/settings.json', plat), '.CLAUDE/settings.json');
    assert.equal(globMatch('.claude/**', '.CLAUDE/settings.json', plat), true);
  }
});
test('case-sensitive on linux', () => {
  assert.equal(normalizeRel('/home/u/r', '/home/u/R/x', 'linux'), '/home/u/R/x');
  assert.equal(globMatch('.claude/**', '.CLAUDE/settings.json', 'linux'), false);
});
test('posix does not rewrite /a/b as a drive', () => {
  assert.equal(normalizeRel('/home/u/r', '/a/b', 'linux'), '/a/b');
  assert.equal(normalizeRel('/home/u/r', '/home/u/r/a/b', 'linux'), 'a/b');
  assert.equal(normalizeRel('/home/u/r', '/a/b', 'darwin'), '/a/b');
});
