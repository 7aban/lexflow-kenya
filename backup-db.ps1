$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DatabasePath = Join-Path $Root "server\lawfirm.db"
$BackupDir = Join-Path $Root "backups"

if (-not (Test-Path $DatabasePath)) {
  throw "No SQLite database found at $DatabasePath. Start the backend once before creating a backup."
}

if (-not (Test-Path $BackupDir)) {
  New-Item -ItemType Directory -Path $BackupDir | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = Join-Path $BackupDir "lawfirm-$timestamp.db"

Copy-Item -LiteralPath $DatabasePath -Destination $backupPath -Force

Write-Host "Database backup created:"
Write-Host $backupPath
