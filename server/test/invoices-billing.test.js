const request = require('supertest');
const { app } = require('../server.js');

describe('Invoice and Billing Access Control', () => {
  let adminToken;
  let advocateToken;
  let clientToken;
  let clientUser;

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
    clientUser = clientRes.body.user;
  });

  test('A. Admin can access invoices', async () => {
    const res = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('B. Advocate sees only invoices linked to assigned matters', async () => {
    const mattersRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(mattersRes.statusCode).toBe(200);
    const matterIds = mattersRes.body.map(m => m.id);
    expect(matterIds.length).toBeGreaterThan(0);

    const invoicesRes = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(invoicesRes.statusCode).toBe(200);
    expect(Array.isArray(invoicesRes.body)).toBe(true);
    expect(invoicesRes.body.length).toBeGreaterThan(0);

    invoicesRes.body.forEach(invoice => {
      expect(matterIds).toContain(invoice.matterId);
    });
  });

  test('C. Client sees only own invoices', async () => {
    const res = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    res.body.forEach(invoice => {
      expect(invoice.clientId).toBe(clientUser.clientId);
    });
  });

  test('D. Client dashboard invoices are scoped', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);

    if (res.body.invoices) {
      expect(Array.isArray(res.body.invoices)).toBe(true);
      if (res.body.invoices.length > 0) {
        res.body.invoices.forEach(invoice => {
          expect(invoice.clientId).toBe(clientUser.clientId);
        });
      }
    }
  });

  test('E. Client is blocked from mutating invoice routes', async () => {
    const invoicesRes = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(invoicesRes.statusCode).toBe(200);
    expect(invoicesRes.body.length).toBeGreaterThan(0);
    const invoiceId = invoicesRes.body[0].id;

    const generateRes = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ matterId: 'nonexistent' });
    expect(generateRes.statusCode).toBe(403);

    const patchRes = await request(app)
      .patch(`/api/invoices/${invoiceId}/status`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ status: 'Paid' });
    expect(patchRes.statusCode).toBe(403);

    const deleteRes = await request(app)
      .delete(`/api/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(deleteRes.statusCode).toBe(403);
  });

  test('F. Advocate cannot change invoice status', async () => {
    const invoicesRes = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(invoicesRes.statusCode).toBe(200);
    expect(invoicesRes.body.length).toBeGreaterThan(0);
    const invoiceId = invoicesRes.body[0].id;

    const res = await request(app)
      .patch(`/api/invoices/${invoiceId}/status`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ status: 'Paid' });
    expect(res.statusCode).toBe(403);
  });
});
