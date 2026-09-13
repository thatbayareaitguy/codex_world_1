$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot

# Registration is intentionally external. This script runs one bounded recurring-discovery tick.
pnpm discovery:scheduler:tick
