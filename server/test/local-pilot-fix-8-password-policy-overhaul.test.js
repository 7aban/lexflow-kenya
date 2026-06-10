// AUTH-PASSWORD-1 — product-wide password policy overhaul.
// The only blocking rule: password must be a non-empty, non-whitespace string.
const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app } = require('../server.js');

const db = new sqlite3.Database(config.DATABASE_PATH);
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});

let adminToken;
let advocateToken;

beforeAll(async () => {
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = adminRes.body.token;

  const advRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
  advocateToken = advRes.body.token;
});

afterAll(async () => {
  // Restore seeded passwords so other test suites are not affected
  const { hashPassword } = require('../lib/passwords');
  const defaultHash = await hashPassword('password123');
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, err => err ? reject(err) : resolve());
  });
  await run("UPDATE users SET password=?, tokenVersion=1 WHERE email=?", [defaultHash, 'sarah.mwangi@achokilaw.co.ke']);
  await run("UPDATE users SET password=?, tokenVersion=1 WHERE email=?", [defaultHash, 'admin@lexflow.co.ke']);
  db.close();
});

describe('AUTH-PASSWORD-1: change password accepts simple passwords', () => {

  test('change password accepts laban', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ currentPassword: 'password123', newPassword: 'laban' });
    expect(res.statusCode).toBe(200);
  });

  test('change password accepts x', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'laban' });
    expect(loginRes.statusCode).toBe(200);
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ currentPassword: 'laban', newPassword: 'x' });
    expect(res.statusCode).toBe(200);
  });

  test('change password accepts letters-only passwords', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'x' });
    expect(loginRes.statusCode).toBe(200);
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ currentPassword: 'x', newPassword: 'abcdef' });
    expect(res.statusCode).toBe(200);
  });

  test('change password accepts numbers-only passwords', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'abcdef' });
    expect(loginRes.statusCode).toBe(200);
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ currentPassword: 'abcdef', newPassword: '12345' });
    expect(res.statusCode).toBe(200);
  });

  test('change password accepts generated-looking passwords with symbols', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: '12345' });
    expect(loginRes.statusCode).toBe(200);
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ currentPassword: '12345', newPassword: 'Tr0ub4dor&X9q' });
    expect(res.statusCode).toBe(200);
  });

  test('change password rejects empty string', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'Tr0ub4dor&X9q' });
    expect(loginRes.statusCode).toBe(200);
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ currentPassword: 'Tr0ub4dor&X9q', newPassword: '' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('currentPassword and newPassword are required');
  });

  test('change password rejects whitespace-only string', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'Tr0ub4dor&X9q' });
    expect(loginRes.statusCode).toBe(200);
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ currentPassword: 'Tr0ub4dor&X9q', newPassword: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Password is required');
  });

  test('old password fails after successful change', async () => {
    // The last change rekeyed from 12345 to Tr0ub4dor&X9q
    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: '12345' });
    expect(oldLogin.statusCode).toBe(401);
  });

  test('new simple password works after successful change', async () => {
    const freshLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'Tr0ub4dor&X9q' });
    expect(freshLogin.statusCode).toBe(200);
    expect(freshLogin.body).toHaveProperty('token');
  });

  test('password hash is not stored as plaintext', async () => {
    const user = await dbGet('SELECT password FROM users WHERE email=?', ['sarah.mwangi@achokilaw.co.ke']);
    expect(user.password).not.toBe('Tr0ub4dor&X9q');
    expect(user.password).not.toBe('12345');
    expect(user.password).not.toBe('abcdef');
    expect(user.password).not.toBe('x');
    expect(user.password).not.toBe('laban');
    expect(user.password).toMatch(/^\$2[aby]\$/);
  });

  test('auth/access-control is intact — invalid email rejected', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nonexistent@test.com', password: 'anything' });
    expect(res.statusCode).toBe(401);
  });

  test('auth/access-control is intact — wrong password rejected', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'wrongpassword' });
    expect(res.statusCode).toBe(401);
  });

  test('admin can still access admin-only endpoint', async () => {
    const res = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
