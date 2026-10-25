param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { Write-Warning "Coordinator should run on 'main' (current: $branch)." }

$env:OFFLIMITS_ROLE = 'coordinator'
if ($DryRun) { Write-Host '[dry-run] OFFLIMITS_ROLE=coordinator claude --model claude-opus-5-5 -n coordinator'; return }
claude --model claude-opus-5-5 -n coordinator
