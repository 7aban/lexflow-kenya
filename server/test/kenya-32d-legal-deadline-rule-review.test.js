const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let adminUserId, sarahFullName, accessibleMatterId;
let db;
const createdRuleIds = [];
const createdSuggestionIds = [];
const createdDeadlineIds = [];

function dbAll(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    d.all(sql, params, (e, r) => {
      d.close(closeErr => {
        if (e) reject(e);
        else if (closeErr) reject(closeErr);
        else resolve(r);
      });
    });
  });
}
function dbGet(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    d.get(sql, params, (e, r) => {
      d.close(closeErr => {
        if (e) reject(e);
        else if (closeErr) reject(closeErr);
        else resolve(r);
      });
    });
  });
}
function dbRun(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    d.run(sql, params, e => {
      d.close(closeErr => {
        if (e) reject(e);
        else if (closeErr) reject(closeErr);
        else resolve();
      });
    });
  });
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

beforeAll(async () => {
  await dbReady;
  db = new sqlite3.Database(config.DATABASE_PATH);
  adminToken = (await request(app).post('/api/auth/login').send({ email: 'admin@lexflow.co.ke', password: 'password123' })).body.token;
  advocateToken = (await request(app).post('/api/auth/login').send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' })).body.token;
  assistantToken = (await request(app).post('/api/auth/login').send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' })).body.token;
  clientToken = (await request(app).post('/api/auth/client-login').send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' })).body.token;
  adminUserId = (await dbGet("SELECT id FROM users WHERE email='admin@lexflow.co.ke'")).id;
  sarahFullName = (await dbGet("SELECT fullName FROM users WHERE email='sarah.mwangi@achokilaw.co.ke'")).fullName;
  accessibleMatterId = (await dbGet('SELECT id FROM matters WHERE assignedTo=? LIMIT 1', [sarahFullName])).id;
});

afterAll(async () => {
  try { for (const id of createdDeadlineIds) await dbRun('DELETE FROM deadlines WHERE id=?', [id]); } catch {}
  try { for (const id of createdSuggestionIds) await dbRun('DELETE FROM legal_deadline_suggestions WHERE id=?', [id]); } catch {}
  try { for (const id of createdRuleIds) await dbRun('DELETE FROM legal_deadline_rules WHERE id=?', [id]); } catch {}
  try { await enableAdvancedCompliance(false); } catch {}
  if (db) {
    await new Promise((resolve, reject) => {
      db.close(err => err ? reject(err) : resolve());
    });
  }
});

describe('KENYA-32D legal deadline rule review controls', () => {
  test('1. legal_deadline_rules has review columns', async () => {
    const cols = (await dbAll('PRAGMA table_info(legal_deadline_rules)')).map(c => c.name);
    for (const col of ['reviewStatus', 'reviewedBy', 'reviewedAt', 'nextReviewDate', 'reviewComment']) {
      expect(cols).toContain(col);
    }
  });

  test('2. Module disabled: review route returns 403 feature_disabled', async () => {
    await enableAdvancedCompliance(false);
    const res = await request(app).patch('/api/legal-deadline-rules/LDR_x/review').set('Authorization', `Bearer ${adminToken}`).send({ reviewStatus: 'reviewed' });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
  });

  test('3. Client cannot review rule', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${clientToken}`).send({ reviewStatus: 'reviewed' });
    expect(res.statusCode).toBe(403);
  });

  test('4. Assistant cannot review rule', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${assistantToken}`).send({ reviewStatus: 'reviewed' });
    expect(res.statusCode).toBe(403);
  });

  test('5. Advocate can review an active rule', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${advocateToken}`).send({ reviewStatus: 'reviewed', nextReviewDate: '2027-01-01' });
    expect(res.statusCode).toBe(200);
    expect(res.body.reviewStatus).toBe('reviewed');
    expect(res.body.nextReviewDate).toBe('2027-01-01');
  });

  test('6. Admin can review an active rule', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${adminToken}`).send({ reviewStatus: 'needs_update', reviewComment: 'Check 2026 amendment' });
    expect(res.statusCode).toBe(200);
    expect(res.body.reviewStatus).toBe('needs_update');
  });

  test('7. Advocate/admin can review an inactive rule without reactivating it', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule({ title: 'Inactive review rule' });
    await request(app).delete(`/api/legal-deadline-rules/${rule.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    const res = await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${advocateToken}`).send({ reviewStatus: 'reviewed' });
    expect(res.statusCode).toBe(200);
    expect(res.body.reviewStatus).toBe('reviewed');
    expect(res.body.isActive).toBe(false);
    const row = await dbGet('SELECT isActive FROM legal_deadline_rules WHERE id=?', [rule.body.id]);
    expect(Number(row.isActive)).toBe(0);
  });

  test('8. Invalid reviewStatus rejected with 400', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${adminToken}`).send({ reviewStatus: 'approved' });
    expect(res.statusCode).toBe(400);
    const missing = await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(missing.statusCode).toBe(400);
  });

  test('9. Invalid nextReviewDate rejected with 400', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${adminToken}`).send({ reviewStatus: 'reviewed', nextReviewDate: 'not-a-date' });
    expect(res.statusCode).toBe(400);
    const bad = await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${adminToken}`).send({ reviewStatus: 'reviewed', nextReviewDate: '2027/01/01' });
    expect(bad.statusCode).toBe(400);
  });

  test('10. reviewComment over 500 chars rejected with 400', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${adminToken}`).send({ reviewStatus: 'reviewed', reviewComment: 'x'.repeat(501) });
    expect(res.statusCode).toBe(400);
  });

  test('11. Successful review sets reviewedBy/reviewedAt', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${adminToken}`).send({ reviewStatus: 'reviewed' });
    expect(res.statusCode).toBe(200);
    const row = await dbGet('SELECT reviewedBy, reviewedAt FROM legal_deadline_rules WHERE id=?', [rule.body.id]);
    expect(row.reviewedBy).toBe(adminUserId);
    expect(row.reviewedAt).toBeTruthy();
  });

  test('12. Successful review returns public rule with review fields', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const res = await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${adminToken}`).send({ reviewStatus: 'reviewed', nextReviewDate: '2028-06-09', reviewComment: 'ok' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('reviewStatus', 'reviewed');
    expect(res.body).toHaveProperty('reviewedBy');
    expect(res.body).toHaveProperty('reviewedAt');
    expect(res.body).toHaveProperty('nextReviewDate', '2028-06-09');
    expect(res.body).toHaveProperty('reviewComment', 'ok');
  });

  test('13. GET legal deadline rules includes review fields', async () => {
    await enableAdvancedCompliance(true);
    await makeRule({ title: 'Review-fields-list rule' });
    const res = await request(app).get('/api/legal-deadline-rules').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const r of res.body) {
      expect(r).toHaveProperty('reviewStatus');
      expect(r).toHaveProperty('reviewedBy');
      expect(r).toHaveProperty('reviewedAt');
      expect(r).toHaveProperty('nextReviewDate');
      expect(r).toHaveProperty('reviewComment');
    }
  });

  test('14. audit event legal_deadline_rule_reviewed is recorded', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${adminToken}`).send({ reviewStatus: 'reviewed', nextReviewDate: '2027-02-02' });
    const audit = await latestAudit('legal_deadline_rule_reviewed');
    expect(audit).toBeTruthy();
    expect(audit.entity_id).toBe(rule.body.id);
  });

  test('15. audit metadata excludes reviewComment/citation/legal analysis', async () => {
    await enableAdvancedCompliance(true);
    const sentinel = 'SECRET_REVIEW_ANALYSIS ' + 'z'.repeat(100);
    const rule = await makeRule({ citation: 'AUDIT_CITATION_SENTINEL s.7' });
    await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${adminToken}`).send({ reviewStatus: 'reviewed', reviewComment: sentinel });
    const audit = await latestAudit('legal_deadline_rule_reviewed');
    const meta = JSON.parse(audit.metadata_json || '{}');
    expect(meta).not.toHaveProperty('reviewComment');
    expect(meta).not.toHaveProperty('citation');
    expect(meta).not.toHaveProperty('notes');
    expect(audit.metadata_json).not.toContain('SECRET_REVIEW_ANALYSIS');
    expect(audit.metadata_json).not.toContain('AUDIT_CITATION_SENTINEL');
    expect(meta).toHaveProperty('ruleId');
    expect(meta).toHaveProperty('reviewStatus');
    expect(meta).toHaveProperty('jurisdiction');
    expect(meta).toHaveProperty('ruleType');
  });

  test('16. review does not create deadlines', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const before = await tableCount('deadlines');
    await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${adminToken}`).send({ reviewStatus: 'reviewed' });
    expect(await tableCount('deadlines')).toBe(before);
  });

  test('17. review does not create legal deadline suggestions', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const before = await tableCount('legal_deadline_suggestions');
    await request(app).patch(`/api/legal-deadline-rules/${rule.body.id}/review`).set('Authorization', `Bearer ${adminToken}`).send({ reviewStatus: 'reviewed' });
    expect(await tableCount('legal_deadline_suggestions')).toBe(before);
  });

  test('18. KENYA-32B preview route remains unchanged and stateless', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule({ periodValue: 30, periodUnit: 'days', title: 'Preview-still-stateless' });
    const before = await tableCount('deadlines');
    const res = await request(app).post(`/api/legal-deadline-rules/${rule.body.id}/preview`).set('Authorization', `Bearer ${adminToken}`).send({ triggerDate: '2026-01-01' });
    expect(res.statusCode).toBe(200);
    expect(res.body.suggestedDueDate).toBe('2026-01-31');
    expect(res.body.requiresAdvocateVerification).toBe(true);
    expect(res.body.disclaimer).toMatch(/planning aid only/i);
    expect(await tableCount('deadlines')).toBe(before);
  });

  test('19. KENYA-32C confirm-to-deadline behavior remains unchanged', async () => {
    await enableAdvancedCompliance(true);
    const rule = await makeRule();
    const suggestion = await request(app).post('/api/legal-deadline-suggestions').set('Authorization', `Bearer ${adminToken}`).send({ ruleId: rule.body.id, triggerDate: '2026-08-08', matterId: accessibleMatterId });
    expect(suggestion.statusCode).toBe(201);
    createdSuggestionIds.push(suggestion.body.id);
    const before = await tableCount('deadlines');
    const confirm = await request(app).post(`/api/legal-deadline-suggestions/${suggestion.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(confirm.statusCode).toBe(200);
    expect(await tableCount('deadlines')).toBe(before + 1);
    expect(confirm.body.deadline.type).toBe('Legal Deadline');
    expect(confirm.body.suggestion.status).toBe('confirmed');
    createdDeadlineIds.push(confirm.body.deadline.id);
  });
});
