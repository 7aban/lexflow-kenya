'use strict';

const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app, dbReady } = require('../server.js');

// Minimal 1×1 PNG (67 bytes) as data URI
const TINY_PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const TINY_PNG_BASE64 = TINY_PNG_DATA_URI.split(',')[1];

// Reuse PNG bytes with JPEG/WebP MIME — server validates MIME type only, not image bytes
const TINY_JPEG_DATA_URI = `data:image/jpeg;base64,${TINY_PNG_BASE64}`;

// Reuse PNG bytes with WebP MIME — server validates MIME type only, not image bytes
const TINY_WEBP_DATA_URI = `data:image/webp;base64,${TINY_PNG_BASE64}`;

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

describe('R19a user avatar — staff profile photos', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let advocateUserId;
  let assistantUserId;
  let clientUserId;

  beforeAll(async () => {
    await dbReady;

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;

    const advRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    expect(advRes.statusCode).toBe(200);
    advocateToken = advRes.body.token;
    advocateUserId = advRes.body.user.id;

    const asstRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' });
    expect(asstRes.statusCode).toBe(200);
    assistantToken = asstRes.body.token;
    assistantUserId = asstRes.body.user.id;

    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(clientRes.statusCode).toBe(200);
    clientToken = clientRes.body.token;
    clientUserId = clientRes.body.user.id;

    // Clean up any avatar left from a previous run
    await request(app)
      .delete(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`);
    await request(app)
      .delete(`/api/users/${assistantUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`);
  }, 30000);

  // ── 1. Unauthenticated GET → 401 ─────────────────────────────────────────
  test('1. unauthenticated GET avatar returns 401', async () => {
    const res = await request(app).get(`/api/users/${advocateUserId}/avatar`);
    expect(res.statusCode).toBe(401);
  });

  // ── 2. Client GET staff avatar → 403 ─────────────────────────────────────
  test('2. client GET staff avatar returns 403', async () => {
    const res = await request(app)
      .get(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  // ── 3. Staff GET own avatar before any upload → 404 ──────────────────────
  test('3. staff GET own avatar before upload returns 404', async () => {
    const res = await request(app)
      .get(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(404);
  });

  // ── 4. Admin uploads valid PNG for staff user → 200 ──────────────────────
  test('4. admin uploads valid PNG for staff user', async () => {
    const res = await request(app)
      .post(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: TINY_PNG_DATA_URI, mimeType: 'image/png' });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(advocateUserId);
    expect(res.body.hasAvatar).toBe(true);
    expect(res.body.mimeType).toBe('image/png');
  });

  // ── 5. GET after upload returns correct Content-Type and bytes ────────────
  test('5. GET after upload returns correct Content-Type and non-empty bytes', async () => {
    const res = await request(app)
      .get(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.body.length).toBeGreaterThan(0);
    // Cache-Control must be set for private use
    expect(res.headers['cache-control']).toMatch(/private/);
  });

  // ── 6. /api/auth/users includes hasAvatar, not avatar BLOB ───────────────
  test('6. /api/auth/users includes hasAvatar boolean but not avatar blob data', async () => {
    const res = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const advocate = res.body.find(u => u.id === advocateUserId);
    expect(advocate).toBeDefined();
    expect(advocate).toHaveProperty('hasAvatar');
    expect(typeof advocate.hasAvatar).toBe('boolean');
    expect(advocate.hasAvatar).toBe(true);

    // Must not include avatar binary/base64 in the list response
    expect(advocate.avatar).toBeUndefined();
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(TINY_PNG_BASE64);
  });

  // ── 7. /api/auth/me includes hasAvatar boolean but not avatar data ────────
  test('7. /api/auth/me includes hasAvatar but not avatar data', async () => {
    // Upload avatar for advocate first (already done in test 4)
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('hasAvatar');
    expect(typeof res.body.hasAvatar).toBe('boolean');
    expect(res.body.avatar).toBeUndefined();
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(TINY_PNG_BASE64);
  });

  // ── 8. Admin DELETE resets avatar → subsequent GET returns 404 ───────────
  test('8. admin DELETE resets avatar and subsequent GET returns 404', async () => {
    const delRes = await request(app)
      .delete(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(delRes.statusCode).toBe(200);
    expect(delRes.body.id).toBe(advocateUserId);
    expect(delRes.body.hasAvatar).toBe(false);

    const getRes = await request(app)
      .get(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(getRes.statusCode).toBe(404);

    // hasAvatar should now be false in /api/auth/users
    const usersRes = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`);
    const advocate = usersRes.body.find(u => u.id === advocateUserId);
    expect(advocate?.hasAvatar).toBe(false);
  });

  // ── 9. Staff can upload own avatar ───────────────────────────────────────
  test('9. staff can upload their own avatar', async () => {
    const res = await request(app)
      .post(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ data: TINY_PNG_DATA_URI, mimeType: 'image/png' });
    expect(res.statusCode).toBe(200);
    expect(res.body.hasAvatar).toBe(true);
  });

  // ── 10. Staff cannot upload another staff user's avatar ──────────────────
  test('10. staff cannot upload another staff user avatar', async () => {
    const res = await request(app)
      .post(`/api/users/${assistantUserId}/avatar`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ data: TINY_PNG_DATA_URI, mimeType: 'image/png' });
    expect(res.statusCode).toBe(403);
  });

  // ── 11. Client cannot upload avatar ──────────────────────────────────────
  test('11. client cannot upload avatar', async () => {
    const res = await request(app)
      .post(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ data: TINY_PNG_DATA_URI, mimeType: 'image/png' });
    expect(res.statusCode).toBe(403);
  });

  // ── 12. Admin cannot upload avatar for client user ────────────────────────
  test('12. admin cannot upload avatar for a client user', async () => {
    const res = await request(app)
      .post(`/api/users/${clientUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: TINY_PNG_DATA_URI, mimeType: 'image/png' });
    expect([400, 403]).toContain(res.statusCode);
    expect(res.body.error).toMatch(/client/i);
  });

  // ── 13. SVG rejected → 400 ───────────────────────────────────────────────
  test('13. SVG MIME type rejected', async () => {
    const res = await request(app)
      .post(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: TINY_PNG_DATA_URI, mimeType: 'image/svg+xml' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/jpeg|png|webp/i);
  });

  // ── 14. GIF rejected → 400 ───────────────────────────────────────────────
  test('14. GIF MIME type rejected', async () => {
    const res = await request(app)
      .post(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: TINY_PNG_DATA_URI, mimeType: 'image/gif' });
    expect(res.statusCode).toBe(400);
  });

  // ── 15. PDF rejected → 400 ───────────────────────────────────────────────
  test('15. PDF MIME type rejected', async () => {
    const res = await request(app)
      .post(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: TINY_PNG_DATA_URI, mimeType: 'application/pdf' });
    expect(res.statusCode).toBe(400);
  });

  // ── 16. Oversized image (> 512 KB) rejected → 400 ────────────────────────
  test('16. oversized image over 512 KB rejected', async () => {
    const bigData = 'data:image/png;base64,' + Buffer.alloc(513 * 1024).fill(0x41).toString('base64');
    const res = await request(app)
      .post(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: bigData, mimeType: 'image/png' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/512/);
  });

  // ── 17. Malformed base64 rejected → 400 ──────────────────────────────────
  test('17. malformed base64 data rejected', async () => {
    const res = await request(app)
      .post(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: 'data:image/png;base64,!!!NOT_VALID_BASE64!!!', mimeType: 'image/png' });
    expect(res.statusCode).toBe(400);
  });

  // ── 18. Audit event user_avatar_updated recorded ─────────────────────────
  test('18. audit event user_avatar_updated is recorded after upload', async () => {
    // Re-upload to get a fresh audit event (advocate already has avatar from test 9)
    await request(app)
      .delete(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`);
    const uploadRes = await request(app)
      .post(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: TINY_PNG_DATA_URI, mimeType: 'image/png' });
    expect(uploadRes.statusCode).toBe(200);

    const event = await latestAuditForEntity('user_avatar_updated', advocateUserId);
    expect(event).toBeDefined();
    expect(event.action).toBe('user_avatar_updated');
    expect(event.entity_type).toBe('user');
    expect(event.entity_id).toBe(advocateUserId);
  });

  // ── 19. Audit event user_avatar_reset recorded ───────────────────────────
  test('19. audit event user_avatar_reset is recorded after delete', async () => {
    const delRes = await request(app)
      .delete(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(delRes.statusCode).toBe(200);

    const event = await latestAuditForEntity('user_avatar_reset', advocateUserId);
    expect(event).toBeDefined();
    expect(event.action).toBe('user_avatar_reset');
    expect(event.entity_type).toBe('user');
    expect(event.entity_id).toBe(advocateUserId);
  });

  // ── 20. Audit metadata does not contain image/base64 data ────────────────
  test('20. audit metadata does not contain avatar image data', async () => {
    const uploadRes = await request(app)
      .post(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: TINY_PNG_DATA_URI, mimeType: 'image/png' });
    expect(uploadRes.statusCode).toBe(200);

    const event = await latestAuditForEntity('user_avatar_updated', advocateUserId);
    expect(event).toBeDefined();
    const metaStr = (event.metadata_json || '').toLowerCase();
    // Must not contain base64 image data or avatar blob markers
    expect(metaStr).not.toContain(TINY_PNG_BASE64.toLowerCase().slice(0, 20));
    expect(metaStr).not.toContain('ivborw0k');
    expect(metaStr).not.toContain('data:image');
    // Metadata should contain role but not blob
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata).toHaveProperty('role');
    expect(metadata.avatar).toBeUndefined();
  });

  // ── Bonus: JPEG and WebP uploads also accepted ───────────────────────────
  test('21. admin uploads valid JPEG for staff user', async () => {
    const res = await request(app)
      .post(`/api/users/${assistantUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: TINY_JPEG_DATA_URI, mimeType: 'image/jpeg' });
    expect(res.statusCode).toBe(200);
    expect(res.body.mimeType).toBe('image/jpeg');
  });

  test('22. admin uploads valid WebP for staff user', async () => {
    const res = await request(app)
      .post(`/api/users/${assistantUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: TINY_WEBP_DATA_URI, mimeType: 'image/webp' });
    expect(res.statusCode).toBe(200);
    expect(res.body.mimeType).toBe('image/webp');
  });

  test('23. GET after JPEG upload returns image/jpeg content-type', async () => {
    // Upload JPEG for assistant
    await request(app)
      .post(`/api/users/${assistantUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: TINY_JPEG_DATA_URI, mimeType: 'image/jpeg' });

    const res = await request(app)
      .get(`/api/users/${assistantUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/jpeg/);
  });

  test('24. /api/auth/me hasAvatar is false for user with no avatar', async () => {
    // Delete assistant avatar first
    await request(app)
      .delete(`/api/users/${assistantUserId}/avatar`)
      .set('Authorization', `Bearer ${adminToken}`);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${assistantToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.hasAvatar).toBe(false);
  });

  test('25. client DELETE avatar endpoint returns 403', async () => {
    const res = await request(app)
      .delete(`/api/users/${advocateUserId}/avatar`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });
});
