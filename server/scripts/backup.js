const fs = require('fs').promises;
const path = require('path');
const { createBackup, rotateBackups, verifyBackup, getBackupList } = require('../lib/backup')({
  serverDir: path.join(__dirname, '..'),
  backupDir: path.join(__dirname, '..', '..', 'backups'),
});

const logFile = path.join(__dirname, '..', '..', 'logs', 'backup.log');

async function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  await fs.mkdir(path.dirname(logFile), { recursive: true }).catch(() => {});
  await fs.appendFile(logFile, line);
  console.log(message);
}

async function main() {
  try {
    await log('Creating backup...');
    const result = await createBackup();
    await log(`Backup created: ${result.filename}`);
    await log(`Size: ${result.size} bytes`);

    await log('Verifying backup...');
    const verification = await verifyBackup(result.backupPath);
    await log(`Verification: ${verification.result}`);

    await log('Rotating old backups...');
    const rotation = await rotateBackups(7);
    await log(`Removed: ${rotation.removed}, Remaining: ${rotation.remaining}`);

    await log('Current backups:');
    const backups = await getBackupList();
    backups.forEach(b => {
      log(`  ${b.filename} (${b.size} bytes, ${b.createdAt})`);
    });

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
