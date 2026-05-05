const request = require('supertest');
const { app } = require('../server.js');

let clientToken;
let clientUser;
let adminToken;
let advocateToken;

beforeAll(async () => {
  const clientRes = await request(app)
    .post('/api/auth/client-login')
    .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
  clientToken = clientRes.body.token;
  clientUser = clientRes.body.user;

  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = adminRes.body.token;

  const advRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
  advocateToken = advRes.body.token;
});

describe('GET /api/client/dashboard', () => {
  test('Client can access dashboard', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  test('Response has all expected keys', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.body).toHaveProperty('client');
    expect(res.body).toHaveProperty('matters');
    expect(res.body).toHaveProperty('documents');
    expect(res.body).toHaveProperty('invoices');
    expect(res.body).toHaveProperty('notes');
    expect(res.body).toHaveProperty('appearances');
    expect(res.body).toHaveProperty('notices');
    expect(res.body).toHaveProperty('paymentProofs');
  });

  test('Response arrays are arrays', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(Array.isArray(res.body.matters)).toBe(true);
    expect(Array.isArray(res.body.documents)).toBe(true);
    expect(Array.isArray(res.body.invoices)).toBe(true);
    expect(Array.isArray(res.body.appearances)).toBe(true);
    expect(Array.isArray(res.body.notices)).toBe(true);
    expect(Array.isArray(res.body.paymentProofs)).toBe(true);
  });

  test('notes is an empty array', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.body.notes).toEqual([]);
  });

  test('Client matters are scoped', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    if (res.body.matters && res.body.matters.length > 0) {
      res.body.matters.forEach(matter => {
        expect(matter.clientId).toBe(clientUser.clientId);
      });
    }
  });

  test('Client invoices are scoped', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    if (res.body.invoices && res.body.invoices.length > 0) {
      res.body.invoices.forEach(invoice => {
        expect(invoice.clientId).toBe(clientUser.clientId);
      });
    }
  });

  test('Admin token cannot access client dashboard', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Client access required');
  });

  test('Advocate token cannot access client dashboard', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Client access required');
  });

  test('No token returns 401', async () => {
    const res = await request(app)
      .get('/api/client/dashboard');
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });
});
