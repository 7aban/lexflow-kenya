const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const config = require('../lib/config');
const { decryptBuffer, checkpointWal } = require('../lib/backup')({
  serverDir: path.join(__dirname, '..'),
  backupDir: config.BACKUP_DIR,
  config,
});

function genId(prefix) {
  return `${prefix || 'ID'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function recordRestoreAudit(dbPath, sourceFile) {
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
            'backup_restored',
            'backup',
            sourceFile || '',
            '',
            '',
            '',
            '',
            JSON.stringify({ sourceFile, targetDb: dbPath }),
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

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const backupArg = args.find(a => !a.startsWith('--'));

  if (!backupArg) {
    console.error('Usage: node restore-backup.js <encrypted-backup-path> [--force]');
    console.error('  --force   Overwrite existing database without prompting');
    process.exit(1);
  }

  const backupPath = path.resolve(backupArg);
  const targetDb = config.DATABASE_PATH;

  if (!backupPath.endsWith('.db.enc')) {
    console.error('Error: Only encrypted backups (.db.enc) are supported');
    process.exit(1);
  }

  if (!config.BACKUP_KEY) {
    console.error('Error: LEXFLOW_BACKUP_KEY is required for encrypted backup restore');
    process.exit(1);
  }

  try {
    await fs.access(backupPath);
  } catch {
    console.error(`Error: Backup file not found: ${backupPath}`);
    process.exit(1);
  }

  try {
    await fs.access(targetDb);
    if (!force) {
      console.error(`Error: Target database already exists: ${targetDb}`);
      console.error('Use --force to overwrite');
      process.exit(1);
    }
    console.log('Overwriting existing database (--force specified)');
  } catch {
    // Target doesn't exist, proceed
  }

  try {
    console.log(`Reading encrypted backup: ${backupPath}`);
    const encryptedData = await fs.readFile(backupPath);

    console.log('Decrypting backup...');
    const plaintext = decryptBuffer(encryptedData, config.BACKUP_KEY);

    console.log(`Writing to target database: ${targetDb}`);
    await fs.mkdir(path.dirname(targetDb), { recursive: true });
    await fs.writeFile(targetDb, plaintext);

    const walPath = targetDb + '-wal';
    const shmPath = targetDb + '-shm';
    const dbWalPath = targetDb.replace(/\.db$/, '-wal.db');
    const dbShmPath = targetDb.replace(/\.db$/, '-shm.db');

    for (const stale of [walPath, shmPath, dbWalPath, dbShmPath]) {
      try {
        await fs.unlink(stale);
        console.log(`Removed stale file: ${stale}`);
      } catch {
        // Ignore missing files
      }
    }

    console.log('Restore completed successfully.');

    try {
      await recordRestoreAudit(targetDb, backupPath);
      console.log('Audit event backup_restored recorded in restored database.');
    } catch (auditErr) {
      console.log(`Audit logging failed (non-fatal): ${auditErr.message}`);
    }

    process.exit(0);
  } catch (err) {
    console.error(`Restore failed: ${err.message}`);
    process.exit(1);
  }
}

main();
