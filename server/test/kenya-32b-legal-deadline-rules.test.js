const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let sarahFullName, accessibleMatterId, inaccessibleMatterId;
let db;
const createdRuleIds = [];
const createdDeadlineIds = [];

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
async function tableCount(t) { return (await dbGet(`SELECT COUNT(*) AS n FROM ${t}`)).n; }
async function enableAdvancedCompliance(val) {
  await request(app).put('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`).send({ moduleSettings: { advancedCompliance: val } });
}
const baseRule = {
  ruleType: 'limitation',
  jurisdiction: 'Kenya',
  legalArea: 'Tort',
  causeOfAction: 'Negligence',
  title: 'Limitation — tort claim',
  triggerEvent: 'cause_of_action_accrual',
  periodValue: 3,
  periodUnit: 'years',
  citation: 'Limitation of Actions Act (Cap 22) s.4(2)',
};
async function makeRule(overrides = {}, token = adminToken) {
  const res = await request(app).post('/api/legal-deadline-rules').set('Authorization', `Bearer ${token}`).send({ ...baseRule, ...overrides });
  if (res.body && res.body.id) createdRuleIds.push(res.body.id);
  return res;
}

beforeAll(async () => {
  await dbReady;
  db = new sqlite3.Database(config.DATABASE_PATH);
  adminToken = (await request(app).post('/api/auth/login').send({ email: 'admin@lexflow.co.ke', password: 'password123' })).body.token;
  advocateToken = (await request(app).post('/api/auth/login').send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' })).body.token;
  assistantToken = (await request(app).post('/api/auth/login').send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' })).body.token;
  clientToken = (await request(app).post('/api/auth/client-login').send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' })).body.token;
  sarahFullName = (await dbGet("SELECT fullName FROM users WHERE email='sarah.mwangi@achokilaw.co.ke'")).fullName;
  accessibleMatterId = (await dbGet('SELECT id FROM matters WHERE assignedTo=? LIMIT 1', [sarahFullName])).id;
  inaccessibleMatterId = (await dbGet('SELECT id FROM matters WHERE assignedTo IS NULL OR assignedTo<>? LIMIT 1', [sarahFullName])).id;
});

afterAll(async () => {
  try { for (const id of createdRuleIds) await dbRun('DELETE FROM legal_deadline_rules WHERE id=?', [id]); } catch {}
  try { for (const id of createdDeadlineIds) await dbRun('DELETE FROM deadlines WHERE id=?', [id]); } catch {}
  try { await enableAdvancedCompliance(false); } catch {}
  try { db.close(); } catch {}
});

describe('KENYA-32B legal deadline rules', () => {
  test('1. legal_deadline_rules table exists with expected columns', async () => {
    const rows = await dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name='legal_deadline_rules'");
    expect(rows.length).toBe(1);
    const cols = (await dbAll('PRAGMA table_info(legal_deadline_rules)')).map(c => c.name);
    for (const col of ['id', 'ruleType', 'jurisdiction', 'legalArea', 'causeOfAction', 'title', 'triggerEvent',
      'periodValue', 'periodUnit', 'computationMode', 'citation', 'notes', 'effectiveFrom', 'effectiveTo',
      'version', 'isActive', 'verifiedBy', 'verifiedAt', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt',
      'deactivatedBy', 'deactivatedAt']) {
      expect(cols).toContain(col);
    }
  });

  test('2. Module disabled: GET returns 403 feature_disabled', async () => {
    await enableAdvancedCompliance(false);
    const res = await request(app).get('/api/legal-deadline-rules').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('3. Module disabled: POST returns 403 feature_disabled', async () => {
    await enableAdvancedCompliance(false);
    const res = await request(app).post('/api/legal-deadline-rules').set('Authorization', `Bearer ${adminToken}`).send(baseRule);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('4. Module enabled: admin can create rule', async () => {
    await enableAdvancedCompliance(true);
    const res = await makeRule();
    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.ruleType).toBe('limitation');
    expect(res.body.periodValue).toBe(3);
    expect(res.body.periodUnit).toBe('years');
    expect(res.body.isActive).toBe(true);
    expect(res.body.version).toBe(1);
  });

  test('5. GET returns active rules to staff (advocate/assistant)', async () => {
    await enableAdvancedCompliance(true);
    await makeRule({ title: 'Visible rule' });
    const adv = await request(app).get('/api/legal-deadline-rules').set('Authorization', `Bearer ${advocateToken}`);
    expect(adv.statusCode).toBe(200);
    expect(Array.isArray(adv.body)).toBe(true);
    expect(adv.body.length).toBeGreaterThan(0);
    const asst = await request(app).get('/api/legal-deadline-rules').set('Authorization', `Bearer ${assistantToken}`);
    expect(asst.statusCode).toBe(200);
  });

  test('6. Client forbidden from GET', async () => {
    await enableAdvancedCompliance(true);
    const res = await request(app).get('/api/legal-deadline-rules').set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('7. Advocate/assistant cannot POST/PATCH/DELETE', async () => {
    await enableAdvancedCompliance(true);
    const ruleId = createdRuleIds[0];
    const advPost = await request(app).post('/api/legal-deadline-rules').set('Authorization', `Bearer ${advocateToken}`).send(baseRule);
    expect(advPost.statusCode).toBe(403);
    const asstPost = await request(app).post('/api/legal-deadline-rules').set('Authorization', `Bearer ${assistantToken}`).send(baseRule);
    expect(asstPost.statusCode).toBe(403);
    const advPatch = await request(app).patch(`/api/legal-deadline-rules/${ruleId}`).set('Authorization', `Bearer ${advocateToken}`).send({ title: 'x' });
    expect(advPatch.statusCode).toBe(403);
    const advDelete = await request(app).delete(`/api/legal-deadline-rules/${ruleId}`).set('Authorization', `Bearer ${advocateToken}`);
    expect(advDelete.statusCode).toBe(403);
  });

  test('8. Missing citation rejected', async () => {
    await enableAdvancedCompliance(true);
    const res = await request(app).post('/api/legal-deadline-rules').set('Authorization', `Bearer ${adminToken}`).send({ ...baseRule, citation: '' });
    expect(res.statusCode).toBe(400);
  });

  test('9. Invalid ruleType rejected', async () => {
    await enableAdvancedCompliance(true);
    const res = await request(app).post('/api/legal-deadline-rules').set('Authorization', `Bearer ${adminToken}`).send({ ...baseRule, ruleType: 'nonsense' });
    expect(res.statusCode).toBe(400);
  });

  test('10. Invalid periodUnit rejected', async () => {
    await enableAdvancedCompliance(true);
    const res = await request(app).post('/api/legal-deadline-rules').set('Authorization', `Bearer ${adminToken}`).send({ ...baseRule, periodUnit: 'weeks' });
    expect(res.statusCode).toBe(400);
  });

  test('11. Non-positive / non-integer periodValue rejected', async () => {
    await enableAdvancedCompliance(true);
    const zero = await request(app).post('/api/legal-deadline-rules').set('Authorization', `Bearer ${adminToken}`).send({ ...baseRule, periodValue: 0 });
    expect(zero.statusCode).toBe(400);
    const neg = await request(app).post('/api/legal-deadline-rules').set('Authorization', `Bearer ${adminToken}`).send({ ...baseRule, periodValue: -3 });
    expect(neg.statusCode).toBe(400);
    const frac = await request(app).post('/api/legal-deadline-rules').set('Authorization', `Bearer ${adminToken}`).send({ ...baseRule, periodValue: 2.5 });
    expect(frac.statusCode).toBe(400);
  });

  test('12. Invalid dates rejected', async () => {
    await enableAdvancedCompliance(true);
    const res = await request(app).post('/api/legal-deadline-rules').set('Authorization', `Bearer ${adminToken}`).send({ ...baseRule, effectiveFrom: 'not-a-date' });
    expect(res.statusCode).toBe(400);
  });

  test('13. PATCH updates rule', async () => {
    await enableAdvancedCompliance(true);
    const created = await makeRule({ title: 'Before update' });
    const res = await request(app).patch(`/api/legal-deadline-rules/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'After update', periodValue: 6, periodUnit: 'months' });
    expect(res.statusCode).toBe(200);
    expect(res.body.title).toBe('After update');
    expect(res.body.periodValue).toBe(6);
    expect(res.body.periodUnit).toBe('months');
  });

  test('14. DELETE soft deactivates only; row remains', async () => {
    await enableAdvancedCompliance(true);
    const created = await makeRule({ title: 'To deactivate' });
    const res = await request(app).delete(`/api/legal-deadline-rules/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    const row = await dbGet('SELECT * FROM legal_deadline_rules WHERE id=?', [created.body.id]);
    expect(row).toBeTruthy();
    expect(Number(row.isActive)).toBe(0);
    expect(row.deactivatedBy).toBeTruthy();
    expect(row.deactivatedAt).toBeTruthy();
  });

  test('15. List excludes inactive unless includeInactive=true', async () => {
    await enableAdvancedCompliance(true);
    const created = await makeRule({ title: 'Inactive-list-test' });
    await request(app).delete(`/api/legal-deadline-rules/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    const active = await request(app).get('/api/legal-deadline-rules').set('Authorization', `Bearer ${adminToken}`);
    expect(active.body.find(r => r.id === created.body.id)).toBeUndefined();
    const all = await request(app).get('/api/legal-deadline-rules?includeInactive=true').set('Authorization', `Bearer ${adminToken}`);
    expect(all.body.find(r => r.id === created.body.id)).toBeTruthy();
  });

  test('16. Preview computes days deterministically', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule({ periodValue: 30, periodUnit: 'days', title: 'Days rule' });
    const res = await request(app).post(`/api/legal-deadline-rules/${rule.body.id}/preview`).set('Authorization', `Bearer ${adminToken}`).send({ triggerDate: '2026-01-01' });
    expect(res.statusCode).toBe(200);
    expect(res.body.suggestedDueDate).toBe('2026-01-31');
  });

  test('17. Preview computes months deterministically (clamps month-end)', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule({ periodValue: 1, periodUnit: 'months', title: 'Months rule' });
    const res = await request(app).post(`/api/legal-deadline-rules/${rule.body.id}/preview`).set('Authorization', `Bearer ${adminToken}`).send({ triggerDate: '2026-01-31' });
    expect(res.statusCode).toBe(200);
    expect(res.body.suggestedDueDate).toBe('2026-02-28');
  });

  test('18. Preview computes years deterministically (leap-year clamp)', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule({ periodValue: 1, periodUnit: 'years', title: 'Years rule' });
    const res = await request(app).post(`/api/legal-deadline-rules/${rule.body.id}/preview`).set('Authorization', `Bearer ${adminToken}`).send({ triggerDate: '2024-02-29' });
    expect(res.statusCode).toBe(200);
    expect(res.body.suggestedDueDate).toBe('2025-02-28');
  });

  test('19. Preview creates no deadlines/tasks/appearances/matter rows', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule({ periodValue: 3, periodUnit: 'years', title: 'No-write rule' });
    const before = {
      deadlines: await tableCount('deadlines'),
      tasks: await tableCount('tasks'),
      appearances: await tableCount('appearances'),
      matters: await tableCount('matters'),
      rules: await tableCount('legal_deadline_rules'),
    };
    const res = await request(app).post(`/api/legal-deadline-rules/${rule.body.id}/preview`).set('Authorization', `Bearer ${adminToken}`).send({ triggerDate: '2020-06-09' });
    expect(res.statusCode).toBe(200);
    expect(await tableCount('deadlines')).toBe(before.deadlines);
    expect(await tableCount('tasks')).toBe(before.tasks);
    expect(await tableCount('appearances')).toBe(before.appearances);
    expect(await tableCount('matters')).toBe(before.matters);
    expect(await tableCount('legal_deadline_rules')).toBe(before.rules);
  });

  test('20. Preview with accessible matterId succeeds for advocate', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule({ title: 'Matter-scoped rule' });
    const res = await request(app).post(`/api/legal-deadline-rules/${rule.body.id}/preview`).set('Authorization', `Bearer ${advocateToken}`).send({ triggerDate: '2026-01-01', matterId: accessibleMatterId });
    expect(res.statusCode).toBe(200);
    expect(res.body.suggestedDueDate).toBeTruthy();
  });

  test('21. Advocate inaccessible-matter preview returns 403', async () => {
    await enableAdvancedCompliance(true);
    const rule = createdRuleIds[0];
    const res = await request(app).post(`/api/legal-deadline-rules/${rule}/preview`).set('Authorization', `Bearer ${advocateToken}`).send({ triggerDate: '2026-01-01', matterId: inaccessibleMatterId });
    expect(res.statusCode).toBe(403);
  });

  test('22. Client preview forbidden', async () => {
    await enableAdvancedCompliance(true);
    const rule = createdRuleIds[0];
    const res = await request(app).post(`/api/legal-deadline-rules/${rule}/preview`).set('Authorization', `Bearer ${clientToken}`).send({ triggerDate: '2026-01-01' });
    expect(res.statusCode).toBe(403);
  });

  test('23. Preview response includes requiresAdvocateVerification true and disclaimer', async () => {
    await enableAdvancedCompliance(true);
    const rule = createdRuleIds[0];
    const res = await request(app).post(`/api/legal-deadline-rules/${rule}/preview`).set('Authorization', `Bearer ${adminToken}`).send({ triggerDate: '2026-01-01' });
    expect(res.statusCode).toBe(200);
    expect(res.body.requiresAdvocateVerification).toBe(true);
    expect(typeof res.body.disclaimer).toBe('string');
    expect(res.body.disclaimer).toMatch(/planning aid only/i);
    expect(res.body.citation).toBeTruthy();
  });

  test('24. Audit events created for create/update/deactivate/preview', async () => {
    await enableAdvancedCompliance(true);
    const created = await makeRule({ title: 'Audit lifecycle rule' });
    await request(app).patch(`/api/legal-deadline-rules/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Audit lifecycle rule v2' });
    await request(app).post(`/api/legal-deadline-rules/${created.body.id}/preview`).set('Authorization', `Bearer ${adminToken}`).send({ triggerDate: '2026-01-01' });
    await request(app).delete(`/api/legal-deadline-rules/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(await latestAudit('legal_deadline_rule_created')).toBeTruthy();
    expect(await latestAudit('legal_deadline_rule_updated')).toBeTruthy();
    expect(await latestAudit('deadline_suggestion_previewed')).toBeTruthy();
    expect(await latestAudit('legal_deadline_rule_deactivated')).toBeTruthy();
  });

  test('25. Audit metadata excludes notes and long legal analysis', async () => {
    await enableAdvancedCompliance(true);
    const longNotes = 'SENSITIVE_INTERNAL_ANALYSIS ' + 'x'.repeat(200);
    const created = await makeRule({ title: 'Notes-redaction rule', notes: longNotes });
    const audit = await latestAudit('legal_deadline_rule_created');
    const meta = JSON.parse(audit.metadata_json || '{}');
    expect(meta).not.toHaveProperty('notes');
    expect(audit.metadata_json).not.toContain('SENSITIVE_INTERNAL_ANALYSIS');
    // whitelist sanity
    expect(meta).toHaveProperty('ruleId');
    expect(meta).toHaveProperty('citation');
  });

  test('26. Existing deadline create/update/list behavior unchanged', async () => {
    // Independent of advancedCompliance — the legacy deadline routes must still work.
    const create = await request(app).post('/api/deadlines').set('Authorization', `Bearer ${adminToken}`).send({ title: 'KENYA-32B regression deadline', dueDate: '2026-07-01', type: 'internal' });
    expect(create.statusCode).toBe(200);
    expect(create.body.id).toBeTruthy();
    createdDeadlineIds.push(create.body.id);
    const list = await request(app).get('/api/deadlines').set('Authorization', `Bearer ${adminToken}`);
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    const patch = await request(app).patch(`/api/deadlines/${create.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'Done' });
    expect(patch.statusCode).toBe(200);
    expect(patch.body.status).toBe('Done');
  });
});
