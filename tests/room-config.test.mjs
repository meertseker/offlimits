import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeHome, loadRoomConfig, roomHome } from '../hooks/lib/room/config.mjs';

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-rc-')));
const write = (file, data) => fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));

test('roomHome and claudeHome follow the environment, else the home folder', () => {
  const home = () => path.join('/h');
  assert.equal(roomHome({}, home), path.join('/h', '.offlimits'));
  assert.equal(claudeHome({}, home), path.join('/h', '.claude'));
  assert.equal(roomHome({ OFFLIMITS_HOME: '/x/ol' }, home), path.resolve('/x/ol'));
  assert.equal(claudeHome({ CLAUDE_CONFIG_DIR: '/x/cl' }, home), path.resolve('/x/cl'));
});

test('defaults and the repo shorthand', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'room.json');
    write(file, { projects: [{ name: 'Shop', repo: './shop' }] });
    const { config, problems, source } = loadRoomConfig({ file, cwd: dir, env: {}, homedir: () => path.join(dir, 'home') });
    assert.deepEqual(problems, []);
    assert.equal(source, 'file');
    assert.equal(config.language, 'en');
    assert.equal(config.port, 4747);
    assert.equal(config.staleDays, 5);
    assert.deepEqual(config.claude, { dir: path.join(dir, 'home', '.claude'), liveMinutes: 30, history: true, orchestration: [] });
    const p = config.projects[0];
    assert.equal(p.id, 'shop');
    assert.equal(p.name, 'Shop');
    assert.deepEqual(p.repos, [{ name: 'shop', path: path.join(dir, 'shop'), base: null }]);
    assert.equal(p.approvals, null);
    assert.equal(p.deliveries, null);
    assert.equal(p.coordinatorFile, null);
    for (const k of ['loops', 'ledgers', 'facts', 'inbox', 'logs']) assert.deepEqual(p[k], [], k);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a full project: home and relative paths, a Turkish name, defaults for every source', () => {
  const dir = tmp();
  try {
    const home = path.join(dir, 'home');
    const file = path.join(dir, 'cfg', 'room.json');
    fs.mkdirSync(path.dirname(file));
    write(file, {
      language: 'tr', port: 5000, staleDays: 3,
      claude: { dir: '~/cl', liveMinutes: 45, history: false, orchestration: ['durum', 'onay'] },
      projects: [{
        name: 'Şehir pazarı',
        repos: ['~/r1', { name: 'admin', path: '../r2', base: 'canli' }],
        deliveries: '../ledgers/teslim',
        approvals: { dir: '../ledgers/onay', answerPrefix: 'CEVAP:', actor: 'Mert', channel: 'kumanda', ignore: ['SABLON.md'] },
        loops: [{ name: 'Gece döngüsü', dir: '../gece/.dongu', status: { file: 'durum.json', field: 'durum', run: 'DEVAM', pause: 'DURAKLATILDI' }, stopFile: 'DUR', markers: ['BEKCI-DUR'], tasks: { file: 'features.json', done: 'passes' }, log: 'log/dongu.txt', startHint: '.dongu\\baslat.cmd' }],
        ledgers: [{ file: '../ledgers/defter.md', sections: ['Aktif işler'], decisions: ["Mert'in bekleyen kararları"] }],
        facts: [{ label: 'Sıradaki göç', file: '../ledgers/defter.md', regex: 'numara[^0-9]*(\\d+)' }],
        coordinatorFile: '../ledgers/koordinator',
        inbox: [{ name: 'Kutu', dir: '../ledgers/kutu', limit: 3 }],
        logs: [{ name: 'Çekme', file: '../ledgers/kutu/pull.log' }],
      }],
    });
    const { config, problems } = loadRoomConfig({ file, cwd: dir, env: {}, homedir: () => home });
    assert.deepEqual(problems, []);
    assert.equal(config.language, 'tr');
    assert.equal(config.port, 5000);
    assert.equal(config.staleDays, 3);
    assert.deepEqual(config.claude, { dir: path.join(home, 'cl'), liveMinutes: 45, history: false, orchestration: ['durum', 'onay'] });
    const p = config.projects[0];
    assert.equal(p.id, 'sehir-pazari');
    assert.deepEqual(p.repos, [
      { name: 'r1', path: path.join(home, 'r1'), base: null },
      { name: 'admin', path: path.join(dir, 'r2'), base: 'canli' },
    ]);
    assert.deepEqual(p.deliveries, { dir: path.join(dir, 'ledgers', 'teslim') });
    assert.deepEqual(p.approvals, { dir: path.join(dir, 'ledgers', 'onay'), answerPrefix: 'CEVAP:', actor: 'Mert', channel: 'kumanda', ignore: ['SABLON.md'] });
    const loop = p.loops[0];
    assert.equal(loop.id, 'gece-dongusu');
    assert.equal(loop.dir, path.join(dir, 'gece', '.dongu'));
    assert.deepEqual(loop.status, { file: 'durum.json', field: 'durum', run: 'DEVAM', pause: 'DURAKLATILDI' });
    assert.equal(loop.stopFile, 'DUR');
    assert.deepEqual(loop.markers, ['BEKCI-DUR']);
    assert.deepEqual(loop.tasks, { file: 'features.json', done: 'passes', blocked: 'blocked', id: 'id', title: 'title' });
    assert.equal(loop.log, 'log/dongu.txt');
    assert.equal(loop.liveMinutes, 30);
    assert.equal(loop.startHint, '.dongu\\baslat.cmd');
    assert.deepEqual(p.ledgers, [{ name: 'defter.md', file: path.join(dir, 'ledgers', 'defter.md'), sections: ['Aktif işler'], decisions: ["Mert'in bekleyen kararları"] }]);
    assert.deepEqual(p.facts, [{ label: 'Sıradaki göç', file: path.join(dir, 'ledgers', 'defter.md'), regex: 'numara[^0-9]*(\\d+)' }]);
    assert.equal(p.coordinatorFile, path.join(dir, 'ledgers', 'koordinator'));
    assert.deepEqual(p.inbox, [{ name: 'Kutu', dir: path.join(dir, 'ledgers', 'kutu'), limit: 3 }]);
    assert.deepEqual(p.logs, [{ name: 'Çekme', file: path.join(dir, 'ledgers', 'kutu', 'pull.log'), ok: '\\bOK\\b', error: 'ERROR' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('approval and loop defaults', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'room.json');
    write(file, { projects: [{ name: 'a', repo: 'r', approvals: 'onay', loops: [{ name: 'L', dir: 'l' }] }] });
    const { config, problems } = loadRoomConfig({ file, cwd: dir, env: {}, homedir: () => dir });
    assert.deepEqual(problems, []);
    const ap = config.projects[0].approvals;
    assert.equal(ap.answerPrefix, 'ANSWER:');
    assert.equal(ap.channel, 'room');
    assert.deepEqual(ap.ignore, ['TEMPLATE.md', 'README.md']);
    assert.equal(typeof ap.actor, 'string');
    assert.ok(ap.actor.length > 0);
    const loop = config.projects[0].loops[0];
    assert.deepEqual(loop.status, { file: 'status.json', field: 'status', run: 'run', pause: 'paused' });
    assert.equal(loop.stopFile, 'STOP');
    assert.deepEqual(loop.markers, []);
    assert.equal(loop.tasks, null);
    assert.equal(loop.log, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bad entries are reported and skipped, the rest still loads', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'room.json');
    write(file, {
      port: 80, language: 'xx', bogus: 1, claude: { orchestration: ['('] },
      projects: [
        { name: 'ok', repo: 'r', facts: [{ label: 'f', file: 'x', regex: '(' }], loops: [{ name: 'no dir' }], logs: [{ name: 'l', file: 'p', ok: '[' }], inbox: [{ name: 'i', dir: 'd', limit: 99 }], wat: true },
        { repo: 'no-name' },
        'not an object',
        { name: 'Ok', repo: 'r2', repos: [{ path: 'r3', base: '-bad' }] },
      ],
    });
    const { config, problems } = loadRoomConfig({ file, cwd: dir, env: {}, homedir: () => dir });
    assert.equal(config.port, 4747);
    assert.equal(config.language, 'en');
    assert.deepEqual(config.claude.orchestration, []);
    assert.deepEqual(config.projects.map((p) => p.id), ['ok', 'no-name', 'ok-2']);
    const ok = config.projects[0];
    assert.deepEqual([ok.facts.length, ok.loops.length, ok.logs.length], [0, 0, 0]);
    assert.equal(ok.inbox[0].limit, 5);
    assert.equal(config.projects[2].repos.length, 1);
    for (const want of ['"port"', '"language"', '"bogus"', 'orchestration', 'facts[0]', 'loops[0]', 'logs[0]', 'inbox[0].limit', '"wat"', 'projects[2]', 'repos[0].base']) {
      assert.ok(problems.some((p) => p.includes(want)), `no problem mentions ${want}: ${problems.join(' | ')}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the default file comes from OFFLIMITS_HOME', () => {
  const dir = tmp();
  try {
    write(path.join(dir, 'room.json'), { projects: [{ name: 'p', repo: 'x' }] });
    const { source, config, file } = loadRoomConfig({ cwd: dir, env: { OFFLIMITS_HOME: dir }, homedir: () => '/nowhere' });
    assert.equal(source, 'file');
    assert.equal(file, path.join(dir, 'room.json'));
    assert.equal(config.projects[0].repos[0].path, path.join(dir, 'x'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without a file: the current repository, else a problem', () => {
  const dir = tmp();
  try {
    const repo = path.join(dir, 'My Repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: repo, stdio: 'ignore' });
    const env = { OFFLIMITS_HOME: path.join(dir, 'empty-home') };
    const r = loadRoomConfig({ cwd: repo, env, homedir: () => dir });
    assert.equal(r.source, 'repo');
    assert.deepEqual(r.problems, []);
    assert.equal(r.config.projects.length, 1);
    assert.equal(r.config.projects[0].id, 'my-repo');
    assert.equal(path.resolve(r.config.projects[0].repos[0].path).toLowerCase(), path.resolve(repo).toLowerCase());
    const outside = loadRoomConfig({ cwd: dir, env, homedir: () => dir });
    assert.equal(outside.source, null);
    assert.equal(outside.config.projects.length, 0);
    assert.match(outside.problems.join('\n'), /room\.json/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an explicit --config file that is missing or broken is a problem, not a crash', () => {
  const dir = tmp();
  try {
    const missing = loadRoomConfig({ file: path.join(dir, 'nope.json'), cwd: dir, env: {}, homedir: () => dir });
    assert.equal(missing.source, null);
    assert.match(missing.problems[0], /cannot read/);
    write(path.join(dir, 'bad.json'), '{ not json');
    const broken = loadRoomConfig({ file: path.join(dir, 'bad.json'), cwd: dir, env: {}, homedir: () => dir });
    assert.equal(broken.source, null);
    assert.match(broken.problems[0], /not valid JSON/);
    write(path.join(dir, 'bom.json'), `﻿${JSON.stringify({ projects: [] })}`);
    assert.equal(loadRoomConfig({ file: path.join(dir, 'bom.json'), cwd: dir, env: {}, homedir: () => dir }).source, 'file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
