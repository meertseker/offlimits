# Thin wrapper: all logic lives in bin/team.mjs. Usage: worker.ps1 <lane> --brief <file> [--model m] [--night] [--base ref] [--print]
$ErrorActionPreference = 'Stop'
node "$PSScriptRoot/../bin/team.mjs" worker @args
exit $LASTEXITCODE
