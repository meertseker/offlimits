param(
  [string]$Lane,
  [string]$Base = 'origin/main',
  [ValidateSet('sonnet', 'opus')][string]$Model = 'sonnet',
  [string]$Remove,
  [switch]$NoLaunch,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$pattern = '^[a-z0-9][a-z0-9-]{1,38}$'
$basePattern = '^[\w./-]+$'

# Runs git directly with an argument list, so no argument is ever evaluated as PowerShell code.
function Git([string[]]$GitArgs) {
  if ($DryRun) { Write-Host "[dry-run] git $($GitArgs -join ' ')"; return }
  & git @GitArgs
  if ($LASTEXITCODE) { throw "failed: git $($GitArgs -join ' ')" }
}

if ($Remove) {
  if ($Remove -notmatch $pattern) { throw "Invalid name '$Remove' (must match $pattern)" }
  Git @('worktree', 'remove', "../offlimits-$Remove")
  return
}
if (-not $Lane) { throw 'Usage: worker.ps1 -Lane <name> [-Base origin/main] [-Model sonnet|opus] [-NoLaunch] [-DryRun] | -Remove <name>' }
if ($Lane -notmatch $pattern) { throw "Invalid lane '$Lane' (must match $pattern)" }
if ($Base -notmatch $basePattern -or $Base.StartsWith('-')) { throw "Invalid base '$Base' (must match $basePattern and not start with -)" }

Git @('fetch', 'origin')
Git @('worktree', 'add', '-b', "feat/$Lane", "../offlimits-$Lane", $Base)
if ($NoLaunch) { Write-Host "Worktree ready: ../offlimits-$Lane"; return }

$env:OFFLIMITS_ROLE = 'worker'
if ($DryRun) { Write-Host "[dry-run] cd ../offlimits-$Lane; OFFLIMITS_ROLE=worker claude --model $Model -n $Lane"; return }
Set-Location "../offlimits-$Lane"
claude --model $Model -n $Lane
