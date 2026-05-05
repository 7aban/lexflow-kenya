$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Convert-Path (Join-Path $ScriptDir "..")
$ProjectRoot = Convert-Path (Join-Path $ServerDir "..")
$LogDir = Join-Path $ProjectRoot "logs"
$LogFile = Join-Path $LogDir "backup.log"

# Ensure logs directory exists
if (-not (Test-Path $LogFile)) {
  New-Item -ItemType Directory -Path (Split-Path $LogFile) -Force | Out-Null
}

function Write-Log {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"
  "$timestamp $Message" | Tee-Object -FilePath $LogFile -Append
}

try {
  Write-Log "=== Backup started ==="
  
  # Change to server directory
  Set-Location $ServerDir
  
  # Run npm backup
  $output = npm run backup 2>&1 | ForEach-Object { $line = $_; Write-Log $line; $line }
  
  if ($LASTEXITCODE -ne 0) {
    Write-Log "ERROR: npm run backup failed with exit code $LASTEXITCODE"
    Write-Log "=== Backup failed ==="
    exit 1
  }
  
  Write-Log "=== Backup completed successfully ==="
  exit 0
} catch {
  Write-Log "ERROR: $_"
  Write-Log "=== Backup failed ==="
  exit 1
}
