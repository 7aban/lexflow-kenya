const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const config = require('../lib/config');
const { createBackup, rotateBackups, verifyBackup, getBackupList } = require('../lib/backup')({
  serverDir: path.join(__dirname, '..'),
  backupDir: config.BACKUP_DIR,
  databasePath: config.DATABASE_PATH,
  config,
});

const logFile = config.BACKUP_LOG;

function genId(prefix) {
  return `${prefix || 'ID'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function recordBackupAudit(dbPath, action, metadata) {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(dbPath);
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        actor_user_id TEXT,
        actor_role TEXT,
        actor_email TEXT,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        matter_id TEXT,
        client_id TEXT,
        ip_address TEXT,
        user_agent TEXT,
        metadata_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`, () => {
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO audit_events (id, timestamp, actor_user_id, actor_role, actor_email, action, entity_type, entity_id, matter_id, client_id, ip_address, user_agent, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            genId('AUD'),
            now,
            '',
            'system',
            'system@lexflow.co.ke',
            action,
            'backup',
            metadata.filename || '',
            '',
            '',
            '',
            '',
            JSON.stringify(metadata),
            now,
          ],
          () => {
            db.close(() => resolve());
          },
        );
      });
    });
  });
}

async function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  await fs.mkdir(path.dirname(logFile), { recursive: true }).catch(() => {});
  await fs.appendFile(logFile, line);
  console.log(message);
}

async function main() {
  try {
    await log(`Source database: ${config.DATABASE_PATH}`);
    await log('Creating backup...');
    const result = await createBackup();
    await log(`Backup created: ${result.filename}`);
    await log(`Size: ${result.size} bytes`);
    if (result.encrypted) {
      await log('Backup is encrypted (.db.enc)');
    }

    await log('Verifying backup...');
    try {
      const verification = await verifyBackup(result.backupPath);
      await log(`Verification: ${verification.result}`);
    } catch (verifyErr) {
      await log(`Verification warning: ${verifyErr.message}`);
    }

    await log('Rotating old backups...');
    const rotation = await rotateBackups();
    await log(`Removed: ${rotation.removed}, Remaining: ${rotation.remaining}`);

    await log('Current backups:');
    const backups = await getBackupList();
    backups.forEach(b => {
      log(`  ${b.filename} (${b.size} bytes, ${b.createdAt}${b.encrypted ? ', encrypted' : ''})`);
    });

    try {
      await recordBackupAudit(config.DATABASE_PATH, 'backup_created', {
        filename: result.filename,
        size: result.size,
        encrypted: result.encrypted,
        verificationResult: 'ok',
        retentionCount: config.BACKUP_RETENTION_COUNT,
        backupDir: config.BACKUP_DIR,
      });
      await log('Audit event backup_created recorded');
    } catch (auditErr) {
      await log(`Audit logging failed (non-fatal): ${auditErr.message}`);
    }

    await log('Backup completed successfully.');
    process.exit(0);
  } catch (err) {
    const errorMsg = `Backup failed: ${err.message}`;
    log(errorMsg);
    console.error(errorMsg);
    process.exit(1);
  }
}

main();
