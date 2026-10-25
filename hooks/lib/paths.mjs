import path from 'node:path';

/** Slash-normalise one path: `\` to `/`, Git Bash `/c/x` to `C:/x`, upper-case drive, no trailing slash. */
function canon(p, platform) {
  let s = String(p).replace(/\\/g, '/');
  // Win32 device / long-path prefixes: //?/C:/x, //./C:/x, //?/UNC/server/share
  s = s.replace(/^\/\/[?.]\/UNC\//i, '//').replace(/^\/\/[?.]\//, '');
  // Windows ignores trailing dots and spaces in a segment, and the default ::$DATA stream
  s = s
    .split('/')
    .map((seg) => {
      const t = seg.replace(/::\$DATA$/i, '').replace(/[. ]+$/, '');
      return seg === '.' || seg === '..' || t === '' ? seg.replace(/::\$DATA$/i, '') : t;
    })
    .join('/');
  const bash = /^\/([a-zA-Z])(?=\/|$)(.*)$/.exec(s);
  if (bash && platform === 'win32') s = `${bash[1]}:${bash[2] || '/'}`;
  const drive = /^([a-zA-Z]):(?=\/|$)/.exec(s);
  if (drive) s = drive[1].toUpperCase() + s.slice(1);
  return s;
}

function isAbs(s) {
  return s.startsWith('/') || /^[A-Za-z]:\//.test(s) || /^[A-Za-z]:$/.test(s);
}

function clean(s) {
  const d = /^([A-Za-z]:)(\/.*)?$/.exec(s);
  if (d) {
    // normalise below the drive so "C:/.." stays "C:/"
    const rest = path.posix.normalize(d[2] || '/');
    return rest === '/' ? `${d[1]}/` : `${d[1]}${rest.endsWith('/') ? rest.slice(0, -1) : rest}`;
  }
  let n = path.posix.normalize(s);
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

/**
 * Absolute, canonical form of `p`, resolved against `base` when relative.
 * @param {string} base
 * @param {string} p
 * @param {string} [platform]
 */
export function resolvePath(base, p, platform = process.platform) {
  const c = canon(p, platform);
  if (isAbs(c)) return clean(c);
  return clean(`${clean(canon(base, platform))}/${c}`);
}

/** True when `p` is absolute (after canonicalisation). */
export function isAbsolutePath(p, platform = process.platform) {
  return isAbs(canon(p, platform));
}

/** True when `a` equals `b` or is a directory above it. Both are canonicalised. */
export function isAncestorOrSelf(a, b, platform = process.platform) {
  const fold = ci(platform) ? (x) => x.toLowerCase() : (x) => x;
  const fa = fold(clean(canon(a, platform)));
  const fb = fold(clean(canon(b, platform)));
  if (fa === fb) return true;
  const prefix = fa.endsWith('/') ? fa : `${fa}/`;
  return fb.startsWith(prefix);
}

/**
 * Replace a leading `~`, `$HOME`, `${HOME}`, `$env:HOME`, `$env:USERPROFILE`, `%USERPROFILE%` with `home`.
 * @param {string} p
 * @param {string} home
 */
export function expandHome(p, home) {
  const s = String(p);
  const m = /^(~|\$HOME\b|\$\{HOME\}|\$env:(?:HOME|USERPROFILE)\b|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%)(?=$|[\\/])/i.exec(s);
  return m && home ? home + s.slice(m[0].length) : s;
}

/**
 * Path relative to `root` using `/`, or the normalised absolute path when outside root.
 * Drive-letter case is ignored; the rest of the path is compared exactly.
 * @param {string} root
 * @param {string} p
 * @param {string} [platform]
 * @returns {string}
 */
export function normalizeRel(root, p, platform = process.platform) {
  const r = clean(canon(root, platform));
  const c = canon(p, platform);
  const abs = clean(isAbs(c) ? c : `${r}/${c}`);
  const fold = ci(platform) ? (x) => x.toLowerCase() : (x) => x;
  const fa = fold(abs);
  const fr = fold(r);
  if (fa === fr) return '.';
  const prefix = fr.endsWith('/') ? fr : `${fr}/`;
  return fa.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

const ci = (platform) => platform === 'win32' || platform === 'darwin';

const cache = new Map();

function compile(pattern, flags) {
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
  return new RegExp(`^${out}$`, flags);
}

/**
 * Glob match over `/`-separated relative paths: `**` any depth, `*` within a segment, `?` one char.
 * @param {string} pattern
 * @param {string} rel
 * @param {string} [platform]
 * @returns {boolean}
 */
export function globMatch(pattern, rel, platform = process.platform) {
  const flags = ci(platform) ? 'i' : '';
  const key = `${flags}:${pattern}`;
  let re = cache.get(key);
  if (!re) {
    re = compile(pattern, flags);
    cache.set(key, re);
  }
  return re.test(rel);
}
