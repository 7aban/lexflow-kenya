$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Join-Path $Root "server"
$PilotDir = Join-Path ([System.IO.Path]::GetTempPath()) "lexflow-pilot"

$backendPidFile = Join-Path $PilotDir "backend.pid"
$frontendPidFile = Join-Path $PilotDir "frontend.pid"

function Stop-ProcTree {
  param([int]$TargetPid)
  $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
  if ($proc) {
    taskkill /F /T /PID $TargetPid 2>$null
  }
}

# Stop frontend first (recorded PID)
if (Test-Path $frontendPidFile) {
  $spid = Get-Content $frontendPidFile
  if ($spid -match '^\d+$') {
    $proc = Get-Process -Id ([int]$spid) -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "Stopping pilot frontend (PID $spid)..."
      Stop-ProcTree ([int]$spid)
    }
  }
}

# Stop backend (recorded PID)
if (Test-Path $backendPidFile) {
  $spid = Get-Content $backendPidFile
  if ($spid -match '^\d+$') {
    $proc = Get-Process -Id ([int]$spid) -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "Stopping pilot backend (PID $spid)..."
      Stop-ProcTree ([int]$spid)
    }
  }
}

Start-Sleep -Seconds 1

# Fallback: clear any remaining listeners on pilot ports
$portProcs = @{}
foreach ($port in @(5173, 5000)) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($l in $listeners) {
    $p = $l.OwningProcess
    if (-not $portProcs.ContainsKey($p)) {
      $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
      if ($proc) {
        Write-Host "Clearing port $port from process $p ($($proc.ProcessName))..."
        Stop-ProcTree $p
        $portProcs[$p] = $true
      }
    }
  }
}

Start-Sleep -Seconds 1

# WAL checkpoint (best-effort after backend is dead so DB is unlocked)
$pilotDb = Join-Path $ServerDir "pilot.db"
if (Test-Path $pilotDb) {
  Write-Host "Checkpointing pilot.db WAL..."
  Push-Location $ServerDir
  $null = node -e "const s=require('sqlite3').verbose();const d=new s.Database('pilot.db',s.OPEN_READWRITE,()=>{d.run('PRAGMA wal_checkpoint(TRUNCATE)',()=>{d.close()})})" 2>&1
  Pop-Location
  # Remove stale WAL sidecar files if checkpoint left them
  Get-ChildItem -Path $ServerDir -Filter "pilot.db-wal" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem -Path $ServerDir -Filter "pilot.db-shm" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

# Remove runtime artifacts (PID files, logs)
if (Test-Path $PilotDir) {
  Remove-Item -Recurse -Force -LiteralPath $PilotDir -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== Port Status ==="
$c5 = Get-NetTCPConnection -LocalPort 5000 -ErrorAction SilentlyContinue
$c3 = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue
if (-not $c5) { Write-Host "Port 5000: FREE" } else { Write-Host ("Port 5000: in use by PID " + $c5.OwningProcess) }
if (-not $c3) { Write-Host "Port 5173: FREE" } else { Write-Host ("Port 5173: in use by PID " + $c3.OwningProcess) }
Write-Host ""
if (Test-Path $pilotDb) { Write-Host "Pilot DB preserved at: $pilotDb" }
