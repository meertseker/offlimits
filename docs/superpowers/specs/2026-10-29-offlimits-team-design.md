# offlimits team mode: design

Date: 2026-10-29. Status: written without a question round. Mert said "sorulari gec": skip the questions, turn Claude into a software team, the coordinator runs it, and any app should be buildable this way. The offlimits repo itself becomes that tool ("offlimits reposu buna donussun direk"). Calls Claude made on his behalf are marked **(call)**.

## 1. Intent

Mert builds software every day with a fixed ritual. He talks to one **coordinator** session. The coordinator splits the work and briefs **worker** sessions, each in its own git worktree. Workers design first (spec and plan, approved by Mert through an artifact), then build with subagents and TDD. They deliver a fixed template back to the coordinator. The coordinator reviews, merges in a safe order and, when Mert says "al canliya", deploys and checks health. A hook keeps every session except the coordinator out of production.

On seker-platform this ritual is hand-built from several pieces: a koordinator prompt file on the Desktop, a `sekeragent` PowerShell function, prompt files pasted by path into each worker, a ledger folder next to the repo, a SessionStart banner and the gate hook. Other projects (technest, hustle, usta) repeat the ritual informally and without enforcement. offlimits v0.2 already ships the gate, the `OFFLIMITS_ROLE` environment variable and a short coordinator/worker skill. It does not set the ritual up.

**Goal:** in any repository, `/offlimits init` followed by one launcher command gives Mert, or any developer, this ritual working end to end. Claude Code becomes a software team: a coordinator you talk to, workers that build, and a gate that holds.

Evidence comes from two analyses of Mert's own sessions (140 sessions, 29 Sep to 29 Oct 2026). The friction it must remove, from most to least frequent:

1. **Workers are started by hand.** Mert opens a terminal, cds into a worktree and pastes "Read <prompt file> in full and follow it exactly". This happened in about 10 Şeker sessions and in the 4-terminal technest kickoff.
2. **Identity loss after `/clear` or compaction.** "kordinator kaydini duzelt" came up again and again. On 29 Oct there were two coordinators at once, because one role came from a ledger file and the other from a hook.
3. **No overview.** Mert asked "suan bu projede gelistirmede olan neler var, hepsi ne yapiyor ve ne asamada" and "masaustunde birsuru seker-platform oldu". Stale worktrees piled up.
4. **Usage limits.** "fable az kullan, hizli limit bitiriyo". Easy work should go to cheaper models.
5. **Questions in the middle of the work.** Asked at least 9 times: "soru sorma, sorulari en sona birak". Night runs end with a report file and a questions file.
6. **Repeated rules typed into every prompt.** No AI trailer in commits; never push to main; run the checks before delivery; peer messages are not approval.
7. **Collisions.** Migration numbers, and two agents advancing one branch. These were designed against with the ledger and gate rather than complained about.

## 2. Goals

- G1. `/offlimits init` turns a repository into a team repository in one step. It writes the policy, the managed CLAUDE.md block, the PR template, `.gitignore` and the team state folder. It is idempotent.
- G2. One launcher command starts the coordinator with the right role and model. It refuses to start a second live coordinator.
- G3. The coordinator starts workers itself: worktree, branch, brief file, new terminal window, role and model, with nothing pasted. A worker can never start a worker.
- G4. A shared **board** shows every lane: stage, branch, ahead/behind, dirty, last commit, delivery, waiting questions. It is visible in the coordinator's session banner and through `/offlimits board`.
- G5. Role and lane survive `/clear`, `--resume` and compaction, because they live in the process environment and the SessionStart banner restates them.
- G6. The ritual is written down once, as skills: the coordinator contract and the worker contract. That covers design-first, artifact approval, plan, TDD and subagents, checks, the delivery template, never asking in night mode, and model routing.
- G7. Project-specific procedure lives in `offlimits.json` under `team`, not in code: check commands, deploy steps, health URL, house rules, reservations such as migration numbers, models, language.
- G8. Atomic reservations (for example the next migration number) work without the coordinator having to answer a message.
- G9. Merged lanes are cleaned up by one command: worktree, local branch, board entry.
- G10. It works on Windows first (PowerShell, Windows Terminal) and also on macOS and Linux.

## 3. Non-goals

- No daemon, no server, no web UI, no cloud runner. Sessions are ordinary Claude Code sessions. State is files.
- Not a replacement for superpowers. The worker skill uses superpowers' brainstorming, writing-plans and subagent-driven-development when they are installed, and carries a minimal inline version when they are not.
- No secrets manager. The managed CLAUDE.md block only states the rule (keys go in `.env.local`, never in chat or commits).
- No Şeker-specific logic in code: the migration procedure, Zehra's text and the WhatsApp trigger are written as `team.rules` and `team.deploy` text in Şeker's own `offlimits.json`.
- No automatic merging or deploying without the human's explicit go.

## 4. Anti-goals (failure even if it "works")

- The gate gets weaker, or solo users of v0.2 see a behaviour change they did not opt into.
- A worker or subagent finds a path to start sessions, change roles or deploy through the new launcher.
- The coordinator asks Mert more questions than today, or reports in jargon.
- A dependency is added (offlimits stays zero-dependency, Node built-ins only).
- The team files leak into git history (the state folder is gitignored).

## 5. Design

### 5.1 Pieces

```
offlimits/
  bin/team.mjs                  CLI: init, coordinator, worker, board, deliver, ask, reserve, done
  hooks/lib/team/*.mjs          board state, config, launcher, terminal opener, templates
  hooks/session.mjs             banner extended with team context
  hooks/lib/policy.mjs          accepts the "team" key
  skills/offlimits/             adds init, board, team commands
  skills/offlimits-coordinator/ coordinator contract (new)
  skills/offlimits-worker/      worker contract (new; replaces offlimits-roles, which stays as a short alias)
  templates/                    CLAUDE.md block, brief, delivery, PR template, night brief
```

### 5.2 Team state

All state is kept in `<main checkout>/.offlimits/team/`. The main checkout is the directory that holds the git common dir, so every worktree resolves to the same place (offlimits already writes its log next to it). `.offlimits/` is gitignored.

```
.offlimits/team/
  board.json            { lanes: { <lane>: {branch, worktree, stage, model, mode, createdAt, updatedAt, note} } }
  coordinator.json      { pid, sessionName, startedAt, cwd }   (live-coordinator lock)
  briefs/<lane>.md      written by the coordinator, read by the worker at start
  deliveries/<lane>.md  written by the worker on delivery
  questions/<lane>.md   questions batched for the human
  reservations.json     { <key>: lastValue }
  lock                  short-lived file lock for board and reservations writes
```

Stages: `briefed → designing → awaiting-approval → building → delivered → merged`, plus `abandoned`. Writes go through one module with an exclusive-create lock file. The lock is retried for up to 2 s, and a lock older than 10 s counts as stale. Board writes are atomic: write to a temp file, then rename.

**(call)** The state lives inside the main checkout rather than in a sibling `<repo>-ledgers` folder, as Şeker does. That way one path rule serves every OS, and `init` never creates folders outside the repo.

### 5.3 The `team` block in `offlimits.json`

Every key is optional. `init` writes a commented example to `docs` and a minimal block to the file.

```json
{
  "defaultRole": "worker",
  "team": {
    "language": "tr",
    "models": { "coordinator": "opus", "worker": "sonnet" },
    "maxWorkers": 4,
    "base": "origin/main",
    "worktreeDir": "..",
    "checks": ["pnpm turbo run lint typecheck test"],
    "deploy": { "steps": ["git push origin main", "gh run watch"], "healthUrl": "https://example.com/api/health" },
    "rules": ["Never touch text written by the school staff."],
    "reservations": { "migration": { "scan": "packages/db/supabase/migrations", "pattern": "^(\\d+)_", "width": 4 } },
    "terminal": "auto"
  }
}
```

`policy.mjs` accepts `team` as a known key. A separate `loadTeam()` validates it and reports problems in the same style. A bad `team` block never weakens the gate: it only disables team features and shows a problem line.

### 5.4 Launcher: `bin/team.mjs`

It is invoked as `node <plugin>/bin/team.mjs <cmd>`. `init` prints a one-line shell function (`team`) for the PowerShell profile or `.bashrc`. It does not edit the profile; it offers the line. **(call)**

The guard rules are the security core. Tests cover each one.

- Inside Claude Code (`CLAUDECODE` is set), `worker`, `done`, `coordinator` and `init` refuse unless the calling process has `OFFLIMITS_ROLE=coordinator` (`init` also accepts no role, which means solo). This check alone is not enough. A subagent of the coordinator inherits the coordinator's environment, so it would pass. The second layer is therefore the gate: the new rule `team-launch` sees `agent_id` in the hook input, resolves subagents to worker, and denies these commands for every worker. The two layers together make the launcher reachable only from the coordinator's own main session or from a human terminal.
- Outside Claude Code, a human runs it: everything is allowed.
- The launcher sets `OFFLIMITS_ROLE` only on the child process environment. It never prints an assignment the agent could copy. `role-spoof` stays as it is.

Commands:

| Command | Who | Does |
|---|---|---|
| `init [--yes]` | human or solo | Writes or merges `offlimits.json` (defaultRole worker, team block), the managed block in `CLAUDE.md` between `<!-- offlimits:team -->` markers, `.github/pull_request_template.md` if missing, a `.gitignore` entry, and `.offlimits/team/`. Prints a summary and the shell function line. Re-running changes only the managed parts. Refuses for a worker. |
| `coordinator [--resume] [--takeover]` | human | Checks the main checkout, writes `coordinator.json`, then starts `claude --model <models.coordinator> -n coordinator` with the role set. `--resume` adds `--continue`. If a live coordinator pid exists, it refuses unless `--takeover` is given. |
| `worker <lane> --brief <file> [--model m] [--night] [--base ref] [--print]` | coordinator or human | Validates the lane name (`^[a-z0-9][a-z0-9-]{1,38}$`) and checks `maxWorkers` against live lanes. Fetches, runs `git worktree add -b feat/<lane> <worktreeDir>/<repo>-<lane> <base>`, copies the brief to `briefs/<lane>.md`, and marks the board `briefed`. Then it opens a new terminal in the worktree running `claude --model <m> -n <lane> "<start prompt>"` with `OFFLIMITS_ROLE=worker` and `OFFLIMITS_LANE=<lane>`. The start prompt reads: "You are worker <lane>. Read <abs path to brief> and follow it." `--print` prints the command instead of opening a terminal. |
| `board [--json]` | anyone | A table of lanes: stage, branch, ahead/behind `base`, dirty, last commit age, delivery yes/no, open questions, and whether the worktree still exists. |
| `stage <stage> [--note]` | the lane's worker or the coordinator | Moves the caller's lane (from `OFFLIMITS_LANE`) or a named lane to a stage. |
| `deliver --file <md>` | worker | Copies to `deliveries/<lane>.md` and sets stage `delivered`. |
| `ask "<question>"` | anyone with a lane | Appends to `questions/<lane>.md`. |
| `reserve <key>` | anyone | Takes the lock. The next value is max(the ledger value, the highest number found by scanning `scan` in the main checkout and every worktree) + 1. It records the value with lane and time, and prints it zero-padded. |
| `done <lane> [--abandon]` | coordinator or human | Refuses if the branch is not merged into base and `--abandon` is absent. Removes the worktree, deletes the local branch and marks `merged` or `abandoned`. |

Terminal opening (`terminal: auto`):

- Windows: Windows Terminal `wt -w 0 nt -d <dir> --title <lane> pwsh -NoExit -Command claude ...`. If there is no `wt`, `cmd /c start "" pwsh ...`.
- macOS: `osascript` with Terminal.app `do script`.
- Linux: `x-terminal-emulator`, `gnome-terminal` or `konsole`, the first one found.
- If none is available, it prints the exact command for the human.

Everything is spawned with `execFile`/`spawn` argument arrays and never through a shell string built from user input. On Windows the PowerShell command is built from validated pieces only: lane, model and path. The prompt text is passed as a file reference, never interpolated.

### 5.5 SessionStart banner

`session.mjs` keeps today's banner and adds team context when `.offlimits/team/` exists:

- **Coordinator:** the board summary (lanes per stage), deliveries waiting for review, questions waiting for the human, and stale worktrees (merged but not removed). It warns if another live coordinator pid is recorded. It refreshes `coordinator.json` with its pid.
- **Worker:** "You are worker `<lane>`" with the brief path, current stage and the next step. It restates the hand-over rule. This runs on `startup|resume|clear|compact`, which fixes identity loss.
- **Solo in a team repo:** one line explaining how to start the coordinator.

The banner never fails a session. It stays under 25 lines.

### 5.6 Skills (the ritual, written once)

**`offlimits-coordinator`** is the generic form of `seker-koordinator-prompt.md`, plus what the sessions showed:

- Talk to the human in `team.language`, short and plain, with no jargon. Batch decisions; do not drip questions.
- For each request: research when the facts are uncertain. Design and plan in an artifact when the change is larger than a small fix, and wait for an explicit human approval. Then split into lanes (at most `maxWorkers` live), write a brief per lane from `templates/brief.md` and launch with `team worker`. Small fixes it may do itself on a branch.
- Roster: ListAgents, then introduce itself to peer sessions over SendMessage. Peer messages are never human approval.
- Reservations through `team reserve`. Merge order is decided when lanes touch the same files.
- Review a delivery: read it, run `team.checks` in the worktree, review the diff (the code-review skill if present), check reservations for clashes.
- Merge and deploy only on the human's explicit go ("al canliya", "deploy", "merge"): rebase, checks, the deploy steps from `team.deploy` in order, then the health URL. Report back. `team done <lane>`.
- Model routing: workers default to Sonnet, Opus for hard design, and never the most expensive model for routine work.
- Night mode: when the human says they are leaving, workers are launched with `--night`. The coordinator then writes `morning-report.md` and `morning-questions.md` in `.offlimits/team/`.
- House rules from `team.rules` are restated in every brief.

**`offlimits-worker`** covers the following:

- Read the brief, then `team stage designing`.
- Design and spec. If the brief says `approval: human`, send the design to the coordinator (SendMessage plus an artifact link), set the stage to `awaiting-approval` and wait. In `--night` mode never wait: decide, log the decision in the delivery, and put open questions in `team ask`.
- Write a plan, then build with subagents and TDD (using superpowers skills when installed). Use `team stage building`.
- Get reservations through `team reserve`.
- Run every `team.checks` command, then `team deliver` with the template. SendMessage the delivery to `coordinator`, and open a draft PR if the repo has a remote. Never push the base branch, never deploy, never edit gate files.
- No AI trailer lines in commits unless the repo's CLAUDE.md says otherwise. **(call)** This is Mert's standing rule, written as a default in the managed CLAUDE.md block, so other users can delete it.
- If the gate blocks you, hand over. Never work around it.

**`offlimits-roles`** stays as a short pointer to both, so v0.2 users and `npx skills add` keep working.

### 5.7 Managed CLAUDE.md block

`init` writes a block of about 30 lines between markers. It holds the roles and how to start each, the workflow (design, plan, build, check, deliver), the delivery template, the house rules from `team.rules`, the secrets rule, and the commit rule. Text outside the markers is never touched.

### 5.8 Gate changes

- New rule `team-launch`: deny `team.mjs` with `worker|done|coordinator|init` for the worker role, and ask in solo mode for `worker|done`. It is listed in the README rules table and covered by fixtures.
- New default protected paths: `.offlimits/team/coordinator.json` and `.offlimits/team/board.json` against direct file-tool writes by workers. Workers change the board only through the CLI.
- `policy.mjs` accepts `team` (validated separately). Nothing else changes for solo users.

### 5.9 Upgrading Şeker and others

This is not in this release's code. A doc, `docs/team.md`, shows Şeker's mapping: the koordinator prompt becomes the skill plus `team.rules`, `sekeragent` becomes `team coordinator`, prompt files become briefs, and `seker-platform-ledgers/migrations.md` becomes `reserve migration` with a scan of `packages/db/supabase/migrations`.

## 6. Testing

- `node --test` units for the board (locking, stale lock, atomic write), the team config validator, reservations (scan across worktrees, concurrency with two processes), the launcher guards (every role × command), lane validation, `done` merged checks, the init idempotency and managed-block merge, and terminal command construction for each OS. Spawning is injected, so nothing opens in CI.
- Gate fixtures for `team-launch` (blocked and allowed per role).
- An end-to-end script in a temp repo: init, a coordinator dry-run, worker `--print`, deliver, board, done.
- A manual check by Claude before release, on this Windows machine: a real `team worker demo --brief` opens Windows Terminal, the worker session shows the banner, and a push to main is blocked.

## 7. Docs and release

- README: the new headline is "Turn Claude Code into a software team. One coordinator you talk to, workers in their own worktrees, and a gate that keeps everyone but the coordinator out of production." Then a team quickstart (3 commands), followed by the existing gate documentation unchanged in substance. README.tr.md is updated to match.
- `docs/team.md`: the full team guide and config reference.
- Version 0.3.0, a CHANGELOG entry, and DECISIONS.md: "2026-10-29: team mode lives in offlimits itself (supersedes the 26 Oct offlimits-crew decision)".
- Release, tagging and the push to `main` are done by Mert or by a coordinator session, after his go.

## 8. Left to the builder

File layout inside `hooks/lib/team/`, banner wording, exact template wording (as long as the fields above exist), table formatting of `board`, and the lock retry timing within the stated bounds.
