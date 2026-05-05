$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Convert-Path (Join-Path $ScriptDir "..")
$ProjectRoot = Convert-Path (Join-Path $ServerDir "..")
$TaskName = "LexFlow-Backup"
$LogDir = Join-Path $ProjectRoot "logs"
$LogPath = Join-Path $LogDir "backup.log"

# Check if running as administrator (optional warning)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "WARNING: Not running as Administrator. Task will run as current user." -ForegroundColor Yellow
}

# Create the scheduled task with working directory set
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$ScriptDir\run-backup.ps1`"" -WorkingDirectory $ServerDir
$Trigger = New-ScheduledTaskTrigger -Daily -At "02:00"
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun

# Register the task (Force updates if exists)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force

Write-Host "=== Windows Task Scheduler Setup Complete ===" -ForegroundColor Green
Write-Host "Task Name: $TaskName"
Write-Host "Script Path: $ScriptDir\run-backup.ps1"
Write-Host "Working Directory: $ServerDir"
Write-Host "Schedule: Daily at 02:00 AM"
Write-Host "Log File: $LogPath"
Write-Host ""
Write-Host "To verify the task:"
Write-Host "  1. Open Task Scheduler (taskschd.msc)"
Write-Host "  2. Look under 'Task Scheduler Library'"
Write-Host "  3. Find task: $TaskName"
Write-Host ""
Write-Host "To manually trigger the task:"
Write-Host "  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Host ""
Write-Host "To check the log after a run:"
Write-Host "  Get-Content $LogPath"
