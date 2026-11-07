// A small Markdown reader for ledger files: sections, tables, lists, paragraphs, code. Output is data, never HTML.

const MAX_SECTION_LINES = 400;
const MAX_CELL = 1500;
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*```/;
const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Inline tokens: text, code spans, **strong** and links. Only http(s) links keep an href.
 * @param {string} s
 * @returns {{t: 'text'|'code'|'strong'|'link', v: string, href?: string}[]}
 */
export function parseInline(s) {
  const text = String(s ?? '');
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'strong', v: m[2] });
    else if (/^https?:\/\//i.test(m[4])) out.push({ t: 'link', v: m[3], href: m[4] });
    else out.push({ t: 'text', v: m[3] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

const plain = (inline) => inline.map((i) => i.v).join('');

function cells(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => parseInline(cut(c.trim(), MAX_CELL)));
}

/**
 * Blocks from Markdown lines.
 * @param {string[]} lines
 */
export function parseBlocks(lines) {
  const ls = lines.map((l) => String(l).replace(/\r$/, ''));
  const out = [];
  let para = null;
  let list = null;
  const flush = () => {
    if (para) out.push({ kind: 'para', inline: parseInline(para.join(' ')) });
    if (list) out.push({ kind: 'list', ordered: list.ordered, items: list.items.map((it) => parseInline(it)) });
    para = null;
    list = null;
  };
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    if (FENCE.test(line)) {
      flush();
      const body = [];
      for (i++; i < ls.length && !FENCE.test(ls[i]); i++) body.push(ls[i]);
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < ls.length && SEPARATOR.test(ls[i + 1])) {
      flush();
      const header = cells(line);
      const rows = [];
      for (i += 2; i < ls.length && ls[i].trim().startsWith('|'); i++) rows.push(cells(ls[i]));
      i--;
      out.push({ kind: 'table', header, rows });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      out.push({ kind: 'para', heading: true, inline: [{ t: 'strong', v: plain(parseInline(h[2])) }] });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      const ordered = Boolean(n);
      if (para) flush();
      if (list && list.ordered !== ordered) flush();
      if (!list) list = { ordered, items: [] };
      list.items.push((b || n)[1]);
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (list) flush();
    if (!para) para = [];
    para.push(line.trim());
  }
  flush();
  return out;
}

function headings(lines) {
  const out = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) return;
    const m = HEADING.exec(line);
    if (m) out.push({ i, level: m[1].length, title: plain(parseInline(m[2])).trim() });
  });
  return out;
}

/**
 * The sections whose heading starts with one of `names` (case-insensitive), in the order of `names`.
 * A section runs to the next heading of the same or a higher level; at most 400 lines are read.
 * @param {string} text
 * @param {string[]} names
 * @returns {{title: string, level: number, blocks: object[], truncated: boolean}[]}
 */
export function pickSections(text, names) {
  const lines = String(text ?? '').split(/\r?\n/);
  const hs = headings(lines);
  const out = [];
  for (const name of names) {
    const want = String(name).trim().toLowerCase();
    if (!want) continue;
    const k = hs.findIndex((h) => h.title.toLowerCase().startsWith(want));
    if (k < 0) continue;
    const h = hs[k];
    const next = hs.slice(k + 1).find((x) => x.level <= h.level);
    const body = lines.slice(h.i + 1, next ? next.i : lines.length);
    const truncated = body.length > MAX_SECTION_LINES;
    out.push({ title: h.title, level: h.level, blocks: parseBlocks(truncated ? body.slice(0, MAX_SECTION_LINES) : body), truncated });
  }
  return out;
}

/**
 * Table rows as plain text, each with its table's header.
 * @param {object[]} blocks
 * @returns {{header: string[], cells: string[]}[]}
 */
export function tableRows(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.kind !== 'table') continue;
    const header = b.header.map((c) => plain(c).trim());
    for (const r of b.rows) out.push({ header, cells: r.map((c) => plain(c).trim()) });
  }
  return out;
}

/**
 * One value from a file: the last match of `regex`, its first capture group when it has one. Null when nothing matches.
 * @param {string} text
 * @param {string} regex
 */
export function extractFact(text, regex) {
  let re;
  try { re = new RegExp(regex, 'g'); } catch { return null; }
  let last = null;
  for (const m of String(text ?? '').matchAll(re)) {
    last = m[1] !== undefined ? m[1] : m[0];
    if (m[0] === '') break;
  }
  return last === null ? null : last.trim().slice(0, 200);
}
