param(
  [string]$TaskName = "TS New Music Radar Web Application"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $repositoryRoot "apps\scanner\src\web-supervisor-cli.ts"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$supervisorPattern = [regex]::Escape($supervisor)
$supervisorProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $supervisorPattern }
foreach ($processRecord in $supervisorProcesses) {
  & taskkill.exe /PID $processRecord.ProcessId /T /F | Out-Null
}

if ($task) {
  Write-Output "Removed $TaskName and its web supervisor."
} else {
  Write-Output "$TaskName is not registered; no web supervisor remains."
}
