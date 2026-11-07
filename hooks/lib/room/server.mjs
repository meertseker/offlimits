// The control room's local HTTP server: 127.0.0.1 only, one-time login link, session cookie, two guarded writes.
import crypto from 'node:crypto';
import http from 'node:http';
import { RoomError } from './errors.mjs';

const COOKIE = 'offlimits_room';
const MAX_BODY = 16 * 1024;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const COMMON = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const GET_ROUTES = ['/', '/ping', '/login', '/assets/room.css', '/assets/room.js', '/api/state'];
const POST_ROUTES = ['/api/answer', '/api/loop'];

const PAGE_401 = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Control room</title><body style="font:16px system-ui;margin:3rem;max-width:40rem">'
  + '<h1>Control room</h1><p>This page is not signed in. Open the link that <code>team room</code> printed in its terminal window, or start the room again.</p></body></html>';
const PAGE_403 = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Control room</title><body style="font:16px system-ui;margin:3rem;max-width:40rem">'
  + '<h1>Control room</h1><p>This sign-in link has expired or was already used. Run <code>team room</code> again for a new one.</p></body></html>';

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { ...COMMON, 'Content-Type': type, ...extra });
  res.end(body);
}
const json = (res, status, data) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));

function cookieValue(header) {
  for (const part of String(header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

/**
 * @param {{getState: () => Promise<object>, answer: (body: object) => Promise<object>, setLoop: (body: object) => Promise<object>,
 *   assets: {html: string, css: string, js: string}, now?: () => number, ticketTtlMs?: number, sessionTtlMs?: number}} opts
 */
export function createRoomServer({ getState, answer, setLoop, assets, now = Date.now, ticketTtlMs = 10 * 60_000, sessionTtlMs = 12 * 3600_000 }) {
  const tickets = new Map();
  const sessions = new Map();
  let port = null;
  let hosts = new Set();
  let origins = new Set();

  const authed = (req) => {
    const id = cookieValue(req.headers.cookie);
    if (!id || !/^[0-9a-f]{64}$/.test(id)) return false;
    const until = sessions.get(id);
    if (!until) return false;
    if (until < now()) {
      sessions.delete(id);
      return false;
    }
    return true;
  };

  async function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) tooBig = true;
        else chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return reject(new RoomError(413, 'too-large', 'request body is too large'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {
          reject(new RoomError(400, 'bad-json', 'request body is not valid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return send(res, 421, 'text/plain; charset=utf-8', 'This server answers only on its own address.');
    const url = new URL(req.url, 'http://room.invalid');
    const route = url.pathname;
    const isGet = GET_ROUTES.includes(route);
    const isPost = POST_ROUTES.includes(route);
    if (!isGet && !isPost) return json(res, 404, { error: 'not-found', message: 'no such route' });
    if ((isGet && req.method !== 'GET' && req.method !== 'HEAD') || (isPost && req.method !== 'POST')) {
      return json(res, 405, { error: 'method', message: 'method not allowed' });
    }
    if (route === '/ping') return json(res, 200, { offlimitsRoom: 1, pid: process.pid });
    if (route === '/login') {
      const t = url.searchParams.get('t') || '';
      const until = tickets.get(t);
      tickets.delete(t);
      if (!until || until < now()) return send(res, 403, 'text/html; charset=utf-8', PAGE_403, { 'Content-Security-Policy': CSP });
      const id = crypto.randomBytes(32).toString('hex');
      sessions.set(id, now() + sessionTtlMs);
      res.writeHead(303, { ...COMMON, Location: '/', 'Set-Cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}` });
      return res.end();
    }
    if (!authed(req)) {
      if (route === '/') return send(res, 401, 'text/html; charset=utf-8', PAGE_401, { 'Content-Security-Policy': CSP });
      return json(res, 401, { error: 'signed-out', message: 'open the link printed by team room' });
    }
    if (route === '/') return send(res, 200, 'text/html; charset=utf-8', assets.html, { 'Content-Security-Policy': CSP });
    if (route === '/assets/room.css') return send(res, 200, 'text/css; charset=utf-8', assets.css);
    if (route === '/assets/room.js') return send(res, 200, 'text/javascript; charset=utf-8', assets.js);
    if (route === '/api/state') return json(res, 200, await getState());
    if (req.headers['x-offlimits-room'] !== '1') throw new RoomError(403, 'missing-header', 'the X-Offlimits-Room header is required');
    if (!origins.has(String(req.headers.origin ?? ''))) throw new RoomError(403, 'bad-origin', 'requests must come from the control room page');
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new RoomError(415, 'bad-type', 'send application/json');
    const body = await readJson(req);
    const result = route === '/api/answer' ? await answer(body) : await setLoop(body);
    return json(res, 200, result);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof RoomError) {
        const body = { error: e.code, message: e.message };
        if (e.data !== undefined) body.data = e.data;
        return json(res, e.status, body);
      }
      return json(res, 500, { error: 'internal', message: String(e && e.message ? e.message : e).slice(0, 300) });
    });
  });

  return {
    get port() { return port; },
    /** Listen on 127.0.0.1; resolves the port (use 0 for any free port). Rejects with EADDRINUSE when taken. */
    listen(p) {
      return new Promise((resolve, reject) => {
        const onError = (e) => {
          server.off('listening', onListening);
          reject(e);
        };
        const onListening = () => {
          server.off('error', onError);
          port = server.address().port;
          hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
          origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
          resolve(port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ port: p, host: '127.0.0.1' });
      });
    },
    /** A single-use sign-in ticket, valid for ten minutes. */
    mintTicket() {
      const t = crypto.randomBytes(24).toString('base64url');
      tickets.set(t, now() + ticketTtlMs);
      return t;
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
  };
}
