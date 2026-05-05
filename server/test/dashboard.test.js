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

describe('GET /api/dashboard', () => {
  test('Admin can access dashboard', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  test('Advocate can access dashboard', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  test('Dashboard response includes required keys', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body).toHaveProperty('activeMattersCount');
    expect(res.body).toHaveProperty('monthHours');
    expect(res.body).toHaveProperty('monthRevenue');
    expect(res.body).toHaveProperty('overdueTaskCount');
    expect(res.body).toHaveProperty('upcomingEvents');
    expect(typeof res.body.activeMattersCount).toBe('number');
    expect(typeof res.body.monthHours).toBe('number');
    expect(typeof res.body.monthRevenue).toBe('number');
    expect(typeof res.body.overdueTaskCount).toBe('number');
  });

  test('upcomingEvents is an array', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(Array.isArray(res.body.upcomingEvents)).toBe(true);
  });

  test('Client token cannot access dashboard', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Staff access required');
  });

  test('No token returns 401', async () => {
    const res = await request(app)
      .get('/api/dashboard');
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });
});
