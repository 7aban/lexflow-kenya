const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3');

const tempRoot = path.join(os.tmpdir(), `lexflow-backup-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const tempServerDir = path.join(tempRoot, 'server');
const tempBackupDir = path.join(tempRoot, 'backups');

let backupHelper;

beforeAll(async () => {
  // Create temp directories
  await fs.mkdir(tempServerDir, { recursive: true });
  await fs.mkdir(tempBackupDir, { recursive: true });

  // Create a minimal valid SQLite database
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(tempServerDir, 'lawfirm.db'));
    db.run('CREATE TABLE test (id TEXT PRIMARY KEY)', (err) => {
      if (err) return reject(err);
      db.run('INSERT INTO test VALUES (?)', ['item1'], (err2) => {
        db.close((err3) => {
          if (err3) return reject(err3);
          resolve();
        });
      });
    });
  });

  // Initialize backup helper with temp directories
  backupHelper = require('../lib/backup')({
    serverDir: tempServerDir,
    backupDir: tempBackupDir,
  });
});

afterAll(async () => {
  // Clean up temp directories
  try {
    await fs.rm(tempRoot, { recursive: true, force: true });
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
});

describe('Backup Helper Tests', () => {
  test('createBackup creates a timestamped .db file', async () => {
    const result = await backupHelper.createBackup();
    expect(result.success).toBe(true);
    expect(result.filename).toMatch(/^lawfirm-\d{8}-\d{6}\.db$/);
    expect(result.size).toBeGreaterThan(0);
    expect(result.backupPath).toBeDefined();
    
    // Verify file exists
    const stats = await fs.stat(result.backupPath);
    expect(stats.isFile()).toBe(true);
  });

  test('verifyBackup passes for valid SQLite backup', async () => {
    const result = await backupHelper.createBackup();
    const verification = await backupHelper.verifyBackup(result.backupPath);
    expect(verification.valid).toBe(true);
    expect(verification.result).toBe('ok');
  });

  test('getBackupList returns newest first', async () => {
    // Create multiple backups with delays for unique timestamps
    await backupHelper.createBackup();
    await new Promise(resolve => setTimeout(resolve, 1100));
    await backupHelper.createBackup();
    await new Promise(resolve => setTimeout(resolve, 1100));
    await backupHelper.createBackup();

    const backups = await backupHelper.getBackupList();
    expect(Array.isArray(backups)).toBe(true);
    expect(backups.length).toBeGreaterThanOrEqual(3);

    // Check each item has required properties
    backups.forEach(backup => {
      expect(backup).toHaveProperty('filename');
      expect(backup).toHaveProperty('path');
      expect(backup).toHaveProperty('size');
      expect(backup).toHaveProperty('createdAt');
    });

    // Verify newest first by createdAt
    for (let i = 0; i < backups.length - 1; i++) {
      expect(new Date(backups[i].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(backups[i + 1].createdAt).getTime()
      );
    }
  });

  test('rotateBackups removes old backups beyond maxBackups', async () => {
    // Create 5 backups
    for (let i = 0; i < 5; i++) {
      await backupHelper.createBackup();
      if (i < 4) await new Promise(resolve => setTimeout(resolve, 1100));
    }

    const rotation = await backupHelper.rotateBackups(2);
    expect(rotation.removed).toBeGreaterThanOrEqual(3);
    expect(rotation.remaining).toBeLessThanOrEqual(2);

    // Verify with getBackupList
    const backups = await backupHelper.getBackupList();
    expect(backups.length).toBeLessThanOrEqual(2);
  });

  test('verifyBackup rejects invalid/non-SQLite file', async () => {
    // Create a text file that's not a database
    const textFilePath = path.join(tempBackupDir, 'not-a-db.txt');
    await fs.writeFile(textFilePath, 'not a database', 'utf8');

    await expect(backupHelper.verifyBackup(textFilePath)).rejects.toThrow();
    
    // Clean up
    try { await fs.unlink(textFilePath); } catch (e) {}
  });
});
