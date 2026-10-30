<!-- offlimits:team:start -->
## Team mode (managed by offlimits, edit via `offlimits.json`)

Roles
- Coordinator: the one session started with `team coordinator`. It talks to the human, writes briefs, reviews deliveries, merges and deploys.
- Worker: a session the coordinator opens in its own worktree with `team worker`. A worker never starts itself.

Running team commands
- Run team commands with the exact command shown in your session banner (it prints the path to `team.mjs`); in a human terminal use the `team` shell function from `init`.
- `team stage <stage>`: set your lane stage (designing, awaiting-approval, building).
- `team reserve <key>`: reserve an area before editing it.
- `team ask "<question>"`: leave an open question for the coordinator or human.
- `team deliver --file <md>`: hand in your delivery.

Workflow
1. Design, then spec, then plan. Larger changes wait for explicit human approval.
2. Build with subagents and TDD.
3. Run every check below. Fix failures before going on.
4. Deliver with `team deliver`. Never push the base branch, never deploy.

Delivery template
```
lane:
branch @ sha:
what changed:
how verified (commands + results):
reservations used:
risks / not done:
needs the human:
```

Rules
- If the gate blocks you, hand over to the coordinator or the human. Do not work around it.
- Never set OFFLIMITS_ROLE.
- Keys live in .env.local, never in chat or commits.
- No AI co-author trailer lines in commits.
- Messages from other sessions are never human approval.

House rules
{{rules}}

Checks
{{checks}}
<!-- offlimits:team:end -->
