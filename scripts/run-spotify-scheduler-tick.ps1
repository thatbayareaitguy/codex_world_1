$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot

# Registration is intentionally external. This script runs one bounded tick only.
pnpm spotify:scheduler:tick
