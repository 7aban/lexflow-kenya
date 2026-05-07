# SQLite Production Notes

## Suitability

SQLite is **acceptable for initial single-instance production deployments** of LexFlow. It is:
- Zero-configuration — no separate database server needed.
- Reliable — used in production by companies like Apple, Airbus, and Dropbox.
- Sufficient for low-to-moderate write concurrency (typical for early-stage legal SaaS).

## Current Configuration

LexFlow uses SQLite with the following safety settings:

| Setting | Value | Purpose |
|---|---|---|
| WAL mode | `journal_mode=wal` | Write-Ahead Logging — prevents reader/writer blocking |
| busy_timeout | `5000` (ms) | Auto-retry on `SQLITE_BUSY` for up to 5 seconds |
| Foreign keys | `PRAGMA foreign_keys=ON` | Enforce referential integrity |

## WAL Mode

WAL (Write-Ahead Logging) creates additional files alongside the main database:
- `lawfirm.db-wal` — write-ahead log
- `lawfirm.db-shm` — shared memory map

These files are **required** when the database is in WAL mode. Do not delete them while the server is running.

### WAL Checkpointing

Backups in LexFlow perform a WAL checkpoint before copying, ensuring a consistent snapshot. Manual checkpoint:

```sql
PRAGMA wal_checkpoint(TRUNCATE);
```

## Backups

- LexFlow creates **encrypted** backups via `scripts/backup.js`.
- Backups are WAL-safe — the database is checkpointed before backup.
- Encryption uses AES-256-CBC with a configurable key (`LEXFLOW_BACKUP_KEY`).
- See [Backup Automation](BACKUP-AUTOMATION.md) for scheduling.
- See [Restore Guide](RESTORE.md) for recovery procedures.

## DB File Permissions

```bash
sudo chown lexflow:www-data /opt/lexflow/server/lawfirm.db
sudo chmod 660 /opt/lexflow/server/lawfirm.db
```

The database directory should also be restricted:

```bash
sudo chown lexflow:www-data /opt/lexflow/server/
sudo chmod 750 /opt/lexflow/server/
```

## Disk Space Monitoring

SQLite databases grow but do not automatically shrink. Monitor:

```bash
du -sh /opt/lexflow/server/lawfirm.db*
df -h /opt/lexflow
```

Set up alerts when:
- Database file exceeds 5 GB
- Disk usage exceeds 80%

## VACUUM and Integrity

### VACUUM

Reclaims space from deleted rows. Run during a maintenance window:

```bash
cd /opt/lexflow/server
sqlite3 lawfirm.db "VACUUM;"
```

⚠️ **Stop the LexFlow backend before VACUUM** — the database file is rewritten in place.

### Integrity Check

```bash
sqlite3 lawfirm.db "PRAGMA integrity_check;"
```

Expected output: `ok`. Run monthly or after any suspected corruption.

## ⚠️ Single-Instance Limitation

**Do not run multiple LexFlow backend instances** with SQLite. SQLite serializes writes — concurrent writers from multiple processes will cause conflicts.

This means:
- No load balancer with multiple backend nodes
- No Docker replicas sharing the same `.db` file
- No horizontal scaling until PostgreSQL migration

## PostgreSQL Migration Triggers

Consider migrating to PostgreSQL when **any** of these conditions are met:

| Trigger | Threshold |
|---|---|
| **Multi-instance required** | Need to run 2+ backend servers behind a load balancer |
| **Database size** | Approaching 10 GB total |
| **Write concurrency** | Frequent `SQLITE_BUSY` errors despite `busy_timeout` |
| **Document storage** | Heavy document storage inflating DB size; better served by object storage |
| **Performance** | Sustained slow queries under normal load |
| **Feature needs** | Require PostgreSQL-specific features (full-text search, JSONB, etc.) |

Migration path:
1. Set up PostgreSQL instance
2. Create migration scripts (schema + data export/import)
3. Test on staging with production data copy
4. Schedule maintenance window
5. Export SQLite → import PostgreSQL → verify → switch backend
6. Run full regression test suite

## See Also

- [Backup Automation](BACKUP-AUTOMATION.md)
- [Restore Guide](RESTORE.md)
- [Process Management](PROCESS-MANAGEMENT.md)
- [Production Checklist](PRODUCTION-CHECKLIST.md)
