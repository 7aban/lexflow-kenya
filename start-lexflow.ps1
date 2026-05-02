$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Join-Path $Root "server"
$ClientDir = Join-Path $Root "client"

function Stop-PortListener {
  param([int]$Port)
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $pidToStop = $listener.OwningProcess
    $process = Get-Process -Id $pidToStop -ErrorAction SilentlyContinue
    if ($process) {
      Write-Host "Stopping existing $($process.ProcessName) process $pidToStop on port $Port..."
      Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue
    }
  }
}

function Ensure-Dependencies {
  param([string]$Directory)
  if (-not (Test-Path (Join-Path $Directory "node_modules"))) {
    Write-Host "Installing dependencies in $Directory..."
    Push-Location $Directory
    npm install
    Pop-Location
  }
}

Write-Host "Preparing LexFlow..."
Ensure-Dependencies $ServerDir
Ensure-Dependencies $ClientDir

Stop-PortListener 5000
Stop-PortListener 5173
Start-Sleep -Seconds 2

Write-Host "Starting backend at http://localhost:5000..."
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$ServerDir`" && npm start" -WindowStyle Normal

Start-Sleep -Seconds 4

Write-Host "Starting frontend at http://localhost:5173..."
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$ClientDir`" && npm run dev" -WindowStyle Normal

Start-Sleep -Seconds 5

Write-Host ""
Write-Host "LexFlow should now be available at http://localhost:5173"
Write-Host "Default admin login: admin@lexflow.co.ke / admin123"
