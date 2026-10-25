param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$branch = $null
try {
  $branch = & git rev-parse --abbrev-ref HEAD 2>$null
  if ($LASTEXITCODE) { $branch = $null }
} catch {
  $branch = $null
}
if (-not $branch) {
  throw 'Not inside a git repository (or git is not installed). Run coordinator.ps1 from the repository you coordinate.'
}
$branch = "$branch".Trim()
if ($branch -ne 'main') { Write-Warning "Coordinator should run on 'main' (current: $branch)." }

$env:OFFLIMITS_ROLE = 'coordinator'
if ($DryRun) { Write-Host '[dry-run] OFFLIMITS_ROLE=coordinator claude --model claude-opus-5-5 -n coordinator'; return }
claude --model claude-opus-5-5 -n coordinator
