const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let advocateFullName, accessibleMatterId, clientId, clientMatterId;
let appearanceId, clientAppearanceId, prepItemId;

const createdAppearanceIds = [];
const createdPrepItemIds = [];

const attendanceFields = ['attendanceStatus', 'appearedBy', 'clientAttended', 'attendanceNote', 'attendanceUpdatedBy', 'attendanceUpdatedAt'];

function dbAll(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { d.all(sql, params, (e, r) => { d.close(); e ? reject(e) : resolve(r); }); });
}
function dbGet(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { d.get(sql, params, (e, r) => { d.close(); e ? reject(e) : resolve(r); }); });
}
function dbRun(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { d.run(sql, params, function (e) { d.close(); e ? reject(e) : resolve(); }); });
}
async function tableCount(table) { return (await dbGet(`SELECT COUNT(*) AS n FROM ${table}`)).n; }
async function sideEffectCounts() {
  return {
    deadlines: await tableCount('deadlines'),
    tasks: await tableCount('tasks'),
    notices: await tableCount('firm_notices'),
    documents: await tableCount('documents'),
    reminderLogs: await tableCount('reminder_logs'),
  };
}
function expectNoAttendanceDeep(value) {
  if (Array.isArray(value)) {
    value.forEach(expectNoAttendanceDeep);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const field of attendanceFields) expect(value).not.toHaveProperty(field);
  Object.values(value).forEach(expectNoAttendanceDeep);
}

async function createAppearance(matterId, title, extra = {}) {
  const res = await request(app).post('/api/appearances').set('Authorization', `Bearer ${adminToken}`).send({
    matterId,
    title,
    date: '2099-10-15',
    time: '9:00 AM',
    type: 'Hearing',
    ...extra,
  });
  expect(res.statusCode).toBe(200);
  createdAppearanceIds.push(res.body.id);
  return res.body.id;
}

beforeAll(async () => {
  await dbReady;
  adminToken = (await request(app).post('/api/auth/login').send({ email: 'admin@lexflow.co.ke', password: 'password123' })).body.token;
  advocateToken = (await request(app).post('/api/auth/login').send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' })).body.token;
  assistantToken = (await request(app).post('/api/auth/login').send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' })).body.token;
  clientToken = (await request(app).post('/api/auth/client-login').send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' })).body.token;
  advocateFullName = (await dbGet("SELECT fullName FROM users WHERE email='sarah.mwangi@achokilaw.co.ke'")).fullName;
  accessibleMatterId = (await dbGet('SELECT id FROM matters WHERE assignedTo=? LIMIT 1', [advocateFullName])).id;
  clientId = (await dbGet("SELECT clientId FROM users WHERE email='margaret.wairimu@example.co.ke' AND role='client'")).clientId;
  clientMatterId = (await dbGet('SELECT id FROM matters WHERE clientId=? LIMIT 1', [clientId])).id;
  appearanceId = await createAppearance(accessibleMatterId, '33D Attendance Hearing', { outcome: 'Outcome remains', prepNote: 'Prep remains' });
  clientAppearanceId = await createAppearance(clientMatterId, '33D Client Attendance Hearing');
  const prep = await request(app).post(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${adminToken}`).send({ title: '33D prep remains', category: 'document' });
  expect(prep.statusCode).toBe(200);
  prepItemId = prep.body.id;
  createdPrepItemIds.push(prepItemId);
});

afterAll(async () => {
  for (const id of createdPrepItemIds) {
    try { await dbRun('DELETE FROM appearance_prep_items WHERE id=?', [id]); } catch {}
  }
  for (const id of createdAppearanceIds) {
    try { await dbRun('DELETE FROM appearances WHERE id=?', [id]); } catch {}
  }
});

describe('KENYA-33D court attendance status', () => {
  test('1. attendance columns exist', async () => {
    const cols = (await dbAll('PRAGMA table_info(appearances)')).map(c => c.name);
    for (const col of attendanceFields) expect(cols).toContain(col);
  });

  test('2. create defaults attendanceStatus to scheduled', async () => {
    const row = await dbGet('SELECT attendanceStatus, appearedBy, clientAttended, attendanceNote FROM appearances WHERE id=?', [appearanceId]);
    expect(row.attendanceStatus).toBe('scheduled');
    expect(row.appearedBy || '').toBe('');
    expect(Number(row.clientAttended)).toBe(0);
    expect(row.attendanceNote || '').toBe('');
  });

  test('3. advocate/admin can update attendance fields', async () => {
    const advocate = await request(app).patch(`/api/appearances/${appearanceId}`).set('Authorization', `Bearer ${advocateToken}`).send({
      attendanceStatus: 'attended',
      appearedBy: 'Sarah Mwangi',
      clientAttended: true,
      attendanceNote: 'Client and advocate attended',
    });
    expect(advocate.statusCode).toBe(200);
    expect(advocate.body).toMatchObject({ attendanceStatus: 'attended', appearedBy: 'Sarah Mwangi', attendanceNote: 'Client and advocate attended' });
    expect(Number(advocate.body.clientAttended)).toBe(1);

    const admin = await request(app).patch(`/api/appearances/${appearanceId}`).set('Authorization', `Bearer ${adminToken}`).send({ attendanceStatus: 'heard' });
    expect(admin.statusCode).toBe(200);
    expect(admin.body.attendanceStatus).toBe('heard');
  });

  test('4. assistant cannot update attendance fields', async () => {
    const res = await request(app).patch(`/api/appearances/${appearanceId}`).set('Authorization', `Bearer ${assistantToken}`).send({ attendanceStatus: 'adjourned' });
    expect(res.statusCode).toBe(403);
  });

  test('5. client cannot access direct appearance route', async () => {
    const res = await request(app).get(`/api/appearances/${appearanceId}`).set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('6. staff matter detail includes attendance fields', async () => {
    const res = await request(app).get(`/api/matters/${accessibleMatterId}`).set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    const appearance = res.body.appearances.find(a => a.id === appearanceId);
    expect(appearance).toBeTruthy();
    for (const field of attendanceFields) expect(appearance).toHaveProperty(field);
  });

  test('7. client dashboard does not expose attendance fields', async () => {
    await request(app).patch(`/api/appearances/${clientAppearanceId}`).set('Authorization', `Bearer ${adminToken}`).send({
      attendanceStatus: 'not_attended',
      appearedBy: 'CLIENT-ATTENDANCE-SECRET',
      clientAttended: true,
      attendanceNote: 'CLIENT-ATTENDANCE-NOTE',
    });
    const res = await request(app).get('/api/client/dashboard').set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expectNoAttendanceDeep(res.body);
    expect(JSON.stringify(res.body)).not.toContain('CLIENT-ATTENDANCE-SECRET');
    expect(JSON.stringify(res.body)).not.toContain('CLIENT-ATTENDANCE-NOTE');
  });

  test('8. client snapshot does not expose attendance fields', async () => {
    const res = await request(app).get(`/api/clients/${clientId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expectNoAttendanceDeep(res.body);
    expect(JSON.stringify(res.body)).not.toContain('CLIENT-ATTENDANCE-SECRET');
    expect(JSON.stringify(res.body)).not.toContain('CLIENT-ATTENDANCE-NOTE');
  });

  test('9. WhatsApp/reminder paths do not expose attendance fields', async () => {
    const res = await request(app).post('/api/whatsapp/reminders').set('Authorization', `Bearer ${adminToken}`).send({ days: 36500 });
    expect(res.statusCode).toBe(200);
    expectNoAttendanceDeep(res.body);
    expect(JSON.stringify(res.body)).not.toContain('CLIENT-ATTENDANCE-SECRET');
    expect(JSON.stringify(res.body)).not.toContain('CLIENT-ATTENDANCE-NOTE');
  });

  test('10. updating attendance sets attendanceUpdatedBy/At', async () => {
    const res = await request(app).patch(`/api/appearances/${appearanceId}`).set('Authorization', `Bearer ${adminToken}`).send({ attendanceStatus: 'adjourned' });
    expect(res.statusCode).toBe(200);
    expect(res.body.attendanceUpdatedBy).toBeTruthy();
    expect(res.body.attendanceUpdatedAt).toBeTruthy();
  });

  test('11. updating attendance does not mutate outcome/prepNote/prep checklist', async () => {
    const beforeAppearance = await dbGet('SELECT outcome, prepNote FROM appearances WHERE id=?', [appearanceId]);
    const beforePrep = await dbGet('SELECT title, category, status, notes FROM appearance_prep_items WHERE id=?', [prepItemId]);
    const res = await request(app).patch(`/api/appearances/${appearanceId}`).set('Authorization', `Bearer ${adminToken}`).send({ attendanceStatus: 'stood_over', attendanceNote: 'Attendance update only' });
    expect(res.statusCode).toBe(200);
    const afterAppearance = await dbGet('SELECT outcome, prepNote FROM appearances WHERE id=?', [appearanceId]);
    const afterPrep = await dbGet('SELECT title, category, status, notes FROM appearance_prep_items WHERE id=?', [prepItemId]);
    expect(afterAppearance).toEqual(beforeAppearance);
    expect(afterPrep).toEqual(beforePrep);
  });

  test('12. updating attendance creates no deadlines/tasks/notices/documents', async () => {
    const before = await sideEffectCounts();
    const res = await request(app).patch(`/api/appearances/${appearanceId}`).set('Authorization', `Bearer ${adminToken}`).send({ appearedBy: 'No side effects' });
    expect(res.statusCode).toBe(200);
    expect(await sideEffectCounts()).toEqual(before);
  });

  test('13. unified deadlines court-date behavior unchanged', async () => {
    const res = await request(app).get('/api/deadlines').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    const appearanceDeadlines = res.body.filter(d => d.source === 'appearance');
    expect(appearanceDeadlines.length).toBeGreaterThan(0);
    for (const item of appearanceDeadlines) {
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('dueDate');
      expectNoAttendanceDeep(item);
    }
  });

  test('14. 33B outcome behavior remains unchanged', async () => {
    const res = await request(app).patch(`/api/appearances/${appearanceId}`).set('Authorization', `Bearer ${adminToken}`).send({ outcome: 'Granted' });
    expect(res.statusCode).toBe(200);
    expect(res.body.outcome).toBe('Granted');
    const clientDashboard = await request(app).get('/api/client/dashboard').set('Authorization', `Bearer ${clientToken}`);
    expect(JSON.stringify(clientDashboard.body)).not.toContain('Granted');
  });

  test('15. 33C prep checklist behavior remains unchanged', async () => {
    const list = await request(app).get(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${assistantToken}`);
    expect(list.statusCode).toBe(200);
    expect(list.body.some(item => item.id === prepItemId)).toBe(true);
    const assistantWrite = await request(app).post(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${assistantToken}`).send({ title: 'Assistant blocked' });
    expect(assistantWrite.statusCode).toBe(403);
  });
});
