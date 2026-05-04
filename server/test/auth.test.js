const request = require('supertest');
const { app } = require('../server.js');

describe('Auth API', () => {
  test('POST /api/auth/login with correct credentials succeeds', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe('admin');
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
