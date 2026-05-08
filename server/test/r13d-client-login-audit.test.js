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

async function latestAuditByMetadata(action, text) {
  const rows = await dbAll(
    'SELECT * FROM audit_events WHERE action=? AND metadata_json LIKE ? ORDER BY timestamp DESC LIMIT 1',
    [action, `%${text}%`],
  );
  return rows[0];
}

function parseSafeMetadata(event) {
  expect(event).toBeDefined();
  const metadata = JSON.parse(event.metadata_json || '{}');
  const serialized = JSON.stringify(metadata).toLowerCase();
  for (const forbidden of ['password', 'password123', 'wrongpassword', 'token', 'authorization', 'bearer', 'secret', 'rawbody']) {
    expect(serialized).not.toContain(forbidden);
  }
  return metadata;
}

describe('R13d client portal login audit events', () => {
  let adminToken;
  let clientToken;
  let clientUser;

  beforeAll(async () => {
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;

    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(clientRes.statusCode).toBe(200);
    clientToken = clientRes.body.token;
    clientUser = clientRes.body.user;
  });

  test('successful client login creates structured audit event queryable by admin', async () => {
    const event = await latestAudit('client_login_success', clientUser.id);
    expect(event.action).toBe('client_login_success');
    expect(event.entity_type).toBe('user');
    expect(event.entity_id).toBe(clientUser.id);
    expect(event.client_id).toBe(clientUser.clientId);
    const metadata = parseSafeMetadata(event);
    expect(metadata.email).toBe(clientUser.email);
    expect(metadata.role).toBe('client');
    expect(metadata.loginMethod).toBe('client_portal');

    const auditRes = await request(app)
      .get(`/api/audit-events?action=client_login_success&entity_id=${encodeURIComponent(clientUser.id)}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.body.rows.some(row => row.action === 'client_login_success' && row.entity_id === clientUser.id)).toBe(true);
  });

  test('invalid client password creates safe client login failure audit event', async () => {
    const res = await request(app)
      .post('/api/auth/client-login')
      .send({ email: clientUser.email, password: 'wrongpassword' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid client email or password' });

    const event = await latestAudit('client_login_failure', clientUser.id);
    expect(event.action).toBe('client_login_failure');
    expect(event.entity_type).toBe('user');
    expect(event.entity_id).toBe(clientUser.id);
    expect(event.client_id).toBe(clientUser.clientId);
    const metadata = parseSafeMetadata(event);
    expect(metadata.reason).toBe('invalid_credentials');
    expect(metadata.loginMethod).toBe('client_portal');
  });

  test('unknown client email creates generic safe login failure audit event', async () => {
    const unknownEmail = `r13d-unknown-${Date.now()}@example.co.ke`;
    const res = await request(app)
      .post('/api/auth/client-login')
      .send({ email: unknownEmail, password: 'password123' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid client email or password' });

    const event = await latestAuditByMetadata('client_login_failure', unknownEmail);
    expect(event.action).toBe('client_login_failure');
    expect(event.entity_type).toBe('user');
    expect(event.entity_id || '').toBe('');
    const metadata = parseSafeMetadata(event);
    expect(metadata.email).toBe(unknownEmail);
    expect(metadata.reason).toBe('unknown_client');
    expect(metadata.loginMethod).toBe('client_portal');
  });

  test('inactive client login creates safe failure audit event without changing response shape', async () => {
    const email = `r13d-inactive-${Date.now()}@example.co.ke`;
    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email,
        password: 'Str0ng!Passw0rd2026',
        fullName: 'R13d Inactive Client',
        role: 'client',
        clientId: clientUser.clientId,
      });
    expect(registerRes.statusCode).toBe(200);

    const toggleRes = await request(app)
      .patch(`/api/auth/users/${registerRes.body.id}/toggle-active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });
    expect(toggleRes.statusCode).toBe(200);

    const loginRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email, password: 'Str0ng!Passw0rd2026' });
    expect(loginRes.statusCode).toBe(401);
    expect(loginRes.body).toEqual({ error: 'Invalid client email or password' });

    const event = await latestAudit('client_login_failure', registerRes.body.id);
    expect(event.action).toBe('client_login_failure');
    expect(event.client_id).toBe(clientUser.clientId);
    const metadata = parseSafeMetadata(event);
    expect(metadata.reason).toBe('inactive_account');
    expect(metadata.loginMethod).toBe('client_portal');
  });

  test('non-admin users cannot read structured audit events', async () => {
    const clientAuditRes = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(clientAuditRes.statusCode).toBe(403);
  });
});
