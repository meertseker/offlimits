# Contributing

All code, docs and comments are in English.

## Zero-dependency rule

offlimits has no runtime or dev dependencies. Use `node:` built-ins only, in hooks and in tests.

## Rules

Rule ids: `git-push-protected`, `git-branch-protected`, `gh-write`, `supabase-remote`, `remote-db`, `db-migrate`, `deploy`, `publish`, `role-spoof`, `protected-file`, `opaque-shell`, `supabase-mcp`, `vercel-mcp`, `mcp-write`, `extra-deny`.

Every rule needs fixtures for both a deny case and an allow case.

## Before opening a PR

Run all three checks:

```
node --test
node hooks/selftest.mjs
claude plugin validate .
```

Use plain `node --test`; `node --test tests/` fails on Windows.
