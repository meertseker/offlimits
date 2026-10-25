import path from 'node:path';

/** Slash-normalise one path: `\` to `/`, Git Bash `/c/x` to `C:/x`, upper-case drive, no trailing slash. */
function canon(p) {
  let s = String(p).replace(/\\/g, '/');
  const bash = /^\/([a-zA-Z])(?=\/|$)(.*)$/.exec(s);
  if (bash) s = `${bash[1]}:${bash[2] || '/'}`;
  const drive = /^([a-zA-Z]):(?=\/|$)/.exec(s);
  if (drive) s = drive[1].toUpperCase() + s.slice(1);
  return s;
}

function isAbs(s) {
  return s.startsWith('/') || /^[A-Za-z]:\//.test(s) || /^[A-Za-z]:$/.test(s);
}

function clean(s) {
  let n = path.posix.normalize(s);
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  // a bare drive such as "C:" must keep its slash form
  return /^[A-Za-z]:$/.test(n) ? `${n}/` : n;
}

/**
 * Path relative to `root` using `/`, or the normalised absolute path when outside root.
 * Drive-letter case is ignored; the rest of the path is compared exactly.
 * @param {string} root
 * @param {string} p
 * @returns {string}
 */
export function normalizeRel(root, p) {
  const r = clean(canon(root));
  const c = canon(p);
  const abs = clean(isAbs(c) ? c : `${r}/${c}`);
  if (abs === r) return '.';
  const prefix = r.endsWith('/') ? r : `${r}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

const cache = new Map();

function compile(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
    }
  }
  // "dir/**" also matches "dir" itself
  if (pattern.endsWith('/**')) out = out.replace(/\\\/\.\*$/, '(?:\\/.*)?');
  return new RegExp(`^${out}$`);
}

/**
 * Glob match over `/`-separated relative paths: `**` any depth, `*` within a segment, `?` one char.
 * @param {string} pattern
 * @param {string} rel
 * @returns {boolean}
 */
export function globMatch(pattern, rel) {
  let re = cache.get(pattern);
  if (!re) {
    re = compile(pattern);
    cache.set(pattern, re);
  }
  return re.test(rel);
}
