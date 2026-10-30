// offlimits team CLI: the glue over config, state, lanes, terminal and init. Node built-ins only.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commonRoot, repoRoot } from '../git.mjs';
import { loadPolicy } from '../policy.mjs';
import { loadTeam } from './config.mjs';
import { guard } from './guard.mjs';
import { runInit } from './init.mjs';
import { LANE_RE, addLane, assertLane, lanePath, laneStatus, pruneLane, removeLane, resolveBase } from './lanes.mjs';
import { STAGES, ensureTeamDir, readBoard, reserve, updateLane, withLock, writeBoard } from './state.mjs';
import { claudeInvocation, hasBin, launchSpec, openTerminal, permissionArgs, sessionCommand } from './terminal.mjs';

const BIN = fileURLToPath(new URL('../../../bin/team.mjs', import.meta.url));
const VALUE_FLAGS = ['brief', 'model', 'base', 'lane', 'note', 'file', 'language'];
const BOOL_FLAGS = ['night', 'print', 'resume', 'takeover', 'json', 'abandon', 'yes'];
const COMMANDS = ['init', 'coordinator', 'worker', 'board', 'stage', 'deliver', 'ask', 'reserve', 'done'];
const ID = /^[A-Za-z0-9][\w.-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const USAGE = `offlimits team <command>

  init [--language xx]                            make this repo a team repo
  coordinator [--resume] [--takeover] [--print]   start the coordinator session
  worker <lane> --brief <file> [--model m] [--night] [--base ref] [--print]
  board [--json]                                  lanes, stages, divergence
  stage <stage> [--lane x] [--note t]             move a lane to a stage
  deliver --file <md>                             hand over this lane's delivery
  ask "<question>"                                queue a question for the human
  reserve <key>                                   take the next reserved number
  done <lane> [--abandon]                         remove a merged (or abandoned) lane
  help`;

class Exit extends Error {
  constructor(code, message) {
    super(message || '');
    this.code = code;
  }
}

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') flags.help = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      if (VALUE_FLAGS.includes(k)) {
        if (i + 1 >= argv.length) throw new Exit(2, `offlimits team: --${k} needs a value`);
        flags[k] = argv[++i];
      } else if (BOOL_FLAGS.includes(k) || k === 'help') flags[k] = true;
      else throw new Exit(2, `offlimits team: unknown option --${k}`);
    } else pos.push(a);
  }
  return { flags, pos };
}

function defaultSpawnSession(file, args, { cwd, env }) {
  const inv = claudeInvocation(args);
  const r = spawnSync(inv.file, inv.args, { ...inv.options, cwd, env, stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

const sameDir = (a, b) => {
  try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return path.resolve(a) === path.resolve(b); }
};

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const isLive = (l) => Boolean(l) && l.stage !== 'merged' && l.stage !== 'abandoned';

/** Strip the OFFLIMITS_* assignments so nothing an agent could copy is printed. */
function stripEnv(cmd) {
  return cmd.replace(/^(?:\$env:\w+='[^']*'; )+/, '').replace(/^(?:\w+=\S+ )+/, '');
}

function ageText(s) {
  if (s == null) return '-';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 172800) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * @param {string[]} argv
 * @param {{env?: object, cwd?: string, stdout?: {write: Function}, stderr?: {write: Function},
 *   spawnSession?: Function, openTerminal?: Function, has?: Function, now?: () => number, platform?: string}} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const spawnSession = deps.spawnSession ?? defaultSpawnSession;
  const open = deps.openTerminal ?? openTerminal;
  const has = deps.has ?? hasBin;
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const out = (s = '') => stdout.write(`${s}\n`);
  const err = (s) => stderr.write(`${s}\n`);
  const stamp = () => new Date(now()).toISOString();

  try {
    return await run();
  } catch (e) {
    if (e instanceof Exit) {
      if (e.message) err(e.message);
      return e.code;
    }
    err(`offlimits team: ${e && e.message ? e.message : e}`);
    return 1;
  }

  async function run() {
    const { flags, pos } = parseArgs(argv);
    const cmd = pos.shift();
    if (!cmd || cmd === 'help' || flags.help) {
      out(USAGE);
      return 0;
    }
    if (!COMMANDS.includes(cmd)) throw new Exit(2, `offlimits team: unknown command "${cmd}"\n${USAGE}`);

    const rawRoot = commonRoot(cwd);
    if (!rawRoot) throw new Exit(2, 'offlimits team: not inside a git repository');
    // Long canonical form: an 8.3 short path (C:\Users\RUNNER~1\...) would put '~' into the worker prompt.
    let mainRoot = rawRoot;
    try { mainRoot = fs.realpathSync.native(rawRoot); } catch { /* keep git's form */ }
    const { policy } = loadPolicy(mainRoot);
    const refusal = guard(cmd, env, policy.roleEnv);
    if (refusal) throw new Exit(3, refusal);
    const role = String(env[policy.roleEnv] || '').toLowerCase();

    const { team, problems } = loadTeam(mainRoot);
    const fatal = problems.some((p) => p.includes('"team" must be an object'));
    if (cmd !== 'init') for (const p of problems) err(`offlimits team: ${p}${fatal ? '' : ' (using default)'}`);
    if (fatal && (cmd === 'worker' || cmd === 'coordinator')) throw new Exit(2, 'offlimits team: fix offlimits.json before starting sessions');

    const ctx = { flags, pos, mainRoot, team, dir: path.join(mainRoot, '.offlimits', 'team'), role, roleEnv: policy.roleEnv };
    switch (cmd) {
      case 'init': return cmdInit(ctx);
      case 'coordinator': return cmdCoordinator(ctx);
      case 'worker': return cmdWorker(ctx);
      case 'board': return cmdBoard(ctx);
      case 'stage': return cmdStage(ctx);
      case 'deliver': return cmdDeliver(ctx);
      case 'ask': return cmdAsk(ctx);
      case 'reserve': return cmdReserve(ctx);
      default: return cmdDone(ctx);
    }
  }

  /** The caller's lane: OFFLIMITS_LANE, or --lane for the coordinator / a human terminal. */
  function callerLane({ flags, role }) {
    const named = flags.lane && (role === 'coordinator' || !env.CLAUDECODE) ? flags.lane : null;
    const lane = named || env.OFFLIMITS_LANE;
    if (!lane) throw new Exit(2, 'offlimits team: no lane (OFFLIMITS_LANE is not set; the coordinator can pass --lane)');
    if (!LANE_RE.test(lane)) throw new Exit(2, `offlimits team: invalid lane name "${lane}"`);
    return lane;
  }

  function cmdInit({ flags, mainRoot }) {
    const { changed, notes } = runInit(mainRoot, { language: flags.language });
    out(changed.length ? `changed: ${changed.join(', ')}` : 'nothing to change');
    for (const n of notes) out(`note: ${n}`);
    out('Add this line to your shell profile to get a `team` command:');
    out(platform === 'win32' ? `function team { node "${BIN}" @args }` : `team() { node "${BIN}" "$@"; }`);
    return 0;
  }

  function cmdWorker({ flags, pos, mainRoot, team, dir, roleEnv }) {
    const lane = pos[0];
    if (!lane || !LANE_RE.test(lane)) throw new Exit(2, `offlimits team: lane name must match ${LANE_RE}`);
    if (!flags.brief) throw new Exit(2, 'offlimits team: worker needs --brief <file>');
    let brief;
    try { brief = fs.readFileSync(path.resolve(cwd, flags.brief), 'utf8'); } catch (e) {
      throw new Exit(2, `offlimits team: cannot read brief ${flags.brief} (${e.code || e.message})`);
    }
    // Validate everything a terminal command needs before git or the board change.
    const model = flags.model || team.models.worker;
    if (!ID.test(model)) throw new Exit(1, `offlimits team: ${flags.model ? '--model' : 'team.models.worker'} must match ${ID.source} (got "${model}")`);
    if (!ENV_NAME.test(roleEnv)) throw new Exit(1, `offlimits team: offlimits.json roleEnv must match ${ENV_NAME.source}`);
    const worktree = lanePath(mainRoot, team, lane);
    const briefPath = path.join(dir, 'briefs', `${lane}.md`);
    const hint = `cd "${worktree}"`;
    let command;
    let spec = null;
    try {
      command = sessionCommand({
        shell: platform === 'win32' ? 'pwsh' : 'sh', role: 'worker', lane, model, name: lane, roleEnv, permissionMode: team.permissionMode,
        prompt: `You are worker ${lane}. Read ${briefPath} and follow it.`,
      });
      spec = launchSpec({ platform, dir: worktree, title: lane, command, has });
    } catch (e) {
      if (!e || e.message !== 'unsafe value') throw e;
      throw new Exit(1, `offlimits team: the brief path contains characters a terminal command cannot carry safely: ${briefPath}; move the repo to a path without ~ + & ' or similar characters`);
    }

    // Reserve the slot under the lock, run the slow git work outside it, then finalise under the lock.
    const claimedAt = stamp();
    withLock(dir, () => {
      ensureTeamDir(dir);
      const board = readBoard(dir);
      if (isLive(board.lanes[lane])) throw new Exit(2, `offlimits team: lane "${lane}" is already live`);
      if (Object.values(board.lanes).filter(isLive).length >= team.maxWorkers) {
        throw new Exit(2, `offlimits team: maxWorkers (${team.maxWorkers}) reached; finish or remove a lane first`);
      }
      board.lanes[lane] = { stage: 'briefed', note: 'creating', model, createdAt: claimedAt, updatedAt: claimedAt };
      writeBoard(dir, board);
    });
    let made = null;
    try {
      made = (deps.addLane ?? addLane)(mainRoot, team, lane, { base: flags.base || resolveBase(mainRoot, team.base) });
      let startSha = null;
      try {
        startSha = execFileSync('git', ['rev-parse', made.branch], { cwd: mainRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
      } catch { /* recorded as null */ }
      fs.writeFileSync(briefPath, (flags.night ? 'mode: night\n\n' : '') + brief);
      updateLane(dir, lane, { branch: made.branch, worktree: made.worktree, base: made.base, startSha, brief: briefPath, note: undefined });
    } catch (e) {
      let extra = '';
      if (made) {
        try { removeLane(mainRoot, { branch: made.branch, worktree: made.worktree }, { force: true }); } catch (r) {
          extra = ` (could not remove worktree ${made.worktree}: ${r.message})`;
        }
      }
      try {
        withLock(dir, () => {
          const board = readBoard(dir);
          delete board.lanes[lane];
          writeBoard(dir, board);
        });
      } catch {
        err(`offlimits team: lane ${lane} is stuck in "creating"; run: team done ${lane} --abandon`);
      }
      if (extra) err(`offlimits team:${extra}`);
      throw e;
    }
    out(`lane ${lane}: ${made.branch} in ${made.worktree} (stage briefed, model ${model})`);
    if (flags.print || team.terminal === 'none' || !spec) {
      out(hint);
      out(env.CLAUDECODE ? `${stripEnv(command)}  (role is set by the launcher)` : command);
      return 0;
    }
    const clean = { ...env };
    // The worker is a fresh Claude session: drop our role and the coordinator's Claude session variables.
    for (const k of [roleEnv, 'OFFLIMITS_ROLE', 'OFFLIMITS_LANE', 'OFFLIMITS_TEAM_LAUNCHER_PID', 'CLAUDECODE', 'CLAUDE_PID', 'AI_AGENT']) delete clean[k];
    for (const k of Object.keys(clean)) if (k.startsWith('CLAUDE_CODE_')) delete clean[k];
    open(spec, undefined, clean);
    out(`opened a terminal for ${lane}`);
    return 0;
  }

  function cmdCoordinator({ flags, mainRoot, team, dir, roleEnv }) {
    const top = repoRoot(cwd);
    if (!top || !sameDir(top, mainRoot)) {
      throw new Exit(2, `offlimits team: run the coordinator from the main checkout (${mainRoot}), not a worktree`);
    }
    const model = team.models.coordinator;
    if (!ID.test(model)) throw new Exit(1, 'offlimits team: cannot build a safe command (unsafe value); fix team.models.coordinator');
    const args = ['--model', model, '-n', 'coordinator', ...permissionArgs(team.permissionMode), ...(flags.resume ? ['--continue'] : [])];
    if (flags.print) {
      out(`cd "${mainRoot}"`);
      out(`claude ${args.join(' ')}  (role is set by the launcher)`);
      return 0;
    }
    ensureTeamDir(dir);
    const lock = path.join(dir, 'coordinator.json');
    withLock(dir, () => {
      const held = readJson(lock);
      if (held && isAlive(held.pid) && !flags.takeover) {
        throw new Exit(4, `offlimits team: a coordinator is already running (pid ${held.pid}); use --takeover to replace it`);
      }
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: stamp() }, null, 2) + '\n');
    });
    const childEnv = { ...env, [roleEnv]: 'coordinator', OFFLIMITS_TEAM_LAUNCHER_PID: String(process.pid) };
    delete childEnv.OFFLIMITS_LANE;
    try {
      const code = spawnSession('claude', args, { cwd: mainRoot, env: childEnv });
      return typeof code === 'number' ? code : 0;
    } finally {
      const cur = readJson(lock);
      if (cur && cur.pid === process.pid) fs.rmSync(lock, { force: true });
    }
  }

  function cmdBoard({ flags, mainRoot, team, dir }) {
    const lanes = readBoard(dir).lanes;
    const names = Object.keys(lanes).sort();
    if (!names.length) {
      out(flags.json ? '[]' : 'no lanes yet');
      return 0;
    }
    let base = null;
    try { base = resolveBase(mainRoot, team.base); } catch { /* no base: no divergence */ }
    const rows = names.map((name) => {
      const l = lanes[name];
      let st = null;
      try { if (base) st = laneStatus(mainRoot, l, base); } catch { /* record without git data */ }
      let questions = 0;
      try {
        questions = fs.readFileSync(path.join(dir, 'questions', `${name}.md`), 'utf8').split(/\r?\n/).filter((x) => x.startsWith('- ')).length;
      } catch { /* none */ }
      return {
        lane: name,
        stage: l.stage,
        ahead: st ? st.ahead : null,
        behind: st ? st.behind : null,
        dirty: st ? st.dirty : null,
        lastCommitAge: st ? st.lastCommitAge : null,
        delivery: fs.existsSync(path.join(dir, 'deliveries', `${name}.md`)),
        questions,
        worktreeMissing: isLive(l) && typeof l.worktree === 'string' ? !fs.existsSync(l.worktree) : null,
      };
    });
    if (flags.json) {
      out(JSON.stringify(rows, null, 2));
      return 0;
    }
    const table = [
      ['lane', 'stage', 'ahead/behind', 'dirty', 'last-commit', 'delivery', 'questions', 'worktree-missing'],
      ...rows.map((r) => [
        r.lane, String(r.stage), r.ahead == null ? '-' : `${r.ahead}/${r.behind}`, r.dirty == null ? '-' : r.dirty ? 'dirty' : 'clean',
        ageText(r.lastCommitAge), r.delivery ? 'yes' : 'no', String(r.questions), r.worktreeMissing == null ? '-' : r.worktreeMissing ? 'yes' : 'no',
      ]),
    ];
    const w = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
    for (const row of table) out(row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(w[i]))).join('  '));
    return 0;
  }

  function cmdStage(ctx) {
    const stage = ctx.pos[0];
    if (!STAGES.includes(stage)) throw new Exit(2, `offlimits team: stage must be one of ${STAGES.join(', ')}`);
    const lane = callerLane(ctx);
    ensureTeamDir(ctx.dir);
    updateLane(ctx.dir, lane, ctx.flags.note ? { stage, note: ctx.flags.note } : { stage });
    out(`lane ${lane}: ${stage}`);
    return 0;
  }

  function cmdDeliver(ctx) {
    if (!ctx.flags.file) throw new Exit(2, 'offlimits team: deliver needs --file <md>');
    const lane = callerLane(ctx);
    let text;
    try { text = fs.readFileSync(path.resolve(cwd, ctx.flags.file), 'utf8'); } catch (e) {
      throw new Exit(2, `offlimits team: cannot read ${ctx.flags.file} (${e.code || e.message})`);
    }
    ensureTeamDir(ctx.dir);
    fs.writeFileSync(path.join(ctx.dir, 'deliveries', `${lane}.md`), text);
    updateLane(ctx.dir, lane, { stage: 'delivered' });
    out(`lane ${lane}: delivered`);
    return 0;
  }

  function cmdAsk(ctx) {
    const q = ctx.pos.join(' ').replace(/\s+/g, ' ').trim();
    if (!q) throw new Exit(2, 'offlimits team: ask needs a question');
    const lane = callerLane(ctx);
    ensureTeamDir(ctx.dir);
    fs.appendFileSync(path.join(ctx.dir, 'questions', `${lane}.md`), `- [${stamp()}] ${q}\n`);
    out(`question queued for ${lane}`);
    return 0;
  }

  function worktrees(mainRoot) {
    const roots = [mainRoot];
    try {
      const text = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: mainRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      for (const l of text.split(/\r?\n/)) if (l.startsWith('worktree ')) roots.push(l.slice(9));
    } catch { /* main checkout only */ }
    return [...new Set(roots.map((r) => path.resolve(r)))];
  }

  function cmdReserve(ctx) {
    const { pos, mainRoot, team, dir } = ctx;
    const key = pos[0];
    if (!key || !Object.hasOwn(team.reservations, key)) {
      throw new Exit(2, `offlimits team: no reservation "${key ?? ''}" in offlimits.json team.reservations`);
    }
    const { scan, pattern, width } = team.reservations[key];
    const re = new RegExp(pattern);
    let floor = 0;
    for (const root of worktrees(mainRoot)) {
      const target = path.resolve(root, scan);
      if (target !== root && !target.startsWith(root + path.sep)) continue;
      let names = [];
      try { names = fs.readdirSync(target); } catch { continue; }
      for (const n of names) {
        const m = re.exec(n);
        const v = m ? Number.parseInt(m[1], 10) : NaN;
        if (Number.isFinite(v) && v > floor) floor = v;
      }
    }
    let lane = '';
    try { lane = callerLane(ctx); } catch { /* reserving without a lane is fine */ }
    ensureTeamDir(dir);
    out(reserve(dir, key, { floor, width, lane }));
    return 0;
  }

  function isWorktree(mainRoot, dir) {
    const norm = (p) => (platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    return worktrees(mainRoot).map(norm).includes(norm(dir));
  }

  function branchTip(mainRoot, branch) {
    try {
      return execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: mainRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || null;
    } catch { return null; }
  }

  /** git refuses to remove a worktree a running session still holds open (Windows): say what to do instead of git's error. */
  function removeOrExplain(lane, fn, worktree) {
    try { fn(); } catch (e) {
      if (fs.existsSync(worktree)) throw new Exit(1, `offlimits team: could not remove ${worktree}; close the worker session in ${lane} first, then re-run team done ${lane}`);
      throw e;
    }
  }

  function undoLine(branch, tip) {
    return tip ? `undo with: git branch ${branch} ${tip}` : null;
  }

  /** Abandon a lane whose board record never got a branch/worktree: clean up what git knows by the lane's own names. */
  function abandonPartial(lane, { mainRoot, team, dir }) {
    const rec = { branch: `feat/${lane}`, worktree: lanePath(mainRoot, team, lane) };
    const tip = branchTip(mainRoot, rec.branch);
    if (isWorktree(mainRoot, rec.worktree)) {
      removeOrExplain(lane, () => execFileSync('git', ['worktree', 'remove', '--force', '--', rec.worktree], { cwd: mainRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }), rec.worktree);
    } else if (fs.existsSync(rec.worktree)) {
      err(`offlimits team: ${rec.worktree} exists but git does not know it as a worktree; left in place`);
    }
    pruneLane(mainRoot, rec);
    updateLane(dir, lane, { stage: 'abandoned', note: undefined });
    out(`lane ${lane}: abandoned (record had no branch or worktree; removed what git knew)`);
    const undo = undoLine(rec.branch, tip);
    if (undo) out(undo);
    return 0;
  }

  function cmdDone({ flags, pos, mainRoot, team, dir }) {
    const lane = pos[0];
    if (!lane || !LANE_RE.test(lane)) throw new Exit(2, `offlimits team: lane name must match ${LANE_RE}`);
    const rec = readBoard(dir).lanes[lane];
    if (!rec) throw new Exit(2, `offlimits team: unknown lane "${lane}"`);
    try {
      assertLane(mainRoot, rec);
    } catch (e) {
      // A launcher killed mid-git leaves {stage: briefed, note: creating} without branch/worktree.
      if (!flags.abandon) throw e;
      return abandonPartial(lane, { mainRoot, team, dir });
    }
    const tip = branchTip(mainRoot, rec.branch);
    if (!flags.abandon) {
      const st = laneStatus(mainRoot, rec, rec.base ?? resolveBase(mainRoot, team.base));
      if (st.dirty) throw new Exit(1, `offlimits team: lane ${lane} has uncommitted changes; commit or use --abandon`);
      if (rec.startSha && tip === rec.startSha) throw new Exit(1, `offlimits team: lane ${lane} has no commits; use --abandon to drop it`);
      if (!st.merged) throw new Exit(1, `offlimits team: lane ${lane} is not merged into the base; merge it, or use --abandon to discard it`);
    }
    if (isWorktree(mainRoot, rec.worktree)) removeOrExplain(lane, () => (deps.removeLane ?? removeLane)(mainRoot, rec, { force: true }), rec.worktree);
    else {
      // Folder deleted by hand, or left behind (empty) by a remove that failed half-way: prune git's record.
      pruneLane(mainRoot, rec);
      try { fs.rmdirSync(rec.worktree); } catch { /* gone, or not empty: left in place */ }
      if (fs.existsSync(rec.worktree)) err(`offlimits team: ${rec.worktree} is no longer a git worktree but still has files; left in place`);
    }
    const stage = flags.abandon ? 'abandoned' : 'merged';
    updateLane(dir, lane, { stage });
    out(`lane ${lane}: ${stage}, worktree and branch removed`);
    if (flags.abandon) {
      const undo = undoLine(rec.branch, tip);
      if (undo) out(`branch ${rec.branch} was at ${tip}; ${undo}`);
    }
    return 0;
  }
}
