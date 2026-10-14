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

module.exports = ({ serverDir, backupDir, config, databasePath }) => {
  // Resolve the backup source: prefer the explicitly configured databasePath
  // (config.DATABASE_PATH at runtime) and fall back to the legacy server/lawfirm.db
  // location only when no databasePath is provided (test helpers that pass serverDir).
  const resolvedDatabasePath = databasePath || path.join(serverDir, 'lawfirm.db');

  function ensureBackupDir() {
    return fs.mkdir(backupDir, { recursive: true });
  }

  async function createBackup() {
    await ensureBackupDir();
    const source = resolvedDatabasePath;
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
    // Keep incomplete/unverified files outside the published retention namespace.
    const stagedPath = path.join(backupDir, `.lexflow-stage-${crypto.randomUUID()}-${filename}`);
    let stagedOwned = false;
    let publishedOwned = false;
    let phase = 'creation';
    try {
      const plaintext = await fs.readFile(source);
      const handle = await fs.open(stagedPath, 'wx');
      stagedOwned = true;
      try {
        await handle.writeFile(key ? encryptBuffer(plaintext, key) : plaintext);
      } finally {
        await handle.close();
      }
      phase = 'verification';
      const verification = await verifyBackup(stagedPath);
      if (!verification.valid || verification.result !== 'ok') {
        throw new Error(`Backup verification failed: ${verification.result}`);
      }
      phase = 'publication';
      // Same-directory hard link publishes atomically without overwriting an older
      // backup if another operation generated the same legacy timestamp name.
      await fs.link(stagedPath, backupPath);
      publishedOwned = true;
      await fs.unlink(stagedPath);
      stagedOwned = false;
      const stats = await fs.stat(backupPath);
      return {
        success: true,
        backupPath,
        filename,
        timestamp,
        size: stats.size,
        encrypted: !!key,
        source,
        verification,
      };
    } catch (err) {
      err.backupPhase = phase;
      err.backupFilename = filename;
      const cleanupErrors = [];
      for (const ownedPath of [stagedOwned && stagedPath, publishedOwned && backupPath].filter(Boolean)) {
        try { await fs.unlink(ownedPath); } catch (cleanupErr) {
          if (cleanupErr.code !== 'ENOENT') cleanupErrors.push(cleanupErr.message);
        }
      }
      if (cleanupErrors.length) err.message += `; current-operation cleanup failed: ${cleanupErrors.join('; ')}`;
      throw err;
    }
  }

  async function rotateBackups(maxBackups = config.BACKUP_RETENTION_COUNT) {
    const candidates = (await fs.readdir(backupDir))
      .filter(f => f.startsWith('lawfirm-') && (f.endsWith('.db') || f.endsWith('.db.enc')))
      .map(f => ({
        filename: f,
        path: path.join(backupDir, f),
      }));
    const files = [];
    const skipped = [];
    // Historical names alone do not prove verification. Never count or delete
    // an artifact that cannot be verified with the current configuration.
    for (const f of candidates) {
      try {
        await verifyBackup(f.path);
        f.mtime = (await fs.stat(f.path)).mtimeMs;
        files.push(f);
      } catch (err) {
        skipped.push({ filename: f.filename, reason: err.message });
      }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    while (files.length > maxBackups) {
      const oldest = files.shift();
      await fs.unlink(oldest.path);
      removed += 1;
    }
    return { removed, remaining: files.length, skipped };
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
        tempDbPath = path.join(os.tmpdir(), `lexflow-verify-${crypto.randomUUID()}.db`);
        const handle = await fs.open(tempDbPath, 'wx');
        cleanup = true;
        try { await handle.writeFile(plaintext); } finally { await handle.close(); }
      }
      // Ensure file exists and is readable
      await fs.access(tempDbPath, fs.constants.R_OK);
      const stats = await fs.stat(tempDbPath);
      if (stats.size === 0) throw new Error('Backup file is empty');
      return await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(tempDbPath, sqlite3.OPEN_READONLY, (err) => {
          if (err) return reject(new Error(`Cannot open backup: ${err.message}`));
          db.get("PRAGMA integrity_check", (err2, row) => {
            db.close(closeErr => {
              if (err2) return reject(new Error(`Integrity check failed: ${err2.message}`));
              if (closeErr) return reject(new Error(`Cannot close backup: ${closeErr.message}`));
              if (row && String(row.integrity_check || '').toLowerCase() === 'ok') {
                resolve({ valid: true, result: 'ok' });
              } else {
                reject(new Error(`Backup is corrupted: ${JSON.stringify(row)}`));
              }
            });
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

  return {
    ensureBackupDir,
    createBackup,
    rotateBackups,
    verifyBackup,
    getBackupList,
    checkpointWal,
    decryptBuffer,
    databasePath: resolvedDatabasePath,
  };
};
