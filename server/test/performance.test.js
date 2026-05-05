const request = require('supertest');
const { app } = require('../server.js');

let adminToken;
let advocateToken;
let clientToken;
let testUserId;

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

  const listRes = await request(app)
    .get('/api/performance/advocates?refresh=1')
    .set('Authorization', `Bearer ${adminToken}`);
  if (listRes.body.length > 0) {
    testUserId = listRes.body[0].userId;
  }
});

describe('GET /api/performance/advocates', () => {
  test('Admin can list advocate performance', async () => {
    const res = await request(app)
      .get('/api/performance/advocates?refresh=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('List response includes expected keys', async () => {
    const res = await request(app)
      .get('/api/performance/advocates?refresh=1')
      .set('Authorization', `Bearer ${adminToken}`);
    const firstRow = res.body[0];
    expect(firstRow).toHaveProperty('userId');
    expect(firstRow).toHaveProperty('fullName');
    expect(firstRow).toHaveProperty('activeMatters');
    expect(firstRow).toHaveProperty('totalMatters');
    expect(firstRow).toHaveProperty('completedTasks');
    expect(firstRow).toHaveProperty('pendingTasks');
    expect(firstRow).toHaveProperty('overdueTasks');
    expect(firstRow).toHaveProperty('totalHours');
    expect(firstRow).toHaveProperty('billedAmount');
    expect(firstRow).toHaveProperty('invoicesGenerated');
    expect(firstRow).toHaveProperty('courtAppearances');
    expect(firstRow).toHaveProperty('thisMonthHours');
    expect(firstRow).toHaveProperty('thisMonthRevenue');
    expect(firstRow).toHaveProperty('last7Hours');
  });
});

describe('GET /api/performance/advocates/:userId', () => {
  test('Admin can get one advocate detail by userId', async () => {
    expect(testUserId).toBeDefined();
    const res = await request(app)
      .get(`/api/performance/advocates/${testUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.userId).toBe(testUserId);
  });

  test('Detail response shape is correct', async () => {
    expect(testUserId).toBeDefined();
    const res = await request(app)
      .get(`/api/performance/advocates/${testUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(Array.isArray(res.body.activeMatterList)).toBe(true);
    expect(Array.isArray(res.body.monthlyBreakdown)).toBe(true);
    expect(res.body.monthlyBreakdown.length).toBe(6);
    if (res.body.monthlyBreakdown.length > 0) {
      const firstMonth = res.body.monthlyBreakdown[0];
      expect(firstMonth).toHaveProperty('month');
      expect(firstMonth).toHaveProperty('hours');
      expect(firstMonth).toHaveProperty('revenue');
    }
    expect(Array.isArray(res.body.recentTimeEntries)).toBe(true);
  });

  test('Unknown advocate userId returns 404', async () => {
    const res = await request(app)
      .get('/api/performance/advocates/DOES-NOT-EXIST')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('Advocate not found');
  });
});

describe('Access control', () => {
  test('Advocate token cannot access list', async () => {
    const res = await request(app)
      .get('/api/performance/advocates')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('Advocate token cannot access detail', async () => {
    const res = await request(app)
      .get('/api/performance/advocates/anything')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('Client token cannot access list', async () => {
    const res = await request(app)
      .get('/api/performance/advocates')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('Client token cannot access detail', async () => {
    const res = await request(app)
      .get('/api/performance/advocates/anything')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('No token returns 401 on list', async () => {
    const res = await request(app)
      .get('/api/performance/advocates');
    expect(res.statusCode).toBe(401);
  });

  test('No token returns 401 on detail', async () => {
    const res = await request(app)
      .get('/api/performance/advocates/anything');
    expect(res.statusCode).toBe(401);
  });
});
