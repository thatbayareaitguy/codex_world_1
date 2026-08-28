param(
  [string]$SchedulerTaskName = "TS New Music Radar Recurring Discovery",
  [string]$MaintenanceTaskName = "TS New Music Radar Maintenance Window"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command "node.exe" -ErrorAction Stop).Source
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$environmentFile = Join-Path $env:LOCALAPPDATA "TSNewMusicRadar\production-scheduler.env"
$schedulerCli = Join-Path $repositoryRoot "apps\scanner\src\discovery-scheduler-cli.ts"
$maintenanceCli = Join-Path $repositoryRoot "apps\scanner\src\discovery-maintenance-cli.ts"
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
  throw "Protected production scheduler environment file was not found."
}

$schedulerArguments = "--headless `"$node`" --env-file=`"$environmentFile`" --import tsx `"$schedulerCli`" tick"
$schedulerAction = New-ScheduledTaskAction -Execute $conhost -Argument $schedulerArguments -WorkingDirectory $repositoryRoot
$schedulerTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$schedulerTrigger.Id = "MinuteScheduler"
$schedulerSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -Hidden

Register-ScheduledTask -TaskName $SchedulerTaskName -Action $schedulerAction `
  -Trigger $schedulerTrigger -Principal $principal -Settings $schedulerSettings `
  -Description "Runs one non-overlapping discovery scheduler tick each minute while Windows is awake." `
  -Force | Out-Null

$maintenanceArguments = "--headless `"$node`" --env-file=`"$environmentFile`" --import tsx `"$maintenanceCli`""
$maintenanceAction = New-ScheduledTaskAction -Execute $conhost -Argument $maintenanceArguments -WorkingDirectory $repositoryRoot
$maintenanceTriggers = @(
  New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Saturday, Sunday, Monday, Tuesday, Wednesday -At "08:50"
  New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Saturday, Sunday, Monday, Tuesday, Wednesday -At "20:50"
  New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Thursday -At "20:50"
  New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Friday -At "08:50"
)
$maintenanceTriggers[0].Id = "BroadMorningWake"
$maintenanceTriggers[1].Id = "BroadEveningWake"
$maintenanceTriggers[2].Id = "ThursdayAppleWake"
$maintenanceTriggers[3].Id = "FridayCatchupWake"
$existingMaintenanceTask = Get-ScheduledTask -TaskName $MaintenanceTaskName -ErrorAction SilentlyContinue
$existingDynamicWake = @(
  $existingMaintenanceTask.Triggers | Where-Object { $_.Id -eq "DynamicCapacityWake" }
)
if ($existingDynamicWake.Count -gt 0) {
  $maintenanceTriggers += $existingDynamicWake[0]
}
$maintenanceSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -WakeToRun `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -Hidden

Register-ScheduledTask -TaskName $MaintenanceTaskName -Action $maintenanceAction `
  -Trigger $maintenanceTriggers -Principal $principal -Settings $maintenanceSettings `
  -Description "Wakes Windows for bounded discovery maintenance windows and exits when no eligible work remains." `
  -Force | Out-Null

Write-Output "Registered $SchedulerTaskName and $MaintenanceTaskName for $userId."
