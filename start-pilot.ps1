$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Join-Path $Root "server"
$ClientDir = Join-Path $Root "client"
$PilotDir = Join-Path ([System.IO.Path]::GetTempPath()) "lexflow-pilot"

if (-not (Test-Path $PilotDir)) {
  New-Item -ItemType Directory -Path $PilotDir -Force | Out-Null
}

$BackendPidFile = Join-Path $PilotDir "backend.pid"
$FrontendPidFile = Join-Path $PilotDir "frontend.pid"

function Stop-PortListener {
  param([int]$Port)
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($l in $listeners) {
    $p = $l.OwningProcess
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "Stopping process $p on port $Port..."
      taskkill /F /T /PID $p 2>$null
    }
  }
}

function Check-Dependencies {
  param([string]$Directory, [string]$Label)
  if (-not (Test-Path (Join-Path $Directory "node_modules"))) {
    Write-Host "ERROR: $Label dependencies missing. Run: push-location $Directory; npm install; pop-location"
    exit 1
  }
}

# Clean stale pilot PIDs
foreach ($pf in @($BackendPidFile, $FrontendPidFile)) {
  if (Test-Path $pf) {
    $oldPid = Get-Content $pf
    if ($oldPid -match '^\d+$') {
      $proc = Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue
      if ($proc) {
        Write-Host "Cleaning stale pilot process $oldPid..."
        taskkill /F /T /PID $oldPid 2>$null
      }
    }
  }
}

Stop-PortListener 5000
Stop-PortListener 5173
Start-Sleep -Seconds 2

Check-Dependencies $ServerDir "server"
Check-Dependencies $ClientDir "client"

# Save and set env vars (restore at end so parent shell is not polluted)
$SavedEnv = @{}
foreach ($key in @('NODE_ENV','OAUTH_STAFF_ENABLED','DATABASE_PATH','LEXFLOW_DISABLE_RATE_LIMIT')) {
  $SavedEnv[$key] = [System.Environment]::GetEnvironmentVariable($key)
}
$env:NODE_ENV = "development"
$env:OAUTH_STAFF_ENABLED = "false"
$env:DATABASE_PATH = "pilot.db"
$env:LEXFLOW_DISABLE_RATE_LIMIT = "true"

Write-Host ""
Write-Host "Starting pilot backend at http://localhost:5000..."
$BackendProc = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $ServerDir -WindowStyle Hidden -PassThru
$BackendProc.Id | Out-File -FilePath $BackendPidFile -Encoding ASCII

Start-Sleep -Seconds 4

Write-Host "Starting pilot frontend at http://localhost:5173..."
$FrontendProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$ClientDir`" && npm run dev" -WindowStyle Hidden -PassThru
$FrontendProc.Id | Out-File -FilePath $FrontendPidFile -Encoding ASCII

Start-Sleep -Seconds 5

# Restore env vars
foreach ($key in $SavedEnv.Keys) {
  [System.Environment]::SetEnvironmentVariable($key, $SavedEnv[$key])
}

Write-Host ""
Write-Host "=== LexFlow Pilot ==="
Write-Host "Frontend : http://localhost:5173"
Write-Host "Backend  : http://localhost:5000"
Write-Host "Login    : admin@lexflow.co.ke"
Write-Host ""
Write-Host "IMPORTANT: Change the default password immediately."
Write-Host "WARNING  : Do NOT run 'npm run seed:demo' against pilot.db"
Write-Host "Pilot DB : $ServerDir\pilot.db"
Write-Host ""
Write-Host "To stop: .\stop-pilot.ps1"
