// Quote-aware shell parsing helpers for offlimits.
// Pure string processing: no process spawning, no filesystem access.

export const OPAQUE_PREFIX = 'offlimits:opaque';
const OPAQUE_STDIN = `${OPAQUE_PREFIX} shell reads stdin`;
const MAX_ROUNDS = 8;

// Commands that merely run another command; we scan past them (and their flags) to the shell.
const WRAPPER_PREFIXES = new Set([
  'sudo', 'env', 'command', 'exec', 'time', 'nohup', 'nice',
  'timeout', 'doas', 'stdbuf', 'setsid', 'xargs',
]);
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PS_SHELLS = new Set(['pwsh', 'powershell']);
const SHELL_LIKE = new Set([...POSIX_SHELLS, ...PS_SHELLS, 'cmd', 'eval']);

// Leading shell keywords / grouping tokens that are not part of the command itself.
const LEADING_NOISE = /^(?:[{}!](?:\s+|$)|(?:then|do|else|elif|if|while|until|time)(?:\s+|$))/;

/**
 * One scan over the command. With literalBackslash the backslash is an ordinary
 * character (Windows paths such as "C:\repo\" must not swallow the closing quote).
 */
function scan(s, literalBackslash) {
  const out = [];
  let cur = '';
  let q = null; // active quote char
  let depth = 0; // $( ... ) nesting
  let bt = false; // inside backticks
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") q = null;
      cur += c;
      continue;
    }
    if (q === '"') {
      if (c === '\\' && !literalBackslash) {
        cur += c + (s[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === '"') q = null;
      cur += c;
      continue;
    }
    if (c === '\\' && !literalBackslash) {
      cur += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === '`') {
      bt = !bt;
      cur += c;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      depth++;
      cur += '$(';
      i++;
      continue;
    }
    if (depth > 0) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      cur += c;
      continue;
    }
    if (bt) {
      cur += c;
      continue;
    }
    if (c === ';' || c === '\n' || c === '\r' || c === '(' || c === ')') {
      flush(); // includes grouping parens and <( >( process substitution
    } else if (c === '|') {
      if (s[i + 1] === '|') i++;
      flush();
    } else if (c === '&') {
      if (s[i + 1] === '&') {
        i++;
        flush();
      } else if (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>') {
        cur += c; // 2>&1, &>file
      } else {
        flush();
      }
    } else {
      cur += c;
    }
  }
  flush();
  return out;
}

/** Drop leading keywords/braces/negation and a trailing closing brace. */
function clean(seg) {
  let t = seg.trim();
  for (;;) {
    const n = t.replace(LEADING_NOISE, '').replace(/\s+\}$/, '').trim();
    if (n === t) return t;
    t = n;
  }
}

/** Split a command on ; && || | & newlines and grouping, outside quotes and substitutions. */
export function segments(command) {
  const s = String(command ?? '');
  const raw = scan(s, false);
  // Second scan with literal backslashes; union is the safe (over-splitting) direction.
  if (s.includes('\\')) raw.push(...scan(s, true));
  const out = [];
  for (const r of raw) {
    const c = clean(r);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Shell-style tokenisation honouring quotes; quotes are dropped. */
export function tokens(segment) {
  const s = String(segment ?? '');
  const out = [];
  let cur = '';
  let has = false;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
      continue;
    }
    if (q === '"') {
      if (c === '\\' && '"\\$`'.includes(s[i + 1] ?? '\0')) {
        cur += s[i + 1];
        i++;
      } else if (c === '"') q = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === '\\' && (s[i + 1] === '"' || s[i + 1] === "'" || s[i + 1] === ' ')) {
      cur += s[i + 1];
      i++;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Read one quote-aware word starting at i; returns [raw, nextIndex]. */
function readWord(s, i, stopAtSemicolon) {
  let q = null;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (q) {
      if (c === '\\' && q === '"') j++;
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (/\s/.test(c) || (stopAtSemicolon && c === ';')) break;
  }
  return [s.slice(i, j), j];
}

/** Separate leading NAME=value pairs (and PowerShell $env:NAME = value;) from the command. */
export function stripAssignments(segment) {
  const s = String(segment ?? '');
  const assignments = [];
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const rest = s.slice(i);
    let m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(rest);
    if (m) {
      const [raw, next] = readWord(s, i + m[0].length, false);
      assignments.push(`${m[1]}=${tokens(raw)[0] ?? ''}`);
      i = next;
      continue;
    }
    m = /^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/i.exec(rest);
    if (m) {
      const [raw, next] = readWord(s, i + m[0].length, true);
      assignments.push(`${m[1]}=${tokens(raw)[0] ?? ''}`);
      i = next;
      while (i < s.length && /[\s;]/.test(s[i])) i++;
      continue;
    }
    break;
  }
  return { assignments, rest: s.slice(i).trim() };
}

/** Bodies of $(...) and `...` found outside single quotes (outermost only). */
function substitutions(s) {
  const out = [];
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") q = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      q = q === c ? null : (q ?? c);
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      let iq = null;
      for (; j < s.length && depth > 0; j++) {
        const d = s[j];
        if (iq) {
          if (d === '\\' && iq === '"') j++;
          else if (d === iq) iq = null;
        } else if (d === "'" || d === '"') iq = d;
        else if (d === '(') depth++;
        else if (d === ')') depth--;
      }
      out.push(s.slice(i + 2, depth === 0 ? j - 1 : j));
      i = j - 1;
    } else if (c === '`') {
      const end = s.indexOf('`', i + 1);
      const stop = end === -1 ? s.length : end;
      out.push(s.slice(i + 1, stop));
      i = stop;
    }
  }
  return out;
}

function baseName(tok) {
  return tok.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

const isPsCommandFlag = (a) => /^-(c|com|comm|comma|comman|command)$/i.test(a);
const isPsEncodedFlag = (a) =>
  /^-ec$/i.test(a) || (/^-e/i.test(a) && 'encodedcommand'.startsWith(a.slice(1).toLowerCase()));

/** Inspect a nested-shell invocation: { bodies: string[], opaque: boolean }. */
function wrapperInfo(segment) {
  const none = { bodies: [], opaque: false };
  const toks = tokens(stripAssignments(segment).rest);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_]\w*=/.test(toks[i])) i++;
  if (i >= toks.length) return none;
  if (WRAPPER_PREFIXES.has(baseName(toks[i]))) {
    // Skip the prefix together with its flags and values, up to the next shell-like token.
    let k = i + 1;
    while (k < toks.length && !SHELL_LIKE.has(baseName(toks[k]))) k++;
    if (k >= toks.length) return none;
    i = k;
  }
  const name = baseName(toks[i]);
  const args = toks.slice(i + 1);
  const afterFlag = (k) => {
    let j = k + 1;
    while (j < args.length && args[j] === '--') j++;
    return j < args.length ? j : -1;
  };
  if (name === 'eval') return { bodies: args.length ? [args.join(' ')] : [], opaque: false };
  if (POSIX_SHELLS.has(name)) {
    const k = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    if (k !== -1) {
      const j = afterFlag(k);
      return { bodies: j === -1 ? [] : [args[j]], opaque: false };
    }
    // No -c: reads stdin unless it is given a script file.
    const bodies = [];
    const hs = args.indexOf('<<<');
    if (hs !== -1 && hs + 1 < args.length) bodies.push(args[hs + 1]);
    const positional = args.filter((a) => !a.startsWith('-'));
    const redirected = args.some((a) => a.startsWith('<'));
    return { bodies, opaque: positional.length === 0 || redirected };
  }
  if (PS_SHELLS.has(name)) {
    const e = args.findIndex(isPsEncodedFlag);
    if (e !== -1 && e + 1 < args.length) {
      let decoded = '';
      try {
        decoded = Buffer.from(args[e + 1], 'base64').toString('utf16le');
      } catch {
        decoded = '';
      }
      return { bodies: decoded ? [decoded] : [], opaque: false };
    }
    const k = args.findIndex(isPsCommandFlag);
    if (k !== -1 && k + 1 < args.length) return { bodies: [args.slice(k + 1).join(' ')], opaque: false };
    const hasWork = args.some((a) => !a.startsWith('-')) && args.every((a) => a !== '-');
    return { bodies: [], opaque: !hasWork || args.includes('-') };
  }
  if (name === 'cmd') {
    const k = args.findIndex((a) => /^\/[ck]/i.test(a));
    if (k === -1) return none;
    const first = args[k].slice(2); // e.g. /c"git push" tokenises to "/cgit push"
    const body = [first, ...args.slice(k + 1)].filter((x) => x !== '').join(' ');
    return { bodies: body ? [body] : [], opaque: false };
  }
  return none;
}

/** Return [segment, ...inner] where inner are nested-shell and substitution bodies (one level). */
export function unwrap(segment) {
  const seg = String(segment ?? '');
  if (seg.startsWith(OPAQUE_PREFIX)) return [seg];
  const info = wrapperInfo(seg);
  const bodies = [...info.bodies, ...substitutions(seg)];
  const out = [seg, ...bodies.flatMap((b) => segments(b))];
  if (info.opaque) out.push(OPAQUE_STDIN);
  return out;
}

/** Segments of a command plus recursively unwrapped inner segments (depth-capped), unique. */
export function expand(command) {
  const seen = new Set(segments(command));
  let frontier = [...seen];
  for (let round = 0; round < MAX_ROUNDS && frontier.length; round++) {
    const next = [];
    for (const seg of frontier) {
      for (const s of unwrap(seg)) {
        if (!seen.has(s)) {
          seen.add(s);
          next.push(s);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}
