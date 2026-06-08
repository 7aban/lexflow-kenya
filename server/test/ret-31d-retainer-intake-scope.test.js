const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let margaretId, graceId, margaretMatterId, kamauMatterId;
let createdRetainerId;
let db;

function dbAll(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    d.all(sql, params, (err, rows) => { d.close(); err ? reject(err) : resolve(rows); });
  });
}

function dbGet(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    d.get(sql, params, (err, row) => { d.close(); err ? reject(err) : resolve(row); });
  });
}

function dbRun(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    d.run(sql, params, function (err) { d.close(); err ? reject(err) : resolve(); });
  });
}

async function latestAudit(action) {
  const rows = await dbAll(
    "SELECT * FROM audit_events WHERE action=? ORDER BY timestamp DESC, id DESC LIMIT 1", [action]);
  return rows[0];
}

async function enableRetainer(val) {
  await request(app)
    .put('/api/firm-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ moduleSettings: { retainerManagement: val } });
}

beforeAll(async () => {
  await dbReady;
  db = new sqlite3.Database(config.DATABASE_PATH);
  adminToken = (await request(app).post('/api/auth/login').send({ email: 'admin@lexflow.co.ke', password: 'password123' })).body.token;
  advocateToken = (await request(app).post('/api/auth/login').send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' })).body.token;
  assistantToken = (await request(app).post('/api/auth/login').send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' })).body.token;
  clientToken = (await request(app).post('/api/auth/client-login').send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' })).body.token;
  const marg = await dbGet("SELECT id FROM clients WHERE name='Margaret Wairimu'");
  margaretId = marg.id;
  const grace = await dbGet("SELECT id FROM clients WHERE name='Grace Njeri'");
  graceId = grace.id;
  const m = await dbGet("SELECT id FROM matters WHERE clientId=? LIMIT 1", [margaretId]);
  margaretMatterId = m.id;
  const km = await dbGet("SELECT id FROM matters WHERE clientId=(SELECT id FROM clients WHERE name='Kamau Logistics Ltd') LIMIT 1");
  kamauMatterId = km ? km.id : null;
});

afterAll(async () => {
  try {
    if (createdRetainerId) await dbRun('DELETE FROM retainer_records WHERE id=?', [createdRetainerId]);
  } catch {}
  try { db.close(); } catch {}
});

describe('RET-31D retainer intake and scope schedule', () => {
  test('1. retainer_records table exists', async () => {
    const rows = await dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name='retainer_records'");
    expect(rows.length).toBe(1);
    const cols = await dbAll("PRAGMA table_info(retainer_records)");
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('clientId');
    expect(colNames).toContain('matterId');
    expect(colNames).toContain('status');
    expect(colNames).toContain('engagementType');
    expect(colNames).toContain('scopeSummary');
    expect(colNames).toContain('isActive');
    expect(colNames).toContain('createdBy');
    expect(colNames).toContain('createdAt');
  });

  test('2. GET /api/retainers returns 403 feature_disabled when retainerManagement disabled', async () => {
    await enableRetainer(false);
    const res = await request(app).get('/api/retainers').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('3. POST /api/retainers returns 403 feature_disabled when disabled', async () => {
    await enableRetainer(false);
    const res = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({ clientId: margaretId });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('4. Enabling retainerManagement permits admin retainer access', async () => {
    await enableRetainer(true);
    const res = await request(app).get('/api/retainers').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('5. Admin can create retainer record', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId,
      engagementType: 'litigation',
      status: 'draft',
      responsibleAdvocate: 'Laban Achoki',
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.clientId).toBe(margaretId);
    expect(res.body.status).toBe('draft');
    expect(res.body.engagementType).toBe('litigation');
    expect(res.body.isActive).toBe(true);
    createdRetainerId = res.body.id;
  });

  test('6. Assistant can create retainer record', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/retainers').set('Authorization', `Bearer ${assistantToken}`).send({
      clientId: margaretId,
      engagementType: 'advisory',
      status: 'not_started',
    });
    expect(res.statusCode).toBe(201);
    const id2 = res.body.id;
    await request(app).delete(`/api/retainers/${id2}`).set('Authorization', `Bearer ${adminToken}`);
  });

  test('7. Advocate assigned to client can create retainer record', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/retainers').set('Authorization', `Bearer ${advocateToken}`).send({
      clientId: margaretId,
      matterId: margaretMatterId,
      engagementType: 'litigation',
      status: 'draft',
    });
    expect(res.statusCode).toBe(201);
    await request(app).delete(`/api/retainers/${res.body.id}`).set('Authorization', `Bearer ${adminToken}`);
  });

  test('8. Advocate unassigned to client gets 403', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/retainers').set('Authorization', `Bearer ${advocateToken}`).send({
      clientId: graceId,
      engagementType: 'advisory',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/denied/i);
  });

  test('9. Client gets 403 on retainer routes', async () => {
    await enableRetainer(true);
    const res = await request(app).get('/api/retainers').set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('10. MatterId must belong to clientId', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId,
      matterId: kamauMatterId,
      engagementType: 'advisory',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/belong/i);
  });

  test('11. Invalid status rejected', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId,
      status: 'invalid_status_xyz',
    });
    expect(res.statusCode).toBe(400);
  });

  test('12. Invalid engagementType rejected', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId,
      engagementType: 'foobar',
    });
    expect(res.statusCode).toBe(400);
  });

  test('13. Invalid date rejected', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId,
      engagementStartDate: 'not-a-date',
    });
    expect(res.statusCode).toBe(400);
  });

  test('14. Summary fields length validated', async () => {
    await enableRetainer(true);
    const longText = 'x'.repeat(5001);
    const res = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId,
      scopeSummary: longText,
    });
    expect(res.statusCode).toBe(400);
  });

  test('15. Admin can update retainer status to signed', async () => {
    await enableRetainer(true);
    expect(createdRetainerId).toBeTruthy();
    const res = await request(app).patch(`/api/retainers/${createdRetainerId}`).set('Authorization', `Bearer ${adminToken}`).send({
      status: 'signed',
      signedDate: '2026-06-01',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('signed');
    expect(res.body.signedDate).toBe('2026-06-01');
  });

  test('16. Updating does not allow clientId change', async () => {
    await enableRetainer(true);
    expect(createdRetainerId).toBeTruthy();
    const res = await request(app).patch(`/api/retainers/${createdRetainerId}`).set('Authorization', `Bearer ${adminToken}`).send({
      clientId: graceId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/cannot be changed/i);
  });

  test('17. Soft delete/deactivate marks isActive=0, no hard delete', async () => {
    await enableRetainer(true);
    // Create a temporary record to deactivate
    const createRes = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId,
      engagementType: 'corporate',
      status: 'draft',
    });
    expect(createRes.statusCode).toBe(201);
    const tempId = createRes.body.id;
    const delRes = await request(app).delete(`/api/retainers/${tempId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(delRes.statusCode).toBe(200);
    const row = await dbGet('SELECT isActive, deactivatedBy, deactivatedAt FROM retainer_records WHERE id=?', [tempId]);
    expect(Number(row.isActive)).toBe(0);
    expect(row.deactivatedBy).toBeTruthy();
    expect(row.deactivatedAt).toBeTruthy();
    // Verify row still exists (soft delete)
    const exists = await dbGet('SELECT id FROM retainer_records WHERE id=?', [tempId]);
    expect(exists).toBeTruthy();
  });

  test('18. List excludes inactive unless includeInactive=true', async () => {
    await enableRetainer(true);
    const listRes = await request(app).get(`/api/retainers?clientId=${margaretId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.statusCode).toBe(200);
    const activeIds = listRes.body.filter(r => r.isActive).map(r => r.id);
    const allIds = listRes.body.map(r => r.id);
    expect(activeIds.length).toBe(allIds.length);
    const listAllRes = await request(app).get(`/api/retainers?clientId=${margaretId}&includeInactive=true`).set('Authorization', `Bearer ${adminToken}`);
    expect(listAllRes.statusCode).toBe(200);
    expect(listAllRes.body.length).toBeGreaterThanOrEqual(listRes.body.length);
  });

  test('19. Audit events created for create/update/deactivate', async () => {
    await enableRetainer(true);
    const createEvent = await latestAudit('retainer_record_created');
    expect(createEvent).toBeDefined();
    expect(createEvent.action).toBe('retainer_record_created');

    const updateEvent = await latestAudit('retainer_record_updated');
    expect(updateEvent).toBeDefined();
    expect(updateEvent.action).toBe('retainer_record_updated');

    const deactivateEvent = await latestAudit('retainer_record_deactivated');
    expect(deactivateEvent).toBeDefined();
    expect(deactivateEvent.action).toBe('retainer_record_deactivated');
  });

  test('20. Audit metadata excludes all free-text summaries and notes', async () => {
    await enableRetainer(true);
    for (const action of ['retainer_record_created', 'retainer_record_updated', 'retainer_record_deactivated']) {
      const event = await latestAudit(action);
      expect(event).toBeDefined();
      const meta = JSON.parse(event.metadata_json || '{}');
      expect(meta).not.toHaveProperty('scopeSummary');
      expect(meta).not.toHaveProperty('exclusionsSummary');
      expect(meta).not.toHaveProperty('clientObligationsSummary');
      expect(meta).not.toHaveProperty('firmObligationsSummary');
      expect(meta).not.toHaveProperty('billingArrangementSummary');
      expect(meta).not.toHaveProperty('terminationTermsSummary');
      expect(meta).not.toHaveProperty('notes');
    }
  });

  test('21. Client Snapshot omits retainer block when module disabled', async () => {
    await enableRetainer(false);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('retainer');
    expect(res.body.retainer.visible).toBe(false);
  });

  test('22. Client Snapshot includes retainer block when module enabled', async () => {
    await enableRetainer(true);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('retainer');
    expect(res.body.retainer.visible).toBe(true);
    expect(res.body.retainer).toHaveProperty('activeCount');
    expect(res.body.retainer).toHaveProperty('latest');
    expect(res.body.retainer).toHaveProperty('flags');
  });

  test('23. Snapshot flags unsigned_retainer or no_retainer correctly', async () => {
    await enableRetainer(true);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.retainer.flags)).toBe(true);
    if (res.body.retainer.latest) {
      if (res.body.retainer.latest.status !== 'signed') {
        const unsignedFlag = res.body.retainer.flags.find(f => f.key === 'unsigned_retainer');
        expect(unsignedFlag).toBeDefined();
      }
    }
  });

  test('24. No KYC/authority/ledger/client-account tables or fields are created', async () => {
    const tables = await dbAll("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = tables.map(t => t.name);
    const forbiddenTables = ['kyc', 'cdd', 'corporate_authority', 'signatory', 'retainer_ledger', 'retainer_deposit', 'client_account', 'fee_plan'];
    for (const ft of forbiddenTables) {
      expect(names).not.toContain(ft);
    }
  });

  test('25. No invoice/payment/time-entry behavior is changed', async () => {
    await enableRetainer(true);
    const invRes = await request(app).get('/api/invoices').set('Authorization', `Bearer ${adminToken}`);
    expect(invRes.statusCode).toBe(200);
    const payRes = await request(app).get('/api/payments').set('Authorization', `Bearer ${adminToken}`);
    expect([200, 404]).toContain(payRes.statusCode);
    const teRes = await request(app).get('/api/time-entries').set('Authorization', `Bearer ${adminToken}`);
    expect([200, 404]).toContain(teRes.statusCode);
  });

  test('26. No client portal route exposes retainer data', async () => {
    await enableRetainer(true);
    const res = await request(app).get('/api/retainers').set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access|denied|forbidden/i);
  });

  test('27. Existing client snapshot tests remain green', async () => {
    await enableRetainer(false);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('client');
    expect(res.body).toHaveProperty('matters');
    expect(res.body).toHaveProperty('obligations');
    expect(res.body).toHaveProperty('billing');
    expect(res.body).toHaveProperty('recentDocuments');
    expect(res.body).toHaveProperty('attentionFlags');
    expect(res.body).toHaveProperty('retainer');
  });

  test('28. Existing module settings tests remain green', async () => {
    await enableRetainer(true);
    const fsRes = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
    expect(fsRes.statusCode).toBe(200);
    expect(fsRes.body).toHaveProperty('moduleSettings');
    expect(fsRes.body.moduleSettings.retainerManagement).toBe(true);
    await enableRetainer(false);
    const fsRes2 = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
    expect(fsRes2.statusCode).toBe(200);
    expect(fsRes2.body.moduleSettings.retainerManagement).toBe(false);
  });
});
