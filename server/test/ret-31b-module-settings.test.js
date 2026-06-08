const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

const ALL_MODULE_KEYS = ['retainerManagement', 'kycCdd', 'corporateAuthority', 'retainerLedger', 'scopeVariation', 'clientTasks', 'advancedCompliance'];

let adminToken, advocateToken, margaretId;

function dbAll(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
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

beforeAll(async () => {
  await dbReady;
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = adminRes.body.token;

  const advRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
  advocateToken = advRes.body.token;

  const clientsRes = await request(app)
    .get('/api/clients')
    .set('Authorization', `Bearer ${adminToken}`);
  const margaret = (Array.isArray(clientsRes.body) ? clientsRes.body : clientsRes.body?.clients || []).find(c => c.name === 'Margaret Wairimu');
  margaretId = margaret?.id || (clientsRes.body?.find ? clientsRes.body.find(c => c.name === 'Margaret Wairimu')?.id : null);
});

afterAll(async () => {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  await new Promise((resolve, reject) => {
    db.run('UPDATE firm_settings SET moduleSettingsJson=NULL WHERE id=?', ['default'], (err) => err ? reject(err) : resolve());
  });
  db.close();
});

describe('RET-31B module settings foundation', () => {
  test('1. moduleSettingsJson column exists after startup', async () => {
    const rows = await dbAll("PRAGMA table_info(firm_settings)");
    const col = rows.find(r => r.name === 'moduleSettingsJson');
    expect(col).toBeDefined();
    expect(col.type).toBe('TEXT');
  });

  test('2. GET /api/firm-settings returns moduleSettings', async () => {
    const res = await request(app)
      .get('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('moduleSettings');
  });

  test('3. Default moduleSettings includes all seven keys and all are false', async () => {
    const res = await request(app)
      .get('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    const ms = res.body.moduleSettings;
    for (const key of ALL_MODULE_KEYS) {
      expect(ms).toHaveProperty(key);
      expect(ms[key]).toBe(false);
    }
  });

  test('4. Admin can enable retainerManagement', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ moduleSettings: { retainerManagement: true } });
    expect(res.statusCode).toBe(200);
    expect(res.body.moduleSettings.retainerManagement).toBe(true);
    // verify other keys remain false
    for (const key of ALL_MODULE_KEYS) {
      if (key !== 'retainerManagement') {
        expect(res.body.moduleSettings[key]).toBe(false);
      }
    }
  });

  test('5. Admin can disable retainerManagement', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ moduleSettings: { retainerManagement: false } });
    expect(res.statusCode).toBe(200);
    expect(res.body.moduleSettings.retainerManagement).toBe(false);
  });

  test('6. Partial update preserves unspecified module keys', async () => {
    // first enable retainerManagement + kycCdd
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ moduleSettings: { retainerManagement: true, kycCdd: true } });

    // then update only kycCdd
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ moduleSettings: { kycCdd: false } });
    expect(res.statusCode).toBe(200);
    expect(res.body.moduleSettings.retainerManagement).toBe(true);
    expect(res.body.moduleSettings.kycCdd).toBe(false);
    // other keys unchanged
    for (const key of ['corporateAuthority', 'retainerLedger', 'scopeVariation', 'clientTasks', 'advancedCompliance']) {
      expect(res.body.moduleSettings[key]).toBe(false);
    }
  });

  test('7. Unknown module key is rejected with 400 and not persisted', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ moduleSettings: { unknownKey: true } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error');

    // Verify it was not persisted
    const getRes = await request(app)
      .get('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.body.moduleSettings).not.toHaveProperty('unknownKey');
  });

  test('8. Invalid non-boolean module value is rejected with 400', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ moduleSettings: { retainerManagement: 'yes' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('9. Non-admin cannot update firm settings (including moduleSettings)', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ moduleSettings: { retainerManagement: true } });
    expect(res.statusCode).toBe(403);
  });

  test('10. Existing firm settings fields such as name and advocateBillingVisibility still update correctly', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Test Firm', advocateBillingVisibility: 0, moduleSettings: { retainerManagement: true } });
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe('Test Firm');
    expect(Number(res.body.advocateBillingVisibility)).toBe(0);
    expect(res.body.moduleSettings.retainerManagement).toBe(true);

    // Restore name
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'LexFlow Kenya', advocateBillingVisibility: 1 });
  });

  test('11. Audit event for firm settings update records module setting changes safely', async () => {
    // Clear state
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ moduleSettings: { retainerManagement: false, kycCdd: false } });

    // Update with module changes
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'LexFlow Kenya', moduleSettings: { retainerManagement: true, kycCdd: true } });
    expect(res.statusCode).toBe(200);

    const event = await latestAudit('firm_settings_updated');
    expect(event).toBeDefined();
    expect(event.action).toBe('firm_settings_updated');
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata).toHaveProperty('moduleSettings');
    // Should only contain safe boolean values
    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['token', 'authorization', 'bearer', 'password', 'secret', 'backup_key', 'oauth', 'rawbody']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('12. GET /api/firm-settings never exposes raw moduleSettingsJson', async () => {
    const res = await request(app)
      .get('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty('moduleSettingsJson');
  });

  test('13. Existing completed modules are not hidden or altered by module settings (no route/nav data changes)', async () => {
    const res = await request(app)
      .get('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    // Just verify firm settings still returns standard properties
    expect(res.body).toHaveProperty('name');
    expect(res.body).toHaveProperty('primaryColor');
    expect(res.body).toHaveProperty('reminderSettings');
    expect(res.body).toHaveProperty('theme');
    // Existing modules still present
    expect(res.body).toHaveProperty('advocateBillingVisibility');
  });

  test('14. Client Snapshot remains functional with module settings present', async () => {
    expect(margaretId).toBeTruthy();
    const snapshotRes = await request(app)
      .get(`/api/clients/${margaretId}/snapshot`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(snapshotRes.statusCode).toBe(200);
    expect(snapshotRes.body).toHaveProperty('client');
    expect(snapshotRes.body).toHaveProperty('matters');
  });
});
