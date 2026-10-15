'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
jest.mock('dotenv', () => ({ config: jest.fn() }), { virtual: true });
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'synthetic-104c1-attribution-key';
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-104c1-')), 'synthetic.db');
const request = require('supertest');
const sqlite3 = require('sqlite3');
const createDb = require('../lib/db');
const { app, dbReady } = require('../server');
const { signAccessToken } = require('../lib/tokens');
const { createWorkSessions } = require('../lib/workSessions');
const { nairobiWorkDate, validWorkDate } = require('../lib/dailyWorkReview');

jest.setTimeout(20000);
let db, sql;
const tokens = {};
const day = '2026-10-15';
const users = [
  ['a', 'advocate', 'Worker A'], ['same', 'advocate', 'Worker A'],
  ['b', 'advocate', 'Worker B'], ['admin', 'admin', 'Admin'],
  ['assistant', 'assistant', 'Assistant'], ['portal', 'client', 'Client'],
];
function api(method, url, body, user = 'a') {
  let call = request(app)[method](`/api${url}`);
  if (user) call = call.set('Authorization', `Bearer ${tokens[user]}`);
  return body === undefined ? call : call.send(body);
}
const manual = (body = {}, actor = 'a') => api('post', '/time-entries', { matterId: 'A', hours: 1.25, date: day, description: 'Draft submissions', billable: true, ...body }, actor);
const review = (date = day, actor = 'a') => api('get', `/daily-work-review?date=${date}`, undefined, actor);
const actor = { user: { userId: 'a', fullName: 'Worker A', role: 'advocate', tokenVersion: 1 }, headers: {} };
async function sessionEntry({ at = Date.parse(`${day}T09:00:00Z`), seconds = 61, date, matterId = 'A', taskId, billable = false } = {}) {
  let clock = at;
  const service = createWorkSessions({ databasePath: process.env.DATABASE_PATH, now: () => clock });
  let row = await service.start(actor, { matterId, ...(taskId ? { taskId } : {}), description: 'Confirmed session work' });
  clock += seconds * 1000;
  row = await service.transition(actor, row.id, 'pause', { version: row.version });
  const input = { version: row.version, billable, ...(date ? { date } : {}) };
  const entry = await service.record(actor, row.id, input);
  return { row, entry, service, input };
}
async function legacy(id, overrides = {}) {
  const entry = { id, matterId: 'A', attorney: 'Worker A', date: day, hours: 9, activity: 'Other', description: '', rate: 99999, billed: 0, billable: 1, ...overrides };
  await sql.run(`INSERT INTO time_entries (${Object.keys(entry).join(',')}) VALUES (${Object.keys(entry).map(() => '?').join(',')})`, Object.values(entry));
  return sql.get('SELECT * FROM time_entries WHERE id=?', [id]);
}

beforeAll(async () => {
  await dbReady;
  db = new sqlite3.Database(process.env.DATABASE_PATH);
  sql = createDb(db);
  for (const [id, role, fullName] of users) {
    await sql.run('INSERT INTO users(id,email,fullName,role,tokenVersion,isActive) VALUES (?,?,?,?,1,1)', [id, `${id}@104c1.example.test`, fullName, role]);
    tokens[id] = signAccessToken({ id, role, fullName, tokenVersion: 1 });
  }
  await sql.run("INSERT INTO clients(id,name) VALUES ('C','Synthetic client')");
  for (const [id, assignedTo] of [['A', 'Worker A'], ['A2', 'Worker A'], ['B', 'Worker B']]) {
    await sql.run("INSERT INTO matters(id,clientId,reference,title,assignedTo,billingType) VALUES (?,'C',?,?,?,'hourly')", [id, `REF-${id}`, `Matter ${id}`, assignedTo]);
  }
  await sql.run("INSERT INTO tasks(id,matterId,title,assignee) VALUES ('TA','A','Private task','Worker A')");
  await sql.run("INSERT INTO firm_settings(id,name,advocateBillingVisibility) VALUES ('default','Synthetic firm',1)");
});
beforeEach(async () => {
  await sql.run('DELETE FROM work_sessions');
  await sql.run('DELETE FROM invoice_items');
  await sql.run('DELETE FROM invoices');
  await sql.run('DELETE FROM time_entries');
  await sql.run("UPDATE users SET fullName='Worker A',tokenVersion=1,isActive=1 WHERE id IN ('a','same')");
  await sql.run("UPDATE matters SET assignedTo='Worker A' WHERE id IN ('A','A2')");
  await sql.run("UPDATE users SET isActive=1 WHERE id='b'");
  await sql.run('UPDATE firm_settings SET advocateBillingVisibility=1');
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { if (db) await new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve())); });

test('fresh schema adds one nullable worker ID without replacing the display field', async () => {
  const columns = await sql.all('PRAGMA table_info(time_entries)');
  expect(columns.filter(c => c.name === 'performedByUserId')).toEqual([expect.objectContaining({ type: 'TEXT', notnull: 0, dflt_value: null })]);
  expect(columns.some(c => c.name === 'attorney')).toBe(true);
});

test('manual default identifies the authenticated performer, with exact fractional hours', async () => {
  const response = await manual({ hours: 0.1234567 });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ attorney: 'Worker A', performedByUserId: 'a', hours: 0.1234567, date: day, billable: 1 });
  expect((await review()).body.totals).toEqual({ billableHours: 0.1234567, nonBillableHours: 0, totalHours: 0.1234567 });
});

test('explicit stable self attribution validates ID rather than matching a name', async () => {
  const response = await manual({ performedByUserId: 'a', attorney: 'Worker A' });
  expect(response.status).toBe(200);
  expect(response.body.performedByUserId).toBe('a');
  for (const attorney of ['Worker A', '', null]) {
    const legacyResponse = await manual({ attorney });
    expect(legacyResponse.status).toBe(200);
    expect(legacyResponse.body.performedByUserId).toBeNull();
  }
});

test('authorized admin and assistant can create on behalf through their existing matter-create permission', async () => {
  for (const user of ['admin', 'assistant']) {
    const response = await manual({ performedByUserId: 'b', matterId: 'B' }, user);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ attorney: 'Worker B', performedByUserId: 'b' });
    expect((await review(day, user)).body.entries).toEqual([]);
  }
  expect((await review(day, 'b')).body.totals.totalHours).toBe(2.5);
  expect((await manual({ attorney: 'Legacy on behalf' }, 'assistant')).status).toBe(200);
});

test('performer ID never expands matter access and rejects invalid or contradictory attribution', async () => {
  expect((await manual({ matterId: 'B', performedByUserId: 'b' })).status).toBe(403);
  expect((await manual({ performedByUserId: 'b' })).status).toBe(403);
  for (const performedByUserId of ['absent', 'portal', '', null, 123, ['a']]) {
    expect((await manual({ performedByUserId })).status).toBe(400);
  }
  expect((await manual({ performedByUserId: 'a', attorney: 'Worker B' })).status).toBe(400);
  await sql.run("UPDATE users SET isActive=0 WHERE id='b'");
  expect((await manual({ matterId: 'B', performedByUserId: 'b' }, 'admin')).status).toBe(400);
  expect((await manual({}, 'portal')).status).toBe(403);
  expect((await sql.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(0);
});

test('session recording binds owning user, retains precision, and idempotent retries never backfill', async () => {
  const { row, entry, service, input } = await sessionEntry({ seconds: 97 });
  expect(entry).toMatchObject({ performedByUserId: 'a', hours: 97 / 3600 });
  expect(await service.record(actor, row.id, input)).toEqual(entry);
  expect((await sql.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(1);
  await sql.run('UPDATE time_entries SET performedByUserId=NULL,billed=1 WHERE id=?', [entry.id]);
  const legacyRetry = await service.record(actor, row.id, input);
  expect(legacyRetry).toMatchObject({ id: entry.id, performedByUserId: null, billed: 1 });
  expect((await review()).body.entries[0]).toMatchObject({ id: entry.id, attribution: 'session_owner', source: 'persistent_session' });
});

test('full-name changes preserve stable attribution without rewriting historical display names', async () => {
  const entry = (await manual()).body;
  await sql.run("UPDATE users SET fullName='Renamed Worker' WHERE id='a'");
  await sql.run("UPDATE matters SET assignedTo='Renamed Worker' WHERE id IN ('A','A2')");
  const response = await review();
  expect(response.status).toBe(200);
  expect(response.body.entries.map(e => e.id)).toEqual([entry.id]);
  expect((await sql.get('SELECT attorney,performedByUserId FROM time_entries WHERE id=?', [entry.id]))).toEqual({ attorney: 'Worker A', performedByUserId: 'a' });
});

test('two users sharing a display name are not conflated; legacy names remain unverified', async () => {
  const own = (await manual()).body;
  const other = (await manual({}, 'same')).body;
  const ambiguous = await legacy('old-shared-name');
  const first = (await review()).body, second = (await review(day, 'same')).body;
  expect(first.entries.map(e => e.id)).toEqual([own.id]);
  expect(second.entries.map(e => e.id)).toEqual([other.id]);
  for (const response of [first, second]) {
    expect(response.unverifiedEntries.map(e => e.id)).toEqual([ambiguous.id]);
    expect(response.unverifiedEntries[0].attribution).toBe('legacy_name_unverified');
    expect(response.totals.totalHours).toBe(1.25);
  }
  expect(await sql.get('SELECT * FROM time_entries WHERE id=?', [ambiguous.id])).toEqual(ambiguous);
});

test.each([
  ['2026-10-14T20:59:59.999Z', '2026-10-14'],
  ['2026-10-14T21:00:00.000Z', '2026-10-15'],
])('Nairobi work-date default at %s applies to manual, session and daily GET', async (instant, expected) => {
  const at = Date.parse(instant);
  expect(nairobiWorkDate(at)).toBe(expected);
  jest.spyOn(Date, 'now').mockReturnValue(at);
  const response = await api('post', '/time-entries', { matterId: 'A', hours: 0.5 });
  expect(response.status).toBe(200);
  expect(response.body.date).toBe(expected);
  const { entry } = await sessionEntry({ at, seconds: 0 });
  expect(entry.date).toBe(expected);
  const daily = await api('get', '/daily-work-review');
  expect(daily.status).toBe(200);
  expect(daily.body.date).toBe(expected);
  expect(daily.body.entries.map(e => e.id).sort()).toEqual([entry.id, response.body.id].sort());
});

test('explicit historical dates survive creation; invalid and duplicate query dates are rejected', async () => {
  const response = await manual({ date: '2024-02-29' });
  const { entry } = await sessionEntry({ date: '2024-02-29' });
  expect(response.status).toBe(200);
  expect(entry.date).toBe('2024-02-29');
  expect((await review('2024-02-29')).body.entries).toHaveLength(2);
  expect((await review()).body.entries).toEqual([]);
  for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', '2026-10-15T09:00:00Z', '', null, 123]) {
    expect(validWorkDate(date)).toBe(false);
    expect((await manual({ date })).status).toBe(400);
    expect((await review(String(date))).status).toBe(400);
  }
  expect((await api('get', '/daily-work-review?date=2026-10-15&date=2026-10-16')).status).toBe(400);
});

test('daily totals span accessible matters, separate billability and count each entry once', async () => {
  const manualEntry = (await manual({ hours: 2, rate: 10000 })).body;
  const nonBillable = (await manual({ matterId: 'A2', hours: 0.375, billable: false })).body;
  const { entry } = await sessionEntry({ seconds: 90, matterId: 'A2', billable: true });
  const response = await review();
  expect(response.status).toBe(200);
  expect(response.body.totals).toEqual({ billableHours: 2.025, nonBillableHours: 0.375, totalHours: 2.4 });
  expect(response.body.entries.map(e => e.id).sort()).toEqual([manualEntry.id, nonBillable.id, entry.id].sort());
  expect(response.body.entries.find(e => e.id === entry.id)).toMatchObject({ attribution: 'stable_user_id_and_session_owner', source: 'persistent_session', activity: 'Legal Research', date: day, matterReference: 'REF-A2', matterTitle: 'Matter A2' });
  expect(response.body.entries.find(e => e.id === manualEntry.id).source).toBe('unknown');
});

test('inaccessible matters and another worker are excluded before aggregation, including stable own rows', async () => {
  const own = (await manual()).body;
  await legacy('own-inaccessible', { matterId: 'B', performedByUserId: 'a', hours: 99 });
  await legacy('name-inaccessible', { matterId: 'B', hours: 98 });
  await legacy('other-in-accessible', { performedByUserId: 'b', hours: 97 });
  const response = (await review()).body;
  expect(response.entries.map(e => e.id)).toEqual([own.id]);
  expect(response.unverifiedEntries).toEqual([]);
  expect(response.totals.totalHours).toBe(1.25);
});

test('unknown source remains unknown and a conflicting stable/session owner is not credited', async () => {
  const { entry } = await sessionEntry();
  await sql.run("UPDATE time_entries SET performedByUserId='same' WHERE id=?", [entry.id]);
  for (const user of ['a', 'same']) {
    const response = (await review(day, user)).body;
    expect(response.entries).toEqual([]);
    expect(response.totals.totalHours).toBe(0);
    expect(response.unverifiedEntries).toEqual([expect.objectContaining({ id: entry.id, attribution: 'conflicting_attribution', source: 'unknown', performedByUserId: null })]);
    expect(JSON.stringify(response)).not.toContain('sessionOwner');
  }
});

test('daily GET is read-only even with overdue running sessions and does not disclose private sessions', async () => {
  const service = createWorkSessions({ databasePath: process.env.DATABASE_PATH, now: () => Date.parse('2020-01-01T00:00:00Z') });
  await service.start(actor, { matterId: 'A', taskId: 'TA', description: 'Private unfinished narrative' });
  const beforeSessions = await sql.all('SELECT * FROM work_sessions');
  const beforeEntries = await sql.all('SELECT * FROM time_entries');
  const beforeAudit = await sql.all('SELECT * FROM audit_events ORDER BY id');
  for (const user of ['a', 'same', 'admin', 'assistant']) {
    const response = await review(day, user);
    expect(response.status).toBe(200);
    expect(response.body.entries).toEqual([]);
    expect(response.body.unverifiedEntries).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain('Private unfinished narrative');
  }
  expect(await sql.all('SELECT * FROM work_sessions')).toEqual(beforeSessions);
  expect(await sql.all('SELECT * FROM time_entries')).toEqual(beforeEntries);
  expect(await sql.all('SELECT * FROM audit_events ORDER BY id')).toEqual(beforeAudit);
});

test('authentication, token revocation, portal exclusion and actor selection cannot be bypassed', async () => {
  await manual();
  expect((await review(day, null)).status).toBe(401);
  expect((await review(day, 'portal')).status).toBe(403);
  const other = await api('get', `/daily-work-review?date=${day}&userId=a&performedByUserId=a`, undefined, 'same');
  expect(other.status).toBe(200);
  expect(other.body.entries).toEqual([]);
  await sql.run("UPDATE users SET tokenVersion=2 WHERE id='a'");
  expect((await review()).status).toBe(401);
});

test('daily response never contains rates or financial values with billing visibility on or off', async () => {
  await manual({ rate: 77777 });
  for (const visibility of [1, 0]) {
    await sql.run('UPDATE firm_settings SET advocateBillingVisibility=?', [visibility]);
    const response = await review();
    expect(response.status).toBe(200);
    expect(response.body.entries).toHaveLength(1);
    for (const entry of response.body.entries) {
      expect(entry).not.toHaveProperty('rate');
      expect(entry).not.toHaveProperty('amount');
      expect(entry).not.toHaveProperty('sessionOwner');
      expect(entry).not.toHaveProperty('sessionId');
    }
    expect(JSON.stringify(response.body)).not.toContain('77777');
  }
});

test('legacy manual editing preserves stable identity for work edits, clears it for performer changes and offers no backfill', async () => {
  const entry = (await manual()).body;
  const update = await api('patch', `/time-entries/${entry.id}`, { description: 'Verified edited description', hours: 0.75, billable: false });
  expect(update.status).toBe(200);
  expect(update.body).toMatchObject({ performedByUserId: 'a', hours: 0.75, billable: 0 });
  const reassign = await api('patch', `/time-entries/${entry.id}`, { attorney: 'Worker B' });
  expect(reassign.status).toBe(200);
  expect(reassign.body).toMatchObject({ attorney: 'Worker B', performedByUserId: null, hours: 0.75 });
  const old = await legacy('no-backfill');
  expect((await api('patch', `/time-entries/${old.id}`, { performedByUserId: 'a' }, 'admin')).status).toBe(400);
  expect(await sql.get('SELECT * FROM time_entries WHERE id=?', [old.id])).toEqual(old);
  expect((await api('patch', `/time-entries/${entry.id}`, { description: 'Forbidden' }, 'assistant')).status).toBe(403);
});

test('session attribution cannot be contradicted through legacy attorney editing', async () => {
  const { entry } = await sessionEntry();
  expect((await api('patch', `/time-entries/${entry.id}`, { attorney: 'Worker B' }, 'admin')).status).toBe(409);
  expect((await sql.get('SELECT attorney,performedByUserId FROM time_entries WHERE id=?', [entry.id]))).toEqual({ attorney: 'Worker A', performedByUserId: 'a' });
  expect((await api('patch', `/time-entries/${entry.id}`, { description: 'Edited description' })).status).toBe(200);
});

test.each(['manual', 'legacy', 'session'])('full-row editor PATCH preserves %s attribution without permitting ID reassignment', async kind => {
  const entry = kind === 'session' ? (await sessionEntry()).entry
    : (await manual(kind === 'legacy' ? { attorney: 'Worker A' } : {})).body;
  // Match TimeEntryEditorList's {...entry} state and saveTimeEntry's request.
  const response = await api('patch', `/time-entries/${entry.id}`, { ...entry, description: 'Edited through the existing form' });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ id: entry.id, description: 'Edited through the existing form',
    performedByUserId: entry.performedByUserId, attorney: entry.attorney, hours: entry.hours, billed: entry.billed });
  const reassignment = await api('patch', `/time-entries/${entry.id}`, { ...response.body, performedByUserId: 'same' });
  expect(reassignment.status).toBe(400);
  expect(await sql.get('SELECT * FROM time_entries WHERE id=?', [entry.id])).toEqual(response.body);
  if (kind === 'manual') {
    const changed = await api('patch', `/time-entries/${entry.id}`, { ...response.body, attorney: 'Worker B' });
    expect(changed.status).toBe(200);
    expect(changed.body.performedByUserId).toBeNull();
    const stale = await api('patch', `/time-entries/${entry.id}`, { ...response.body, description: 'Stale form' });
    expect(stale.status).toBe(400);
    expect(await sql.get('SELECT * FROM time_entries WHERE id=?', [entry.id])).toEqual(changed.body);
  }
});

test('invoice generation includes only billable time and record retry preserves billed state', async () => {
  const billable = (await manual({ hours: 2, rate: 1000 })).body;
  const nonBillable = (await manual({ hours: 3, rate: 1000, billable: false })).body;
  const { row, entry, service, input } = await sessionEntry();
  const invoice = await api('post', '/invoices/generate', { matterId: 'A' }, 'admin');
  expect(invoice.status).toBe(200);
  expect(invoice.body.amount).toBe(2000);
  expect((await sql.get('SELECT billed FROM time_entries WHERE id=?', [billable.id])).billed).toBe(1);
  expect((await sql.get('SELECT billed FROM time_entries WHERE id=?', [nonBillable.id])).billed).toBe(0);
  await sql.run('UPDATE time_entries SET billed=1 WHERE id=?', [entry.id]);
  expect(await service.record(actor, row.id, input)).toMatchObject({ id: entry.id, billed: 1, performedByUserId: 'a' });
  expect((await review()).body.totals.totalHours).toBe(5 + 61 / 3600);
});

test('existing synthetic schema migration is idempotent and does not backfill or alter historical values', async () => {
  const location = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-104c1-migrate-')), 'synthetic.db');
  const legacyDb = new sqlite3.Database(location);
  const oldSql = createDb(legacyDb);
  await oldSql.run('CREATE TABLE time_entries(id TEXT PRIMARY KEY,matterId TEXT,attorney TEXT,date TEXT,hours REAL,activity TEXT,description TEXT,rate REAL,billed INTEGER,billable INTEGER,taskId TEXT)');
  await oldSql.run("INSERT INTO time_entries VALUES ('old','absent-matter','Worker A','2020-01-02',0.1234567,'Other','Original',123,1,0,'')");
  const before = await oldSql.get('SELECT * FROM time_entries');
  await new Promise((resolve, reject) => legacyDb.close(e => e ? reject(e) : resolve()));
  const program = `const {dbReady}=require('./server'); const sqlite3=require('sqlite3'); dbReady.then(()=>{const db=new sqlite3.Database(process.env.DATABASE_PATH);db.get('SELECT * FROM time_entries WHERE id=?',['old'],(e,row)=>{if(e)throw e;console.log('104C1_ROW:'+JSON.stringify(row));db.close(()=>process.exit(0));});}).catch(e=>{console.error(e);process.exit(1);});`;
  for (let pass = 0; pass < 2; pass++) {
    const child = spawnSync(process.execPath, ['-e', program], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: location }, encoding: 'utf8', windowsHide: true, timeout: 12000 });
    expect({ error: child.error?.message, status: child.status }).toEqual({ error: undefined, status: 0 });
    const row = JSON.parse(child.stdout.split('\n').find(line => line.startsWith('104C1_ROW:')).slice('104C1_ROW:'.length));
    expect(row).toEqual({ ...before, performedByUserId: null });
  }
});
