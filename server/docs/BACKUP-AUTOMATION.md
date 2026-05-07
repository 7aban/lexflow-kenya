# Backup Automation

## Overview

LexFlow supports encrypted daily backups via `scripts/backup.js`. This document covers scheduling, monitoring, and alerts.

## Manual Backup

```bash
cd /opt/lexflow/server
NODE_ENV=production node scripts/backup.js
```

Output:
```
Creating backup...
Backup created: lawfirm-20260507-120000000.db.enc
Size: 1241120 bytes
Backup is encrypted (.db.enc)
Verifying backup...
Verification: ok
```

## Option A: Cron

See [`deploy/cron/lexflow-backup.example`](../../deploy/cron/lexflow-backup.example).

### Installation

```bash
sudo cp deploy/cron/lexflow-backup /etc/cron.d/lexflow-backup
sudo chmod 644 /etc/cron.d/lexflow-backup
```

## Option B: systemd Timer

See [`deploy/systemd/lexflow-backup.service.example`](../../deploy/systemd/lexflow-backup.service.example) and [`deploy/systemd/lexflow-backup.timer.example`](../../deploy/systemd/lexflow-backup.timer.example).

### Installation

```bash
sudo cp deploy/systemd/lexflow-backup.service /etc/systemd/system/
sudo cp deploy/systemd/lexflow-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable lexflow-backup.timer
sudo systemctl start lexflow-backup.timer
```

### Verify

```bash
sudo systemctl status lexflow-backup.timer
sudo journalctl -u lexflow-backup -n 20
```

## Off-Site Backups

Backup files should be copied to a separate location:

| Method | Command |
|---|---|
| **rsync to backup server** | `rsync -avz /opt/lexflow/backups/ backup-server:/backups/lexflow/` |
| **S3-compatible storage** | `aws s3 sync /opt/lexflow/backups/ s3://lexflow-backups/` |
| **Encrypted archive** | `tar czf backup-$(date +%Y%m%d).tar.gz /opt/lexflow/backups/*.db.enc` |

### ⚠️ Security Rules

- **Never upload decrypted database files.** Only `.db.enc` files leave the server.
- **Never upload `.env` files.** They contain secrets.
- **Store the backup key separately from the backups.** If an attacker has both, encryption is worthless.
- Use separate credentials for backup storage (e.g., a dedicated S3 bucket with write-only IAM policy).

## Monitoring & Alerts

Set up alerts for the following conditions:

| Condition | Alert | Suggested Tool |
|---|---|---|
| No backup in 24 hours | CRITICAL | Cron mail, systemd failure notification, UptimeRobot |
| Backup size dropped >50% from average | WARNING | Custom script comparing file sizes |
| Backup verification failed | CRITICAL | Check exit code of `backup.js` |
| Restore drill overdue (>90 days) | WARNING | Calendar reminder, ticket system |

### Backup Size Check Example

```bash
#!/bin/bash
# /opt/lexflow/scripts/check-backup-size.sh
LATEST=$(ls -t /opt/lexflow/backups/*.db.enc | head -1)
SIZE=$(stat -c%s "$LATEST")
AVG=1200000  # expected ~1.2 MB, adjust based on your data
THRESHOLD=$((AVG / 2))

if [ "$SIZE" -lt "$THRESHOLD" ]; then
    echo "ALERT: Backup size ${SIZE} is below threshold ${THRESHOLD}"
    # send notification (email, Slack, etc.)
fi
```

## Backup Key Management

- The `LEXFLOW_BACKUP_KEY` is a 64 hex character string (32 bytes).
- Store it in a password manager, secrets vault, or hardware security module.
- **Do not store the key on the same filesystem as the backups.**
- Document the key location in your team's secrets runbook.

## See Also

- [Restore Guide](RESTORE.md)
- [SQLite Production Notes](SQLITE-PRODUCTION.md)
- [Environment Variables](ENVIRONMENT.md)
- [Production Checklist](PRODUCTION-CHECKLIST.md)
