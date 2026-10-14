const fs = require('fs').promises;
const path = require('path');
const config = require('../lib/config');
const { decryptBuffer } = require('../lib/backup')({
  serverDir: path.join(__dirname, '..'), backupDir: config.BACKUP_DIR, config,
});
const { validateStagedDatabase, stageRestoreAudit, replaceWindowsDestination } = require('../lib/restore');

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const backupArg = args.find(arg => !arg.startsWith('--'));
  if (!backupArg || args.some(arg => arg.startsWith('--') && arg !== '--force')) {
    throw new Error('Usage: node restore-backup.js <backup.db.enc|backup.db> [--force] (keep destination offline)');
  }
  const backupPath = path.resolve(backupArg);
  const targetDb = path.resolve(config.DATABASE_PATH);
  const encrypted = backupPath.endsWith('.db.enc');
  if (!encrypted && !backupPath.endsWith('.db')) throw new Error('Only .db.enc and .db backups are supported');
  if (encrypted && !config.BACKUP_KEY) throw new Error('LEXFLOW_BACKUP_KEY is required for encrypted backup restore');
  if (backupPath === targetDb) throw new Error('Backup source and destination must differ');
  try {
    const target = await fs.lstat(targetDb);
    if (!target.isFile() || target.isSymbolicLink()) throw new Error('Destination must be a regular file');
    if (!force) throw new Error(`Target database already exists: ${targetDb}; use --force to overwrite`);
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const input = await fs.readFile(backupPath);
  const plaintext = encrypted ? decryptBuffer(input, config.BACKUP_KEY) : input;
  await fs.mkdir(path.dirname(targetDb), { recursive: true });
  let operationDir;
  let retainRecovery = false;
  try {
    operationDir = await fs.mkdtemp(path.join(path.dirname(targetDb), '.lexflow-restore-'));
    const staged = path.join(operationDir, 'restored.db');
    await fs.writeFile(staged, plaintext, { flag: 'wx' });
    await validateStagedDatabase(staged);
    await stageRestoreAudit(staged, backupPath, targetDb);
    await validateStagedDatabase(staged);
    console.log('Staged SQLite integrity and minimum LexFlow schema verified. Destination must remain offline.');
    const result = await replaceWindowsDestination(operationDir, targetDb, force);
    console.log(`Restore completed successfully. Preserved original files during replacement: ${result.preservedOriginals}`);
    console.log('Audit event backup_restored recorded in restored database.');
  } catch (err) {
    retainRecovery = !!err.preserveRecovery;
    throw err;
  } finally {
    if (operationDir && !retainRecovery) {
      try { await fs.rm(operationDir, { recursive: true }); } catch (err) {
        console.error(`Operation-owned restoration files retained at ${operationDir}: ${err.message}`);
      }
    }
  }
}

main().catch(err => {
  console.error(`Restore failed: ${err.message}`);
  process.exitCode = 1;
});
