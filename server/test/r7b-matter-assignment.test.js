const request = require('supertest');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');
const path = require('path');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');
const { hashPassword } = require('../lib/passwords');
const { genId } = require('../lib/utils');

let adminToken;
let advocateToken;
let assistantToken;
let clientToken;
let matterId;
let inactiveAdvocateEmail;
let inactiveAdvocateId;

beforeAll(async () => {
  await dbReady;
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = adminRes.body.token;

  const advRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
  advocateToken = advRes.body.token;

  const asstRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' });
  assistantToken = asstRes.body.token;

  const clientRes = await request(app)
    .post('/api/auth/client-login')
    .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
  clientToken = clientRes.body.token;

  // Get a matter assigned to Sarah Mwangi
  const mattersRes = await request(app)
    .get('/api/matters')
    .set('Authorization', `Bearer ${advocateToken}`);
  const sarahMatters = mattersRes.body.filter(m => m.assignedTo === 'Sarah Mwangi');
  matterId = sarahMatters.length ? sarahMatters[0].id : null;

  // Create an inactive advocate for testing
  const db = new sqlite3.Database(config.DATABASE_PATH);
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, (err) => err ? reject(err) : resolve());
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
  inactiveAdvocateEmail = 'inactive.advocate.r7b@test.com';
  const existing = await get('SELECT id FROM users WHERE email=?', [inactiveAdvocateEmail]);
  if (!existing) {
    const pwd = await hashPassword('Str0ng!Passw0rd2026');
    const id = genId('U');
    await run('INSERT INTO users (id,email,password,fullName,role,createdAt,tokenVersion,isActive) VALUES (?,?,?,?,?,?,?,?)', [id, inactiveAdvocateEmail, pwd, 'Inactive Advocate R7b', 'advocate', new Date().toISOString(), 1, 0]);
    inactiveAdvocateId = id;
  } else {
    inactiveAdvocateId = existing.id;
  }
  db.close();
});

afterAll(async () => {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, (err) => err ? reject(err) : resolve());
  });
  const { hashPassword } = require('../lib/passwords');
  try {
    const defaultHash = await hashPassword('password123');
    await run("UPDATE users SET password=? WHERE email IN (?,?)", [defaultHash, 'admin@lexflow.co.ke', 'sarah.mwangi@achokilaw.co.ke']);
    if (inactiveAdvocateId) {
      await run('DELETE FROM users WHERE id=?', [inactiveAdvocateId]);
    }
  } finally {
    db.close();
  }
});

describe('R7b-1 - PATCH /api/matters/:id/reassign', () => {
  test('1. Admin can reassign a matter to a valid active advocate', async () => {
    expect(matterId).toBeDefined();
    const res = await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'Michael Oduor' });
    expect(res.statusCode).toBe(200);
    expect(res.body.assignedTo).toBe('Michael Oduor');
    // Reassign back for other tests
    await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'Sarah Mwangi' });
  });

  test('2. Reassignment rejects nonexistent user', async () => {
    const res = await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'Nonexistent Advocate XYZ' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/does not exist/i);
  });

  test('3. Reassignment rejects non-advocate user', async () => {
    const res = await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'David Wanjiku' }); // assistant
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not an advocate/i);
  });

  test('4. Reassignment rejects inactive advocate', async () => {
    const res = await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'Inactive Advocate R7b' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not active/i);
  });

  test('5. Reassignment rejects no-op same assignedTo', async () => {
    // Ensure matter is assigned to Sarah Mwangi first
    await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'Sarah Mwangi' });
    const res = await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'Sarah Mwangi' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/already assigned/i);
  });

  test('6. Advocate cannot reassign matter', async () => {
    const res = await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ assignedTo: 'Michael Oduor' });
    expect(res.statusCode).toBe(403);
  });

  test('7. Assistant cannot reassign matter', async () => {
    const res = await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ assignedTo: 'Michael Oduor' });
    expect(res.statusCode).toBe(403);
  });

  test('8. Unauthenticated request is rejected', async () => {
    const res = await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .send({ assignedTo: 'Michael Oduor' });
    expect(res.statusCode).toBe(401);
  });

  test('9. Reassignment creates matter_reassigned audit event', async () => {
    // Reassign to Michael Oduor
    await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'Michael Oduor' });
    // Reassign back to Sarah Mwangi
    await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'Sarah Mwangi' });
    // Check audit events
    const auditRes = await request(app)
      .get('/api/audit-events?action=matter_reassigned')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    const events = auditRes.body.rows.filter(e => e.action === 'matter_reassigned')
    expect(events.length).toBeGreaterThanOrEqual(2);
    const matterEvent = events.find(e => e.entity_id === matterId);
    expect(matterEvent).toBeDefined();
    const meta = JSON.parse(matterEvent.metadata_json || '{}');
    expect(meta.oldAssignedTo).toBeDefined();
    expect(meta.newAssignedTo).toBeDefined();
  });

  test('10. Old advocate loses access after reassignment', async () => {
    // Ensure matter assigned to Michael Oduor
    await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'Michael Oduor' });
    // Sarah should no longer see this matter
    const sarahRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${advocateToken}`);
    const stillHasAccess = sarahRes.body.some(m => m.id === matterId);
    expect(stillHasAccess).toBe(false);
    // Reassign back for other tests
    await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'Sarah Mwangi' });
  });

  test('11. New advocate gains access after reassignment', async () => {
    // Login as Michael Oduor
    const michaelRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'michael.oduor@achokilaw.co.ke', password: 'password123' });
    expect(michaelRes.statusCode).toBe(200);
    const michaelToken = michaelRes.body.token;
    // Ensure matter assigned to Michael Oduor
    await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'Michael Oduor' });
    // Michael should see the matter
    const michaelMattersRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${michaelToken}`);
    const hasAccess = michaelMattersRes.body.some(m => m.id === matterId);
    expect(hasAccess).toBe(true);
    // Reassign back
    await request(app)
      .patch(`/api/matters/${matterId}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: 'Sarah Mwangi' });
  });

  test('12. Existing generic PATCH /api/matters/:id still works', async () => {
    const res = await request(app)
      .patch(`/api/matters/${matterId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ priority: 'High' });
    expect(res.statusCode).toBe(200);
    expect(res.body.priority).toBe('High');
    // Reset
    await request(app)
      .patch(`/api/matters/${matterId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ priority: 'Medium' });
  });
});
