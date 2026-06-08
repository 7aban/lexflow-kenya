const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let margaretId, margaretMatterId;
let unassignedClientId, unassignedMatterId;
let activeRetainerId, activeFeePlanId;
let db;
const createdLedgerIds = [];
const createdRetainerIds = [];
const createdFeePlanIds = [];

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
  const rows = await dbAll('SELECT * FROM audit_events WHERE action=? ORDER BY timestamp DESC, id DESC LIMIT 1', [action]);
  return rows[0];
}
async function setModules(retainerManagement, retainerLedger) {
  await request(app).put('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`)
    .send({ moduleSettings: { retainerManagement, retainerLedger } });
}
async function tableCount(table) {
  const row = await dbGet(`SELECT COUNT(*) AS n FROM ${table}`);
  return row.n;
}
async function makeEntry(overrides = {}) {
  const res = await request(app).post('/api/retainer-ledger').set('Authorization', `Bearer ${adminToken}`).send({
    clientId: margaretId, entryType: 'deposit', direction: 'credit', amount: 10000, currency: 'KES', entryDate: '2026-06-01', ...overrides,
  });
  if (res.body && res.body.id) createdLedgerIds.push(res.body.id);
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
  margaretMatterId = (await dbGet('SELECT id FROM matters WHERE clientId=? LIMIT 1', [margaretId])).id;
  const other = await dbGet(`SELECT id, clientId FROM matters
    WHERE clientId NOT IN (
      SELECT clientId FROM matters WHERE assignedTo=(SELECT fullName FROM users WHERE email='sarah.mwangi@achokilaw.co.ke')
    ) LIMIT 1`);
  unassignedClientId = other.clientId;
  unassignedMatterId = other.id;
  // Seed an active retainer + active fee plan on margaret+margaretMatter for linkage tests.
  await setModules(true, true);
  const ret = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
    clientId: margaretId, matterId: margaretMatterId, status: 'draft', engagementType: 'litigation',
  });
  activeRetainerId = ret.body.id;
  createdRetainerIds.push(activeRetainerId);
  const fp = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
    clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed',
  });
  activeFeePlanId = fp.body.id;
  createdFeePlanIds.push(activeFeePlanId);
});

afterAll(async () => {
  try { for (const id of createdLedgerIds) await dbRun('DELETE FROM retainer_ledger_entries WHERE id=?', [id]); } catch {}
  try { for (const id of createdFeePlanIds) await dbRun('DELETE FROM matter_fee_plans WHERE id=?', [id]); } catch {}
  try { for (const id of createdRetainerIds) await dbRun('DELETE FROM retainer_records WHERE id=?', [id]); } catch {}
  try { await setModules(false, false); } catch {}
  try { db.close(); } catch {}
});

describe('RET-31F retainer ledger', () => {
  test('1. retainer_ledger_entries table exists with expected columns', async () => {
    const rows = await dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name='retainer_ledger_entries'");
    expect(rows.length).toBe(1);
    const cols = (await dbAll('PRAGMA table_info(retainer_ledger_entries)')).map(c => c.name);
    for (const col of ['id', 'clientId', 'matterId', 'retainerId', 'feePlanId', 'entryType', 'direction', 'amount',
      'currency', 'entryDate', 'reference', 'description', 'sourceType', 'sourceId', 'isVoided', 'voidedBy', 'voidedAt',
      'voidReason', 'createdBy', 'createdAt']) {
      expect(cols).toContain(col);
    }
  });

  test('2. retainerManagement disabled: GET returns 403 feature_disabled', async () => {
    await setModules(false, true);
    const res = await request(app).get('/api/retainer-ledger').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('3. retainerManagement on but retainerLedger off: GET returns 403 feature_disabled', async () => {
    await setModules(true, false);
    const res = await request(app).get('/api/retainer-ledger').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('4. Both modules enabled: admin can create ledger entry', async () => {
    await setModules(true, true);
    const res = await makeEntry({ amount: 50000 });
    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.clientId).toBe(margaretId);
    expect(res.body.entryType).toBe('deposit');
    expect(res.body.direction).toBe('credit');
    expect(res.body.amount).toBe(50000);
    expect(res.body.isVoided).toBe(false);
  });

  test('5. Assistant can create ledger entry', async () => {
    await setModules(true, true);
    const res = await request(app).post('/api/retainer-ledger').set('Authorization', `Bearer ${assistantToken}`).send({
      clientId: margaretId, entryType: 'deposit', direction: 'credit', amount: 5000, entryDate: '2026-06-02',
    });
    expect(res.statusCode).toBe(201);
    createdLedgerIds.push(res.body.id);
  });

  test('6. Advocate assigned to client/matter can create ledger entry', async () => {
    await setModules(true, true);
    const res = await request(app).post('/api/retainer-ledger').set('Authorization', `Bearer ${advocateToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, entryType: 'deposit', direction: 'credit', amount: 7000, entryDate: '2026-06-03',
    });
    expect(res.statusCode).toBe(201);
    createdLedgerIds.push(res.body.id);
  });

  test('7. Advocate unassigned gets 403', async () => {
    await setModules(true, true);
    const res = await request(app).post('/api/retainer-ledger').set('Authorization', `Bearer ${advocateToken}`).send({
      clientId: unassignedClientId, matterId: unassignedMatterId, entryType: 'deposit', direction: 'credit', amount: 1000, entryDate: '2026-06-03',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/denied/i);
  });

  test('8. Client gets 403', async () => {
    await setModules(true, true);
    const res = await request(app).get('/api/retainer-ledger').set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('9. Invalid entryType rejected', async () => {
    await setModules(true, true);
    const res = await makeEntry({ entryType: 'bogus' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/entryType/i);
  });

  test('10. Invalid direction rejected', async () => {
    await setModules(true, true);
    const res = await makeEntry({ entryType: 'adjustment', direction: 'sideways' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/direction/i);
  });

  test('11. Direction mismatch rejected', async () => {
    await setModules(true, true);
    const res = await makeEntry({ entryType: 'deposit', direction: 'debit' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/deposit must be a credit/i);
  });

  test('12. Zero amount rejected', async () => {
    await setModules(true, true);
    const res = await makeEntry({ amount: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/greater than 0/i);
  });

  test('13. Negative amount rejected', async () => {
    await setModules(true, true);
    const res = await makeEntry({ amount: -100 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/greater than 0/i);
  });

  test('14. NaN/non-numeric amount rejected', async () => {
    await setModules(true, true);
    const res = await makeEntry({ amount: 'abc' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/valid number/i);
  });

  test('15. Invalid entryDate rejected', async () => {
    await setModules(true, true);
    const res = await makeEntry({ entryDate: 'not-a-date' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/entryDate/i);
  });

  test('16. matterId must belong to clientId', async () => {
    await setModules(true, true);
    const res = await makeEntry({ matterId: unassignedMatterId });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/belong/i);
  });

  test('17. retainerId must belong to same client and matter when matter supplied', async () => {
    await setModules(true, true);
    // active retainer is on margaretMatterId; supply a different (unassigned) matter that does not match.
    const res = await makeEntry({ matterId: margaretMatterId, retainerId: activeRetainerId });
    expect(res.statusCode).toBe(201); // valid linkage
    // Now mismatch: retainer belongs to margaret but state a different client via unassigned client is not same client.
    const mismatch = await request(app).post('/api/retainer-ledger').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: unassignedClientId, retainerId: activeRetainerId, entryType: 'deposit', direction: 'credit', amount: 1000, entryDate: '2026-06-01',
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body.error).toMatch(/retainerId does not belong/i);
  });

  test('18. inactive retainerId rejected', async () => {
    await setModules(true, true);
    const ret = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, status: 'draft',
    });
    createdRetainerIds.push(ret.body.id);
    await request(app).delete(`/api/retainers/${ret.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    const res = await makeEntry({ retainerId: ret.body.id });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not active/i);
  });

  test('19. feePlanId must belong to same client and matter when matter supplied', async () => {
    await setModules(true, true);
    const ok = await makeEntry({ matterId: margaretMatterId, feePlanId: activeFeePlanId });
    expect(ok.statusCode).toBe(201);
    const mismatch = await request(app).post('/api/retainer-ledger').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: unassignedClientId, feePlanId: activeFeePlanId, entryType: 'deposit', direction: 'credit', amount: 1000, entryDate: '2026-06-01',
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body.error).toMatch(/feePlanId does not belong/i);
  });

  test('20. inactive feePlanId rejected', async () => {
    await setModules(true, true);
    const fp = await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, feeType: 'fixed',
    });
    createdFeePlanIds.push(fp.body.id);
    await request(app).delete(`/api/matter-fee-plans/${fp.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    const res = await makeEntry({ feePlanId: fp.body.id });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/feePlanId is not active/i);
  });

  test('21. GET list excludes voided unless includeVoided=true', async () => {
    await setModules(true, true);
    const e = await makeEntry({ amount: 1234 });
    await request(app).post(`/api/retainer-ledger/${e.body.id}/void`).set('Authorization', `Bearer ${adminToken}`).send({});
    const active = await request(app).get(`/api/retainer-ledger?clientId=${margaretId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(active.body.find(x => x.id === e.body.id)).toBeUndefined();
    const all = await request(app).get(`/api/retainer-ledger?clientId=${margaretId}&includeVoided=true`).set('Authorization', `Bearer ${adminToken}`);
    expect(all.body.find(x => x.id === e.body.id)).toBeTruthy();
  });

  test('22. Summary computes credit/debit/balance from non-voided entries', async () => {
    await setModules(true, true);
    // Use a fresh dedicated client scope via matterless entries on a fresh fee plan? Use retainerId scope for isolation.
    const ret = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, status: 'draft',
    });
    createdRetainerIds.push(ret.body.id);
    const scopeRet = ret.body.id;
    await makeEntry({ retainerId: scopeRet, entryType: 'deposit', direction: 'credit', amount: 100000 });
    await makeEntry({ retainerId: scopeRet, entryType: 'fee_application', direction: 'debit', amount: 30000 });
    const summary = await request(app).get(`/api/retainer-ledger/summary?clientId=${margaretId}&retainerId=${scopeRet}`).set('Authorization', `Bearer ${adminToken}`);
    expect(summary.statusCode).toBe(200);
    expect(summary.body.totalCredits).toBe(100000);
    expect(summary.body.totalDebits).toBe(30000);
    expect(summary.body.balance).toBe(70000);
    expect(summary.body.entryCount).toBe(2);
  });

  test('23. Summary excludes voided entries', async () => {
    await setModules(true, true);
    const ret = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, status: 'draft',
    });
    createdRetainerIds.push(ret.body.id);
    const scopeRet = ret.body.id;
    await makeEntry({ retainerId: scopeRet, entryType: 'deposit', direction: 'credit', amount: 80000 });
    const toVoid = await makeEntry({ retainerId: scopeRet, entryType: 'deposit', direction: 'credit', amount: 20000 });
    await request(app).post(`/api/retainer-ledger/${toVoid.body.id}/void`).set('Authorization', `Bearer ${adminToken}`).send({});
    const summary = await request(app).get(`/api/retainer-ledger/summary?clientId=${margaretId}&retainerId=${scopeRet}`).set('Authorization', `Bearer ${adminToken}`);
    expect(summary.body.balance).toBe(80000);
    expect(summary.body.entryCount).toBe(1);
  });

  test('24. Mixed currencies grouped without misleading single-currency sum', async () => {
    await setModules(true, true);
    const ret = await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId: margaretId, matterId: margaretMatterId, status: 'draft',
    });
    createdRetainerIds.push(ret.body.id);
    const scopeRet = ret.body.id;
    await makeEntry({ retainerId: scopeRet, currency: 'KES', amount: 1000 });
    await makeEntry({ retainerId: scopeRet, currency: 'USD', amount: 2000 });
    const summary = await request(app).get(`/api/retainer-ledger/summary?clientId=${margaretId}&retainerId=${scopeRet}`).set('Authorization', `Bearer ${adminToken}`);
    expect(summary.body.currency).toBe('MIXED');
    expect(summary.body.balance).toBeNull();
    expect(Array.isArray(summary.body.byCurrency)).toBe(true);
    expect(summary.body.byCurrency.length).toBe(2);
    const kes = summary.body.byCurrency.find(g => g.currency === 'KES');
    const usd = summary.body.byCurrency.find(g => g.currency === 'USD');
    expect(kes.balance).toBe(1000);
    expect(usd.balance).toBe(2000);
  });

  test('25. Void is soft: row remains with isVoided=1', async () => {
    await setModules(true, true);
    const e = await makeEntry({ amount: 4321 });
    const res = await request(app).post(`/api/retainer-ledger/${e.body.id}/void`).set('Authorization', `Bearer ${adminToken}`).send({ voidReason: 'entered in error' });
    expect(res.statusCode).toBe(200);
    expect(res.body.isVoided).toBe(true);
    const row = await dbGet('SELECT id, isVoided, voidedAt FROM retainer_ledger_entries WHERE id=?', [e.body.id]);
    expect(row).toBeTruthy();
    expect(Number(row.isVoided)).toBe(1);
    expect(row.voidedAt).toBeTruthy();
  });

  test('26. Double void returns 409', async () => {
    await setModules(true, true);
    const e = await makeEntry({ amount: 999 });
    await request(app).post(`/api/retainer-ledger/${e.body.id}/void`).set('Authorization', `Bearer ${adminToken}`).send({});
    const second = await request(app).post(`/api/retainer-ledger/${e.body.id}/void`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toMatch(/already voided/i);
  });

  test('27. Audit events created for create and void', async () => {
    await setModules(true, true);
    const e = await makeEntry({ amount: 1500 });
    const createdAudit = await latestAudit('retainer_ledger_entry_created');
    expect(createdAudit).toBeTruthy();
    expect(createdAudit.entity_id).toBe(e.body.id);
    await request(app).post(`/api/retainer-ledger/${e.body.id}/void`).set('Authorization', `Bearer ${adminToken}`).send({});
    const voidAudit = await latestAudit('retainer_ledger_entry_voided');
    expect(voidAudit).toBeTruthy();
    expect(voidAudit.entity_id).toBe(e.body.id);
  });

  test('28. Audit metadata excludes description/reference/voidReason/sourceType/sourceId', async () => {
    await setModules(true, true);
    const secretDesc = 'SECRET_DESC_TOKEN_AAA';
    const secretRef = 'SECRET_REF_TOKEN_BBB';
    const secretReason = 'SECRET_REASON_TOKEN_CCC';
    const e = await makeEntry({ amount: 2222, description: secretDesc, reference: secretRef, sourceType: 'manual', sourceId: 'SRC_TOKEN_DDD' });
    const createdAudit = await latestAudit('retainer_ledger_entry_created');
    const meta = JSON.parse(createdAudit.metadata_json);
    expect(meta).not.toHaveProperty('description');
    expect(meta).not.toHaveProperty('reference');
    expect(meta).not.toHaveProperty('sourceType');
    expect(meta).not.toHaveProperty('sourceId');
    expect(createdAudit.metadata_json).not.toContain(secretDesc);
    expect(createdAudit.metadata_json).not.toContain(secretRef);
    expect(createdAudit.metadata_json).not.toContain('SRC_TOKEN_DDD');
    expect(meta).toHaveProperty('entryType');
    expect(meta).toHaveProperty('amount');
    await request(app).post(`/api/retainer-ledger/${e.body.id}/void`).set('Authorization', `Bearer ${adminToken}`).send({ voidReason: secretReason });
    const voidAudit = await latestAudit('retainer_ledger_entry_voided');
    expect(JSON.parse(voidAudit.metadata_json)).not.toHaveProperty('voidReason');
    expect(voidAudit.metadata_json).not.toContain(secretReason);
  });

  test('29. No invoice rows created or mutated', async () => {
    await setModules(true, true);
    const before = await tableCount('invoices');
    const e = await makeEntry({ amount: 60000 });
    await request(app).post(`/api/retainer-ledger/${e.body.id}/void`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(await tableCount('invoices')).toBe(before);
  });

  test('30. No payment rows created or mutated', async () => {
    await setModules(true, true);
    const before = await tableCount('payments');
    await makeEntry({ amount: 61000 });
    expect(await tableCount('payments')).toBe(before);
  });

  test('31. No payment_proof rows created or mutated', async () => {
    await setModules(true, true);
    const before = await tableCount('payment_proofs');
    await makeEntry({ amount: 62000 });
    expect(await tableCount('payment_proofs')).toBe(before);
  });

  test('32. No time_entry rows created or mutated', async () => {
    await setModules(true, true);
    const before = await tableCount('time_entries');
    await makeEntry({ amount: 63000 });
    expect(await tableCount('time_entries')).toBe(before);
  });

  test('33. matters.retainerBalance remains unchanged', async () => {
    await setModules(true, true);
    const before = await dbGet('SELECT retainerBalance FROM matters WHERE id=?', [margaretMatterId]);
    await makeEntry({ matterId: margaretMatterId, amount: 500000 });
    const after = await dbGet('SELECT retainerBalance FROM matters WHERE id=?', [margaretMatterId]);
    expect(Number(after.retainerBalance || 0)).toBe(Number(before.retainerBalance || 0));
  });

  test('34. Client Snapshot ledger hidden when either module disabled', async () => {
    await setModules(true, false);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.ledger).toBeTruthy();
    expect(res.body.ledger.visible).toBe(false);
  });

  test('35. Client Snapshot ledger visible when both modules enabled', async () => {
    await setModules(true, true);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.ledger.visible).toBe(true);
    expect(res.body.ledger).toHaveProperty('balance');
    expect(res.body.ledger).toHaveProperty('entryCount');
  });

  test('36. Existing RET-31E fee plan route remains green (smoke)', async () => {
    await setModules(true, true);
    const res = await request(app).get(`/api/matter-fee-plans?clientId=${margaretId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('37. Existing RET-31D retainer route remains green (smoke)', async () => {
    await setModules(true, true);
    const res = await request(app).get(`/api/retainers?clientId=${margaretId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('38. Existing RET-31B module settings remain green (smoke)', async () => {
    const res = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.moduleSettings).toHaveProperty('retainerManagement');
    expect(res.body.moduleSettings).toHaveProperty('retainerLedger');
  });

  test('39. Client snapshot core structure remains green (smoke)', async () => {
    await setModules(true, true);
    const res = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('client');
    expect(res.body).toHaveProperty('retainer');
    expect(res.body).toHaveProperty('feePlan');
    expect(res.body).toHaveProperty('ledger');
  });

  test('40. Auth smoke: client cannot create ledger entry (defense in depth)', async () => {
    await setModules(true, true);
    const res = await request(app).post('/api/retainer-ledger').set('Authorization', `Bearer ${clientToken}`).send({
      clientId: margaretId, entryType: 'deposit', direction: 'credit', amount: 100, entryDate: '2026-06-01',
    });
    expect(res.statusCode).toBe(403);
  });
});
