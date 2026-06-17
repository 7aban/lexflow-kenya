'use strict';

const request = require('supertest');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(30000);

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

describe('LOCAL-PILOT document workflow polish', () => {
  let admin;
  let advocate;
  let assistant;
  let matterId;

  const suffix = Date.now();

  beforeAll(async () => {
    await dbReady;

    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    admin = adminLogin.body;

    const advLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    advocate = advLogin.body;

    const asstLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' });
    assistant = asstLogin.body;

    const clientRes = await request(app)
      .post('/api/clients')
      .set(auth(admin.token))
      .send({ name: `LP Polish Client ${suffix}`, email: `lp.polish.${suffix}@example.com` });
    expect(clientRes.statusCode).toBe(200);

    const matterRes = await request(app)
      .post('/api/matters')
      .set(auth(admin.token))
      .send({ clientId: clientRes.body.id, title: `LP Polish Matter ${suffix}`, assignedTo: 'Sarah Mwangi' });
    expect(matterRes.statusCode).toBe(200);
    matterId = matterRes.body.id;
  });

  test('file between 25 MB and 34 MB is rejected with 400 (not 413)', async () => {
    const oversized = Buffer.alloc(config.UPLOAD_MAX_FILE_MB * 1024 * 1024 + 1, 'x');
    const data = oversized.toString('base64');
    const res = await request(app)
      .post(`/api/matters/${matterId}/documents`)
      .set(auth(admin.token))
      .send({ name: 'just-over-25mb.pdf', mimeType: 'application/pdf', data });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain(`${config.UPLOAD_MAX_FILE_MB} MB`);
  });

  test('file just under 25 MB uploads successfully', async () => {
    const valid = Buffer.alloc((config.UPLOAD_MAX_FILE_MB * 1024 * 1024) - 1, 'x');
    const data = valid.toString('base64');
    const res = await request(app)
      .post(`/api/matters/${matterId}/documents`)
      .set(auth(admin.token))
      .send({ name: 'just-under-25mb.pdf', mimeType: 'application/pdf', data });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
  });

  test('assistant cannot upload documents to matter', async () => {
    const res = await request(app)
      .post(`/api/matters/${matterId}/documents`)
      .set(auth(assistant.token))
      .send({ name: 'assistant-test.pdf', mimeType: 'application/pdf', data: 'ZHVtbXk=' });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate|admin/i);
  });

  test('advocate can upload documents to matter', async () => {
    const res = await request(app)
      .post(`/api/matters/${matterId}/documents`)
      .set(auth(advocate.token))
      .send({ name: 'advocate-test.pdf', mimeType: 'application/pdf', data: 'ZHVtbXk=' });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
  });
});
