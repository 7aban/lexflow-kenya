const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let margaretId, unassignedClientId;
let db;
const createdEventIds = [];

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
async function enableRetainerManagement(val) {
  await request(app).put('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`).send({ moduleSettings: { retainerManagement: val } });
}
async function enableScopeVariation(val) {
  await request(app).put('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`).send({ moduleSettings: { scopeVariation: val } });
}
async function setModules(ret, sv) {
  await request(app).put('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`).send({ moduleSettings: { retainerManagement: ret, scopeVariation: sv } });
}
async function tableCount(t) { return (await dbGet(`SELECT COUNT(*) AS n FROM ${t}`)).n; }
async function makeEvent(overrides = {}, token = adminToken) {
  const res = await request(app).post('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${token}`).send({ clientId: margaretId, eventType: 'scope_variation', ...overrides });
  if (res.body && res.body.id) createdEventIds.push(res.body.id);
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
  try { for (const id of createdEventIds) await dbRun('DELETE FROM retainer_lifecycle_events WHERE id=?', [id]); } catch {}
  try { await setModules(false, false); } catch {}
  try { db.close(); } catch {}
});

describe('RET-31I retainer lifecycle events', () => {
  test('1. retainer_lifecycle_events table exists with expected columns', async () => {
    const rows = await dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name='retainer_lifecycle_events'");
    expect(rows.length).toBe(1);
    const cols = (await dbAll('PRAGMA table_info(retainer_lifecycle_events)')).map(c => c.name);
    for (const col of ['id', 'clientId', 'matterId', 'retainerId', 'eventType', 'status',
      'effectiveDate', 'noticeDate', 'title', 'summary', 'reason',
      'scopeBeforeSummary', 'scopeAfterSummary', 'clientObligationsSummary', 'firmObligationsSummary',
      'isActive', 'createdBy', 'createdAt']) {
      expect(cols).toContain(col);
    }
  });

  test('2. retainerManagement disabled: GET returns 403 feature_disabled', async () => {
    await setModules(false, false);
    const res = await request(app).get('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('3. retainerManagement enabled but scopeVariation disabled: GET returns 403 feature_disabled', async () => {
    await setModules(true, false);
    const res = await request(app).get('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('4. Both enabled: POST creates event and GET lists it', async () => {
    await setModules(true, true);
    const res = await makeEvent({ eventType: 'scope_variation', status: 'recorded', title: 'Test scope change', effectiveDate: '2026-06-01' });
    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.eventType).toBe('scope_variation');
    expect(res.body.status).toBe('recorded');
    expect(res.body.title).toBe('Test scope change');
    expect(res.body.isActive).toBe(true);
    const list = await request(app).get('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${adminToken}`);
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.some(e => e.id === res.body.id)).toBe(true);
  });

  test('5. GET single event returns event', async () => {
    const created = await makeEvent({ eventType: 'suspension', title: 'Suspension test' });
    const res = await request(app).get(`/api/retainer-lifecycle-events/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.eventType).toBe('suspension');
  });

  test('6. PATCH updates event fields', async () => {
    const created = await makeEvent({ eventType: 'termination', title: 'Before update' });
    const res = await request(app).patch(`/api/retainer-lifecycle-events/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'After update', status: 'approved', reason: 'Approved reason' });
    expect(res.statusCode).toBe(200);
    expect(res.body.title).toBe('After update');
    expect(res.body.status).toBe('approved');
    expect(res.body.reason).toBe('Approved reason');
  });

  test('7. PATCH clientId immutable after creation', async () => {
    const created = await makeEvent({ eventType: 'closure' });
    const res = await request(app).patch(`/api/retainer-lifecycle-events/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: 'some-other-id' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('clientId cannot be changed');
  });

  test('8. Soft deactivate event', async () => {
    const created = await makeEvent({ eventType: 'scope_variation', title: 'To deactivate' });
    const res = await request(app).delete(`/api/retainer-lifecycle-events/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    const row = await dbGet('SELECT isActive, deactivatedBy FROM retainer_lifecycle_events WHERE id=?', [created.body.id]);
    expect(Number(row.isActive)).toBe(0);
    expect(row.deactivatedBy).toBeTruthy();
  });

  test('9. List excludes inactive by default', async () => {
    await setModules(true, true);
    const active = await makeEvent({ eventType: 'resumption', title: 'Active event' });
    const inactive = await makeEvent({ eventType: 'closure', title: 'Inactive event' });
    await request(app).delete(`/api/retainer-lifecycle-events/${inactive.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    const list = await request(app).get('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${adminToken}`);
    const ids = list.body.map(e => e.id);
    expect(ids).toContain(active.body.id);
    expect(ids).not.toContain(inactive.body.id);
  });

  test('10. List with includeInactive=true includes inactive', async () => {
    const list = await request(app).get('/api/retainer-lifecycle-events?includeInactive=true').set('Authorization', `Bearer ${adminToken}`);
    const inactiveInList = list.body.some(e => !e.isActive);
    expect(inactiveInList).toBe(true);
  });

  test('11. Assistant can create and list events', async () => {
    const res = await makeEvent({ eventType: 'scope_variation', title: 'By assistant' }, assistantToken);
    expect(res.statusCode).toBe(201);
    const list = await request(app).get('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${assistantToken}`);
    expect(list.statusCode).toBe(200);
  });

  test('12. Advocate assigned to client can create event', async () => {
    const res = await makeEvent({ eventType: 'suspension', title: 'By advocate' }, advocateToken);
    expect(res.statusCode).toBe(201);
  });

  test('13. Advocate cannot create event for unassigned client', async () => {
    const res = await request(app).post('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${advocateToken}`)
      .send({ clientId: unassignedClientId, eventType: 'scope_variation' });
    expect(res.statusCode).toBe(403);
  });

  test('14. Client cannot access lifecycle events', async () => {
    const res = await request(app).get('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('15. POST missing clientId rejected', async () => {
    const res = await request(app).post('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${adminToken}`)
      .send({ eventType: 'scope_variation' });
    expect(res.statusCode).toBe(400);
  });

  test('16. POST missing eventType rejected', async () => {
    const res = await request(app).post('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: margaretId });
    expect(res.statusCode).toBe(400);
  });

  test('17. POST invalid eventType rejected', async () => {
    const res = await request(app).post('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: margaretId, eventType: 'invalid' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('Invalid eventType');
  });

  test('18. POST invalid status rejected', async () => {
    const res = await request(app).post('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: margaretId, eventType: 'scope_variation', status: 'invalid' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('Invalid status');
  });

  test('19. POST invalid effectiveDate rejected', async () => {
    const res = await request(app).post('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: margaretId, eventType: 'scope_variation', effectiveDate: 'not-a-date' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('Invalid effectiveDate');
  });

  test('20. POST title exceeds 200 chars rejected', async () => {
    const res = await request(app).post('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: margaretId, eventType: 'scope_variation', title: 'x'.repeat(201) });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('title exceeds');
  });

  test('21. POST matterId must belong to clientId', async () => {
    const otherMatter = await dbGet('SELECT id FROM matters WHERE clientId != ? LIMIT 1', [margaretId]);
    if (otherMatter) {
      const res = await request(app).post('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${adminToken}`)
        .send({ clientId: margaretId, eventType: 'scope_variation', matterId: otherMatter.id });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('matterId does not belong');
    }
  });

  test('22. Audit event created on POST', async () => {
    const created = await makeEvent({ eventType: 'scope_variation', title: 'Audit test event' });
    const audit = await latestAudit('retainer_lifecycle_event_created');
    expect(audit).toBeTruthy();
    expect(audit.entity_id).toBe(created.body.id);
  });

  test('23. Audit event created on PATCH', async () => {
    const created = await makeEvent({ eventType: 'suspension', title: 'Audit patch test' });
    await request(app).patch(`/api/retainer-lifecycle-events/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'approved' });
    const audit = await latestAudit('retainer_lifecycle_event_updated');
    expect(audit).toBeTruthy();
    expect(audit.entity_id).toBe(created.body.id);
  });

  test('24. Audit event created on DELETE', async () => {
    const created = await makeEvent({ eventType: 'termination', title: 'Audit delete test' });
    await request(app).delete(`/api/retainer-lifecycle-events/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    const audit = await latestAudit('retainer_lifecycle_event_deactivated');
    expect(audit).toBeTruthy();
    expect(audit.entity_id).toBe(created.body.id);
  });

  test('25. Audit metadata excludes sensitive text fields', async () => {
    const created = await makeEvent({ eventType: 'scope_variation', title: 'Sensitive test', summary: 'secret', reason: 'private', scopeBeforeSummary: 'old', scopeAfterSummary: 'new', clientObligationsSummary: 'client', firmObligationsSummary: 'firm' });
    const audit = await latestAudit('retainer_lifecycle_event_created');
    const meta = JSON.parse(audit.metadata_json || '{}');
    expect(meta.summary).toBeUndefined();
    expect(meta.reason).toBeUndefined();
    expect(meta.scopeBeforeSummary).toBeUndefined();
    expect(meta.scopeAfterSummary).toBeUndefined();
    expect(meta.clientObligationsSummary).toBeUndefined();
    expect(meta.firmObligationsSummary).toBeUndefined();
    expect(meta.title).toBeDefined();
    expect(meta.eventType).toBeDefined();
    expect(meta.lifecycleEventId).toBeDefined();
  });

  test('26. No retainer_records status changed by lifecycle events', async () => {
    const before = await dbAll('SELECT id, status FROM retainer_records WHERE isActive=1');
    await makeEvent({ eventType: 'termination', title: 'Should not change retainer' });
    const after = await dbAll('SELECT id, status FROM retainer_records WHERE isActive=1');
    expect(after).toEqual(before);
  });

  test('27. No matters.stage changed by lifecycle events', async () => {
    const before = await dbAll('SELECT id, stage FROM matters');
    await makeEvent({ eventType: 'closure', title: 'Should not change matter' });
    const after = await dbAll('SELECT id, stage FROM matters');
    expect(after).toEqual(before);
  });

  test('28. Client Snapshot lifecycle block hidden when scopeVariation disabled', async () => {
    await setModules(true, false);
    const snap = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(snap.statusCode).toBe(200);
    expect(snap.body.lifecycle.visible).toBe(false);
  });

  test('29. Client Snapshot lifecycle block visible when both modules enabled', async () => {
    await setModules(true, true);
    const snap = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(snap.statusCode).toBe(200);
    expect(snap.body.lifecycle.visible).toBe(true);
    expect(snap.body.lifecycle.activeCount).toBeGreaterThanOrEqual(0);
  });

  test('29b. Client Snapshot lifecycle summary counts scope variation events', async () => {
    await setModules(true, true);
    const before = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    const beforeCount = Number(before.body.lifecycle?.summary?.scope_variation || 0);
    await makeEvent({ eventType: 'scope_variation', title: 'Snapshot summary count test' });
    const after = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(after.statusCode).toBe(200);
    expect(Number(after.body.lifecycle.summary.scope_variation)).toBe(beforeCount + 1);
  });

  test('30. Client Snapshot lifecycle block excludes sensitive text', async () => {
    await setModules(true, true);
    const snap = await request(app).get(`/api/clients/${margaretId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(snap.statusCode).toBe(200);
    if (snap.body.lifecycle.latest) {
      expect(snap.body.lifecycle.latest.summary).toBeUndefined();
      expect(snap.body.lifecycle.latest.reason).toBeUndefined();
    }
  });

  test('31. GET non-existent event returns 404', async () => {
    const res = await request(app).get('/api/retainer-lifecycle-events/non-existent-id').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(404);
  });

  test('32. PATCH non-existent event returns 404', async () => {
    const res = await request(app).patch('/api/retainer-lifecycle-events/non-existent-id').set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'nope' });
    expect(res.statusCode).toBe(404);
  });

  test('33. DELETE non-existent event returns 404', async () => {
    const res = await request(app).delete('/api/retainer-lifecycle-events/non-existent-id').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(404);
  });

  test('34. PATCH with no fields to update returns 400', async () => {
    const created = await makeEvent({ eventType: 'scope_variation', title: 'No update fields' });
    const res = await request(app).patch(`/api/retainer-lifecycle-events/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('No fields');
  });

  test('35. Filtering by eventType works', async () => {
    await setModules(true, true);
    await makeEvent({ eventType: 'resumption', title: 'Filter resumption' });
    const list = await request(app).get('/api/retainer-lifecycle-events?eventType=resumption').set('Authorization', `Bearer ${adminToken}`);
    expect(list.statusCode).toBe(200);
    expect(list.body.every(e => e.eventType === 'resumption')).toBe(true);
  });
});
