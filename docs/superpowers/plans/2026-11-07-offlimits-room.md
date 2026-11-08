# offlimits room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `team room` opens a local control-room page over every configured project, and the team commands start an append-only event log.

**Architecture:** Small read-only source modules under `hooks/lib/room/` (git, approvals, loops, markdown ledgers, feeds, Claude Code sessions and history, events) feed one snapshot builder; a zero-dependency `node:http` server on 127.0.0.1 serves the snapshot and three static assets and accepts exactly two writes (approval answer, loop pause/resume). `hooks/lib/team/events.mjs` holds the event schema used by the CLI and the room.

**Tech Stack:** Node >= 20 built-ins only (`node:http`, `node:fs`, `node:child_process`, `node:crypto`), `node --test`, vanilla HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-11-07-offlimits-room-design.md`

## Global Constraints

- No dependencies, no lockfile, `node:` imports only; tests use `node --test` only (plain `node --test`, not `node --test tests/`).
- No outbound network; the server binds to `127.0.0.1` only; the page loads nothing from other origins.
- Every file under 256 KiB. English code, docs and CLI messages; the page is localised (`en`, `tr`).
- `README.md`, `CHANGELOG.md`, `docs/limits.md`, `docs/policy.md`, `docs/incidents.md`: no em-dashes and no `!`.
- Writes: only the approval answer line and the loop status/stop marker, each also recorded as an event.
- Answer line format: `<prefix> <option>[ — <note>] - <actor>, <ISO time>, <channel>`.
- Event line: `{"v":1,"ts":...,"type":...}` plus the optional fields of spec section 6; unknown keys rejected.
- `team room` refused inside Claude Code in every role; gate rule `team-launch` denies it to workers and subagents, asks in solo mode.
- Commits carry no Claude trailer (owner's rule).

## Review Focus

- Approval and loop files written by PowerShell have CRLF line endings: parsing and appending must treat `\r\n` like `\n` (test in Task 4 and Task 5).
- Repository and folder paths with spaces and non-ASCII letters (`C:\Users\x\Desktop\Bahce Sulama Projesi`, `ş`): session-folder encoding and path resolution must still match (test in Task 7).
- Very large inputs (100+ MB transcripts, a 112 KB ledger): reads are bounded (transcript tail at most 256 KiB, ledger sections capped) and stay fast (test in Task 7 and Task 3).
- A configured repository path that does not exist or is not a git repository: that repository shows an error, every other source still renders (test in Task 9).
- The configured port is taken by another program: the room takes the next free port up to +10 and says which (test in Task 12).

---

### Task 1: Event log and `team event`

**Files:**
- Create: `hooks/lib/team/events.mjs`, `tests/team-events.test.mjs`
- Modify: `hooks/lib/team/cli.mjs` (emit events, `event` command), `hooks/lib/team/guard.mjs` (`event` privileged), `tests/team-guard.test.mjs`, `tests/team-cli.test.mjs`

**Interfaces:**
- Produces: `EVENT_TYPES: string[]`, `TYPE_RE: RegExp`, `makeEvent(fields, now = Date.now): object` (throws `Error('invalid event: ...')`), `appendEvent(file, fields, {now}?): object`, `readEvents(file, {sinceMs = 0, limit = 5000}?): object[]`, `parseChecks(text): {name: string, ok: boolean}[]`, `eventsFile(teamDir): string` (`<teamDir>/events.jsonl`).

- [ ] **Step 1: Write the failing tests** in `tests/team-events.test.mjs`:
  - `makeEvent fills v and ts`: `makeEvent({type:'note'}, () => 0)` deep-equals `{v:1, ts:'1970-01-01T00:00:00.000Z', type:'note'}`.
  - `makeEvent rejects`: types `'Lane.x'`, `'a..b'`, `''`; key `{type:'note', bogus:1}`; `sha:'zz'`; `data` over 2048 bytes of JSON; `checks` entry without boolean `ok`. Each throws `/invalid event/`.
  - `makeEvent truncates a 600-character note to 500` and replaces control characters with spaces.
  - `appendEvent/readEvents round trip`: three appends into a missing folder, then a corrupt line appended by hand; `readEvents` returns the three in order; `sinceMs` drops older ones; `limit: 2` keeps the newest two.
  - `parseChecks`: `'checks: tests ✓ selftest ✓ validate ✗'` gives `[{tests,true},{selftest,true},{validate,false}]`; `'kontroller: lint ✓ typecheck ✓ test ✓ web build ✓ panel build ✓'` gives 5 entries including `{name:'web build', ok:true}`; text without such a line gives `[]`.
  - In `tests/team-cli.test.mjs`: `stage, deliver, ask, reserve and done write events` (each command appends one event with type `lane.stage`, `lane.delivered` with parsed checks, `lane.question`, `reserve` with `data.key/value`, `lane.merged`; actor `human` without `CLAUDECODE`); `event command records and validates` (`team event deploy --sha abc1234 --note n` exits 0 and writes `{type:'deploy', sha:'abc1234'}`; `--defects x` exits 2; inside Claude as worker exits 3).
  - In `tests/team-guard.test.mjs`: add `event` to the command list; worker and solo inside Claude are refused, coordinator and human allowed.
- [ ] **Step 2: Run** `node --test tests/team-events.test.mjs tests/team-guard.test.mjs tests/team-cli.test.mjs`. Expected: FAIL (module missing, unknown command `event`).
- [ ] **Step 3: Implement** `events.mjs` per spec section 6 (field limits: short strings 120 chars, note 500, sha `^[0-9a-f]{4,40}$`i, tokens non-negative integers `in/out/cacheRead/cacheWrite`, `costUsd` finite >= 0, up to 32 checks, `defects` integer 0 to 10000, `data` object up to 2048 bytes). In `cli.mjs`: `emit(dir, fields)` appends with `actor` = `coordinator | worker | solo | human`, warns on stderr and never fails the command; emit from `worker`, `stage`, `deliver`, `ask`, `reserve`, `done`; add `event` (flags `--lane --sha --note --model --verdict --defects --cost`, value flags added to `VALUE_FLAGS`). In `guard.mjs` add `event` to `PRIVILEGED`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(team): append-only event log and team event`.

### Task 2: Room configuration

**Files:**
- Create: `hooks/lib/room/config.mjs`, `tests/room-config.test.mjs`

**Interfaces:**
- Produces: `roomHome(env, homedir): string` (`$OFFLIMITS_HOME` or `~/.offlimits`), `claudeHome(env, homedir): string` (`$CLAUDE_CONFIG_DIR` or `~/.claude`), `loadRoomConfig({file?, cwd, env, homedir, readFile?}): {config, problems: string[], source: 'file'|'repo'|null}`. `config = {language, port, staleDays, claude: {dir, liveMinutes, history, orchestration: string[]}, projects: Project[]}`; `Project = {id, name, repos: [{name, path, base}], deliveries: {dir}|null, approvals: {dir, answerPrefix, actor, channel, ignore: string[]}|null, loops: Loop[], ledgers: [{name, file, sections: string[], decisions: string[]}], facts: [{label, file, regex}], coordinatorFile: string|null, inbox: [{name, dir, limit}], logs: [{name, file, ok, error}]}`; `Loop = {id, name, dir, status: {file, field, run, pause}, stopFile, markers: string[], tasks: {file, done, blocked, id, title}|null, log: string|null, liveMinutes, startHint: string|null}`.

- [ ] **Step 1: Write the failing tests**: `defaults and repo shorthand` (`{"projects":[{"name":"Shop","repo":"./shop"}]}` gives `id 'shop'`, absolute repo path beside the config file, `base null`, `language 'en'`, `port 4747`); `home and relative paths` (`~/x` expands, relative paths resolve against the config folder, `OFFLIMITS_HOME` picks the default file); `bad entries are reported and skipped` (bad facts regex, loop without `dir`, unknown key, `port: 80`, `language: 'xx'`; config still loads, each produces one problem string); `repo mode` (no file, cwd inside a git repo: `source 'repo'`, one project for that repo; outside a repo: `source null` and a problem).
- [ ] **Step 2: Run** `node --test tests/room-config.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** with validation that never throws (pattern of `team/config.mjs`). Defaults: approvals `answerPrefix 'ANSWER:'`, `actor` = OS user name, `channel 'room'`, `ignore ['TEMPLATE.md','README.md']`; loop status `{file:'status.json', field:'status', run:'run', pause:'paused'}`, `stopFile 'STOP'`, `liveMinutes 30`; inbox `limit 5` (1 to 20); logs `ok '\\bOK\\b'`, `error 'ERROR'`; `port` 1024 to 65535; `language` `en | tr`; project `id` `^[a-z0-9][a-z0-9-]{0,39}$`, derived from `name` when missing (ASCII-folded).
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(room): room.json configuration`.

### Task 3: Markdown ledgers and facts

**Files:**
- Create: `hooks/lib/room/markdown.mjs`, `tests/room-markdown.test.mjs`

**Interfaces:**
- Produces: `parseInline(s): Inline[]` (`{t:'text'|'code'|'strong'|'link', v, href?}`), `parseBlocks(lines): Block[]` (`{kind:'table', header: Inline[][], rows: Inline[][][]}`, `{kind:'list', items: Inline[][]}`, `{kind:'para', inline}`, `{kind:'code', text}`), `pickSections(text, names): [{title, blocks, truncated}]`, `tableRows(blocks): [{header: string[], cells: string[]}]`, `extractFact(text, regex): string|null`.

- [ ] **Step 1: Write the failing tests**: `inline` (`` `0045` and **bold** and [x](https://a.b) and [y](javascript:alert(1)) `` gives code, strong, link with href `https://a.b`, and plain text `y`); `table, list, paragraph and code fence`; `section pick by prefix` (`Göçler` matches `## Göçler: magaza-admin (`src/x`)`, ends at the next `##`, a `###` inside stays); `caps` (a 1000-line section is cut to 400 lines with `truncated: true`; a 3000-character cell is cut to 1500); `tableRows plain text`; `extractFact` (`/Sıradaki boş numara[^0-9]*(\d+)/` on `Sıradaki boş numara: **019**.` gives `'019'`; the last match in the file wins).
- [ ] **Step 2: Run** `node --test tests/room-markdown.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement**; only `http:` and `https:` links keep an `href`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(room): Markdown ledger sections and facts`.

### Task 4: Approval requests

**Files:**
- Create: `hooks/lib/room/approvals.mjs`, `tests/room-approvals.test.mjs`

**Interfaces:**
- Consumes: approvals config from Task 2.
- Produces: `RoomError(status, code, message)` (exported class, also used by Tasks 5 and 10), `parseRequest(text, {prefix}): {header: {id,title,from,date,impact,reversible,due}, options: [{key,text}], answers: [{text, option, at}], answered}`, `listRequests(cfg, {now}): {items: Request[], error?}` (`Request` adds `id` = file stem, `file`, `mtime`, `ageMs`, `requestedAt`), `answerLine({prefix, option, note, actor, channel, at}): string`, `answerRequest(cfg, {id, option, note}, {now}): {line, file}`.

- [ ] **Step 1: Write the failing tests** with synthetic Turkish and English fixtures: `parse unanswered` (header keys `konu`, `isteyen oturum`, `tarih`, `etki`, `geri alınabilir mi`, `son tarih`; three options; a bare `CEVAP:` line is not an answer); `parse answered` (a bare `CEVAP:` then `CEVAP: A — note - Mert, 2026-11-07T14:49:49Z, telegram`: answered, option `A`, `at` that ISO time); `CRLF file parses the same`; `English ANSWER prefix`; `list` (ignores `SABLON.md` when listed in `ignore`, non-`.md` files; newest first; `requestedAt` from `2026-11-07 14:40` and `04.11.2026 21:05`); `answer appends one line` (fixed `now` gives exactly `CEVAP: B — later - Mert, 2026-11-07T17:41:00.000Z, kumanda\n`; a file without a final newline gets one first); `answer refuses` (second answer 409 with the existing text; option `Z` 400; id `../x` 400; missing file 404; note with a newline becomes one line, over 300 characters cut).
- [ ] **Step 2: Run** `node --test tests/room-approvals.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement**; ids `^[\w.-]{1,80}$`; the file path is resolved and must stay inside `cfg.dir`; the file is re-read immediately before appending.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(room): approval requests and answers`.

### Task 5: Loops

**Files:**
- Create: `hooks/lib/room/loops.mjs`, `tests/room-loops.test.mjs`

**Interfaces:**
- Consumes: `Loop` config (Task 2), `RoomError` (Task 4).
- Produces: `readLoop(cfg, {now}): {id, name, status, note, paused, running: boolean|null, logAgeMs, logTail: string[], markers: [{name, mtime}], stopped, tasks: {done, total, blocked, next: {id, title}|null}|null, error?}`, `setLoop(cfg, action: 'pause'|'resume', {now}): ReturnType<readLoop>`.

- [ ] **Step 1: Write the failing tests**: `read` (status `{"durum":"DURAKLATILDI","not":"x"}` with field `durum`, pause `DURAKLATILDI`: `paused true`, `note 'x'` from key `not` when the status object has it; tasks list of 4 with 3 `passes`: `done 3, total 4, next` the open one; markers `DUR`, `BEKCI-DUR` present with mtimes); `running from log freshness` (log touched now: `true`; 2 hours old with `liveMinutes 30`: `false`; no log configured: `null`); `resume` (status becomes `DEVAM`, other keys kept, `DUR` removed, `BEKCI-DUR` kept, compact JSON stays compact); `pause` (`DURAKLATILDI` and `DUR` created); `bad action` 400; `missing status file` is created on resume.
- [ ] **Step 2: Run** `node --test tests/room-loops.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement**; atomic write (tmp then rename); `note` is read from a `note` or `not` key; the task list accepts an array or `{features: [...]}`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(room): loop status, pause and resume`.

### Task 6: Inbox feeds and log watch

**Files:**
- Create: `hooks/lib/room/feeds.mjs`, `tests/room-feeds.test.mjs`

**Interfaces:**
- Produces: `readInbox(cfg, {now}): {name, items: [{file, mtime, fields: [string,string][], text}], error?}`, `readLogWatch(cfg, {now}): {name, lastOk: {ts, line}|null, errorsSinceOk, lastError: {ts, line}|null, mtime, error?}`.

- [ ] **Step 1: Write the failing tests**: `inbox` (three files with `- key: value` bullets and a fenced `text` block: newest first, `limit` respected, `text` from the fence, at most 8 fields); `log watch` (lines `2026-11-07T14:50:41Z OK ...`, then two `ERROR ssh timeout` lines: `lastOk.ts` that time, `errorsSinceOk 2`, `lastError` the last; a missing file gives `error`; only the last 64 KiB are read).
- [ ] **Step 2: Run** `node --test tests/room-feeds.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement**; a line's time is its leading ISO timestamp, else `null`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(room): inbox feeds and log watch`.

### Task 7: Claude Code sessions and prompt history

**Files:**
- Create: `hooks/lib/room/sessions.mjs`, `tests/room-sessions.test.mjs`

**Interfaces:**
- Produces: `encodeProjectDir(dir): string` (every character outside `[A-Za-z0-9-]` becomes `-`), `readSessionTail(file, {bytes = 262144}?): {id, lastTs, model, branch, title, lastPrompt, ended: boolean, limitNotice: {ts, text}|null}`, `readSessions(claudeDir, dirs: [{dir, project, lane}], {now, liveMinutes, coordinatorIds: string[]}): {sessions: Session[], limitNotice: {ts, text, project}|null}` with `Session = {id, shortId, project, lane, role: 'coordinator'|'lane'|'main', title, lastPrompt, model, branch, lastTs, ageMs, state: 'working'|'waiting'|'quiet', stalled}`, `readHistory(claudeDir, projects: [{id, dirs: string[]}], {now, days = 14, patterns: string[]}): {days: [{date, total, byProject}], byProject, thisWeek: {prompts, orchestration}, lastWeek: {prompts, orchestration}}`.

- [ ] **Step 1: Write the failing tests** with a temp Claude folder: `encode` (`C:\Users\me\Desktop\a-b` gives `C--Users-me-Desktop-a-b`; `/home/me/x` gives `-home-me-x`; `C:\Users\me\Desktop\Bahce Sulama Projesi` and a folder with `ş` give the dashed form and are found); `waiting` (last assistant entry `stop_reason end_turn`, then a `system` line: `state 'waiting'`, title from `ai-title`, prompt from `last-prompt`); `working` (last entry a `tool_result`: `working`; 20 minutes old: `stalled true`); `quiet` (older than `liveMinutes` and not waiting); `coordinator label` (id listed in `coordinatorIds`); `limit notice` (newest `<synthetic>` text matching `limit|credits|resets`); `tail is bounded` (a 5 MB file: only the last 256 KiB are read, result still correct); `history` (prompts mapped to projects by path prefix, case-insensitive on Windows, slash commands skipped, per-day buckets for 14 days, orchestration share from patterns this week and last week).
- [ ] **Step 2: Run** `node --test tests/room-sessions.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement**; only transcripts modified in the last 24 hours are opened per folder; waiting sessions older than 12 hours count as quiet; working older than 15 minutes is `stalled`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(room): Claude Code sessions and prompt history`.

### Task 8: Repositories and lanes

**Files:**
- Create: `hooks/lib/room/git.mjs`, `hooks/lib/room/repos.mjs`, `tests/room-repos.test.mjs`

**Interfaces:**
- Consumes: `readBoard` (`team/state.mjs`), `parseChecks` (Task 1), `tableRows` (Task 3).
- Produces: `gitAsync(cwd, args, {timeoutMs = 8000}?): Promise<string|null>`, `readRepo(repo, {now, staleDays, deliveryFiles: [{file, name, mtime}], ledgerRows: [{header, cells}]}): Promise<{name, path, base, baseHead: {sha, ts, subject}|null, todayCommits: [{sha, ts, subject}], lanes: Lane[], error?}>` with `Lane = {id, path, main, branch, sha, dirty, ahead, behind, merged, lastCommit, team: {stage, note, model}|null, delivery: {file, mtime, fields, checks}|null, ledger: {status, row}|null, stage: {index, name, inferred}, state: 'main'|'building'|'delivered'|'merged'|'stale', quietDays}`.

- [ ] **Step 1: Write the failing tests** on a temp repo with two worktrees: `lanes` (main gives `state 'main'`; `feat/a` with one commit and an untracked file gives `building`, `ahead 1`, `dirty 1`; `feat/b` at the base gives `merged`); `delivery` (`feat-a.md` newer than the last commit gives `delivered`, fields and checks parsed); `stale` (commit dated 9 days ago with `staleDays 5`: `stale`, `quietDays 9`); `ledger status` (a row with `` `feat/a` `` and a `Durum` column `BAŞLADI`); `team board` (stage from `board.json`, `inferred false`); `today commits` (only base commits since local midnight); `missing repo` (`error` set, no throw).
- [ ] **Step 2: Run** `node --test tests/room-repos.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement**; at most 6 concurrent git processes; base = configured, else `resolveBase` order; inferred stage index: merged 5, delivered 4, ahead > 0 is 3, else 0.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(room): repositories, worktrees and lanes`.

### Task 9: Metrics, strings and the snapshot

**Files:**
- Create: `hooks/lib/room/metrics.mjs`, `hooks/lib/room/i18n.mjs`, `hooks/lib/room/snapshot.mjs`, `tests/room-metrics.test.mjs`, `tests/room-snapshot.test.mjs`

**Interfaces:**
- Consumes: Tasks 1 to 8.
- Produces: `computeMetrics({events, approvals, lanes, history, now}): {lanesMerged7d, firstPassGreen, reviewFindings, briefToMerge, approvalsAnswered7d, answerTime, openLanes, staleLanes, cleanupLanes, prompts7d, orchestration}` (a metric without data is `null`), `STRINGS: {en, tr}`, `strings(lang): object`, `buildSnapshot(config, {now, env, homedir}): Promise<Snapshot>` with `Snapshot = {v:1, generatedAt, lang, strings, summary, needsYou: {approvals, sessions, questions, decisions, loops}, projects, claude: {live, limitNotice, history}, today, metrics, problems, timings}`.

- [ ] **Step 1: Write the failing tests**: metrics from synthetic events (2 merged lanes in 7 days, first deliveries 1 of 2 all green: share 0.5; brief-to-merge median from two lanes; empty input gives `null`s); answer time from requests (request 14:40 local, answer 14:49Z), never negative; `en` and `tr` have the same keys; snapshot over a fixture world (one repo, an unanswered and an answered request, a paused loop, a ledger with a decisions section, an inbox, a log, a Claude folder with one waiting session) lists the unanswered request and the waiting session under `needsYou`; a project whose repo path does not exist reports a problem while the other project renders.
- [ ] **Step 2: Run** `node --test tests/room-metrics.test.mjs tests/room-snapshot.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement**; each source wrapped so an exception becomes a `problems` entry; today's timeline merges events, base commits, answered requests, deliveries and inbox items since local midnight.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(room): snapshot and metrics`.

### Task 10: Server

**Files:**
- Create: `hooks/lib/room/server.mjs`, `tests/room-server.test.mjs`

**Interfaces:**
- Consumes: `RoomError` (Task 4).
- Produces: `createRoomServer({getState: () => Promise<object>, answer: (body) => Promise<object>, setLoop: (body) => Promise<object>, assets: {html, css, js}}): {listen(port): Promise<number>, mintTicket(): string, close(): Promise<void>, port}`.

- [ ] **Step 1: Write the failing tests** (port 0): `ping without cookie`; `page needs a session` (401 page without any ticket or token); `login` (bad ticket 403; good ticket 303 to `/` with `Set-Cookie` holding `HttpOnly` and `SameSite=Strict`; the same ticket again 403; an expired ticket after 10 minutes 403 with injected clock); `host check` (`Host: evil.example:port` gives 421); `state with cookie` (200 JSON, `Cache-Control: no-store`); `post checks` (no `X-Offlimits-Room` 403, wrong or missing `Origin` 403, non-JSON content type 415, body over 16 KiB 413, bad JSON 400, good request calls `answer` with the parsed body); `RoomError maps to its status`; `page headers` (CSP `default-src 'none'`, `X-Frame-Options DENY`, `nosniff`).
- [ ] **Step 2: Run** `node --test tests/room-server.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** per spec section 7; cookie `offlimits_room`, 12 hours; tickets single use, 10 minutes; routes `/ping`, `/login`, `/`, `/assets/room.css`, `/assets/room.js`, `/api/state`, `/api/answer`, `/api/loop`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(room): localhost server with one-time login`.

### Task 11: The page

**Files:**
- Create: `hooks/lib/room/assets/room.html`, `hooks/lib/room/assets/room.css`, `hooks/lib/room/assets/room.js`, `tests/room-page.test.mjs`

**Interfaces:**
- Consumes: `Snapshot` (Task 9), routes (Task 10).

- [ ] **Step 1: Write the failing tests**: assets exist and are under 256 KiB; no `http://` or `https://` in the HTML and CSS, none in the JS outside the link-href check; the JS never uses `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `eval`; every `t('key')` the JS uses exists in `STRINGS.en` and `STRINGS.tr`; the CSS defines a dark theme for `prefers-color-scheme: dark` and `[data-theme="dark"]`.
- [ ] **Step 2: Run** `node --test tests/room-page.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** spec section 8: header, needs-you column with a confirmation step before every write, board per project with lane rows and details, today timeline, metrics with a 14-day bar chart and a table view, light and dark themes, phone width, keyboard focus, `aria-live` status line, polling every 20 seconds and on focus, DOM built with `textContent`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(room): control room page`.

### Task 12: `team room` and the gate

**Files:**
- Create: `hooks/lib/room/launch.mjs`, `tests/room-launch.test.mjs`
- Modify: `hooks/lib/team/cli.mjs`, `hooks/lib/team/guard.mjs`, `hooks/lib/rules/shell-rules.mjs`, `tests/team-guard.test.mjs`, `tests/fixtures/cases-shell.json`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 9, 10, 1.
- Produces: `runRoom({flags, env, cwd, out, err, platform, deps}): Promise<number>`; `deps = {openUrl?, waitForExit?, homedir?, now?}`.

- [ ] **Step 1: Write the failing tests**: `room starts, prints the login link and stops` (`deps.waitForExit` resolves at once: stdout has `http://127.0.0.1:<port>/login?t=`, `room.pid` written then removed, `openUrl` called unless `--no-open`); `port in use moves to the next port and says so`; `config problems are printed`; guard: `room` refused inside Claude for coordinator, worker and solo with the message `offlimits team: "room" answers approvals for the human; start it yourself from a terminal.`; fixtures: worker `team room` deny `team-launch`, worker `node C:/x/offlimits/bin/team.mjs room --no-open` deny, subagent of the coordinator `team room` deny, solo `team room` ask, coordinator `team room` allow.
- [ ] **Step 2: Run** `node --test tests/room-launch.test.mjs tests/team-guard.test.mjs tests/rules.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement**: `room` runs before the git-repository check; a previous room in `room.pid` that answers `/ping` is stopped; ports `port` to `port + 10`; `openUrl` uses `explorer.exe` on Windows, `open` on macOS, `xdg-open` elsewhere; answers and loop changes append `approval.answered` and `loop.paused`/`loop.resumed` to `<home>/events.jsonl`. Gate: `team-launch` hits `room` for workers (deny, also with `viaDefault`) and solo (ask), reason `room answers approvals for the human; only a human terminal may start it`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(team): team room, guarded for humans only`.

### Task 13: Documentation

**Files:**
- Create: `docs/room.md`
- Modify: `docs/team.md` (commands, who may run what, state, event log), `README.md` (a "Control room" subsection inside "Team mode"), `README.tr.md` (one line), `CHANGELOG.md` (`## Unreleased`), `docs/limits.md` (Control room section), `DECISIONS.md`, `docs/ledger/lanes.md`

- [ ] **Step 1: Write** the docs: every `room.json` key with type and default, the two writes, the security model, the event schema and known types, metric definitions, limits (same-user processes can answer approvals, no usage percentage, no health checks, ledger row matching is by branch text, polling not live).
- [ ] **Step 2: Run** `node --test tests/docs.test.mjs tests/skills.test.mjs tests/repo.test.mjs`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: control room and event log`.

### Task 14: Verification and delivery

- [ ] **Step 1: Run** `node --test`, `node hooks/selftest.mjs --all`, `claude plugin validate .`. Expected: all pass.
- [ ] **Step 2: Smoke on a real machine**: a `room.json` for two real projects, `team room --no-open`, log in with the printed link, fetch `/api/state`, check every source renders without problems; headless screenshots at 1440 and 390 pixels wide.
- [ ] **Step 3: Independent review** of the whole branch (security of the server and the two writes first); fix what it finds, with tests.
- [ ] **Step 4: Push** `feat/room` and open a draft PR against `main`, stacked on #2, with the delivery template.
