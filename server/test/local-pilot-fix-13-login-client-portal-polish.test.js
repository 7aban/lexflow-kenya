// LOCAL-PILOT-FIX-13 — Login hygiene + client portal polish.
//
// This suite re-asserts that auth endpoints still behave correctly after
// frontend-only fixes for password-change logout hygiene and client portal
// empty-state polish. No backend routes were changed.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app } = require('../server.js');

const STAFF_EMAIL = 'admin@lexflow.co.ke';
const STAFF_PASS = 'password123';
const CLIENT_EMAIL = 'margaret.wairimu@example.co.ke';
const CLIENT_PASS = 'password123';
const NEW_PASS = 'LP-Fix13!TestPass1';

let staffToken;
let clientToken;
let clientUserId;

const db = new sqlite3.Database(config.DATABASE_PATH);
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, err => err ? reject(err) : resolve());
});

beforeAll(async () => {
  const staffRes = await request(app)
    .post('/api/auth/login')
    .send({ email: STAFF_EMAIL, password: STAFF_PASS });
  staffToken = staffRes.body.token;
  expect(staffToken).toBeDefined();

  const clientRes = await request(app)
    .post('/api/auth/client-login')
    .send({ email: CLIENT_EMAIL, password: CLIENT_PASS });
  clientToken = clientRes.body.token;
  expect(clientToken).toBeDefined();
  clientUserId = jwt.decode(clientToken).userId;
});

afterAll(async () => {
  // Restore staff password
  const { hashPassword } = require('../lib/passwords');
  const staffHash = await hashPassword(STAFF_PASS);
  await dbRun("UPDATE users SET password=?, tokenVersion=1 WHERE email=?", [staffHash, STAFF_EMAIL]);
  // Restore client password
  const clientHash = await hashPassword(CLIENT_PASS);
  await dbRun("UPDATE users SET password=?, tokenVersion=1 WHERE email=?", [clientHash, CLIENT_EMAIL]);
  db.close();
});

describe('Auth endpoints — login hygiene regression checks', () => {

  test('staff login succeeds', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: STAFF_EMAIL, password: STAFF_PASS });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  test('client login succeeds', async () => {
    const res = await request(app)
      .post('/api/auth/client-login')
      .send({ email: CLIENT_EMAIL, password: CLIENT_PASS });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  test('staff password change returns 200', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ currentPassword: STAFF_PASS, newPassword: NEW_PASS });
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Password changed successfully');
  });

  test('staff password change increments tokenVersion', async () => {
    const user = await dbGet('SELECT tokenVersion FROM users WHERE email=?', [STAFF_EMAIL]);
    expect(user.tokenVersion).toBe(2);
  });

  test('old staff token is rejected after password change (401)', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.statusCode).toBe(401);
  });

  test('staff logs in with new password after change', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: STAFF_EMAIL, password: NEW_PASS });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    staffToken = res.body.token;
  });

  test('client password change returns 200', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ currentPassword: CLIENT_PASS, newPassword: NEW_PASS });
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Password changed successfully');
  });

  test('client password change increments tokenVersion', async () => {
    const user = await dbGet('SELECT tokenVersion FROM users WHERE email=?', [CLIENT_EMAIL]);
    expect(user.tokenVersion).toBe(2);
  });

  test('old client token is rejected after password change (401)', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(401);
  });

  test('client logs in with new password after change', async () => {
    const res = await request(app)
      .post('/api/auth/client-login')
      .send({ email: CLIENT_EMAIL, password: NEW_PASS });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    clientToken = res.body.token;
  });

  test('client dashboard endpoint returns 200 with new token', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('matters');
    expect(res.body).toHaveProperty('documents');
    expect(res.body).toHaveProperty('invoices');
    expect(res.body).toHaveProperty('notices');
    expect(res.body).toHaveProperty('appearances');
  });

});

describe('Login — password is not returned by any auth endpoint', () => {

  test('login response does not contain password field', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: STAFF_EMAIL, password: NEW_PASS });
    expect(res.body).not.toHaveProperty('password');
  });

  test('client-login response does not contain password field', async () => {
    const res = await request(app)
      .post('/api/auth/client-login')
      .send({ email: CLIENT_EMAIL, password: NEW_PASS });
    expect(res.body).not.toHaveProperty('password');
  });

  test('auth/me response does not contain password field', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.body).not.toHaveProperty('password');
  });

});

describe('Client portal — dashboard endpoint shape', () => {

  test('dashboard.matters is an array', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(Array.isArray(res.body.matters)).toBe(true);
  });

  test('dashboard.documents is an array', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(Array.isArray(res.body.documents)).toBe(true);
  });

  test('dashboard.invoices is an array', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(Array.isArray(res.body.invoices)).toBe(true);
  });

  test('dashboard.notices is an array', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(Array.isArray(res.body.notices)).toBe(true);
  });

  test('dashboard.appearances is an array', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(Array.isArray(res.body.appearances)).toBe(true);
  });

});

describe('Blank password is rejected by login endpoints', () => {

  test('staff login with empty password returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: STAFF_EMAIL, password: '' });
    expect(res.statusCode).toBe(400);
  });

  test('client login with empty password returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/client-login')
      .send({ email: CLIENT_EMAIL, password: '' });
    expect(res.statusCode).toBe(400);
  });

});
