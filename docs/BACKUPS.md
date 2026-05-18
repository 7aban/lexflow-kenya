# LexFlow Local Backup Setup

## Overview

LexFlow uses a local SQLite database resolved at runtime from the `DATABASE_PATH` environment variable (default: `server/lawfirm.db`). This document describes how to set up automated daily backups using Windows Task Scheduler.

## What the Backup System Does

- **Source**: the SQLite database at `DATABASE_PATH`. After PILOT-HARDENING-4 the backup script reads the same path the server runs against; in default deployments that is `server/lawfirm.db`.
- **Backup location**: `BACKUP_DIR` (defaults to `backups/` at the project root).
- **Filename format**: `lawfirm-YYYYMMDD-HHmmssSSS.db.enc` when `LEXFLOW_BACKUP_KEY` is set (e.g., `lawfirm-20260519-063339123.db.enc`), or `.db` when unencrypted.
- **Encryption**: AES-256-GCM, keyed by `LEXFLOW_BACKUP_KEY` (64 hex characters / 32 bytes). Required for production; required for encrypted restore.
- **Verification**: each backup is decrypted to a temp file and verified using SQLite `PRAGMA integrity_check`.
- **Rotation**: keeps `LEXFLOW_BACKUP_RETENTION_COUNT` backups (default 7), rotating older `lawfirm-*.db.enc`/`.db` files.
- **Restore**: `npm run restore:backup -- <file>` writes the decrypted backup to `DATABASE_PATH`. Requires the same `LEXFLOW_BACKUP_KEY` used at backup time.
- **Logging**: all backup operations are logged to `BACKUP_LOG` (default `logs/backup.log`). The resolved source path is logged at the start of each run.

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
2. Verify the database file at `DATABASE_PATH` (default `server/lawfirm.db`) is not corrupted
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

⚠️ **Encryption Key Required**: When `LEXFLOW_BACKUP_KEY` is set (required in production), backups are encrypted with AES-256-GCM at rest and the same key is required to restore. Store the key separately from the backup files and never commit it to the repository. If the key is unset in development, backups are written as plaintext `.db` files — do not run production this way.
