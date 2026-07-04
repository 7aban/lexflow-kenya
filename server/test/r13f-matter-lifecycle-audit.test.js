const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app, dbReady } = require('../server.js');

function dbAll(sql, params = []) {
  const db = new sqlite3.Database(path.join(__dirname, '..', 'lawfirm.db'));
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      db.close();
      err ? reject(err) : resolve(rows);
    });
  });
}

async function latestAudit(action, entityId) {
  const rows = await dbAll(
    'SELECT * FROM audit_events WHERE action=? AND entity_id=? ORDER BY timestamp DESC LIMIT 1',
    [action, entityId || ''],
  );
  return rows[0];
}

function parseSafeMetadata(event) {
  expect(event).toBeDefined();
  const metadata = JSON.parse(event.metadata_json || '{}');
  const serialized = JSON.stringify(metadata).toLowerCase();
  for (const forbidden of ['token', 'authorization', 'bearer', 'password', 'secret', 'rawbody']) {
    expect(serialized).not.toContain(forbidden);
  }
  return metadata;
}

describe('R13f matter lifecycle structured audit events', () => {
  let adminToken;
  let advocateToken;
  let clientToken;
  let testClientId;
  let createdMatterId;

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

    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(clientRes.statusCode).toBe(200);
    clientToken = clientRes.body.token;

    const clientsRes = await request(app)
      .get('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(clientsRes.statusCode).toBe(200);
    expect(clientsRes.body.length).toBeGreaterThan(0);
    testClientId = clientsRes.body[0].id;
  });

  test('successful matter creation creates structured matter_created audit event', async () => {
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId: testClientId,
        title: 'R13f Create Test Matter',
        practiceArea: 'Civil Litigation',
        stage: 'Intake',
      });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('id');
    createdMatterId = res.body.id;

    const event = await latestAudit('matter_created', createdMatterId);
    expect(event).toBeDefined();
    expect(event.action).toBe('matter_created');
    expect(event.entity_type).toBe('matter');
    expect(event.entity_id).toBe(createdMatterId);

    const metadata = parseSafeMetadata(event);
    expect(metadata.title).toBe('R13f Create Test Matter');
    expect(metadata.stage).toBe('Intake');
  });

  test('successful matter update creates structured matter_updated audit event', async () => {
    const res = await request(app)
      .patch(`/api/matters/${createdMatterId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'R13f Updated Title', priority: 'High' });
    expect(res.statusCode).toBe(200);
    expect(res.body.title).toBe('R13f Updated Title');

    const event = await latestAudit('matter_updated', createdMatterId);
    expect(event).toBeDefined();
    expect(event.action).toBe('matter_updated');
    expect(event.entity_type).toBe('matter');
    expect(event.entity_id).toBe(createdMatterId);

    const metadata = parseSafeMetadata(event);
    expect(metadata.title).toBe('R13f Updated Title');
    expect(metadata.updatedFields).toContain('title');
    expect(metadata.updatedFields).toContain('priority');
  });

  test('successful matter archive creates structured matter_archived audit event', async () => {
    const res = await request(app)
      .patch(`/api/matters/${createdMatterId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ stage: 'Closed' });
    expect(res.statusCode).toBe(200);
    expect(res.body.stage).toBe('Closed');

    const event = await latestAudit('matter_archived', createdMatterId);
    expect(event).toBeDefined();
    expect(event.action).toBe('matter_archived');
    expect(event.entity_type).toBe('matter');
    expect(event.entity_id).toBe(createdMatterId);

    const metadata = parseSafeMetadata(event);
    expect(metadata.stage).toBe('Closed');
  });

  test('unauthorized user cannot create matter and no success lifecycle event is created', async () => {
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({
        clientId: testClientId,
        title: 'R13f Unauthorized Matter',
        practiceArea: 'Test',
      });
    expect(res.statusCode).toBe(403);

    const rows = await dbAll("SELECT * FROM audit_events WHERE action='matter_created' AND metadata_json LIKE ?", ['%R13f Unauthorized Matter%']);
    expect(rows.length).toBe(0);
  });

  test('audit metadata does not contain token, Authorization, Bearer, password, secret, or raw request body', async () => {
    const id = `r13f-safe-${Date.now()}`;
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId: testClientId,
        title: 'R13f Safe Metadata Matter',
        practiceArea: 'Test',
      });
    expect(res.statusCode).toBe(200);

    const event = await latestAudit('matter_created', res.body.id);
    expect(event).toBeDefined();
    parseSafeMetadata(event);
  });

  test('admin can query matter lifecycle events through /api/audit-events', async () => {
    const auditRes = await request(app)
      .get(`/api/audit-events?action=matter_created&entity_id=${encodeURIComponent(createdMatterId)}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.body.rows.some(row => row.action === 'matter_created' && row.entity_id === createdMatterId)).toBe(true);
  });

  test('non-admin cannot query /api/audit-events', async () => {
    const res = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);
  });
});
