// Cross-platform terminal opener for team sessions. Node built-ins only.
import { spawn, spawnSync } from 'node:child_process';

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

export function sessionCommand({ shell, role, lane, model, name, prompt }) {
  if (shell !== 'pwsh' && shell !== 'sh') throw new Error('unsafe value');
  const r = ident(role);
  const m = ident(model);
  const n = ident(name);
  const p = promptText(prompt);
  const l = lane == null || lane === '' ? null : ident(lane);
  const tail = `claude --model ${m} -n ${n} '${p}'`;
  if (shell === 'pwsh') {
    const env = [`$env:OFFLIMITS_ROLE='${r}'`];
    if (l !== null) env.push(`$env:OFFLIMITS_LANE='${l}'`);
    return `${env.join('; ')}; ${tail}`;
  }
  const env = [`OFFLIMITS_ROLE=${r}`];
  if (l !== null) env.push(`OFFLIMITS_LANE=${l}`);
  return `${env.join(' ')} ${tail}`;
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

export function openTerminal(spec, spawnFn = spawn) {
  const opts = { ...(spec.options || {}), detached: true, stdio: 'ignore' };
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
