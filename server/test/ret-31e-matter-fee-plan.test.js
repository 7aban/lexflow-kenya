const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let margaretId, margaretMatterId;
let unassignedClientId, unassignedMatterId;
let db;
const createdFeePlanIds = [];
const createdRetainerIds = [];

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
    'SELECT * FROM audit_events WHERE action=? ORDER BY timestamp DESC, id DESC LIMIT 1', [action]);
  return rows[0];
}

async function enableRetainer(val) {
  await request(app)
    .put('/api/firm-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ moduleSettings: { retainerManagement: val } });
}

async function tableCount(table) {
  const row = await dbGet(`SELECT COUNT(*) AS n FROM ${table}`);
  return row.n;
}

// Create an active retainer directly (helper for linkage tests). Returns id.
async function makeRetainer({ clientId, matterId }) {
  await enableRetainer(true);
  const res = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
    clientId, matterId, engagementType: 'litigation', status: 'draft',
  });
  createdRetainerIds.push(res.body.id);
  return res.body.id;
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
  const m = await dbGet('SELECT id FROM matters WHERE clientId=? LIMIT 1', [margaretId]);
  margaretMatterId = m.id;
  // Find a client+matter NOT assigned to the advocate (Sarah Mwangi) for the unassigned-access test.
  const other = await dbGet(`SELECT id, clientId FROM matters
    WHERE clientId NOT IN (
      SELECT clientId FROM matters WHERE assignedTo=(SELECT fullName FROM users WHERE email='sarah.mwangi@achokilaw.co.ke')
    ) LIMIT 1`);
  unassignedClientId = other.clientId;
  unassignedMatterId = other.id;
});

afterAll(async () => {
  try { for (const id of createdFeePlanIds) await dbRun('DELETE FROM matter_fee_plans WHERE id=?', [id]); } catch {}
  try { for (const id of createdRetainerIds) await dbRun('DELETE FROM retainer_records WHERE id=?', [id]); } catch {}
  try { await enableRetainer(false); } catch {}
  try { db.close(); } catch {}
});

describe('RET-31E matter fee plan', () => {
  test('1. matter_fee_plans table exists with expected columns', async () => {
    const rows = await dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name='matter_fee_plans'");
    expect(rows.length).toBe(1);
    const cols = (await dbAll('PRAGMA table_info(matter_fee_plans)')).map(c => c.name);
    for (const col of ['id', 'clientId', 'matterId', 'retainerId', 'feeType', 'currency', 'estimatedAmount',
      'hourlyRate', 'capAmount', 'depositRequired', 'billingFrequency', 'paymentTerms', 'vatTreatment',
      'disbursementsTreatment', 'status', 'notes', 'isActive', 'createdBy', 'createdAt']) {
      expect(cols).toContain(col);
    }
  });

  test('2. Module disabled: GET returns 403 feature_disabled', async () => {
    await enableRetainer(false);
    const res = await request(app).get('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('3. Module disabled: POST returns 403 feature_disabled', async () => {
    await enableRetainer(false);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('4. Module enabled: admin can create fee plan', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', status: 'draft',
      currency: 'KES', estimatedAmount: 150000,
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.clientId).toBe(margaretId);
    expect(res.body.matterId).toBe(margaretMatterId);
    expect(res.body.feeType).toBe('fixed');
    expect(res.body.estimatedAmount).toBe(150000);
    expect(res.body.isActive).toBe(true);
    createdFeePlanIds.push(res.body.id);
  });

  test('5. Module enabled: assistant can create fee plan', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${assistantToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'hourly', hourlyRate: 12000,
    });
    expect(res.statusCode).toBe(201);
    createdFeePlanIds.push(res.body.id);
  });

  test('6. Advocate assigned to client/matter can create fee plan', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${advocateToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'capped', capAmount: 500000,
    });
    expect(res.statusCode).toBe(201);
    createdFeePlanIds.push(res.body.id);
  });

  test('7. Advocate unassigned gets 403', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${advocateToken}`).send({
      clientId: unassignedClientId, matterId: unassignedMatterId, feeType: 'fixed',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/denied/i);
  });

  test('8. Client gets 403', async () => {
    await enableRetainer(true);
    const res = await request(app).get('/api/matter-fee-plans').set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('9. matterId must belong to clientId', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: unassignedMatterId, feeType: 'fixed',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/belong/i);
  });

  test('10. retainerId must belong to same client and matter', async () => {
    await enableRetainer(true);
    // Retainer with no matterId on the same client -> matter mismatch.
    const noMatterRet = await makeRetainer({ clientId: margaretId });
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', retainerId: noMatterRet,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/retainerId does not belong to this matter/i);
    // A valid retainer on the same client+matter should be accepted.
    const validRet = await makeRetainer({ clientId: margaretId, matterId: margaretMatterId });
    const ok = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'retainer', retainerId: validRet,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.body.retainerId).toBe(validRet);
    createdFeePlanIds.push(ok.body.id);
  });

  test('11. inactive retainerId rejected', async () => {
    await enableRetainer(true);
    const ret = await makeRetainer({ clientId: margaretId, matterId: margaretMatterId });
    await request(app).delete(`/api/retainers/${ret}`).set('Authorization', `Bearer ${adminToken}`);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', retainerId: ret,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not active/i);
  });

  test('12. invalid feeType rejected', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'totally_invalid',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/feeType/i);
  });

  test('13. invalid status rejected', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', status: 'nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });

  test('14. invalid billingFrequency rejected', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', billingFrequency: 'fortnightly',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/billingFrequency/i);
  });

  test('15. invalid vatTreatment rejected', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', vatTreatment: 'maybe',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/vatTreatment/i);
  });

  test('16. invalid disbursementsTreatment rejected', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', disbursementsTreatment: 'whatever',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/disbursementsTreatment/i);
  });

  test('17. negative numeric values rejected', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', estimatedAmount: -1,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/greater than or equal to 0/i);
  });

  test('18. NaN/non-numeric numeric values rejected', async () => {
    await enableRetainer(true);
    const res = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', hourlyRate: 'abc',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/valid number/i);
  });

  test('19. over-length paymentTerms/notes rejected', async () => {
    await enableRetainer(true);
    const longTerms = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', paymentTerms: 'x'.repeat(5001),
    });
    expect(longTerms.statusCode).toBe(400);
    expect(longTerms.body.error).toMatch(/paymentTerms/i);
    const longNotes = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', notes: 'y'.repeat(10001),
    });
    expect(longNotes.statusCode).toBe(400);
    expect(longNotes.body.error).toMatch(/notes/i);
  });

  test('20. admin can update status to approved', async () => {
    await enableRetainer(true);
    const id = createdFeePlanIds[0];
    const res = await request(app).patch(`/api/matter-fee-plans/${id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'approved' });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('approved');
  });

  test('21. clientId/matterId immutable on PATCH', async () => {
    await enableRetainer(true);
    const id = createdFeePlanIds[0];
    const c = await request(app).patch(`/api/matter-fee-plans/${id}`).set('Authorization', `Bearer ${adminToken}`).send({ clientId: unassignedClientId });
    expect(c.statusCode).toBe(400);
    expect(c.body.error).toMatch(/clientId cannot be changed/i);
    const m = await request(app).patch(`/api/matter-fee-plans/${id}`).set('Authorization', `Bearer ${adminToken}`).send({ matterId: unassignedMatterId });
    expect(m.statusCode).toBe(400);
    expect(m.body.error).toMatch(/matterId cannot be changed/i);
  });

  test('22. soft deactivate marks isActive=0 and row remains', async () => {
    await enableRetainer(true);
    const create = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed',
    });
    const id = create.body.id;
    createdFeePlanIds.push(id);
    const del = await request(app).delete(`/api/matter-fee-plans/${id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(del.statusCode).toBe(200);
    const row = await dbGet('SELECT id, isActive, deactivatedAt FROM matter_fee_plans WHERE id=?', [id]);
    expect(row).toBeTruthy();
    expect(Number(row.isActive)).toBe(0);
    expect(row.deactivatedAt).toBeTruthy();
  });

  test('23. list excludes inactive unless includeInactive=true', async () => {
    await enableRetainer(true);
    const create = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed',
    });
    const id = create.body.id;
    createdFeePlanIds.push(id);
    await request(app).delete(`/api/matter-fee-plans/${id}`).set('Authorization', `Bearer ${adminToken}`);
    const active = await request(app).get(`/api/matter-fee-plans?clientId=${margaretId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(active.body.find(p => p.id === id)).toBeUndefined();
    const withInactive = await request(app).get(`/api/matter-fee-plans?clientId=${margaretId}&includeInactive=true`).set('Authorization', `Bearer ${adminToken}`);
    expect(withInactive.body.find(p => p.id === id)).toBeTruthy();
  });

  test('24. audit events created for create/update/deactivate', async () => {
    await enableRetainer(true);
    const create = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed',
    });
    const id = create.body.id;
    createdFeePlanIds.push(id);
    const createdAudit = await latestAudit('matter_fee_plan_created');
    expect(createdAudit).toBeTruthy();
    expect(createdAudit.entity_id).toBe(id);
    await request(app).patch(`/api/matter-fee-plans/${id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'proposed' });
    const updatedAudit = await latestAudit('matter_fee_plan_updated');
    expect(updatedAudit).toBeTruthy();
    expect(updatedAudit.entity_id).toBe(id);
    await request(app).delete(`/api/matter-fee-plans/${id}`).set('Authorization', `Bearer ${adminToken}`);
    const deactivatedAudit = await latestAudit('matter_fee_plan_deactivated');
    expect(deactivatedAudit).toBeTruthy();
    expect(deactivatedAudit.entity_id).toBe(id);
  });

  test('25. audit metadata excludes notes/paymentTerms/disbursement text', async () => {
    await enableRetainer(true);
    const secretNote = 'SENSITIVE_NOTE_TOKEN_12345';
    const secretTerms = 'SENSITIVE_TERMS_TOKEN_67890';
    const create = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed',
      notes: secretNote, paymentTerms: secretTerms, disbursementsTreatment: 'included',
    });
    createdFeePlanIds.push(create.body.id);
    const audit = await latestAudit('matter_fee_plan_created');
    const meta = JSON.parse(audit.metadata_json);
    expect(meta).not.toHaveProperty('notes');
    expect(meta).not.toHaveProperty('paymentTerms');
    expect(meta).not.toHaveProperty('disbursementsTreatment');
    expect(audit.metadata_json).not.toContain(secretNote);
    expect(audit.metadata_json).not.toContain(secretTerms);
    // Allowed fields present.
    expect(meta).toHaveProperty('feePlanId');
    expect(meta).toHaveProperty('feeType');
    expect(meta).toHaveProperty('status');
  });

  test('26. no invoice rows created or mutated', async () => {
    await enableRetainer(true);
    const before = await tableCount('invoices');
    const create = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', estimatedAmount: 99999,
    });
    createdFeePlanIds.push(create.body.id);
    await request(app).patch(`/api/matter-fee-plans/${create.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'approved' });
    const after = await tableCount('invoices');
    expect(after).toBe(before);
  });

  test('27. no payment rows created or mutated', async () => {
    await enableRetainer(true);
    const before = await tableCount('payments');
    const create = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed', depositRequired: 25000,
    });
    createdFeePlanIds.push(create.body.id);
    const after = await tableCount('payments');
    expect(after).toBe(before);
  });

  test('28. no time_entry rows created or mutated', async () => {
    await enableRetainer(true);
    const before = await tableCount('time_entries');
    const create = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'hourly', hourlyRate: 15000,
    });
    createdFeePlanIds.push(create.body.id);
    const after = await tableCount('time_entries');
    expect(after).toBe(before);
  });

  test('29. Client Snapshot hides feePlan block when module disabled', async () => {
    await enableRetainer(false);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.feePlan).toBeTruthy();
    expect(res.body.feePlan.visible).toBe(false);
  });

  test('30. Client Snapshot includes feePlan block when module enabled', async () => {
    await enableRetainer(true);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.feePlan.visible).toBe(true);
    expect(res.body.feePlan).toHaveProperty('activeCount');
    expect(typeof res.body.feePlan.activeCount).toBe('number');
  });

  test('31. Existing RET-31D retainer routes remain green (smoke)', async () => {
    await enableRetainer(true);
    const create = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, status: 'draft', engagementType: 'advisory',
    });
    expect(create.statusCode).toBe(201);
    createdRetainerIds.push(create.body.id);
    const getOne = await request(app).get(`/api/retainers/${create.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(getOne.statusCode).toBe(200);
    expect(getOne.body.id).toBe(create.body.id);
  });

  test('32. Existing RET-31B module settings remain green (smoke)', async () => {
    const res = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.moduleSettings).toHaveProperty('retainerManagement');
  });

  test('33. Client snapshot core structure remains green (smoke)', async () => {
    await enableRetainer(true);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('client');
    expect(res.body).toHaveProperty('matters');
    expect(res.body).toHaveProperty('billing');
    expect(res.body).toHaveProperty('retainer');
    expect(res.body).toHaveProperty('feePlan');
  });
});
