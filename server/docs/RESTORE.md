# Restore Guide

## Overview

This document covers restoring LexFlow from an encrypted backup.

## Prerequisites

- The encrypted backup file (`*.db.enc`)
- The `LEXFLOW_BACKUP_KEY` used to create the backup
- Access to the server running `scripts/restore-backup.js`

## Encrypted Restore

### Standard Restore

```bash
cd /opt/lexflow/server
LEXFLOW_BACKUP_KEY=<your-key> node scripts/restore-backup.js /opt/lexflow/backups/lawfirm-20260507-120000000.db.enc
```

This will:
1. Decrypt the backup.
2. Stop the running LexFlow server (if managed by systemd/PM2 — you may need to stop it manually first).
3. Replace the current database.
4. Clean up stale WAL/SHM files.
5. Verify the restored database.

### Force Restore

If the current database appears corrupted or you need to overwrite without prompts:

```bash
LEXFLOW_BACKUP_KEY=<your-key> node scripts/restore-backup.js --force /opt/lexflow/backups/lawfirm-20260507-120000000.db.enc
```

### Stale WAL/SHM Cleanup

The restore script automatically removes `lawfirm.db-wal` and `lawfirm.db-shm` before restoring. If you need to do this manually:

```bash
# Stop the server first
sudo systemctl stop lexflow

# Remove WAL/SHM files
rm -f /opt/lexflow/server/lawfirm.db-wal
rm -f /opt/lexflow/server/lawfirm.db-shm

# Start the server
sudo systemctl start lexflow
```

## Quarterly Restore Drill

**Perform a restore drill at least once per quarter.**

### Drill Procedure

1. **Provision a test/staging machine** — do not drill on production.
2. Install the same Node.js version and dependencies.
3. Copy the latest encrypted backup and the backup key to the test machine.
4. Run the restore script.
5. Start the server and verify:
   - `GET /health` returns `{"status":"ok"}`
   - Login works with known credentials
   - A few key records (clients, matters) are visible
6. **Destroy the test restore safely** after the drill:
   - Shut down the test server
   - Delete the test database and backup files
   - Wipe any sensitive data from the test machine
7. Document the drill result (date, duration, any issues).

### Drill Checklist

- [ ] Test machine provisioned
- [ ] Backup key available (from secure storage)
- [ ] Latest `.db.enc` file copied
- [ ] Restore script executed successfully
- [ ] Server started and `/health` responds
- [ ] Login verified with test credentials
- [ ] Key data spot-checked
- [ ] Test database and files securely deleted
- [ ] Drill result documented

## Emergency Restore

In a disaster scenario:

1. Provision a fresh server (or use the existing one if the DB is the only issue).
2. Deploy the LexFlow codebase (from Git tag or bundle).
3. Restore the `.env.production` from your secrets store.
4. Restore the latest encrypted backup.
5. Start the server and verify.
6. Update DNS if using a new server.

## See Also

- [Backup Automation](BACKUP-AUTOMATION.md)
- [SQLite Production Notes](SQLITE-PRODUCTION.md)
- [Production Checklist](PRODUCTION-CHECKLIST.md)
