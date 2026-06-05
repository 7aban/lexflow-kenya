const request = require('supertest');
const { app } = require('../server.js');

describe('PRODUCT-20C Document Requests', () => {
  let clientToken;
  let clientUser;
  let otherClientToken;
  let advocateToken;
  let adminToken;
  let assistantToken;
  let matterId;
  let requestId;

  beforeAll(async () => {
    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    clientToken = clientRes.body.token;
    clientUser = clientRes.body.user;

    const otherRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'grace.njeri@example.com', password: 'password123' });
    otherClientToken = otherRes.body.token;

    const advRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    advocateToken = advRes.body.token;

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    adminToken = adminRes.body.token;

    const assistantRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' });
    assistantToken = assistantRes.body.token;

    const mattersRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`);
    const clientMatters = mattersRes.body.filter(m => m.clientId === clientUser.clientId);
    matterId = clientMatters[0]?.id;
  });

  test('1. Staff can create a document request for an accessible matter', async () => {
    const res = await request(app)
      .post('/api/document-requests')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ matterId, title: 'Signed Affidavit', description: 'Please upload a signed affidavit' });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.title).toBe('Signed Affidavit');
    expect(res.body.description).toBe('Please upload a signed affidavit');
    expect(res.body.status).toBe('pending');
    expect(res.body.matterId).toBe(matterId);
    expect(res.body.clientId).toBe(clientUser.clientId);
    requestId = res.body.id;
  });

  test('2. Client can see their own pending requests', async () => {
    const res = await request(app)
      .get('/api/client/document-requests')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find(r => r.id === requestId);
    expect(found).toBeDefined();
    expect(found.status).toBe('pending');
  });

  test('3. Wrong client cannot see or respond to another client request', async () => {
    const listRes = await request(app)
      .get('/api/client/document-requests')
      .set('Authorization', `Bearer ${otherClientToken}`);
    expect(listRes.statusCode).toBe(200);
    const found = listRes.body.find(r => r.id === requestId);
    expect(found).toBeUndefined();

    const respondRes = await request(app)
      .post(`/api/document-requests/${requestId}/respond`)
      .set('Authorization', `Bearer ${otherClientToken}`)
      .send({ name: 'test.pdf', mimeType: 'application/pdf', data: 'data:application/pdf;base64,dGVzdA==' });
    expect(respondRes.statusCode).toBe(403);
  });

  test('4. Client responds with an uploaded document and request becomes fulfilled', async () => {
    const res = await request(app)
      .post(`/api/document-requests/${requestId}/respond`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ name: 'signed-affidavit.pdf', mimeType: 'application/pdf', data: 'data:application/pdf;base64,dGVzdCByZXNwb25zZQ==' });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fulfilled');
    expect(res.body.responseDocumentId).toBeDefined();
    expect(res.body.respondedAt).toBeDefined();
    expect(res.body.responseDocument).toBeDefined();
    expect(res.body.responseDocument.displayName).toBe('signed-affidavit.pdf');
  });

  test('5. Staff can cancel a pending request', async () => {
    const createRes = await request(app)
      .post('/api/document-requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId, title: 'Cancel Test' });
    expect(createRes.statusCode).toBe(200);
    const cancelId = createRes.body.id;

    const cancelRes = await request(app)
      .patch(`/api/document-requests/${cancelId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'cancelled' });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.body.status).toBe('cancelled');
    expect(cancelRes.body.cancelledAt).toBeDefined();
    expect(cancelRes.body.cancelledBy).toBeDefined();
  });

  test('6. Cancelled request cannot be fulfilled', async () => {
    const createRes = await request(app)
      .post('/api/document-requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId, title: 'Cancel then respond' });
    expect(createRes.statusCode).toBe(200);
    const cancelId = createRes.body.id;

    await request(app)
      .patch(`/api/document-requests/${cancelId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'cancelled' });

    const respondRes = await request(app)
      .post(`/api/document-requests/${cancelId}/respond`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ name: 'test.pdf', mimeType: 'application/pdf', data: 'data:application/pdf;base64,dGVzdA==' });
    expect(respondRes.statusCode).toBe(400);
    expect(respondRes.body.error).toMatch(/not pending/i);
  });

  test('7. Invalid MIME type is rejected consistently with normal document upload', async () => {
    const createRes = await request(app)
      .post('/api/document-requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId, title: 'MIME test' });
    expect(createRes.statusCode).toBe(200);
    const mimeId = createRes.body.id;

    const res = await request(app)
      .post(`/api/document-requests/${mimeId}/respond`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ name: 'test.txt', mimeType: 'text/plain', data: 'data:text/plain;base64,dGVzdA==' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf, word and image/i);
  });

  test('8. Staff GET /api/document-requests returns requests for a matter', async () => {
    const res = await request(app)
      .get(`/api/document-requests?matterId=${matterId}`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const fulfilled = res.body.find(r => r.status === 'fulfilled' && r.responseDocumentId);
    if (fulfilled) {
      expect(fulfilled.responseDocumentName).toBeDefined();
      expect(fulfilled.responseDocumentMimeType).toBeDefined();
      expect(fulfilled.responseDocumentSize).toBeDefined();
    }
  });

  test('9. Assistant can create document requests', async () => {
    const res = await request(app)
      .post('/api/document-requests')
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ matterId, title: 'Identity Document Copy' });
    expect(res.statusCode).toBe(200);
    expect(res.body.title).toBe('Identity Document Copy');
    expect(res.body.status).toBe('pending');
  });

  test('10. Unauthorized client cannot access staff endpoint', async () => {
    const res = await request(app)
      .get('/api/document-requests')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('11. Creating request without matterId fails', async () => {
    const res = await request(app)
      .post('/api/document-requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'No matter' });
    expect(res.statusCode).toBe(400);
  });

  test('12. Creating request without title fails', async () => {
    const res = await request(app)
      .post('/api/document-requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId, title: '' });
    expect(res.statusCode).toBe(400);
  });

  test('13. Staff can list all document requests without matterId filter', async () => {
    const res = await request(app)
      .get('/api/document-requests')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });
});
