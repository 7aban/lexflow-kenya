const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let margaretId, unassignedClientId;
let db;
const createdKycIds = [];

function dbAll(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { d.all(sql, params, (e, r) => { d.close(); e ? reject(e) : resolve(r); }); });
}
function dbGet(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { d.get(sql, params, (e, r) => { d.close(); e ? reject(e) : resolve(r); }); });
}
function dbRun(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { d.run(sql, params, function (e) { d.close(); e ? reject(e) : resolve(); }); });
}
async function latestAudit(action) {
  const rows = await dbAll('SELECT * FROM audit_events WHERE action=? ORDER BY timestamp DESC, id DESC LIMIT 1', [action]);
  return rows[0];
}
async function enableKyc(val) {
  await request(app).put('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`).send({ moduleSettings: { kycCdd: val } });
}
async function tableCount(t) { return (await dbGet(`SELECT COUNT(*) AS n FROM ${t}`)).n; }
async function makeKyc(overrides = {}, token = adminToken) {
  const res = await request(app).post('/api/client-kyc').set('Authorization', `Bearer ${token}`).send({ clientId: margaretId, status: 'pending', ...overrides });
  if (res.body && res.body.id) createdKycIds.push(res.body.id);
  return res;
}

beforeAll(async () => {
  await dbReady;
  db = new sqlite3.Database(config.DATABASE_PATH);
  adminToken = (await request(app).post('/api/auth/login').send({ email: 'admin@lexflow.co.ke', password: 'password123' })).body.token;
  advocateToken = (await request(app).post('/api/auth/login').send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' })).body.token;
  assistantToken = (await request(app).post('/api/auth/login').send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' })).body.token;
  clientToken = (await request(app).post('/api/auth/client-login').send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' })).body.token;
  margaretId = (await dbGet("SELECT id FROM clients WHERE name='Margaret Wairimu'")).id;
  const other = await dbGet(`SELECT clientId FROM matters
    WHERE clientId NOT IN (
      SELECT clientId FROM matters WHERE assignedTo=(SELECT fullName FROM users WHERE email='sarah.mwangi@achokilaw.co.ke')
    ) LIMIT 1`);
  unassignedClientId = other.clientId;
});

afterAll(async () => {
  try { for (const id of createdKycIds) await dbRun('DELETE FROM client_kyc_records WHERE id=?', [id]); } catch {}
  try { await enableKyc(false); } catch {}
  try { db.close(); } catch {}
});

describe('RET-31G client KYC / CDD', () => {
  test('1. client_kyc_records table exists with expected columns', async () => {
    const rows = await dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name='client_kyc_records'");
    expect(rows.length).toBe(1);
    const cols = (await dbAll('PRAGMA table_info(client_kyc_records)')).map(c => c.name);
    for (const col of ['id', 'clientId', 'status', 'clientCategory', 'riskLevel', 'idNumber', 'kraPin', 'registrationNumber',
      'verificationDate', 'expiryDate', 'sourceOfFundsSummary', 'pepStatus', 'sanctionsCheckStatus', 'verifiedBy', 'notes',
      'isActive', 'createdBy', 'createdAt']) {
      expect(cols).toContain(col);
    }
  });

  test('2. Module disabled: GET returns 403 feature_disabled', async () => {
    await enableKyc(false);
    const res = await request(app).get('/api/client-kyc').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('3. Module disabled: POST returns 403 feature_disabled', async () => {
    await enableKyc(false);
    const res = await request(app).post('/api/client-kyc').set('Authorization', `Bearer ${adminToken}`).send({ clientId: margaretId });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('4. Module enabled: admin can create KYC record', async () => {
    await enableKyc(true);
    const res = await makeKyc({ status: 'pending', clientCategory: 'individual', riskLevel: 'low' });
    expect(res.statusCode).toBe(201);
    expect(res.body.clientId).toBe(margaretId);
    expect(res.body.status).toBe('pending');
    expect(res.body.clientCategory).toBe('individual');
    expect(res.body.isActive).toBe(true);
  });

  test('5. Module enabled: assistant can create KYC record', async () => {
    await enableKyc(true);
    const res = await makeKyc({ status: 'not_started' }, assistantToken);
    expect(res.statusCode).toBe(201);
  });

  test('6. Advocate assigned to client can create KYC record', async () => {
    await enableKyc(true);
    const res = await makeKyc({ status: 'pending' }, advocateToken);
    expect(res.statusCode).toBe(201);
  });

  test('7. Advocate unassigned gets 403', async () => {
    await enableKyc(true);
    const res = await request(app).post('/api/client-kyc').set('Authorization', `Bearer ${advocateToken}`).send({ clientId: unassignedClientId, status: 'pending' });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/denied/i);
  });

  test('8. Client gets 403', async () => {
    await enableKyc(true);
    const res = await request(app).get('/api/client-kyc').set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('9. Missing clientId rejected', async () => {
    await enableKyc(true);
    const res = await request(app).post('/api/client-kyc').set('Authorization', `Bearer ${adminToken}`).send({ status: 'pending' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/clientId/i);
  });

  test('10. Nonexistent clientId rejected', async () => {
    await enableKyc(true);
    const res = await request(app).post('/api/client-kyc').set('Authorization', `Bearer ${adminToken}`).send({ clientId: 'C-DOES-NOT-EXIST', status: 'pending' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/client not found/i);
  });

  test('11. Invalid status rejected', async () => {
    await enableKyc(true);
    const res = await makeKyc({ status: 'bogus' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });

  test('12. Invalid clientCategory rejected', async () => {
    await enableKyc(true);
    const res = await makeKyc({ clientCategory: 'alien' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/clientCategory/i);
  });

  test('13. Invalid riskLevel rejected', async () => {
    await enableKyc(true);
    const res = await makeKyc({ riskLevel: 'extreme' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/riskLevel/i);
  });

  test('14. Invalid pepStatus rejected', async () => {
    await enableKyc(true);
    const res = await makeKyc({ pepStatus: 'maybe' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/pepStatus/i);
  });

  test('15. Invalid sanctionsCheckStatus rejected', async () => {
    await enableKyc(true);
    const res = await makeKyc({ sanctionsCheckStatus: 'dunno' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/sanctionsCheckStatus/i);
  });

  test('16. Invalid verificationDate rejected', async () => {
    await enableKyc(true);
    const res = await makeKyc({ verificationDate: 'not-a-date' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/verificationDate/i);
  });

  test('17. Invalid expiryDate rejected', async () => {
    await enableKyc(true);
    const res = await makeKyc({ expiryDate: 'nope' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/expiryDate/i);
  });

  test('18. Over-length fields rejected', async () => {
    await enableKyc(true);
    expect((await makeKyc({ idNumber: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await makeKyc({ kraPin: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await makeKyc({ registrationNumber: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await makeKyc({ sourceOfFundsSummary: 'x'.repeat(5001) })).statusCode).toBe(400);
    expect((await makeKyc({ notes: 'x'.repeat(10001) })).statusCode).toBe(400);
  });

  test('19. Admin can update status to verified', async () => {
    await enableKyc(true);
    const c = await makeKyc({ status: 'pending' });
    const res = await request(app).patch(`/api/client-kyc/${c.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'verified', verifiedBy: 'Laban Achoki' });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('verified');
  });

  test('20. clientId immutable on PATCH', async () => {
    await enableKyc(true);
    const c = await makeKyc({ status: 'pending' });
    const res = await request(app).patch(`/api/client-kyc/${c.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ clientId: unassignedClientId });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/clientId cannot be changed/i);
  });

  test('21. soft deactivate marks isActive=0 and row remains', async () => {
    await enableKyc(true);
    const c = await makeKyc({ status: 'pending' });
    const del = await request(app).delete(`/api/client-kyc/${c.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(del.statusCode).toBe(200);
    const row = await dbGet('SELECT id, isActive, deactivatedAt FROM client_kyc_records WHERE id=?', [c.body.id]);
    expect(row).toBeTruthy();
    expect(Number(row.isActive)).toBe(0);
    expect(row.deactivatedAt).toBeTruthy();
  });

  test('22. list excludes inactive unless includeInactive=true', async () => {
    await enableKyc(true);
    const c = await makeKyc({ status: 'pending' });
    await request(app).delete(`/api/client-kyc/${c.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    const active = await request(app).get(`/api/client-kyc?clientId=${margaretId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(active.body.find(x => x.id === c.body.id)).toBeUndefined();
    const all = await request(app).get(`/api/client-kyc?clientId=${margaretId}&includeInactive=true`).set('Authorization', `Bearer ${adminToken}`);
    expect(all.body.find(x => x.id === c.body.id)).toBeTruthy();
  });

  test('23. audit events created for create/update/deactivate', async () => {
    await enableKyc(true);
    const c = await makeKyc({ status: 'pending' });
    expect((await latestAudit('client_kyc_record_created')).entity_id).toBe(c.body.id);
    await request(app).patch(`/api/client-kyc/${c.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'verified' });
    expect((await latestAudit('client_kyc_record_updated')).entity_id).toBe(c.body.id);
    await request(app).delete(`/api/client-kyc/${c.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect((await latestAudit('client_kyc_record_deactivated')).entity_id).toBe(c.body.id);
  });

  test('24. audit metadata excludes sensitive fields', async () => {
    await enableKyc(true);
    const secrets = { idNumber: 'IDTOKEN111', kraPin: 'PINTOKEN222', registrationNumber: 'REGTOKEN333', sourceOfFundsSummary: 'SOFTOKEN444', notes: 'NOTETOKEN555', verifiedBy: 'VBTOKEN666' };
    const c = await makeKyc({ status: 'pending', clientCategory: 'company', riskLevel: 'high', pepStatus: 'pep', sanctionsCheckStatus: 'flagged', ...secrets });
    const audit = await latestAudit('client_kyc_record_created');
    const meta = JSON.parse(audit.metadata_json);
    for (const k of ['idNumber', 'kraPin', 'registrationNumber', 'sourceOfFundsSummary', 'notes', 'pepStatus', 'sanctionsCheckStatus', 'verifiedBy']) {
      expect(meta).not.toHaveProperty(k);
    }
    for (const v of Object.values(secrets)) expect(audit.metadata_json).not.toContain(v);
    // allowed fields present
    expect(meta).toHaveProperty('kycRecordId');
    expect(meta).toHaveProperty('status');
    expect(meta).toHaveProperty('riskLevel');
  });

  test('25. client count and target client core fields unchanged', async () => {
    await enableKyc(true);
    const beforeCount = await tableCount('clients');
    const before = await dbGet('SELECT id, name, email, phone, status FROM clients WHERE id=?', [margaretId]);
    await makeKyc({ status: 'pending', idNumber: '12345678', kraPin: 'A001' });
    const afterCount = await tableCount('clients');
    const after = await dbGet('SELECT id, name, email, phone, status FROM clients WHERE id=?', [margaretId]);
    expect(afterCount).toBe(beforeCount);
    expect(after).toEqual(before);
  });

  test('26. no matters/invoices/payments/retainer/fee-plan/ledger rows mutated', async () => {
    await enableKyc(true);
    const tables = ['matters', 'invoices', 'payments', 'retainer_records', 'matter_fee_plans', 'retainer_ledger_entries'];
    const before = {};
    for (const t of tables) before[t] = await tableCount(t);
    const c = await makeKyc({ status: 'pending' });
    await request(app).patch(`/api/client-kyc/${c.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'verified' });
    for (const t of tables) expect(await tableCount(t)).toBe(before[t]);
  });

  test('27. Client Snapshot kyc hidden when module disabled', async () => {
    await enableKyc(false);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.kyc).toBeTruthy();
    expect(res.body.kyc.visible).toBe(false);
  });

  test('28. Client Snapshot kyc visible when module enabled', async () => {
    await enableKyc(true);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.kyc.visible).toBe(true);
    expect(res.body.kyc).toHaveProperty('activeCount');
  });

  test('29. Snapshot kyc excludes sensitive PII fields', async () => {
    await enableKyc(true);
    await makeKyc({ status: 'verified', idNumber: 'SNAPID999', kraPin: 'SNAPPIN999', registrationNumber: 'SNAPREG999', sourceOfFundsSummary: 'SNAPSOF999', notes: 'SNAPNOTE999' });
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    const latest = res.body.kyc.latest || {};
    expect(latest).not.toHaveProperty('idNumber');
    expect(latest).not.toHaveProperty('kraPin');
    expect(latest).not.toHaveProperty('registrationNumber');
    expect(latest).not.toHaveProperty('sourceOfFundsSummary');
    expect(latest).not.toHaveProperty('notes');
    expect(JSON.stringify(res.body.kyc)).not.toContain('SNAPID999');
    expect(JSON.stringify(res.body.kyc)).not.toContain('SNAPSOF999');
  });

  test('30. No client-facing route exposes KYC data', async () => {
    await enableKyc(true);
    // client cannot read KYC list, single record, or the staff-only snapshot
    expect((await request(app).get(`/api/client-kyc?clientId=${margaretId}`).set('Authorization', `Bearer ${clientToken}`)).statusCode).toBe(403);
    expect((await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${clientToken}`)).statusCode).toBe(403);
  });

  test('31. RET-31F ledger route remains green (smoke)', async () => {
    // ledger requires both modules; just confirm gating still responds (403 feature_disabled when off)
    const res = await request(app).get(`/api/retainer-ledger?clientId=${margaretId}`).set('Authorization', `Bearer ${adminToken}`);
    expect([200, 403]).toContain(res.statusCode);
  });

  test('32. RET-31E fee plan route remains green (smoke)', async () => {
    // fee plan gated by retainerManagement; with it off expect 403 feature_disabled, structurally intact
    const res = await request(app).get(`/api/matter-fee-plans?clientId=${margaretId}`).set('Authorization', `Bearer ${adminToken}`);
    expect([200, 403]).toContain(res.statusCode);
    if (res.statusCode === 403) expect(res.body.error).toBe('feature_disabled');
  });

  test('33. RET-31D retainer route remains green (smoke)', async () => {
    const res = await request(app).get(`/api/retainers?clientId=${margaretId}`).set('Authorization', `Bearer ${adminToken}`);
    expect([200, 403]).toContain(res.statusCode);
  });

  test('34. RET-31B module settings remain green (smoke)', async () => {
    const res = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.moduleSettings).toHaveProperty('kycCdd');
  });

  test('35. Client snapshot core structure remains green (smoke)', async () => {
    await enableKyc(true);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    for (const k of ['client', 'matters', 'billing', 'retainer', 'feePlan', 'ledger', 'kyc']) {
      expect(res.body).toHaveProperty(k);
    }
  });
});
