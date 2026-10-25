# GitHub settings for `meertseker/offlimits`

Applied with `gh api` at v0.1.0 (2026-10-26). The repository is public, the maintainer is a solo coordinator, so the ruleset protects `main` from force pushes, deletion and unreviewed CI failures while still allowing the admin to merge without a second reviewer.

## Ruleset `main`

```json
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "test (ubuntu-24.04, 22)" }]
      }
    }
  ],
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ]
}
```

Notes:

- `actor_id: 5` is the built-in *Repository admin* role. The maintainer uses it as break-glass only; day-to-day work still goes through a branch and a pull request.
- No `pull_request` rule yet: with a single maintainer a required review would block every merge. Add `{ "type": "pull_request", "parameters": { "required_approving_review_count": 1, "dismiss_stale_reviews_on_push": true } }` once a second maintainer exists.
- The required check name is the matrix job `test (ubuntu-24.04, 22)` from `.github/workflows/ci.yml`. Renaming the job or the matrix values silently breaks the protection, so change both together.

## Apply or verify

```bash
# apply (once)
gh api -X POST repos/meertseker/offlimits/rulesets --input docs/github-ruleset.json

# verify
gh api repos/meertseker/offlimits/rules/branches/main
```

## Other repository settings

| Setting | Value | Why |
|---|---|---|
| Default branch | `main` | protected by the ruleset above |
| Topics | `claude-code`, `claude-code-plugin`, `hooks`, `ai-agents`, `guardrails`, `security`, `supabase`, `vercel` | discovery |
| Issues | on, blank issues off (`.github/ISSUE_TEMPLATE/config.yml`) | bypass reports use the template |
| Private vulnerability reporting | on | `SECURITY.md` points here |
| Discussions | off for v0.1 | one channel (issues) until there is traffic |
| Actions | read-only `GITHUB_TOKEN` (workflow sets `permissions: contents: read`) | the hook's own principle |
