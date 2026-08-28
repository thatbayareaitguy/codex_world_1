param(
  [string]$TaskName = "Showcase Public Site Web Application"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $repositoryRoot "apps\showcase\ops\showcase-supervisor-cli.ts"
$runtimeDirectory = Join-Path $env:LOCALAPPDATA "ShowcasePublicSite\runtime"
$supervisorPidPath = Join-Path $runtimeDirectory "showcase-supervisor.pid"
$stopPath = Join-Path $runtimeDirectory "showcase.stop"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
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
        throw "Refusing to stop unexpected process $supervisorPid while removing $TaskName."
      }
      & taskkill.exe /PID $supervisorPid /T /F | Out-Null
    }
  }

  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Remove-Item -LiteralPath $supervisorPidPath, (Join-Path $runtimeDirectory "showcase.pid"), $stopPath `
    -Force -ErrorAction SilentlyContinue
  Write-Output "Removed $TaskName."
} else {
  Write-Output "$TaskName is not registered."
}
