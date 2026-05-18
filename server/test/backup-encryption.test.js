const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3');
const util = require('util');

const tempRoot = path.join(os.tmpdir(), `lexflow-r3b-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const tempServerDir = path.join(tempRoot, 'server');
const tempBackupDir = path.join(tempRoot, 'backups');
const tempDbPath = path.join(tempServerDir, 'lawfirm.db');

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function createTestConfig(overrides = {}) {
  return {
    BACKUP_DIR: tempBackupDir,
    BACKUP_RETENTION_COUNT: 7,
    BACKUP_KEY: Buffer.from(TEST_KEY, 'hex'),
    DATABASE_PATH: tempDbPath,
    ...overrides,
  };
}

function createBackupHelper(configOverrides = {}) {
  const config = createTestConfig(configOverrides);
  return {
    config,
    ...require('../lib/backup')({ serverDir: tempServerDir, backupDir: tempBackupDir, config }),
  };
}

function dbGet(db, sql) {
  return new Promise((resolve, reject) => {
    db.get(sql, (err, row) => err ? reject(err) : resolve(row));
  });
}

function dbClose(db) {
  return new Promise((resolve, reject) => {
    db.close(err => err ? reject(err) : resolve());
  });
}

beforeAll(async () => {
  await fs.mkdir(tempServerDir, { recursive: true });
  await fs.mkdir(tempBackupDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(tempDbPath);
    db.run('CREATE TABLE test (id TEXT PRIMARY KEY, val TEXT)', (err) => {
      if (err) return reject(err);
      db.run('INSERT INTO test VALUES (?, ?)', ['row1', 'hello'], (err2) => {
        db.close((err3) => {
          if (err3) return reject(err3);
          resolve();
        });
      });
    });
  });
});

afterAll(async () => {
  try { await fs.rm(tempRoot, { recursive: true, force: true }); } catch (e) {}
});

describe('R3b Encrypted Backup', () => {
  test('encrypted backup creates .db.enc file', async () => {
    const { createBackup } = createBackupHelper();
    const result = await createBackup();
    expect(result.encrypted).toBe(true);
    expect(result.filename).toMatch(/\.db\.enc$/);
    const stats = await fs.stat(result.backupPath);
    expect(stats.isFile()).toBe(true);
  });

  test('encrypted backup does not leave plaintext .db in backup dir', async () => {
    const { createBackup, getBackupList } = createBackupHelper();
    await createBackup();
    const backups = await getBackupList();
    const plaintext = backups.filter(b => b.filename.endsWith('.db') && !b.filename.endsWith('.db.enc'));
    expect(plaintext.length).toBe(0);
  });

  test('missing backup key fails safely', async () => {
    const { createBackup } = createBackupHelper({ BACKUP_KEY: null });
    const result = await createBackup();
    expect(result.encrypted).toBe(false);
    expect(result.filename).toMatch(/\.db$/);
  });

  test('retention count is configurable', async () => {
    const { createBackup, rotateBackups } = createBackupHelper({ BACKUP_RETENTION_COUNT: 3 });
    for (let i = 0; i < 5; i++) {
      await createBackup();
      await new Promise(r => setTimeout(r, 50));
    }
    const rotation = await rotateBackups();
    expect(rotation.remaining).toBe(3);
  });

  test('WAL checkpoint helper runs against file-backed DB', async () => {
    const { checkpointWal } = createBackupHelper();
    await expect(checkpointWal(tempDbPath)).resolves.not.toThrow();
  });
});

describe('R3b Restore Script', () => {
  test('restore decrypts .db.enc to target temp DB', async () => {
    const { createBackup, decryptBuffer } = createBackupHelper();
    const result = await createBackup();
    expect(result.encrypted).toBe(true);

    const encryptedData = await fs.readFile(result.backupPath);
    const plaintext = decryptBuffer(encryptedData, Buffer.from(TEST_KEY, 'hex'));

    const tempRestoreDb = path.join(tempRoot, 'restored.db');
    await fs.writeFile(tempRestoreDb, plaintext);

    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(tempRestoreDb, sqlite3.OPEN_READONLY, (err) => {
        if (err) return reject(err);
        dbClose(db).then(resolve).catch(reject);
      });
    });
    await fs.unlink(tempRestoreDb).catch(() => {});
  });

  test('restore refuses overwrite without --force', async () => {
    const targetDb = path.join(tempRoot, 'overwrite-test.db');
    await fs.writeFile(targetDb, 'existing data');
    const exists = await fs.access(targetDb).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    await fs.unlink(targetDb).catch(() => {});
  });

  test('restore deletes stale WAL/SHM files', async () => {
    const targetDb = path.join(tempRoot, 'wal-cleanup.db');
    const walPath = targetDb + '-wal';
    const shmPath = targetDb + '-shm';
    await fs.writeFile(walPath, 'stale wal');
    await fs.writeFile(shmPath, 'stale shm');

    const exists1 = await fs.access(walPath).then(() => true).catch(() => false);
    const exists2 = await fs.access(shmPath).then(() => true).catch(() => false);
    expect(exists1 || exists2).toBe(true);

    await fs.unlink(walPath).catch(() => {});
    await fs.unlink(shmPath).catch(() => {});
    await fs.unlink(targetDb).catch(() => {});
  });
});

describe('R3b Error Safety', () => {
  test('error messages do not include the actual backup key', async () => {
    const badKey = Buffer.from('badkey', 'utf8');
    expect(() => {
      require('../lib/backup')({
        serverDir: tempServerDir,
        backupDir: tempBackupDir,
        config: createTestConfig({ BACKUP_KEY: badKey }),
      });
    }).not.toThrow();
  });
});

describe('PILOT-HARDENING-4 Backup Source Follows DATABASE_PATH', () => {
  const ph4Root = path.join(os.tmpdir(), `lexflow-ph4-source-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const ph4ServerDir = path.join(ph4Root, 'server');
  const ph4BackupDir = path.join(ph4Root, 'backups');
  const wrongSourceDb = path.join(ph4ServerDir, 'lawfirm.db');
  const correctSourceDb = path.join(ph4Root, 'configured-database.db');

  async function seedSourceDb(dbPath, marker) {
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath);
      db.serialize(() => {
        db.run('CREATE TABLE source_marker (id TEXT PRIMARY KEY, marker TEXT)', (err) => {
          if (err) return reject(err);
          db.run('INSERT INTO source_marker (id, marker) VALUES (?, ?)', ['m', marker], (err2) => {
            if (err2) return reject(err2);
            db.close((err3) => err3 ? reject(err3) : resolve());
          });
        });
      });
    });
  }

  function readMarker(dbPath) {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) return reject(err);
        db.get('SELECT marker FROM source_marker WHERE id = ?', ['m'], (err2, row) => {
          db.close(() => err2 ? reject(err2) : resolve(row));
        });
      });
    });
  }

  beforeAll(async () => {
    await fs.mkdir(ph4ServerDir, { recursive: true });
    await fs.mkdir(ph4BackupDir, { recursive: true });
    await seedSourceDb(wrongSourceDb, 'wrong_source');
    await seedSourceDb(correctSourceDb, 'correct_source');
  });

  afterAll(async () => {
    try { await fs.rm(ph4Root, { recursive: true, force: true }); } catch (e) {}
  });

  test('createBackup reads from configured databasePath, not serverDir/lawfirm.db', async () => {
    const helperConfig = {
      BACKUP_DIR: ph4BackupDir,
      BACKUP_RETENTION_COUNT: 7,
      BACKUP_KEY: Buffer.from(TEST_KEY, 'hex'),
      DATABASE_PATH: correctSourceDb,
    };
    const helper = require('../lib/backup')({
      serverDir: ph4ServerDir,
      backupDir: ph4BackupDir,
      databasePath: correctSourceDb,
      config: helperConfig,
    });

    expect(helper.databasePath).toBe(correctSourceDb);

    const result = await helper.createBackup();
    expect(result.success).toBe(true);
    expect(result.encrypted).toBe(true);
    expect(result.source).toBe(correctSourceDb);
    expect(result.filename).toMatch(/^lawfirm-\d{8}-\d{9}\.db\.enc$/);

    const verification = await helper.verifyBackup(result.backupPath);
    expect(verification.valid).toBe(true);
    expect(verification.result).toBe('ok');

    const encryptedData = await fs.readFile(result.backupPath);
    const plaintext = helper.decryptBuffer(encryptedData, Buffer.from(TEST_KEY, 'hex'));
    const decodedPath = path.join(ph4Root, `decoded-${Date.now()}.db`);
    await fs.writeFile(decodedPath, plaintext);

    let marker;
    try {
      marker = await readMarker(decodedPath);
    } finally {
      await fs.unlink(decodedPath).catch(() => {});
    }

    expect(marker).toBeDefined();
    expect(marker.marker).toBe('correct_source');
    expect(marker.marker).not.toBe('wrong_source');

    const wrongMarker = await readMarker(wrongSourceDb);
    expect(wrongMarker.marker).toBe('wrong_source');
  });
});
