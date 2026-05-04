const request = require('supertest');
const { app } = require('../server.js');

let adminToken;
let advocateToken;
let clientToken;

beforeAll(async () => {
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = adminRes.body.token;

  const advRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
  advocateToken = advRes.body.token;

  const clientRes = await request(app)
    .post('/api/auth/client-login')
    .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
  clientToken = clientRes.body.token;
});

describe('Auth API', () => {
  test('POST /api/auth/login with correct credentials succeeds', () => {
    expect(adminToken).toBeDefined();
  });

  test('POST /api/auth/login with wrong password fails', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'wrongpassword' });
    expect(res.statusCode).toBe(401);
  });

  test('POST /api/auth/client-login rejects staff credentials', async () => {
    const res = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(res.statusCode).toBe(401);
  });

  test('GET /api/notifications without token returns 401', async () => {
    const res = await request(app)
      .get('/api/notifications');
    expect(res.statusCode).toBe(401);
  });
});

describe('Register validation', () => {
  test('missing email returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'password123', fullName: 'Test User' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('email, password and fullName are required');
  });

  test('missing password returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'test@example.com', fullName: 'Test User' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('email, password and fullName are required');
  });

  test('missing fullName returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'test@example.com', password: 'password123' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('email, password and fullName are required');
  });

  test('invalid role returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'test@example.com', password: 'password123', fullName: 'Test User', role: 'manager' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Invalid role');
  });

  test('client role without clientId returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'test@example.com', password: 'password123', fullName: 'Test User', role: 'client' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Client users must be linked to a client record');
  });
});

describe('Register auth gate', () => {
  test('no token returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: 'password123', fullName: 'Test User' });
    expect(res.statusCode).toBe(401);
  });

  test('advocate token returns 403', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ email: 'test@example.com', password: 'password123', fullName: 'Test User' });
    expect(res.statusCode).toBe(403);
  });
});

describe('Invitation validation', () => {
  test('missing email returns 400', async () => {
    const res = await request(app)
      .post('/api/invitations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('email is required');
  });
});

describe('Invitation auth gate', () => {
  test('no token returns 401', async () => {
    const res = await request(app)
      .post('/api/invitations')
      .send({ email: 'test@example.com' });
    expect(res.statusCode).toBe(401);
  });

  test('client token returns 403', async () => {
    const res = await request(app)
      .post('/api/invitations')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ email: 'test@example.com' });
    expect(res.statusCode).toBe(403);
  });
});
