$ErrorActionPreference = "Stop"

function Stop-PortListener {
  param([int]$Port)
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $pidToStop = $listener.OwningProcess
    $process = Get-Process -Id $pidToStop -ErrorAction SilentlyContinue
    if ($process) {
      Write-Host "Stopping $($process.ProcessName) process $pidToStop on port $Port..."
      Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue
    }
  }
}

Stop-PortListener 5000
Stop-PortListener 5173

Write-Host "LexFlow backend and frontend ports are clear."
