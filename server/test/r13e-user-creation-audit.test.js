const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app } = require('../server.js');

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
  for (const forbidden of ['password', 'password123', 'token', 'authorization', 'bearer', 'secret', 'rawbody']) {
    expect(serialized).not.toContain(forbidden);
  }
  return metadata;
}

describe('R13e user creation structured audit events', () => {
  let adminToken;
  let advocateToken;

  beforeAll(async () => {
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
  });

  test('successful admin user creation creates structured user_created audit event', async () => {
    const email = `r13e-create-${Date.now()}@example.com`;
    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email,
        password: 'Str0ng!Passw0rd2026',
        fullName: 'R13e Created User',
        role: 'assistant',
      });
    expect(registerRes.statusCode).toBe(200);
    expect(registerRes.body).toHaveProperty('id');

    const event = await latestAudit('user_created', registerRes.body.id);
    expect(event).toBeDefined();
    expect(event.action).toBe('user_created');
    expect(event.entity_type).toBe('user');
    expect(event.entity_id).toBe(registerRes.body.id);

    const metadata = parseSafeMetadata(event);
    expect(metadata.email).toBe(email);
    expect(metadata.role).toBe('assistant');
    expect(metadata.fullName).toBe('R13e Created User');
  });

  test('non-admin user creation is forbidden and does not create success user_created event', async () => {
    const email = `r13e-nonadmin-${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({
        email,
        password: 'Str0ng!Passw0rd2026',
        fullName: 'R13e Non-Admin',
        role: 'assistant',
      });
    expect(res.statusCode).toBe(403);

    const rows = await dbAll("SELECT * FROM audit_events WHERE action='user_created' AND metadata_json LIKE ?", [`%${email}%`]);
    expect(rows.length).toBe(0);
  });

  test('audit metadata does not contain password, hash, token, Authorization, Bearer, secret, or raw request body', async () => {
    const email = `r13e-safe-${Date.now()}@example.com`;
    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email,
        password: 'Str0ng!Passw0rd2026',
        fullName: 'R13e Safe Metadata',
        role: 'assistant',
      });
    expect(registerRes.statusCode).toBe(200);

    const event = await latestAudit('user_created', registerRes.body.id);
    expect(event).toBeDefined();
    parseSafeMetadata(event);
  });

  test('admin can query user_created event through /api/audit-events', async () => {
    const email = `r13e-query-${Date.now()}@example.com`;
    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email,
        password: 'Str0ng!Passw0rd2026',
        fullName: 'R13e Query User',
        role: 'advocate',
      });
    expect(registerRes.statusCode).toBe(200);

    const auditRes = await request(app)
      .get(`/api/audit-events?action=user_created&entity_id=${encodeURIComponent(registerRes.body.id)}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.body.rows.some(row => row.action === 'user_created' && row.entity_id === registerRes.body.id)).toBe(true);
  });

  test('non-admin cannot query /api/audit-events', async () => {
    const res = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);
  });
});
