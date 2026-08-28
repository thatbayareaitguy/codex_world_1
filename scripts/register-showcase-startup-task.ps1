param(
  [string]$TaskName = "Showcase Public Site Web Application"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command "node.exe" -ErrorAction Stop).Source
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$supervisor = Join-Path $repositoryRoot "apps\showcase\ops\showcase-supervisor-cli.ts"
$runtimeDirectory = Join-Path $env:LOCALAPPDATA "ShowcasePublicSite\runtime"
$supervisorPidPath = Join-Path $runtimeDirectory "showcase-supervisor.pid"
$stopPath = Join-Path $runtimeDirectory "showcase.stop"

foreach ($requiredPath in @($node, $conhost, $supervisor)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required Showcase startup path was not found: $requiredPath"
  }
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
  Set-Content -LiteralPath $stopPath -Value "stop" -NoNewline
  $supervisorPid = if (Test-Path -LiteralPath $supervisorPidPath) {
    [int](Get-Content -Raw -LiteralPath $supervisorPidPath)
  } else {
    $null
  }

  if ($supervisorPid) {
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
      if (-not (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 500
    }
    $runningSupervisor = Get-CimInstance Win32_Process -Filter "ProcessId = $supervisorPid"
    if ($runningSupervisor) {
      $runningCommandLine = [string]$runningSupervisor.CommandLine
      if ($runningCommandLine.IndexOf($supervisor, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "Refusing to stop unexpected process $supervisorPid while replacing $TaskName."
      }
      & taskkill.exe /PID $supervisorPid /T /F | Out-Null
    }
  }

  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $supervisorPidPath, (Join-Path $runtimeDirectory "showcase.pid"), $stopPath `
    -Force -ErrorAction SilentlyContinue
}

$arguments = "--headless `"$node`" --import tsx `"$supervisor`""
$action = New-ScheduledTaskAction -Execute $conhost -Argument $arguments -WorkingDirectory $repositoryRoot
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description "Starts and supervises the loopback-only Showcase development site after user logon." `
  -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Output "Registered and started $TaskName for $userId."
