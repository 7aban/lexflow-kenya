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

async function latestAudit(action) {
  await new Promise(r => setTimeout(r, 50));
  const rows = await dbAll(
    "SELECT * FROM audit_events WHERE action=? ORDER BY timestamp DESC, id DESC LIMIT 1",
    [action],
  );
  return rows[0];
}

function parseSafeMetadata(event) {
  expect(event).toBeDefined();
  const metadata = JSON.parse(event.metadata_json || '{}');
  const serialized = JSON.stringify(metadata).toLowerCase();
  for (const forbidden of ['token', 'authorization', 'bearer', 'password', 'secret', 'backup_key', 'oauth', 'rawbody']) {
    expect(serialized).not.toContain(forbidden);
  }
  return metadata;
}

describe('R13j export report download audit', () => {
  let adminToken;
  let advocateToken;
  let clientToken;

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
  });

  test('successful matter export download creates export_downloaded audit event', async () => {
    const res = await request(app)
      .get('/api/exports/matters.xls')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);

    const event = await latestAudit('export_downloaded');
    expect(event).toBeDefined();
    expect(event.action).toBe('export_downloaded');
    expect(event.entity_type).toBe('export');
    expect(event.entity_id).toBe('matters.xls');
  });

  test('audit event records export type, format, and record count', async () => {
    const res = await request(app)
      .get('/api/exports/itax.pdf')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);

    const event = await latestAudit('export_downloaded');
    expect(event).toBeDefined();
    expect(event.action).toBe('export_downloaded');
    expect(event.entity_id).toBe('itax.pdf');

    const metadata = parseSafeMetadata(event);
    expect(metadata.exportType).toBe('itax');
    expect(metadata.format).toBe('pdf');
    expect(typeof metadata.recordCount).toBe('number');
  });

  test('client cannot access export route and no export_downloaded event is created', async () => {
    const res = await request(app)
      .get('/api/exports/matters.xls')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toHaveProperty('token');

    const rows = await dbAll("SELECT * FROM audit_events WHERE action='export_downloaded' AND actor_role='client'");
    expect(rows.length).toBe(0);
  });

  test('advocate can export and audit event records correct actor role', async () => {
    const res = await request(app)
      .get('/api/exports/matters.xls')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);

    const event = await latestAudit('export_downloaded');
    expect(event).toBeDefined();
    expect(event.actor_role).toBe('advocate');
  });

  test('audit metadata does not contain token, Authorization, Bearer, password, secret, backup key, OAuth secret, or raw request body', async () => {
    const res = await request(app)
      .get('/api/exports/matters.xls')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);

    const event = await latestAudit('export_downloaded');
    expect(event).toBeDefined();
    parseSafeMetadata(event);
  });

  test('admin can query export audit event through /api/audit-events', async () => {
    const auditRes = await request(app)
      .get("/api/audit-events?action=export_downloaded")
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.body.rows.some(row => row.action === 'export_downloaded')).toBe(true);
  });

  test('non-admin cannot query audit events', async () => {
    const auditRes = await request(app)
      .get("/api/audit-events?action=export_downloaded")
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(auditRes.statusCode).toBe(403);
  });
});
