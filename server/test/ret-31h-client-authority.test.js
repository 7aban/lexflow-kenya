const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let margaretId, unassignedClientId;
let db;
const createdAuthorityIds = [];

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
  return rows[0] || null;
}
async function enableCorporateAuthority(val) {
  await request(app).put('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`).send({ moduleSettings: { corporateAuthority: val } });
}
async function tableCount(t) { return (await dbGet(`SELECT COUNT(*) AS n FROM ${t}`)).n; }
async function makeAuthority(overrides = {}, token = adminToken) {
  const res = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${token}`).send({ clientId: margaretId, status: 'pending', ...overrides });
  if (res.body && res.body.id) createdAuthorityIds.push(res.body.id);
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
  try { for (const id of createdAuthorityIds) await dbRun('DELETE FROM client_authority_records WHERE id=?', [id]); } catch {}
  try { await enableCorporateAuthority(false); } catch {}
  try { db.close(); } catch {}
});

describe('RET-31H client authority records', () => {
  test('1. client_authority_records table exists with expected columns', async () => {
    const rows = await dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name='client_authority_records'");
    expect(rows.length).toBe(1);
    const cols = (await dbAll('PRAGMA table_info(client_authority_records)')).map(c => c.name);
    for (const col of ['id', 'clientId', 'status', 'authorityBasis', 'authorisedPersonName', 'authorisedPersonRole',
      'authorisedPersonEmail', 'authorisedPersonPhone', 'authorityDate', 'expiryDate', 'notes',
      'isActive', 'createdBy', 'createdAt']) {
      expect(cols).toContain(col);
    }
  });

  test('2. Module disabled: GET /api/client-authorities returns 403 feature_disabled', async () => {
    await enableCorporateAuthority(false);
    const res = await request(app).get('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('3. Module disabled: POST returns 403 feature_disabled', async () => {
    await enableCorporateAuthority(false);
    const res = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({ clientId: margaretId });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('4. Module enabled: admin can create authority record', async () => {
    await enableCorporateAuthority(true);
    const res = await makeAuthority({ status: 'pending', authorityBasis: 'board_resolution', authorisedPersonName: 'John Doe', authorisedPersonRole: 'Director' });
    expect(res.statusCode).toBe(201);
    expect(res.body.clientId).toBe(margaretId);
    expect(res.body.status).toBe('pending');
    expect(res.body.authorityBasis).toBe('board_resolution');
    expect(res.body.isActive).toBe(true);
  });

  test('5. Module enabled: assistant can create authority record', async () => {
    await enableCorporateAuthority(true);
    const res = await makeAuthority({ status: 'confirmed' }, assistantToken);
    expect(res.statusCode).toBe(201);
  });

  test('6. Advocate assigned to client can create authority record', async () => {
    await enableCorporateAuthority(true);
    const res = await makeAuthority({ status: 'pending' }, advocateToken);
    expect(res.statusCode).toBe(201);
  });

  test('7. Advocate unassigned gets 403', async () => {
    await enableCorporateAuthority(true);
    const res = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${advocateToken}`).send({ clientId: unassignedClientId, status: 'pending' });
    expect(res.statusCode).toBe(403);
  });

  test('8. Client gets 403', async () => {
    await enableCorporateAuthority(true);
    const res = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${clientToken}`).send({ clientId: margaretId, status: 'pending' });
    expect(res.statusCode).toBe(403);
  });

  test('9. Missing clientId rejected', async () => {
    await enableCorporateAuthority(true);
    const res = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({ status: 'pending' });
    expect(res.statusCode).toBe(400);
  });

  test('10. Nonexistent clientId rejected', async () => {
    await enableCorporateAuthority(true);
    const res = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({ clientId: 'nonexistent-id', status: 'pending' });
    expect(res.statusCode).toBe(400);
  });

  test('11. Invalid status rejected', async () => {
    await enableCorporateAuthority(true);
    const res = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({ clientId: margaretId, status: 'invalid_status' });
    expect(res.statusCode).toBe(400);
  });

  test('12. Invalid authorityBasis rejected', async () => {
    await enableCorporateAuthority(true);
    const res = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({ clientId: margaretId, authorityBasis: 'invalid_basis' });
    expect(res.statusCode).toBe(400);
  });

  test('13. Invalid authorityDate rejected', async () => {
    await enableCorporateAuthority(true);
    const res = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({ clientId: margaretId, authorityDate: 'not-a-date' });
    expect(res.statusCode).toBe(400);
  });

  test('14. Invalid expiryDate rejected', async () => {
    await enableCorporateAuthority(true);
    const res = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({ clientId: margaretId, expiryDate: 'not-a-date' });
    expect(res.statusCode).toBe(400);
  });

  test('15. Over-length fields rejected', async () => {
    await enableCorporateAuthority(true);
    const longStr = 'x'.repeat(200);
    const res = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({ clientId: margaretId, authorisedPersonName: longStr });
    expect(res.statusCode).toBe(400);
    const res2 = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({ clientId: margaretId, authorisedPersonRole: longStr });
    expect(res2.statusCode).toBe(400);
    const res3 = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({ clientId: margaretId, authorisedPersonEmail: longStr });
    expect(res3.statusCode).toBe(400);
    const res4 = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({ clientId: margaretId, authorisedPersonPhone: 'x'.repeat(100) });
    expect(res4.statusCode).toBe(400);
    const res5 = await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({ clientId: margaretId, notes: 'x'.repeat(10001) });
    expect(res5.statusCode).toBe(400);
  });

  test('16. Admin can update status to confirmed', async () => {
    await enableCorporateAuthority(true);
    const create = await makeAuthority({ status: 'pending' });
    const res = await request(app).patch(`/api/client-authorities/${create.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'confirmed' });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('confirmed');
  });

  test('17. clientId immutable on PATCH', async () => {
    await enableCorporateAuthority(true);
    const create = await makeAuthority({ status: 'pending' });
    const res = await request(app).patch(`/api/client-authorities/${create.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ clientId: 'some-other-id' });
    expect(res.statusCode).toBe(400);
  });

  test('18. Soft deactivate marks isActive=0 and row remains', async () => {
    await enableCorporateAuthority(true);
    const create = await makeAuthority({ status: 'pending' });
    const del = await request(app).delete(`/api/client-authorities/${create.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(del.statusCode).toBe(200);
    const row = await dbGet('SELECT isActive, deactivatedBy, deactivatedAt FROM client_authority_records WHERE id=?', [create.body.id]);
    expect(row.isActive).toBe(0);
    expect(row.deactivatedBy).toBeTruthy();
    expect(row.deactivatedAt).toBeTruthy();
  });

  test('19. List excludes inactive unless includeInactive=true', async () => {
    await enableCorporateAuthority(true);
    const create = await makeAuthority({ status: 'pending' });
    await request(app).delete(`/api/client-authorities/${create.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    const list = await request(app).get(`/api/client-authorities?clientId=${margaretId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.every(r => r.isActive)).toBe(true);
    const listWithInactive = await request(app).get(`/api/client-authorities?clientId=${margaretId}&includeInactive=true`).set('Authorization', `Bearer ${adminToken}`);
    const found = listWithInactive.body.find(r => r.id === create.body.id);
    expect(found).toBeTruthy();
    expect(found.isActive).toBe(false);
  });

  test('20. Audit events created for create/update/deactivate', async () => {
    await enableCorporateAuthority(true);
    const create = await makeAuthority({ status: 'pending' });
    const auditCreated = await latestAudit('client_authority_record_created');
    expect(auditCreated).toBeTruthy();
    expect(auditCreated.entity_id).toBe(create.body.id);
    await request(app).patch(`/api/client-authorities/${create.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'confirmed' });
    const auditUpdated = await latestAudit('client_authority_record_updated');
    expect(auditUpdated).toBeTruthy();
    expect(auditUpdated.entity_id).toBe(create.body.id);
    await request(app).delete(`/api/client-authorities/${create.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    const auditDeactivated = await latestAudit('client_authority_record_deactivated');
    expect(auditDeactivated).toBeTruthy();
    expect(auditDeactivated.entity_id).toBe(create.body.id);
  });

  test('21. Audit metadata excludes sensitive fields', async () => {
    await enableCorporateAuthority(true);
    const create = await makeAuthority({ status: 'pending', authorityBasis: 'power_of_attorney', authorisedPersonName: 'Jane Doe', authorisedPersonEmail: 'jane@example.com', authorisedPersonPhone: '0712345678', authorisedPersonRole: 'CEO', notes: 'sensitive note' });
    const audit = await latestAudit('client_authority_record_created');
    const meta = JSON.parse(audit.metadata_json || '{}');
    expect(meta.authorisedPersonName).toBeUndefined();
    expect(meta.authorisedPersonEmail).toBeUndefined();
    expect(meta.authorisedPersonPhone).toBeUndefined();
    expect(meta.authorisedPersonRole).toBeUndefined();
    expect(meta.notes).toBeUndefined();
    expect(meta.authorityRecordId).toBe(create.body.id);
    expect(meta.clientId).toBe(margaretId);
    expect(meta.status).toBe('pending');
  });

  test('22. No clients rows mutated', async () => {
    await enableCorporateAuthority(true);
    const before = await dbGet('SELECT COUNT(*) AS n FROM clients');
    const margaretBefore = await dbGet('SELECT * FROM clients WHERE id=?', [margaretId]);
    const create = await makeAuthority({ status: 'confirmed' });
    const after = await dbGet('SELECT COUNT(*) AS n FROM clients');
    const margaretAfter = await dbGet('SELECT * FROM clients WHERE id=?', [margaretId]);
    expect(after.n).toBe(before.n);
    expect(margaretAfter.name).toBe(margaretBefore.name);
    expect(margaretAfter.email).toBe(margaretBefore.email);
  });

  test('23. No matters/invoices/payments/retainer_records/matter_fee_plans/retainer_ledger_entries/client_kyc_records rows created or mutated', async () => {
    await enableCorporateAuthority(true);
    const tables = ['matters', 'invoices', 'payment_proofs', 'retainer_records', 'matter_fee_plans', 'retainer_ledger_entries', 'client_kyc_records'];
    const before = {};
    for (const t of tables) before[t] = await tableCount(t);
    const create = await makeAuthority({ status: 'confirmed' });
    for (const t of tables) {
      const after = await tableCount(t);
      expect(after).toBe(before[t]);
    }
  });

  test('24. Client Snapshot authority hidden when module disabled', async () => {
    await enableCorporateAuthority(false);
    const snap = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(snap.body.authority).toBeDefined();
    expect(snap.body.authority.visible).toBe(false);
  });

  test('25. Client Snapshot authority visible when module enabled', async () => {
    await enableCorporateAuthority(true);
    await makeAuthority({ status: 'confirmed', authorityBasis: 'director_resolution', authorisedPersonName: 'Test Person', authorityDate: '2026-01-01' });
    const snap = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(snap.body.authority).toBeDefined();
    expect(snap.body.authority.visible).toBe(true);
    expect(snap.body.authority.activeCount).toBeGreaterThanOrEqual(1);
    expect(snap.body.authority.latest).toBeTruthy();
    expect(snap.body.authority.latest.status).toBe('confirmed');
  });

  test('26. Snapshot authority excludes authorisedPersonEmail, authorisedPersonPhone, and notes', async () => {
    await enableCorporateAuthority(true);
    await makeAuthority({ status: 'confirmed', authorityBasis: 'mandate', authorisedPersonName: 'Test Person', authorisedPersonEmail: 'test@example.com', authorisedPersonPhone: '0712345678', notes: 'private' });
    const snap = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    if (snap.body.authority?.latest) {
      expect(snap.body.authority.latest.authorisedPersonEmail).toBeUndefined();
      expect(snap.body.authority.latest.authorisedPersonPhone).toBeUndefined();
      expect(snap.body.authority.latest.notes).toBeUndefined();
    }
  });

  test('27. No client portal route exposes authority data', async () => {
    const res = await request(app).get('/api/client-authorities').set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
    const res2 = await request(app).get(`/api/client-authorities/some-id`).set('Authorization', `Bearer ${clientToken}`);
    expect(res2.statusCode).toBe(403);
  });
});
