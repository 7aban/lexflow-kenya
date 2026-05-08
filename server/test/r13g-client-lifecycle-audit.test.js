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
  for (const forbidden of ['token', 'authorization', 'bearer', 'password', 'secret', 'rawbody']) {
    expect(serialized).not.toContain(forbidden);
  }
  return metadata;
}

describe('R13g client lifecycle structured audit events', () => {
  let adminToken;
  let advocateToken;
  let clientToken;
  let createdClientId;

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

    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(clientRes.statusCode).toBe(200);
    clientToken = clientRes.body.token;
  });

  test('successful client creation creates structured client_created audit event', async () => {
    const name = `R13g Create Client ${Date.now()}`;
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, type: 'Individual', email: `r13g-create-${Date.now()}@example.com`, phone: '+254700123456' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('id');
    createdClientId = res.body.id;

    const event = await latestAudit('client_created', createdClientId);
    expect(event).toBeDefined();
    expect(event.action).toBe('client_created');
    expect(event.entity_type).toBe('client');
    expect(event.entity_id).toBe(createdClientId);

    const metadata = parseSafeMetadata(event);
    expect(metadata.name).toBe(name);
    expect(metadata.type).toBe('Individual');
  });

  test('successful client update creates structured client_updated audit event', async () => {
    const res = await request(app)
      .patch(`/api/clients/${createdClientId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'R13g Updated Name', phone: '+254700999999' });
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe('R13g Updated Name');

    const event = await latestAudit('client_updated', createdClientId);
    expect(event).toBeDefined();
    expect(event.action).toBe('client_updated');
    expect(event.entity_type).toBe('client');
    expect(event.entity_id).toBe(createdClientId);

    const metadata = parseSafeMetadata(event);
    expect(metadata.name).toBe('R13g Updated Name');
    expect(metadata.updatedFields).toContain('name');
    expect(metadata.updatedFields).toContain('phone');
  });

  test('unauthorized user cannot create client and no success lifecycle event is created', async () => {
    const name = `R13g Unauthorized ${Date.now()}`;
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ name, type: 'Individual' });
    expect(res.statusCode).toBe(403);

    const rows = await dbAll("SELECT * FROM audit_events WHERE action='client_created' AND metadata_json LIKE ?", [`%${name}%`]);
    expect(rows.length).toBe(0);
  });

  test('audit metadata does not contain token, Authorization, Bearer, password, secret, or raw request body', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `R13g Safe ${Date.now()}`, type: 'Company' });
    expect(res.statusCode).toBe(200);

    const event = await latestAudit('client_created', res.body.id);
    expect(event).toBeDefined();
    parseSafeMetadata(event);
  });

  test('admin can query client lifecycle events through /api/audit-events', async () => {
    const auditRes = await request(app)
      .get(`/api/audit-events?action=client_created&entity_id=${encodeURIComponent(createdClientId)}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.body.rows.some(row => row.action === 'client_created' && row.entity_id === createdClientId)).toBe(true);
  });

  test('non-admin cannot query /api/audit-events', async () => {
    const res = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('existing client_deleted behavior remains unchanged', async () => {
    const name = `R13g DeleteTest ${Date.now()}`;
    const createRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, type: 'Individual' });
    expect(createRes.statusCode).toBe(200);

    const delRes = await request(app)
      .delete(`/api/clients/${createRes.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(delRes.statusCode).toBe(200);
    expect(delRes.body.deleted).toBe(true);

    const event = await latestAudit('client_deleted', createRes.body.id);
    expect(event).toBeDefined();
    expect(event.action).toBe('client_deleted');
    expect(event.entity_type).toBe('client');
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.name).toBe(name);
    expect(typeof metadata.matterCount).toBe('number');
  });
});
