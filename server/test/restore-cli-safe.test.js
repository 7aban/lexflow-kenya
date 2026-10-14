const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');
const schema = require('./helpers/lexflow-restore-fixture');
const key = Buffer.from('ab'.repeat(32), 'hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-restore-tests-'));
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
function encrypt(data) {
  const iv = crypto.randomBytes(16), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const bytes = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
}
async function fixture() {
  const dir = path.join(root, `${++index} path with spaces Ω`); fs.mkdirSync(dir);
  const source = path.join(dir, 'source.db'), target = path.join(dir, 'destination.db');
  for (const [file, value] of [[source, 'restore-data'], [target, 'original-destination']]) {
    const db = await open(file);
    await exec(db, schema + `CREATE TABLE sample(txt TEXT,num REAL,bytes BLOB); INSERT INTO sample VALUES('${value}',42.125,X'00FF8041');`);
    await close(db);
  }
  const backup = path.join(dir, 'backup.db.enc'); fs.writeFileSync(backup, encrypt(fs.readFileSync(source)));
  const sidecars = [target+'-wal', target+'-shm', target+'-journal', target.replace(/\.db$/, '-wal.db'), target.replace(/\.db$/, '-shm.db')];
  for (const file of sidecars) fs.writeFileSync(file, 'synthetic offline sidecar ' + path.basename(file));
  return { dir, source, target, backup, sidecars };
}
function state(f) { return [f.target, ...f.sidecars].map(file => ({ file, hash: hash(file) })); }
function expectState(previous) { for (const file of previous) expect(hash(file.file)).toBe(file.hash); }
function cli(f, args = ['--force'], extra = {}, preload) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(name)));
  const env = { ...inherited, NODE_ENV: 'production', JWT_SECRET: 'synthetic-restore-only', DATABASE_PATH: f.target,
    BACKUP_DIR: path.join(f.dir, 'unused-backups'), BACKUP_LOG: path.join(f.dir, 'unused-backup.log'),
    LEXFLOW_BACKUP_KEY: key.toString('hex'), TEMP: f.dir, TMP: f.dir, ...extra };
  const argv = [...(preload ? ['--require', preload] : []), path.join(__dirname, '../scripts/restore-backup.js'), f.backup, ...args];
  const start = Date.now();
  const r = spawnSync(process.execPath, argv, { cwd: f.dir, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const output = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(evidence, `restore-${index}.log`), output);
  fs.writeFileSync(path.join(evidence, `restore-${index}.json`), JSON.stringify({ argv, status: r.status, signal: r.signal, error: r.error?.message, elapsedMs: Date.now() - start, fixture: f.dir }, null, 2));
  expect(r.error).toBeUndefined();
  return { ...r, output };
}
function noSuccess(r) {
  expect(r.status).toBe(1);
  expect(r.output).not.toContain('Restore completed successfully');
  expect(r.output).not.toContain('Audit event backup_restored recorded');
}
function noStaging(f) { expect(fs.readdirSync(f.dir).filter(name => name.startsWith('.lexflow-restore-'))).toEqual([]); }

test.each(['encrypted', 'plaintext'])('valid %s offline restore retains record fidelity and truthful audit', async format => {
  const f = await fixture();
  if (format === 'plaintext') { f.backup = path.join(f.dir, 'backup.db'); fs.copyFileSync(f.source, f.backup); }
  const r = cli(f);
  expect(r.status).toBe(0);
  expect(r.output).toContain('Restore completed successfully');
  expect(r.output).toContain('Audit event backup_restored recorded');
  for (const file of f.sidecars) expect(fs.existsSync(file)).toBe(false);
  const db = await open(f.target);
  try {
    expect(await all(db, 'SELECT txt,num,hex(bytes) bytes FROM sample')).toEqual([{ txt: 'restore-data', num: 42.125, bytes: '00FF8041' }]);
    expect(await all(db, 'SELECT action FROM audit_events')).toEqual([{ action: 'backup_restored' }]);
  } finally { await close(db); }
  noStaging(f);
}, 40000);

test.each(['wrong-key', 'corrupt', 'truncated', 'invalid-sqlite', 'incomplete-sqlite', 'incompatible-schema'])('%s rejects before changing destination or sidecars', async kind => {
  const f = await fixture(), before = state(f);
  let extra = {};
  if (kind === 'wrong-key') extra.LEXFLOW_BACKUP_KEY = 'cd'.repeat(32);
  if (kind === 'corrupt') { const bytes = fs.readFileSync(f.backup); bytes[bytes.length-1] ^= 1; fs.writeFileSync(f.backup, bytes); }
  if (kind === 'truncated') fs.writeFileSync(f.backup, fs.readFileSync(f.backup).subarray(0, 20));
  if (kind === 'invalid-sqlite') fs.writeFileSync(f.backup, encrypt(Buffer.from('authenticated non SQLite payload')));
  if (kind === 'incomplete-sqlite') fs.writeFileSync(f.backup, encrypt(fs.readFileSync(f.source).subarray(0, 200)));
  if (kind === 'incompatible-schema') {
    const db = await open(f.source); await exec(db, 'DROP TABLE matters'); await close(db);
    fs.writeFileSync(f.backup, encrypt(fs.readFileSync(f.source)));
  }
  const r = cli(f, ['--force'], extra); noSuccess(r); expectState(before); noStaging(f);
  if (kind === 'incompatible-schema') expect(r.output).toContain('Incompatible LexFlow schema: missing table matters');
}, 40000);

test('existing destination requires explicit --force', async () => {
  const f = await fixture(), before = state(f);
  const r = cli(f, []); noSuccess(r); expect(r.output).toContain('use --force'); expectState(before); noStaging(f);
});

test('active SQLite handle refuses replacement while preserving bytes', async () => {
  const f = await fixture();
  // Remove fake sidecars before opening SQLite; create real WAL/SHM instead.
  for (const file of f.sidecars) fs.unlinkSync(file);
  const db = await open(f.target);
  try {
    await exec(db, 'PRAGMA journal_mode=WAL; BEGIN;');
    await all(db, 'SELECT * FROM sample');
    const files = [f.target, f.target+'-wal', f.target+'-shm'].filter(fs.existsSync);
    const before = files.map(file => ({ file, hash: hash(file) }));
    const r = cli(f); noSuccess(r); expect(r.output).toContain('Destination must be offline'); expectState(before); noStaging(f);
  } finally { await exec(db, 'ROLLBACK'); await close(db); }
}, 40000);

test('staging write failure preserves original destination and sidecars', async () => {
  const f = await fixture(), before = state(f);
  const preload = path.join(f.dir, 'stage-failure.cjs');
  fs.writeFileSync(preload, "const fs=require('fs');const original=fs.promises.writeFile;fs.promises.writeFile=async function(file,...args){if(String(file).endsWith('restored.db'))throw Error('synthetic staging write failure');return original.call(this,file,...args);};");
  const r = cli(f, ['--force'], {}, preload); noSuccess(r); expect(r.output).toContain('synthetic staging write failure'); expectState(before); noStaging(f);
});

test('rejected staged audit insertion is fatal before replacement and never reported as recorded', async () => {
  const f = await fixture(), before = state(f);
  const db = await open(f.source); await exec(db, 'CREATE TABLE audit_events(incompatible TEXT)'); await close(db);
  fs.writeFileSync(f.backup, encrypt(fs.readFileSync(f.source)));
  const r = cli(f); noSuccess(r); expect(r.output).toContain('audit_events'); expectState(before); noStaging(f);
});

test.each([false, true])('replacement failure rolls back or reports retained recoverable files, incomplete recovery=%s', async incomplete => {
  const f = await fixture(), before = state(f);
  const helper = path.join(f.dir, 'replacement-injected.ps1');
  let source = fs.readFileSync(path.join(__dirname, '../scripts/replace-restore.ps1'), 'utf8');
  source = source.replace('[IO.File]::Move($staged, $target)', "throw 'synthetic publication failure'");
  if (incomplete) source = source.replace('[IO.File]::Move($moved[$i].saved, $moved[$i].source)', "throw 'synthetic rollback failure'");
  fs.writeFileSync(helper, source);
  const preload = path.join(f.dir, 'helper-injection.cjs');
  fs.writeFileSync(preload, `const cp=require('child_process');const original=cp.execFile;cp.execFile=function(file,args,...rest){args=args.map(x=>String(x).endsWith('replace-restore.ps1')?${JSON.stringify(helper)}:x);return original.call(this,file,args,...rest);};`);
  const r = cli(f, ['--force'], {}, preload); noSuccess(r); expect(r.output).toContain('synthetic publication failure');
  if (!incomplete) { expectState(before); expect(r.output).toContain('original state preserved/restored'); noStaging(f); }
  else {
    expect(r.output).toContain('recovery incomplete');
    const stage = path.join(f.dir, fs.readdirSync(f.dir).find(name => name.startsWith('.lexflow-restore-')));
    for (const file of before) expect(hash(path.join(stage, 'original', path.basename(file.file)))).toBe(file.hash);
    expect(fs.existsSync(path.join(stage, 'recovery.json'))).toBe(true);
  }
}, 40000);
