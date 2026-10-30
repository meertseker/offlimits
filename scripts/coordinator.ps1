# Thin wrapper: all logic lives in bin/team.mjs. Usage: coordinator.ps1 [--resume] [--takeover] [--print]
$ErrorActionPreference = 'Stop'
node "$PSScriptRoot/../bin/team.mjs" coordinator @args
exit $LASTEXITCODE
