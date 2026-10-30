// Quote-aware shell parsing helpers for offlimits.
// Pure string processing: no process spawning, no filesystem access.

export const OPAQUE_PREFIX = 'offlimits:opaque';
const OPAQUE_STDIN = `${OPAQUE_PREFIX} shell reads stdin`;
export const OPAQUE_DEEP = `${OPAQUE_PREFIX} nesting too deep`;
export const OPAQUE_EVAL = `${OPAQUE_PREFIX} eval of command output`;
const MAX_ROUNDS = 8;

/**
 * The one wrapper table: commands that merely run another command. `v` lists the wrapper's flags
 * that take a separate value, `pos` how many leading positionals (duration, priority, CPU mask,
 * lock file) the wrapper itself consumes. Used by the shell unwrapper and by every rule module.
 */
export const WRAPPERS = Object.freeze({
  sudo: { v: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir', '--host', '--prompt', '--role', '--type', '--other-user', '--close-from', '--command-timeout'] },
  doas: { v: ['-u', '-C'] },
  env: { v: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'] },
  command: {},
  builtin: {},
  exec: { v: ['-a'] },
  nohup: {},
  time: { v: ['-f', '--format', '-o', '--output'] },
  nice: { v: ['-n', '--adjustment'] },
  timeout: { v: ['-s', '--signal', '-k', '--kill-after'], pos: 1 },
  stdbuf: { v: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  setsid: {},
  ionice: { v: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'] },
  flock: { v: ['-w', '--timeout', '-E', '--conflict-exit-code'], pos: 1 },
  chrt: { v: ['-T', '--sched-runtime', '-P', '--sched-period', '-D', '--sched-deadline'], pos: 1 },
  taskset: { pos: 1 },
  watch: { v: ['-n', '--interval'] },
  unbuffer: {},
  strace: { v: ['-o', '-e', '-p', '-s', '-u', '-E', '-P', '-I', '-b', '-a', '-X', '-O', '-S'] },
  winpty: {},
  chronic: {},
  xargs: { v: ['-I', '-n', '-P', '-L', '-d', '-a', '-E', '-s', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace', '--max-lines', '--eof', '--max-chars'] },
});
const isWrapper = (name) => Object.hasOwn(WRAPPERS, name);
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PS_SHELLS = new Set(['pwsh', 'powershell']);
const SHELL_LIKE = new Set([...POSIX_SHELLS, ...PS_SHELLS, 'cmd', 'eval']);
const ASSIGN = /^[A-Za-z_]\w*=/;
const EVAL_SAFE = new Set(['ssh-agent', 'brew', 'direnv', 'pyenv', 'rbenv', 'nodenv', 'fnm', 'zoxide', 'starship', 'mise', 'rtx', 'conda', 'keychain', 'dircolors', 'opam', 'luarocks', 'pdm', 'register-python-argcomplete']);

const START_LIKE = /^\s*(?:&\s*)?(?:start-process|saps|start)\s/i;

// PowerShell lead-ins that still run the command after them: assignments ($p =, $x +=, $script:p =, [type]$p =, ${p} =,
// $a, $b =, $h['k'] =, $p ??=), [type] casts before a parenthesised body, dot-sourcing (. cmd) and the call operator (& cmd).
// $env:NAME = is left to stripAssignments, which records the variable.
const PS_TYPE = String.raw`\[(?:[^\[\]]|\[[^\[\]]*\])*\]`;
const PS_VAR = String.raw`(?:\$\{[^}]*\}|\$(?!env:)[A-Za-z_]\w*(?::[A-Za-z_]\w*)?)(?:\.\w+|\[[^\]]*\])*`;
const PS_LEAD = new RegExp(
  String.raw`^\s*(?:(?:${PS_TYPE}\s*)*${PS_VAR}(?:\s*,\s*${PS_VAR})*\s*(?:[-+*/%]|\?\?)?=(?!=)|(?:${PS_TYPE}\s*)+(?=\()|\.(?=\s+\S)|&)\s*`,
  'i',
);

/** Drop PowerShell lead-ins (see PS_LEAD) from the start of a segment; the command after them is what runs. */
export function psLead(seg) {
  const s = dropPsLead(seg);
  return s.trim() ? s.trim() : String(seg).trim();
}

/** psLead without trimming (scan() needs the space after Start-Process). */
function dropPsLead(seg) {
  let s = String(seg);
  for (let m; (m = PS_LEAD.exec(s)) && m[0].length; ) s = s.slice(m[0].length);
  return s;
}
const OPEN = Symbol('open');
const CLOSE = Symbol('close');

/**
 * One scan over the command. With literalBackslash the backslash is an ordinary
 * character (Windows paths such as "C:\repo\" must not swallow the closing quote).
 * With marks, grouping parentheses are reported as OPEN / CLOSE items.
 */
function scan(s, literalBackslash, marks = false, ps = false) {
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
    if (c === '(' && START_LIKE.test(ps ? dropPsLead(cur) : cur)) {
      // Start-Process git ('push', 'origin'): an argument list, not a grouping
      depth++;
      cur += c;
      continue;
    }
    if ((c === '$' || c === '@') && s[i + 1] === '(') {
      // $( ... ) and PowerShell's @( ... ) stay in one segment; substitutions() hands the inside on
      depth++;
      cur += c + '(';
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
    if (c === ';' || c === '\n' || c === '\r') {
      flush();
    } else if (c === '(' || c === ')') {
      flush(); // includes grouping parens and <( >( process substitution
      if (marks) out.push(c === '(' ? OPEN : CLOSE);
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

// Leading shell keywords / grouping tokens that are not part of the command itself.
const NOISE_WORDS = [/[{}!]/y, /time\s+-p/y, /(?:then|do|else|elif|if|while|until|time)/y];
const WS = /\s/;

/** Drop leading keywords/braces/negation and trailing closing braces (index based, linear time). */
function clean(seg) {
  const s = String(seg);
  let start = 0;
  let end = s.length;
  const trim = () => {
    while (start < end && WS.test(s[start])) start++;
    while (end > start && WS.test(s[end - 1])) end--;
  };
  trim();
  for (;;) {
    const was = [start, end];
    for (const re of NOISE_WORDS) {
      re.lastIndex = start;
      const m = re.exec(s);
      const p = m ? start + m[0].length : -1;
      // a noise word must be followed by whitespace or end the segment
      if (m && (p === end || (p < end && WS.test(s[p])))) {
        start = p;
        break;
      }
    }
    trim();
    if (end - start >= 3 && s[end - 1] === '}' && WS.test(s[end - 2])) {
      end--;
      trim();
    }
    if (start === was[0] && end === was[1]) return s.slice(start, end);
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

const PS_ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };
const ANSI_ESCAPES = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/** Decode one bash $'...' escape starting at s[i] === '\\'; returns [text, lastIndexConsumed]. */
function ansiEscape(s, i) {
  const n = s[i + 1];
  if (n === undefined) return ['\\', i];
  if (n in ANSI_ESCAPES) return [ANSI_ESCAPES[n], i + 1];
  const tail = s.slice(i + 2);
  let m;
  if (n === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(tail))) return [String.fromCharCode(parseInt(m[0], 16)), i + 1 + m[0].length];
  if (n === 'u' && (m = /^[0-9a-fA-F]{1,4}/.exec(tail))) return [String.fromCodePoint(parseInt(m[0], 16)), i + 1 + m[0].length];
  if (n === 'U' && (m = /^[0-9a-fA-F]{1,8}/.exec(tail))) {
    const cp = parseInt(m[0], 16);
    return [cp <= 0x10ffff ? String.fromCodePoint(cp) : '', i + 1 + m[0].length];
  }
  if ((m = /^[0-7]{1,3}/.exec(s.slice(i + 1)))) return [String.fromCharCode(parseInt(m[0], 8) & 0xff), i + m[0].length];
  if (n === 'c' && s[i + 2] !== undefined) return [String.fromCharCode(s.charCodeAt(i + 2) & 0x1f), i + 2];
  return [`\\${n}`, i + 1];
}

/**
 * Shell-style tokenisation honouring quotes; quotes are dropped.
 * Modes: 'default' (backslash only escapes quotes and spaces, so Windows paths survive),
 * 'bash' (an unquoted backslash escapes any character), 'ps' (backslash is literal,
 * a backtick escapes the next character). All modes but 'ps' decode $'...'.
 * @param {string} segment
 * @param {'default'|'bash'|'ps'} [mode]
 * @returns {{toks: string[], raws: string[]}} tokens and their raw source text
 */
export function tokenize(segment, mode = 'default') {
  const s = String(segment ?? '');
  const toks = [];
  const raws = [];
  let cur = '';
  let has = false;
  let q = null;
  let start = -1;
  const push = (end) => {
    if (has || cur) {
      toks.push(cur);
      raws.push(s.slice(start, end));
    }
    cur = '';
    has = false;
    start = -1;
  };
  const ps = mode === 'ps';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (start === -1 && !/\s/.test(c)) start = i;
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
      continue;
    }
    if (q === 'ansi') {
      if (c === "'") q = null;
      else if (c === '\\') {
        const [text, last] = ansiEscape(s, i);
        cur += text;
        i = last;
      } else cur += c;
      continue;
    }
    if (q === '"') {
      if (ps && c === '`' && i + 1 < s.length) {
        cur += PS_ESCAPES[s[i + 1]] ?? s[i + 1];
        i++;
      } else if (!ps && c === '\\' && '"\\$`'.includes(s[i + 1] ?? '\0')) {
        cur += s[i + 1];
        i++;
      } else if (c === '"') q = null;
      else cur += c;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      // keep a command substitution in one word, as the shell does
      let depth = 0;
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) break;
      }
      cur += s.slice(i, j + 1);
      i = j;
      has = true;
    } else if (!ps && c === '`') {
      const end = s.indexOf('`', i + 1);
      const stop = end === -1 ? s.length - 1 : end;
      cur += s.slice(i, stop + 1);
      i = stop;
      has = true;
    } else if (!ps && c === '$' && s[i + 1] === "'") {
      q = 'ansi';
      has = true;
      i++;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === '\\' && mode === 'bash' && i + 1 < s.length) {
      if (s[i + 1] !== '\n') cur += s[i + 1];
      i++;
      has = true;
    } else if (c === '\\' && mode === 'default' && (s[i + 1] === '"' || s[i + 1] === "'" || s[i + 1] === ' ')) {
      cur += s[i + 1];
      i++;
      has = true;
    } else if (ps && c === '`' && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      cur += PS_ESCAPES[s[i + 1]] ?? s[i + 1];
      i++;
      has = true;
    } else if (/\s/.test(c)) {
      push(i);
    } else {
      cur += c;
    }
  }
  push(s.length);
  return { toks, raws };
}

/** Shell-style tokenisation honouring quotes; quotes are dropped. See tokenize for the modes. */
export function tokens(segment, mode = 'default') {
  return tokenize(segment, mode).toks;
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
    if ((c === '$' || (c === '@' && !q)) && s[i + 1] === '(') {
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

/** Lower-case command name without directory and Windows extension (`C:\x\Git.EXE` -> `git`). */
export function baseName(tok) {
  return String(tok ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/**
 * Skip past the wrapper at t[i] (see WRAPPERS) with its own flags, flag values, leading
 * positionals and NAME=value words. onValue(flag, value) sees every flag value, onAssign(word)
 * every NAME=value word. Returns the index of the wrapped command (t.length when none).
 */
export function skipWrapperArgs(t, i, { onValue, onAssign } = {}) {
  const spec = WRAPPERS[baseName(t[i])] ?? {};
  const values = spec.v ?? [];
  let pos = spec.pos ?? 0;
  let k = i + 1;
  while (k < t.length) {
    const a = t[k];
    if (a === '--') return k + 1;
    if (a.length > 1 && a.startsWith('-')) {
      let flag = a;
      let value;
      const eq = a.indexOf('=');
      if (a.startsWith('--') && eq !== -1) {
        flag = a.slice(0, eq);
        value = a.slice(eq + 1);
      } else if (values.includes(a)) {
        value = t[k + 1];
        k++;
      } else if (!a.startsWith('--') && a.length > 2 && values.includes(a.slice(0, 2))) {
        flag = a.slice(0, 2);
        value = a.slice(2);
      }
      if (value !== undefined) onValue?.(flag, value);
      k++;
      continue;
    }
    if (ASSIGN.test(a)) {
      onAssign?.(a);
      k++;
      continue;
    }
    if (pos > 0) {
      pos--;
      k++;
      continue;
    }
    break;
  }
  return k;
}

const isPsCommandFlag = (a) => /^-(c|com|comm|comma|comman|command)$/i.test(a);
const isPsEncodedFlag = (a) =>
  /^-ec$/i.test(a) || (/^-e/i.test(a) && 'encodedcommand'.startsWith(a.slice(1).toLowerCase()));

/** Value of `-f value`, `--flag value` or `--flag=value` for any of names; undefined when absent. */
export function flagValue(args, names) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    for (const n of names) {
      if (a === n && k + 1 < args.length) return args[k + 1];
      if (n.startsWith('--') && a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
}

/** PowerShell named parameter (case-insensitive, `-Name value` or `-Name:value`). */
function psParam(args, names) {
  for (let k = 0; k < args.length; k++) {
    const m = /^-([A-Za-z]+)(?::(.*))?$/.exec(args[k]);
    if (!m || !names.includes(m[1].toLowerCase())) continue;
    if (m[2] !== undefined) return { value: m[2], at: k, len: 1 };
    if (k + 1 < args.length) return { value: args[k + 1], at: k, len: 2 };
  }
  return null;
}

// --- terminal launchers: the command they open is re-parsed like a nested shell ---

const SAFE_WORD = /^[\w@%+=:,./\\-]+$/;
/** Re-join argv into text that tokenises back to the same words. */
function quoteJoin(argv) {
  return argv.map((a) => (SAFE_WORD.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`)).join(' ');
}
const OPAQUE_BODY = { opaque: true };
const hasExpansion = (s) => /[$`]/.test(s);


/** The raw text after the first word of a segment (leading NAME=value pairs removed). */
function rawAfterCommand(segment) {
  const rest = stripAssignments(segment).rest;
  let i = 0;
  while (i < rest.length && /\s/.test(rest[i])) i++;
  const [, next] = readWord(rest, i, false);
  return rest.slice(next);
}

/**
 * PowerShell-style words: quotes ('' and "" with backtick escapes), @( ... ) arrays and comma lists are one word with several
 * items. Each word: { items, quoted (starts with a quote), expansion (unquoted/double-quoted $ or subexpression) }.
 */
function psWords(s) {
  const words = [];
  const n = s.length;
  let i = 0;
  const ws = (c) => /\s/.test(c);
  while (i < n) {
    while (i < n && ws(s[i])) i++;
    if (i >= n) break;
    const w = { items: [], quoted: s[i] === "'" || s[i] === '"', expansion: false };
    let cur = '';
    let has = false;
    let afterComma = false;
    const push = () => { if (has) w.items.push(cur); cur = ''; has = false; };
    while (i < n) {
      const c = s[i];
      if (ws(c)) {
        let j = i;
        while (j < n && ws(s[j])) j++;
        if (afterComma || s[j] === ',') { i = j; continue; }
        break;
      }
      if (c === ',') { push(); afterComma = true; i++; continue; }
      afterComma = false;
      if (c === "'") {
        has = true;
        i++;
        while (i < n) {
          if (s[i] === "'") { if (s[i + 1] === "'") { cur += "'"; i += 2; continue; } break; }
          cur += s[i++];
        }
        i++;
      } else if (c === '"') {
        has = true;
        i++;
        while (i < n && s[i] !== '"') {
          if (s[i] === '`' && i + 1 < n) { cur += s[i + 1]; i += 2; continue; }
          if (s[i] === '$' && /[A-Za-z_{(]/.test(s[i + 1] ?? '')) w.expansion = true;
          cur += s[i++];
        }
        i++;
      } else if (c === '(' || ((c === '@' || c === '$') && s[i + 1] === '(')) {
        let depth = 0;
        let q = null;
        const open = c === '(' ? i : i + 1;
        let j = open;
        for (; j < n; j++) {
          const d = s[j];
          if (q) { if (d === q) q = null; continue; }
          if (d === "'" || d === '"') q = d;
          else if (d === '(') depth++;
          else if (d === ')' && --depth === 0) break;
        }
        if (c !== '$') {
          // @( ... ) and plain ( ... ) groups: only quoted literals and commas; a bare word is a command, so anything else is opaque
          push();
          const body = s.slice(open + 1, j);
          const inner = psWords(body);
          for (const x of inner) w.items.push(...x.items);
          if (inner.some((x) => x.expansion) || body.replace(/'(?:[^']|'')*'|"(?:[^"`]|`.)*"/g, '').replace(/[\s,]/g, '') !== '') w.expansion = true;
        } else { w.expansion = true; has = true; cur += s.slice(i, j + 1); }
        i = j + 1;
      } else {
        if (c === '$' && /[A-Za-z_{]/.test(s[i + 1] ?? '')) w.expansion = true;
        if (c === '`') w.expansion = true;
        has = true;
        cur += c;
        i++;
      }
    }
    push();
    words.push(w);
  }
  return words;
}

const PS_START_VALUE = new Set(['filepath', 'file', 'path', 'argumentlist', 'args', 'arguments', 'workingdirectory', 'wd', 'verb', 'windowstyle', 'redirectstandardinput', 'redirectstandardoutput', 'redirectstandarderror', 'credential']);
const PS_START_SWITCH = new Set(['-wait', '-nonewwindow', '-passthru', '-usenewenvironment', '-loadenvironment']);
const CMD_START_VALUE = new Set(['/d', '/affinity', '/node']);
const CMD_START_SWITCH = new Set(['/min', '/max', '/wait', '/b', '/i', '/low', '/normal', '/high', '/realtime', '/abovenormal', '/belownormal', '/separate', '/shared']);

/** cmd `start` and PowerShell Start-Process / saps / start. text is the raw text after the command word. */
function startBodies(name, text) {
  const out = [];
  const ws = psWords(text);
  const named = {};
  const used = new Set();
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k];
    if (w.quoted || !w.items.length) continue;
    const m = /^-([A-Za-z]+)(?::(.*))?$/s.exec(w.items[0]);
    if (!m || !PS_START_VALUE.has(m[1].toLowerCase())) continue;
    if (m[2] === undefined && w.items.length !== 1) continue;
    const key = m[1].toLowerCase();
    used.add(k);
    // -Name:value, where the value may itself be a comma list
    if (m[2] !== undefined) named[key] = { items: [m[2], ...w.items.slice(1)].filter((x, n) => n > 0 || x !== '' || w.items.length === 1), expansion: w.expansion };
    else if (k + 1 < ws.length) { named[key] = ws[k + 1]; used.add(k + 1); }
  }
  const pick = (...ns) => ns.map((x) => named[x]).find((v) => v !== undefined);
  const wdW = pick('workingdirectory', 'wd');
  const wd = wdW ? wdW.items[0] : undefined;
  const fileW = pick('filepath', 'file', 'path');
  const listW = pick('argumentlist', 'args', 'arguments');
  const free = ws.filter((_, k) => !used.has(k));
  const mk = (text2) => (wd !== undefined ? { text: text2, chdir: wd } : { text: text2 });

  const run = (words, skipTitle, titleAfter = false) => {
    let k = skipTitle ? 1 : 0;
    // switches before the program: PowerShell -Wait ..., cmd /min, /D <dir>, /NODE <n>, /AFFINITY <hex>
    for (; k < words.length; k++) {
      const x = words[k];
      const v = x.items.length === 1 && !x.quoted ? x.items[0].toLowerCase() : '';
      if (PS_START_SWITCH.has(v) || CMD_START_SWITCH.has(v)) continue;
      if (CMD_START_VALUE.has(v)) { k++; continue; }
      break;
    }
    // cmd is picky about order, but a title after the switches is cheap to check as well
    if (titleAfter && k < words.length) {
      k++;
      for (; k < words.length; k++) {
        const x = words[k];
        const v = x.items.length === 1 && !x.quoted ? x.items[0].toLowerCase() : '';
        if (PS_START_SWITCH.has(v) || CMD_START_SWITCH.has(v)) continue;
        if (CMD_START_VALUE.has(v)) { k++; continue; }
        break;
      }
    }
    let exeW;
    let rest;
    if (fileW) { exeW = fileW; rest = words.slice(k); } else { exeW = words[k]; rest = words.slice(k + 1); }
    if (!exeW || exeW.items.length === 0) return;
    // the argument list: -ArgumentList, else PowerShell's second positional, else cmd's trailing words
    let argv;
    let raw = false;
    let expansion = exeW.expansion;
    if (listW) { argv = listW.items; raw = true; expansion ||= listW.expansion; }
    else if (name !== 'start' && rest.length) { argv = rest[0].items; raw = true; expansion ||= rest.some((x) => x.expansion); }
    else if (rest.length === 1 && rest[0].items.length > 1) { argv = rest[0].items; raw = true; expansion ||= rest[0].expansion; }
    else { argv = rest.flatMap((x) => x.items); expansion ||= rest.some((x) => x.expansion); }
    if (expansion) { out.push(OPAQUE_BODY); return; }
    const prog = exeW.items[0];
    // a lone PowerShell string such as 'push origin main' is a whole argument line; array items are joined by spaces
    out.push(mk(raw ? [quoteJoin([prog]), ...argv].join(' ') : quoteJoin([prog, ...argv])));
  };

  if (name === 'start') {
    // cmd takes a first quoted word as the window title; PowerShell takes it as the program: check both readings
    if (free.length > 1 || (free.length && free[0].quoted)) run(free, true);
    if (free.length > 2) run(free, false, true);
    run(free, false);
  } else run(free, false);
  return out;
}

const WT_VALUE = new Set(['-w', '--window', '-d', '--startingdirectory', '--title', '-p', '--profile', '--tabcolor', '--colorscheme', '--size', '--pos', '-H', '-V', '-s', '--size']);
const WT_VALUE_LOW = new Set([...WT_VALUE].map((x) => x.toLowerCase()));
const WT_SUBS = new Set(['new-tab', 'nt', 'split-pane', 'sp', 'new-window', 'nw']);

/** Windows Terminal: `wt [-w 0] nt [-d dir] [--title t] <command...> [; nt ...]`. */
function wtBodies(args) {
  const out = [];
  const chunks = [[]];
  for (const a of args) {
    if (a === ';' || a === '\\;') { chunks.push([]); continue; }
    if (!/(?<!\\);/.test(a)) { chunks.at(-1).push(a); continue; }
    // wt splits its own command line on every unescaped ';', also one inside an argument ('nt;nt', 'echo hi;nt'); the
    // pieces are command-line text that the opened program splits into words again
    a.split(/(?<!\\);/).forEach((piece, n) => {
      if (n > 0) chunks.push([]);
      chunks.at(-1).push(...piece.split(/\s+/).filter(Boolean));
    });
  }
  for (const c of chunks) {
    let k = 0;
    while (k < c.length) {
      const a = c[k];
      const low = a.toLowerCase();
      if (a === '--') { k++; break; }
      if (WT_SUBS.has(low)) { k++; continue; }
      if (WT_VALUE_LOW.has(low)) { k += 2; continue; }
      if (/^--?[A-Za-z]/.test(a)) { k++; continue; }
      break;
    }
    const argv = c.slice(k);
    if (!argv.length) continue;
    if (argv.some(hasExpansion)) { out.push(OPAQUE_BODY); continue; }
    out.push({ text: quoteJoin(argv) });
  }
  return out;
}

/** Quote every unescaped ';' outside quotes as its own word, so re-splitting the text keeps it for wt. */
function protectSemicolons(s) {
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; out += c; continue; }
    if (c === "'" || c === '"') q = c;
    if (c === ';' && s[i - 1] !== '\\') out += " ';' ";
    else out += c;
  }
  return out;
}

/**
 * wt commands anywhere in a cmd body: cmd runs each command between &, &&, ||, |, and parentheses (^ escapes), after an
 * optional @ and `start ["title"] [/switches]`. Each one starting with wt comes back as `wt ...` with its ';' kept for wt.
 */
function cmdWtBodies(body) {
  const parts = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') q = !q;
    if (!q && c === '^' && i + 1 < body.length) { cur += body[++i]; continue; }
    if (!q && '&|()'.includes(c)) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  const out = [];
  const isWt = (w) => baseName(w.replace(/"/g, '')) === 'wt';
  for (const part of parts) {
    let p = part.replace(/^[\s@]+/, '');
    let [w, next] = readWord(p, 0, true);
    if (/^"?start"?$/i.test(w)) {
      p = p.slice(next);
      for (;;) {
        p = p.trimStart();
        [w, next] = readWord(p, 0, true);
        if (!w || isWt(w)) break;
        const low = w.toLowerCase();
        if (w.startsWith('"') || CMD_START_SWITCH.has(low)) { p = p.slice(next); continue; }
        if (CMD_START_VALUE.has(low)) { p = p.slice(next).trimStart(); p = p.slice(readWord(p, 0, true)[1]); continue; }
        break;
      }
    }
    if (!w || !isWt(w)) continue;
    const rest = p.slice(next);
    if (rest.includes(';')) out.push(`wt ${protectSemicolons(rest)}`);
  }
  return out;
}

const TERMINAL_EMULATORS = new Set(['x-terminal-emulator', 'xterm', 'konsole', 'gnome-terminal', 'mate-terminal', 'xfce4-terminal', 'terminator', 'tilix', 'lxterminal', 'urxvt', 'rxvt', 'alacritty', 'kitty', 'foot']);

/** Linux terminals: the command follows -e / -x / --. */
const KITTY_BOOL = new Set(['--hold', '--single-instance', '-1', '--detach', '--detached', '--wait-for-single-instance-window-close', '--debug-config']);
const KITTY_VALUE = new Set(['--class', '--name', '--title', '-T', '--directory', '-d', '--config', '-c', '--override', '-o', '--session', '--listen-on', '--start-as', '--os-window-state', '--instance-group', '--watcher']);
const FOOT_BOOL = new Set(['-H', '--hold', '-L', '--login-shell', '-m', '--maximized', '-F', '--fullscreen', '-S', '--server']);
const FOOT_VALUE = new Set(['-t', '--title', '-a', '--app-id', '-w', '--window-size-pixels', '-W', '--window-size-chars', '-c', '--config', '-f', '--font', '-o', '--override', '-D', '--working-directory', '-T', '-s']);

const NO_RUN = new Set(['--version', '-v', '--help', '-h']);

/** kitty and foot take the command directly after their own options; an option we do not know makes it opaque. */
function optionedTerminalBody(args, bools, values) {
  let k = 0;
  while (k < args.length) {
    const a = args[k];
    if (a === '--') { k++; break; }
    if (!a.startsWith('-')) break;
    const flag = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (NO_RUN.has(flag)) return []; // prints version or help, runs nothing
    if (bools.has(flag)) k++;
    else if (values.has(flag)) k += a.includes('=') ? 1 : 2;
    else return [OPAQUE_BODY];
  }
  if (args[0] === '@') return [OPAQUE_BODY];
  return terminalTail(args.slice(k));
}

function terminalBodies(name, args) {
  if (name === 'kitty') return optionedTerminalBody(args, KITTY_BOOL, KITTY_VALUE);
  if (name === 'foot') return optionedTerminalBody(args, FOOT_BOOL, FOOT_VALUE);
  let k = args.findIndex((a) => a === '-e' || a === '-x' || a === '--' || a === '--command' || a === '--exec' || a.startsWith('--command=') || a.startsWith('--exec='));
  if (k === -1) return [];
  const a = args[k];
  if (a.includes('=')) return terminalTail([a.slice(a.indexOf('=') + 1)]);
  return terminalTail(args.slice(k + 1));
}

function terminalTail(argv) {
  if (!argv.length) return [];
  if (argv.some(hasExpansion)) return [OPAQUE_BODY];
  // a single word with spaces is a whole command line (gnome-terminal -e "git push origin main")
  return [{ text: argv.length === 1 ? argv[0] : quoteJoin(argv) }];
}

// words a prefix wrapper (nohup, sudo, env ...) may stop at: nested shells are in SHELL_LIKE, these open another window
const LAUNCHERS = new Set([...TERMINAL_EMULATORS, 'wt', 'osascript']);

/** osascript: pull `do script "..."` bodies out of the AppleScript; any other script is opaque. */
function osascriptBodies(args) {
  const out = [];
  let any = false;
  for (let k = 0; k < args.length; k++) {
    if (args[k] !== '-e' || k + 1 >= args.length) continue;
    any = true;
    const script = args[++k];
    const re = /do script\s+"((?:[^"\\]|\\.)*)"/gi;
    let m;
    let found = false;
    while ((m = re.exec(script))) {
      found = true;
      out.push({ text: m[1].replace(/\\(["\\])/g, '$1') });
    }
    if (!found) out.push(OPAQUE_BODY);
  }
  if (!any && args.length) out.push(OPAQUE_BODY);
  return out;
}

/** Bodies that other command carriers run (PowerShell, git submodule foreach, find -exec, runners). */
function carrierBodies(toks, i, segment) {
  const out = [];
  const name = baseName(toks[i]);
  const args = toks.slice(i + 1);
  // git submodule foreach <cmd>: runs in every submodule, so the directory is unknown.
  const g = toks.findIndex((t) => baseName(t) === 'git');
  if (g !== -1 && toks.indexOf('submodule', g) !== -1) {
    const f = toks.indexOf('foreach', g);
    if (f !== -1) {
      let j = f + 1;
      while (j < toks.length && /^(--recursive|-q|--quiet)$/.test(toks[j])) j++;
      const body = toks.slice(j).join(' ');
      if (body) out.push({ text: body, cwdUnknown: true });
    }
  }
  // find ... -exec cmd {} ;
  if (toks.some((t) => baseName(t) === 'find')) {
    for (let k = 0; k < toks.length; k++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(toks[k])) continue;
      let j = k + 1;
      const body = [];
      while (j < toks.length && !/^(\\?;|\+)$/.test(toks[j])) body.push(toks[j++]);
      if (body.length) out.push({ text: body.join(' '), cwdUnknown: true });
      k = j;
    }
  }
  if (name === 'iex' || name === 'invoke-expression') {
    const p = psParam(args, ['command']);
    const body = p ? p.value : args.join(' ');
    if (body) out.push({ text: body, ps: true });
  } else if (name === 'start-process' || name === 'saps' || name === 'start') {
    out.push(...startBodies(name, rawAfterCommand(segment)));
  } else if (name === 'wt') {
    out.push(...wtBodies(args));
  } else if (TERMINAL_EMULATORS.has(name)) {
    out.push(...terminalBodies(name, args));
  } else if (name === 'osascript') {
    out.push(...osascriptBodies(args));
  } else if (name === 'invoke-command' || name === 'icm') {
    const a = segment.indexOf('{');
    const b = segment.lastIndexOf('}');
    if (a !== -1) out.push({ text: segment.slice(a + 1, b > a ? b : segment.length), ps: true });
  } else if (name === 'cross-env-shell') {
    const body = args.filter((x) => !ASSIGN.test(x)).join(' ');
    if (body) out.push({ text: body });
  } else if (['npx', 'npm', 'pnpm', 'yarn', 'bunx', 'pnpx'].includes(name)) {
    const v = flagValue(args, ['-c', '--call']);
    if (v) out.push({ text: v });
  } else if (name === 'doppler' || name === 'infisical') {
    const v = flagValue(args, ['--command']);
    if (v) out.push({ text: v });
  } else if (name === 'sops' && args[0] === 'exec-env' && args[2]) {
    out.push({ text: args[2] });
  } else if (name === 'su' || name === 'runuser' || name === 'script') {
    const v = flagValue(args, ['-c', '--command']);
    if (v) out.push({ text: v });
  } else if (name === 'env') {
    const v = flagValue(args, ['-S', '--split-string']);
    if (v) out.push({ text: v });
  } else if (name === 'flock') {
    const v = flagValue(args, ['-c', '--command']);
    if (v) out.push({ text: v });
  } else if (name === 'watch') {
    let j = 0;
    while (j < args.length && args[j].startsWith('-')) j += /^(-n|--interval)$/.test(args[j]) ? 2 : 1;
    const body = args.slice(j).join(' ');
    if (body) out.push({ text: body });
  }
  return out;
}

/** Inspect a nested-shell invocation: { bodies: {text, chdir?, cwdUnknown?}[], opaque: boolean }. */
function wrapperInfo(segment) {
  const toks = tokens(stripAssignments(segment).rest);
  let i = 0;
  while (i < toks.length && ASSIGN.test(toks[i])) i++;
  if (i >= toks.length) return { bodies: [], opaque: false };
  const carried = carrierBodies(toks, i, segment);
  // ps: whether the own bodies are PowerShell code (undefined: same language as the segment)
  const done = (bodies, opaque, evalOpaque = false, ps = undefined) => ({
    bodies: [...carried.filter((c) => c.text !== undefined), ...bodies.map((text) => ({ text, ps }))],
    opaque: opaque || carried.some((c) => c.opaque),
    evalOpaque,
  });
  if (isWrapper(baseName(toks[i]))) {
    // Skip the prefix together with its flags and values, up to the next shell-like token.
    let k = i + 1;
    while (k < toks.length && !SHELL_LIKE.has(baseName(toks[k])) && !LAUNCHERS.has(baseName(toks[k]))) k++;
    if (k >= toks.length) return done([], false);
    i = k;
    if (LAUNCHERS.has(baseName(toks[k]))) carried.push(...carrierBodies(toks, k, segment));
  }
  const name = baseName(toks[i]);
  const args = toks.slice(i + 1);
  const afterFlag = (k) => {
    let j = k + 1;
    while (j < args.length && args[j] === '--') j++;
    return j < args.length ? j : -1;
  };
  if (name === 'eval') {
    // eval of command output is opaque, except well-known environment setup tools
    const generated = substitutions(args.join(' ')).some((b) => !EVAL_SAFE.has(baseName(tokens(b)[0])));
    return done(args.length ? [args.join(' ')] : [], false, generated, false);
  }
  if (POSIX_SHELLS.has(name)) {
    const k = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    if (k !== -1) {
      const j = afterFlag(k);
      return done(j === -1 ? [] : [args[j]], false, false, false);
    }
    // No -c: reads stdin unless it is given a script file.
    const found = [];
    const hs = args.indexOf('<<<');
    if (hs !== -1 && hs + 1 < args.length) found.push(args[hs + 1]);
    const positional = args.filter((a) => !a.startsWith('-'));
    const redirected = args.some((a) => a.startsWith('<'));
    return done(found, positional.length === 0 || redirected, false, false);
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
      return done(decoded ? [decoded] : [], false, false, true);
    }
    const k = args.findIndex(isPsCommandFlag);
    if (k !== -1 && k + 1 < args.length) return done([args.slice(k + 1).join(' ')], false, false, true);
    const hasWork = args.some((a) => !a.startsWith('-')) && args.every((a) => a !== '-');
    return done([], !hasWork || args.includes('-'));
  }
  if (name === 'cmd') {
    const k = args.findIndex((a) => /^\/[ck]/i.test(a));
    if (k === -1) return done([], false);
    const first = args[k].slice(2); // e.g. /c"git push" tokenises to "/cgit push"
    const body = [first, ...args.slice(k + 1)].filter((x) => x !== '').join(' ');
    // cmd has no ';' separator, but wt does: every wt command in the body is also checked with its ';' kept for wt.
    // The body itself keeps every ';' where it is, so a nested shell body is still split by the checks that follow.
    return done(body ? [body, ...cmdWtBodies(body)] : [], false, false, false);
  }
  return done([], false);
}

/** Return [segment, ...inner] where inner are nested-shell and substitution bodies (one level). */
export function unwrap(segment) {
  const seg = String(segment ?? '');
  if (seg.startsWith(OPAQUE_PREFIX)) return [seg];
  const info = wrapperInfo(seg);
  const bodies = [...info.bodies.map((b) => b.text), ...substitutions(seg)];
  const out = [seg, ...bodies.flatMap((b) => segments(b))];
  if (info.opaque) out.push(OPAQUE_STDIN);
  if (info.evalOpaque) out.push(OPAQUE_EVAL);
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
  if (frontier.some((s) => unwrap(s).length > 1)) seen.add(OPAQUE_DEEP);
  return [...seen];
}

// ---------- stateful expansion ----------

const DYNAMIC = /[`$%]/;
const isAbsDir = (p) => /^(\/|~(\/|\\|$)|[A-Za-z]:([\\/]|$)|\\\\)/.test(p);

function normDir(p) {
  const s = p.replace(/\\/g, '/');
  const abs = s.startsWith('/');
  const parts = [];
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue;
    const last = parts[parts.length - 1];
    if (part === '..' && last !== undefined && last !== '..' && !/^([A-Za-z]:|~)$/.test(last)) parts.pop();
    else if (part === '..' && abs && !parts.length) continue;
    else parts.push(part);
  }
  const body = parts.join('/');
  if (abs) return `/${body}`;
  if (/^[A-Za-z]:$/.test(body)) return `${body}/`;
  return body || '.';
}

/** Join a `cd` target onto a tracked cwd ('.' = the starting directory, null = unknown). */
function joinCwd(prev, target) {
  const t = String(target ?? '');
  if (t === '' || DYNAMIC.test(t)) return null;
  if (isAbsDir(t)) return normDir(t);
  if (prev === null) return null;
  return normDir(prev === '.' ? t : `${prev}/${t}`);
}

const CD_NAMES = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const POP_NAMES = new Set(['popd', 'pop-location']);
const DECLARE = new Set(['export', 'declare', 'typeset', 'readonly', 'local', 'set']);
const CD_WORD = /\b(cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)\b/i;

/**
 * State after running one segment: tracks cd/pushd/Set-Location and variable assignments.
 * States are immutable: a segment that changes nothing returns the same state object, and the
 * env map is copied only when a variable changes. `id` names the env map in dedup keys.
 */
function nextState(seg, st, w) {
  const { assignments, rest } = stripAssignments(seg);
  let envs = st.envs;
  const changes = [];
  let { cwd } = st;
  const own = () => {
    if (envs === st.envs) envs = { ...st.envs };
  };
  const setKV = (kv) => {
    const k = kv.indexOf('=');
    const key = kv.slice(0, k);
    const value = kv.slice(k + 1);
    if (Object.hasOwn(envs, key) && envs[key] === value) return;
    own();
    envs[key] = value;
    changes.push(kv);
  };
  const done = () => {
    if (envs === st.envs) return cwd === st.cwd ? st : { cwd, envs, id: st.id };
    if (Object.keys(envs).length > w.maxVars) throw w.over(`more than ${w.maxVars} tracked variables`);
    return { cwd, envs: Object.freeze(envs), id: w.intern(`${st.id}\0${changes.join('\0')}`) };
  };
  if (!rest) {
    for (const a of assignments) setKV(a);
    return done();
  }
  const psVar = /^\$([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(rest);
  if (psVar && !/^env$/i.test(psVar[1])) {
    setKV(`${psVar[1]}=${tokens(psVar[2])[0] ?? ''}`);
    return done();
  }
  const t = tokens(rest);
  let i = 0;
  while (i < t.length && (baseName(t[i]) === 'builtin' || baseName(t[i]) === 'command')) i++;
  const name = baseName(t[i]);
  const args = t.slice(i + 1);
  if (DECLARE.has(name)) {
    for (const a of args) if (ASSIGN.test(a)) setKV(a);
  } else if (name === 'unset') {
    for (const a of args) {
      if (a.startsWith('-') || !Object.hasOwn(envs, a)) continue;
      own();
      delete envs[a];
      changes.push(`-${a}`);
    }
  } else if (CD_NAMES.has(name)) {
    const p = psParam(args, ['path', 'literalpath']);
    const target = p ? p.value : args.find((a) => a === '-' || !/^-[A-Za-z]+$/.test(a));
    if (target === undefined) {
      if (name === 'cd' || name === 'chdir') cwd = '~';
      else if (name === 'pushd') cwd = null;
    } else if (target === '-') cwd = null;
    else cwd = joinCwd(cwd, target);
  } else if (POP_NAMES.has(name)) {
    cwd = null;
  } else if (['eval', 'iex', 'invoke-expression', 'source', '.'].includes(name) && CD_WORD.test(rest)) {
    cwd = null;
  }
  return done();
}

/**
 * Like expand, but every segment carries the state that earlier segments of the same
 * command set up: `cwd` (relative to the starting directory, '.' when unchanged, absolute
 * after an absolute cd, '~'-prefixed after `cd ~`, null when unknown, for example after
 * `cd -`, `popd` or `cd $X`) and `envs` (variables assigned by `export X=`, `X=...;`,
 * `$env:X=`, `set X=` and PowerShell `$x =`). Parenthesised subshells restore the state.
 * With `budget` ({maxSegments, maxVars}) the walk stops once a limit is passed and the
 * returned array carries `overBudget` (a short reason).
 * The `envs` objects are frozen and shared between segments; copy before changing them.
 * @param {string} command
 * @param {{maxSegments?: number, maxVars?: number}} [budget]
 * @returns {Array<{segment: string, cwd: string | null, envs: Readonly<Record<string, string>>}> & {overBudget?: string}}
 */
export function expandWithState(command, budget = {}, { ps = false } = {}) {
  const out = [];
  const seen = new Set();
  const ids = new Map();
  const maxSegments = budget.maxSegments ?? Infinity;
  const OVER = Symbol('over');
  let overReason = null;
  const w = {
    maxVars: budget.maxVars ?? Infinity,
    // equal derivations (same parent state, same changes) share an id, so both scan passes dedup
    intern: (k) => {
      let id = ids.get(k);
      if (id === undefined) ids.set(k, (id = ids.size + 1));
      return id;
    },
    over: (why) => {
      overReason = why;
      return OVER;
    },
    emit: (segment, st) => {
      const key = `${segment}\0${st.cwd}\0${st.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (out.length >= maxSegments) throw w.over(`more than ${maxSegments} segments`);
      out.push({ segment, cwd: st.cwd, envs: st.envs });
      return true;
    },
  };
  try {
    walk(String(command ?? ''), { cwd: '.', envs: Object.freeze({}), id: 0 }, 0, w, ps);
  } catch (err) {
    if (err !== OVER) throw err;
    out.overBudget = overReason;
  }
  return out;
}

function walk(text, state0, depth, w, ps = false) {
  const { emit } = w;
  const passes = [scan(text, false, true, ps)];
  if (text.includes('\\')) passes.push(scan(text, true, true, ps));
  for (const items of passes) {
    let st = state0;
    const stack = [];
    for (const it of items) {
      if (it === OPEN) {
        stack.push(st);
        continue;
      }
      if (it === CLOSE) {
        if (stack.length) st = stack.pop();
        continue;
      }
      // PowerShell: `$p = git push`, `[void](...)`, `. git push` run the command after the lead-in
      const raw = clean(it);
      const seg = ps ? psLead(raw) : raw;
      if (!seg) continue;
      if (emit(seg, st) && !seg.startsWith(OPAQUE_PREFIX)) {
        const info = wrapperInfo(seg);
        const bodies = [...info.bodies, ...substitutions(seg).map((b) => ({ text: b }))];
        if (bodies.length && depth >= MAX_ROUNDS) emit(OPAQUE_DEEP, st);
        else {
          for (const b of bodies) {
            const cwd = b.cwdUnknown ? null : b.chdir !== undefined ? joinCwd(st.cwd, b.chdir) : st.cwd;
            walk(b.text, cwd === st.cwd ? st : { cwd, envs: st.envs, id: st.id }, depth + 1, w, b.ps ?? ps);
          }
        }
        if (info.opaque) emit(OPAQUE_STDIN, st);
        if (info.evalOpaque) emit(OPAQUE_EVAL, st);
      }
      // the lead-in may itself set a variable ($b = 'main'); the command after it may change directory
      st = nextState(raw, st, w);
      if (seg !== raw) st = nextState(seg, st, w);
    }
  }
}
