// Inbox folders (newest Markdown files) and log watches (last success, errors after it). Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_TEXT = 400;
const FIELD = /^\s*[-*]\s+([^:\n]{1,40}):\s*(.*)$/;
const LEAD_TS = /^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/;

function readSlice(file, fromEnd, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, fromEnd ? size - n : 0);
    return { text: buf.toString('utf8'), partial: fromEnd && size > n };
  } finally { fs.closeSync(fd); }
}

const cut = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

function summary(text) {
  const lines = text.split(/\r?\n/);
  const fields = [];
  for (const l of lines) {
    const m = FIELD.exec(l);
    if (m && fields.length < 8) fields.push([m[1].trim(), m[2].trim().slice(0, 200)]);
  }
  const fence = /```[^\n]*\r?\n([\s\S]*?)\r?\n\s*```/.exec(text);
  if (fence) return { fields, text: cut(fence[1].trim()) };
  const para = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) {
      if (para.length) break;
      continue;
    }
    if (/^(#|>|[-*]\s|\|)/.test(t)) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  return { fields, text: cut(para.join(' ')) };
}

/**
 * The newest Markdown files of a folder.
 * @param {{name: string, dir: string, limit: number}} cfg
 * @returns {{name: string, items: {file: string, mtime: number, fields: [string, string][], text: string}[], total: number, error?: string}}
 */
export function readInbox(cfg) {
  let names;
  try { names = fs.readdirSync(cfg.dir); } catch (e) {
    return { name: cfg.name, items: [], total: 0, error: `cannot read ${cfg.dir} (${e.code || e.message})` };
  }
  const files = [];
  for (const name of names) {
    if (!/\.md$/i.test(name) || name.startsWith('.')) continue;
    try {
      const st = fs.statSync(path.join(cfg.dir, name));
      if (st.isFile()) files.push({ name, mtime: st.mtimeMs });
    } catch { /* gone */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const items = files.slice(0, cfg.limit).map(({ name, mtime }) => {
    try {
      return { file: name, mtime, ...summary(readSlice(path.join(cfg.dir, name), false, HEAD_BYTES).text) };
    } catch { return { file: name, mtime, fields: [], text: '' }; }
  });
  return { name: cfg.name, items, total: files.length };
}

function lineTime(line) {
  const m = LEAD_TS.exec(line);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * The last line matching `ok`, how many `error` lines came after it, and the last `error` line, from the last 64 KiB.
 * @param {{name: string, file: string, ok: string, error: string}} cfg
 */
export function readLogWatch(cfg) {
  const out = { name: cfg.name, file: cfg.file, lastOk: null, errorsSinceOk: 0, lastError: null, mtime: null };
  let slice;
  try {
    out.mtime = fs.statSync(cfg.file).mtimeMs;
    slice = readSlice(cfg.file, true, TAIL_BYTES);
  } catch (e) {
    return { ...out, error: `cannot read ${cfg.file} (${e.code || e.message})` };
  }
  let ok;
  let bad;
  try {
    ok = new RegExp(cfg.ok);
    bad = new RegExp(cfg.error);
  } catch {
    return { ...out, error: 'the ok or error pattern is not a valid regular expression' };
  }
  const lines = slice.text.split(/\r?\n/);
  if (slice.partial) lines.shift();
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (ok.test(line)) {
      out.lastOk = { ts: lineTime(line), line: line.slice(0, 300) };
      out.errorsSinceOk = 0;
    } else if (bad.test(line)) {
      out.errorsSinceOk++;
      out.lastError = { ts: lineTime(line), line: line.slice(0, 300) };
    }
  }
  return out;
}
