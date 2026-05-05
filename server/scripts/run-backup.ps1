$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Convert-Path (Join-Path $ScriptDir "..")

try {
  # Change to server directory
  Set-Location $ServerDir
  
  # Run npm backup (backup.js handles its own logging to logs/backup.log)
  npm run backup 2>&1 | ForEach-Object { Write-Host $_ }
  
  if ($LASTEXITCODE -ne 0) {
    Write-Error "npm run backup failed with exit code $LASTEXITCODE"
    exit 1
  }
  
  exit 0
} catch {
  Write-Error "Backup failed: $_"
  exit 1
}
