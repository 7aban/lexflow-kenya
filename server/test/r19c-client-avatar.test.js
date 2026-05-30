'use strict';

const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app, dbReady } = require('../server.js');

const TINY_PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const TINY_PNG_BASE64 = TINY_PNG_DATA_URI.split(',')[1];
const TINY_PNG_BUFFER = Buffer.from(TINY_PNG_BASE64, 'base64');

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function dbGet(sql, params = []) {
  const db = new sqlite3.Database(path.join(__dirname, '..', 'lawfirm.db'));
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      db.close();
      err ? reject(err) : resolve(row);
    });
  });
}

async function latestAuditForEntity(action, entityId) {
  return dbGet(
    'SELECT * FROM audit_events WHERE action=? AND entity_id=? ORDER BY timestamp DESC LIMIT 1',
    [action, entityId],
  );
}

function uploadMyAvatar(token, contentType = 'image/png', buffer = TINY_PNG_BUFFER) {
  const ext = contentType.split('/').pop() || 'bin';
  return request(app)
    .post('/api/auth/me/avatar')
    .set(auth(token))
    .attach('avatar', buffer, { filename: `avatar.${ext}`, contentType });
}

function uploadClientAvatar(token, clientId, contentType = 'image/png', buffer = TINY_PNG_BUFFER) {
  const ext = contentType.split('/').pop() || 'bin';
  return request(app)
    .post(`/api/clients/${clientId}/avatar`)
    .set(auth(token))
    .attach('avatar', buffer, { filename: `client-avatar.${ext}`, contentType });
}

function expectNoImageData(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  expect(serialized).not.toContain(TINY_PNG_BASE64.toLowerCase().slice(0, 24));
  expect(serialized).not.toContain('ivborw0k');
  expect(serialized).not.toContain('data:image');
  expect(serialized).not.toContain('"avatar"');
}

describe('R19c client avatar - client profile photos', () => {
  let adminToken;
  let advocateToken;
  let otherAdvocateToken;
  let assistantToken;
  let clientToken;
  let otherClientToken;
  let clientUser;
  let otherClientUser;
  let unlinkedClientId;

  beforeAll(async () => {
    await dbReady;

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;

    const advocateRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    expect(advocateRes.statusCode).toBe(200);
    advocateToken = advocateRes.body.token;

    const otherAdvocateRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'michael.oduor@achokilaw.co.ke', password: 'password123' });
    expect(otherAdvocateRes.statusCode).toBe(200);
    otherAdvocateToken = otherAdvocateRes.body.token;

    const assistantRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' });
    expect(assistantRes.statusCode).toBe(200);
    assistantToken = assistantRes.body.token;

    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(clientRes.statusCode).toBe(200);
    clientToken = clientRes.body.token;
    clientUser = clientRes.body.user;

    const otherClientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'grace.njeri@example.com', password: 'password123' });
    expect(otherClientRes.statusCode).toBe(200);
    otherClientToken = otherClientRes.body.token;
    otherClientUser = otherClientRes.body.user;

    await request(app).delete('/api/auth/me/avatar').set(auth(clientToken));
    await request(app).delete('/api/auth/me/avatar').set(auth(otherClientToken));

    const unlinkedClientRes = await request(app)
      .post('/api/clients')
      .set(auth(adminToken))
      .send({ name: 'R19c Unlinked Client', email: 'r19c-unlinked@example.com' });
    expect(unlinkedClientRes.statusCode).toBe(200);
    unlinkedClientId = unlinkedClientRes.body.id;
  }, 30000);

  afterAll(async () => {
    if (clientUser?.clientId) await request(app).delete(`/api/clients/${clientUser.clientId}/avatar`).set(auth(adminToken));
    if (otherClientUser?.clientId) await request(app).delete(`/api/clients/${otherClientUser.clientId}/avatar`).set(auth(adminToken));
  });

  test('1. client can upload own avatar through /api/auth/me/avatar', async () => {
    const res = await uploadMyAvatar(clientToken, 'image/png');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: clientUser.id, hasAvatar: true, mimeType: 'image/png' }));
    expectNoImageData(res.body);
  });

  test('2. client can GET own avatar bytes with image content-type', async () => {
    const res = await request(app)
      .get('/api/auth/me/avatar')
      .set(auth(clientToken));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toMatch(/private/);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('3. /api/auth/me exposes hasAvatar but no avatar image data', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set(auth(clientToken));
    expect(res.statusCode).toBe(200);
    expect(res.body.hasAvatar).toBe(true);
    expect(res.body.avatar).toBeUndefined();
    expectNoImageData(res.body);
  });

  test('4. client can delete own avatar', async () => {
    const deleteRes = await request(app)
      .delete('/api/auth/me/avatar')
      .set(auth(clientToken));
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.hasAvatar).toBe(false);

    const getRes = await request(app)
      .get('/api/auth/me/avatar')
      .set(auth(clientToken));
    expect(getRes.statusCode).toBe(404);
  });

  test('5. client cannot access another client avatar', async () => {
    const uploadRes = await uploadClientAvatar(adminToken, otherClientUser.clientId, 'image/png');
    expect(uploadRes.statusCode).toBe(200);

    const res = await request(app)
      .get(`/api/clients/${otherClientUser.clientId}/avatar`)
      .set(auth(clientToken));
    expect(res.statusCode).toBe(403);
  });

  test('6. admin can upload, get, and delete linked client avatar via client route', async () => {
    const uploadRes = await uploadClientAvatar(adminToken, clientUser.clientId, 'image/png');
    expect(uploadRes.statusCode).toBe(200);
    expect(uploadRes.body).toEqual(expect.objectContaining({ clientId: clientUser.clientId, hasAvatar: true, mimeType: 'image/png' }));
    expectNoImageData(uploadRes.body);

    const getRes = await request(app)
      .get(`/api/clients/${clientUser.clientId}/avatar`)
      .set(auth(adminToken));
    expect(getRes.statusCode).toBe(200);
    expect(getRes.headers['content-type']).toMatch(/image\/png/);

    const deleteRes = await request(app)
      .delete(`/api/clients/${clientUser.clientId}/avatar`)
      .set(auth(adminToken));
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.hasAvatar).toBe(false);
  });

  test('7. advocate and assistant cannot upload or delete client avatar', async () => {
    const advocateUpload = await uploadClientAvatar(advocateToken, clientUser.clientId, 'image/png');
    expect(advocateUpload.statusCode).toBe(403);

    const assistantUpload = await uploadClientAvatar(assistantToken, clientUser.clientId, 'image/png');
    expect(assistantUpload.statusCode).toBe(403);

    const advocateDelete = await request(app)
      .delete(`/api/clients/${clientUser.clientId}/avatar`)
      .set(auth(advocateToken));
    expect(advocateDelete.statusCode).toBe(403);

    const assistantDelete = await request(app)
      .delete(`/api/clients/${clientUser.clientId}/avatar`)
      .set(auth(assistantToken));
    expect(assistantDelete.statusCode).toBe(403);
  });

  test('8. staff view of client avatar respects existing client access rules', async () => {
    const uploadRes = await uploadClientAvatar(adminToken, clientUser.clientId, 'image/png');
    expect(uploadRes.statusCode).toBe(200);

    const adminGet = await request(app).get(`/api/clients/${clientUser.clientId}/avatar`).set(auth(adminToken));
    expect(adminGet.statusCode).toBe(200);

    const assistantGet = await request(app).get(`/api/clients/${clientUser.clientId}/avatar`).set(auth(assistantToken));
    expect(assistantGet.statusCode).toBe(200);

    const assignedAdvocateGet = await request(app).get(`/api/clients/${clientUser.clientId}/avatar`).set(auth(advocateToken));
    expect(assignedAdvocateGet.statusCode).toBe(200);

    const unrelatedAdvocateGet = await request(app).get(`/api/clients/${clientUser.clientId}/avatar`).set(auth(otherAdvocateToken));
    expect(unrelatedAdvocateGet.statusCode).toBe(403);
  });

  test('9. admin route rejects missing linked client user cleanly', async () => {
    const res = await request(app)
      .get(`/api/clients/${unlinkedClientId}/avatar`)
      .set(auth(adminToken));
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/linked client user/i);
  });

  test('10. SVG, GIF, PDF, oversized, and malformed uploads are rejected', async () => {
    const svg = await uploadMyAvatar(clientToken, 'image/svg+xml');
    expect(svg.statusCode).toBe(400);

    const gif = await uploadMyAvatar(clientToken, 'image/gif');
    expect(gif.statusCode).toBe(400);

    const pdf = await uploadMyAvatar(clientToken, 'application/pdf');
    expect(pdf.statusCode).toBe(400);

    const oversized = await uploadMyAvatar(clientToken, 'image/png', Buffer.alloc((512 * 1024) + 1, 0x41));
    expect(oversized.statusCode).toBe(400);
    expect(oversized.body.error).toMatch(/512/);

    const malformed = await request(app)
      .post('/api/auth/me/avatar')
      .set(auth(clientToken))
      .send({ data: 'data:image/png;base64,!!!NOT_VALID_BASE64!!!', mimeType: 'image/png' });
    expect(malformed.statusCode).toBe(400);
  });

  test('11. JPEG, PNG, and WebP uploads are accepted', async () => {
    for (const mimeType of ['image/jpeg', 'image/png', 'image/webp']) {
      const res = await uploadMyAvatar(clientToken, mimeType);
      expect(res.statusCode).toBe(200);
      expect(res.body.mimeType).toBe(mimeType);
      expect(res.body.hasAvatar).toBe(true);
    }
  });

  test('12. audit events are recorded with safe metadata only', async () => {
    const uploadRes = await uploadMyAvatar(clientToken, 'image/png');
    expect(uploadRes.statusCode).toBe(200);

    const event = await latestAuditForEntity('client_avatar_updated', clientUser.id);
    expect(event).toBeDefined();
    expect(event.client_id).toBe(clientUser.clientId);
    expectNoImageData(event.metadata_json || '');
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.role).toBe('client');
    expect(metadata.clientId).toBe(clientUser.clientId);
    expect(metadata.avatar).toBeUndefined();

    const deleteRes = await request(app).delete('/api/auth/me/avatar').set(auth(clientToken));
    expect(deleteRes.statusCode).toBe(200);
    const resetEvent = await latestAuditForEntity('client_avatar_reset', clientUser.id);
    expect(resetEvent).toBeDefined();
    expectNoImageData(resetEvent.metadata_json || '');
  });

  test('13. Product 13B staff avatar route remains staff-only and not generic for clients', async () => {
    const clientGetStaffRoute = await request(app)
      .get(`/api/users/${clientUser.id}/avatar`)
      .set(auth(clientToken));
    expect(clientGetStaffRoute.statusCode).toBe(403);

    const adminUploadClientViaStaffRoute = await request(app)
      .post(`/api/users/${clientUser.id}/avatar`)
      .set(auth(adminToken))
      .send({ data: TINY_PNG_DATA_URI, mimeType: 'image/png' });
    expect([400, 403]).toContain(adminUploadClientViaStaffRoute.statusCode);
    expect(adminUploadClientViaStaffRoute.body.error).toMatch(/client/i);
  });

  test('14. normal JSON responses expose hasAvatar only, never image data', async () => {
    const uploadRes = await uploadMyAvatar(clientToken, 'image/png');
    expect(uploadRes.statusCode).toBe(200);

    const me = await request(app).get('/api/auth/me').set(auth(clientToken));
    expect(me.statusCode).toBe(200);
    expect(me.body.hasAvatar).toBe(true);
    expectNoImageData(me.body);

    const users = await request(app).get('/api/auth/users').set(auth(adminToken));
    expect(users.statusCode).toBe(200);
    const row = users.body.find(user => user.id === clientUser.id);
    expect(row).toBeDefined();
    expect(row.hasAvatar).toBe(true);
    expectNoImageData(users.body);

    const dashboard = await request(app).get('/api/client/dashboard').set(auth(clientToken));
    expect(dashboard.statusCode).toBe(200);
    expectNoImageData(dashboard.body);
  });
});
