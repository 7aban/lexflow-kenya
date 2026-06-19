const request = require('supertest');
const sqlite3 = require('sqlite3').verbose();
const { app } = require('../server.js');
const config = require('../lib/config');

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(config.DATABASE_PATH);
    db.get(sql, params, (err, row) => {
      db.close();
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function uploadPayload(name = 'response.pdf', content = 'client response') {
  return {
    name,
    mimeType: 'application/pdf',
    data: `data:application/pdf;base64,${Buffer.from(content).toString('base64')}`,
  };
}

describe('LOCAL-PILOT client request upload binding safety', () => {
  let clientToken;
  let clientUser;
  let otherClientToken;
  let adminToken;
  let matterId;

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

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    adminToken = adminRes.body.token;

    const mattersRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`);
    matterId = mattersRes.body.find(m => m.clientId === clientUser.clientId)?.id;
  });

  async function createDocumentRequest(title = 'Pilot upload binding request') {
    const res = await request(app)
      .post('/api/document-requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId, title });
    expect(res.statusCode).toBe(200);
    return res.body;
  }

  test('client can respond to own pending request and it is linked to the right request, matter, and client', async () => {
    const created = await createDocumentRequest('Own request response');

    const res = await request(app)
      .post(`/api/document-requests/${created.id}/respond`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send(uploadPayload('own-response.pdf'));

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fulfilled');
    expect(res.body.responseDocumentId).toBeDefined();
    expect(res.body.matterId).toBe(matterId);
    expect(res.body.clientId).toBe(clientUser.clientId);

    const row = await dbGet(
      `SELECT dr.id requestId, dr.status, dr.clientId requestClientId, dr.matterId requestMatterId, dr.responseDocumentId,
        d.id documentId, d.matterId documentMatterId, d.source, d.clientVisible
       FROM document_requests dr
       JOIN documents d ON d.id=dr.responseDocumentId
       WHERE dr.id=?`,
      [created.id],
    );
    expect(row.requestId).toBe(created.id);
    expect(row.status).toBe('fulfilled');
    expect(row.responseDocumentId).toBe(row.documentId);
    expect(row.requestClientId).toBe(clientUser.clientId);
    expect(row.requestMatterId).toBe(matterId);
    expect(row.documentMatterId).toBe(matterId);
    expect(row.source).toBe('client');
    expect(Number(row.clientVisible)).toBe(0);
  });

  test('two pending requests respond independently by request id', async () => {
    const first = await createDocumentRequest('First clicked request');
    const second = await createDocumentRequest('Second clicked request');

    const firstRes = await request(app)
      .post(`/api/document-requests/${first.id}/respond`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send(uploadPayload('first-response.pdf', 'first'));
    expect(firstRes.statusCode).toBe(200);

    let refreshedSecond = await dbGet('SELECT status, responseDocumentId FROM document_requests WHERE id=?', [second.id]);
    expect(refreshedSecond.status).toBe('pending');
    expect(refreshedSecond.responseDocumentId).toBeFalsy();

    const secondRes = await request(app)
      .post(`/api/document-requests/${second.id}/respond`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send(uploadPayload('second-response.pdf', 'second'));
    expect(secondRes.statusCode).toBe(200);

    const refreshedFirst = await dbGet('SELECT status, responseDocumentId FROM document_requests WHERE id=?', [first.id]);
    refreshedSecond = await dbGet('SELECT status, responseDocumentId FROM document_requests WHERE id=?', [second.id]);
    expect(refreshedFirst.status).toBe('fulfilled');
    expect(refreshedSecond.status).toBe('fulfilled');
    expect(refreshedFirst.responseDocumentId).not.toBe(refreshedSecond.responseDocumentId);
  });

  test('client cannot respond to another client request', async () => {
    const created = await createDocumentRequest('Wrong client blocked');

    const res = await request(app)
      .post(`/api/document-requests/${created.id}/respond`)
      .set('Authorization', `Bearer ${otherClientToken}`)
      .send(uploadPayload('wrong-client.pdf'));

    expect(res.statusCode).toBe(403);
  });

  test('oversized request-response upload is rejected with pilot message', async () => {
    const created = await createDocumentRequest('Oversized response');
    const originalLimit = config.UPLOAD_MAX_FILE_MB;
    config.UPLOAD_MAX_FILE_MB = 1;
    try {
      const oversized = Buffer.alloc((config.UPLOAD_MAX_FILE_MB * 1024 * 1024) + 1, 1).toString('base64');

      const res = await request(app)
        .post(`/api/document-requests/${created.id}/respond`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ name: 'oversized.pdf', mimeType: 'application/pdf', data: `data:application/pdf;base64,${oversized}` });

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Document upload is limited to 25 MB.');
    } finally {
      config.UPLOAD_MAX_FILE_MB = originalLimit;
    }
  });
});
