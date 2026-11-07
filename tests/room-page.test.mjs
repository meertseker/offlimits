import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../hooks/lib/room/i18n.mjs';
import { STAGES } from '../hooks/lib/team/state.mjs';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'lib', 'room', 'assets');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

test('the three assets exist and stay under 256 KiB', () => {
  for (const f of ['room.html', 'room.css', 'room.js']) assert.ok(fs.statSync(path.join(DIR, f)).size < 256 * 1024, f);
});

test('the page loads nothing from other origins', () => {
  for (const f of ['room.html', 'room.css', 'room.js']) assert.ok(!/https?:\/\//.test(read(f)), `${f} names an http(s) URL`);
  const html = read('room.html');
  assert.ok(html.includes('src="/assets/room.js"'));
  assert.ok(html.includes('href="/assets/room.css"'));
  assert.ok(!/<script>[^<]/.test(html) && !/\son\w+=/.test(html), 'no inline script or handlers (CSP)');
  assert.ok(!/@import|url\(/.test(read('room.css')), 'no external CSS resources');
});

test('the script builds DOM nodes, never HTML strings or code from strings', () => {
  const js = read('room.js');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!js.includes(bad), bad);
  assert.ok(!/style:\s*`/.test(js) && !js.includes("setAttribute('style'"), 'inline style attributes are blocked by the CSP; use the CSSOM');
});

test('every string key the script uses exists in English and Turkish', () => {
  const js = read('room.js');
  const keys = new Set([...js.matchAll(/\bt\(\s*'([\w.-]+)'/g)].map((m) => m[1]));
  assert.ok(keys.size > 40, `only ${keys.size} keys found`);
  for (const k of keys) {
    assert.ok(Object.hasOwn(STRINGS.en, k), `en misses ${k}`);
    assert.ok(Object.hasOwn(STRINGS.tr, k), `tr misses ${k}`);
  }
  const dynamic = [
    ...STAGES.map((s) => `stage.${s}`),
    ...['main', 'building', 'delivered', 'merged', 'stale', 'missing'].map((s) => `state.${s}`),
    ...['event', 'commit', 'approval', 'delivery', 'inbox'].map((s) => `kind.${s}`),
    ...['coordinator', 'main', 'lane'].map((s) => `role.${s}`),
  ];
  for (const k of dynamic) assert.ok(Object.hasOwn(STRINGS.en, k) && Object.hasOwn(STRINGS.tr, k), k);
});

test('the stylesheet has a light and a dark theme and respects reduced motion', () => {
  const css = read('room.css');
  assert.ok(css.includes('@media (prefers-color-scheme: dark)'));
  assert.ok(css.includes('[data-theme="dark"]'));
  assert.ok(css.includes('prefers-reduced-motion'));
  assert.ok(css.includes(':focus-visible'));
});
