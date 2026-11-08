import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRoomConfig } from '../hooks/lib/room/config.mjs';
import { encodeProjectDir } from '../hooks/lib/room/sessions.mjs';
import { buildSnapshot } from '../hooks/lib/room/snapshot.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const MIN = 60_000;

function world() {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-snap-')));
  const home = path.join(tmp, 'home');
  const claude = path.join(tmp, 'claude');
  const repo = path.join(tmp, 'shop');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['-c', 'init.defaultBranch=main', 'init']);
  for (const [k, v] of [['user.name', 'T'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false']]) git(repo, ['config', k, v]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init shop']);
  const lane = path.join(tmp, 'shop-cart');
  git(repo, ['worktree', 'add', '-b', 'feat/cart', lane, 'main']);
  fs.writeFileSync(path.join(lane, 'c.txt'), 'c');
  git(lane, ['add', '.']);
  git(lane, ['commit', '-m', 'cart work']);
  const led = path.join(tmp, 'ledgers');
  fs.mkdirSync(path.join(led, 'approvals'), { recursive: true });
  fs.writeFileSync(path.join(led, 'ledger.md'), [
    '# Ledger', '', '## Active work', '| Session | Branch | Status |', '|---|---|---|', '| w1 | `feat/cart` | BUILDING |', '',
    '## Pending decisions', '- Turn on real email sending?', '- Partner key', '', 'Next free number: **019**.', '',
  ].join('\n'));
  fs.writeFileSync(path.join(led, 'approvals', 'q-open.md'), 'id: q-open\ndate: 2026-11-07 10:00\nfrom: cart\nsubject: Ship it?\n- A: yes\n- B: no\n\nANSWER:\n');
  fs.writeFileSync(path.join(led, 'approvals', 'q-done.md'), `subject: Old\n- A: yes\nANSWER: A - Mert, ${new Date().toISOString()}, telegram\n`);
  const loop = path.join(lane, '.loop');
  fs.mkdirSync(loop);
  fs.writeFileSync(path.join(loop, 'status.json'), '{"status":"paused"}');
  fs.mkdirSync(path.join(led, 'inbox'));
  fs.writeFileSync(path.join(led, 'inbox', 'm1.md'), '- kind: note\n\n```text\nhello\n```\n');
  fs.writeFileSync(path.join(led, 'pull.log'), `${new Date().toISOString()} OK pulled\n${new Date().toISOString()} ERROR timeout\n`);
  const sess = path.join(claude, 'projects', encodeProjectDir(lane));
  fs.mkdirSync(sess, { recursive: true });
  const at = (ago) => new Date(Date.now() - ago).toISOString();
  fs.writeFileSync(path.join(sess, 'abcdef12-1111.jsonl'), [
    { type: 'ai-title', aiTitle: 'Cart lane' },
    { type: 'user', timestamp: at(30 * MIN), message: { role: 'user', content: 'build the cart' } },
    { type: 'assistant', timestamp: at(25 * MIN), message: { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
  ].map((o) => JSON.stringify(o)).join('\n'));
  fs.writeFileSync(path.join(claude, 'history.jsonl'), `${JSON.stringify({ display: 'durum ne', timestamp: Date.now() - MIN, project: lane })}\n`);
  const cfgFile = path.join(home, 'room.json');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({
    claude: { dir: claude, orchestration: ['durum'] },
    projects: [
      {
        name: 'Shop', repo, deliveries: path.join(led, 'deliveries'),
        approvals: { dir: path.join(led, 'approvals'), answerPrefix: 'ANSWER:', actor: 'Mert' },
        loops: [{ name: 'Cart loop', dir: loop }],
        ledgers: [{ file: path.join(led, 'ledger.md'), sections: ['Active work'], decisions: ['Pending decisions'] }],
        facts: [{ label: 'Next migration', file: path.join(led, 'ledger.md'), regex: 'Next free number[^0-9]*(\\d+)' }],
        inbox: [{ name: 'Inbox', dir: path.join(led, 'inbox') }],
        logs: [{ name: 'Pull', file: path.join(led, 'pull.log') }],
      },
      { name: 'Broken', repo: path.join(tmp, 'does-not-exist') },
    ],
  }));
  const env = { OFFLIMITS_HOME: home };
  const cleanup = () => {
    try { git(repo, ['worktree', 'remove', '--force', lane]); } catch { /* best effort */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { tmp, env, home, lane, cleanup };
}

test('a snapshot over every source: needs-you, lanes with ledger status, facts, feeds, today, metrics', async () => {
  const w = world();
  try {
    const { config, problems } = loadRoomConfig({ cwd: w.tmp, env: w.env, homedir: () => w.home });
    assert.deepEqual(problems, []);
    const s = await buildSnapshot(config, { env: w.env, homedir: () => w.home, problems: ['room.json: example'] });
    assert.equal(s.v, 1);
    assert.equal(s.lang, 'en');
    assert.equal(s.strings.title, 'Control room');
    const shop = s.projects.find((p) => p.id === 'shop');
    assert.equal(shop.repos[0].error, undefined);
    const cart = shop.repos[0].lanes.find((l) => l.id === 'shop-cart');
    assert.equal(cart.ledger.status, 'BUILDING');
    assert.equal(cart.sessions.length, 1);
    assert.equal(cart.sessions[0].state, 'waiting');
    assert.deepEqual(shop.facts, [{ label: 'Next migration', value: '019' }]);
    assert.equal(shop.decisions[0].title, 'Pending decisions');
    assert.equal(shop.ledgers[0].sections[0].title, 'Active work');
    assert.equal(shop.loops[0].paused, true);
    assert.equal(shop.inbox[0].items[0].text, 'hello');
    assert.equal(shop.logs[0].errorsSinceOk, 1);
    assert.deepEqual(s.needsYou.approvals.map((a) => a.id), ['q-open']);
    assert.equal(s.needsYou.approvals[0].project, 'shop');
    assert.deepEqual(s.needsYou.sessions.map((x) => x.shortId), ['abcdef12']);
    assert.equal(s.needsYou.decisions.length, 1);
    assert.equal(s.summary.approvals, 1);
    assert.equal(s.summary.waiting, 1);
    assert.ok(s.today.some((x) => x.kind === 'commit' && x.text === 'init shop'));
    assert.ok(s.today.some((x) => x.kind === 'approval'));
    assert.equal(s.metrics.prompts7d, 1);
    assert.equal(s.metrics.orchestration.thisWeek, 1);
    assert.ok(s.problems.includes('room.json: example'));
    assert.ok(s.problems.some((p) => p.includes('Broken') && p.includes('not a git repository')), s.problems.join('\n'));
    assert.equal(typeof s.timings.totalMs, 'number');
  } finally { w.cleanup(); }
});

test('a repository reader that throws becomes one problem; the rest of the snapshot renders', async () => {
  const w = world();
  try {
    const { config } = loadRoomConfig({ cwd: w.tmp, env: w.env, homedir: () => w.home });
    const s = await buildSnapshot(config, { env: w.env, homedir: () => w.home, readRepo: async (repo) => { if (repo.name === 'shop') throw new Error('boom'); return { name: repo.name, path: repo.path, base: null, baseHead: null, todayCommits: [], lanes: [] }; } });
    const shop = s.projects.find((p) => p.id === 'shop');
    assert.match(shop.repos[0].error, /boom/);
    assert.ok(s.problems.some((p) => p.includes('boom')));
    assert.equal(shop.facts[0].value, '019');
  } finally { w.cleanup(); }
});

test('a project whose sources all fail still renders the others', async () => {
  const w = world();
  try {
    const { config } = loadRoomConfig({ cwd: w.tmp, env: w.env, homedir: () => w.home });
    config.projects[0].ledgers[0].file = path.join(w.tmp, 'nope.md');
    config.projects[0].approvals.dir = path.join(w.tmp, 'nope');
    const s = await buildSnapshot(config, { env: w.env, homedir: () => w.home });
    const shop = s.projects.find((p) => p.id === 'shop');
    assert.ok(shop.ledgers[0].error);
    assert.ok(shop.approvals.error);
    assert.ok(shop.repos[0].lanes.length >= 2);
    assert.ok(s.problems.some((p) => p.includes('nope.md')));
  } finally { w.cleanup(); }
});
