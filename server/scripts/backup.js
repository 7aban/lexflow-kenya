const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const config = require('../lib/config');
const { createBackup, rotateBackups, getBackupList } = require('../lib/backup')({
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
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, openErr => {
      if (openErr) return reject(openErr);
      const finish = err => db.close(closeErr => err || closeErr ? reject(err || closeErr) : resolve());
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
      )`, createErr => {
        if (createErr) return finish(createErr);
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
          finish,
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
    await log('Verifying staged backup before publication...');
    const result = await createBackup();
    await log(`Verification: ${result.verification.result}`);
    await log(`Backup created: ${result.filename}`);
    await log(`Size: ${result.size} bytes`);
    if (result.encrypted) {
      await log('Backup is encrypted (.db.enc)');
    }

    await log('Rotating old backups...');
    const rotation = await rotateBackups();
    await log(`Removed: ${rotation.removed}, Remaining: ${rotation.remaining}`);
    for (const skipped of rotation.skipped) {
      await log(`Excluded unverified backup from retention: ${skipped.filename}: ${skipped.reason}`);
    }

    await log('Current backups:');
    const backups = await getBackupList();
    for (const b of backups) {
      await log(`  ${b.filename} (${b.size} bytes, ${b.createdAt}${b.encrypted ? ', encrypted' : ''})`);
    }

    try {
      await recordBackupAudit(config.DATABASE_PATH, 'backup_created', {
        filename: result.filename,
        size: result.size,
        encrypted: result.encrypted,
        verificationResult: result.verification.result,
        retentionCount: config.BACKUP_RETENTION_COUNT,
        backupDir: config.BACKUP_DIR,
      });
      await log('Audit event backup_created recorded');
    } catch (auditErr) {
      await log(`Audit logging failed (non-fatal): ${auditErr.message}`);
    }

    await log('Backup completed successfully.');
    process.exitCode = 0;
  } catch (err) {
    const errorMsg = `Backup failed: ${err.message}`;
    await log(errorMsg).catch(logErr => console.error(`Backup failure logging failed: ${logErr.message}`));
    console.error(errorMsg);
    try {
      await recordBackupAudit(config.DATABASE_PATH, 'backup_failed', {
        filename: err.backupFilename || '',
        phase: err.backupPhase || 'operation',
        error: err.message,
        verificationResult: err.backupPhase === 'verification' ? 'failed' : 'not_successful',
        backupDir: config.BACKUP_DIR,
      });
      await log('Audit event backup_failed recorded');
    } catch (auditErr) {
      console.error(`Failure audit logging failed: ${auditErr.message}`);
    }
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(`Backup failed: ${err.message}`);
  process.exitCode = 1;
});
