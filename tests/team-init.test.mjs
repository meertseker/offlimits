import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInit, renderTemplate } from '../hooks/lib/team/init.mjs';

const repo = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-init-')));
  execFileSync('git', ['init', '-q'], { cwd: d });
  return d;
};
const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');
const START = '<!-- offlimits:team:start -->';
const END = '<!-- offlimits:team:end -->';

test('init on an empty repo writes all files', () => {
  const d = repo();
  const r = runInit(d, {});
  for (const f of ['offlimits.json', 'CLAUDE.md', '.gitignore', '.github/pull_request_template.md']) {
    assert.ok(r.changed.includes(f), f);
  }
  assert.ok(fs.existsSync(path.join(d, '.offlimits', 'team', 'briefs')));
  assert.deepEqual(JSON.parse(read(d, 'offlimits.json')), { defaultRole: 'worker', team: { language: 'en' } });
  assert.ok(read(d, 'CLAUDE.md').includes(START) && read(d, 'CLAUDE.md').includes(END));
  assert.ok(read(d, '.gitignore').split(/\r?\n/).includes('.offlimits/'));
});

test('init honours the language option', () => {
  const d = repo();
  runInit(d, { language: 'tr' });
  assert.equal(JSON.parse(read(d, 'offlimits.json')).team.language, 'tr');
});

test('init is idempotent', () => {
  const d = repo();
  runInit(d, {});
  const files = ['offlimits.json', 'CLAUDE.md', '.gitignore', '.github/pull_request_template.md'];
  const before = files.map((f) => read(d, f));
  const r = runInit(d, {});
  assert.deepEqual(r.changed, []);
  assert.deepEqual(files.map((f) => read(d, f)), before);
});

test('init keeps user keys', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, 'offlimits.json'), '{"production":{"mcpServers":["supabase"]},"defaultRole":"solo"}');
  runInit(d, {});
  const j = JSON.parse(read(d, 'offlimits.json'));
  assert.deepEqual(j.production, { mcpServers: ['supabase'] });
  assert.equal(j.defaultRole, 'solo');
  assert.deepEqual(j.team, { language: 'en' });
});

test('init keeps CLAUDE.md text outside markers and replaces the block', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), `# Mine\nkeep top\n${START}\nOLD STUFF\n${END}\nkeep bottom\n`);
  runInit(d, {});
  const t = read(d, 'CLAUDE.md');
  assert.ok(t.startsWith('# Mine\nkeep top\n') && t.endsWith('keep bottom\n'));
  assert.ok(!t.includes('OLD STUFF'));
  assert.equal(t.split(START).length, 2);
});

test('init appends to a CLAUDE.md without trailing newline', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# Mine');
  runInit(d, {});
  assert.ok(read(d, 'CLAUDE.md').startsWith('# Mine\n'));
});

test('init leaves invalid offlimits.json alone', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, 'offlimits.json'), '{ nope');
  const r = runInit(d, {});
  assert.equal(read(d, 'offlimits.json'), '{ nope');
  assert.ok(r.notes.some((n) => /not valid JSON/.test(n)));
  assert.ok(!r.changed.includes('offlimits.json'));
});

test('rules and checks render into the block', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, 'offlimits.json'), JSON.stringify({ team: { rules: ['Never touch staff text.'], checks: ['npm test'] } }));
  runInit(d, {});
  const t = read(d, 'CLAUDE.md');
  assert.ok(t.includes('- Never touch staff text.'));
  assert.ok(t.includes('- `npm test`'));
});

test('empty rules and checks render placeholders', () => {
  const d = repo();
  runInit(d, {});
  const t = read(d, 'CLAUDE.md');
  assert.ok(t.includes('- (none yet)') && t.includes('- (none configured)'));
});

test('existing gitignore without trailing newline and existing PR template are kept', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules');
  fs.mkdirSync(path.join(d, '.github'));
  fs.writeFileSync(path.join(d, '.github', 'pull_request_template.md'), 'mine');
  runInit(d, {});
  assert.equal(read(d, '.gitignore'), 'node_modules\n.offlimits/\n');
  assert.equal(read(d, '.github/pull_request_template.md'), 'mine');
});

test('renderTemplate replaces known keys and leaves unknown ones', () => {
  const out = renderTemplate('claude-block.md', { rules: 'R1', nope: 'x' });
  assert.ok(out.includes('R1'));
  assert.ok(out.includes('{{checks}}'));
});

const BAD = {
  'start only': `top\n${START}\nuser text\n`,
  'end only': `top\nuser text\n${END}\n`,
  'end before start': `${END}\nuser text\n${START}\n`,
  'two blocks': `${START}\na\n${END}\nmid\n${START}\nb\n${END}\n`,
};
for (const [name, text] of Object.entries(BAD)) {
  test(`init leaves CLAUDE.md alone with malformed markers: ${name}`, () => {
    const d = repo();
    fs.writeFileSync(path.join(d, 'CLAUDE.md'), text);
    const r = runInit(d, {});
    assert.equal(read(d, 'CLAUDE.md'), text);
    assert.ok(!r.changed.includes('CLAUDE.md'));
    assert.ok(r.notes.some((n) => /unpaired or duplicated offlimits:team marker/.test(n)));
  });
}

test('init keeps CRLF bytes outside the markers', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), `# Mine\r\nkeep top\r\n${START}\r\nold\r\n${END}\r\nkeep bottom\r\n`);
  runInit(d, {});
  const t = read(d, 'CLAUDE.md');
  assert.ok(t.startsWith('# Mine\r\nkeep top\r\n'));
  assert.ok(t.endsWith(`${END}\r\nkeep bottom\r\n`));
  assert.ok(!t.includes('old'));
});
