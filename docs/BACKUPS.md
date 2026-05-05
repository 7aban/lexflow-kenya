# LexFlow Local Backup Setup

## Overview

LexFlow uses a local SQLite database stored at `server/lawfirm.db`. This document describes how to set up automated daily backups using Windows Task Scheduler.

## What the Backup System Does

- **Source**: `server/lawfirm.db` (SQLite database)
- **Backup location**: `backups/` folder at project root
- **Filename format**: `lawfirm-YYYYMMDD-HHmmss.db` (e.g., `lawfirm-20260505-063339.db`)
- **Verification**: Each backup is verified using SQLite `PRAGMA integrity_check`
- **Rotation**: Keeps the last 7 backups by default (removes older ones)
- **Logging**: All backup operations are logged to `logs/backup.log`

## Manual Backup

To create a backup manually:

```bash
cd server
npm run backup
```

Check the log file for results:
```bash
cat logs/backup.log
```

## PowerShell Wrapper

The `server/scripts/run-backup.ps1` script:
- Changes to the server directory
- Runs `npm run backup`
- Appends all output to `logs/backup.log`
- Exits with code 0 on success, 1 on failure

To run manually:
```powershell
.\server\scripts\run-backup.ps1
```

## Windows Task Scheduler Setup

The `server/scripts/setup-backup-task.ps1` script creates a scheduled task named `LexFlow-Backup`.

### Prerequisites

- Windows 10/11 with Task Scheduler
- Node.js and npm must be in PATH
- Project cloned locally

### Setup Steps

1. Open PowerShell (run as Administrator for system-wide access, optional)
2. Navigate to project root
3. Run:
   ```powershell
   .\server\scripts\setup-backup-task.ps1
   ```

### Scheduled Task Details

- **Task Name**: `LexFlow-Backup`
- **Schedule**: Daily at 02:00 AM
- **Action**: Runs `run-backup.ps1` wrapper
- **Run As**: Current user (not SYSTEM)
- **Wake to Run**: Disabled (runs only when user is logged on)

### Verify the Task

1. Open Task Scheduler (`taskschd.msc`)
2. Look under **Task Scheduler Library**
3. Find task: `LexFlow-Backup`
4. Check **Last Run Result** column

### Manual Trigger

```powershell
Start-ScheduledTask -TaskName "LexFlow-Backup"
```

## Check Logs

Backup logs are stored at:
```
logs/backup.log
```

Each log entry format:
```
[2026-05-05T06:33:39.000Z] Backup created: lawfirm-20260505-063339.db
[2026-05-05T06:33:39.000Z] Size: 315392 bytes
[2026-05-05T06:33:39.000Z] Verification: ok
[2026-05-05T06:33:39.000Z] Removed: 0, Remaining: 3
[2026-05-05T06:33:39.000Z] Backup completed successfully.
```

View recent logs:
```powershell
Get-Content logs/backup.log -Tail 20
```

## Troubleshooting

### npm/node not found

**Symptom**: Task runs but backup fails with "npm is not recognized"

**Solution**: Ensure Node.js and npm are in your PATH:
```powershell
Get-Command npm
Get-Command node
```

If not found, add Node.js to PATH or use full paths in `run-backup.ps1`.

### PowerShell Execution Policy

**Symptom**: Script won't run due to execution policy

**Solution**: The setup script uses `-ExecutionPolicy Bypass` when calling PowerShell. If issues persist:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### Task Not Running

**Symptom**: Scheduled task doesn't trigger

**Check**:
1. Open Task Scheduler
2. Find `LexFlow-Backup` task
3. Check **Last Run Result**
4. Check **Actions** tab for correct paths
5. Enable **All Task History** (Action menu) for detailed logs

### Backup Verification Failure

**Symptom**: Log shows "Backup failed: Backup is corrupted"

**Solution**:
1. Check disk space
2. Verify `server/lawfirm.db` is not corrupted
3. Run manual backup: `cd server && npm run backup`

### Log File Not Created

**Symptom**: `logs/backup.log` doesn't exist after running

**Solution**:
1. Ensure `logs/` directory is writable
2. Run setup script again: `.\server\scripts\setup-backup-task.ps1`
3. Check task action paths are correct

## Important Warnings

⚠️ **Local Backup Only**: This system protects against database corruption and accidental deletion. It does NOT protect against:
- Full machine failure
- Disk failure
- Physical theft or damage

For production use, consider:
- Remote/cloud backup (e.g., AWS S3, Azure Blob Storage)
- Replication to offsite location
- Database migration to managed service (e.g., PostgreSQL on cloud)

⚠️ **No Encryption**: Backup files are not encrypted at rest. Ensure proper file system permissions on the `backups/` folder.
