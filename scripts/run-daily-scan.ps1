$ErrorActionPreference = "Stop"

$repository = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repository

$dataRoot = if ($env:APP_DATA_DIR) {
  $env:APP_DATA_DIR
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA "TSNewMusicRadar"
} else {
  Join-Path $HOME ".local\share\TSNewMusicRadar"
}
$logDirectory = if ($env:APP_LOG_DIR) { $env:APP_LOG_DIR } else { Join-Path $dataRoot "logs" }
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd"
$logPath = Join-Path $logDirectory "daily-scan-$stamp.log"

& pnpm.cmd scan *>&1 | Tee-Object -FilePath $logPath -Append
exit $LASTEXITCODE
