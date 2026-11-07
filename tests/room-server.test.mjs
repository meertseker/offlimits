import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRoomServer } from '../hooks/lib/room/server.mjs';
import { RoomError } from '../hooks/lib/room/errors.mjs';

const ASSETS = { html: '<!doctype html><title>room</title>', css: 'body{}', js: 'void 0;' };

function req(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

async function start(extra = {}) {
  let clock = Date.parse('2026-11-07T12:00:00Z');
  const calls = [];
  const room = createRoomServer({
    getState: async () => ({ v: 1, hello: 'world' }),
    answer: async (b) => { calls.push(['answer', b]); return { ok: true, line: 'x' }; },
    setLoop: async (b) => { calls.push(['loop', b]); return { ok: true }; },
    assets: ASSETS,
    now: () => clock,
    ...extra,
  });
  const port = await room.listen(0);
  const login = async () => {
    const r = await req(port, { path: `/login?t=${room.mintTicket()}` });
    return r.headers['set-cookie'][0].split(';')[0];
  };
  return { room, port, calls, login, tick: (ms) => { clock += ms; } };
}

const post = (s, cookie, path, body, headers = {}) => req(s.port, {
  method: 'POST', path, body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${s.port}`, 'X-Offlimits-Room': '1', ...headers },
});

test('ping works without a session and names the room', async () => {
  const s = await start();
  try {
    const r = await req(s.port, { path: '/ping' });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).offlimitsRoom, 1);
  } finally { await s.room.close(); }
});

test('the page needs a session and the 401 page carries no ticket', async () => {
  const s = await start();
  try {
    const t = s.room.mintTicket();
    const r = await req(s.port, { path: '/' });
    assert.equal(r.status, 401);
    assert.ok(!r.body.includes(t));
    assert.equal((await req(s.port, { path: '/api/state' })).status, 401);
    assert.equal((await req(s.port, { path: '/assets/room.js' })).status, 401);
  } finally { await s.room.close(); }
});

test('login: a good ticket once, then never again; a bad or expired ticket is refused', async () => {
  const s = await start();
  try {
    assert.equal((await req(s.port, { path: '/login?t=nope' })).status, 403);
    const t = s.room.mintTicket();
    const ok = await req(s.port, { path: `/login?t=${t}` });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, '/');
    const cookie = ok.headers['set-cookie'][0];
    assert.match(cookie, /^offlimits_room=[0-9a-f]{64};/);
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag), flag);
    assert.equal((await req(s.port, { path: `/login?t=${t}` })).status, 403);
    const late = s.room.mintTicket();
    s.tick(11 * 60_000);
    assert.equal((await req(s.port, { path: `/login?t=${late}` })).status, 403);
  } finally { await s.room.close(); }
});

test('a session ends after 12 hours', async () => {
  const s = await start();
  try {
    const cookie = await s.login();
    assert.equal((await req(s.port, { path: '/api/state', headers: { Cookie: cookie } })).status, 200);
    s.tick(12 * 3600_000 + 1);
    assert.equal((await req(s.port, { path: '/api/state', headers: { Cookie: cookie } })).status, 401);
  } finally { await s.room.close(); }
});

test('a foreign Host header is refused on every route', async () => {
  const s = await start();
  try {
    for (const p of ['/ping', '/', '/login?t=x', '/api/state']) {
      assert.equal((await req(s.port, { path: p, headers: { Host: `evil.example:${s.port}` } })).status, 421, p);
    }
    assert.equal((await req(s.port, { path: '/ping', headers: { Host: `localhost:${s.port}` } })).status, 200);
  } finally { await s.room.close(); }
});

test('state and the page with a session: JSON, no-store, strict headers', async () => {
  const s = await start();
  try {
    const cookie = await s.login();
    const st = await req(s.port, { path: '/api/state', headers: { Cookie: cookie } });
    assert.equal(st.status, 200);
    assert.deepEqual(JSON.parse(st.body), { v: 1, hello: 'world' });
    assert.match(st.headers['content-type'], /application\/json/);
    assert.equal(st.headers['cache-control'], 'no-store');
    const page = await req(s.port, { path: '/', headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.equal(page.body, ASSETS.html);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    const css = await req(s.port, { path: '/assets/room.css', headers: { Cookie: cookie } });
    assert.match(css.headers['content-type'], /text\/css/);
    const js = await req(s.port, { path: '/assets/room.js', headers: { Cookie: cookie } });
    assert.match(js.headers['content-type'], /javascript/);
    assert.equal((await req(s.port, { path: '/nope', headers: { Cookie: cookie } })).status, 404);
    assert.equal((await req(s.port, { path: '/api/answer', headers: { Cookie: cookie } })).status, 405);
  } finally { await s.room.close(); }
});

test('writes need the header, the room origin, JSON, a small body and valid JSON', async () => {
  const s = await start();
  try {
    const cookie = await s.login();
    const body = { project: 'p', id: 'q', option: 'A' };
    assert.equal((await post(s, cookie, '/api/answer', body, { 'X-Offlimits-Room': '' })).status, 403);
    assert.equal((await post(s, cookie, '/api/answer', body, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(s, cookie, '/api/answer', body, { Origin: '' })).status, 403);
    assert.equal((await post(s, cookie, '/api/answer', body, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(s, cookie, '/api/answer', { pad: 'x'.repeat(17 * 1024) })).status, 413);
    assert.equal((await post(s, cookie, '/api/answer', '{oops')).status, 400);
    assert.equal((await post(s, 'offlimits_room=bad', '/api/answer', body)).status, 401);
    assert.deepEqual(s.calls, []);
    const ok = await post(s, cookie, '/api/answer', body);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, line: 'x' });
    const loop = await post(s, cookie, '/api/loop', { project: 'p', loop: 'l', action: 'pause' }, { Origin: `http://localhost:${s.port}` });
    assert.equal(loop.status, 200);
    assert.deepEqual(s.calls, [['answer', body], ['loop', { project: 'p', loop: 'l', action: 'pause' }]]);
  } finally { await s.room.close(); }
});

test('a RoomError becomes its status and a JSON body; other errors are 500', async () => {
  const s = await start({
    answer: async () => { throw new RoomError(409, 'already-answered', 'answered', { answer: 'A' }); },
    setLoop: async () => { throw new Error('boom'); },
  });
  try {
    const cookie = await s.login();
    const r = await post(s, cookie, '/api/answer', { id: 'q' });
    assert.equal(r.status, 409);
    assert.deepEqual(JSON.parse(r.body), { error: 'already-answered', message: 'answered', data: { answer: 'A' } });
    const e = await post(s, cookie, '/api/loop', {});
    assert.equal(e.status, 500);
    assert.equal(JSON.parse(e.body).error, 'internal');
  } finally { await s.room.close(); }
});

test('listen rejects with EADDRINUSE when the port is taken', async () => {
  const a = await start();
  const b = createRoomServer({ getState: async () => ({}), answer: async () => ({}), setLoop: async () => ({}), assets: ASSETS });
  try {
    await assert.rejects(b.listen(a.port), (e) => e.code === 'EADDRINUSE');
  } finally {
    await a.room.close();
    await b.close();
  }
});
