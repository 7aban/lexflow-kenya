const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let advocateFullName, accessibleMatterId, inaccessibleMatterId, clientId, clientMatterId;
let appearanceId, otherAppearanceId, clientAppearanceId, prepItemId, otherPrepItemId;

const createdAppearanceIds = [];
const createdPrepItemIds = [];

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
function expectNoPrepItemsDeep(value) {
  if (Array.isArray(value)) {
    value.forEach(expectNoPrepItemsDeep);
    return;
  }
  if (!value || typeof value !== 'object') return;
  expect(value).not.toHaveProperty('prepItems');
  expect(value).not.toHaveProperty('appearancePrepItems');
  Object.values(value).forEach(expectNoPrepItemsDeep);
}

async function createAppearance(matterId, title, outcome = '') {
  const res = await request(app).post('/api/appearances').set('Authorization', `Bearer ${adminToken}`).send({
    matterId,
    title,
    date: '2099-11-15',
    time: '9:00 AM',
    type: 'Hearing',
    outcome,
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
  inaccessibleMatterId = (await dbGet("SELECT id FROM matters WHERE COALESCE(assignedTo,'')<>? LIMIT 1", [advocateFullName])).id;
  clientId = (await dbGet("SELECT clientId FROM users WHERE email='margaret.wairimu@example.co.ke' AND role='client'")).clientId;
  clientMatterId = (await dbGet('SELECT id FROM matters WHERE clientId=? LIMIT 1', [clientId])).id;

  appearanceId = await createAppearance(accessibleMatterId, '33C Hearing', 'Outcome should remain');
  otherAppearanceId = await createAppearance(inaccessibleMatterId, '33C Other Hearing');
  clientAppearanceId = await createAppearance(clientMatterId, '33C Client Hearing');
});

afterAll(async () => {
  for (const id of createdPrepItemIds) {
    try { await dbRun('DELETE FROM appearance_prep_items WHERE id=?', [id]); } catch {}
  }
  for (const id of createdAppearanceIds) {
    try { await dbRun('DELETE FROM appearances WHERE id=?', [id]); } catch {}
  }
});

describe('KENYA-33C hearing preparation checklist', () => {
  test('1. appearance_prep_items table exists', async () => {
    const cols = (await dbAll('PRAGMA table_info(appearance_prep_items)')).map(c => c.name);
    for (const col of ['id', 'appearanceId', 'matterId', 'title', 'category', 'status', 'notes', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'completedBy', 'completedAt']) {
      expect(cols).toContain(col);
    }
  });

  test('2. client forbidden', async () => {
    const list = await request(app).get(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${clientToken}`);
    expect(list.statusCode).toBe(403);
    const create = await request(app).post(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${clientToken}`).send({ title: 'Client item' });
    expect(create.statusCode).toBe(403);
  });

  test('3. assistant can read but cannot write', async () => {
    const list = await request(app).get(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${assistantToken}`);
    expect(list.statusCode).toBe(200);
    const create = await request(app).post(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${assistantToken}`).send({ title: 'Assistant item' });
    expect(create.statusCode).toBe(403);
  });

  test('4. advocate/admin can create prep item', async () => {
    const res = await request(app).post(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${advocateToken}`).send({
      title: 'Prepare authorities bundle',
      category: 'authority',
      notes: 'Include latest Court of Appeal authority',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ appearanceId, matterId: accessibleMatterId, title: 'Prepare authorities bundle', category: 'authority', status: 'open' });
    prepItemId = res.body.id;
    createdPrepItemIds.push(prepItemId);

    const adminRes = await request(app).post(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Confirm client attendance', category: 'client' });
    expect(adminRes.statusCode).toBe(200);
    createdPrepItemIds.push(adminRes.body.id);
  });

  test('5. inaccessible matter/appearance is denied', async () => {
    const read = await request(app).get(`/api/appearances/${otherAppearanceId}/prep-items`).set('Authorization', `Bearer ${advocateToken}`);
    expect(read.statusCode).toBe(403);
    const write = await request(app).post(`/api/appearances/${otherAppearanceId}/prep-items`).set('Authorization', `Bearer ${advocateToken}`).send({ title: 'Denied item' });
    expect(write.statusCode).toBe(403);
  });

  test('6. invalid category rejected', async () => {
    const res = await request(app).post(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Bad category', category: 'billing' });
    expect(res.statusCode).toBe(400);
  });

  test('7. invalid status rejected', async () => {
    const res = await request(app).post(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Bad status', status: 'blocked' });
    expect(res.statusCode).toBe(400);
  });

  test('8. patch can update title/category/notes/status', async () => {
    const res = await request(app).patch(`/api/appearance-prep-items/${prepItemId}`).set('Authorization', `Bearer ${advocateToken}`).send({
      title: 'File submissions',
      category: 'submission',
      notes: 'Draft and file submissions',
      status: 'open',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ title: 'File submissions', category: 'submission', notes: 'Draft and file submissions', status: 'open' });
    expect(res.body.updatedBy).toBeTruthy();
    expect(res.body.updatedAt).toBeTruthy();
  });

  test('9. marking done sets completedBy/completedAt', async () => {
    const res = await request(app).patch(`/api/appearance-prep-items/${prepItemId}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'done' });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('done');
    expect(res.body.completedBy).toBeTruthy();
    expect(res.body.completedAt).toBeTruthy();
  });

  test('10. list returns only items for requested appearance', async () => {
    const other = await request(app).post(`/api/appearances/${otherAppearanceId}/prep-items`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Other appearance item', category: 'document' });
    expect(other.statusCode).toBe(200);
    otherPrepItemId = other.body.id;
    createdPrepItemIds.push(otherPrepItemId);
    const res = await request(app).get(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every(item => item.appearanceId === appearanceId)).toBe(true);
    expect(res.body.some(item => item.id === otherPrepItemId)).toBe(false);
  });

  test('11. prep items are not exposed in client dashboard', async () => {
    const secret = await request(app).post(`/api/appearances/${clientAppearanceId}/prep-items`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'CLIENT-PREP-SECRET', category: 'document' });
    expect(secret.statusCode).toBe(200);
    createdPrepItemIds.push(secret.body.id);
    const res = await request(app).get('/api/client/dashboard').set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expectNoPrepItemsDeep(res.body);
    expect(JSON.stringify(res.body)).not.toContain('CLIENT-PREP-SECRET');
  });

  test('12. prep items are not exposed in client snapshot', async () => {
    const res = await request(app).get(`/api/clients/${clientId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expectNoPrepItemsDeep(res.body);
    expect(JSON.stringify(res.body)).not.toContain('CLIENT-PREP-SECRET');
  });

  test('13. creating/updating prep items creates no deadline/task/notice/document', async () => {
    const before = await sideEffectCounts();
    const create = await request(app).post(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'No side effect item', category: 'filing' });
    expect(create.statusCode).toBe(200);
    createdPrepItemIds.push(create.body.id);
    const patch = await request(app).patch(`/api/appearance-prep-items/${create.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ notes: 'Still no side effects', status: 'done' });
    expect(patch.statusCode).toBe(200);
    expect(await sideEffectCounts()).toEqual(before);
  });

  test('14. existing 33B outcome behavior remains unchanged', async () => {
    const before = await dbGet('SELECT outcome, prepNote FROM appearances WHERE id=?', [appearanceId]);
    const res = await request(app).patch(`/api/appearance-prep-items/${prepItemId}`).set('Authorization', `Bearer ${adminToken}`).send({ notes: 'Prep item update only' });
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT outcome, prepNote FROM appearances WHERE id=?', [appearanceId]);
    expect(after.outcome).toBe(before.outcome);
    expect(after.prepNote || '').toBe(before.prepNote || '');
    const staffMatter = await request(app).get(`/api/matters/${accessibleMatterId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(staffMatter.statusCode).toBe(200);
    const appearance = staffMatter.body.appearances.find(a => a.id === appearanceId);
    expect(appearance).toHaveProperty('outcome');
    expect(Array.isArray(appearance.prepItems)).toBe(true);
  });
});
