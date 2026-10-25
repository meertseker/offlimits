import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parse(name) {
  const text = fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, 'frontmatter present');
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z-]+):\s*(.+)$/.exec(line);
    assert.ok(kv, `single-line key: value, got "${line}"`);
    fm[kv[1]] = kv[2];
  }
  return { fm, body: m[2] };
}

test('offlimits skill', () => {
  const { fm, body } = parse('offlimits');
  assert.equal(fm.name, 'offlimits');
  assert.match(fm.description, /^Show offlimits gate status/);
  assert.match(body, /selftest\.mjs/);
  assert.match(body, /explain\.mjs/);
  assert.match(body, /status\.mjs/);
  assert.match(body, /CLAUDE_PLUGIN_ROOT/);
  assert.ok(!body.includes('—') && !fm.description.includes('—'), 'no em dash');
  assert.ok(body.indexOf('CLAUDE_PLUGIN_ROOT') < body.indexOf('skills/'), 'CLAUDE_PLUGIN_ROOT is mentioned first');
  assert.match(body, /parent of the `skills\/` directory/);
  assert.ok(body.includes(`node "<root>/hooks/explain.mjs" '<command>'`), 'explain takes one single-quoted argument');
  assert.ok(!body.includes('explain.mjs -- '), 'no -- word form');
  assert.match(body, /selftest\.mjs" --all/);
  assert.match(body, /10-minute timeout/);
});

test('offlimits-roles skill', () => {
  const { fm, body } = parse('offlimits-roles');
  assert.equal(fm.name, 'offlimits-roles');
  assert.match(fm.description, /^Coordinator\/worker contract/);
  assert.ok(body.trim().split('\n').length < 60, 'body under 60 lines');
  assert.match(body, /hand over/i);
});
