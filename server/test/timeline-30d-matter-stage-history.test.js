const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

function dbGet(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { db.get(sql, params, (err, row) => { db.close(); err ? reject(err) : resolve(row); }); });
}
function dbAll(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { db.all(sql, params, (err, rows) => { db.close(); err ? reject(err) : resolve(rows); }); });
}
function dbRun(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { db.run(sql, params, err => { db.close(); err ? reject(err) : resolve(); }); });
}
function auth(token) { return { Authorization: `Bearer ${token}` }; }

const ADMIN = { email: 'admin@lexflow.co.ke', password: 'password123' };
const ADVOCATE = { email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' };
const CLIENT = { email: 'margaret.wairimu@example.co.ke', password: 'password123' };
const RUN = Date.now();

const createdMatterIds = [];

describe('TIMELINE-30D matter stage history capture', () => {
  let adminToken, advocateToken, clientToken, advocateName, seededMatterId;

  async function createMatter(overrides = {}) {
    const res = await request(app).post('/api/matters').set(auth(adminToken)).send({
      clientId: `TLD-CLIENT-${RUN}`,
      title: `Stage history matter ${createdMatterIds.length}`,
      stage: 'Intake',
      ...overrides,
    });
    if (res.statusCode === 200 && res.body?.id) createdMatterIds.push(res.body.id);
    return res;
  }
  const countRows = async (matterId) => (await dbGet('SELECT COUNT(*) c FROM matter_stage_history WHERE matterId=?', [matterId])).c;

  beforeAll(async () => {
    await dbReady;
    const a = await request(app).post('/api/auth/login').send(ADMIN); adminToken = a.body.token;
    const adv = await request(app).post('/api/auth/login').send(ADVOCATE); advocateToken = adv.body.token; advocateName = adv.body.user.fullName;
    const cl = await request(app).post('/api/auth/client-login').send(CLIENT); clientToken = cl.body.token;
    const seededMatter = await dbGet("SELECT id FROM matters WHERE reference='LEX-2026-0001'");
    seededMatterId = seededMatter?.id;
  });

  afterAll(async () => {
    for (const id of createdMatterIds) {
      await dbRun('DELETE FROM matter_stage_history WHERE matterId=?', [id]);
      await dbRun('DELETE FROM audit_events WHERE entity_id=?', [id]);
      await dbRun('DELETE FROM matters WHERE id=?', [id]);
    }
  });

  test('1. matter_stage_history table exists', async () => {
    const row = await dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name='matter_stage_history'");
    expect(row).toBeTruthy();
  });

  test('2. PATCH /api/matters/:id with a changed stage creates exactly one history row', async () => {
    const created = await createMatter();
    const id = created.body.id;
    const before = await countRows(id);
    const res = await request(app).patch(`/api/matters/${id}`).set(auth(adminToken)).send({ stage: 'Active' });
    expect(res.statusCode).toBe(200);
    const after = await countRows(id);
    expect(after - before).toBe(1);
  });

  test('3. Row records correct oldStage and newStage', async () => {
    const created = await createMatter();
    const id = created.body.id;
    await request(app).patch(`/api/matters/${id}`).set(auth(adminToken)).send({ stage: 'Discovery' });
    const row = await dbGet("SELECT oldStage, newStage, source FROM matter_stage_history WHERE matterId=? AND source='manual' ORDER BY changedAt DESC LIMIT 1", [id]);
    expect(row.oldStage).toBe('Intake');
    expect(row.newStage).toBe('Discovery');
  });

  test('4. Row records changedBy and changedByName', async () => {
    const created = await createMatter();
    const id = created.body.id;
    await request(app).patch(`/api/matters/${id}`).set(auth(adminToken)).send({ stage: 'Active' });
    const row = await dbGet("SELECT changedBy, changedByName FROM matter_stage_history WHERE matterId=? AND source='manual' ORDER BY changedAt DESC LIMIT 1", [id]);
    expect(row.changedBy).toBeTruthy();
    expect(row.changedByName).toBeTruthy();
  });

  test('5. Updating a non-stage field creates no history row', async () => {
    const created = await createMatter();
    const id = created.body.id;
    const before = await countRows(id);
    await request(app).patch(`/api/matters/${id}`).set(auth(adminToken)).send({ title: 'Renamed matter' });
    const after = await countRows(id);
    expect(after).toBe(before);
  });

  test('6. Setting stage to the same value creates no history row', async () => {
    const created = await createMatter({ stage: 'Active' });
    const id = created.body.id;
    const before = await countRows(id);
    await request(app).patch(`/api/matters/${id}`).set(auth(adminToken)).send({ stage: 'Active' });
    const after = await countRows(id);
    expect(after).toBe(before);
  });

  test('7. PATCH /api/matters/:id/status creates a history row', async () => {
    const created = await createMatter();
    const id = created.body.id;
    const before = await countRows(id);
    const res = await request(app).patch(`/api/matters/${id}/status`).set(auth(adminToken)).send({ stage: 'Closed' });
    expect(res.statusCode).toBe(200);
    const after = await countRows(id);
    expect(after - before).toBe(1);
    const row = await dbGet("SELECT source, newStage FROM matter_stage_history WHERE matterId=? AND source='status' ORDER BY changedAt DESC LIMIT 1", [id]);
    expect(row.newStage).toBe('Closed');
  });

  test('8. Existing matters.stage remains the current source of truth', async () => {
    const created = await createMatter();
    const id = created.body.id;
    await request(app).patch(`/api/matters/${id}`).set(auth(adminToken)).send({ stage: 'Trial Prep' });
    const matter = await dbGet('SELECT stage FROM matters WHERE id=?', [id]);
    expect(matter.stage).toBe('Trial Prep');
  });

  test('9. Existing matter_updated audit still records', async () => {
    const created = await createMatter();
    const id = created.body.id;
    await request(app).patch(`/api/matters/${id}`).set(auth(adminToken)).send({ stage: 'Active' });
    const rows = await dbAll("SELECT id FROM audit_events WHERE entity_id=? AND action='matter_updated'", [id]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test('10. Existing matter_archived audit still records', async () => {
    const created = await createMatter();
    const id = created.body.id;
    await request(app).patch(`/api/matters/${id}/status`).set(auth(adminToken)).send({ stage: 'Closed' });
    const rows = await dbAll("SELECT id FROM audit_events WHERE entity_id=? AND action='matter_archived'", [id]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test('11. matter_stage_changed audit records', async () => {
    const created = await createMatter();
    const id = created.body.id;
    await request(app).patch(`/api/matters/${id}`).set(auth(adminToken)).send({ stage: 'Active' });
    const rows = await dbAll("SELECT metadata_json FROM audit_events WHERE entity_id=? AND action='matter_stage_changed'", [id]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const meta = JSON.parse(rows[rows.length - 1].metadata_json || '{}');
    expect(meta.oldStage).toBe('Intake');
    expect(meta.newStage).toBe('Active');
    expect(meta.source).toBeTruthy();
  });

  test('12. Audit metadata excludes note text', async () => {
    const created = await createMatter();
    const id = created.body.id;
    await request(app).patch(`/api/matters/${id}`).set(auth(adminToken)).send({ stage: 'Active' });
    const rows = await dbAll("SELECT metadata_json FROM audit_events WHERE entity_id=? AND action='matter_stage_changed'", [id]);
    const serialized = JSON.stringify(rows.map(r => JSON.parse(r.metadata_json || '{}')));
    expect(serialized.toLowerCase()).not.toContain('note');
  });

  test('13. Stage change appears in timeline as stage_change', async () => {
    const created = await createMatter();
    const id = created.body.id;
    await request(app).patch(`/api/matters/${id}`).set(auth(adminToken)).send({ stage: 'Active' });
    const tl = await request(app).get(`/api/matters/${id}/timeline`).set(auth(adminToken));
    expect(tl.statusCode).toBe(200);
    const stageEvents = tl.body.events.filter(e => e.type === 'stage_change');
    expect(stageEvents.length).toBeGreaterThanOrEqual(1);
  });

  test('14. Timeline stage event has safe fields only', async () => {
    const created = await createMatter();
    const id = created.body.id;
    await request(app).patch(`/api/matters/${id}`).set(auth(adminToken)).send({ stage: 'Active' });
    const tl = await request(app).get(`/api/matters/${id}/timeline`).set(auth(adminToken));
    const ev = tl.body.events.find(e => e.type === 'stage_change');
    for (const key of ['id', 'type', 'title', 'date', 'summary', 'actor', 'sourceId', 'sourceType', 'matterId', 'metadata']) {
      expect(ev).toHaveProperty(key);
    }
    expect(Object.keys(ev.metadata).sort()).toEqual(['newStage', 'oldStage', 'source']);
    expect(ev.metadata).not.toHaveProperty('note');
    const blob = JSON.stringify(tl.body);
    for (const forbidden of ['passwordHash', 'tokenVersion', 'accessToken', 'refreshToken']) {
      expect(blob).not.toContain(forbidden);
    }
  });

  test('15. Client cannot view stage_change timeline (timeline remains 403 for clients)', async () => {
    const created = await createMatter();
    const id = created.body.id;
    const res = await request(app).get(`/api/matters/${id}/timeline`).set(auth(clientToken));
    expect(res.statusCode).toBe(403);
  });

  test('16. Assigned advocate can trigger and view stage history', async () => {
    const created = await createMatter({ assignedTo: advocateName });
    const id = created.body.id;
    const patch = await request(app).patch(`/api/matters/${id}`).set(auth(advocateToken)).send({ stage: 'Active' });
    expect(patch.statusCode).toBe(200);
    const row = await dbGet("SELECT id FROM matter_stage_history WHERE matterId=? AND source='manual'", [id]);
    expect(row).toBeTruthy();
    const tl = await request(app).get(`/api/matters/${id}/timeline`).set(auth(advocateToken));
    expect(tl.statusCode).toBe(200);
    expect(tl.body.events.some(e => e.type === 'stage_change')).toBe(true);
  });

  test('17. Non-assigned advocate gets 403', async () => {
    const created = await createMatter({ assignedTo: 'Nobody Unassigned' });
    const id = created.body.id;
    const patch = await request(app).patch(`/api/matters/${id}`).set(auth(advocateToken)).send({ stage: 'Active' });
    expect(patch.statusCode).toBe(403);
    const tl = await request(app).get(`/api/matters/${id}/timeline`).set(auth(advocateToken));
    expect(tl.statusCode).toBe(403);
  });

  test('18. Existing seeded matters are not backfilled with history rows', async () => {
    expect(seededMatterId).toBeTruthy();
    const count = await countRows(seededMatterId);
    expect(count).toBe(0);
  });

  test('19. Newly created matter gets exactly one create-source row', async () => {
    const created = await createMatter();
    const id = created.body.id;
    const rows = await dbAll("SELECT source, oldStage, newStage FROM matter_stage_history WHERE matterId=? AND source='create'", [id]);
    expect(rows.length).toBe(1);
    expect(rows[0].oldStage).toBe('');
    expect(rows[0].newStage).toBe('Intake');
  });

  test('20. Existing stage values and labels are not changed', async () => {
    expect(seededMatterId).toBeTruthy();
    const before = await dbGet('SELECT stage FROM matters WHERE id=?', [seededMatterId]);
    // Operate only on our own created matters elsewhere; the seeded matter must be untouched.
    await createMatter();
    const after = await dbGet('SELECT stage FROM matters WHERE id=?', [seededMatterId]);
    expect(after.stage).toBe(before.stage);
  });

  test('21. No new public mutation route exists for stage history', async () => {
    const get1 = await request(app).get(`/api/matters/${createdMatterIds[0]}/stage-history`).set(auth(adminToken));
    expect(get1.statusCode).toBe(404);
    const post1 = await request(app).post('/api/matter-stage-history').set(auth(adminToken)).send({ matterId: createdMatterIds[0], newStage: 'Active' });
    expect(post1.statusCode).toBe(404);
  });
});
