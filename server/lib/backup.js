const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3');

module.exports = ({ serverDir, backupDir }) => {
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
    const timestamp = `${datePart}-${timePart}`;
    const filename = `lawfirm-${timestamp}.db`;
    const backupPath = path.join(backupDir, filename);
    await fs.copyFile(source, backupPath);
    const stats = await fs.stat(backupPath);
    return {
      success: true,
      backupPath,
      filename,
      timestamp,
      size: stats.size,
    };
  }

  async function rotateBackups(maxBackups = 7) {
    const files = (await fs.readdir(backupDir))
      .filter(f => f.startsWith('lawfirm-') && f.endsWith('.db'))
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

  function verifyBackup(backupPath) {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(backupPath, sqlite3.OPEN_READONLY, err => {
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
  }

  async function getBackupList() {
    const files = (await fs.readdir(backupDir))
      .filter(f => f.startsWith('lawfirm-') && f.endsWith('.db'))
      .map(f => {
        const filePath = path.join(backupDir, f);
        return fs.stat(filePath).then(s => ({
          filename: f,
          path: filePath,
          size: s.size,
          createdAt: s.mtime.toISOString(),
        })).catch(() => null);
      });
    const results = (await Promise.all(files)).filter(Boolean);
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return results;
  }

  return { ensureBackupDir, createBackup, rotateBackups, verifyBackup, getBackupList };
};
