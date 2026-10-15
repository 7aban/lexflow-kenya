'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
jest.mock('dotenv', () => ({ config: jest.fn() }), { virtual: true });
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'synthetic-work-session-104a-key';
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-104a-api-')), 'synthetic.db');
const request = require('supertest');
const sqlite3 = require('sqlite3');
const { app, dbReady } = require('../server');
const createDb = require('../lib/db');
const { signAccessToken } = require('../lib/tokens');
const { hashPassword } = require('../lib/passwords');

jest.setTimeout(20000);
let db, sql;
const tokens = {};
const children = new Set();
const api = (method, url, body, user = 'a') => {
  let call = request(app)[method](`/api${url}`);
  if (user) call = call.set('Authorization', `Bearer ${tokens[user]}`);
  return body === undefined ? call : call.send(body);
};
const start = (body = {}, user = 'a') => api('post', '/work-sessions', { matterId: '104A-A', ...body }, user);

beforeAll(async () => {
  await dbReady;
  db = new sqlite3.Database(process.env.DATABASE_PATH);
  sql = createDb(db);
  const password = await hashPassword('Synthetic104A!Password');
  for (const [id, role, fullName] of [['a', 'advocate', '104A Advocate A'], ['b', 'advocate', '104A Advocate B'], ['portal', 'client', '104A Client'], ['assistant', 'assistant', '104A Assistant']]) {
    const user = { id: `104A-${id}`, role, fullName, tokenVersion: 1 };
    await sql.run('INSERT INTO users(id,email,password,role,fullName,tokenVersion,isActive) VALUES (?,?,?,?,?,1,1)', [user.id, `${id}@104a.example.test`, password, role, fullName]);
    tokens[id] = signAccessToken(user);
  }
  await sql.run("INSERT INTO clients(id,name,email) VALUES ('104A-C','Synthetic client','client@104a.example.test')");
  for (const [id, assignedTo] of [['104A-A', '104A Advocate A'], ['104A-A2', '104A Advocate A'], ['104A-B', '104A Advocate B']]) {
    await sql.run('INSERT INTO matters(id,clientId,title,assignedTo) VALUES (?,\'104A-C\',?,?)', [id, id, assignedTo]);
  }
  await sql.run("INSERT INTO tasks(id,matterId,title,assignee) VALUES ('104A-TA','104A-A','Synthetic task','104A Advocate A')");
  await sql.run("INSERT INTO tasks(id,matterId,title,assignee) VALUES ('104A-TB','104A-B','Delegated task','104A Advocate A')");
});
beforeEach(async () => {
  await sql.run('DELETE FROM work_sessions');
  await sql.run('DELETE FROM time_entries');
  await sql.run("UPDATE matters SET assignedTo='104A Advocate A' WHERE id='104A-A'");
});
afterAll(async () => {
  for (const child of children) await stop(child);
  if (db) await new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve()));
});

test('HTTP routes use authentication and exclude portal clients', async () => {
  const row = (await start()).body;
  for (const user of [null, 'portal']) {
    for (const [method, url, body] of [['get', '/work-sessions'], ['get', `/work-sessions/${row.id}`], ['post', '/work-sessions', { matterId: '104A-A' }], ['patch', `/work-sessions/${row.id}`, { version: 1, description: 'forbidden' }], ...['pause', 'resume', 'confirm', 'review', 'record'].map(action => ['post', `/work-sessions/${row.id}/${action}`, { version: 1 }])]) {
      expect((await api(method, url, body, user)).status).toBe(user ? 403 : 401);
    }
  }
  expect((await sql.get('SELECT COUNT(*) n FROM work_sessions')).n).toBe(1);
});

test('HTTP ownership, inaccessible matters and optional task validation', async () => {
  const row = (await start({ taskId: '104A-TA' })).body;
  expect(row.taskId).toBe('104A-TA');
  for (const [method, url, body] of [['get', `/work-sessions/${row.id}`], ['patch', `/work-sessions/${row.id}`, { version: 1, description: 'forbidden' }], ...['pause', 'resume', 'confirm', 'review', 'record'].map(action => ['post', `/work-sessions/${row.id}/${action}`, { version: 1 }])]) {
    expect((await api(method, url, body, 'b')).status).toBe(404);
  }
  expect((await api('get', '/work-sessions', undefined, 'b')).body).toEqual([]);
  expect((await start({ matterId: '104A-B', taskId: '104A-TB' })).status).toBe(403);
  expect((await start({ taskId: '104A-TB' })).status).toBe(400);
  expect((await start({ taskId: 'missing' })).status).toBe(400);
});

test('HTTP switch, update, confirmation, pause, resume and idempotent recording', async () => {
  let first = (await start()).body;
  const second = (await start({ matterId: '104A-A2', runningSessionId: first.id, runningVersion: first.version })).body;
  first = (await api('get', `/work-sessions/${first.id}`)).body;
  first = (await api('post', `/work-sessions/${first.id}/resume`, { version: first.version, runningSessionId: second.id, runningVersion: second.version })).body;
  const update = await api('patch', `/work-sessions/${first.id}`, { version: first.version, activity: 'Preparation', description: 'Review evidence' });
  expect(update.status).toBe(200);
  first = update.body;
  const confirmed = await api('post', `/work-sessions/${first.id}/confirm`, { version: first.version });
  expect(confirmed.status).toBe(200);
  const paused = await api('post', `/work-sessions/${first.id}/pause`, { version: confirmed.body.version });
  expect(paused.status).toBe(200);
  const url = `/work-sessions/${first.id}/record`;
  const entries = await Promise.all(Array.from({ length: 4 }, () => api('post', url, { version: paused.body.version, billable: false })));
  expect(entries.every(r => r.status === 200)).toBe(true);
  expect(new Set(entries.map(r => r.body.id)).size).toBe(1);
  expect(entries[0].body).toMatchObject({ description: 'Review evidence', activity: 'Preparation', attorney: '104A Advocate A', billed: 0, billable: 0 });
  expect((await sql.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(1);
});

test('HTTP concurrent starts/resumes and version conflicts return controlled responses', async () => {
  const results = await Promise.all([start(), start(), start()]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409, 409]);
  let row = results.find(r => r.status === 200).body;
  const updates = await Promise.all([api('patch', `/work-sessions/${row.id}`, { version: row.version, description: 'one' }), api('patch', `/work-sessions/${row.id}`, { version: row.version, description: 'two' })]);
  expect(updates.map(r => r.status).sort()).toEqual([200, 409]);
  row = updates.find(r => r.status === 200).body;
  row = (await api('post', `/work-sessions/${row.id}/pause`, { version: row.version })).body;
  const resumes = await Promise.all([api('post', `/work-sessions/${row.id}/resume`, { version: row.version }), api('post', `/work-sessions/${row.id}/resume`, { version: row.version })]);
  expect(resumes.map(r => r.status).sort()).toEqual([200, 409]);
});

test('HTTP record rechecks current matter access and leaves no inserted time', async () => {
  let row = (await start()).body;
  row = (await api('post', `/work-sessions/${row.id}/pause`, { version: row.version })).body;
  await sql.run("UPDATE matters SET assignedTo='104A Advocate B' WHERE id='104A-A'");
  const response = await api('post', `/work-sessions/${row.id}/record`, { version: row.version, billable: true });
  expect(response.status).toBe(403);
  expect(response.body).toEqual({ error: 'Matter access denied' });
  expect((await api('get', '/work-sessions')).body).toEqual([]);
  expect((await sql.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(0);
});

test('existing manual time-entry request/response and fractional hours remain unchanged', async () => {
  const input = { matterId: '104A-A', taskId: '104A-TA', attorney: '104A Advocate A', date: '2026-10-15', hours: 0.1234567, activity: 'Drafting', description: 'Manual entry', rate: 7500, billable: true };
  const response = await api('post', '/time-entries', input);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ...input, id: expect.stringMatching(/^TIME-/), billable: 1, billed: 0, performedByUserId: null });
  expect((await api('get', `/time-entries/${response.body.id}`)).body).toEqual(response.body);
  expect((await sql.get('SELECT COUNT(*) n FROM work_sessions')).n).toBe(0);
});

async function backend() {
  const code = `const {app,dbReady}=require('./server');dbReady.then(()=>{const server=app.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));}).catch(e=>{console.error(e);process.exit(1);});`;
  const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  children.add(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Synthetic backend startup timeout: ${output}`)), 8000);
    child.once('message', message => { clearTimeout(timer); resolve(message.port); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Synthetic backend exited ${code}: ${output}`)); });
  });
  return { child, get: async id => {
    const response = await fetch(`http://127.0.0.1:${port}/api/work-sessions/${id}`, { headers: { Authorization: `Bearer ${tokens.a}` } });
    expect(response.status).toBe(200);
    return response.json();
  } };
}
async function stop(child) {
  if (!children.has(child)) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await exited;
  children.delete(child);
}

test('actual backend process restarts retain confirmed time and recover an interrupted interval', async () => {
  let row = (await start()).body;
  await sql.run('UPDATE work_sessions SET lastConfirmedAt=? WHERE id=?', [Date.now() - 30000, row.id]);
  row = (await api('post', `/work-sessions/${row.id}/confirm`, { version: row.version })).body;
  expect(row.accumulatedSeconds).toBeGreaterThanOrEqual(30);
  const one = await backend();
  const beforeRestart = await one.get(row.id);
  await stop(one.child);
  const two = await backend();
  expect(await two.get(row.id)).toMatchObject({ id: row.id, version: row.version, status: 'running', accumulatedSeconds: beforeRestart.accumulatedSeconds, lastConfirmedAt: beforeRestart.lastConfirmedAt });
  await stop(two.child);
  await sql.run('UPDATE work_sessions SET lastConfirmedAt=? WHERE id=?', [Date.now() - 8 * 3600000, row.id]);
  const three = await backend();
  const recovered = await three.get(row.id);
  expect(recovered).toMatchObject({ status: 'paused', accumulatedSeconds: row.accumulatedSeconds, recoveryRequired: 1, pendingSeconds: 0 });
  expect(recovered.uncertainSeconds).toBeGreaterThanOrEqual(8 * 3600);
  await stop(three.child);
  const review = await api('post', `/work-sessions/${row.id}/review`, { version: recovered.version, discardUnconfirmed: true });
  expect(review.status).toBe(200);
  const recorded = await api('post', `/work-sessions/${row.id}/record`, { version: review.body.version, billable: false });
  expect(recorded.status).toBe(200);
  expect(recorded.body.hours).toBe(row.accumulatedSeconds / 3600);
});
