// Quote-aware shell parsing helpers for offlimits.
// Pure string processing: no process spawning, no filesystem access.

const WRAPPER_PREFIXES = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'nice']);
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PS_SHELLS = new Set(['pwsh', 'powershell']);

/** Split a command on ; && || | & and newlines, outside quotes and substitutions. */
export function segments(command) {
  const s = String(command ?? '');
  const out = [];
  let cur = '';
  let q = null; // active quote char
  let depth = 0; // $( ... ) nesting
  let bt = false; // inside backticks
  const flush = () => {
    const t = cur.trim();
    if (t) out.push(t);
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
      if (c === '\\') {
        cur += c + (s[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === '"') q = null;
      cur += c;
      continue;
    }
    if (c === '\\') {
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
    if (c === ')' && depth > 0) depth--;
    if (depth > 0 || bt) {
      cur += c;
      continue;
    }
    if (c === ';' || c === '\n' || c === '\r') {
      flush();
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

/** Body of a nested shell invocation (bash -c "..." etc.), or null. */
function wrapperBody(segment) {
  const toks = tokens(stripAssignments(segment).rest);
  let i = 0;
  while (
    i < toks.length &&
    (WRAPPER_PREFIXES.has(baseName(toks[i])) || /^[A-Za-z_]\w*=/.test(toks[i]))
  ) {
    i++;
  }
  if (i >= toks.length) return null;
  const name = baseName(toks[i]);
  const args = toks.slice(i + 1);
  if (name === 'eval') return args.length ? args.join(' ') : null;
  if (POSIX_SHELLS.has(name)) {
    const k = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    return k !== -1 && k + 1 < args.length ? args[k + 1] : null;
  }
  if (PS_SHELLS.has(name)) {
    const k = args.findIndex((a) => /^-(c|command)$/i.test(a));
    return k !== -1 && k + 1 < args.length ? args.slice(k + 1).join(' ') : null;
  }
  if (name === 'cmd') {
    const k = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return k !== -1 && k + 1 < args.length ? args.slice(k + 1).join(' ') : null;
  }
  return null;
}

/** Return [segment, ...inner] where inner are nested-shell and substitution bodies (one level). */
export function unwrap(segment) {
  const seg = String(segment ?? '');
  const bodies = [];
  const w = wrapperBody(seg);
  if (w !== null) bodies.push(w);
  bodies.push(...substitutions(seg));
  const inner = bodies.flatMap((b) => segments(b));
  return [seg, ...inner];
}

/** Segments of a command plus one level of unwrapped inner segments, unique. */
export function expand(command) {
  return [...new Set(segments(command).flatMap((s) => unwrap(s)))];
}
