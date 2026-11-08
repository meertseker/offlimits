# Control room

`team room` opens a local page that shows your whole team at once: every lane (git worktree) across your projects with its stage, divergence and activity, the Claude Code sessions that are working or waiting for you, unanswered approval requests, night loops, inbox folders, log watches, ledger sections, a timeline of the day and a few metrics.

It is for the human. It answers an approval request and pauses or resumes a night loop, after a confirmation, and writes nothing else. It never plans, merges, deploys, numbers migrations or edits ledgers: those stay with the coordinator.

It also reads hand-built setups (Markdown ledgers, approval folders, loop folders), so a project can use it before it moves to team mode.

## Quick start

Run it yourself, in a terminal:

```sh
team room                        # or: node <plugin>/bin/team.mjs room
```

It loads `~/.offlimits/room.json` (or `--config <file>`). Without a config file it shows the repository you run it in. It listens on `127.0.0.1:4747` (or the next free port), prints a sign-in link and opens it in your browser. The link works once; press Enter in the terminal for a new one. Ctrl+C stops the room. Starting it again stops the previous one first.

```
team room [--config <file>] [--port <n>] [--no-open]
```

The page is localised: `"language": "tr"` in `room.json` gives Turkish.

## What it reads

Every source is read when the page asks for state (every 20 seconds and on focus; cached for 10 seconds). A source that fails shows its error; the rest of the page still renders.

| Source | Read |
|---|---|
| Repositories | `git worktree list`; per worktree: branch, HEAD, ahead and behind the base, uncommitted files, last commit, merged into the base by ancestry. Base-branch commits since midnight (first parent). |
| Team board | `.offlimits/team/board.json` stages, deliveries and questions, when the repository is in team mode. |
| Delivery notes | A folder of notes; `feat/a-b` matches `feat-a-b.md` or `a-b.md`. The note's `key: value` lines and its check marks (`tests ✓`). |
| Approval requests | A folder of request files (format below). |
| Loops | A loop folder: status JSON, stop marker, other markers, task list, log freshness. |
| Ledgers | Named sections of Markdown files, shown as tables, lists and paragraphs. A table row that names a lane's branch gives that lane its status. |
| Facts | One value per regular expression, for example the next free migration number. |
| Coordinator file | Session ids, the first one current, to label the coordinator's session. |
| Inbox folders | The newest Markdown files: their `- key: value` bullets and first fenced block. |
| Log watches | The last line matching `ok`, and the `error` lines after it, from the last 64 KiB. |
| Claude Code sessions | Transcripts of every repository and worktree folder from the last 24 hours, from their last 256 KiB: title, last prompt, the away summary, model, branch, and a state (below). The newest usage-limit notice. |
| Prompt history | `history.jsonl`: prompts per day and project for 14 days, and the share matching `claude.orchestration` patterns, this week and last week. |
| Events | `<repo>/.offlimits/team/events.jsonl` and `~/.offlimits/events.jsonl`. |

A session is **waiting** when its last turn ended (for up to 12 hours), **working** when its last entry is a tool call or result within `claude.liveMinutes` (stalled after 15 minutes without a step), and **quiet** otherwise.

A lane is **main** (the main checkout), **building**, **delivered** (a delivery note newer than its last commit, or the team stage), **merged** (nothing beyond the base and a clean tree, so it can be removed), **stale** (no commit for `staleDays` and no open session) or **missing** (git still lists the worktree but the folder is gone). Lanes on a team board show the board's stage; others show a stage inferred from git, drawn lighter.

## What it writes

Exactly two things, each after a confirmation step on the page, each also recorded in `~/.offlimits/events.jsonl`:

1. **An approval answer.** One line appended to the request file, in the format a waiting session already watches for:
   ```
   <answerPrefix> <option>[ — <note>] - <actor>, <ISO time>, <channel>
   ```
   The room re-reads the file first and refuses when an answer arrived in the meantime. The option must be one the file lists.
2. **A loop pause or resume.** Pause writes the pause value into the status field and creates the stop marker. Resume writes the run value and removes the stop marker. Other keys of the status file and other markers are kept. The room does not start the loop process; when the log is not fresh, the page shows `startHint`.

Besides those, `team room` writes `~/.offlimits/room.pid` while it runs.

## room.json

`~/.offlimits/room.json` (or `$OFFLIMITS_HOME/room.json`). Every key is optional except a project's `name` or repository. Paths may start with `~` and are resolved against the folder of `room.json`. A bad value is reported (in the terminal and on the page) and skipped or defaulted; the rest still loads.

```json
{
  "language": "en",
  "port": 4747,
  "staleDays": 5,
  "claude": { "dir": "~/.claude", "liveMinutes": 30, "history": true, "orchestration": ["status\\?", "where are we", "approve", "deploy"] },
  "projects": [
    {
      "name": "Shop",
      "repos": [{ "path": "~/code/shop", "base": "origin/main" }],
      "deliveries": "~/code/shop-ledgers/deliveries",
      "approvals": { "dir": "~/code/shop-ledgers/approvals", "answerPrefix": "ANSWER:", "actor": "Sam", "channel": "room", "ignore": ["TEMPLATE.md"] },
      "loops": [{ "name": "Night loop", "dir": "~/code/shop-night/.loop", "status": { "file": "status.json", "field": "status", "run": "run", "pause": "paused" }, "stopFile": "STOP", "markers": ["WATCHDOG-STOP"], "tasks": { "file": "tasks.json", "done": "passes" }, "log": "log/loop.txt", "startHint": "bash .loop/run.sh" }],
      "ledgers": [{ "file": "~/code/shop-ledgers/ledger.md", "sections": ["Active work"], "decisions": ["Pending decisions"] }],
      "facts": [{ "label": "Next migration", "file": "~/code/shop-ledgers/ledger.md", "regex": "Next free number[^0-9]*(\\d+)" }],
      "coordinatorFile": "~/code/shop-ledgers/coordinator",
      "inbox": [{ "name": "Phone inbox", "dir": "~/code/shop-ledgers/inbox", "limit": 5 }],
      "logs": [{ "name": "Inbox pull", "file": "~/code/shop-ledgers/inbox/pull.log", "ok": "\\bOK\\b", "error": "ERROR" }]
    }
  ]
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `language` | `en` or `tr` | `en` | Page language. |
| `port` | integer 1024 to 65535 | `4747` | First port tried; up to ten more are tried when it is busy. `--port` overrides it. |
| `staleDays` | integer 1 to 365 | `5` | Days without a commit before a lane is stale. |
| `claude.dir` | path | `$CLAUDE_CONFIG_DIR` or `~/.claude` | Where Claude Code keeps transcripts and `history.jsonl`. |
| `claude.liveMinutes` | integer 1 to 1440 | `30` | How long after its last step a session still counts as working. |
| `claude.history` | boolean | `true` | Read `history.jsonl` for the prompt chart. |
| `claude.orchestration` | array of regular expressions | `[]` | Prompts matching any of them count as "operating the team" (case-insensitive). |
| `projects[].id` | `^[a-z0-9][a-z0-9-]{0,39}$` | from `name` | Stable id used by the page and the event log. |
| `projects[].name` | string | first repository's folder | Display name. |
| `projects[].repo`, `repos[]` | path, or `{path, name?, base?}` | none | Repositories. `base` defaults to `origin/main`, `origin/master`, `main` or `master`, whichever exists. |
| `projects[].deliveries` | folder or `{dir}` | none | Delivery notes. A team repository's `.offlimits/team/deliveries/` is always read. |
| `projects[].approvals` | folder or object | none | `dir`, `answerPrefix` (`ANSWER:`), `actor` (your OS user name), `channel` (`room`), `ignore` (`TEMPLATE.md`, `README.md`). |
| `projects[].loops[]` | object | none | `dir` (required), `name`, `status` `{file: "status.json", field: "status", run: "run", pause: "paused"}`, `stopFile` (`STOP`; `null` for none), `markers`, `tasks` `{file, done: "done", blocked: "blocked", id: "id", title: "title"}`, `log`, `liveMinutes` (`30`), `startHint`. Paths are inside `dir`; a path that leaves it is not used. |
| `projects[].ledgers[]` | object | none | `file` (required), `name`, `sections` (shown on the board), `decisions` (shown read-only in the needs-you column). A section is the first heading that starts with the name, case-insensitive, up to the next heading of the same level, at most 400 lines. |
| `projects[].facts[]` | object | none | `label`, `file`, `regex` with at most one capture group; the last match wins. |
| `projects[].coordinatorFile` | path | none | Lines starting with a session id; `#` lines are skipped; the first id is the current coordinator. |
| `projects[].inbox[]` | object | none | `dir`, `name`, `limit` (1 to 20, `5`). |
| `projects[].logs[]` | object | none | `file`, `name`, `ok` (`\bOK\b`), `error` (`ERROR`). |

## Approval requests

A request is a Markdown or text file in the approvals folder (UTF-8 with or without a BOM, or UTF-16LE as PowerShell 5.1 `Out-File` writes it); its id is the file name without `.md`, and may contain spaces and any letters. The room reads:

- header lines `key: value` (English or Turkish keys): `id`; `subject`, `title`, `question` or `konu`; `from`, `requested by`, `session` or `isteyen oturum`; `date` or `tarih` (`2026-11-07 14:40`, `07.11.2026 14:40` or ISO); `impact` or `etki`; `reversible` or `geri alınabilir mi`; `due`, `deadline` or `son tarih`. Without a subject, the first line is the title.
- options: lines like `- A: ship it today`.
- answers: lines that start with `answerPrefix` and have text after it. A bare prefix line is a placeholder, not an answer. A request with an answer line is answered.

```
id: 0711-1440
date: 2026-11-07 14:40
from: coordinator
subject: Ship the cart redesign today?
- A: yes, after the checks
- B: wait for the review
impact: checkout page only
reversible: yes
ANSWER:
```

A session that asked can wait for the answer with any file watcher; the room's line is the same shape a phone bridge writes, so the waiting side does not need to know where the answer came from.

## Event log

`.offlimits/team/events.jsonl` in a team repository, and `~/.offlimits/events.jsonl` for the room's own writes. One JSON object per line, appended, never rewritten; readers skip lines they cannot parse.

```json
{"v":1,"ts":"2026-11-07T17:41:02.123Z","type":"lane.delivered","lane":"cart","actor":"worker","checks":[{"name":"tests","ok":true}]}
```

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` | schema version |
| `ts` | ISO time | when |
| `type` | `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$` | what happened |
| `project`, `lane`, `actor`, `run`, `model`, `verdict`, `intervention` | strings, up to 120 characters | context |
| `note` | string, up to 500 characters | free text, one line |
| `sha` | 4 to 40 hex characters | commit |
| `tokens` | `{in, out, cacheRead, cacheWrite}` | token use |
| `costUsd` | number | cost |
| `checks` | up to 32 `{name, ok}` | check results |
| `defects` | integer | review findings |
| `data` | object, up to 2 KB | anything else |

The team commands write their own events: `worker` (`lane.briefed`), `stage` (`lane.stage`), `deliver` (`lane.delivered` with the note's checks), `ask` (`lane.question`), `reserve` (`reserve`), `done` (`lane.merged` or `lane.abandoned`). The room writes `approval.answered`, `loop.paused` and `loop.resumed`. The coordinator records the rest:

```sh
team event deploy --sha 3f90e5e --note "checkout redesign"
team event review --lane cart --verdict fail --defects 2 --model opus
```

`team event` is for the coordinator and human terminals; workers are refused. A failed event write never fails a team command; it prints a warning.

## Metrics

A metric without data says so; nothing is estimated.

| Metric | From |
|---|---|
| Lanes merged in 7 days | `lane.merged` events |
| First delivery with every check green | the first `lane.delivered` of each lane that has checks |
| Reviews with findings | `review` events with `defects > 0` or verdict `fail` or `changes` |
| Brief to merge, median and p90 | `lane.briefed` to the first later `lane.merged`, per lane |
| Approvals answered in 7 days, time to answer | request files: the request date to the first answer line with a time |
| Open, quiet and finished-not-removed lanes | repositories |
| Prompts in 7 days, orchestration share | `history.jsonl` and `claude.orchestration` |

## Security

- The server binds to `127.0.0.1` only and makes no outbound connections. The page loads nothing from other origins.
- Sign-in: a single-use link, valid for ten minutes, sets an `HttpOnly`, `SameSite=Strict` session cookie for 12 hours. Every other route needs the cookie.
- A request whose `Host` header is not the room's own address gets 421 (DNS-rebinding defence).
- Writes are `POST` requests with `Content-Type: application/json`, the header `X-Offlimits-Room: 1`, the room's own `Origin`, and at most 16 KiB.
- Responses carry a strict Content-Security-Policy (`default-src 'none'`; scripts and styles from the room only), `X-Frame-Options: DENY`, `nosniff` and `no-store`. The page builds its DOM with `textContent`; links are kept only for `http` and `https`.
- Request ids and loop ids must match configured items; files are resolved inside the configured folder.
- `team room` is refused inside Claude Code: the CLI refuses it whenever `CLAUDECODE` is set, the gate rule `team-launch` denies it in every role (the coordinator included), and `role-spoof` denies changing `CLAUDECODE` to get around that. A wrapper script, or an environment change built from variables, is not seen by the gate (see limits.md).

## Limits

See the control room section of [limits.md](limits.md). The two that matter most: any process running as you can answer an approval (with or without the room), and the room cannot see the plan's usage percentage, so it cannot pause loops at a usage threshold.
