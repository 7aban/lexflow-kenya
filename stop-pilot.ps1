$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Join-Path $Root "server"
$PilotDir = Join-Path ([System.IO.Path]::GetTempPath()) "lexflow-pilot"

$backendPidFile = Join-Path $PilotDir "backend.pid"
$frontendPidFile = Join-Path $PilotDir "frontend.pid"

# Stop by recorded PIDs first
$stoppedAny = $false
foreach ($pf in @($frontendPidFile, $backendPidFile)) {
  if (Test-Path $pf) {
    $oldPid = Get-Content $pf
    if ($oldPid -match '^\d+$') {
      $proc = Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue
      if ($proc) {
        Write-Host "Stopping pilot process $oldPid ($($proc.ProcessName))..."
        taskkill /F /T /PID $oldPid 2>$null
        $stoppedAny = $true
      }
    }
  }
}

# Fallback: clear ports if no PIDs were recorded/stopped
if (-not $stoppedAny) {
  Write-Host "No recorded pilot PIDs found. Checking ports..."
}
foreach ($port in @(5000, 5173)) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($l in $listeners) {
    $p = $l.OwningProcess
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc -and ($proc.ProcessName -eq "node" -or $proc.ProcessName -eq "cmd")) {
      Write-Host "Clearing port $port from process $p ($($proc.ProcessName))..."
      taskkill /F /T /PID $p 2>$null
    }
  }
}

Start-Sleep -Seconds 1

# WAL checkpoint (best-effort, after backend is dead so DB is unlocked)
$pilotDb = Join-Path $ServerDir "pilot.db"
if (Test-Path $pilotDb) {
  Write-Host "Checkpointing pilot.db WAL..."
  Push-Location $ServerDir
  $null = node -e "const s=require('sqlite3').verbose();const d=new s.Database('pilot.db',s.OPEN_READWRITE,()=>{d.run('PRAGMA wal_checkpoint(TRUNCATE)',()=>{d.close()})})" 2>&1
  Pop-Location
}

# Remove runtime artifacts (PID files, logs, temp scripts)
if (Test-Path $PilotDir) {
  Remove-Item -Recurse -Force -LiteralPath $PilotDir -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== Port Status ==="
$c5 = Get-NetTCPConnection -LocalPort 5000 -ErrorAction SilentlyContinue
$c3 = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue
if (-not $c5) { Write-Host "Port 5000: FREE" } else { Write-Host "Port 5000: in use by PID $($c5.OwningProcess)" }
if (-not $c3) { Write-Host "Port 5173: FREE" } else { Write-Host "Port 5173: in use by PID $($c3.OwningProcess)" }
Write-Host ""
Write-Host "Pilot DB preserved at: $pilotDb"
