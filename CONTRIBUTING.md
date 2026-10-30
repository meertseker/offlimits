# Contributing

All code, docs and comments are in English.

## Zero-dependency rule

offlimits has no runtime or dev dependencies. Use `node:` built-ins only, in hooks and in tests.

## Rules

Rule ids (the same list as `RULE_IDS` in `hooks/lib/rules.mjs`): `role-spoof`, `git-push-protected`, `git-branch-protected`, `gh-write`, `supabase-remote`, `remote-db`, `db-migrate`, `deploy`, `publish`, `agent-spawn`, `team-launch`, `git-clean`, `opaque-shell`, `extra-deny`, `protected-file`, `supabase-mcp`, `vercel-mcp`, `mcp-write`, `github-mcp`, `mcp-destructive`.

Every rule needs fixtures for both a deny case and an allow case.

## Before opening a PR

Run all three checks:

```
node --test
node hooks/selftest.mjs --all
claude plugin validate .
```

Use plain `node --test`; `node --test tests/` fails on Windows.
