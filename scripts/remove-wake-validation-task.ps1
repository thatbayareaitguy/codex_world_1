param(
  [string]$TaskName = "TS New Music Radar Maintenance Wake Validation 2026-08-28"
)

$ErrorActionPreference = "Stop"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Removed $TaskName."
} else {
  Write-Output "$TaskName is not registered."
}
