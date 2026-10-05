$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$runner = Join-Path $repositoryRoot 'scripts\showcase-update.ts'
$taskName = 'Showcase Weekly Publication'
$deployer = Join-Path $repositoryRoot '.app-runtime\deployer\node_modules\vercel\dist\index.js'
$budget = Join-Path $env:LOCALAPPDATA 'Showcase\publication\transfer-budget.json'
foreach ($required in @($runner, $deployer, $budget)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Missing Showcase publication prerequisite: $required" }
}
if ((Get-TimeZone).Id -ne 'Pacific Standard Time') { throw 'This task requires Windows Pacific Time so weekly triggers follow daylight-saving changes.' }
$scannerEnv = Join-Path (Split-Path -Parent $repositoryRoot) 'codex_world_1\.env'
if (-not (Test-Path -LiteralPath $scannerEnv)) { throw 'The scanner source configuration is missing.' }
$arguments = "--headless `"$node`" --import tsx `"$runner`" --scheduled"
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\conhost.exe') -Argument $arguments -WorkingDirectory $repositoryRoot
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$triggers = @(
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At '23:00'),
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday -At '00:45'),
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday -At '11:00'),
  (New-ScheduledTaskTrigger -AtLogOn -User $userId)
)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 55) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Budgeted Showcase publication: Friday 23:00 Pacific, Saturday 00:45 retry and 11:00 catch-up. No scanner/provider scheduling changes.' -Force | Out-Null
Write-Output "Registered $taskName. User must be signed in; missed slots catch up within 24 hours. Task is not started now."
