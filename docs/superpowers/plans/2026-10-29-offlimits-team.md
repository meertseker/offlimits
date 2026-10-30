# offlimits team mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn offlimits into a tool that sets up a coordinator/worker software team in any repository: `init`, a launcher that opens worker sessions in their own worktrees, a shared board, a session banner and two skills, all sitting on top of the existing gate.

**Architecture:** A zero-dependency Node CLI (`bin/team.mjs`) over small modules in `hooks/lib/team/`. State is kept as files in `<main checkout>/.offlimits/team/`. The gate gains one rule (`team-launch`), and `session.mjs` gains team context. The ritual itself is written as two skills.

**Tech Stack:** Node ≥20 ESM, `node:test`, Node built-ins only. The plugin is the existing offlimits Claude Code plugin.

**Spec:** `docs/superpowers/specs/2026-10-29-offlimits-team-design.md`

## Global Constraints

- Zero dependencies: Node built-ins only. `package.json` gets no `dependencies`.
- Node ≥20, and it must work on Windows, macOS and Linux (CI matrix: ubuntu-24.04, windows-2025, macos-15 × Node 20, 22).
- Every child process is started with `execFileSync`/`spawn` argument arrays. Never use a shell string built from user input.
- Lane names must match `^[a-z0-9][a-z0-9-]{1,38}$`. Branch: `feat/<lane>`. Worktree: `<worktreeDir>/<repoBasename>-<lane>` (default `worktreeDir` is `..`, relative to the main checkout).
- State folder: `<commonRoot>/.offlimits/team/`, where `commonRoot` is the existing `hooks/lib/git.mjs#commonRoot`.
- The role comes from `OFFLIMITS_ROLE` only. The launcher sets it on the child process and never prints an assignment. `role-spoof` stays unchanged.
- No behaviour change for solo users of v0.2 except: `team` is now a known `offlimits.json` key, and the new `team-launch` rule.
- Commit messages carry no `Co-Authored-By` or other AI trailer lines (Mert's rule).
- Run `node --test` and `node hooks/selftest.mjs --all` before each commit that touches `hooks/`.

## Review Focus

1. **A repo with no `origin` remote.** The default base must fall back to local `main`/`master` instead of failing `git fetch`. Test it in Task 4.
2. **Paths with spaces** (for example `C:\Users\Mert Seker\Desktop\app`). Worktree creation and the terminal command must survive them. A path containing `'` must be refused with a clear message. Test it in Tasks 4 and 5.
3. **Two reservations at the same instant** (two workers asking for a migration number together) must get different numbers. Test it in Task 2 with two child processes.
4. **A stale lock file** left by a crashed process must not block forever (older than 10 s means stale). Test it in Task 2.
5. **`init` run twice, or on a repo that already has `offlimits.json` with production settings,** must keep the user's keys and add only `team`/`defaultRole` when they are missing. Test it in Task 6.

---

### Task 1: `team` config key and validator

**Files:**
- Modify: `hooks/lib/policy.mjs` (switch in `loadPolicy`; typedef)
- Create: `hooks/lib/team/config.mjs`
- Test: `tests/team-config.test.mjs`

**Interfaces:**
- Produces: `loadTeam(root: string|null, readFile?) => { team: Team, problems: string[], enabled: boolean }`. `enabled` is false when the file has no `team` key.
- `Team` = `{ language: string, models: {coordinator: string, worker: string}, maxWorkers: number, base: string|null, worktreeDir: string, checks: string[], deploy: {steps: string[], healthUrl: string|null}, rules: string[], reservations: Record<string,{scan: string, pattern: string, width: number}>, terminal: 'auto'|'none' }`
- Produces: `TEAM_DEFAULTS` (frozen) with language `'en'`, models `{coordinator:'opus', worker:'sonnet'}`, maxWorkers `4`, base `null` (null means auto: `origin/main`, then `origin/master`, then local `main`/`master`), worktreeDir `'..'`, checks `[]`, deploy `{steps:[], healthUrl:null}`, rules `[]`, reservations `{}`, terminal `'auto'`.

- [ ] **Step 1: Write the failing tests**
  - `policy accepts team key without problems`: `loadPolicy` on a temp dir with `{"team":{}}` returns `problems` equal to `[]`.
  - `policy still flags unknown keys`: `{"teamz":1}` gives a problem matching `/unknown key "teamz"/`.
  - `loadTeam defaults`: on `{}` it returns `enabled:false` and `team` deep-equal to `TEAM_DEFAULTS`.
  - `loadTeam merges and validates`: `{"team":{"maxWorkers":2,"checks":["npm test"],"models":{"worker":"haiku"}}}` gives `maxWorkers 2`, `models.coordinator 'opus'`, `models.worker 'haiku'`.
  - `loadTeam reports bad values and keeps defaults`: `maxWorkers: 0`, `checks: "x"`, `reservations.m.pattern: "("` and `terminal: "x"` each produce one problem, and the default stays.
  - `bad team block never changes gate policy`: with `{"defaultRole":"worker","team":5}`, `loadPolicy().policy.defaultRole === 'worker'` and `problems` is `[]` (team problems come only from `loadTeam`).
- [ ] **Step 2: Run** `node --test tests/team-config.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** In `loadPolicy` add `case 'team': break;`, since validation belongs to `loadTeam`. Write `loadTeam` with the same problem phrasing as policy (`offlimits.json: "team.<key>" must be …`). `maxWorkers` is an integer from 1 to 16. `reservations.*.width` is an integer from 1 to 12, default 4. The pattern must compile and have one capture group. Parse the JSON with the BOM stripped, like `loadPolicy`.
- [ ] **Step 4: Run** `node --test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(team): accept and validate the team block in offlimits.json`

### Task 2: Team state store (board, lock, reservations)

**Files:**
- Create: `hooks/lib/team/state.mjs`
- Test: `tests/team-state.test.mjs`

**Interfaces:**
- Consumes: `commonRoot(cwd)` from `hooks/lib/git.mjs`.
- Produces:
  - `teamDir(cwd: string) => string|null`, which is `<commonRoot>/.offlimits/team`.
  - `ensureTeamDir(dir) => void`, which creates `briefs/`, `deliveries/` and `questions/`.
  - `withLock(dir, fn, {timeoutMs=2000, staleMs=10000}) => T`. It is synchronous: exclusive-create `dir/lock` (`fs.openSync(p,'wx')`) and retry with a short busy-wait (`Atomics.wait` on a SharedArrayBuffer, 25 ms). A lock whose mtime is older than `staleMs` is removed. It throws `Error('team state is locked')` on timeout and always removes the lock afterwards.
  - `readBoard(dir) => {lanes: Record<string, Lane>}`, which returns `{lanes:{}}` when the file is missing or unreadable.
  - `writeBoard(dir, board)`, which writes `board.json.tmp` and then renames it.
  - `updateLane(dir, lane, patch) => Lane`. It runs under the lock, merges `patch`, and sets `updatedAt` (ISO) and `createdAt` on the first write.
  - `Lane` = `{branch, worktree, stage, model, mode: 'day'|'night', createdAt, updatedAt, note}`.
  - `STAGES = ['briefed','designing','awaiting-approval','building','delivered','merged','abandoned']`. `updateLane` throws on an unknown stage.
  - `reserve(dir, key, {floor=0, width=4, lane=''}) => string`. Under the lock, read `reservations.json` `{[key]: {last, history:[{value,lane,at}]}}`, take next = max(last, floor) + 1, write it, and return the value zero-padded to `width`.

- [ ] **Step 1: Write the failing tests** (each uses a temp dir):
  - `updateLane creates and merges`: create with stage `briefed`, then update the note. `createdAt` is unchanged and `updatedAt` is ≥ `createdAt`.
  - `updateLane rejects unknown stage`: an object with stage `'shipping'` throws `/unknown stage/`.
  - `writeBoard is atomic`: after a write there is no `board.json.tmp` left.
  - `stale lock is broken`: create `lock` with mtime 60 s in the past (`fs.utimesSync`). `withLock` runs `fn` within 500 ms.
  - `live lock times out`: a fresh `lock` and `timeoutMs: 100` throw `/locked/`.
  - `reserve pads and increments`: `reserve(d,'migration',{floor:12})` returns `'0013'`, and the next call returns `'0014'`.
  - `reserve is safe across processes`: spawn 2 `node -e` children that each call `reserve` 20 times on the same dir, then collect the output. That gives 40 distinct values, from `0001` to `0040`.
  - `teamDir from a worktree points to the main checkout`: init a temp repo, commit, `git worktree add ../x-lane`. `teamDir` from the worktree equals `teamDir` from main.
- [ ] **Step 2: Run** `node --test tests/team-state.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `state.mjs` as specified.
- [ ] **Step 4: Run** `node --test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(team): board, lock and reservations state store`

### Task 3: Launcher guard

**Files:**
- Create: `hooks/lib/team/guard.mjs`
- Test: `tests/team-guard.test.mjs`

**Interfaces:**
- Produces: `guard(cmd: string, env: NodeJS.ProcessEnv, roleEnv='OFFLIMITS_ROLE') => string|null`. It returns a refusal message, or null when allowed.
- Produces: `PRIVILEGED = ['coordinator','worker','done','init']` and `LANE_CMDS = ['stage','deliver','ask']`.

Rules:
- If `env.CLAUDECODE` is unset, the caller is a human, and everything returns null.
- Inside Claude, with the role from `env[roleEnv]` lowercased:
  - `coordinator` may do everything.
  - `worker` is refused for `PRIVILEGED`.
  - Unset or other values (solo) are allowed only for `init`, `board`, `reserve` and `ask`, and refused for `coordinator|worker|done`.
- The refusal text is `offlimits team: "<cmd>" is for the coordinator (or a human terminal). Hand over instead of working around this.`

- [ ] **Step 1: Write the failing tests**. These are table-driven over every `{CLAUDECODE unset|set} × role {coordinator, worker, unset} × cmd {init, coordinator, worker, done, board, stage, deliver, ask, reserve}`, with the expected allow/refuse per the rules above. Add one case for a custom `roleEnv`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(team): launcher guard by role`

### Task 4: Worktree and lane git operations

**Files:**
- Create: `hooks/lib/team/lanes.mjs`
- Test: `tests/team-lanes.test.mjs`

**Interfaces:**
- Consumes: `commonRoot` and `currentBranch` from `git.mjs`, `Team` from Task 1, and `updateLane` and `readBoard` from Task 2.
- Produces:
  - `LANE_RE = /^[a-z0-9][a-z0-9-]{1,38}$/`
  - `resolveBase(mainRoot, configured: string|null, exec?) => string`. If `configured` is set, return it after validating it against `/^[\w./-]+$/` (it must not start with `-`). Otherwise use the first of `origin/main`, `origin/master`, `main`, `master` that `git rev-parse --verify --quiet` accepts. Throw `no base branch found` otherwise.
  - `lanePath(mainRoot, team, lane) => string`, the absolute path `<resolve(mainRoot, worktreeDir)>/<basename(mainRoot)>-<lane>`. It throws if the path contains `'` or `"`.
  - `addLane(mainRoot, team, lane, {base}, exec?) => {branch, worktree, base}`. It validates the lane, runs `git fetch origin` only if an `origin` remote exists (ignoring a fetch failure with a warning on stderr), then `git worktree add -b feat/<lane> <path> <base>`.
  - `laneStatus(mainRoot, lane: Lane, base, exec?) => {exists, ahead, behind, dirty, lastCommitAge, merged}`, using `git rev-list --left-right --count base...branch`, `git -C wt status --porcelain`, `git log -1 --format=%ct` and `git merge-base --is-ancestor branch base`.
  - `removeLane(mainRoot, lane: Lane, {force}, exec?) => void`. It runs `git worktree remove <wt>` (adding `--force` when `force`), then `git branch -D feat/<lane>` when `force`, otherwise `-d`.

- [ ] **Step 1: Write the failing tests** with temp repos that have one commit on `main`:
  - `resolveBase with no remote falls back to local main`.
  - `resolveBase rejects "--upload-pack=x" and "a;b"`.
  - `addLane creates branch and worktree beside the repo`: the path is `<tmp>/<repo>-demo` and `git -C path branch --show-current` returns `feat/demo`.
  - `addLane works when the repo path has a space` (temp dir `my repo`).
  - `lanePath refuses a quote`: a `worktreeDir` containing `'` throws `/quote/`.
  - `addLane rejects bad lane "Demo_1"`.
  - `laneStatus reports ahead 1 and dirty after a commit plus an untracked file`.
  - `laneStatus merged true after fast-forward merge into main`.
  - `removeLane removes worktree and branch`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with `execFileSync('git', [...], {cwd, encoding:'utf8', stdio:['ignore','pipe','pipe']})`, injected as `exec`.
- [ ] **Step 4: Run** `node --test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(team): lane worktree operations`

### Task 5: Terminal opener

**Files:**
- Create: `hooks/lib/team/terminal.mjs`
- Test: `tests/team-terminal.test.mjs`

**Interfaces:**
- Produces: `sessionCommand({shell: 'pwsh'|'sh', role, lane, model, name, prompt}) => string`. This is the one-line command run inside the new terminal.
  - pwsh form: `$env:OFFLIMITS_ROLE='worker'; $env:OFFLIMITS_LANE='demo'; claude --model sonnet -n demo 'You are worker demo. Read C:\x\brief.md and follow it.'`
  - sh form: `OFFLIMITS_ROLE=worker OFFLIMITS_LANE=demo claude --model sonnet -n demo 'You are …'`
  - Every interpolated value must match `/^[^'"`$\r\n]*$/`, or it throws `unsafe value`. The model must match `/^[\w.-]+$/`. `lane` is omitted for the coordinator.
- Produces: `launchSpec({platform, dir, title, command, has: (bin)=>boolean}) => {file, args, options} | null`.
  - win32 with `wt`: `wt -w 0 nt -d <dir> --title <title> pwsh -NoExit -Command <command>`.
  - win32 without `wt`: `cmd /c start "<title>" /D <dir> pwsh -NoExit -Command <command>`. Use `powershell` when there is no `pwsh`, chosen by `has`.
  - darwin: `osascript -e 'tell application "Terminal" to do script "cd <dir> && <command>"'`. The `dir` must have no `"` or `\` (otherwise null).
  - linux: the first of `x-terminal-emulator`, `gnome-terminal`, `konsole` found by `has`, with `-e bash -lc "cd '<dir>' && <command>; exec bash"` (gnome uses `--`).
  - Returns null when nothing fits.
- Produces: `openTerminal(spec, spawnFn=spawn) => void`. It spawns detached with `stdio:'ignore'` and calls `unref()`.
- Produces: `hasBin(bin) => boolean`, using `where` on win32 and `command -v` via `sh -c` elsewhere. Use an argument array; the `bin` is a constant from this module only.

- [ ] **Step 1: Write the failing tests**:
  - The exact pwsh and sh strings shown above.
  - `sessionCommand` throws on a prompt containing `'`, `$` or a newline.
  - `launchSpec` per platform with a fake `has`: win32 with and without `wt`, darwin, linux with gnome only, and null on linux with none.
  - A dir with spaces survives on win32 (it is a separate arg after `-d`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(team): cross-platform terminal opener for sessions`

### Task 6: Templates and `init`

**Files:**
- Create: `templates/claude-block.md`, `templates/brief.md`, `templates/delivery.md`, `templates/pull_request_template.md`
- Create: `hooks/lib/team/init.mjs`
- Test: `tests/team-init.test.mjs`

**Interfaces:**
- Consumes: `loadTeam`, `ensureTeamDir` and `teamDir`.
- Produces: `runInit(root: string, {language?: string}) => {changed: string[], notes: string[]}`.
  - `offlimits.json`: if it is missing, write `{"defaultRole":"worker","team":{"language":<lang|'en'>}}`. If it exists and parses, add `defaultRole: "worker"` only when the key is absent, and `team: {language}` only when absent. Never change other keys, and keep 2-space formatting. If it exists and is invalid JSON, do not write it; add a note `offlimits.json is not valid JSON; fix it and run init again`.
  - `CLAUDE.md`: replace the text between `<!-- offlimits:team:start -->` and `<!-- offlimits:team:end -->`. If there are no markers, append the block. The block is rendered from `templates/claude-block.md` with `{{rules}}` (a bullet list of `team.rules`, or `- (none yet)`) and `{{checks}}`.
  - `.gitignore`: append `.offlimits/` if no line equals it.
  - `.github/pull_request_template.md`: copy the template only if the file is missing.
  - Run `ensureTeamDir(teamDir(root))`.
  - `changed` lists the relative paths that were written.
- Produces: `renderTemplate(name, vars: Record<string,string>) => string`, which replaces `{{key}}`. An unknown key is left as is.
- Template content:
  - `claude-block.md` (about 30 lines): roles (the coordinator starts with `team coordinator`; workers are opened by the coordinator), workflow (design → spec → plan → build with subagents and TDD → checks → deliver), "If the gate blocks you, hand over, do not work around it", "Never set OFFLIMITS_ROLE", "Keys live in .env.local, never in chat or commits", "No AI co-author trailer lines in commits", house rules `{{rules}}` and checks `{{checks}}`.
  - `brief.md` fields: `lane`, `mode (day|night)`, `approval (human|coordinator|none)`, `goal`, `context and files to read`, `acceptance`, `constraints and house rules`, `reservations needed`, `deliver to: coordinator`, and the night section "Never ask and never wait. Decide, log decisions in the delivery, put open questions with `team ask`".
  - `delivery.md` fields: `lane`, `branch @ sha`, `worktree`, `what changed`, `how verified (commands + results)`, `reservations used`, `env / config changes`, `risks / not done`, `decisions taken alone`, `needs the human`.

- [ ] **Step 1: Write the failing tests** with temp repos:
  - `init on an empty repo writes all files`: `changed` includes `offlimits.json`, `CLAUDE.md`, `.gitignore` and `.github/pull_request_template.md`, and `.offlimits/team/briefs` exists.
  - `init is idempotent`: the second run returns `changed: []` and the files are byte-identical.
  - `init keeps user keys`: an existing `{"production":{"mcpServers":["supabase"]},"defaultRole":"solo"}` keeps both after init and gains `team`.
  - `init keeps CLAUDE.md text outside markers`, and replaces the block content between the markers.
  - `init leaves invalid offlimits.json alone`: the file is unchanged and the note matches `/not valid JSON/`.
  - `rules render into the block`: `team.rules: ["Never touch staff text."]` appears as a bullet.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the templates and `init.mjs`.
- [ ] **Step 4: Run** `node --test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(team): init and templates`

### Task 7: CLI `bin/team.mjs`

**Files:**
- Create: `bin/team.mjs`, `hooks/lib/team/cli.mjs` (holds `main(argv, deps)` so it can be tested; `bin/team.mjs` only calls it)
- Modify: `package.json` (add `"bin": {"offlimits-team": "bin/team.mjs"}`)
- Modify: `scripts/worker.ps1`, `scripts/coordinator.ps1` (become thin wrappers: `node "$PSScriptRoot/../bin/team.mjs" worker <lane> …` and `… coordinator`), `tests/scripts.test.mjs` (update their assertions), `CLAUDE.md` (repo's own: the launcher lines)
- Test: `tests/team-cli.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: `main(argv: string[], deps = {env, cwd, stdout, stderr, spawnSession, openTerminal, has, now}) => number` (exit code). `deps.spawnSession(file, args, {cwd, env})` runs the coordinator in the foreground (default: `spawnSync` with `stdio:'inherit'`).
- Behaviour per the spec §5.4 table, plus:
  - Every command first runs `guard(cmd, env, policy.roleEnv)`. On refusal it prints to stderr and exits 3.
  - `worker <lane> --brief <file>` requires `--brief`. It refuses when live lanes (stage not `merged|abandoned`) ≥ `maxWorkers`. It reads the brief, prepends `mode: night` when `--night`, writes it to `briefs/<lane>.md`, and records the lane stage as `briefed` with the model (`--model` or `team.models.worker`). The prompt is `You are worker <lane>. Read <abs brief path> and follow it.` It builds `sessionCommand` + `launchSpec`. With `--print`, `team.terminal === 'none'` or a null spec, it prints the command and a cd hint and exits 0. Otherwise it calls `openTerminal`.
  - `coordinator [--resume] [--takeover] [--print]` refuses when cwd's repo root ≠ the main checkout (`commonRoot`). Read `coordinator.json`: if its pid is alive (`process.kill(pid,0)` succeeds) and `--takeover` is absent, exit 4 with `a coordinator is already running (pid N)`. Otherwise write `{pid: process.pid, startedAt}`, run `claude --model <models.coordinator> -n coordinator [--continue]` with `env` plus `OFFLIMITS_ROLE=coordinator`, and delete `coordinator.json` when it exits (only if it still holds our pid).
  - `board [--json]` prints one row per lane: `lane  stage  ahead/behind  dirty  last-commit  delivery  questions  worktree-missing`. With no lanes it prints `no lanes yet`.
  - `stage <stage> [--lane x] [--note t]`: the lane comes from `OFFLIMITS_LANE` unless the role is coordinator and `--lane` is given.
  - `deliver --file f`, `ask "<q>"`, `reserve <key>`: `reserve` computes `floor` by scanning `team.reservations[key].scan` in the main checkout and in every lane worktree. File names match `pattern` and the highest capture is taken as a number. An unknown key exits 2 with `no reservation "<key>" in offlimits.json team.reservations`.
  - `done <lane> [--abandon]` refuses when `laneStatus.merged` is false and `--abandon` is absent. It runs `removeLane` (force when `--abandon`) and sets the stage `merged`/`abandoned`.
  - `init [--language xx]` runs `runInit`, prints `changed` and `notes`, then prints the profile line. On win32 that is `function team { node "<abs bin/team.mjs>" @args }`; elsewhere it is `team() { node "<abs bin/team.mjs>" "$@"; }`.
  - `help` or no args prints usage. An unknown command exits 2.

- [ ] **Step 1: Write the failing tests** (a temp repo, `deps` with fake `openTerminal`/`spawnSession`, and `env` without `CLAUDECODE` unless stated):
  - `init then worker then board`: worker `demo --brief b.md --print` exits 0, the stdout contains `claude --model sonnet -n demo`, `briefs/demo.md` exists, and `board` lists `demo  briefed`.
  - `worker opens a terminal when not --print`: the fake `openTerminal` is called once and its spec args contain the worktree path.
  - `worker refused inside Claude for worker role`: `env {CLAUDECODE:'1', OFFLIMITS_ROLE:'worker'}` exits 3.
  - `maxWorkers enforced`: with `maxWorkers: 1`, a second live lane exits non-zero and stderr matches `/maxWorkers/`.
  - `night brief`: `--night` makes `briefs/x.md` start with `mode: night`.
  - `coordinator refuses second live coordinator`: write `coordinator.json` with `process.pid` (alive) and the exit code is 4; with `--takeover` it calls `spawnSession` with `claude` and `--model opus`, and `env.OFFLIMITS_ROLE === 'coordinator'`.
  - `coordinator removes its lock after exit`.
  - `reserve scans worktrees`: a lane worktree holding `migrations/0007_x.sql` and the main checkout holding `0005_y.sql` make `reserve migration` print `0008`.
  - `done refuses unmerged`, `done --abandon removes`.
  - `deliver sets delivered and stores file`, `ask appends`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `cli.mjs` and `bin/team.mjs` (shebang, `process.exit(await main(process.argv.slice(2)))`), and convert the ps1 wrappers.
- [ ] **Step 4: Run** `node --test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(team): team CLI (init, coordinator, worker, board, stage, deliver, ask, reserve, done)`

### Task 8: Gate rule `team-launch` and protected team files

**Files:**
- Modify: `hooks/lib/rules/shell-rules.mjs` (new rule added to `RULES` after `agent-spawn`), `hooks/lib/policy.mjs` (`DEFAULT_POLICY.protectedPaths` gains `.offlimits/team/board.json` and `.offlimits/team/coordinator.json`)
- Modify: `tests/fixtures/cases-shell.json`, `tests/fixtures/cases-mcp-file.json`, and the README rules table (the docs test checks every rule id is documented)
- Test: the existing `tests/gate.test.mjs` fixtures run, plus `node hooks/selftest.mjs --all`

**Interfaces:**
- The rule `teamLaunch(c)` matches a segment when either (a) `c.info.name` is `node` and some arg ends with `team.mjs` (separator-insensitive), followed by an arg in `worker|done|coordinator|init`, or (b) `c.info.name` is `team` or `offlimits-team` and `args[0]` is in that set. The worker gets `deny` for all four. Solo gets `ask` for `worker|done|coordinator` and nothing for `init`. The reason is `<cmd> would start or remove team sessions, which only the coordinator does (matched "...")`.

- [ ] **Step 1: Add fixtures** (expected to fail first):
  - worker denies `node C:/x/offlimits/bin/team.mjs worker demo --brief b.md`
  - worker denies `team done demo`
  - a subagent of the coordinator denies `team worker x` (fixture with `agent_id` and `OFFLIMITS_ROLE=coordinator`, matching how existing fixtures express env)
  - worker allows `team board`, `team reserve migration` and `node bin/team.mjs stage building`
  - solo asks `team worker x`
  - coordinator allows `team worker x`
  - worker denies a `Write` to `.offlimits/team/board.json`
- [ ] **Step 2: Run** `node --test tests/gate.test.mjs`. Expected: FAIL on the new fixtures.
- [ ] **Step 3: Implement** the rule and protected paths, and add a row to the README rules table: `team-launch` | `team worker|done|coordinator|init` from a worker or subagent; solo asks.
- [ ] **Step 4: Run** `node --test && node hooks/selftest.mjs --all`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(gate): team-launch rule and protected team state files`

### Task 9: SessionStart team banner

**Files:**
- Modify: `hooks/session.mjs`, `hooks/lib/format.mjs` (new `teamBanner(f)`)
- Test: `tests/team-banner.test.mjs`

**Interfaces:**
- Consumes: `teamDir`, `readBoard`, `loadTeam` and `laneStatus`.
- Produces: `teamBanner({role, lane, board, deliveriesWaiting: string[], questionsWaiting: string[], staleLanes: string[], otherCoordinatorPid: number|null, briefPath: string|null, stage: string|null}) => string`, at most 25 lines.
  - coordinator: `team: N lanes (x building, y delivered, …)`, then `waiting for your review: a, b`, `questions for the human: c`, `merged but not cleaned (run team done): d` and, when it applies, `WARNING: another coordinator is running (pid N)`.
  - worker: `You are worker <lane>. Brief: <path>. Stage: <stage>. Next: <next step for that stage>`, followed by `If the gate blocks you, hand over to the coordinator.` A worker with no lane prints `You are a worker without a lane; ask the coordinator for a brief.`
  - solo with a team dir: `This is a team repo. Start the coordinator from a terminal with: team coordinator`.
- `session.mjs` appends `teamBanner` output only when `teamDir` exists. Any error is swallowed, as today.
- Next step per stage: `briefed → read the brief and start the design`, `designing → finish the design; if approval is human, send it and wait`, `awaiting-approval → wait for approval`, `building → build, run checks, deliver`, `delivered → wait for coordinator review`.

- [ ] **Step 1: Write the failing tests**: the format output for each role (snapshot by `assert.match` on the lines above), a line count ≤ 25 with 30 lanes, and `session.mjs` run as a child with stdin `{cwd}` in a temp team repo with `OFFLIMITS_ROLE=worker`, `OFFLIMITS_LANE=demo` prints `You are worker demo`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(team): session banner restates role, lane and board`

### Task 10: Skills (the ritual)

**Files:**
- Create: `skills/offlimits-coordinator/SKILL.md`, `skills/offlimits-worker/SKILL.md`
- Modify: `skills/offlimits-roles/SKILL.md` (a short contract plus pointers to both), `skills/offlimits/SKILL.md` (add `init`, `board`, `team` commands that run `node "<root>/bin/team.mjs" …`)
- Test: `tests/manifest.test.mjs` or `tests/docs.test.mjs` gains a check that each `skills/*/SKILL.md` has `name` and `description` frontmatter and that the name equals its folder

Content, per spec §5.6. Each skill stays under 150 lines, is in English, and uses imperative voice.
- `offlimits-coordinator`. Frontmatter description: "Run a repo as the coordinator of a team of Claude Code worker sessions: plan with the human, brief and launch workers, review deliveries, merge and deploy on the human's go. Use when OFFLIMITS_ROLE is coordinator or the user asks to coordinate workers." Its sections: Talk to the human; From request to lanes; Launching a worker (exact `team worker` call and the brief template path); Roster and messages; Reservations; Reviewing a delivery; Merge and deploy (only on explicit go; `team.deploy` steps; health URL; `team done`); Night mode (morning-report.md, morning-questions.md); Model routing; What you never do.
- `offlimits-worker`. Description: "Contract for a worker session started by offlimits team: design first, build in your worktree with subagents and TDD, deliver to the coordinator. Use when OFFLIMITS_ROLE is worker or a brief was given." Its sections: Start (read the brief, `team stage designing`); Design and approval (human, coordinator or none; night rule); Plan and build (superpowers skills if available, otherwise the inline steps); Reservations; Checks; Deliver (`team deliver`, SendMessage to `coordinator`, draft PR if a remote exists); Never (push base, deploy, edit gate files, set the role, start agents); When blocked.

- [ ] **Step 1: Write the failing frontmatter test.**
- [ ] **Step 2: Run.** Expected: FAIL (the new skills are missing).
- [ ] **Step 3: Write the skills.**
- [ ] **Step 4: Run** `node --test && claude plugin validate .` (validate is skipped if `claude` is not on PATH). Expected: PASS.
- [ ] **Step 5: Commit** `feat(team): coordinator and worker skills`

### Task 11: Docs, version, decisions

**Files:**
- Modify: `README.md` (new headline and a "Team mode" quickstart ahead of the gate sections; the gate content keeps its substance), `README.tr.md` (same in Turkish), `CHANGELOG.md` (0.3.0), `DECISIONS.md` (decided: "2026-10-29: team mode lives in offlimits itself; supersedes the 26 Oct offlimits-crew decision"; pending: Şeker migration to team mode), `.claude-plugin/plugin.json` + `marketplace.json` description and version 0.3.0, `package.json` version 0.3.0
- Create: `docs/team.md` (the guide: quickstart, a day in the life, every command, the `team` config reference with the example from spec §5.3, Şeker mapping from spec §5.9, limits)
- Test: the existing `docs.test.mjs` and `manifest.test.mjs` (version consistency) pass

README headline: **"Turn Claude Code into a software team."** Subline: "One coordinator you talk to, workers in their own worktrees, and a gate that keeps everyone but the coordinator out of production. Runs in every permission mode, including --dangerously-skip-permissions."

Quickstart:
```
claude plugin install offlimits --marketplace meertseker/offlimits
node <plugin>/bin/team.mjs init      # or /offlimits init inside Claude
team coordinator                      # then talk to it
```

- [ ] **Step 1: Write the docs and bump versions.**
- [ ] **Step 2: Run** `node --test && node hooks/selftest.mjs --all`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: team mode guide, README repositioning, 0.3.0`

### Task 12: End-to-end check on Windows (coordinator does this, not a subagent)

- [ ] In a temp repo, run `init`, then `worker demo --brief` without `--print`. Windows Terminal opens a tab, the worker session shows `You are worker demo` and reads the brief, and asking it to `git push origin main` is blocked by `git-push-protected`.
- [ ] `board` shows the lane. `done demo --abandon` cleans up.
- [ ] Record the result in `DECISIONS.md` under Published/verified. Do not tag or push `main`; that waits for Mert's go.
