const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let sarahFullName, accessibleMatterId, accessibleClientId, inaccessibleMatterId;
let db;
const createdRuleIds = [];
const createdSuggestionIds = [];
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
async function makeRule(overrides = {}) {
  const res = await request(app).post('/api/legal-deadline-rules').set('Authorization', `Bearer ${adminToken}`).send({ ...baseRule, ...overrides });
  if (res.body && res.body.id) createdRuleIds.push(res.body.id);
  return res;
}
async function makeSuggestion(body, token = adminToken) {
  const res = await request(app).post('/api/legal-deadline-suggestions').set('Authorization', `Bearer ${token}`).send(body);
  if (res.body && res.body.id) createdSuggestionIds.push(res.body.id);
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
  const accessible = await dbGet('SELECT id, clientId FROM matters WHERE assignedTo=? LIMIT 1', [sarahFullName]);
  accessibleMatterId = accessible.id;
  accessibleClientId = accessible.clientId;
  inaccessibleMatterId = (await dbGet('SELECT id FROM matters WHERE assignedTo IS NULL OR assignedTo<>? LIMIT 1', [sarahFullName])).id;
});

afterAll(async () => {
  try { for (const id of createdDeadlineIds) await dbRun('DELETE FROM deadlines WHERE id=?', [id]); } catch {}
  try { for (const id of createdSuggestionIds) await dbRun('DELETE FROM legal_deadline_suggestions WHERE id=?', [id]); } catch {}
  try { for (const id of createdRuleIds) await dbRun('DELETE FROM legal_deadline_rules WHERE id=?', [id]); } catch {}
  try { await enableAdvancedCompliance(false); } catch {}
  try { db.close(); } catch {}
});

describe('KENYA-32C legal deadline suggestions', () => {
  test('1. legal_deadline_suggestions table exists with expected columns', async () => {
    const rows = await dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name='legal_deadline_suggestions'");
    expect(rows.length).toBe(1);
    const cols = (await dbAll('PRAGMA table_info(legal_deadline_suggestions)')).map(c => c.name);
    for (const col of ['id', 'ruleId', 'matterId', 'clientId', 'triggerDate', 'suggestedDueDate', 'title', 'ruleType',
      'jurisdiction', 'legalArea', 'causeOfAction', 'triggerEvent', 'periodValue', 'periodUnit', 'computationMode',
      'citation', 'disclaimer', 'requiresAdvocateVerification', 'status', 'confirmedDeadlineId', 'notes',
      'createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'confirmedBy', 'confirmedAt', 'cancelledBy', 'cancelledAt']) {
      expect(cols).toContain(col);
    }
  });

  test('2. Module disabled: all suggestion routes return 403 feature_disabled', async () => {
    await enableAdvancedCompliance(false);
    const list = await request(app).get('/api/legal-deadline-suggestions').set('Authorization', `Bearer ${adminToken}`);
    expect(list.statusCode).toBe(403);
    expect(list.body.error).toBe('feature_disabled');
    const post = await request(app).post('/api/legal-deadline-suggestions').set('Authorization', `Bearer ${adminToken}`).send({ ruleId: 'x', triggerDate: '2026-01-01' });
    expect(post.statusCode).toBe(403);
    expect(post.body.error).toBe('feature_disabled');
    const patch = await request(app).patch('/api/legal-deadline-suggestions/LDS_x').set('Authorization', `Bearer ${adminToken}`).send({ title: 'x' });
    expect(patch.statusCode).toBe(403);
    expect(patch.body.error).toBe('feature_disabled');
    const confirm = await request(app).post('/api/legal-deadline-suggestions/LDS_x/confirm').set('Authorization', `Bearer ${adminToken}`).send({});
    expect(confirm.statusCode).toBe(403);
    expect(confirm.body.error).toBe('feature_disabled');
  });

  test('3. Client forbidden from all suggestion routes', async () => {
    await enableAdvancedCompliance(true);
    const list = await request(app).get('/api/legal-deadline-suggestions').set('Authorization', `Bearer ${clientToken}`);
    expect(list.statusCode).toBe(403);
    const post = await request(app).post('/api/legal-deadline-suggestions').set('Authorization', `Bearer ${clientToken}`).send({ ruleId: 'x', triggerDate: '2026-01-01' });
    expect(post.statusCode).toBe(403);
    const patch = await request(app).patch('/api/legal-deadline-suggestions/LDS_x').set('Authorization', `Bearer ${clientToken}`).send({ title: 'x' });
    expect(patch.statusCode).toBe(403);
    const confirm = await request(app).post('/api/legal-deadline-suggestions/LDS_x/confirm').set('Authorization', `Bearer ${clientToken}`).send({});
    expect(confirm.statusCode).toBe(403);
  });

  test('4. Staff creates draft suggestion from active rule', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-01-01' });
    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe('draft');
    expect(res.body.ruleId).toBe(rule.body.id);
    expect(res.body.suggestedDueDate).toBe('2029-01-01');
    expect(res.body.requiresAdvocateVerification).toBe(true);
    expect(res.body.disclaimer).toMatch(/planning aid only/i);
  });

  test('5. Inactive/missing rule rejected', async () => {
    await enableAdvancedCompliance(true);
    const missing = await makeSuggestion({ ruleId: 'LDR_does_not_exist', triggerDate: '2026-01-01' });
    expect(missing.statusCode).toBe(404);
    const rule = await makeRule({ title: 'To deactivate before suggestion' });
    await request(app).delete(`/api/legal-deadline-rules/${rule.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    const inactive = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-01-01' });
    expect(inactive.statusCode).toBe(404);
  });

  test('6. Invalid triggerDate rejected', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await makeSuggestion({ ruleId: rule.body.id, triggerDate: 'not-a-date' });
    expect(res.statusCode).toBe(400);
    const missingDate = await makeSuggestion({ ruleId: rule.body.id });
    expect(missingDate.statusCode).toBe(400);
  });

  test('7. Suggestion snapshots citation and rule fields', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule({ legalArea: 'Contract', causeOfAction: 'Breach', citation: 'SNAPSHOT_CITATION s.99' });
    const res = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-01-01' });
    expect(res.statusCode).toBe(201);
    expect(res.body.citation).toBe('SNAPSHOT_CITATION s.99');
    expect(res.body.ruleType).toBe('limitation');
    expect(res.body.jurisdiction).toBe('Kenya');
    expect(res.body.legalArea).toBe('Contract');
    expect(res.body.causeOfAction).toBe('Breach');
    expect(res.body.triggerEvent).toBe('cause_of_action_accrual');
    expect(res.body.periodValue).toBe(3);
    expect(res.body.periodUnit).toBe('years');
    expect(res.body.computationMode).toBe('calendar');
    expect(res.body.title).toBe(rule.body.title);
  });

  test('8. Suggestion creation creates no deadline', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const before = await tableCount('deadlines');
    const res = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-02-02' });
    expect(res.statusCode).toBe(201);
    expect(await tableCount('deadlines')).toBe(before);
  });

  test('9. GET filters by matterId/clientId/status/ruleId', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule({ title: 'Filter rule' });
    const withMatter = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-03-03', matterId: accessibleMatterId });
    expect(withMatter.statusCode).toBe(201);

    const byMatter = await request(app).get(`/api/legal-deadline-suggestions?matterId=${accessibleMatterId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(byMatter.statusCode).toBe(200);
    expect(byMatter.body.every(s => s.matterId === accessibleMatterId)).toBe(true);
    expect(byMatter.body.find(s => s.id === withMatter.body.id)).toBeTruthy();

    const byClient = await request(app).get(`/api/legal-deadline-suggestions?clientId=${accessibleClientId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(byClient.statusCode).toBe(200);
    expect(byClient.body.every(s => s.clientId === accessibleClientId)).toBe(true);

    const byStatus = await request(app).get('/api/legal-deadline-suggestions?status=draft').set('Authorization', `Bearer ${adminToken}`);
    expect(byStatus.statusCode).toBe(200);
    expect(byStatus.body.every(s => s.status === 'draft')).toBe(true);

    const byRule = await request(app).get(`/api/legal-deadline-suggestions?ruleId=${rule.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(byRule.statusCode).toBe(200);
    expect(byRule.body.every(s => s.ruleId === rule.body.id)).toBe(true);
    expect(byRule.body.find(s => s.id === withMatter.body.id)).toBeTruthy();
  });

  test('10. Advocate can list accessible matter suggestion', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-04-04', matterId: accessibleMatterId });
    expect(created.statusCode).toBe(201);
    const res = await request(app).get(`/api/legal-deadline-suggestions?matterId=${accessibleMatterId}`).set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.find(s => s.id === created.body.id)).toBeTruthy();
  });

  test('11. Advocate cannot create suggestion for inaccessible matter', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-01-01', matterId: inaccessibleMatterId }, advocateToken);
    expect(res.statusCode).toBe(403);
  });

  test('12. Advocate cannot confirm inaccessible matter suggestion', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-01-01', matterId: inaccessibleMatterId });
    expect(created.statusCode).toBe(201);
    const res = await request(app).post(`/api/legal-deadline-suggestions/${created.body.id}/confirm`).set('Authorization', `Bearer ${advocateToken}`).send({});
    expect(res.statusCode).toBe(403);
  });

  test('13. Assistant can create draft suggestion', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-05-05' }, assistantToken);
    expect(res.statusCode).toBe(201);
    expect(res.body.status).toBe('draft');
  });

  test('14. Assistant can cancel draft suggestion', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-06-06' }, assistantToken);
    const res = await request(app).patch(`/api/legal-deadline-suggestions/${created.body.id}`).set('Authorization', `Bearer ${assistantToken}`).send({ status: 'cancelled' });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  test('15. Assistant cannot confirm suggestion', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-01-01', matterId: accessibleMatterId });
    const res = await request(app).post(`/api/legal-deadline-suggestions/${created.body.id}/confirm`).set('Authorization', `Bearer ${assistantToken}`).send({});
    expect(res.statusCode).toBe(403);
  });

  test('16. Cancel draft suggestion works', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-07-07' });
    const res = await request(app).patch(`/api/legal-deadline-suggestions/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'cancelled' });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('cancelled');
    const row = await dbGet('SELECT * FROM legal_deadline_suggestions WHERE id=?', [created.body.id]);
    expect(row.cancelledBy).toBeTruthy();
    expect(row.cancelledAt).toBeTruthy();
  });

  test('17. Cannot confirm cancelled suggestion', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-01-01', matterId: accessibleMatterId });
    await request(app).patch(`/api/legal-deadline-suggestions/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'cancelled' });
    const res = await request(app).post(`/api/legal-deadline-suggestions/${created.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(res.statusCode).toBe(409);
  });

  test('18. Cannot confirm suggestion without matterId', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-01-01' });
    expect(created.body.matterId).toBe('');
    const res = await request(app).post(`/api/legal-deadline-suggestions/${created.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(res.statusCode).toBe(400);
  });

  test('19. Confirm draft creates exactly one deadline', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-08-08', matterId: accessibleMatterId });
    const before = await tableCount('deadlines');
    const res = await request(app).post(`/api/legal-deadline-suggestions/${created.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(res.statusCode).toBe(200);
    expect(await tableCount('deadlines')).toBe(before + 1);
    expect(res.body.suggestion.status).toBe('confirmed');
    expect(res.body.suggestion.confirmedDeadlineId).toBeTruthy();
    expect(res.body.deadline.id).toBe(res.body.suggestion.confirmedDeadlineId);
    createdDeadlineIds.push(res.body.deadline.id);
  });

  test('20. Double confirm returns 409 and creates no second deadline', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-09-09', matterId: accessibleMatterId });
    const first = await request(app).post(`/api/legal-deadline-suggestions/${created.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(first.statusCode).toBe(200);
    createdDeadlineIds.push(first.body.deadline.id);
    const before = await tableCount('deadlines');
    const second = await request(app).post(`/api/legal-deadline-suggestions/${created.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(second.statusCode).toBe(409);
    expect(await tableCount('deadlines')).toBe(before);
  });

  test('21. Confirmed suggestion cannot be patched', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-10-10', matterId: accessibleMatterId });
    const confirm = await request(app).post(`/api/legal-deadline-suggestions/${created.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(confirm.statusCode).toBe(200);
    createdDeadlineIds.push(confirm.body.deadline.id);
    const patch = await request(app).patch(`/api/legal-deadline-suggestions/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'changed' });
    expect(patch.statusCode).toBe(409);
  });

  test('22. Created deadline fields are correct', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule({ title: 'Mapping rule' });
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-11-11', matterId: accessibleMatterId });
    const confirm = await request(app).post(`/api/legal-deadline-suggestions/${created.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(confirm.statusCode).toBe(200);
    const d = confirm.body.deadline;
    createdDeadlineIds.push(d.id);
    expect(d.matterId).toBe(accessibleMatterId);
    expect(d.clientId).toBe(accessibleClientId);
    expect(d.title).toBe(rule.body.title);
    expect(d.type).toBe('Legal Deadline');
    expect(d.dueDate).toBe(created.body.suggestedDueDate);
    expect(d.status).toBe('Open');
  });

  test('23. Created deadline notes include citation', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule({ citation: 'NOTES_CITATION s.42' });
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2026-12-12', matterId: accessibleMatterId });
    const confirm = await request(app).post(`/api/legal-deadline-suggestions/${created.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(confirm.statusCode).toBe(200);
    createdDeadlineIds.push(confirm.body.deadline.id);
    expect(confirm.body.deadline.notes).toContain('NOTES_CITATION s.42');
    expect(confirm.body.deadline.notes).toMatch(/Confirm applicable law before reliance/i);
  });

  test('24. Created deadline notes do not include suggestion notes or long legal analysis', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const sentinel = 'PRIVATE_INTERNAL_ANALYSIS ' + 'z'.repeat(200);
    const created = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2027-01-01', matterId: accessibleMatterId, notes: sentinel });
    const confirm = await request(app).post(`/api/legal-deadline-suggestions/${created.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(confirm.statusCode).toBe(200);
    createdDeadlineIds.push(confirm.body.deadline.id);
    expect(confirm.body.deadline.notes).not.toContain('PRIVATE_INTERNAL_ANALYSIS');
  });

  test('25. Audit events created for create/update/cancel/confirm', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const createdForUpdate = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2027-02-02' });
    await request(app).patch(`/api/legal-deadline-suggestions/${createdForUpdate.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'updated title' });
    const createdForCancel = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2027-03-03' });
    await request(app).patch(`/api/legal-deadline-suggestions/${createdForCancel.body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'cancelled' });
    const createdForConfirm = await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2027-04-04', matterId: accessibleMatterId });
    const confirm = await request(app).post(`/api/legal-deadline-suggestions/${createdForConfirm.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({});
    if (confirm.body?.deadline?.id) createdDeadlineIds.push(confirm.body.deadline.id);
    expect(await latestAudit('legal_deadline_suggestion_created')).toBeTruthy();
    expect(await latestAudit('legal_deadline_suggestion_updated')).toBeTruthy();
    expect(await latestAudit('legal_deadline_suggestion_cancelled')).toBeTruthy();
    expect(await latestAudit('legal_deadline_suggestion_confirmed')).toBeTruthy();
  });

  test('26. Audit metadata excludes notes/analysis', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const sentinel = 'AUDIT_SENSITIVE_NOTES ' + 'q'.repeat(200);
    await makeSuggestion({ ruleId: rule.body.id, triggerDate: '2027-05-05', notes: sentinel });
    const audit = await latestAudit('legal_deadline_suggestion_created');
    const meta = JSON.parse(audit.metadata_json || '{}');
    expect(meta).not.toHaveProperty('notes');
    expect(audit.metadata_json).not.toContain('AUDIT_SENSITIVE_NOTES');
    expect(meta).toHaveProperty('suggestionId');
    expect(meta).toHaveProperty('citation');
    expect(meta).toHaveProperty('ruleId');
  });

  test('27. Existing KENYA-32B stateless preview route unchanged', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule({ periodValue: 30, periodUnit: 'days', title: 'Preview-unchanged rule' });
    const before = await tableCount('deadlines');
    const res = await request(app).post(`/api/legal-deadline-rules/${rule.body.id}/preview`).set('Authorization', `Bearer ${adminToken}`).send({ triggerDate: '2026-01-01' });
    expect(res.statusCode).toBe(200);
    expect(res.body.suggestedDueDate).toBe('2026-01-31');
    expect(res.body.requiresAdvocateVerification).toBe(true);
    expect(res.body.disclaimer).toMatch(/planning aid only/i);
    // preview must remain stateless — it persists nothing.
    expect(await tableCount('deadlines')).toBe(before);
    const suggestionRows = await dbGet('SELECT COUNT(*) AS n FROM legal_deadline_suggestions WHERE ruleId=?', [rule.body.id]);
    expect(suggestionRows.n).toBe(0);
  });

  test('28. Existing manual deadline CRUD unchanged', async () => {
    const create = await request(app).post('/api/deadlines').set('Authorization', `Bearer ${adminToken}`).send({ title: 'KENYA-32C regression deadline', dueDate: '2026-07-01', type: 'internal' });
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
