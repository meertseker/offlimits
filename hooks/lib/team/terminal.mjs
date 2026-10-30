// Cross-platform terminal opener for team sessions. Node built-ins only.
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const ID = /^[A-Za-z0-9][\w.-]*$/;
// prompt allowlist: letters, digits, space and . , :  / - _ ( )
const PROMPT = /^[\p{L}\p{N} .,:\\/_()-]*$/u;

function ident(v) {
  const s = String(v ?? '');
  if (!ID.test(s)) throw new Error('unsafe value');
  return s;
}

function promptText(v) {
  const s = String(v ?? '');
  if (!PROMPT.test(s)) throw new Error('unsafe value');
  return s;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions'];

/** `--permission-mode <m>` for a non-default mode, else nothing. */
export function permissionArgs(mode) {
  if (mode == null || mode === 'default') return [];
  if (!PERMISSION_MODES.includes(mode)) throw new Error('unsafe value');
  return ['--permission-mode', mode];
}

export function sessionCommand({ shell, role, lane, model, name, prompt, roleEnv = 'OFFLIMITS_ROLE', permissionMode }) {
  if (shell !== 'pwsh' && shell !== 'sh') throw new Error('unsafe value');
  if (!ENV_NAME.test(String(roleEnv))) throw new Error('unsafe value');
  const r = ident(role);
  const m = ident(model);
  const n = ident(name);
  const p = promptText(prompt);
  const l = lane == null || lane === '' ? null : ident(lane);
  const pm = permissionArgs(permissionMode).map((a) => ` ${a}`).join('');
  const tail = `claude --model ${m} -n ${n}${pm} '${p}'`;
  if (shell === 'pwsh') {
    const env = [`$env:${roleEnv}='${r}'`];
    if (l !== null) env.push(`$env:OFFLIMITS_LANE='${l}'`);
    return `${env.join('; ')}; ${tail}`;
  }
  const env = [`${roleEnv}=${r}`];
  if (l !== null) env.push(`OFFLIMITS_LANE=${l}`);
  return `${env.join(' ')} ${tail}`;
}

/** The line a new terminal runs to start the coordinator: `node '<bin>' coordinator`. */
export function teamCommand({ shell, bin, args }) {
  if (shell !== 'pwsh' && shell !== 'sh') throw new Error('unsafe value');
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== 'coordinator') throw new Error('unsafe value');
  return `node '${promptText(bin)}' coordinator`;
}

export function launchSpec({ platform, dir, title, command, has }) {
  if (platform === 'win32') {
    const sh = has('pwsh') ? 'pwsh' : 'powershell';
    if (has('wt')) {
      if (/[;\r\n]/.test(dir) || /[;\r\n]/.test(title)) throw new Error('unsafe value');
      // wt treats an unescaped ';' as a command separator
      const cmd = command.replace(/;/g, '\\;');
      return { file: 'wt', args: ['-w', '0', 'nt', '-d', dir, '--title', title, sh, '-NoExit', '-Command', cmd], options: {} };
    }
    // cmd /c start: build the quoted command line ourselves (verbatim)
    const BAD = /["%&|^<>\r\n]/;
    if (BAD.test(dir) || BAD.test(title) || BAD.test(command)) throw new Error('unsafe value');
    return {
      file: 'cmd',
      args: ['/c', 'start', `"${title}"`, '/D', `"${dir}"`, sh, '-NoExit', '-Command', `"${command}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  if (platform === 'darwin') {
    if (/["\\]/.test(dir) || /["\\]/.test(command)) return null;
    if (/['\r\n]/.test(dir)) return null;
    const script = `tell application "Terminal" to do script "cd '${dir}' && ${command}"`;
    return { file: 'osascript', args: ['-e', script], options: {} };
  }
  if (platform === 'linux') {
    if (dir.includes("'")) return null;
    const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole'].find((t) => has(t));
    if (!term) return null;
    const script = `cd '${dir}' && ${command}; exec bash`;
    const flag = term === 'gnome-terminal' ? ['--'] : ['-e'];
    return { file: term, args: [...flag, 'bash', '-lc', script], options: {} };
  }
  return null;
}

export function openTerminal(spec, spawnFn = spawn, env) {
  const opts = { ...(spec.options || {}), detached: true, stdio: 'ignore' };
  if (env) opts.env = env;
  if (process.platform === 'win32') opts.windowsHide = true;
  const child = spawnFn(spec.file, spec.args, opts);
  if (child && typeof child.on === 'function') {
    child.on('error', (e) => process.stderr.write(`offlimits: could not open terminal: ${e.message}\n`));
  }
  if (child && typeof child.unref === 'function') child.unref();
}

export function hasBin(bin) {
  const win = process.platform === 'win32';
  const r = win
    ? spawnSync('where', [bin], { stdio: 'ignore' })
    : spawnSync('sh', ['-c', 'command -v "$1"', 'sh', bin], { stdio: 'ignore' });
  return r.status === 0;
}

const CLAUDE_ARG = /^[A-Za-z0-9][\w.-]*$/;
const CLAUDE_FLAGS = ['--model', '-n', '--continue', '--permission-mode'];

function whereClaude() {
  try {
    return execFileSync('where', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * How to run `claude <args>` in the foreground without a shell string built from user input.
 * Windows: resolve with `where`, run a .exe directly, or a .cmd/.bat through cmd.exe with re-validated args.
 * @returns {{file: string, args: string[], options: object}}
 */
export function claudeInvocation(args, { platform = process.platform, where = whereClaude } = {}) {
  if (platform !== 'win32') return { file: 'claude', args, options: {} };
  for (const a of args) if (!CLAUDE_FLAGS.includes(a) && !CLAUDE_ARG.test(a)) throw new Error('unsafe value');
  const found = where('claude');
  // First PATH entry that can run wins; only skip entries that are not .exe/.cmd/.bat.
  const hit = found.find((p) => /\.(exe|cmd|bat)$/i.test(p));
  if (!hit) throw new Error('claude not found on PATH');
  if (/\.exe$/i.test(hit)) return { file: hit, args, options: {} };
  const shim = hit;
  if (/["%&|^<>\r\n]/.test(shim)) throw new Error('unsafe value');
  // /s strips the outer quotes, leaving: "<shim>" args
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `""${shim}" ${args.join(' ')}"`],
    options: { windowsVerbatimArguments: true },
  };
}
