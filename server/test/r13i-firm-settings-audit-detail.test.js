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

describe('R13i firm settings audit detail', () => {
  let adminToken;
  let advocateToken;

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
  });

  test('firm settings update creates firm_settings_updated audit event with metadata', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'R13i Test Firm', address: 'R13i audit test address' });
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe('R13i Test Firm');

    const event = await latestAudit('firm_settings_updated');
    expect(event).toBeDefined();
    expect(event.action).toBe('firm_settings_updated');
    expect(event.entity_type).toBe('firm_settings');

    const metadata = parseSafeMetadata(event);
    expect(metadata.name).toBe('R13i Test Firm');
    expect(metadata.fieldsUpdated).toContain('name');
    expect(metadata.fieldsUpdated).toContain('address');
  });

  test('billing visibility setting change records safe old/new metadata', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });
    expect(res.statusCode).toBe(200);

    const event = await latestAudit('firm_settings_updated');
    expect(event).toBeDefined();

    const metadata = parseSafeMetadata(event);
    expect(metadata.fieldsUpdated).toContain('advocateBillingVisibility');
    expect(metadata.advocateBillingVisibility).toBeDefined();
    expect(metadata.advocateBillingVisibility.old).toBeDefined();
    expect(metadata.advocateBillingVisibility.new).toBe(0);

    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });
  });

  test('metadata records changed field names', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'R13i Fields Test', primaryColor: '#123456', email: 'test@lexflow.co.ke' });
    expect(res.statusCode).toBe(200);

    const event = await latestAudit('firm_settings_updated');
    expect(event).toBeDefined();

    const metadata = parseSafeMetadata(event);
    expect(metadata.fieldsUpdated).toContain('name');
    expect(metadata.fieldsUpdated).toContain('primaryColor');
    expect(metadata.fieldsUpdated).toContain('email');
  });

  test('metadata does not include token, Authorization, Bearer, password, secret, backup key, OAuth secret, or raw request body', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'R13i Safe Test', address: 'Safe metadata check' });
    expect(res.statusCode).toBe(200);

    const event = await latestAudit('firm_settings_updated');
    expect(event).toBeDefined();
    parseSafeMetadata(event);
  });

  test('non-admin firm settings update remains forbidden and does not create success audit event', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ name: 'R13i Unauthorized' });
    expect(res.statusCode).toBe(403);

    const rows = await dbAll("SELECT * FROM audit_events WHERE action='firm_settings_updated' AND metadata_json LIKE ?", ['%R13i Unauthorized%']);
    expect(rows.length).toBe(0);
  });

  test('admin can query setting audit event through /api/audit-events', async () => {
    const auditRes = await request(app)
      .get("/api/audit-events?action=firm_settings_updated")
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.body.rows.some(row => row.action === 'firm_settings_updated')).toBe(true);
  });

  test('existing theme audit behavior remains unchanged', async () => {
    const theme = { source: 'manual', primaryColor: '#1B3A5C', accentColor: '#D4A34A', backgroundColor: '#0A0F1A', textColor: '#E5E7EB', buttonColor: '#D4A34A', buttonTextColor: '#0F1B33', sidebarColor: '#0F1B33', sidebarTextColor: '#E5E7EB' };
    const themeRes = await request(app)
      .put('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(theme);
    expect(themeRes.statusCode).toBe(200);

    const themeEvent = await latestAudit('firm_theme_updated');
    expect(themeEvent).toBeDefined();
    expect(themeEvent.action).toBe('firm_theme_updated');

    const resetRes = await request(app)
      .post('/api/firm-settings/theme/reset')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(resetRes.statusCode).toBe(200);

    const resetEvent = await latestAudit('firm_theme_reset');
    expect(resetEvent).toBeDefined();
    expect(resetEvent.action).toBe('firm_theme_reset');
  });
});
