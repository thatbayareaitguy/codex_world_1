param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$CampaignId
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot

$node = (Get-Command "node.exe" -ErrorAction Stop).Source
$campaignCli = Join-Path $repositoryRoot "apps\scanner\src\spotify-sync-campaign-cli.ts"
& $node --import tsx $campaignCli tick --campaign $CampaignId
exit $LASTEXITCODE
