'use strict';

const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app, dbReady } = require('../server.js');

const TINY_PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const TINY_PNG_BASE64 = TINY_PNG_DATA_URI.split(',')[1];

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

function dbRun(sql, params = []) {
  const db = new sqlite3.Database(path.join(__dirname, '..', 'lawfirm.db'));
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      db.close();
      err ? reject(err) : resolve(this);
    });
  });
}

async function latestAudit(action, entityId) {
  return dbGet(
    'SELECT * FROM audit_events WHERE action=? AND entity_id=? ORDER BY timestamp DESC LIMIT 1',
    [action, entityId],
  );
}

function expectNoImageData(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  expect(serialized).not.toContain(TINY_PNG_BASE64.toLowerCase().slice(0, 24));
  expect(serialized).not.toContain('ivborw0k');
  expect(serialized).not.toContain('data:image');
  expect(serialized).not.toContain('"content"');
}

function postAsset(token, body) {
  return request(app)
    .post('/api/signature-assets')
    .set(auth(token))
    .send({
      ownerType: 'user',
      assetType: 'signature',
      label: `PRODUCT-23B signature ${Date.now()}`,
      mimeType: 'image/png',
      data: TINY_PNG_DATA_URI,
      ...body,
    });
}

describe('PRODUCT-23B signature and stamp asset storage', () => {
  let adminToken;
  let advocateToken;
  let otherAdvocateToken;
  let assistantToken;
  let clientToken;
  let advocateUserId;
  let firmStampId;

  beforeAll(async () => {
    await dbReady;

    await dbRun('DELETE FROM signature_assets');

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
    advocateUserId = advocateRes.body.user.id;

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
  }, 30000);

  test('1. advocate can upload own signature image', async () => {
    const res = await postAsset(advocateToken, { label: 'PRODUCT-23B Sarah signature' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ownerType: 'user',
      ownerId: advocateUserId,
      assetType: 'signature',
      label: 'PRODUCT-23B Sarah signature',
      mimeType: 'image/png',
      isDefault: true,
    }));
    expect(res.body.size).toBeGreaterThan(0);
    expectNoImageData(res.body);
  });

  test('2. admin can upload firm stamp image', async () => {
    const res = await postAsset(adminToken, {
      ownerType: 'firm',
      assetType: 'stamp',
      label: 'PRODUCT-23B firm stamp',
    });
    expect(res.statusCode).toBe(200);
    firmStampId = res.body.id;
    expect(res.body).toEqual(expect.objectContaining({
      ownerType: 'firm',
      ownerId: null,
      assetType: 'stamp',
      label: 'PRODUCT-23B firm stamp',
      mimeType: 'image/png',
      isDefault: true,
    }));
    expectNoImageData(res.body);
  });

  test('3. invalid MIME is rejected', async () => {
    const res = await postAsset(advocateToken, {
      label: 'PRODUCT-23B bad gif',
      mimeType: 'image/gif',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/jpeg|png|webp/i);
  });

  test('4. SVG is rejected', async () => {
    const res = await postAsset(advocateToken, {
      label: 'PRODUCT-23B bad svg',
      mimeType: 'image/svg+xml',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/jpeg|png|webp/i);
  });

  test('5. client cannot access signature assets', async () => {
    const listRes = await request(app)
      .get('/api/signature-assets')
      .set(auth(clientToken));
    expect(listRes.statusCode).toBe(403);

    const uploadRes = await postAsset(clientToken, { label: 'PRODUCT-23B client blocked' });
    expect(uploadRes.statusCode).toBe(403);
  });

  test('6. advocate cannot access another advocate personal signature asset content', async () => {
    const otherUpload = await postAsset(otherAdvocateToken, { label: 'PRODUCT-23B other advocate signature' });
    expect(otherUpload.statusCode).toBe(200);

    const res = await request(app)
      .get(`/api/signature-assets/${otherUpload.body.id}/content`)
      .set(auth(advocateToken));
    expect(res.statusCode).toBe(403);
  });

  test('7. firm stamp asset metadata is visible to authorized staff', async () => {
    const advocateList = await request(app)
      .get('/api/signature-assets')
      .set(auth(advocateToken));
    expect(advocateList.statusCode).toBe(200);
    expect(advocateList.body.some(asset => asset.id === firmStampId)).toBe(true);
    expectNoImageData(advocateList.body);

    const assistantList = await request(app)
      .get('/api/signature-assets')
      .set(auth(assistantToken));
    expect(assistantList.statusCode).toBe(200);
    expect(assistantList.body.some(asset => asset.id === firmStampId)).toBe(true);
    expect(assistantList.body.every(asset => asset.ownerType === 'firm' && asset.assetType === 'stamp')).toBe(true);

    const contentRes = await request(app)
      .get(`/api/signature-assets/${firmStampId}/content`)
      .set(auth(assistantToken));
    expect(contentRes.statusCode).toBe(200);
    expect(contentRes.headers['content-type']).toMatch(/image\/png/);
    expect(contentRes.body.length).toBeGreaterThan(0);
  });

  test('8. soft-deleted asset content is not retrievable', async () => {
    const upload = await postAsset(advocateToken, { label: 'PRODUCT-23B delete me' });
    expect(upload.statusCode).toBe(200);

    const del = await request(app)
      .patch(`/api/signature-assets/${upload.body.id}`)
      .set(auth(advocateToken))
      .send({ deleted: true });
    expect(del.statusCode).toBe(200);
    expect(del.body.deletedAt).toBeTruthy();

    const content = await request(app)
      .get(`/api/signature-assets/${upload.body.id}/content`)
      .set(auth(advocateToken));
    expect(content.statusCode).toBe(404);
  });

  test('9. audit events are recorded for create, delete, and default set', async () => {
    const first = await postAsset(advocateToken, { label: 'PRODUCT-23B audit first' });
    expect(first.statusCode).toBe(200);
    const second = await postAsset(advocateToken, { label: 'PRODUCT-23B audit second' });
    expect(second.statusCode).toBe(200);
    expect(second.body.isDefault).toBe(false);

    const defaultSet = await request(app)
      .patch(`/api/signature-assets/${second.body.id}`)
      .set(auth(advocateToken))
      .send({ isDefault: true });
    expect(defaultSet.statusCode).toBe(200);
    expect(defaultSet.body.isDefault).toBe(true);

    const deleted = await request(app)
      .patch(`/api/signature-assets/${second.body.id}`)
      .set(auth(advocateToken))
      .send({ deleted: true });
    expect(deleted.statusCode).toBe(200);

    const createEvent = await latestAudit('signature_asset_created', first.body.id);
    const defaultEvent = await latestAudit('signature_asset_default_set', second.body.id);
    const deleteEvent = await latestAudit('signature_asset_deleted', second.body.id);

    expect(createEvent).toBeDefined();
    expect(defaultEvent).toBeDefined();
    expect(deleteEvent).toBeDefined();
    expectNoImageData(createEvent.metadata_json || '');
    expectNoImageData(defaultEvent.metadata_json || '');
    expectNoImageData(deleteEvent.metadata_json || '');
  });
});
