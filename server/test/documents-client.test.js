const request = require('supertest');
const { app } = require('../server.js');

describe('Document and Client Portal Visibility', () => {
  let clientToken;
  let clientUser;
  let advocateToken;
  let adminToken;

  beforeAll(async () => {
    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    clientToken = clientRes.body.token;
    clientUser = clientRes.body.user;

    const advRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    advocateToken = advRes.body.token;

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    adminToken = adminRes.body.token;
  });

  test('A. Client login succeeds with correct role', () => {
    expect(clientToken).toBeDefined();
    expect(clientUser.role).toBe('client');
  });

  test('B. Client dashboard returns only that client data', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);

    const { client, matters, documents, invoices, appearances, notices } = res.body;

    expect(client).toBeDefined();
    expect(client.id).toBe(clientUser.clientId);

    expect(Array.isArray(matters)).toBe(true);
    matters.forEach(matter => {
      expect(matter.clientId).toBe(clientUser.clientId);
    });

    expect(Array.isArray(documents)).toBe(true);
    documents.forEach(doc => {
      expect(doc.id).toBeDefined();
      const matter = matters.find(m => m.id === doc.matterId);
      expect(matter).toBeDefined();
    });

    expect(Array.isArray(invoices)).toBe(true);
    invoices.forEach(inv => {
      const matter = matters.find(m => m.id === inv.matterId);
      expect(matter).toBeDefined();
    });
  });

  test('C. Client cannot access staff-only /api/search route', async () => {
    const res = await request(app)
      .get('/api/search?q=test')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('C2. Client cannot access admin-only /api/auth/users route', async () => {
    const res = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('D. Client document visibility on matter documents', async () => {
    const mattersRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(mattersRes.statusCode).toBe(200);
    expect(Array.isArray(mattersRes.body)).toBe(true);

    if (mattersRes.body.length === 0) return;

    const matter = mattersRes.body[0];
    const docsRes = await request(app)
      .get(`/api/matters/${matter.id}/documents`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(docsRes.statusCode).toBe(200);
    expect(Array.isArray(docsRes.body)).toBe(true);

    docsRes.body.forEach(doc => {
      expect(doc.id).toBeDefined();
      expect(doc.displayName || doc.name).toBeDefined();
      expect(doc.sharedBy).toBeDefined();
    });
  });

  test('E. Staff can access matter documents', async () => {
    const mattersRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(mattersRes.statusCode).toBe(200);
    expect(Array.isArray(mattersRes.body)).toBe(true);
    expect(mattersRes.body.length).toBeGreaterThan(0);

    const matter = mattersRes.body.find(m => m.assignedTo === 'Sarah Mwangi') || mattersRes.body[0];
    const docsRes = await request(app)
      .get(`/api/matters/${matter.id}/documents`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(docsRes.statusCode).toBe(200);
    expect(Array.isArray(docsRes.body)).toBe(true);

    if (docsRes.body.length > 0) {
      const doc = docsRes.body[0];
      expect(doc.source).toBeDefined();
      expect(doc.clientVisible).toBeDefined();
    }
  });

  test('F. Case notes are not exposed to clients', async () => {
    const mattersRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(mattersRes.statusCode).toBe(200);

    if (mattersRes.body.length === 0) return;

    const matter = mattersRes.body[0];
    const notesRes = await request(app)
      .get(`/api/matters/${matter.id}/notes`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(notesRes.statusCode).toBe(200);
    expect(Array.isArray(notesRes.body)).toBe(true);
    expect(notesRes.body).toEqual([]);
  });
});
