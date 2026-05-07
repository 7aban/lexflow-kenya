const request = require('supertest');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');
const path = require('path');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');
const { hashPassword, genId } = require('../lib/passwords');

let adminToken;
let adminUserId;
let advocateToken;
let clientToken;
let testUserId;
let testUserEmail;

beforeAll(async () => {
  await dbReady;
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = adminRes.body.token;
  adminUserId = jwt.decode(adminToken).userId;

  const advRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
  advocateToken = advRes.body.token;

  const clientRes = await request(app)
    .post('/api/auth/client-login')
    .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
  clientToken = clientRes.body.token;
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
    if (testUserEmail) {
      await run('DELETE FROM users WHERE email=?', [testUserEmail]);
    }
  } finally {
    db.close();
  }
});

describe('R7a - GET /api/auth/users', () => {
  test('Admin can list active users by default', async () => {
    const res = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    res.body.forEach(u => {
      expect(u.isActive).not.toBe(false);
      expect(u.password).toBeUndefined();
      expect(u.tokenVersion).toBeUndefined();
    });
  });

  test('Admin can include inactive users with include_inactive=true', async () => {
    // First deactivate a user to test
    const users = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`);
    const target = users.body.find(u => u.id !== adminUserId && u.role !== 'admin');
    if (target) {
      await request(app)
        .patch(`/api/auth/users/${target.id}/toggle-active`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });
    }

    const res = await request(app)
      .get('/api/auth/users?include_inactive=true')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.some(u => u.isActive === false)).toBe(true);
  });

  test('Default user listing excludes inactive users', async () => {
    const res = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.every(u => u.isActive !== false)).toBe(true);
  });

  test('Non-admin cannot list users', async () => {
    const res = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);
  });
});

describe('R7a - User activation/deactivation', () => {
  beforeEach(async () => {
    // Create a test user for each test
    testUserEmail = `test.r7a.${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: testUserEmail, password: 'Str0ng!Passw0rd2026', fullName: 'Test R7a User', role: 'assistant' });
    testUserId = res.body.id;
  });

  afterEach(async () => {
    const db = new sqlite3.Database(config.DATABASE_PATH);
    await new Promise(resolve => {
      db.run('DELETE FROM users WHERE email LIKE ?', ['test.r7a.%@example.com'], () => {
        db.close();
        resolve();
      });
    });
    testUserId = null;
    testUserEmail = null;
  });

  test('Admin can deactivate a user', async () => {
    const res = await request(app)
      .patch(`/api/auth/users/${testUserId}/toggle-active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });
    expect(res.statusCode).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(res.body.password).toBeUndefined();
  });

  test('Deactivated user cannot login', async () => {
    await request(app)
      .patch(`/api/auth/users/${testUserId}/toggle-active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testUserEmail, password: 'Str0ng!Passw0rd2026' });
    expect(res.statusCode).toBe(401);
  });

  test('Admin can reactivate a user', async () => {
    await request(app)
      .patch(`/api/auth/users/${testUserId}/toggle-active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });

    const res = await request(app)
      .patch(`/api/auth/users/${testUserId}/toggle-active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.isActive).toBe(true);
  });

  test('Reactivated user can login', async () => {
    await request(app)
      .patch(`/api/auth/users/${testUserId}/toggle-active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });

    await request(app)
      .patch(`/api/auth/users/${testUserId}/toggle-active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: true });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testUserEmail, password: 'Str0ng!Passw0rd2026' });
    expect(res.statusCode).toBe(200);
  });

  test('Admin cannot deactivate self', async () => {
    const res = await request(app)
      .patch(`/api/auth/users/${adminUserId}/toggle-active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });
    expect(res.statusCode).toBe(400);
  });

  test('Non-admin cannot activate/deactivate users', async () => {
    const res = await request(app)
      .patch(`/api/auth/users/${testUserId}/toggle-active`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ isActive: false });
    expect(res.statusCode).toBe(403);
  });

  test('Cannot deactivate last active admin', async () => {
    // Create a new admin so we can test last-admin logic
    const newAdminEmail = `test.admin.${Date.now()}@example.com`;
    const regRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: newAdminEmail, password: 'Str0ng!Passw0rd2026', fullName: 'Test Admin', role: 'admin' });

    // Deactivate the new admin (should succeed - not last admin)
    await request(app)
      .patch(`/api/auth/users/${regRes.body.id}/toggle-active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });

    // Now try to deactivate the original admin - should fail (last active admin)
    const res = await request(app)
      .patch(`/api/auth/users/${adminUserId}/toggle-active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });
    expect(res.statusCode).toBe(400);

    // Cleanup
    const db = new sqlite3.Database(config.DATABASE_PATH);
    await new Promise(resolve => {
      db.run('DELETE FROM users WHERE email=?', [newAdminEmail], () => { db.close(); resolve(); });
    });
  });

  test('Activation/deactivation is audited', async () => {
    await request(app)
      .patch(`/api/auth/users/${testUserId}/toggle-active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });

    const auditRes = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.body.rows.some(e => e.action === 'user_deactivated')).toBe(true);
  });
});

describe('R7a - User role change', () => {
  beforeEach(async () => {
    testUserEmail = `test.r7a.role.${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: testUserEmail, password: 'Str0ng!Passw0rd2026', fullName: 'Test R7a Role User', role: 'assistant' });
    testUserId = res.body.id;
  });

  afterEach(async () => {
    const db = new sqlite3.Database(config.DATABASE_PATH);
    await new Promise(resolve => {
      db.run('DELETE FROM users WHERE email LIKE ?', ['test.r7a.role.%@example.com'], () => {
        db.close();
        resolve();
      });
    });
    testUserId = null;
    testUserEmail = null;
  });

  test('Admin can change user role', async () => {
    const res = await request(app)
      .patch(`/api/auth/users/${testUserId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'advocate' });
    expect(res.statusCode).toBe(200);
    expect(res.body.role).toBe('advocate');
    expect(res.body.password).toBeUndefined();
  });

  test('Invalid role is rejected', async () => {
    const res = await request(app)
      .patch(`/api/auth/users/${testUserId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'superadmin' });
    expect(res.statusCode).toBe(400);
  });

  test('Non-admin cannot change roles', async () => {
    const res = await request(app)
      .patch(`/api/auth/users/${testUserId}/role`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ role: 'advocate' });
    expect(res.statusCode).toBe(403);
  });

  test('Admin cannot change own role', async () => {
    const res = await request(app)
      .patch(`/api/auth/users/${adminUserId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'advocate' });
    expect(res.statusCode).toBe(400);
  });

  test('Cannot change last active admin away from admin', async () => {
    // Create a new admin so we can test last-admin logic
    const newAdminEmail = `test.admin2.${Date.now()}@example.com`;
    const regRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: newAdminEmail, password: 'Str0ng!Passw0rd2026', fullName: 'Test Admin 2', role: 'admin' });

    // Change new admin role (should succeed - not last admin)
    await request(app)
      .patch(`/api/auth/users/${regRes.body.id}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'advocate' });

    // Try to change original admin role - should fail (last active admin)
    const res = await request(app)
      .patch(`/api/auth/users/${adminUserId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'advocate' });
    expect(res.statusCode).toBe(400);

    // Cleanup
    const db = new sqlite3.Database(config.DATABASE_PATH);
    await new Promise(resolve => {
      db.run('DELETE FROM users WHERE email=?', [newAdminEmail], () => { db.close(); resolve(); });
    });
  });

  test('Role change is audited', async () => {
    await request(app)
      .patch(`/api/auth/users/${testUserId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'advocate' });

    const auditRes = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.body.rows.some(e => e.action === 'user_role_changed')).toBe(true);
  });
});

describe('R7a - Passwords not returned', () => {
  test('Passwords not in user list', async () => {
    const res = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`);
    res.body.forEach(u => {
      expect(u.password).toBeUndefined();
      expect(u.tokenVersion).toBeUndefined();
    });
  });

  test('Passwords not in role change response', async () => {
    const users = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`);
    const target = users.body.find(u => u.role === 'assistant');
    if (target) {
      const res = await request(app)
        .patch(`/api/auth/users/${target.id}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'advocate' });
      expect(res.body.password).toBeUndefined();
    }
  });

  test('Passwords not in toggle-active response', async () => {
    const users = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`);
    const target = users.body.find(u => u.role !== 'admin');
    if (target) {
      const res = await request(app)
        .patch(`/api/auth/users/${target.id}/toggle-active`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });
      expect(res.body.password).toBeUndefined();
    }
  });
});
