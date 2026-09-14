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
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$logonTrigger.Id = "WebAtLogon"
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$watchdogTrigger.Id = "WebWatchdog"
$triggers = @($logonTrigger, $watchdogTrigger)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal `
  -Settings $settings -Description "Starts and supervises the loopback-only TS New Music Radar web application after user logon and checks it every five minutes while Windows is awake." `
  -Force | Out-Null

Write-Output "Registered $TaskName for $userId."
