const request = require('supertest');
const { app } = require('../server.js');

describe('LOCAL-PILOT-FIX-19 deadline route baseline', () => {
  let adminToken;
  let clientToken;
  let createdDeadlineId;

  beforeAll(async () => {
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;

    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(clientRes.statusCode).toBe(200);
    clientToken = clientRes.body.token;
  });

  afterAll(async () => {
    if (createdDeadlineId) {
      await request(app)
        .delete(`/api/deadlines/${createdDeadlineId}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }
  });

  test('staff can list unified court and deadline data', async () => {
    const res = await request(app)
      .get('/api/deadlines')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(row => row.type === 'Court Date' && row.source === 'appearance')).toBe(true);
  });

  test('admin can create a custom deadline entry', async () => {
    const res = await request(app)
      .post('/api/deadlines')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'FIX-19 route preservation deadline',
        type: 'internal',
        dueDate: '2026-06-30',
        owner: 'Admin',
        notes: 'Created by FIX-19 route baseline test',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeTruthy();
    expect(res.body.title).toBe('FIX-19 route preservation deadline');
    createdDeadlineId = res.body.id;
  });

  test('deadline routes remain staff-only', async () => {
    const unauthenticated = await request(app).get('/api/deadlines');
    expect(unauthenticated.statusCode).toBe(401);

    const client = await request(app)
      .get('/api/deadlines')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(client.statusCode).toBe(403);
  });
});
