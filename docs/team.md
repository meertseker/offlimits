# Team mode

Team mode turns a repository into a small software team made of ordinary Claude Code sessions: one **coordinator** you talk to, and **workers**, each in its own git worktree on its own branch. The gate (the rest of offlimits) keeps every session except the coordinator out of production. There is no daemon, server or cloud runner: state is plain files.

## Quickstart

```sh
claude plugin install offlimits --marketplace meertseker/offlimits
/offlimits init                       # inside Claude; prints the `team` shell function
                                      # add that printed line to your shell profile
team coordinator                      # in a terminal, then talk to it
```

`<plugin>` is the folder the plugin is installed in. You do not need to know it for the first step: run `/offlimits init` inside a Claude Code session in the repository. The skill locates the plugin, runs `init` and prints the `team` shell function below with the absolute path filled in. Add it to your profile, then run `team coordinator` from a terminal. Afterwards the SessionStart banner prints the same path on its `team CLI:` line. There is no npm package, so the launcher is always `node <plugin>/bin/team.mjs`.

`init` prints a one-line shell function for you to add to your profile (offlimits never edits it):

```sh
# bash / zsh
team() { node "<plugin>/bin/team.mjs" "$@"; }
```

```powershell
# PowerShell
function team { node "<plugin>\bin\team.mjs" @args }
```

The plugin path contains the plugin version, so after an update run `init` again and replace the line. Agents are not affected: the banner of every session states the exact current command.

Run `team coordinator` from the main checkout (not a worktree). The coordinator session starts with the role set by the launcher and the model from `team.models.coordinator`.

## A day in the life

1. You tell the coordinator what you want. For anything bigger than a small fix it writes a design and a plan and asks you to approve them.
2. It writes a brief per lane from the brief template: goal, files to read, acceptance, your house rules, reservations, mode (day or night) and approval.
3. It runs `team worker <lane> --brief <file>`. A new terminal opens in a fresh worktree, with the worker role, the lane name and the worker model already set. The worker is told to read its brief.
4. Each worker designs, plans, builds with tests and subagents, runs `team.checks`, commits on its lane branch and runs `team deliver --file <delivery.md>`.
5. The coordinator reads each delivery, reviews, merges lanes into the base branch in a safe order and runs `team done <lane>` to clean up.
6. You say "deploy". The coordinator runs `team.deploy.steps` and checks `team.deploy.healthUrl`.

At any time `team board` shows every lane, its stage, how far it is ahead of or behind the base, whether the worktree is dirty, whether a delivery is waiting and how many questions are queued for you.

Stages: `briefed`, `designing`, `awaiting-approval`, `building`, `delivered`, `merged`, `abandoned`.

## Commands

Run as `team <command>` (or `node <plugin>/bin/team.mjs <command>`). Exit codes: 0 done; 1 failed (git, an unsafe value, an unmerged or dirty lane); 2 usage error or refused state (bad argument, unknown lane, lane already live, `maxWorkers` reached); 3 refused by the role guard; 4 a coordinator is already running.

| Command | Does |
|---|---|
| `init [--language xx]` | Merges `offlimits.json` (`defaultRole: worker`, a `team` block), the managed block in `CLAUDE.md` between `<!-- offlimits:team:start -->` and `<!-- offlimits:team:end -->`, `.github/pull_request_template.md` if missing, the `.offlimits/` line in `.gitignore`, and `.offlimits/team/`. Prints what changed and the shell function. Re-running changes only the managed parts. |
| `coordinator [--resume] [--takeover] [--print]` | Starts `claude --model <models.coordinator> -n coordinator` in the main checkout with the coordinator role. `--resume` adds `--continue`. Refuses (exit 4) while another live coordinator holds `coordinator.json`, unless `--takeover`. `--print` prints the command instead of running it. |
| `worker <lane> --brief <file> [--model m] [--night] [--base ref] [--print]` | Checks the lane name and `maxWorkers`, creates the worktree and branch `feat/<lane>` from the base, stores the brief, marks the lane `briefed` and opens a terminal running Claude with the worker role. `--night` prepends `mode: night` to the brief. `--print` prints the command instead of opening a terminal. |
| `board [--json]` | Lists lanes: stage, ahead/behind, dirty, last commit age, delivery, questions, missing worktree. |
| `stage <stage> [--lane x] [--note t]` | Moves a lane to a stage. A worker moves its own lane; `--lane` is honoured only for the coordinator or a human terminal. |
| `deliver --file <md>` | Copies the file to `deliveries/<lane>.md` and sets the stage `delivered`. |
| `ask "<question>"` | Appends a question to `questions/<lane>.md` for the human. |
| `reserve <key>` | Prints the next number for a reservation from `team.reservations` (see below). |
| `done <lane> [--abandon]` | Removes the worktree and local branch and marks the lane `merged`. Refuses a lane with uncommitted changes, a lane with no commits since it was created, and a lane not merged into the base. `--abandon` drops any of these and marks it `abandoned`. |
| `help` | Prints usage. |

`done` decides "merged" from git ancestry, so merge lanes with a merge commit or a fast-forward, never a squash. A squash-merged lane looks unmerged; close it with `--abandon` after checking it landed.

### Who may run what

Inside Claude Code the launcher reads `CLAUDECODE` and the session's role. A subagent of the coordinator inherits the coordinator's environment, so the CLI check alone would let it through; the gate rule `team-launch` closes that gap by treating subagents as workers. Outside Claude Code (a human terminal) everything is allowed.

| Command | Human terminal | Coordinator | Worker (or subagent) | Solo inside Claude |
|---|---|---|---|---|
| `init` | yes | yes | no (the gate says: re-run it from a terminal with `team init`) | yes |
| `coordinator`, `worker`, `done` | yes | yes | no | no (the gate asks) |
| `board`, `reserve` | yes | yes | yes | yes |
| `ask` | yes | yes | yes (own lane) | no (needs a lane) |
| `stage`, `deliver` | yes | yes | yes (own lane) | no (needs a lane) |

After the first `init`, `defaultRole: worker` makes your own plain `claude` session in the repository a worker, so `/offlimits init` there is denied the second time with "init rewrites team configuration; re-run it from a terminal with: team init". Do exactly that.

`stage`, `deliver` and `ask` all need a lane: `OFFLIMITS_LANE` (set for workers), or `--lane` from the coordinator or a human terminal (`ask` takes the lane the same way). Solo sessions have none.

## Configuration

Everything lives under `team` in `offlimits.json`, and every key is optional. A bad value never weakens the gate: the key is ignored, the default stays and a problem line is printed. A `team` that is not an object stops `worker` and `coordinator` until it is fixed.

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
    "rules": ["Never edit generated files in dist/."],
    "reservations": { "migration": { "scan": "packages/db/supabase/migrations", "pattern": "^(\\d+)_", "width": 4 } },
    "terminal": "auto",
    "permissionMode": "default"
  }
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `language` | string | `"en"` | Language the sessions talk to you in. |
| `models.coordinator` | string | `"opus"` | Model of the coordinator session. Letters, digits, `.`, `_`, `-` only. |
| `models.worker` | string | `"sonnet"` | Default worker model; `--model` overrides it per lane. |
| `maxWorkers` | integer 1 to 16 | `4` | Most live lanes at once. |
| `base` | string or null | `null` | Ref lanes start from and merge into. `null` picks the repository's default branch. |
| `worktreeDir` | string | `".."` | Where worktrees go, relative to the main checkout. They are named `<repo>-<lane>`. |
| `checks` | string array | `[]` | Commands a worker runs before delivering and the coordinator re-runs before merging. |
| `deploy.steps` | string array | `[]` | Commands the coordinator runs, in order, when you say deploy. |
| `deploy.healthUrl` | string or null | `null` | URL the coordinator checks after deploying. |
| `rules` | string array | `[]` | House rules, written into the managed `CLAUDE.md` block and restated in every brief. |
| `reservations.<key>` | object | none | `scan` (folder, relative to each checkout), `pattern` (regex with exactly one capture group, matched against file names), `width` (integer 1 to 12, default 4). |
| `terminal` | `"auto"` or `"none"` | `"auto"` | `none` always prints the command instead of opening a terminal. |
| `permissionMode` | `"default"`, `"acceptEdits"` or `"bypassPermissions"` | `"default"` | Claude Code permission mode of the coordinator and worker sessions. Any value but `default` is passed as `--permission-mode <mode>`. See Unattended workers. |

Lane names match `^[a-z0-9][a-z0-9-]{1,38}$`. Model names (`models.coordinator`, `models.worker`, `--model`) must match `^[A-Za-z0-9][\w.-]*$`, so a value such as `opus[1m]` is refused when a session starts; use a plain alias or a full model id. Unknown `team` keys are reported and not used.

### Reservations

`team reserve migration` scans `scan` in the main checkout and every worktree, takes the highest number the pattern captures, compares it with the recorded ledger value and prints the next one, zero-padded to `width` and recorded with the lane and time. Two workers asking at the same moment get different numbers. Nobody waits for the coordinator to answer.

## State

Team state lives in the main checkout, in `.offlimits/team/` (gitignored by `init`), not in a sibling folder:

```
.offlimits/team/
  board.json            lanes, stages, branches, worktrees, models
  coordinator.json      pid and start time of the live coordinator
  reservations.json     last number handed out per key
  lock, lock.break      the advisory file lock and its breaker
  briefs/<lane>.md      the brief each worker was started with
  drafts/<lane>.md      briefs the coordinator is still writing
  deliveries/<lane>.md  what each worker handed over
  questions/<lane>.md   questions queued for you
```

State is written under a file lock: a timestamped token, a breaker lock for stale locks and a token-checked release. Workers in other worktrees reach the same folder because the launcher resolves the main checkout.

## Night mode

Tell the coordinator you are leaving. It sends you one combined message with the plan and, per lane, two questions: approve, and merge tonight. Whatever the answer, or if you do not answer, it still launches every lane with `--night` and `approval: none`, so work is not parked. Night workers never ask and never wait: they take conservative choices, log every decision in their delivery and queue questions with `team ask`. Nothing is merged or deployed without your explicit go. In the morning you read the board, the deliveries and the questions.

If a terminal could not be opened, the launcher only prints the command; the coordinator is told to say so before you leave.

### Unattended workers

Unattended or night workers need `team.permissionMode` set to `acceptEdits` or `bypassPermissions`: in the default mode a fresh worker session stops at its first permission prompt and waits for someone to answer it. The gate is what keeps that safe, because it runs in every permission mode and still denies a worker anything that touches production. With `permissionMode` left at `default`, the coordinator warns you before you leave.

## From a hand-built setup to team mode

A production school-management SaaS ran this ritual by hand for months: a coordinator prompt on the desktop, a shell function that started the coordinator, prompt files pasted into each worker by path, a ledger folder next to the repo and a banner. The mapping to team mode:

| Hand-built piece | Team mode |
|---|---|
| Coordinator prompt file | The coordinator skill plus `team.rules` |
| Shell function that starts the coordinator | `team coordinator` |
| Prompt files pasted into workers | Briefs, started with `team worker <lane> --brief` |
| Ledger folder next to the repo | `.offlimits/team/` and `team board` |
| Migration number ledger | `team reserve migration`, scanning the migrations folder |
| Hook and role environment variable | Unchanged: the gate |

To migrate: run `init`, move the house rules into `team.rules`, the check and deploy commands into `team.checks` and `team.deploy`, and add a `migration` reservation. Keep the old hook and the plugin side by side for a week before removing the hook.

## Limits

Team mode inherits every limit of the gate (see [limits.md](limits.md)) and adds the team-mode limits listed there: the `team worker` false positive, the launcher's reliance on `CLAUDECODE`, the advisory lock, terminal support and refused repository paths.
