# Lane ledger

One row per active lane. A lane edits only the files it owns. Update this file in the same PR that claims files.

| Lane | Branch | Owns | Status |
|---|---|---|---|
| repo-skeleton | feat/repo-skeleton | `package.json`, `.gitignore`, `.gitattributes`, `.nvmrc`, `LICENSE`, `CLAUDE.md`, `DECISIONS.md`, `docs/ledger/**`, `.github/pull_request_template.md`, `.claude/settings.json`, `offlimits.json`, `scripts/**`, `tests/repo.test.mjs` | done (v0.1.0) |
| room | feat/room | `hooks/lib/room/**`, `hooks/lib/team/events.mjs`, `docs/room.md`, `tests/room-*.test.mjs`, `tests/team-events.test.mjs` | delivered (PR, stacked on #2) |
