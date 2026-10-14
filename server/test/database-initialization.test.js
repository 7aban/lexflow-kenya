'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const net = require('node:net');
const serverDir = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-103b4-'));
const database = path.join(root, 'fresh.db');
const worker = path.join(__dirname, 'helpers', 'database-initialization-worker.js');
const env = databasePath => ({
  ...process.env, NODE_ENV: 'test', DATABASE_PATH: databasePath, PORT: '0',
  JWT_SECRET: 'synthetic-103b4-secret', SEED_ADMIN_EMAIL: 'init@example.test',
  SEED_ADMIN_PASSWORD: 'synthetic-103b4-password', DISABLE_RATE_LIMIT: 'true',
});
function child(script, databasePath, extra = {}) {
  // The success worker covers startup plus many HTTP/token/record contracts.
  // Keep CLI error-path deadlines short; bound each worker HTTP request too.
  const timeout = script[0] === worker ? 45000 : 20000;
  return spawnSync(process.execPath, script, {
    cwd: serverDir, env: { ...env(databasePath), ...extra }, encoding: 'utf8',
    timeout, maxBuffer: 1024 * 1024, windowsHide: true,
  });
}
function success(result) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('INITIALIZATION_AUTH_OK');
  expect(result.stdout).toContain('PORT_RELEASED');
  expect(result.stderr).not.toMatch(/SQLITE_|Unhandled|Database initialisation failed/i);
}
function failure(databasePath, expectedCode) {
  const result = child(['server.js'], databasePath);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('server running');
  expect(result.stderr).toContain(`Database initialisation failed [${expectedCode}]`);
  expect(result.stderr).not.toMatch(/Unhandled|Emitted 'error' event|node:events|\bat .*\.js:\d/i);
  for (const secret of [databasePath, env(databasePath).JWT_SECRET, env(databasePath).SEED_ADMIN_PASSWORD, 'SYNTHETIC_PRIVATE_CONTENT']) expect(result.stderr).not.toContain(secret);
  expect(result.stdout).not.toContain('Initial admin');
}

afterAll(() => {
  // Delete only the disposable root allocated by this suite, after children exit.
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('lexflow-103b4-')) throw new Error('Unsafe synthetic cleanup target');
  fs.rmSync(root, { recursive: true, force: true });
});

test('original import-time read-only open fails before file creation; auth import now opens nothing', () => {
  const absent = path.join(root, 'original.db');
  const original = child(['-e', "const sqlite3=require('sqlite3');new sqlite3.Database(process.env.DATABASE_PATH,sqlite3.OPEN_READONLY);"], absent);
  expect(original.status).toBe(1);
  expect(original.stderr).toContain('SQLITE_CANTOPEN');
  expect(fs.existsSync(absent)).toBe(false);
  const fixed = child(['-e', "require('./middleware/auth');setImmediate(()=>console.log('AUTH_IMPORTED'));"], absent);
  expect(fixed.status).toBe(0);
  expect(fixed.stderr).toBe('');
  expect(fs.existsSync(absent)).toBe(false);
});

test('fresh database initializes health, login, token checks and role enforcement, then releases its port', () => {
  expect(fs.existsSync(database)).toBe(false);
  success(child([worker], database));
});

test('existing synthetic LexFlow database retains its records and authenticates on restart', () => {
  expect(fs.existsSync(database)).toBe(true);
  success(child([worker], database, { INIT_WORKER_EXISTING: 'true' }));
});

test('actual CLI starts on a fresh database, serves health/login and releases its process and port', async () => {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const fresh = path.join(root, 'cli.db');
  const processUnderTest = spawn(process.execPath, ['server.js'], {
    cwd: serverDir, env: { ...env(fresh), PORT: String(port) }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  processUnderTest.stdout.on('data', data => { stdout += data; });
  processUnderTest.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => processUnderTest.once('exit', resolve));
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Synthetic CLI startup timed out')), 15000);
      processUnderTest.once('error', reject);
      processUnderTest.once('exit', () => reject(new Error('Synthetic CLI exited before readiness')));
      processUnderTest.stdout.on('data', () => { if (stdout.includes('server running')) resolve(); });
    });
    clearTimeout(timeout);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe('ok');
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: env(fresh).SEED_ADMIN_EMAIL, password: env(fresh).SEED_ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    expect(typeof (await login.json()).token).toBe('string');
    expect(stderr).not.toMatch(/SQLITE_|Unhandled|Database initialisation failed/i);
  } finally {
    clearTimeout(timeout);
    if (processUnderTest.exitCode === null) processUnderTest.kill();
    await exited;
  }
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
}, 20000);

test('nonexistent parent fails without creation or fallback', () => {
  const parent = path.join(root, 'missing-parent');
  failure(path.join(parent, 'absent.db'), 'SQLITE_CANTOPEN');
  expect(fs.existsSync(parent)).toBe(false);
});

test('directory used as database fails safely', () => failure(root, 'SQLITE_CANTOPEN'));

test('invalid database rejects readiness, reports HTTP 503 and exposes no contents', () => {
  const invalid = path.join(root, 'invalid.db');
  fs.writeFileSync(invalid, 'SYNTHETIC_PRIVATE_CONTENT invalid SQLite');
  const before = fs.readFileSync(invalid);
  failure(invalid, 'SQLITE_NOTADB');
  expect(fs.readFileSync(invalid)).toEqual(before);
  const imported = child([worker], invalid, { INIT_WORKER_FAILURE: 'true' });
  expect(imported.status).toBe(0);
  expect(imported.stderr).toBe('');
  expect(imported.stdout).toContain('FAILED_READINESS_REJECTED_AND_HTTP_503');
  expect(imported.stdout).toContain('ONLY_OPENED_CONNECTIONS_CLOSED');
  expect(imported.stdout).toContain('PORT_RELEASED');
});

test.each(['main-open', 'auth-open'])('%s failure rejects readiness and closes only opened connections', mode => {
  const target = mode === 'main-open'
    ? path.join(root, 'missing-main-parent', 'main.db')
    : path.join(root, 'auth-open-failure.db');
  const imported = child([worker], target, { INIT_WORKER_FAILURE: mode });
  expect(imported.error).toBeUndefined();
  expect(imported.status).toBe(0);
  expect(imported.stderr).toBe('');
  expect(imported.stdout).toContain('ONLY_OPENED_CONNECTIONS_CLOSED');
  expect(imported.stdout).toContain('FAILED_READINESS_REJECTED_AND_HTTP_503');
  expect(imported.stdout).toContain('PORT_RELEASED');
  expect(fs.existsSync(path.join(root, 'missing-main-parent'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'missing-auth-parent'))).toBe(false);
});

test.each(['W', 'R'])('Windows parent directory denies %s access without fallback or unhandled errors', permission => {
  if (process.platform !== 'win32') throw new Error('Windows ACL validation requires Windows');
  const denied = path.join(root, `denied-${permission}`);
  fs.mkdirSync(denied);
  const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[0-9-]+/)[0];
  try {
    const rights = permission === 'R' ? 'RX,W' : 'W';
    execFileSync('icacls', [denied, '/deny', `*${sid}:(OI)(CI)(${rights})`], { windowsHide: true });
    failure(path.join(denied, 'blocked.db'), 'SQLITE_CANTOPEN');
  } finally {
    execFileSync('icacls', [denied, '/remove:d', `*${sid}`], { windowsHide: true });
  }
  expect(fs.existsSync(path.join(denied, 'blocked.db'))).toBe(false);
});

test('initialization diagnostics accept only known codes and never raw errors', () => {
  const { initializationError } = require('../lib/databaseInitialization');
  for (const code of ['SQLITE_CANTOPEN', 'SQLITE_READONLY', 'SQLITE_NOTADB', 'SQLITE_CORRUPT', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_PERM', 'UNSAFE_PRIVATE_CONTENT', undefined]) {
    const error = initializationError({ code, message: 'SYNTHETIC_PRIVATE_CONTENT', stack: 'private SQL and credentials' });
    expect(error.message).not.toContain('SYNTHETIC_PRIVATE_CONTENT');
    expect(error.message).not.toContain('private SQL');
    expect(error.code).not.toContain('UNSAFE_PRIVATE_CONTENT');
  }
});
