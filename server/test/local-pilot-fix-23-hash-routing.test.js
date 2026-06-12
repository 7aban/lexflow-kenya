const request = require('supertest');
const { app, dbReady } = require('../server.js');

describe('LOCAL-PILOT-FIX-23 hash routing access foundations', () => {
  let adminToken;
  let clientToken;
  let clientUser;
  let matterId;

  beforeAll(async () => {
    await dbReady;

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
    clientUser = clientRes.body.user;

    const mattersRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(mattersRes.statusCode).toBe(200);
    expect(Array.isArray(mattersRes.body)).toBe(true);
    matterId = mattersRes.body[0]?.id;
  });

  test('staff can fetch matters needed for deep-link restoration', async () => {
    const res = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('client dashboard remains scoped to the linked client', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.client?.id).toBe(clientUser.clientId);
    for (const matter of res.body.matters || []) expect(matter.clientId).toBe(clientUser.clientId);
    for (const invoice of res.body.invoices || []) expect(invoice.clientId).toBe(clientUser.clientId);
  });

  test('client cannot access staff-only matter work metadata route', async () => {
    expect(matterId).toBeTruthy();

    const res = await request(app)
      .get(`/api/matters/${matterId}/work-metadata-links`)
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Staff access required');
  });

  test('staff-only matter routes still require authentication', async () => {
    expect(matterId).toBeTruthy();

    const res = await request(app)
      .get(`/api/matters/${matterId}/work-metadata-links`);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });
});
