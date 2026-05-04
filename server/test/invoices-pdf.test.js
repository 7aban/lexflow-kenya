const request = require('supertest');
const { app } = require('../server.js');

describe('Invoice PDF Access Control', () => {
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

  test('A. Client can download own invoice PDF', async () => {
    const invoicesRes = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(invoicesRes.statusCode).toBe(200);
    expect(invoicesRes.body.length).toBeGreaterThan(0);
    const invoiceId = invoicesRes.body[0].id;

    const pdfRes = await request(app)
      .get(`/api/invoices/${invoiceId}/pdf`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(pdfRes.statusCode).toBe(200);
    expect(pdfRes.headers['content-type']).toMatch(/^application\/pdf/);
  });

  test('B. Client cannot download another client\'s invoice PDF', async () => {
    const adminInvoicesRes = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminInvoicesRes.statusCode).toBe(200);
    expect(adminInvoicesRes.body.length).toBeGreaterThan(0);

    const otherInvoice = adminInvoicesRes.body.find(inv => inv.clientId !== clientUser.clientId);
    expect(otherInvoice).toBeDefined();

    const pdfRes = await request(app)
      .get(`/api/invoices/${otherInvoice.id}/pdf`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(pdfRes.statusCode).toBe(403);
  });

  test('C. Advocate can download invoice PDF for assigned matter', async () => {
    const invoicesRes = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(invoicesRes.statusCode).toBe(200);
    expect(invoicesRes.body.length).toBeGreaterThan(0);
    const invoiceId = invoicesRes.body[0].id;

    const pdfRes = await request(app)
      .get(`/api/invoices/${invoiceId}/pdf`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(pdfRes.statusCode).toBe(200);
    expect(pdfRes.headers['content-type']).toMatch(/^application\/pdf/);
  });

  test('D. Unauthorized request is rejected', async () => {
    const invoicesRes = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(invoicesRes.statusCode).toBe(200);
    expect(invoicesRes.body.length).toBeGreaterThan(0);
    const invoiceId = invoicesRes.body[0].id;

    const pdfRes = await request(app)
      .get(`/api/invoices/${invoiceId}/pdf`);
    expect(pdfRes.statusCode).toBe(401);
  });

  test('E. Nonexistent invoice returns 404', async () => {
    const pdfRes = await request(app)
      .get('/api/invoices/DOES-NOT-EXIST/pdf')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(pdfRes.statusCode).toBe(404);
  });
});
