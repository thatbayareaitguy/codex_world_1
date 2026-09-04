param(
  [string]$TaskName = "TS New Music Scanner Spotify Campaign 100"
)

$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Disable-ScheduledTask -TaskName $TaskName | Out-Null
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
