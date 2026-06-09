const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let advocateFullName, accessibleMatterId, appearanceId;
let db;

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
async function tableCount(t) { return (await dbGet(`SELECT COUNT(*) AS n FROM ${t}`)).n; }

const createdAppearanceIds = [];

beforeAll(async () => {
  await dbReady;
  db = new sqlite3.Database(config.DATABASE_PATH);
  adminToken = (await request(app).post('/api/auth/login').send({ email: 'admin@lexflow.co.ke', password: 'password123' })).body.token;
  advocateToken = (await request(app).post('/api/auth/login').send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' })).body.token;
  assistantToken = (await request(app).post('/api/auth/login').send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' })).body.token;
  clientToken = (await request(app).post('/api/auth/client-login').send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' })).body.token;
  advocateFullName = (await dbGet("SELECT fullName FROM users WHERE email='sarah.mwangi@achokilaw.co.ke'")).fullName;
  accessibleMatterId = (await dbGet('SELECT id FROM matters WHERE assignedTo=? LIMIT 1', [advocateFullName])).id;
  // create a test appearance
  const res = await request(app).post('/api/appearances').set('Authorization', `Bearer ${adminToken}`).send({
    matterId: accessibleMatterId, title: 'Test Hearing', date: '2099-12-31', time: '10:00 AM', type: 'Hearing'
  });
  appearanceId = res.body.id;
  createdAppearanceIds.push(appearanceId);
});

afterAll(async () => {
  for (const id of createdAppearanceIds) {
    try { await dbRun('DELETE FROM appearances WHERE id=?', [id]); } catch {}
  }
  try { db.close(); } catch {}
});

describe('KENYA-33B hearing brief outcome tracking', () => {
  test('1. appearances table has outcome column', async () => {
    const cols = (await dbAll('PRAGMA table_info(appearances)')).map(c => c.name);
    expect(cols).toContain('outcome');
  });

  test('2. create appearance defaults outcome to empty string', async () => {
    const row = await dbGet('SELECT outcome FROM appearances WHERE id=?', [appearanceId]);
    expect(row).toBeTruthy();
    expect(row.outcome).toBe('');
  });

  test('3. advocate/admin can update outcome', async () => {
    const res = await request(app).patch(`/api/appearances/${appearanceId}`).set('Authorization', `Bearer ${advocateToken}`).send({ outcome: 'Granted' });
    expect(res.statusCode).toBe(200);
    expect(res.body.outcome).toBe('Granted');
    // verify persisted
    const row = await dbGet('SELECT outcome FROM appearances WHERE id=?', [appearanceId]);
    expect(row.outcome).toBe('Granted');
    // clean up
    await request(app).patch(`/api/appearances/${appearanceId}`).set('Authorization', `Bearer ${adminToken}`).send({ outcome: '' });
  });

  test('4. assistant cannot update appearance outcome', async () => {
    const res = await request(app).patch(`/api/appearances/${appearanceId}`).set('Authorization', `Bearer ${assistantToken}`).send({ outcome: 'Dismissed' });
    expect(res.statusCode).toBe(403);
  });

  test('5. client cannot access direct appearance route', async () => {
    const res = await request(app).get(`/api/appearances/${appearanceId}`).set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('6. matter detail includes outcome for staff', async () => {
    const res = await request(app).get(`/api/matters/${accessibleMatterId}`).set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    const appearance = res.body.appearances.find(a => a.id === appearanceId);
    expect(appearance).toBeTruthy();
    expect(appearance).toHaveProperty('outcome');
  });

  test('7. client dashboard/portal data does not expose outcome', async () => {
    const res = await request(app).get('/api/client/dashboard').set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    const appearances = Array.isArray(res.body.appearances) ? res.body.appearances : [];
    for (const a of appearances) {
      expect(a).not.toHaveProperty('outcome');
    }
  });

  test('8. existing unified deadlines court-date behavior unchanged', async () => {
    const deadlinesRes = await request(app).get('/api/deadlines').set('Authorization', `Bearer ${adminToken}`);
    expect(deadlinesRes.statusCode).toBe(200);
    const appearanceDeadlines = (Array.isArray(deadlinesRes.body) ? deadlinesRes.body : []).filter(d => d.source === 'appearance');
    for (const d of appearanceDeadlines) {
      expect(d).toHaveProperty('title');
      expect(d).toHaveProperty('dueDate');
      expect(d).toHaveProperty('source', 'appearance');
    }
  });

  test('9. existing matter timeline appearance behavior unchanged', async () => {
    const timelineRes = await request(app).get(`/api/matters/${accessibleMatterId}/timeline`).set('Authorization', `Bearer ${advocateToken}`);
    expect(timelineRes.statusCode).toBe(200);
    const timelineItems = Array.isArray(timelineRes.body) ? timelineRes.body : [];
    const appearanceEvents = timelineItems.filter(t => t.source === 'appearance' || t.eventType === 'appearance');
    for (const ev of appearanceEvents) {
      expect(ev).toHaveProperty('date');
      expect(ev).toHaveProperty('title');
    }
  });
});
