const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');
const makeHelper = require('../lib/backup');
const key = Buffer.from('cd'.repeat(32), 'hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-snapshot-tests-'));
const evidence = process.env.LEXFLOW_TEST_EVIDENCE_DIR || root;
fs.mkdirSync(evidence, { recursive: true });
let index = 0;
const open = file => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(file, err => err ? reject(err) : resolve(db));
});
const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, err => err ? reject(err) : resolve()));
const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (err, rows) => err ? reject(err) : resolve(rows)));
const close = db => new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function fixture(options = {}) {
  const dir = path.join(root, String(++index)); fs.mkdirSync(dir);
  const backups = path.join(dir, 'backups'); fs.mkdirSync(backups);
  const database = path.join(dir, 'synthetic.db');
  const db = await open(database);
  await exec(db, "CREATE TABLE sample(id INTEGER PRIMARY KEY,txt TEXT,num REAL,bytes BLOB); INSERT INTO sample VALUES(1,'initial',42.125,X'00FF8041');");
  await close(db);
  const helper = makeHelper({ serverDir: dir, databasePath: database, backupDir: backups,
    config: { BACKUP_KEY: key, BACKUP_RETENTION_COUNT: 2 }, ...options });
  return { dir, backups, database, helper };
}
function cli(f, script, args = [], preload) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(name)));
  const env = { ...inherited, NODE_ENV: 'production', JWT_SECRET: 'synthetic-snapshot-secret', DATABASE_PATH: f.database,
    BACKUP_DIR: f.backups, BACKUP_LOG: path.join(f.dir, 'cli.log'), LEXFLOW_BACKUP_KEY: key.toString('hex'),
    LEXFLOW_BACKUP_RETENTION_COUNT: '2', TEMP: f.dir, TMP: f.dir };
  const argv = [...(preload ? ['--require', preload] : []), path.join(__dirname, '../scripts', script), ...args];
  const start = Date.now();
  const r = spawnSync(process.execPath, argv, { cwd: f.dir, env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  const output = (r.stdout || '') + (r.stderr || '');
  const label = `snapshot-${index}-${script}`;
  fs.writeFileSync(path.join(evidence, label + '.log'), output);
  fs.writeFileSync(path.join(evidence, label + '.json'), JSON.stringify({ argv, status: r.status, signal: r.signal, error: r.error?.message, elapsedMs: Date.now() - start, fixture: f.dir }, null, 2));
  expect(r.error).toBeUndefined();
  return { ...r, output };
}
async function restoredRows(f, backup) {
  const target = path.join(f.dir, 'restored.db');
  const r = cli({ ...f, database: target }, 'restore-backup.js', [backup]);
  expect(r.status).toBe(0);
  const db = await open(target);
  try { return await all(db, 'SELECT id,txt,num,hex(bytes) bytes FROM sample ORDER BY id'); } finally { await close(db); }
}

test.each([false, true])('committed WAL records survive CLI backup/restore with older reader=%s', async olderReader => {
  const f = await fixture();
  const writer = await open(f.database);
  let reader;
  try {
    await exec(writer, 'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE);');
    if (olderReader) {
      reader = await open(f.database);
      await exec(reader, 'BEGIN');
      expect(await all(reader, 'SELECT id FROM sample')).toEqual([{ id: 1 }]);
    }
    await exec(writer, "INSERT INTO sample VALUES(2,'committed before backup',99.5,X'FF00');");
    expect(fs.statSync(f.database + '-wal').size).toBeGreaterThan(0);
    const r = cli(f, 'backup.js');
    expect(r.status).toBe(0);
    const files = fs.readdirSync(f.backups);
    expect(files).toHaveLength(1); // Includes absence of temporary plaintext directories.
    const rows = await restoredRows(f, path.join(f.backups, files[0]));
    expect(rows).toEqual([
      { id: 1, txt: 'initial', num: 42.125, bytes: '00FF8041' },
      { id: 2, txt: 'committed before backup', num: 99.5, bytes: 'FF00' },
    ]);
    if (reader) expect(await all(reader, 'SELECT id FROM sample')).toEqual([{ id: 1 }]);
  } finally {
    if (reader) { await exec(reader, 'ROLLBACK'); await close(reader); }
    await close(writer);
  }
}, 30000);

test('pinned boundary excludes a transaction committed between native copy steps', async () => {
  const f = await fixture();
  const writer = await open(f.database);
  await exec(writer, `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE padding(bytes BLOB); WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<300) INSERT INTO padding SELECT zeroblob(8192) FROM n;`);
  const original = sqlite3.Database.prototype.backup;
  let committedBetweenSteps = false;
  const spy = jest.spyOn(sqlite3.Database.prototype, 'backup').mockImplementation(function (...args) {
    const backup = original.apply(this, args);
    const step = backup.step.bind(backup);
    backup.step = (pages, callback) => step(pages, (err, done) => {
      if (err || committedBetweenSteps || done) return callback(err, done);
      committedBetweenSteps = true;
      exec(writer, "INSERT INTO sample VALUES(2,'committed after boundary',100,X'ABCD');")
        .then(() => callback(null, done), callback);
    });
    return backup;
  });
  try {
    const result = await f.helper.createBackup();
    expect(committedBetweenSteps).toBe(true);
    expect(result.snapshot).toMatchObject({ mechanism: 'sqlite-online-backup', boundaryAt: expect.any(String) });
    expect(await all(writer, 'SELECT id FROM sample ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await restoredRows(f, result.backupPath)).toEqual([{ id: 1, txt: 'initial', num: 42.125, bytes: '00FF8041' }]);
    expect(fs.readdirSync(f.backups)).toHaveLength(1);
  } finally { spy.mockRestore(); await close(writer); }
}, 30000);

test.each(['SQLITE_BUSY', 'SQLITE_IOERR'])('CLI %s during a partial native copy preserves old backups and reports failure', async code => {
  const f = await fixture();
  const old = [];
  for (let i = 0; i < 3; i++) {
    const result = await f.helper.createBackup(); old.push({ path: result.backupPath, hash: hash(result.backupPath) });
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const preload = path.join(f.dir, 'snapshot-failure.cjs');
  fs.writeFileSync(preload, `const s=require(${JSON.stringify(require.resolve('sqlite3'))});const original=s.Database.prototype.backup;
    s.Database.prototype.backup=function(...args){const b=original.apply(this,args),step=b.step.bind(b);b.step=(pages,cb)=>step(1,(err,done)=>{if(err)return cb(err);const e=new Error('synthetic incomplete snapshot ${code}');e.code='${code}';cb(e);});return b;};`);
  const r = cli(f, 'backup.js', [], preload);
  expect(r.status).toBe(1);
  expect(r.output).toContain(`synthetic incomplete snapshot ${code}`);
  expect(r.output).not.toContain('Backup completed successfully');
  expect(r.output).not.toContain('Rotating old backups');
  expect(r.output).not.toContain('Audit event backup_created recorded');
  for (const file of old) expect(hash(file.path)).toBe(file.hash);
  expect(fs.readdirSync(f.backups)).toHaveLength(3);
  const db = await open(f.database);
  try {
    const audit = await all(db, 'SELECT action,metadata_json FROM audit_events');
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('backup_failed');
    expect(JSON.parse(audit[0].metadata_json)).toMatchObject({ phase: 'snapshot', error: expect.stringContaining(code) });
  } finally { await close(db); }
}, 30000);

test('incomplete copy exceeds its deadline without publishing and cleans its owned plaintext snapshot', async () => {
  const f = await fixture({ snapshotTimeoutMs: 30 });
  const original = sqlite3.Database.prototype.backup;
  const spy = jest.spyOn(sqlite3.Database.prototype, 'backup').mockImplementation(function (...args) {
    const backup = original.apply(this, args);
    backup.step = (pages, callback) => { setTimeout(() => callback(null, false), 40); return backup; };
    return backup;
  });
  try { await expect(f.helper.createBackup()).rejects.toThrow('SQLite snapshot readiness deadline exceeded'); } finally { spy.mockRestore(); }
  expect(fs.readdirSync(f.backups)).toEqual([]);
});

test('legacy encrypted file verifies and restores without changing encryption format', async () => {
  const f = await fixture();
  const iv = Buffer.from('ef'.repeat(16), 'hex');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(fs.readFileSync(f.database)), cipher.final()]);
  const legacy = path.join(f.dir, 'legacy.db.enc');
  fs.writeFileSync(legacy, Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
  expect(await f.helper.verifyBackup(legacy)).toEqual({ valid: true, result: 'ok' });
  expect(await restoredRows(f, legacy)).toEqual([{ id: 1, txt: 'initial', num: 42.125, bytes: '00FF8041' }]);
}, 30000);

test('plaintext backup remains a standalone valid SQLite file', async () => {
  const f = await fixture({ config: { BACKUP_KEY: null, BACKUP_RETENTION_COUNT: 2 } });
  const result = await f.helper.createBackup();
  expect(result.filename).toMatch(/^lawfirm-\d{8}-\d{9}\.db$/);
  expect(await f.helper.verifyBackup(result.backupPath)).toEqual({ valid: true, result: 'ok' });
  expect(fs.readdirSync(f.backups)).toHaveLength(1);
});
