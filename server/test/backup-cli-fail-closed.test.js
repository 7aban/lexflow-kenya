const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');

const key = Buffer.from('ab'.repeat(32), 'hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-backup-cli-'));
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

async function fixture() {
  const dir = path.join(root, String(++index));
  fs.mkdirSync(dir);
  const database = path.join(dir, 'synthetic.db');
  const backups = path.join(dir, 'backups');
  fs.mkdirSync(backups);
  const db = await open(database);
  await exec(db, "CREATE TABLE sample(id INTEGER, txt TEXT, num REAL, bytes BLOB); INSERT INTO sample VALUES(1,'synthetic text',42.125,X'00FF8041');");
  await close(db);
  const config = { BACKUP_KEY: key, BACKUP_RETENTION_COUNT: 2 };
  const helper = require('../lib/backup')({ serverDir: dir, databasePath: database, backupDir: backups, config });
  return { dir, database, backups, helper };
}

function cli(f, extra = {}, preload) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(name)));
  const env = { ...inherited, NODE_ENV: 'production', JWT_SECRET: 'synthetic-cli-only-secret', DATABASE_PATH: f.database,
    BACKUP_DIR: f.backups, BACKUP_LOG: path.join(f.dir, 'backup.log'), LEXFLOW_BACKUP_KEY: key.toString('hex'),
    LEXFLOW_BACKUP_RETENTION_COUNT: '2', TEMP: f.dir, TMP: f.dir, ...extra };
  const args = [...(preload ? ['--require', preload] : []), path.join(__dirname, '../scripts/backup.js')];
  const start = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: f.dir, env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  const output = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(evidence, `cli-${index}.log`), output);
  fs.writeFileSync(path.join(evidence, `cli-${index}.json`), JSON.stringify({ args, status: result.status, signal: result.signal, error: result.error?.message, elapsedMs: Date.now() - start, fixture: f.dir }, null, 2));
  expect(result.error).toBeUndefined();
  return { ...result, output };
}

async function audits(f) {
  const db = await open(f.database);
  try { return await all(db, 'SELECT action,metadata_json FROM audit_events'); } finally { await close(db); }
}

test('CLI verifies a staged encrypted file before publishing; legacy format remains readable', async () => {
  const f = await fixture();
  const trace = path.join(f.dir, 'trace.json');
  const preload = path.join(f.dir, 'publication-probe.cjs');
  // External instrumentation observes the integrity callback and publication.
  fs.writeFileSync(preload, `const fs=require('fs'),s=require(${JSON.stringify(require.resolve('sqlite3'))});
    let checked=false;const get=s.Database.prototype.get;
    s.Database.prototype.get=function(sql,...args){if(sql==='PRAGMA integrity_check'){const cb=args.pop();args.push(function(err,row){if(!err&&row.integrity_check==='ok')checked=true;cb.apply(this,arguments);});}return get.call(this,sql,...args);};
    const link=fs.promises.link;fs.promises.link=async function(stage,dest){fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify({checked,stageExists:fs.existsSync(stage),destExists:fs.existsSync(dest),stage,dest}));return link.call(this,stage,dest);};`);
  const result = cli(f, {}, preload);
  expect(result.status).toBe(0);
  expect(JSON.parse(fs.readFileSync(trace))).toMatchObject({ checked: true, stageExists: true, destExists: false });
  const files = fs.readdirSync(f.backups);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^lawfirm-\d{8}-\d{9}\.db\.enc$/);
  const bytes = fs.readFileSync(path.join(f.backups, files[0]));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 16));
  decipher.setAuthTag(bytes.subarray(16, 32));
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
  expect(plaintext.subarray(0, 16).toString()).toBe('SQLite format 3\0');
  const decoded = path.join(f.dir, 'decoded.db');
  fs.writeFileSync(decoded, plaintext);
  const db = await open(decoded);
  try { expect(await all(db, 'SELECT txt,num,hex(bytes) bytes FROM sample')).toEqual([{ txt: 'synthetic text', num: 42.125, bytes: '00FF8041' }]); } finally { await close(db); }
  expect(await audits(f)).toEqual([expect.objectContaining({ action: 'backup_created', metadata_json: expect.stringContaining('"verificationResult":"ok"') })]);
  expect(result.output).toContain('Backup completed successfully.');
}, 30000);

test('CLI regression: verification I/O failure exits nonzero, preserves older bytes and skips success audit/rotation', async () => {
  const f = await fixture();
  const old = [];
  for (let i = 0; i < 3; i++) {
    const result = await f.helper.createBackup();
    old.push({ path: result.backupPath, hash: hash(result.backupPath) });
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const orphan = path.join(f.backups, '.lexflow-stage-prior.db.enc');
  fs.writeFileSync(orphan, 'prior operation artifact');
  const badTemp = path.join(f.dir, 'regular-file');
  fs.writeFileSync(badTemp, 'not a directory');
  const result = cli(f, { TEMP: badTemp, TMP: badTemp });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/Backup failed:.*(ENOENT|ENOTDIR)/);
  expect(result.output).not.toContain('Backup completed successfully');
  expect(result.output).not.toContain('Rotating old backups');
  expect(result.output).not.toContain('Audit event backup_created recorded');
  for (const file of old) expect(hash(file.path)).toBe(file.hash);
  expect(fs.readFileSync(orphan, 'utf8')).toBe('prior operation artifact');
  expect(fs.readdirSync(f.backups)).toHaveLength(4);
  const events = await audits(f);
  expect(events).toHaveLength(1);
  expect(events[0].action).toBe('backup_failed');
  expect(JSON.parse(events[0].metadata_json)).toMatchObject({ phase: 'verification', verificationResult: 'failed', error: expect.stringMatching(/ENOENT|ENOTDIR/) });
  expect(await f.helper.getBackupList()).toHaveLength(3);
}, 30000);

test('successful retention counts only verified published files, excludes invalid and staging artifacts', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) { await f.helper.createBackup(); await new Promise(resolve => setTimeout(resolve, 5)); }
  const invalid = path.join(f.backups, 'lawfirm-invalid.db.enc');
  fs.writeFileSync(invalid, 'invalid ciphertext');
  const invalidHash = hash(invalid);
  const staged = path.join(f.backups, '.lexflow-stage-orphan.db.enc');
  fs.writeFileSync(staged, 'unpublished');
  const result = cli(f);
  expect(result.status).toBe(0);
  expect(result.output).toContain('Remaining: 2');
  expect(result.output).toContain('Excluded unverified backup from retention: lawfirm-invalid.db.enc');
  expect(hash(invalid)).toBe(invalidHash);
  expect(fs.readFileSync(staged, 'utf8')).toBe('unpublished');
  expect(fs.readdirSync(f.backups).filter(name => /^lawfirm-\d/.test(name))).toHaveLength(2);
}, 30000);

test('audit INSERT error is reported without claiming insertion succeeded', async () => {
  const f = await fixture();
  const db = await open(f.database);
  await exec(db, `CREATE TABLE audit_events(id TEXT,timestamp TEXT,actor_user_id TEXT,actor_role TEXT,actor_email TEXT,action TEXT,entity_type TEXT,entity_id TEXT,matter_id TEXT,client_id TEXT,ip_address TEXT,user_agent TEXT,metadata_json TEXT,created_at TEXT);
    CREATE TRIGGER reject_backup_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit rejection'); END;`);
  await close(db);
  const result = cli(f);
  expect(result.status).toBe(0); // Verified backup remains valid; audit failure stays explicitly non-fatal.
  expect(result.output).toContain('Audit logging failed (non-fatal): SQLITE_CONSTRAINT: synthetic audit rejection');
  expect(result.output).not.toContain('Audit event backup_created recorded');
  expect(await audits(f)).toEqual([]);
  expect(fs.readdirSync(f.backups)).toHaveLength(1);
}, 30000);

test('failed failure-audit INSERT cannot hide the verification reason or claim success', async () => {
  const f = await fixture();
  const db = await open(f.database);
  await exec(db, 'CREATE TABLE audit_events(incompatible_column TEXT);');
  await close(db);
  const badTemp = path.join(f.dir, 'regular-file');
  fs.writeFileSync(badTemp, 'not a directory');
  const result = cli(f, { TEMP: badTemp, TMP: badTemp });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/Backup failed:.*(ENOENT|ENOTDIR)/);
  expect(result.output).toContain('Failure audit logging failed:');
  expect(result.output).not.toContain('Audit event backup_failed recorded');
  expect(result.output).not.toContain('Backup completed successfully');
  expect(fs.readdirSync(f.backups)).toEqual([]);
}, 30000);

test('publication collision preserves the existing path and cleans only the current stage', async () => {
  const f = await fixture();
  const link = jest.spyOn(fs.promises, 'link').mockImplementation(async (stage, destination) => {
    fs.writeFileSync(destination, 'existing concurrent backup');
    const err = new Error('synthetic publication collision'); err.code = 'EEXIST'; throw err;
  });
  try { await expect(f.helper.createBackup()).rejects.toThrow('synthetic publication collision'); } finally { link.mockRestore(); }
  const files = fs.readdirSync(f.backups);
  expect(files).toHaveLength(1);
  expect(fs.readFileSync(path.join(f.backups, files[0]), 'utf8')).toBe('existing concurrent backup');
});
