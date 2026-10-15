'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { spawn } = require('child_process');
const createDb = require('../lib/db');
const { createWorkSessions, initializeWorkSessions, CONFIRMATION_WINDOW_SECONDS } = require('../lib/workSessions');

let db, sql, service, databasePath, clock;
const req = (userId = 'a', role = 'advocate', fullName = 'Advocate A') => ({ user: { userId, role, fullName, tokenVersion: 1 }, headers: {} });
const a = req();
const b = req('b', 'advocate', 'Advocate B');
const start = (body = {}, actor = a) => service.start(actor, { matterId: 'A', ...body });
const act = (row, action, body = {}, actor = a) => service.transition(actor, row.id, action, { version: row.version, ...body });
const record = (row, body = {}, actor = a) => service.record(actor, row.id, { version: row.version, billable: false, ...body });
const tick = seconds => { clock += seconds * 1000; };

// Observe independent SQLite transaction callbacks without serializing calls
// in the test. Only statement verbs, timing and synthetic connection IDs are
// logged; no parameters, SQL values, database paths or user data are captured.
function observeTransactions() {
  const connections = new Map();
  const events = [];
  const started = performance.now();
  let pending = 0, peakPending = 0;
  const originalRun = sqlite3.Database.prototype.run;
  const originalClose = sqlite3.Database.prototype.close;
  sqlite3.Database.prototype.run = function (statement, ...args) {
    const operation = /^(BEGIN IMMEDIATE|COMMIT|ROLLBACK)$/.exec(statement)?.[1];
    if (!operation) return originalRun.call(this, statement, ...args);
    if (!connections.has(this)) connections.set(this, { id: connections.size + 1, commits: 0, rollbacks: 0, closed: false, acquired: false });
    const state = connections.get(this);
    const requested = performance.now();
    if (operation === 'BEGIN IMMEDIATE') { pending++; peakPending = Math.max(peakPending, pending); }
    const callback = args.pop();
    return originalRun.call(this, statement, ...args, function (error) {
      events.push({ connection: state.id, operation, elapsedMs: performance.now() - started, durationMs: performance.now() - requested, errorCode: error?.code || null });
      if (operation === 'BEGIN IMMEDIATE') { pending--; if (!error) state.acquired = true; }
      if (!error && operation === 'COMMIT') { state.commits++; state.acquired = false; }
      if (!error && operation === 'ROLLBACK') { state.rollbacks++; state.acquired = false; }
      callback.call(this, error);
    });
  };
  sqlite3.Database.prototype.close = function (callback) {
    const state = connections.get(this);
    return originalClose.call(this, function (error) {
      if (state && !error) state.closed = true;
      callback.call(this, error);
    });
  };
  return {
    finish(scenario) {
      sqlite3.Database.prototype.run = originalRun;
      sqlite3.Database.prototype.close = originalClose;
      const summary = { scenario, elapsedMs: performance.now() - started, peakPending, connections: [...connections.values()], events };
      console.info(JSON.stringify(summary));
      return summary;
    },
  };
}
function expectClosed(summary, count) {
  expect(summary.connections).toHaveLength(count);
  expect(summary.peakPending).toBeGreaterThanOrEqual(2);
  expect(summary.connections.every(c => c.closed && !c.acquired)).toBe(true);
  expect(summary.elapsedMs).toBeLessThan(3000);
}

beforeEach(async () => {
  databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-104a-unit-')), 'synthetic.db');
  db = await new Promise((resolve, reject) => { const connection = new sqlite3.Database(databasePath, e => e ? reject(e) : resolve(connection)); });
  sql = createDb(db);
  await sql.run('CREATE TABLE users(id TEXT PRIMARY KEY,fullName TEXT,role TEXT,tokenVersion INTEGER)');
  await sql.run('CREATE TABLE matters(id TEXT PRIMARY KEY,assignedTo TEXT)');
  await sql.run('CREATE TABLE tasks(id TEXT PRIMARY KEY,matterId TEXT,assignee TEXT)');
  await sql.run('CREATE TABLE firm_settings(advocateBillingVisibility INTEGER)');
  await sql.run('INSERT INTO firm_settings VALUES (1)');
  await sql.run('CREATE TABLE time_entries(id TEXT PRIMARY KEY,matterId TEXT,taskId TEXT,attorney TEXT,date TEXT,hours REAL,activity TEXT,description TEXT,rate REAL,billed INTEGER,billable INTEGER)');
  for (const [id, name, role] of [['a', 'Advocate A', 'advocate'], ['b', 'Advocate B', 'advocate'], ['admin', 'Admin', 'admin'], ['assistant', 'Assistant', 'assistant'], ['portal', 'Client', 'client']]) {
    await sql.run('INSERT INTO users VALUES (?,?,?,1)', [id, name, role]);
  }
  for (const [id, assignedTo] of [['A', 'Advocate A'], ['A2', 'Advocate A'], ['B', 'Advocate B']]) await sql.run('INSERT INTO matters VALUES (?,?)', [id, assignedTo]);
  for (const [id, matterId, assignee] of [['TA', 'A', 'Advocate A'], ['TB', 'B', 'Advocate A'], ['TA2', 'A2', 'Advocate A']]) await sql.run('INSERT INTO tasks VALUES (?,?,?)', [id, matterId, assignee]);
  await initializeWorkSessions(sql);
  clock = Date.parse('2026-10-15T09:00:00Z');
  service = createWorkSessions({ databasePath, now: () => clock });
});
afterEach(async () => { if (db) await new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve())); });

test('task is optional; canonical activities, ownership and defaults are durable', async () => {
  const row = await start();
  expect(row).toMatchObject({ userId: 'a', matterId: 'A', taskId: null, activity: 'Legal Research', status: 'running', accumulatedSeconds: 0, version: 1 });
  expect(await sql.get('SELECT * FROM work_sessions WHERE id=?', [row.id])).toMatchObject({ id: row.id, userId: 'a' });
  await initializeWorkSessions(sql);
  expect((await service.list(a)).map(s => s.id)).toEqual([row.id]);
});

test('authorized task; start, confirm, pause, resume, update and record exact seconds', async () => {
  let row = await start({ taskId: 'TA', activity: 'Drafting', description: 'Draft submissions' });
  tick(61.9);
  row = await act(row, 'confirm');
  expect(row.accumulatedSeconds).toBe(61);
  tick(1.2);
  row = await act(row, 'pause');
  expect(row.accumulatedSeconds).toBe(63);
  tick(36000);
  expect((await service.retrieve(a, row.id)).accumulatedSeconds).toBe(63);
  row = await act(row, 'resume');
  tick(17);
  row = await act(row, 'pause');
  row = await service.update(a, row.id, { version: row.version, activity: 'Preparation', description: 'Hearing preparation' });
  const entry = await record(row);
  expect(entry).toMatchObject({ matterId: 'A', taskId: 'TA', attorney: 'Advocate A', hours: 80 / 3600, activity: 'Preparation', description: 'Hearing preparation', billed: 0, billable: 0, rate: 0 });
  expect(entry.id).toMatch(/^TIME-/);
  expect((await service.retrieve(a, row.id))).toMatchObject({ status: 'recorded', accumulatedSeconds: 80, timeEntryId: entry.id });
});

test('switching matters and resuming preserves each duration and multiple paused sessions', async () => {
  let first = await start();
  tick(40);
  let second = await start({ matterId: 'A2', activity: 'Drafting', runningSessionId: first.id, runningVersion: first.version });
  first = await service.retrieve(a, first.id);
  expect(first).toMatchObject({ status: 'paused', accumulatedSeconds: 40 });
  tick(25);
  first = await act(first, 'resume', { runningSessionId: second.id, runningVersion: second.version });
  second = await service.retrieve(a, second.id);
  expect(second).toMatchObject({ status: 'paused', accumulatedSeconds: 25 });
  tick(15);
  first = await act(first, 'pause');
  expect(first.accumulatedSeconds).toBe(55);
  expect((await service.list(a)).filter(s => s.status === 'paused')).toHaveLength(2);
});

test('conflicting start does not erase time; direct SQL cannot create two running sessions', async () => {
  const row = await start();
  await expect(start({ matterId: 'A2' })).rejects.toMatchObject({ statusCode: 409 });
  await expect(sql.run(`INSERT INTO work_sessions SELECT id||'-duplicate',userId,matterId,taskId,activity,description,status,accumulatedSeconds,segmentStartedAt,lastConfirmedAt,createdAt,updatedAt,version,timeEntryId,recoveryRequired,uncertainSeconds,uncertainSince,recoveryReviewedAt FROM work_sessions WHERE id=?`, [row.id])).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });
  expect((await service.list(a))).toHaveLength(1);
});

test('separate users have independent running sessions and cannot access each other', async () => {
  const first = await start();
  const second = await start({ matterId: 'B' }, b);
  expect((await service.list(b)).map(r => r.id)).toEqual([second.id]);
  for (const operation of [() => service.retrieve(b, first.id), () => service.update(b, first.id, { version: 1, description: 'intrusion' }), () => act(first, 'pause', {}, b), () => act(first, 'resume', {}, b), () => record(first, {}, b)]) {
    await expect(operation()).rejects.toMatchObject({ statusCode: 404 });
  }
  await expect(service.retrieve(req('admin', 'admin', 'Admin'), first.id)).rejects.toMatchObject({ statusCode: 404 });
});

test('staff only, no unauthenticated access and live token revocation is respected', async () => {
  await expect(service.list({})).rejects.toMatchObject({ statusCode: 401 });
  await expect(start({}, req('portal', 'client', 'Client'))).rejects.toMatchObject({ statusCode: 403 });
  await sql.run("UPDATE users SET tokenVersion=2 WHERE id='a'");
  await expect(start()).rejects.toMatchObject({ statusCode: 401 });
});

test('assistant and admin follow existing staff matter access but still own their sessions', async () => {
  const admin = req('admin', 'admin', 'Admin');
  const assistant = req('assistant', 'assistant', 'Assistant');
  const one = await start({ matterId: 'B' }, admin);
  const two = await start({ matterId: 'B' }, assistant);
  expect((await service.list(admin)).map(r => r.id)).toEqual([one.id]);
  expect((await service.list(assistant)).map(r => r.id)).toEqual([two.id]);
});

test('inaccessible/missing matters and mismatched, delegated or missing tasks are denied', async () => {
  for (const [body, statusCode] of [[{ matterId: 'B' }, 403], [{ matterId: 'MISSING' }, 404], [{ taskId: 'TA2' }, 400], [{ taskId: 'MISSING' }, 400], [{ matterId: 'B', taskId: 'TB' }, 403], [{ taskId: 123 }, 400], [{ matterId: '' }, 400]]) {
    await expect(start(body)).rejects.toMatchObject({ statusCode });
  }
  expect((await sql.get('SELECT COUNT(*) n FROM work_sessions')).n).toBe(0);
});

test('loss of matter access prevents reads, modification, recording and idempotent result disclosure', async () => {
  let row = await start({ taskId: 'TA' });
  tick(33);
  row = await act(row, 'pause');
  await sql.run("UPDATE matters SET assignedTo='Advocate B' WHERE id='A'");
  expect(await service.list(a)).toEqual([]);
  for (const operation of [() => service.retrieve(a, row.id), () => service.update(a, row.id, { version: row.version, description: 'x' }), () => act(row, 'resume'), () => record(row)]) {
    await expect(operation()).rejects.toMatchObject({ statusCode: 403 });
  }
  expect((await sql.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(0);
  await sql.run("UPDATE matters SET assignedTo='Advocate A' WHERE id='A'");
  await record(row);
  await sql.run("UPDATE matters SET assignedTo='Advocate B' WHERE id='A'");
  await expect(record(row)).rejects.toMatchObject({ statusCode: 403 });
});

test('task moved after creation is revalidated before recording', async () => {
  const row = await act(await start({ taskId: 'TA' }), 'pause');
  await sql.run("UPDATE tasks SET matterId='B' WHERE id='TA'");
  await expect(record(row)).rejects.toMatchObject({ statusCode: 400 });
  expect(await service.list(a)).toEqual([]);
});

test('refresh/reconnect and a new service instance retain state; reads never confirm elapsed time', async () => {
  const row = await start();
  tick(44);
  service = createWorkSessions({ databasePath, now: () => clock });
  for (let i = 0; i < 3; i++) expect(await service.retrieve(a, row.id)).toMatchObject({ version: 1, accumulatedSeconds: 0, pendingSeconds: 44, totalSeconds: 44 });
  expect((await sql.get('SELECT lastConfirmedAt FROM work_sessions WHERE id=?', [row.id])).lastConfirmedAt).toBe(row.lastConfirmedAt);
});

test('120 second boundary confirms; overdue overnight interval is excluded and explicitly reviewed', async () => {
  let row = await start();
  tick(CONFIRMATION_WINDOW_SECONDS);
  row = await act(row, 'confirm');
  expect(row.accumulatedSeconds).toBe(120);
  tick(12 * 3600);
  row = await service.retrieve(a, row.id);
  expect(row).toMatchObject({ status: 'paused', accumulatedSeconds: 120, recoveryRequired: 1, uncertainSeconds: 43200, pendingSeconds: 0 });
  await expect(record(row)).rejects.toMatchObject({ statusCode: 409 });
  await expect(act(row, 'resume')).rejects.toMatchObject({ statusCode: 409 });
  await expect(act(row, 'review', { discardUnconfirmed: false })).rejects.toMatchObject({ statusCode: 400 });
  row = await act(row, 'review', { discardUnconfirmed: true });
  expect(row).toMatchObject({ accumulatedSeconds: 120, recoveryRequired: 0, uncertainSeconds: 43200 });
  expect((await record(row)).hours).toBe(120 / 3600);
});

test('clock reversal is flagged and does not inflate confirmed seconds', async () => {
  let row = await start();
  tick(30);
  row = await act(row, 'confirm');
  tick(-60);
  row = await service.retrieve(a, row.id);
  expect(row).toMatchObject({ status: 'paused', accumulatedSeconds: 30, recoveryRequired: 1, uncertainSeconds: 0 });
});

test('overdue mutation conflicts and reload persists recovery without silently confirming the tail', async () => {
  const row = await start();
  tick(121);
  await expect(act(row, 'confirm')).rejects.toMatchObject({ statusCode: 409 });
  const recovered = await service.retrieve(a, row.id);
  expect(recovered).toMatchObject({ status: 'paused', accumulatedSeconds: 0, recoveryRequired: 1 });
});

test('concurrent starts across independent connections yield one running session', async () => {
  const observation = observeTransactions();
  let results, summary;
  try { results = await Promise.allSettled(Array.from({ length: 6 }, () => start())); }
  finally { summary = observation.finish('concurrent-starts'); }
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected').every(r => r.reason.statusCode === 409)).toBe(true);
  expectClosed(summary, 6);
  expect(summary.connections.reduce((n, c) => n + c.commits, 0)).toBe(1);
  expect(summary.connections.reduce((n, c) => n + c.rollbacks, 0)).toBe(5);
  expect((await sql.get("SELECT COUNT(*) n FROM work_sessions WHERE status='running'")).n).toBe(1);
  expect((await sql.get('SELECT COUNT(*) n FROM work_sessions')).n).toBe(1);
  expect((await sql.get('SELECT COUNT(*) n FROM audit_events')).n).toBe(1);
  expect((await sql.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(0);
  await sql.run('BEGIN IMMEDIATE');
  await sql.run('ROLLBACK');
});

test('concurrent resume/switch and stale tabs cannot pause an unexpected session', async () => {
  let first = await act(await start(), 'pause');
  let second = await act(await start({ matterId: 'A2' }), 'pause');
  const results = await Promise.allSettled([act(first, 'resume'), act(second, 'resume')]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const running = (await service.list(a)).find(r => r.status === 'running');
  const paused = running.id === first.id ? second : first;
  tick(10);
  const confirmed = await act(running, 'confirm');
  await expect(act(paused, 'resume', { runningSessionId: running.id, runningVersion: running.version })).rejects.toMatchObject({ statusCode: 409 });
  expect((await service.retrieve(a, running.id))).toMatchObject({ status: 'running', version: confirmed.version, accumulatedSeconds: 10 });
});

test('concurrent versioned modifications have one winner; no duplicate checkpoint seconds', async () => {
  const row = await start();
  tick(15);
  const results = await Promise.allSettled([act(row, 'confirm'), act(row, 'confirm'), service.update(a, row.id, { version: row.version, description: 'other tab' })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected').every(r => r.reason.statusCode === 409)).toBe(true);
  expect((await service.retrieve(a, row.id)).accumulatedSeconds).toBeLessThanOrEqual(15);
});

test('simultaneous recording and old-version retries return exactly one existing entry', async () => {
  let row = await start();
  tick(97);
  row = await act(row, 'pause');
  const observation = observeTransactions();
  let results, summary;
  try { results = await Promise.allSettled(Array.from({ length: 6 }, () => record(row, { billable: true, rate: 12000 }))); }
  finally { summary = observation.finish('concurrent-recording'); }
  expect(results.every(r => r.status === 'fulfilled')).toBe(true);
  const entries = results.map(r => r.value);
  expectClosed(summary, 6);
  expect(summary.connections.reduce((n, c) => n + c.commits, 0)).toBe(6);
  expect(new Set(entries.map(e => e.id)).size).toBe(1);
  expect((await sql.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(1);
  expect(await sql.get('SELECT status,timeEntryId,version,accumulatedSeconds FROM work_sessions WHERE id=?', [row.id])).toEqual({ status: 'recorded', timeEntryId: entries[0].id, version: row.version + 1, accumulatedSeconds: 97 });
  expect((await sql.get('SELECT COUNT(*) n FROM audit_events')).n).toBe(3);
  expect((await sql.get("SELECT COUNT(*) n FROM audit_events WHERE action='work_session_record'")).n).toBe(1);
  await sql.run('BEGIN IMMEDIATE');
  await sql.run('ROLLBACK');
  expect(await record(row)).toEqual(entries[0]);
  await expect(service.update(a, row.id, { version: row.version + 1, description: 'change recorded' })).rejects.toMatchObject({ statusCode: 409 });
  await expect(act({ ...row, version: row.version + 1 }, 'resume')).rejects.toMatchObject({ statusCode: 409 });
});

test('failure after time entry insertion rolls back entry, link and audit; subsequent explicit request succeeds', async () => {
  const row = await act(await start(), 'pause');
  const beforeAudit = await sql.get('SELECT COUNT(*) n FROM audit_events');
  await sql.run("CREATE TRIGGER fail_link BEFORE UPDATE OF timeEntryId ON work_sessions WHEN NEW.timeEntryId IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic link failure'); END");
  await expect(record(row)).rejects.toMatchObject({ statusCode: 409 });
  expect((await sql.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(0);
  expect(await sql.get('SELECT status,timeEntryId,version FROM work_sessions WHERE id=?', [row.id])).toEqual({ status: 'paused', timeEntryId: null, version: row.version });
  expect(await sql.get('SELECT COUNT(*) n FROM audit_events')).toEqual(beforeAudit);
  await sql.run('DROP TRIGGER fail_link');
  expect((await record(row)).id).toMatch(/^TIME-/);
});

test('writer acquisition deadline closes every connection without partial records or a lingering transaction', async () => {
  const row = await act(await start(), 'pause');
  const before = await sql.get('SELECT COUNT(*) n FROM audit_events');
  await sql.run('BEGIN IMMEDIATE'); // An independent writer deliberately holds the lock.
  const observation = observeTransactions();
  let results, summary;
  try { results = await Promise.allSettled([start({ matterId: 'A2' }), record(row)]); }
  finally {
    summary = observation.finish('writer-acquisition-deadline');
    await sql.run('ROLLBACK');
  }
  expect(results.every(r => r.status === 'rejected' && r.reason.statusCode === 409)).toBe(true);
  expectClosed(summary, 2);
  expect(summary.elapsedMs).toBeGreaterThanOrEqual(1900);
  expect(summary.connections.every(c => c.commits === 0 && c.rollbacks === 0)).toBe(true);
  expect((await sql.get('SELECT COUNT(*) n FROM work_sessions')).n).toBe(1);
  expect((await sql.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(0);
  expect(await sql.get('SELECT COUNT(*) n FROM audit_events')).toEqual(before);
  expect(await sql.get('SELECT status,timeEntryId,version FROM work_sessions WHERE id=?', [row.id])).toEqual({ status: 'paused', timeEntryId: null, version: row.version });
  expect((await record(row)).id).toMatch(/^TIME-/);
});

test('audit failure atomically rolls back a switch and its confirmed seconds', async () => {
  const row = await start();
  tick(55);
  await sql.run("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events WHEN NEW.action='work_session_start' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  await expect(start({ matterId: 'A2', runningSessionId: row.id, runningVersion: row.version })).rejects.toMatchObject({ statusCode: 409 });
  expect(await sql.get('SELECT status,accumulatedSeconds,version FROM work_sessions WHERE id=?', [row.id])).toEqual({ status: 'running', accumulatedSeconds: 0, version: 1 });
  expect((await sql.get('SELECT COUNT(*) n FROM work_sessions')).n).toBe(1);
});

test('record retry never changes an invoiced entry or recreates a deleted entry', async () => {
  const row = await act(await start(), 'pause');
  const entry = await record(row, { billable: true, rate: 4500 });
  await sql.run('UPDATE time_entries SET billed=1 WHERE id=?', [entry.id]);
  expect(await record(row)).toMatchObject({ id: entry.id, billed: 1, rate: 4500, billable: 1 });
  await sql.run('DELETE FROM time_entries WHERE id=?', [entry.id]);
  await expect(record(row)).rejects.toMatchObject({ statusCode: 409 });
  expect((await sql.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(0);
});

test('explicit billable choice, strict inputs, hidden rates and server-owned duration', async () => {
  const row = await act(await start(), 'pause');
  for (const body of [{ version: row.version }, { version: row.version, billable: 'true' }, { version: row.version, billable: false, rate: -1 }, { version: row.version, billable: false, date: '2026-02-30' }, { version: row.version, billable: false, hours: 9 }, { version: row.version, billable: false, billed: true }]) {
    await expect(service.record(a, row.id, body)).rejects.toMatchObject({ statusCode: 400 });
  }
  await expect(service.update(a, row.id, { version: row.version, accumulatedSeconds: 9999 })).rejects.toMatchObject({ statusCode: 400 });
  await expect(start({ activity: 'Research' })).rejects.toMatchObject({ statusCode: 400 });
  await expect(service.update(a, row.id, { description: 'missing version' })).rejects.toMatchObject({ statusCode: 400 });
  await sql.run('UPDATE firm_settings SET advocateBillingVisibility=0');
  await expect(record(row, { rate: 5000 })).rejects.toMatchObject({ statusCode: 400 });
  expect((await record(row)).rate).toBeNull();
});

test('independent backend processes serialize starts through SQLite', async () => {
  const code = `const {createWorkSessions}=require('./lib/workSessions');
    createWorkSessions({databasePath:process.env.DATABASE_PATH,now:()=>${clock}}).start(${JSON.stringify(a)},{matterId:'A'})
    .then(r=>process.send({id:r.id}),e=>process.send({status:e.statusCode}));`;
  const worker = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: databasePath }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let message, stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('message', value => { message = value; });
    child.on('error', reject);
    child.on('exit', code => code === 0 && message ? resolve(message) : reject(new Error(stderr || `Worker exited ${code}`)));
  });
  const results = await Promise.all([worker(), worker()]);
  expect(results.filter(r => r.id)).toHaveLength(1);
  expect(results.filter(r => r.status === 409)).toHaveLength(1);
  expect((await sql.get("SELECT COUNT(*) n FROM work_sessions WHERE status='running'")).n).toBe(1);
});
