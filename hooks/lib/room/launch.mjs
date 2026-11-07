// `team room`: load the config, replace a running room, serve the page, print the one-time link. Human terminals only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent } from '../team/events.mjs';
import { answerRequest } from './approvals.mjs';
import { loadRoomConfig, roomHome } from './config.mjs';
import { RoomError } from './errors.mjs';
import { setLoop as writeLoop } from './loops.mjs';
import { createRoomServer } from './server.mjs';
import { buildSnapshot } from './snapshot.mjs';

const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url));
const CACHE_MS = 10_000;
const PORT_TRIES = 10;

/** Open a URL in the default browser without a shell. */
export function openUrl(url, platform = process.platform) {
  const [file, args] = platform === 'win32' ? ['explorer.exe', [url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* no browser: the link is printed anyway */ });
    child.unref();
  } catch { /* the link is printed anyway */ }
}

function waitForSignal() {
  return new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

function ping(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/ping', timeout: 1500, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.on('error', () => resolve(null));
  });
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stop the room recorded in room.pid, but only when it answers /ping as that same process. */
async function stopPrevious(pidFile, out) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch { return; }
  if (!rec || !Number.isInteger(rec.pid) || !Number.isInteger(rec.port) || rec.pid === process.pid) return;
  if (!alive(rec.pid)) {
    fs.rmSync(pidFile, { force: true });
    return;
  }
  const p = await ping(rec.port);
  if (!p || p.offlimitsRoom !== 1 || p.pid !== rec.pid) return;
  try { process.kill(rec.pid); } catch { return; }
  for (let i = 0; i < 30 && (await ping(rec.port)); i++) await sleep(100);
  out(`offlimits room: stopped the previous control room (pid ${rec.pid})`);
}

/**
 * @param {{flags: object, env: object, cwd: string, out: (s: string) => void, err: (s: string) => void, platform: string,
 *   deps?: {homedir?: () => string, now?: () => number, openUrl?: Function, waitForExit?: () => Promise<void>}}} opts
 * @returns {Promise<number>} exit code
 */
export async function runRoom({ flags, env, cwd, out, err, platform, deps = {} }) {
  const homedir = deps.homedir ?? os.homedir;
  const now = deps.now ?? Date.now;
  const { config, problems, source, file } = loadRoomConfig({ file: flags.config, cwd, env, homedir });
  for (const p of problems) err(`offlimits room: ${p}`);
  if (!source) return 2;
  const home = roomHome(env, homedir);
  fs.mkdirSync(home, { recursive: true });
  const pidFile = path.join(home, 'room.pid');
  const eventsFile = path.join(home, 'events.jsonl');
  await stopPrevious(pidFile, out);

  const assets = {
    html: fs.readFileSync(path.join(ASSETS, 'room.html'), 'utf8'),
    css: fs.readFileSync(path.join(ASSETS, 'room.css'), 'utf8'),
    js: fs.readFileSync(path.join(ASSETS, 'room.js'), 'utf8'),
  };
  let cached = null;
  let building = null;
  const getState = async () => {
    if (cached && now() - cached.at < CACHE_MS) return cached.value;
    if (!building) {
      building = buildSnapshot(config, { now, env, homedir, problems, platform })
        .then((value) => {
          cached = { at: now(), value };
          return value;
        })
        .finally(() => { building = null; });
    }
    return building;
  };
  const record = (fields) => {
    try { appendEvent(eventsFile, fields, { now }); } catch (e) {
      err(`offlimits room: could not write the event log (${e.message})`);
    }
  };
  const answer = async (body) => {
    const p = config.projects.find((x) => x.id === body.project);
    if (!p || !p.approvals) throw new RoomError(404, 'not-found', 'no such project, or it has no approvals folder');
    const r = answerRequest(p.approvals, { id: body.id, option: body.option, note: body.note }, { now });
    cached = null;
    record({ type: 'approval.answered', project: p.id, actor: p.approvals.actor, note: `${body.id} ${body.option}`, data: { id: body.id, option: body.option } });
    return { ok: true, line: r.line, file: path.basename(r.file) };
  };
  const setLoop = async (body) => {
    const p = config.projects.find((x) => x.id === body.project);
    const loop = p && p.loops.find((l) => l.id === body.loop);
    if (!loop) throw new RoomError(404, 'not-found', 'no such loop');
    const r = writeLoop(loop, body.action, { now });
    cached = null;
    record({ type: body.action === 'pause' ? 'loop.paused' : 'loop.resumed', project: p.id, actor: 'human', data: { loop: loop.id, status: r.status } });
    return { ok: true, status: r.status, paused: r.paused };
  };

  const server = createRoomServer({ getState, answer, setLoop, assets, now });
  const wanted = flags.port ?? config.port;
  let port = null;
  for (let p = wanted; p <= wanted + PORT_TRIES && port === null; p++) {
    try { port = await server.listen(p); } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  if (port === null) {
    err(`offlimits room: ports ${wanted} to ${wanted + PORT_TRIES} are all busy; pass --port`);
    return 1;
  }
  if (port !== wanted) out(`offlimits room: port ${wanted} is busy; using ${port}`);
  fs.writeFileSync(pidFile, `${JSON.stringify({ pid: process.pid, port, startedAt: new Date(now()).toISOString() })}\n`);
  const link = () => `http://127.0.0.1:${port}/login?t=${server.mintTicket()}`;
  out(`offlimits room: ${source === 'file' ? file : 'this repository'}, ${config.projects.length} project${config.projects.length === 1 ? '' : 's'}`);
  const first = link();
  out(`open: ${first}`);
  out('The link works once. Press Enter for a new one, Ctrl+C to stop.');
  if (!flags['no-open']) (deps.openUrl ?? openUrl)(first, platform);
  const onLine = () => out(`open: ${link()}`);
  const interactive = !deps.waitForExit && process.stdin.isTTY;
  if (interactive) process.stdin.on('data', onLine);
  try {
    await (deps.waitForExit ?? waitForSignal)();
  } finally {
    if (interactive) {
      process.stdin.off('data', onLine);
      process.stdin.pause();
    }
    await server.close();
    try {
      const cur = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      if (cur.pid === process.pid) fs.rmSync(pidFile, { force: true });
    } catch { /* already gone */ }
  }
  return 0;
}
