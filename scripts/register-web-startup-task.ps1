param(
  [string]$TaskName = "TS New Music Radar Web Application"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command "node.exe" -ErrorAction Stop).Source
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$supervisor = Join-Path $repositoryRoot "apps\scanner\src\web-supervisor-cli.ts"
$arguments = "--headless `"$node`" --import tsx `"$supervisor`""
$action = New-ScheduledTaskAction -Execute $conhost -Argument $arguments -WorkingDirectory $repositoryRoot
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description "Starts and supervises the loopback-only TS New Music Radar web application after user logon." `
  -Force | Out-Null

Write-Output "Registered $TaskName for $userId."
