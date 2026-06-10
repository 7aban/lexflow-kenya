// LOCAL-PILOT-FIX-8 — Restore Login OAuth Options
//
// 1. public login OAuth availability endpoint returns only safe booleans
// 2. with OAuth disabled/unconfigured, availability returns false values and does not 500
// 3. OAuth start route refuses cleanly when unconfigured, without crashing
// 4. email/password login still works
const request = require('supertest');
const { app } = require('../server.js');

describe('LOCAL-PILOT-FIX-8 Login OAuth availability', () => {
  test('GET /api/auth/oauth/availability returns only booleans and never 500', async () => {
    const res = await request(app).get('/api/auth/oauth/availability');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('google');
    expect(res.body).toHaveProperty('microsoft');
    expect(typeof res.body.google).toBe('boolean');
    expect(typeof res.body.microsoft).toBe('boolean');
  });

  test('GET /api/auth/oauth/availability does not expose secrets', async () => {
    const res = await request(app).get('/api/auth/oauth/availability');
    expect(res.body).not.toHaveProperty('clientId');
    expect(res.body).not.toHaveProperty('clientSecret');
    expect(res.body).not.toHaveProperty('stateSecret');
    expect(res.body).not.toHaveProperty('GOOGLE_CLIENT_ID');
    expect(res.body).not.toHaveProperty('MICROSOFT_CLIENT_ID');
  });

  test('OAuth start route returns 503 (not 500) when unconfigured — google', async () => {
    const res = await request(app).get('/api/auth/oauth/google/start');
    expect([503]).toContain(res.statusCode);
  });

  test('OAuth start route returns 503 (not 500) when unconfigured — microsoft', async () => {
    const res = await request(app).get('/api/auth/oauth/microsoft/start');
    expect([503]).toContain(res.statusCode);
  });

  test('email/password login still works', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  test('email/password client login still works', async () => {
    const res = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('token');
  });
});
