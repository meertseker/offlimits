# offlimits v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `offlimits` v0.1.0: a zero-dependency Claude Code plugin whose PreToolUse hook keeps coding agents out of production, developed in this repo with the coordinator/worker discipline the plugin itself enforces.

**Architecture:** Pure decision logic in `hooks/lib/*.mjs` (no I/O, fully unit-tested with `node --test`), thin entry points `hooks/gate.mjs` and `hooks/session.mjs` that read stdin, call `decide()`, and translate the decision into the Claude Code hook protocol. Policy from `offlimits.json` merged over defaults; role from the environment and hook input only. Skills are markdown that call small Node scripts. The repo is its own first user: `.claude/settings.json` wires the in-repo hooks, so every session that develops offlimits is gated by offlimits.

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, `node:` built-ins only, `node --test`), Claude Code plugin format (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `skills/*/SKILL.md`), GitHub Actions, PowerShell 7 for the dev scripts. No npm dependencies, no lockfile.

**Spec:** `docs/superpowers/specs/2026-10-25-offlimits-design.md`

## Global Constraints

- Only `node:` built-ins; `package.json` has no `dependencies`/`devDependencies`; no lockfile is committed. Node `>=20`.
- Every file in the repo under 256 KiB; plugin at repo root; hook commands are plain `node ${CLAUDE_PLUGIN_ROOT}/hooks/<file>.mjs` (plugin) or `node "${CLAUDE_PROJECT_DIR}/hooks/<file>.mjs"` (this repo's own `.claude/settings.json`).
- All messages, docs and code comments in English; only `README.tr.md` is Turkish.
- Rule ids are exactly the spec's: `git-push-protected`, `git-branch-protected`, `gh-write`, `supabase-remote`, `remote-db`, `db-migrate`, `deploy`, `publish`, `role-spoof`, `protected-file`, `supabase-mcp`, `vercel-mcp`, `mcp-write`.
- Decision type everywhere: `{ action: 'allow' | 'deny' | 'ask', rule?: string, reason?: string }`.
- Roles are exactly `'coordinator' | 'worker' | 'solo'`.
- Tests: `node --test tests/` from the repo root; test files `tests/<module>.test.mjs`; Windows paths (`C:\…`, `/c/…`) covered where paths are compared.
- Commits: `feat|fix|test|docs|ci|chore(scope): message`, English. The coordinator commits; implementers do not run git commands (the gate blocks pushes anyway).

## Review Focus

1. Malformed or empty hook stdin: worker → exit 2 (fail-closed), solo → exit 0 plus log line, coordinator → exit 0. Test in Task 6.
2. Role spoofing inside the command (`OFFLIMITS_ROLE=coordinator git push origin main`, `$env:OFFLIMITS_ROLE='coordinator'`) and an edit to `.claude/settings.json` or `offlimits.json` by a worker: deny. Tests in Task 5.
3. Nested shells and substitutions (`bash -c "git push origin main"`, `pwsh -Command "git push"`, `echo $(git push origin main)`): deny. Test in Task 2 and Task 4.
4. `git push` with no refspec while on `main` in a *different* directory (`git -C ../other push`): branch must be read from that directory. Test in Task 4 with an injected `currentBranch`.
5. Solo user with Supabase MCP pointed at a dev project: `execute_sql` insert must *ask*, not deny, and `list_tables` must be silent. Test in Task 4.

---

## File structure

```
.claude-plugin/plugin.json  .claude-plugin/marketplace.json
.claude/settings.json                 dev wiring: superpowers plugin + in-repo hooks
hooks/hooks.json  hooks/gate.mjs  hooks/session.mjs  hooks/status.mjs  hooks/explain.mjs  hooks/selftest.mjs
hooks/lib/input.mjs      readStdin(): object | null
hooks/lib/shell.mjs      segments(), unwrap(), stripAssignments(), tokens()
hooks/lib/policy.mjs     DEFAULT_POLICY, loadPolicy(root): {policy, problems[]}
hooks/lib/role.mjs       resolveRole(input, env, policy): Role
hooks/lib/git.mjs        repoRoot(cwd), currentBranch(cwd), ledgerRoot(cwd)   (execFileSync, injectable)
hooks/lib/paths.mjs      normalizeRel(root, p), globMatch(pattern, rel)
hooks/lib/rules.mjs      decide(input, ctx): Decision   — composes the rule modules
hooks/lib/rules/shell-rules.mjs   git, gh, supabase, remote-db, db-migrate, deploy, publish, role-spoof
hooks/lib/rules/file-rules.mjs    protected-file (Write/Edit tools + Bash writes)
hooks/lib/rules/mcp-rules.mjs     supabase-mcp, vercel-mcp, mcp-write
hooks/lib/format.mjs     denyMessage(decision, role), askReason(decision), banner(facts)
hooks/lib/log.mjs        appendLog(root, entry), readLog(root)
skills/offlimits/SKILL.md  skills/offlimits-roles/SKILL.md
tests/*.test.mjs  tests/fixtures/cases.json
offlimits.example.json  offlimits.json (this repo's own policy)
README.md  README.tr.md  CHANGELOG.md  SECURITY.md  CONTRIBUTING.md  LICENSE  CLAUDE.md  DECISIONS.md
docs/incidents.md  docs/limits.md  docs/policy.md  docs/ledger/lanes.md  docs/superpowers/{specs,plans}/
.github/workflows/ci.yml  .github/pull_request_template.md  .github/ISSUE_TEMPLATE/bypass.md
scripts/worker.ps1  scripts/coordinator.ps1
assets/demo.svg
package.json  .gitignore  .gitattributes  .nvmrc
```

---

### Task 1: Repository skeleton and dev system

**Files:** Create `package.json`, `.gitignore`, `.gitattributes`, `.nvmrc`, `LICENSE`, `CLAUDE.md`, `DECISIONS.md`, `docs/ledger/lanes.md`, `.github/pull_request_template.md`, `.claude/settings.json`, `offlimits.json`, `scripts/worker.ps1`, `scripts/coordinator.ps1`; Test `tests/repo.test.mjs`

**Interfaces:**
- Produces: `package.json` `{ "name": "offlimits", "version": "0.1.0", "type": "module", "engines": { "node": ">=20" }, "scripts": { "test": "node --test tests/", "validate": "claude plugin validate --strict .", "selftest": "node hooks/selftest.mjs" } }` and nothing else that installs. `.claude/settings.json`: `enabledPlugins: {"superpowers@claude-plugins-official": true}`; hooks `SessionStart` (matcher `startup|resume|clear|compact`) → `node "${CLAUDE_PROJECT_DIR}/hooks/session.mjs"`; `PreToolUse` (matcher `Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*`) → `node "${CLAUDE_PROJECT_DIR}/hooks/gate.mjs"`; both `"shell": "bash"`, `timeout: 10`. `offlimits.json` for this repo: `{ "protectedBranches": ["main"], "protectedPaths": [".claude/**", "offlimits.json", ".github/workflows/**"] }`.
- `CLAUDE.md` (≤ 120 lines, English) sections: Roles (`OFFLIMITS_ROLE=coordinator` merges, tags, releases; everyone else is a worker on `feat/<lane>` in `../offlimits-<lane>`, opens a draft PR on first commit, never pushes `main`; if the gate blocks you, hand over, do not work around), Workflow (brainstorm → spec in `docs/superpowers/specs/` → plan in `docs/superpowers/plans/` → subagent-driven development, TDD per task), Before delivery (`node --test tests/`, `node hooks/selftest.mjs`, `claude plugin validate --strict .`), Delivery template (a ```delivery block identical to the PR template), Code rules (built-ins only, every rule has a deny and an allow test, rule ids from the spec, English messages, no network, no telemetry), Where state lives (`DECISIONS.md` pending/decided, `docs/ledger/lanes.md` file ownership, open PRs), Compact instruction.
- PR template fields: `lane`, `branch / sha`, `touched`, `checks: tests ✓ selftest ✓ validate ✓`, `new dependency: none (must stay none)`, `limits added to docs/limits.md`, `risks`, `decision needed from Mert`, `Tasks` checklist.
- `scripts/worker.ps1 -Lane <name> [-Base origin/main] [-Model sonnet|opus] [-NoLaunch] [-DryRun]`, `-Remove <name>`: `git fetch origin`, `git worktree add -b feat/<name> ../offlimits-<name> origin/main`, `$env:OFFLIMITS_ROLE='worker'`, `claude --model <model> -n <name>`; name must match `^[a-z0-9][a-z0-9-]{1,38}$`. `scripts/coordinator.ps1 [-DryRun]`: `$env:OFFLIMITS_ROLE='coordinator'`, `claude --model claude-opus-5-5 -n coordinator`, warns if branch is not `main`.

- [ ] **Step 1: Write the failing test** `tests/repo.test.mjs`: `package.json has no dependencies and node --test script`; `settings.json wires both hooks with the spec matchers`; `CLAUDE.md delivery block equals PR template` (``` ```delivery ``` block trimmed equals template trimmed); `CLAUDE.md under 120 lines`; `.gitattributes forces LF`; `offlimits.json parses and protects .claude/**`.
- [ ] **Step 2: Run** `node --test tests/` → FAIL (files missing).
- [ ] **Step 3: Create the files** per Interfaces. `.gitignore`: `.offlimits/`, `node_modules/`, `*.log`, `.DS_Store`. `.gitattributes`: `* text=auto eol=lf`. `.nvmrc`: `22`. `LICENSE`: MIT, "Copyright (c) 2026 Mert Seker". `DECISIONS.md`: `## Pending` / `## Decided` with the eight decisions from the Turkish strategy doc recorded as decided (name, personal account, MIT, Supabase rules in core with ask fallback, fail-closed in team mode, env-only role, subagents default to worker, Şeker is the first real user).
- [ ] **Step 4: Run** `node --test tests/` → PASS.
- [ ] **Step 5: Commit** `chore(repo): scaffold offlimits with dev system, CLAUDE.md and PR template`

### Task 2: Shell parsing

**Files:** Create `hooks/lib/shell.mjs`; Test `tests/shell.test.mjs`

**Interfaces:**
- Produces: `segments(command: string): string[]` — split on `;`, `&&`, `||`, `|`, `\r?\n` outside quotes; each segment trimmed, empty dropped. `unwrap(segment: string): string[]` — returns `[segment, ...inner]` where inner are the quoted bodies of `bash -c`, `sh -c`, `zsh -c`, `pwsh -c|-Command`, `powershell -c|-Command`, `cmd /c`, `eval`, plus every `$(...)` and backtick body, one level, each inner body itself passed through `segments`. `stripAssignments(segment: string): { assignments: string[], rest: string }` — leading `NAME=value` pairs (and PowerShell `$env:NAME = value;` prefix). `tokens(segment: string): string[]` — shell-style tokenisation honouring single/double quotes, dropping the quotes. `expand(command: string): string[]` — convenience: `segments` → `unwrap` → flattened unique list of segments to check.

- [ ] **Step 1: Write the failing test** cases: `segments('npm test && git push origin main')` → 2; `segments('echo "a;b"')` → 1; `segments("a | b || c\nd")` → 4; `unwrap('bash -c "git push origin main"')` includes `git push origin main`; `unwrap("pwsh -Command 'git push'")` includes `git push`; `unwrap('echo $(git push origin main)')` includes `git push origin main`; backticks likewise; `stripAssignments('OFFLIMITS_ROLE=coordinator git push')` → `{assignments:['OFFLIMITS_ROLE=coordinator'], rest:'git push'}`; `tokens('git -C "my dir" push')` → `['git','-C','my dir','push']`; `expand('cd x && bash -c "git push origin main"')` contains both the outer and the inner segment.
- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Implement** with a single character-scanner for quotes (no regex splitting inside quotes). - [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shell): add quote-aware segmenting and nested-shell unwrapping`

### Task 3: Policy, role, git facts, paths

**Files:** Create `hooks/lib/policy.mjs`, `hooks/lib/role.mjs`, `hooks/lib/git.mjs`, `hooks/lib/paths.mjs`; Test `tests/policy.test.mjs`, `tests/role.test.mjs`, `tests/paths.test.mjs`

**Interfaces:**
- Produces: `DEFAULT_POLICY` (spec §Policy file values; `production: {mcpServers:[], projectRefs:[], hosts:[]}`, `extraDeny: []`, `allow: []`, `trustedAgentTypes: []`, `roleEnv: 'OFFLIMITS_ROLE'`, `onError: 'auto'`). `loadPolicy(root: string | null, readFile = fs.readFileSync): { policy: Policy, source: 'default' | string, problems: string[] }` — reads `<root>/offlimits.json`; invalid JSON → defaults + problem `offlimits.json: invalid JSON (<msg>)`; unknown key → problem `offlimits.json: unknown key "<k>"` (key ignored); wrong type → problem and default for that key; `protectedBranches` and `protectedPaths` **replace** defaults when given, `production.*` arrays merge.
- `resolveRole(input: object | null, env: NodeJS.ProcessEnv, policy: Policy): 'coordinator' | 'worker' | 'solo'` — env value trimmed lowercased; `coordinator` only when `!input?.agent_id || policy.trustedAgentTypes.includes(input.agent_type)`; coordinator env with `agent_id` → `worker`; env `worker` → `worker`; `agent_id` present with no env → `worker`; else `solo`.
- `git.mjs`: `repoRoot(cwd): string | null` (`git rev-parse --show-toplevel`), `commonRoot(cwd): string | null` (parent of `--git-common-dir`, absolute), `currentBranch(cwd): string` (`--abbrev-ref HEAD`, `''` on error). All take an optional `exec = execFileSync` for tests.
- `paths.mjs`: `normalizeRel(root: string, p: string): string` — absolute or relative input, `\`→`/`, Git Bash `/c/…` → `C:/…`, case-insensitive drive letter, returns path relative to root with `/`, or the normalised absolute path if outside root. `globMatch(pattern: string, rel: string): boolean` — supports `**` (any depth), `*` (within a segment), `?`; patterns ending in `/**` also match the directory itself.

- [ ] **Step 1: Write the failing tests** — policy: defaults when file missing; invalid JSON → defaults + problem; unknown key → problem; `protectedBranches: ["release"]` replaces; `production.mcpServers: ["supabase"]` merges; `onError: "nonsense"` → problem + `auto`. role: table of 8 rows from the Interfaces bullet including `' Coordinator '` → coordinator and `{agent_id:'x', agent_type:'Explore'}` with `trustedAgentTypes:['Explore']` → coordinator. paths: `normalizeRel('C:/repo','C:\\repo\\.claude\\settings.json')` → `.claude/settings.json`; `normalizeRel('/c/repo','/c/repo/offlimits.json')` → `offlimits.json`; `globMatch('.claude/hooks/**','.claude/hooks/a/b.mjs')` true; `globMatch('.claude/**','.claude')` true; `globMatch('*.json','a/b.json')` false.
- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Implement.** - [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(core): add policy loading, role resolution, git facts and path matching`

### Task 4: Shell and MCP rules

**Files:** Create `hooks/lib/rules/shell-rules.mjs`, `hooks/lib/rules/mcp-rules.mjs`, `hooks/lib/rules.mjs`; Test `tests/shell-rules.test.mjs`, `tests/mcp-rules.test.mjs`, `tests/rules.test.mjs`, `tests/fixtures/cases.json`

**Interfaces:**
- Consumes: Task 2 `expand`, `stripAssignments`, `tokens`; Task 3 `Policy`, roles.
- Produces: `decide(input: HookInput, ctx: { role: Role, policy: Policy, currentBranch: (dir: string) => string, cwd: string, repoRoot: string | null }): Decision`. `coordinator` → `{action:'allow'}` before any rule runs. Shell rules: `checkSegment(segment: string, ctx): Decision | null` in `shell-rules.mjs` applying, in order: `allow` regexes (skip), `role-spoof`, `git-push-protected`, `git-branch-protected`, `gh-write`, `supabase-remote`, `remote-db`, `db-migrate` (returns `ask` when `ctx.role === 'solo'`, `deny` for worker), `deploy`, `publish`, `extraDeny`. `checkMcp(toolName: string, toolInput: object, ctx): Decision | null` in `mcp-rules.mjs`: `supabase-mcp`, `vercel-mcp`, `mcp-write`; for `supabase-mcp`/`vercel-mcp` writes, `deny` when the server is listed in `production.mcpServers` or role is worker, otherwise `ask`; `mcp-write` always `deny`. `rules.mjs` dispatches by `tool_name`: `Bash`/`PowerShell` → `expand(command)` and first non-null `checkSegment`; `mcp__*` → `checkMcp`; file tools → Task 5's `checkFileTool`; Bash segments also go through Task 5's `checkBashWrite`. Every deny/ask carries `rule` and a one-sentence `reason` naming the matched text.
- `tests/fixtures/cases.json`: array of `{ name, tool_name, tool_input, role, expect: 'allow'|'deny'|'ask', rule? , branch? }` — this file is also consumed by the self-test (Task 7); minimum 40 cases covering every rule's deny and allow side.

- [ ] **Step 1: Write the failing tests** — `rules.test.mjs` runs every fixture through `decide` with a stub `currentBranch` returning `case.branch ?? 'feat/x'`. Fixtures must include at least: `git push origin main` deny; `git push origin feat/x` allow; `git push` on branch `main` deny; `git push` on `feat/x` allow; `git -C ../other push` with stub returning `main` for `../other` deny; `git push origin HEAD:main`, `+main`, `:main`, `--delete main`, `--all`, `--mirror`, `--force origin main` deny; `git push origin main --dry-run` deny (documented, conservative); `git branch -D main` deny; `git branch -d feat/x` allow; `gh pr merge 12` deny; `gh pr view 12` allow; `gh api -X DELETE repos/a/b/rulesets/1` deny; `gh api repos/a/b/rulesets` allow; `supabase db push` deny; `supabase db reset` (no `--linked`) allow; `supabase start` allow; `psql postgres://u:p@db.example.com/x -c 'select 1'` deny; `psql -h localhost` allow; `psql $DATABASE_URL` deny; `prisma migrate deploy` solo → ask, worker → deny; `prisma migrate dev` allow; `vercel --prod` deny; `vercel` allow; `vercel env ls` allow; `terraform plan` allow; `terraform apply` deny; `kubectl get pods` allow; `kubectl apply -f x` deny; `npm publish` deny; `npm test` allow; `docker compose -f /opt/app/compose.yml up -d` deny; `docker compose up -d` allow; `OFFLIMITS_ROLE=coordinator git push origin main` deny with rule `role-spoof`; `bash -c "git push origin main"` deny; `echo $(git push origin main)` deny; `git push origin main` with `allow: ["^git push origin main$"]` allow; `echo hi` with `extraDeny: [{pattern:"^echo", reason:"no echo"}]` deny; coordinator role with `git push origin main` allow. `mcp-rules.test.mjs`: `mcp__supabase__list_tables` allow; `mcp__supabase__execute_sql {query:'select 1'}` allow; `… {query:'INSERT INTO t …'}` solo → ask, worker → deny, solo with `production.mcpServers:['supabase']` → deny; `mcp__supabase__apply_migration` solo → ask; `mcp__plugin_vercel_vercel__list_projects` allow; `mcp__plugin_vercel_vercel__create_deployment` solo → ask; `mcp__acme__get_thing` with `production.mcpServers:['acme']` allow; `mcp__acme__update_thing` same policy → deny; `mcp__acme__update_thing` without policy → allow; `mcp__x__do {project_ref:'abc'}` with `projectRefs:['abc']` → deny.
- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Implement** each rule as `{ id, test(segment, tokens, ctx) → reason | null }` in an ordered array; port `gitPushToMain` from the original hook (refspec regex `(^|:|\+)(refs\/heads\/)?(<branch>)$` built from `protectedBranches`, `-C <dir>` resolution, no-refspec → `ctx.currentBranch(dir || ctx.cwd)`). - [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(rules): add shell and MCP production rules with fixture table`

### Task 5: Protected files and role spoof via file tools

**Files:** Create `hooks/lib/rules/file-rules.mjs`; Modify `hooks/lib/rules.mjs` (dispatch); Test `tests/file-rules.test.mjs`, add fixtures

**Interfaces:**
- Consumes: Task 3 `normalizeRel`, `globMatch`; Task 2 `tokens`.
- Produces: `checkFileTool(toolName: string, toolInput: object, ctx): Decision | null` — for `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, path from `tool_input.file_path ?? tool_input.notebook_path ?? tool_input.path`, deny with rule `protected-file` when `globMatch` hits any `protectedPaths` (relative to `ctx.repoRoot ?? ctx.cwd`). `checkBashWrite(segment: string, ctx): Decision | null` — deny when a protected path token appears as the target of `>`/`>>`, `tee`, `sed -i`, `cp`/`mv`/`rm` (last positional), `Set-Content`/`Out-File`/`Add-Content` (`-Path` or first positional). Also PowerShell `$env:OFFLIMITS_ROLE =` and `Set-Item env:OFFLIMITS_ROLE` map to `role-spoof` here.

- [ ] **Step 1: Write the failing tests** — `Write .claude/settings.json` deny; `Edit C:\repo\offlimits.json` with `repoRoot 'C:/repo'` deny; `Write .github/workflows/ci.yml` deny; `Write hooks/gate.mjs` allow; `Edit README.md` allow; Bash `echo x > .claude/settings.json` deny; `cat .claude/settings.json` allow; `sed -i 's/a/b/' offlimits.json` deny; `rm offlimits.json` deny; `cp offlimits.example.json offlimits.json` deny; `cp offlimits.json /tmp/backup.json` allow; PowerShell `Set-Content -Path offlimits.json -Value x` deny; PowerShell `$env:OFFLIMITS_ROLE='coordinator'; git push origin main` deny `role-spoof`; coordinator → all allow.
- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Implement** and wire into `decide`. - [ ] **Step 4: Run** → PASS (all suites).
- [ ] **Step 5: Commit** `feat(rules): protect hook config and policy files from worker writes`

### Task 6: Hook entry points, formatting, log

**Files:** Create `hooks/lib/input.mjs`, `hooks/lib/format.mjs`, `hooks/lib/log.mjs`, `hooks/gate.mjs`, `hooks/session.mjs`, `hooks/hooks.json`; Test `tests/gate.test.mjs`, `tests/session.test.mjs`, `tests/format.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: `readStdin(): object | null` (null on empty/invalid JSON). `denyMessage(d: Decision, role: Role): string` — lines: `offlimits: blocked <tool summary>`, `rule: <id> — <reason>`, `role: <role>`, next step (worker: `Commit your branch and hand over to the coordinator; do not work around this.`; solo: `Run it yourself outside Claude, or start the session with OFFLIMITS_ROLE=coordinator if this is intended.`). `askReason(d)`: `offlimits: <reason>. No production definition in offlimits.json, so this asks instead of blocking. See /offlimits.` `banner(f: { role, protectedBranches, productionConfigured: boolean, blocks: number, errors: number, branch, policySource, problems: string[] }): string`. `appendLog(root, entry)` writes `<root>/.offlimits/log.jsonl`, keeps last 200 lines; `readLog(root): entry[]`.
- `gate.mjs` behaviour (spec §Hook contract): deny → stderr `denyMessage` + exit 2; ask → stdout JSON `permissionDecision: 'ask'` + exit 0; allow → exit 0 silent; error path per role and `policy.onError`; every deny/ask/error appended to the log (log failures ignored). Tool summary: Bash → first 80 chars of command; MCP → tool name; file tools → path.
- `hooks/hooks.json`: `PreToolUse` matcher `Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*` → `node ${CLAUDE_PLUGIN_ROOT}/hooks/gate.mjs` timeout 10; `SessionStart` matcher `startup|resume|clear|compact` → `node ${CLAUDE_PLUGIN_ROOT}/hooks/session.mjs` timeout 10.

- [ ] **Step 1: Write the failing tests** — `gate.test.mjs` uses `spawnSync(process.execPath, ['hooks/gate.mjs'], { input, env, cwd: tmpGitRepo })` where `tmpGitRepo` is created with `git init -b feat/x` in `os.tmpdir()`: worker + `git push origin main` → status 2, stderr contains `rule: git-push-protected`; worker + `npm test` → 0, empty stdout; solo + supabase insert → 0, stdout JSON `permissionDecision === 'ask'`; coordinator + `git push origin main` → 0; `'not json'` with `OFFLIMITS_ROLE=worker` → 2 and stderr contains `hook error`; `'not json'` with no role → 0 and `.offlimits/log.jsonl` has one `error` entry; `onError:'block'` in solo → 2; log capped at 200 after 205 denies. `session.test.mjs`: worker on `main` → stdout contains `WARNING` and `protected branch`; solo, no log → contains `role: solo` and `MCP writes will ask`; log with error entries → contains `hook errors`. `format.test.mjs`: deny message has the four lines; ask reason mentions `/offlimits`.
- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Implement.** - [ ] **Step 4: Run** → PASS. Manual: start `claude` in this repo with `OFFLIMITS_ROLE=worker`, ask it to run `git push origin main`, observe the block.
- [ ] **Step 5: Commit** `feat(hooks): add gate and session entry points with fail-closed team mode and log`

### Task 7: Skills, status, explain, self-test

**Files:** Create `hooks/status.mjs`, `hooks/explain.mjs`, `hooks/selftest.mjs`, `skills/offlimits/SKILL.md`, `skills/offlimits-roles/SKILL.md`; Test `tests/selftest.test.mjs`, `tests/skills.test.mjs`

**Interfaces:**
- Consumes: Task 4 `decide`, fixtures; Task 6 log and banner helpers.
- Produces: `node hooks/status.mjs` prints role, policy source and problems, protected branches, production state, active rule ids, last 10 log lines. `node hooks/explain.mjs -- <command>` prints the decision for a Bash command as if run by the current role (`DECISION: deny (git-push-protected) — …`), exit 0 always. `node hooks/selftest.mjs` creates a temp git repo, runs every fixture whose `tool_name` is `Bash` or starts with `mcp__` or is `Write` through `gate.mjs` with `OFFLIMITS_ROLE` set to the fixture's role, prints a table `✓ blocked | ✓ asked | ✓ allowed | ✗ MISMATCH`, exit 1 on any mismatch; `--json` flag prints machine-readable results.
- `skills/offlimits/SKILL.md` frontmatter `name: offlimits`, `description: Show offlimits gate status, run its self-test, or explain what the gate would do with a command. Use when the user types /offlimits, asks why a command was blocked, or wants to verify the gate.`; body tells Claude how to locate the plugin root (directory two levels above this file) and which script to run for `status` (default), `test`, `explain <command>`, and to report the output verbatim. `skills/offlimits-roles/SKILL.md` frontmatter `name: offlimits-roles`, `description: Coordinator/worker contract for running several coding-agent sessions on one repo safely. Use when setting up parallel agent sessions, worktrees, or when a session hits an offlimits block.`; body ≤ 60 lines: one coordinator, workers in worktrees on `feat/*`, early draft PRs, delivery template, "when blocked, hand over".

- [ ] **Step 1: Write the failing tests** — `selftest.test.mjs`: `spawnSync(node, ['hooks/selftest.mjs','--json'])` exit 0 and every result `ok: true`; `skills.test.mjs`: both SKILL.md files parse frontmatter with `name` and single-line `description`; `offlimits-roles` body under 60 lines.
- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Implement.** - [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(skills): add /offlimits status, explain and self-test plus the roles skill`

### Task 8: Plugin manifests and validation

**Files:** Create `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `offlimits.example.json`; Test `tests/manifest.test.mjs`

**Interfaces:**
- Produces: `plugin.json` `{ name: 'offlimits', displayName: 'Off Limits', version: '0.1.0', description: 'The hook that keeps your coding agent out of production: blocks pushes to protected branches, remote migrations, deploys and prod MCP writes, in every permission mode.', author: { name: 'Mert Seker' }, homepage, repository: 'https://github.com/meertseker/offlimits', license: 'MIT', keywords: ['hooks','safety','guardrails','production','git','supabase','vercel','multi-agent'] }` — **no** `hooks` field (hooks.json loads automatically). `marketplace.json` `{ name: 'offlimits', owner: { name: 'Mert Seker' }, plugins: [{ name: 'offlimits', source: './', description: <same> }] }`. `offlimits.example.json`: every key with comments expressed as `"_comment"` keys? No — JSON has no comments; instead `docs/policy.md` (Task 9) explains, and the example file holds the spec defaults plus a filled `production` example.

- [ ] **Step 1: Write the failing test** — manifest fields present, `name === 'offlimits'`, no `hooks` key, marketplace entry name equals manifest name, `version` matches `package.json`.
- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Create files.** - [ ] **Step 4: Run** `node --test tests/` → PASS; `claude plugin validate --strict .` → `Validation passed`; `claude plugin validate --profile directory .` (if the profile exists in this CLI) → passes or the findings are recorded in `DECISIONS.md`; smoke: `claude plugin marketplace add ./` then `claude plugin install offlimits@offlimits --scope local` in a scratch repo, `claude plugin list` shows it, then uninstall and remove the marketplace.
- [ ] **Step 5: Commit** `feat(plugin): add manifest and marketplace so offlimits installs by name`

### Task 9: CI and templates

**Files:** Create `.github/workflows/ci.yml`, `.github/ISSUE_TEMPLATE/bypass.md`, `.github/ISSUE_TEMPLATE/config.yml`, `CONTRIBUTING.md`, `SECURITY.md`; Test `tests/ci.test.mjs`

**Interfaces:**
- Produces: workflow `name: ci`, `on: [push, pull_request]`, `permissions: contents: read`, `concurrency: ci-${{ github.ref }}` cancel-in-progress, job `test` matrix `os: [ubuntu-24.04, windows-2025, macos-15]` × `node: [20, 22]`, steps: checkout, setup-node (matrix), `node --test tests/`, `node hooks/selftest.mjs`; job `validate` on ubuntu: `npm i -g @anthropic-ai/claude-code@<pinned version read from the local `claude --version`>` then `claude plugin validate --strict .` — if this needs authentication in CI, drop the job and record it in `DECISIONS.md`. No secrets referenced anywhere. `SECURITY.md`: report bypasses by GitHub security advisory or issue template `bypass.md` (fields: command, role, expected, actual, Claude Code version, OS); promise: triage within 48 h, fix or documented limit within 7 days. `CONTRIBUTING.md`: zero-dependency rule, rule id list, every rule needs deny+allow fixtures, run the three checks, English.

- [ ] **Step 1: Write the failing test** — parse `ci.yml` (minimal YAML read: the test checks substrings, no YAML lib): contains `windows-2025`, `macos-15`, `node --test tests/`, `node hooks/selftest.mjs`, `permissions:`, no `secrets.`, no `pull_request_target`.
- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Create files.** - [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `ci: test on three OSes and two Node versions, validate the plugin manifest`

### Task 10: README, docs and demo

**Files:** Create `README.md`, `README.tr.md`, `CHANGELOG.md`, `docs/incidents.md`, `docs/limits.md`, `docs/policy.md`, `assets/demo.svg`; Test `tests/docs.test.mjs`

**Interfaces:**
- `README.md` order: H1 `offlimits`, bold one-liner **The hook that keeps your coding agent out of production.**, sub-line `Production is off limits. Prompts ask, hooks enforce. Runs in every permission mode, including --dangerously-skip-permissions.` (keep this sentence only if Task 6's manual check in bypass mode confirmed it; otherwise `Runs in every permission mode.`), `assets/demo.svg` image, **Install** (`claude plugin install offlimits --marketplace meertseker/offlimits`, and the two-step form, and `npx skills add meertseker/offlimits` for the roles skill), **What it blocks** (table from spec rules, one line each), **Roles** (3-row table), **Why a hook and not a prompt** (≤ 6 lines), **Compared with** table (native deny rules / karanb192 claude-code-hooks / rulebricks guardrails / offlimits; rows: works in bypass mode, role-aware, MCP SQL inspection, nested shell parsing, zero deps, no account), **Configuration** (link `docs/policy.md`, inline minimal example), **Limits** (first 5 from `docs/limits.md` + link), **Built in production** (3 sentences: school platform, 37 sessions, Usta), **Incidents this would have caught** (link), **FAQ** (5 questions: bypass mode, false positives, how to allow one command, Windows, telemetry), **Contributing / Security / License**. `README.tr.md`: Turkish summary ≤ 60 lines linking to the English README. `docs/incidents.md`: the four 2026 incidents and the 2025 Replit case with sources from the strategy research, each with "would offlimits have caught it: yes / partly / no — why". `docs/limits.md`: inline interpreters (`node -e`, `python -c`) calling git; aliases and wrapper scripts; `--dry-run` false positive; `git push` with remote URL instead of name; hook not running when Claude Code's `if` filter or plugin disabled; MCP servers with non-standard tool names; policy file edited by the human mid-session. `docs/policy.md`: every key, type, default, example. `CHANGELOG.md`: `## 0.1.0 — 2026-10-26` with the rule list. `assets/demo.svg`: static 800×360 terminal-style SVG, dark background, showing `$ git push origin main` then the four-line deny message, then `OFFLIMITS_ROLE=coordinator` session running the same command successfully; text only, no external fonts.

- [ ] **Step 1: Write the failing test** — README ≥ 400 words outside code blocks, contains the install command, contains `## Limits`, every spec rule id appears in README or `docs/policy.md`; `docs/limits.md` ≥ 5 bullets; `assets/demo.svg` parses as XML and is under 64 KiB.
- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Write the files.** - [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `docs: add README, Turkish summary, incidents, limits, policy reference and demo`

### Task 11: Adversarial review and fixes

**Files:** Modify whatever the review finds; Modify `docs/limits.md`; add fixtures.

- [ ] **Step 1:** Dispatch a fresh read-only reviewer (Opus 5.5, high effort) with the spec, `hooks/lib/**` and the fixtures: "find commands or tool inputs that reach production but return allow". Candidate list to try: `git  push` (double space), `git -c core.x=y push origin main`, `git push origin refs/heads/main:refs/heads/main`, `git push --repo=… `, `git push origin $(git branch --show-current)` while on main, `command git push origin main`, `\git push origin main`, `/usr/bin/git push origin main`, `git.exe push origin main`, `pwsh -EncodedCommand …`, `supabase db push --linked`, `psql "host=db.example.com"`, `PGHOST=db.example.com psql`, `vercel deploy --prod`, `vercel --prebuilt --prod`, `npx vercel --prod`, `pnpm dlx vercel --prod`, `mcp__supabase__execute_sql {query:'/* comment */ insert …'}`, SQL with `WITH … INSERT`, `DO $$ … $$`, `COPY t FROM`, `mcp__Supabase__…` case.
- [ ] **Step 2:** For each confirmed gap: add a deny fixture, make it pass, or add a line to `docs/limits.md` with the reason it cannot be closed cheaply. `git push` detection must cover `command git`, `\git`, absolute paths, `git.exe`, `-c key=value`, and `PGHOST=` → `remote-db`; `--prod` anywhere in a `vercel` segment including via `npx`/`pnpm dlx`; SQL comments stripped before the write regex; `WITH`, `DO`, `COPY … FROM`, `MERGE`, `CALL` added to the write regex; server-name matching case-insensitive.
- [ ] **Step 3: Run** all tests and self-test → PASS.
- [ ] **Step 4: Commit** `fix(rules): close bypasses found in adversarial review; document the rest`

### Task 12: Publish v0.1.0

**Files:** none new; GitHub repository and release.

- [ ] **Step 1:** `gh repo create meertseker/offlimits --public --source . --description "The hook that keeps your coding agent out of production. Claude Code plugin." --push`; set topics `claude-code, claude-code-plugin, hooks, ai-agents, guardrails, security, supabase, vercel`.
- [ ] **Step 2:** Verify CI green on `main` (`gh run watch`); if the `validate` job fails for auth reasons, remove it per Task 9 and push.
- [ ] **Step 3:** `gh release create v0.1.0 --title "offlimits 0.1.0" --notes-file CHANGELOG.md` (notes trimmed to the 0.1.0 section).
- [ ] **Step 4:** Apply the `main` ruleset via `gh api repos/meertseker/offlimits/rulesets` — rules: deletion, non_fast_forward, required_status_checks (`test (ubuntu-24.04, 22)` strict), pull_request with 0 required reviews (solo maintainer), bypass actor: repository admin. Record the JSON in `docs/github-settings.md`.
- [ ] **Step 5:** Smoke-install from GitHub in a scratch directory: `claude plugin install offlimits --marketplace meertseker/offlimits`, run `/offlimits test` in a session, uninstall.
- [ ] **Step 6:** Write the morning handover in `DECISIONS.md` → `## Pending`: Anthropic directory submission (browser, Mert), X account, Şeker migration (install plugin at project scope in parallel with the old hook, remove the old hook after a week), launch checklist link to the private strategy doc.

---

## Self-review notes

- Spec coverage: roles (T3, T6), every rule (T4, T5, T11), policy (T3), hook contract incl. error paths and log (T6), banner (T6), skills (T7), manifests and directory constraints (T8, T9), docs and limits (T10), publish (T12), dev system (T1). Not in v0.1: cross-agent adapters, `offlimits-crew` package (spec says later versions).
- Type consistency: `Decision`, `Role`, `Policy`, `ctx` shape (`role, policy, currentBranch, cwd, repoRoot`) used identically in T4–T7.
- Review Focus items each have a named test (T6 ×1, T5 ×2, T2/T4 ×3, T4 ×4, T4 ×5).
- Proportion: plan ≈ spec length ×2 because the fixture table is the product's actual contract; bodies are not transcribed.
