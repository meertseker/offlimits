import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFact, parseBlocks, parseInline, pickSections, tableRows } from '../hooks/lib/room/markdown.mjs';

test('inline: code, strong, safe links only', () => {
  assert.deepEqual(parseInline('Göç `0045` and **bold** and [x](https://a.b/c) and [y](javascript:alert(1)) end'), [
    { t: 'text', v: 'Göç ' }, { t: 'code', v: '0045' }, { t: 'text', v: ' and ' }, { t: 'strong', v: 'bold' },
    { t: 'text', v: ' and ' }, { t: 'link', v: 'x', href: 'https://a.b/c' }, { t: 'text', v: ' and ' },
    { t: 'text', v: 'y' }, { t: 'text', v: ' end' },
  ]);
  assert.deepEqual(parseInline('plain'), [{ t: 'text', v: 'plain' }]);
});

test('blocks: table, list, paragraph and code fence', () => {
  const lines = [
    'Intro **line**', 'continues here.', '',
    '| No | Ad | Durum |', '|----|----|-------|', '| 017 | `followup` | canlı |', '| 018 | lead | ayrıldı |', '',
    '- one', '- two `x`', '1. first', '',
    '```text', 'raw | not a table', '```',
  ];
  const b = parseBlocks(lines);
  assert.deepEqual(b.map((x) => x.kind), ['para', 'table', 'list', 'list', 'code']);
  assert.deepEqual(b[0].inline, [{ t: 'text', v: 'Intro ' }, { t: 'strong', v: 'line' }, { t: 'text', v: ' continues here.' }]);
  assert.equal(b[1].header.length, 3);
  assert.deepEqual(b[1].header[2], [{ t: 'text', v: 'Durum' }]);
  assert.equal(b[1].rows.length, 2);
  assert.deepEqual(b[1].rows[0][1], [{ t: 'code', v: 'followup' }]);
  assert.equal(b[2].items.length, 2);
  assert.equal(b[3].items.length, 1);
  assert.equal(b[4].text, 'raw | not a table');
});

test('pickSections matches heading prefixes and stops at the next heading of the same level', () => {
  const md = [
    '# Defter', '', '## Canlı durum', 'ok', '',
    '## Göçler: magaza-admin (`src/lib/db/migrations/`)', '| No | Ad |', '|---|---|', '| 017 | x |', '### Not', 'inside', '',
    '## Aktif işler', '- iş', '',
  ].join('\r\n');
  const s = pickSections(md, ['göçler', 'Aktif işler', 'missing']);
  assert.deepEqual(s.map((x) => x.title), ['Göçler: magaza-admin (src/lib/db/migrations/)', 'Aktif işler']);
  assert.deepEqual(s[0].blocks.map((x) => x.kind), ['table', 'para', 'para']);
  assert.equal(s[0].truncated, false);
});

test('caps: long sections and long cells are cut', () => {
  const md = ['## Big', ...Array.from({ length: 1000 }, (_, i) => `line ${i}`), '## Cell', '| a |', '|---|', `| ${'x'.repeat(3000)} |`].join('\n');
  const [big, cell] = pickSections(md, ['Big', 'Cell']);
  assert.equal(big.truncated, true);
  const text = big.blocks.map((b) => b.inline.map((i) => i.v).join('')).join(' ');
  assert.ok(text.includes('line 399') && !text.includes('line 400'));
  assert.ok(cell.blocks[0].rows[0][0][0].v.length <= 1501);
});

test('tableRows gives plain text rows with their header', () => {
  const [s] = pickSections('## T\n| Oturum | Dal | Durum |\n|---|---|---|\n| fb | `lead-sayfasi` | **BAŞLADI** |\n', ['T']);
  assert.deepEqual(tableRows(s.blocks), [{ header: ['Oturum', 'Dal', 'Durum'], cells: ['fb', 'lead-sayfasi', 'BAŞLADI'] }]);
});

test('extractFact takes the last match, the capture group or the whole match', () => {
  const text = 'Sıradaki boş numara: **017**.\n...\nSıradaki boş numara: **019**.';
  assert.equal(extractFact(text, 'Sıradaki boş numara[^0-9]*(\\d+)'), '019');
  assert.equal(extractFact('main 3c6cc4f ok', '[0-9a-f]{7}'), '3c6cc4f');
  assert.equal(extractFact('nothing', '(\\d+)'), null);
  assert.equal(extractFact('x', '('), null);
});
