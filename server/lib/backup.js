const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getBackupKey() {
  const key = process.env.LEXFLOW_BACKUP_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('LEXFLOW_BACKUP_KEY environment variable is required in production');
    }
    return null;
  }
  if (Buffer.from(key, 'hex').length !== 32) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('LEXFLOW_BACKUP_KEY must be 64 hex characters (32 bytes)');
    }
    return null;
  }
  return Buffer.from(key, 'hex');
}

function encryptBuffer(plaintext, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptBuffer(encryptedData, key) {
  const iv = encryptedData.slice(0, IV_LENGTH);
  const authTag = encryptedData.slice(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = encryptedData.slice(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function checkpointWal(dbPath) {
  return new Promise((resolve, reject) => {
    const tempDb = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
      if (err) return reject(err);
      tempDb.exec("PRAGMA wal_checkpoint(FULL)", (err2) => {
        tempDb.close();
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

module.exports = ({ serverDir, backupDir, config }) => {
  function ensureBackupDir() {
    return fs.mkdir(backupDir, { recursive: true });
  }

  async function createBackup() {
    await ensureBackupDir();
    const source = path.join(serverDir, 'lawfirm.db');
    const now = new Date();
    const ts = now.toISOString();
    const datePart = ts.slice(0, 10).replace(/-/g, '');
    const timePart = ts.slice(11, 19).replace(/:/g, '');
    const msPart = String(now.getMilliseconds()).padStart(3, '0');
    const timestamp = `${datePart}-${timePart}${msPart}`;

    // WAL-safe checkpoint before backup
    try {
      await checkpointWal(source);
    } catch (e) {
      console.error('WAL checkpoint warning:', e.message);
    }

    const key = config.BACKUP_KEY;
    const ext = key ? '.db.enc' : '.db';
    const filename = `lawfirm-${timestamp}${ext}`;
    const backupPath = path.join(backupDir, filename);

    if (key) {
      const plaintext = await fs.readFile(source);
      const encrypted = encryptBuffer(plaintext, key);
      await fs.writeFile(backupPath, encrypted);
    } else {
      await fs.copyFile(source, backupPath);
    }

    const stats = await fs.stat(backupPath);
    return {
      success: true,
      backupPath,
      filename,
      timestamp,
      size: stats.size,
      encrypted: !!key,
    };
  }

  async function rotateBackups(maxBackups = config.BACKUP_RETENTION_COUNT) {
    const files = (await fs.readdir(backupDir))
      .filter(f => f.startsWith('lawfirm-') && (f.endsWith('.db') || f.endsWith('.db.enc')))
      .map(f => ({
        filename: f,
        path: path.join(backupDir, f),
        mtime: fs.stat(path.join(backupDir, f)).then(s => s.mtimeMs).catch(() => 0),
      }));
    for (const f of files) f.mtime = await f.mtime;
    files.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    while (files.length > maxBackups) {
      const oldest = files.shift();
      await fs.unlink(oldest.path).catch(() => {});
      removed += 1;
    }
    return { removed, remaining: files.length };
  }

  async function verifyBackup(backupPath) {
    const isEnc = backupPath.endsWith('.db.enc');
    let tempDbPath = backupPath;
    let cleanup = false;
    try {
      if (isEnc) {
        const key = config.BACKUP_KEY;
        if (!key) throw new Error('Cannot verify encrypted backup: no BACKUP_KEY');
        const encryptedData = await fs.readFile(backupPath);
        const plaintext = decryptBuffer(encryptedData, key);
        const os = require('os');
        const path = require('path');
        tempDbPath = path.join(os.tmpdir(), `lexflow-verify-${Date.now()}.db`);
        await fs.writeFile(tempDbPath, plaintext);
        cleanup = true;
        // Clean up possible WAL/SHM files created when SQLite opens the temp DB
        for (const ext of ['-wal', '-shm', '.db-wal', '.db-shm']) {
          try { await fs.unlink(tempDbPath + ext); } catch (e) {}
        }
      }
      // Ensure file exists and is readable
      await fs.access(tempDbPath, fs.constants.R_OK);
      const stats = await fs.stat(tempDbPath);
      if (stats.size === 0) throw new Error('Backup file is empty');
      return await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(tempDbPath, sqlite3.OPEN_READONLY, (err) => {
          if (err) return reject(new Error(`Cannot open backup: ${err.message}`));
          db.get("PRAGMA integrity_check", (err2, row) => {
            db.close();
            if (err2) return reject(new Error(`Integrity check failed: ${err2.message}`));
            if (row && String(row.integrity_check || '').toLowerCase() === 'ok') {
              resolve({ valid: true, result: 'ok' });
            } else {
              reject(new Error(`Backup is corrupted: ${JSON.stringify(row)}`));
            }
          });
        });
      });
    } finally {
      if (cleanup) {
        await fs.unlink(tempDbPath).catch(() => {});
      }
    }
  }

  async function getBackupList() {
    const files = (await fs.readdir(backupDir))
      .filter(f => f.startsWith('lawfirm-') && (f.endsWith('.db') || f.endsWith('.db.enc')))
      .map(f => {
        const filePath = path.join(backupDir, f);
        return fs.stat(filePath).then(s => ({
          filename: f,
          path: filePath,
          size: s.size,
          createdAt: s.mtime.toISOString(),
          encrypted: f.endsWith('.db.enc'),
        })).catch(() => null);
      });
    const results = (await Promise.all(files)).filter(Boolean);
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return results;
  }

  return { ensureBackupDir, createBackup, rotateBackups, verifyBackup, getBackupList, checkpointWal, decryptBuffer };
};
