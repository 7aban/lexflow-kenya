const request = require('supertest');
const sqlite3 = require('sqlite3');
const { app, dbReady } = require('../server.js');
const config = require('../lib/config');

describe('GET /api/matters/:id/work-metadata-links', () => {
  let adminToken;
  let sarahToken;
  let michaelToken;
  let clientToken;
  let matterIds = {};
  let noLinksMatterId;

  async function withDb(work) {
    const db = new sqlite3.Database(config.DATABASE_PATH);
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
    const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
    const close = () => new Promise(resolve => db.close(() => resolve()));
    try {
      return await work({ get, all });
    } finally {
      await close();
    }
  }

  beforeAll(async () => {
    await dbReady;

    async function auth(path, email) {
      const res = await request(app).post(path).send({ email, password: 'password123' });
      expect(res.statusCode).toBe(200);
      return res.body.token;
    }

    adminToken = await auth('/api/auth/login', 'admin@lexflow.co.ke');
    sarahToken = await auth('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    michaelToken = await auth('/api/auth/login', 'michael.oduor@achokilaw.co.ke');
    clientToken = await auth('/api/auth/client-login', 'margaret.wairimu@example.co.ke');

    const refs = await withDb(({ all }) => all('SELECT id, reference FROM matters'));
    for (const row of refs) {
      matterIds[row.reference] = row.id;
    }
    noLinksMatterId = matterIds['LEX-2026-0004'];
  });

  test('Staff can retrieve confirmed email and calendar links for an accessible matter', async () => {
    const emailMatterId = matterIds['LEX-2026-0001'];
    const res = await request(app)
      .get(`/api/matters/${emailMatterId}/work-metadata-links`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const emailLink = res.body.find(l => l.sourceType === 'email');
    expect(emailLink).toBeTruthy();
    expect(emailLink.linkId).toBeTruthy();
    expect(emailLink.sourceRecordId).toBe('demo-work-email-lex-2026-0001-confirmed');
    expect(emailLink.subject).toBeTruthy();
    expect(emailLink.sender).toBeTruthy();
    expect(emailLink.receivedAt).toBeTruthy();
    expect(emailLink.hasAttachments).toBe(1);
    expect(emailLink.accountEmail).toBeTruthy();
    expect(emailLink.accountProvider).toBeTruthy();
    expect(emailLink.confirmedBy).toBe('seed-admin');
    expect(emailLink.confirmedAt).toBeTruthy();
    const calMatterId = matterIds['LEX-2026-0005'];
    const res2 = await request(app)
      .get(`/api/matters/${calMatterId}/work-metadata-links`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res2.statusCode).toBe(200);
    const calLink = res2.body.find(l => l.sourceType === 'calendar');
    expect(calLink).toBeTruthy();
    expect(calLink.linkId).toBeTruthy();
    expect(calLink.sourceRecordId).toBe('demo-work-calendar-lex-2026-0005-confirmed');
    expect(calLink.subject).toBeTruthy();
    expect(calLink.organizer).toBeTruthy();
    expect(calLink.startTime).toBeTruthy();
    expect(calLink.meetingLink).toBeTruthy();
    expect(calLink.accountEmail).toBeTruthy();
    expect(calLink.accountProvider).toBeTruthy();
    expect(calLink.confirmedBy).toBe('seed-admin');
    expect(calLink.confirmedAt).toBeTruthy();
  });

  test('Returns empty array when matter has no confirmed links', async () => {
    const res = await request(app)
      .get(`/api/matters/${noLinksMatterId}/work-metadata-links`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  test('Does not return suggested-only/unconfirmed links', async () => {
    const suggestedMatterId = matterIds['LEX-2026-0003'];
    const res = await request(app)
      .get(`/api/matters/${suggestedMatterId}/work-metadata-links`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  test('Does not return unlinked records', async () => {
    const testIds = [matterIds['LEX-2026-0001'], matterIds['LEX-2026-0005'], matterIds['LEX-2026-0003'], noLinksMatterId];
    for (const id of testIds) {
      const res = await request(app)
        .get(`/api/matters/${id}/work-metadata-links`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      for (const link of res.body) {
        expect(link.linkId).toBeTruthy();
      }
    }
  });

  test('Client role is blocked with 403', async () => {
    const emailMatterId = matterIds['LEX-2026-0001'];
    const res = await request(app)
      .get(`/api/matters/${emailMatterId}/work-metadata-links`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('Advocate cannot access another advocate\'s matter links', async () => {
    const michaelMatterId = matterIds['LEX-2026-0003'];
    const res = await request(app)
      .get(`/api/matters/${michaelMatterId}/work-metadata-links`)
      .set('Authorization', `Bearer ${sarahToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('Advocate can access own matter links', async () => {
    const emailMatterId = matterIds['LEX-2026-0001'];
    const res = await request(app)
      .get(`/api/matters/${emailMatterId}/work-metadata-links`)
      .set('Authorization', `Bearer ${sarahToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  test('Admin can access confirmed links', async () => {
    const calMatterId = matterIds['LEX-2026-0005'];
    const res = await request(app)
      .get(`/api/matters/${calMatterId}/work-metadata-links`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const calLink = res.body.find(l => l.sourceType === 'calendar');
    expect(calLink).toBeTruthy();
    expect(calLink.sourceType).toBe('calendar');
  });

  test('Response excludes body/attachment/token/encrypted/full-description fields', async () => {
    const emailMatterId = matterIds['LEX-2026-0001'];
    const res = await request(app)
      .get(`/api/matters/${emailMatterId}/work-metadata-links`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    const payload = JSON.stringify(res.body);
    expect(payload.toLowerCase()).not.toContain('body');
    expect(payload.toLowerCase()).not.toContain('attachmentcontent');
    expect(payload.toLowerCase()).not.toContain('attachmentsjson');
    expect(payload.toLowerCase()).not.toContain('accesstoken');
    expect(payload.toLowerCase()).not.toContain('refreshtoken');
    expect(payload.toLowerCase()).not.toContain('encrypted');
    expect(payload.toLowerCase()).not.toContain('snippet');
    expect(payload.toLowerCase()).not.toContain('recipientssummary');
    expect(payload.toLowerCase()).not.toContain('labelsjson');
    expect(payload.toLowerCase()).not.toContain('foldersjson');
    expect(payload.toLowerCase()).not.toContain('descriptionsnippet');
    expect(payload.toLowerCase()).not.toContain('attendeesummary');
    expect(payload.toLowerCase()).not.toContain('description');
  });

  test('Response contains only safe metadata fields', async () => {
    const emailMatterId = matterIds['LEX-2026-0001'];
    const res = await request(app)
      .get(`/api/matters/${emailMatterId}/work-metadata-links`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    for (const link of res.body) {
      const keys = Object.keys(link).sort();
      expect(keys).toEqual([
        'accountEmail',
        'accountProvider',
        'confirmedAt',
        'confirmedBy',
        'hasAttachments',
        'linkId',
        'meetingLink',
        'organizer',
        'receivedAt',
        'sender',
        'sourceRecordId',
        'sourceType',
        'startTime',
        'subject',
      ]);
      expect(link.linkId).toBeTruthy();
      expect(link.sourceType).toMatch(/^(email|calendar)$/);
      expect(link.sourceRecordId).toBeTruthy();
      expect(link.confirmedBy).toBeTruthy();
      expect(link.confirmedAt).toBeTruthy();
    }
  });
});
