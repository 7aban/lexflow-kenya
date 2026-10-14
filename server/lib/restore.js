const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const sqlite3 = require('sqlite3');

const requiredSchema = {
  users: ['id', 'email', 'password', 'fullName', 'role'],
  clients: ['id', 'name'], matters: ['id', 'reference', 'clientId', 'title'],
  time_entries: ['id', 'matterId', 'hours'], invoices: ['id', 'matterId', 'amount'],
  firm_settings: ['id', 'name'],
};

async function withDatabase(file, mode, work) {
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(file, mode, err => err ? reject(err) : resolve(connection));
  });
  const all = (sql, values = []) => new Promise((resolve, reject) => db.all(sql, values, (err, rows) => err ? reject(err) : resolve(rows)));
  const run = (sql, values = []) => new Promise((resolve, reject) => db.run(sql, values, err => err ? reject(err) : resolve()));
  try { return await work({ all, run }); } finally {
    await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
  }
}

async function validateStagedDatabase(file) {
  const header = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await header.read(bytes, 0, 16, 0);
    if (bytesRead !== 16 || bytes.toString() !== 'SQLite format 3\0') throw new Error('Staged payload is not a SQLite database');
  } finally { await header.close(); }
  await withDatabase(file, sqlite3.OPEN_READONLY, async ({ all }) => {
    const integrity = await all('PRAGMA integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error(`Staged SQLite integrity failed: ${JSON.stringify(integrity)}`);
    for (const [table, columns] of Object.entries(requiredSchema)) {
      const tables = await all("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]);
      if (tables.length !== 1) throw new Error(`Incompatible LexFlow schema: missing table ${table}`);
      const present = new Set((await all(`PRAGMA table_info("${table}")`)).map(row => row.name));
      const missing = columns.filter(column => !present.has(column));
      if (missing.length) throw new Error(`Incompatible LexFlow schema: ${table} missing ${missing.join(', ')}`);
    }
  });
}

async function stageRestoreAudit(file, sourceFile, targetDb) {
  await withDatabase(file, sqlite3.OPEN_READWRITE, async ({ run }) => {
    await run(`CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT,
      actor_email TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
      matter_id TEXT, client_id TEXT, ip_address TEXT, user_agent TEXT, metadata_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    const now = new Date().toISOString();
    await run(`INSERT INTO audit_events (id,timestamp,actor_user_id,actor_role,actor_email,action,
      entity_type,entity_id,matter_id,client_id,ip_address,user_agent,metadata_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [`AUD-${require('crypto').randomUUID()}`, now, '', 'system', 'system@lexflow.co.ke',
      'backup_restored', 'backup', sourceFile, '', '', '', '', JSON.stringify({ sourceFile, targetDb }), now]);
    await run('PRAGMA journal_mode=DELETE');
  });
}

async function replaceWindowsDestination(operationDir, targetDb, force) {
  if (process.platform !== 'win32') throw new Error('Protected restoration currently requires Windows');
  const request = path.join(operationDir, 'replacement.json');
  await fs.writeFile(request, JSON.stringify({ operationDir, targetDb, force }), { flag: 'wx' });
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, '../scripts/replace-restore.ps1'), '-RequestPath', request],
    { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      let result;
      try { result = JSON.parse(stdout.trim()); } catch {
        const failure = new Error(`Replacement outcome unknown; preserve recovery files at ${operationDir}: ${stderr || err?.message || stdout}`);
        failure.preserveRecovery = true;
        return reject(failure);
      }
      if (err || !result.success) {
        const failure = new Error(result.error || 'Protected replacement failed');
        failure.preserveRecovery = !!result.recoverable;
        return reject(failure);
      }
      resolve(result);
    });
  });
}

module.exports = { validateStagedDatabase, stageRestoreAudit, replaceWindowsDestination };
