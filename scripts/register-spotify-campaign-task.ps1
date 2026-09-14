param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$CampaignId,
  [string]$TaskName = "TS New Music Scanner Spotify Campaign 100"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command "node.exe" -ErrorAction Stop).Source
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$campaignCli = Join-Path $repositoryRoot "apps\scanner\src\spotify-sync-campaign-cli.ts"
$arguments = "--headless `"$node`" --import tsx `"$campaignCli`" tick --campaign $CampaignId"
$action = New-ScheduledTaskAction -Execute $conhost -Argument $arguments -WorkingDirectory $repositoryRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Hours 8)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -WakeToRun `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Temporary bounded Spotify campaign runner. Safe to delete after campaign completion." `
  -Force | Out-Null
