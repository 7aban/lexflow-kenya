const path = require('path');
const { createBackup, rotateBackups, verifyBackup, getBackupList } = require('../lib/backup')({
  serverDir: path.join(__dirname, '..'),
  backupDir: path.join(__dirname, '..', 'backups'),
});

async function main() {
  try {
    console.log('Creating backup...');
    const result = await createBackup();
    console.log(`Backup created: ${result.filename}`);
    console.log(`Size: ${result.size} bytes`);

    console.log('Verifying backup...');
    const verification = await verifyBackup(result.backupPath);
    console.log(`Verification: ${verification.result}`);

    console.log('Rotating old backups...');
    const rotation = await rotateBackups(7);
    console.log(`Removed: ${rotation.removed}, Remaining: ${rotation.remaining}`);

    console.log('Current backups:');
    const backups = await getBackupList();
    backups.forEach(b => {
      console.log(`  ${b.filename} (${b.size} bytes, ${b.createdAt})`);
    });

    console.log('Backup completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Backup failed:', err.message);
    process.exit(1);
  }
}

main();
