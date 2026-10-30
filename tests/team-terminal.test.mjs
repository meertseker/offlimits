import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionCommand, launchSpec, openTerminal, hasBin } from '../hooks/lib/team/terminal.mjs';

const base = { role: 'worker', lane: 'demo', model: 'sonnet', name: 'demo', prompt: 'You are worker demo. Read C:\\x\\brief.md and follow it.' };

test('sessionCommand pwsh form', () => {
  assert.equal(
    sessionCommand({ shell: 'pwsh', ...base }),
    "$env:OFFLIMITS_ROLE='worker'; $env:OFFLIMITS_LANE='demo'; claude --model sonnet -n demo 'You are worker demo. Read C:\\x\\brief.md and follow it.'",
  );
});

test('sessionCommand sh form', () => {
  assert.equal(
    sessionCommand({ shell: 'sh', ...base, prompt: 'You are worker demo.' }),
    "OFFLIMITS_ROLE=worker OFFLIMITS_LANE=demo claude --model sonnet -n demo 'You are worker demo.'",
  );
});

test('sessionCommand omits lane for coordinator', () => {
  const p = sessionCommand({ shell: 'pwsh', ...base, role: 'coordinator', lane: undefined });
  assert.ok(p.startsWith("$env:OFFLIMITS_ROLE='coordinator'; claude "));
  assert.ok(!p.includes('LANE'));
  const s = sessionCommand({ shell: 'sh', ...base, role: 'coordinator', lane: undefined });
  assert.ok(s.startsWith('OFFLIMITS_ROLE=coordinator claude '));
});

test('sessionCommand rejects unsafe values', () => {
  for (const bad of ["it's", 'a $x', 'a\nb', 'a"b', 'a`b', 'a\rb']) {
    assert.throws(() => sessionCommand({ shell: 'sh', ...base, prompt: bad }), /unsafe value/);
    assert.throws(() => sessionCommand({ shell: 'sh', ...base, name: bad }), /unsafe value/);
  }
  assert.throws(() => sessionCommand({ shell: 'sh', ...base, model: 'a b' }), /unsafe value|model/);
  assert.throws(() => sessionCommand({ shell: 'sh', ...base, model: "x'y" }), /unsafe value|model/);
});

test('launchSpec win32 with wt keeps dir as own arg', () => {
  const has = (b) => b === 'wt' || b === 'pwsh';
  const s = launchSpec({ platform: 'win32', dir: 'C:\\My Dir\\p', title: 'demo', command: 'echo hi', has });
  assert.equal(s.file, 'wt');
  assert.deepEqual(s.args, ['-w', '0', 'nt', '-d', 'C:\\My Dir\\p', '--title', 'demo', 'pwsh', '-NoExit', '-Command', 'echo hi']);
});

test('launchSpec win32 wt escapes semicolons', () => {
  const has = (b) => b === 'wt' || b === 'pwsh';
  const s = launchSpec({ platform: 'win32', dir: 'C:\\d', title: 't', command: 'a; b', has });
  assert.equal(s.args.at(-1), 'a\\; b');
});

test('launchSpec win32 without wt uses cmd start, powershell fallback', () => {
  const s = launchSpec({ platform: 'win32', dir: 'C:\\My Dir', title: 'demo', command: 'echo hi', has: (b) => b === 'pwsh' });
  assert.equal(s.file, 'cmd');
  assert.deepEqual(s.args, ['/c', 'start', 'demo', '/D', 'C:\\My Dir', 'pwsh', '-NoExit', '-Command', 'echo hi']);
  const p = launchSpec({ platform: 'win32', dir: 'C:\\d', title: 't', command: 'x', has: () => false });
  assert.equal(p.args[5], 'powershell');
});

test('launchSpec darwin', () => {
  const s = launchSpec({ platform: 'darwin', dir: '/Users/a b/p', title: 't', command: "FOO=1 claude 'hi'", has: () => true });
  assert.equal(s.file, 'osascript');
  assert.deepEqual(s.args, ['-e', `tell application "Terminal" to do script "cd /Users/a b/p && FOO=1 claude 'hi'"`]);
  assert.equal(launchSpec({ platform: 'darwin', dir: '/a"b', title: 't', command: 'x', has: () => true }), null);
  assert.equal(launchSpec({ platform: 'darwin', dir: '/a\\b', title: 't', command: 'x', has: () => true }), null);
});

test('launchSpec linux gnome only', () => {
  const s = launchSpec({ platform: 'linux', dir: '/home/a', title: 't', command: 'cmd', has: (b) => b === 'gnome-terminal' });
  assert.equal(s.file, 'gnome-terminal');
  assert.deepEqual(s.args, ['--', 'bash', '-lc', "cd '/home/a' && cmd; exec bash"]);
});

test('launchSpec linux prefers x-terminal-emulator and uses -e', () => {
  const s = launchSpec({ platform: 'linux', dir: '/h', title: 't', command: 'cmd', has: () => true });
  assert.equal(s.file, 'x-terminal-emulator');
  assert.deepEqual(s.args, ['-e', 'bash', '-lc', "cd '/h' && cmd; exec bash"]);
  const k = launchSpec({ platform: 'linux', dir: '/h', title: 't', command: 'cmd', has: (b) => b === 'konsole' });
  assert.equal(k.file, 'konsole');
});

test('launchSpec null when nothing fits', () => {
  assert.equal(launchSpec({ platform: 'linux', dir: '/h', title: 't', command: 'c', has: () => false }), null);
  assert.equal(launchSpec({ platform: 'freebsd', dir: '/h', title: 't', command: 'c', has: () => true }), null);
  assert.equal(launchSpec({ platform: 'linux', dir: "/h'x", title: 't', command: 'c', has: () => true }), null);
});

test('openTerminal spawns detached, ignores stdio, unrefs', () => {
  let call; let unrefd = false;
  const fake = (f, a, o) => { call = [f, a, o]; return { unref() { unrefd = true; } }; };
  openTerminal({ file: 'x', args: ['1'], options: { cwd: '/' } }, fake);
  assert.equal(call[0], 'x');
  assert.deepEqual(call[1], ['1']);
  assert.equal(call[2].detached, true);
  assert.equal(call[2].stdio, 'ignore');
  assert.equal(call[2].cwd, '/');
  assert.ok(unrefd);
});

test('hasBin returns false for a missing binary', () => {
  assert.equal(hasBin('definitely-not-a-real-bin-xyz'), false);
});
