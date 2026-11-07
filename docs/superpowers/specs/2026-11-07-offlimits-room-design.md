# offlimits room: a control room for a team of Claude Code sessions

**Date:** 2026-11-07
**Status:** approved by Mert on 2026-11-07 ("onaylıyorum, bunu yap bitir"), after the brainstorm in the planning workspace and a clickable mockup.
**Lane:** `room`, branch `feat/room`, stacked on `feat/start` (PR #2).

## 1. Why

Six weeks of Mert's own Claude Code history (7 Sep to 7 Nov 2026): 2,008 prompts, 259 sessions, 41,561 assistant turns, 1,019 SendMessage calls, up to 12 sessions in one hour. About 36% of the prompts were spent operating the team rather than deciding about the product: "durum ne" (128 times), relaying messages between sessions, answering approvals, ordering deploys, pausing night loops because of the usage limit, and pasting role prompts. The human is the dashboard, the message bus, the approval inbox and the quota governor.

The same coordinator/worker ritual exists in six hand-built copies (two production projects with ledger folders, a third with a team chat file, offlimits team mode, a product spec, and a remote assistant bridge). Each copy keeps its state in a different place, and the human is the only link between them.

The control room removes the "where are we" work: one local page that reads every place where team state already lives, shows what needs the human, and takes the two answers the human gives most often.

## 2. Decisions this design rests on

| # | Decision |
|---|---|
| D1 | The control room lives inside offlimits, as the extension of `team board`. A product that needs an internal console takes offlimits as a dependency instead of building its own. |
| D2 | Projects move to team mode one at a time. The room must work before they do, so it also reads hand-built setups (ledger files, approval folders, loop folders). |
| D3 | An append-only event log becomes the source of truth for team history. Ledgers, reports and the room are projections of it. During the transition the hand-written ledgers stay and are read as they are. |
| D4 | The event schema carries metric fields from day one (model, tokens, cost, checks, review verdict, intervention), so the weekly numbers come from data, not from memory. |

## 3. Goals, non-goals, anti-goals

Goals:

- `team room` opens a local page that shows, across every configured project: worktrees and lanes, their stage and activity, deliveries, live Claude Code sessions and which of them wait for the human, unanswered approval requests, night loops, ledger sections, inbox feeds, log health, today's events and a small set of metrics.
- The page answers an approval request (appends the answer line the existing protocol expects) and pauses or resumes a loop. Nothing else is written.
- `team event` and the existing team commands append to `.offlimits/team/events.jsonl`.
- Zero dependencies, Node 20 built-ins only, no outbound network, every file under 256 KiB, English code and docs, the page localised (English and Turkish).

Non-goals (v1):

- No planning, merging, deploying, migration numbering or ledger writing from the room. Those stay with the coordinator.
- No remote access. The server binds to 127.0.0.1. Phone approvals keep going through the existing remote assistant.
- No usage-limit governor: Claude Code exposes no local file with the plan's usage percentage. The room shows the last limit notice it finds in session transcripts instead.
- No health-URL checks (no outbound network).
- No session control (the room cannot type into a session).

Anti-goals (failure even if it works):

- A second coordinator: if the room ever decides, plans or writes ledgers, it recreates the double-coordinator incident of 31 Oct.
- A way for an agent to approve its own request.
- A page that hides stale or unknown state behind confident green marks.

## 4. What it reads

All sources are read on demand when the page asks for state (cached for 10 seconds). Every source catches its own errors and reports them, so one bad path never blanks the page.

| Source | Config | Read |
|---|---|---|
| Repositories | `projects[].repos[]` (`path`, `base`) | `git worktree list`; per worktree: branch, HEAD, ahead/behind the base, dirty count, last commit time and subject, merged into the base. Base branch commits from today. |
| Team board | automatic when `<repo>/.offlimits/team/board.json` exists | lane stage, deliveries, questions. |
| Deliveries | `projects[].deliveries.dir` | delivery notes matched to lanes by branch slug (`feat/a-b` matches `feat-a-b.md`, `a-b.md`). |
| Approvals | `projects[].approvals` (`dir`, `answerPrefix`, `actor`, `channel`, `ignore`) | request files: header lines (`id`, subject, requester, date, impact, reversible, due; English and Turkish keys), options (`- A: ...`), answer lines. |
| Loops | `projects[].loops[]` | status JSON field (run/pause values), stop marker, other markers, task list counts and first open task, log freshness. |
| Ledgers | `projects[].ledgers[]` (`file`, `sections`, `decisions`) | named Markdown sections rendered as tables, lists and paragraphs; table rows that mention a lane's branch are attached to that lane. |
| Facts | `projects[].facts[]` (`label`, `file`, `regex`) | one value per fact, extracted with a regex (for example the next free migration number). |
| Coordinator | `projects[].coordinatorFile` | session ids, first one current; used to label sessions. |
| Inbox feeds | `projects[].inbox[]` | newest files in a folder: header bullets and the first fenced block. |
| Log watch | `projects[].logs[]` (`file`, `ok`, `error`) | last success time and the errors after it. |
| Claude Code sessions | `claude.dir` (default `~/.claude`) | transcripts of every repo and worktree directory: last activity, model, branch, title, last prompt, and state: working, waiting for you, or quiet. The newest usage-limit notice across transcripts. |
| Prompt history | `claude.history` | prompts per day and per project for 14 days; the share that matches `claude.orchestration` patterns, this week and last week. |
| Events | `<repo>/.offlimits/team/events.jsonl` and `<home>/events.jsonl` | today's timeline and the metrics. |

Without a config file, `team room` run inside a repository shows that repository only (worktrees, team board, sessions, events).

## 5. What it writes

Exactly two things, both on an explicit click and a confirmation step, both recorded as events in `<home>/events.jsonl`:

1. **An approval answer.** One line appended to the request file: `<prefix> <option>[ — <note>] - <actor>, <ISO time>, <channel>`. This is the format the existing remote bridge writes, so a session waiting on the file wakes up the same way. The room re-reads the file first and refuses (409) when an answer arrived in the meantime. The option must be one of the options the file lists.
2. **A loop pause or resume.** Pause sets the status field to the pause value and creates the stop marker; resume sets the run value and removes the stop marker. Other keys of the status file are kept. Other markers (for example a watchdog stop) are never touched. The room does not start processes; when a resumed loop shows no fresh log, the page says how to start it.

`<home>` is `$OFFLIMITS_HOME`, else `~/.offlimits`. It also holds `room.json` (written by the user) and `room.pid` (written by the running room).

## 6. Event log

`.offlimits/team/events.jsonl` in a team repository and `<home>/events.jsonl` for room actions. One JSON object per line, appended, never rewritten. Unreadable lines are skipped by readers.

```json
{"v":1,"ts":"2026-11-07T17:41:02.123Z","type":"lane.delivered","project":"shop","lane":"cart","actor":"worker","sha":"3f90e5e","checks":[{"name":"tests","ok":true}],"note":"..."}
```

| Field | Type | Meaning |
|---|---|---|
| `v` | 1 | schema version |
| `ts` | ISO string | when |
| `type` | string `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$` | what happened |
| `project`, `lane`, `actor`, `run`, `model`, `verdict`, `intervention`, `note` | short strings | context (note up to 500 characters) |
| `sha` | hex 4 to 40 | commit |
| `tokens` | `{in, out, cacheRead, cacheWrite}` | token use |
| `costUsd` | number | cost |
| `checks` | `[{name, ok}]` | check results |
| `defects` | integer | review findings |
| `data` | object, up to 2 KB | anything else |

Known types: `lane.briefed`, `lane.stage`, `lane.delivered`, `lane.question`, `lane.merged`, `lane.abandoned`, `reserve`, `review`, `deploy`, `approval.answered`, `loop.paused`, `loop.resumed`, `note`. The team commands write the `lane.*` and `reserve` events themselves; `team event <type>` writes the rest (coordinator and human only). A failed event write never fails the command; it prints a warning.

Metrics derived from events: lanes merged in 7 days, first delivery with every check green (share), reviews with findings (share), brief-to-merge time (median, p90), approvals answered in 7 days. Derived from other sources: approval answer time (request date to answer line), open, stale and finished-but-not-removed lanes, prompts per day, orchestration share. A metric without data says so; nothing is estimated.

## 7. Security

- Binds to 127.0.0.1 only. No outbound connections; the page loads no external fonts, scripts or images.
- Login: the CLI prints and opens a one-time link `/login?t=<ticket>` (ticket valid 10 minutes, single use). It sets an `HttpOnly`, `SameSite=Strict` session cookie. Every other route needs the cookie.
- The `Host` header must name the room's own address (DNS-rebinding defence). State-changing requests must be `POST` with `Content-Type: application/json`, the header `X-Offlimits-Room: 1` and an `Origin` equal to the room's origin.
- Strict CSP (`default-src 'none'`, scripts and styles from the room only), `X-Frame-Options: DENY`, `nosniff`, `no-store`. The page builds DOM with `textContent`, never HTML strings.
- Request ids and loop ids must match configured items; file paths are resolved inside the configured folder.
- `team room` refuses to start inside Claude Code in every role, and the `team-launch` gate rule denies it to workers and subagents (asks in solo mode), because the room answers approvals for the human.
- Honest limit: any process running as the same user can read the approval folder and append a line, with or without the room. The room does not make that worse and does not fix it.

## 8. The page

One page, three tabs, localised from `room.json` `language` (`en` or `tr`).

- **Header:** time, one sentence summary (lanes, open approvals, sessions waiting), live sessions, the newest limit notice, log-watch health.
- **Needs you (left column):** unanswered approvals with option buttons and a confirmation step; sessions waiting for the human; lane questions; ledger decision lists (read-only); loops in an odd state.
- **Board:** one block per project: facts, coordinator session, one row per worktree (lane, branch, stage trace, status, last activity, delivery, ledger status). A row opens its detail: commits, dirty files, delivery fields, ledger row, sessions in that worktree, loop controls. Below: loops, feeds, log watch, ledger sections (collapsible).
- **Today:** one timeline from events, base-branch commits, answered approvals, deliveries and inbox items of the day, each labelled with its source.
- **Metrics:** the numbers of section 6, a 14-day prompt chart with a table view, and the orchestration share.

Status is never colour alone: every state has an icon shape and a word. Light and dark themes. Works at phone width. Polls every 20 seconds and on focus.

## 9. CLI

```
team room [--config <file>] [--port <n>] [--no-open]
team event <type> [--lane x] [--sha s] [--note t] [--model m] [--verdict v] [--defects n] [--cost usd]
```

`team room` loads the config (`--config`, else `<home>/room.json`, else the current repository), stops a previous room recorded in `room.pid`, listens on `port` (default 4747, the next free port up to +10), prints the login link and opens it. It runs until Ctrl+C.

## 10. Left to the builder

File layout under `hooks/lib/room/`, the exact page styling within the rules above, test fixtures, and the wording of English and Turkish strings.
