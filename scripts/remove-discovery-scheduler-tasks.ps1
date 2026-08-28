param(
  [string]$SchedulerTaskName = "TS New Music Radar Recurring Discovery",
  [string]$MaintenanceTaskName = "TS New Music Radar Maintenance Window"
)

$ErrorActionPreference = "Stop"
foreach ($taskName in @($SchedulerTaskName, $MaintenanceTaskName)) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "Removed $taskName."
  }
}
