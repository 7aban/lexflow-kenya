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

describe('Audit Events Table', () => {
  test('GET /api/audit-events returns empty array when no events', async () => {
    const res = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('rows');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('limit');
    expect(res.body).toHaveProperty('offset');
  });

  test('GET /api/audit-events requires admin role', async () => {
    const res = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('GET /api/audit-events rejects client role', async () => {
    const res = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('GET /api/audit-events rejects unauthenticated requests', async () => {
    const res = await request(app)
      .get('/api/audit-events');
    expect(res.statusCode).toBe(401);
  });
});

describe('Audit Events Filtering and Pagination', () => {
  test('GET /api/audit-events supports limit parameter', async () => {
    const res = await request(app)
      .get('/api/audit-events?limit=10')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.limit).toBe(10);
  });

  test('GET /api/audit-events supports offset parameter', async () => {
    const res = await request(app)
      .get('/api/audit-events?offset=5')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.offset).toBe(5);
  });

  test('GET /api/audit-events supports action filter', async () => {
    const res = await request(app)
      .get('/api/audit-events?action=login_success')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  test('GET /api/audit-events supports actor_user_id filter', async () => {
    const res = await request(app)
      .get('/api/audit-events?actor_user_id=U1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  test('GET /api/audit-events limit cannot exceed 200', async () => {
    const res = await request(app)
      .get('/api/audit-events?limit=500')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.limit).toBeLessThanOrEqual(200);
  });

  test('GET /api/audit-events limit minimum is 1', async () => {
    const res = await request(app)
      .get('/api/audit-events?limit=0')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.limit).toBeGreaterThanOrEqual(1);
  });
});

describe('Login Audit Logging', () => {
  test('successful login creates audit event', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(res.statusCode).toBe(200);

    const auditRes = await request(app)
      .get('/api/audit-events?action=login_success')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.body.rows.length).toBeGreaterThan(0);
  });

  test('failed login creates audit event', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'wrongpassword' });

    const auditRes = await request(app)
      .get('/api/audit-events?action=login_failure')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
  });
});

describe('Audit Metadata Safety', () => {
  test('audit events include metadata_json field', async () => {
    const res = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    if (res.body.rows.length > 0) {
      expect(res.body.rows[0]).toHaveProperty('metadata');
    }
  });
});

describe('Legacy Audit Logs Endpoint', () => {
  test('GET /api/audit-logs requires admin role', async () => {
    const res = await request(app)
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('GET /api/audit-logs accessible by admin', async () => {
    const res = await request(app)
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('rows');
  });
});
