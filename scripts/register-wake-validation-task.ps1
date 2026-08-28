param(
  [string]$TaskName = "TS New Music Radar Maintenance Wake Validation 2026-08-28",
  [datetime]$RunAt = "2026-08-28T02:50:00"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command "node.exe" -ErrorAction Stop).Source
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$validationCli = Join-Path $repositoryRoot "apps\scanner\src\wake-validation-cli.ts"
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
if ($RunAt -le (Get-Date)) {
  throw "Wake validation time must be in the future."
}

$arguments = "--headless `"$node`" --import tsx `"$validationCli`""
$action = New-ScheduledTaskAction -Execute $conhost -Argument $arguments -WorkingDirectory $repositoryRoot
$trigger = New-ScheduledTaskTrigger -Once -At $RunAt
$trigger.Id = "WakeValidation20260828"
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -WakeToRun `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description "One-time read-only wake and keep-awake validation. It cannot run provider, scheduler, database, or playlist work." `
  -Force | Out-Null

Write-Output "Registered $TaskName for $($RunAt.ToString('yyyy-MM-dd HH:mm:ss zzz'))."
