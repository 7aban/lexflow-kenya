const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

function dbRun(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    db.run(sql, params, err => {
      db.close();
      err ? reject(err) : resolve();
    });
  });
}

function dbGet(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      db.close();
      err ? reject(err) : resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      db.close();
      err ? reject(err) : resolve(rows);
    });
  });
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

const ADMIN_EMAIL = 'admin@lexflow.co.ke';
const ADMIN_PASSWORD = 'password123';
const ADVOCATE_EMAIL = 'sarah.mwangi@achokilaw.co.ke';
const ADVOCATE_PASSWORD = 'password123';
const ASSISTANT_EMAIL = 'david.wanjiku@achokilaw.co.ke';
const ASSISTANT_PASSWORD = 'password123';
const CLIENT_EMAIL = 'margaret.wairimu@example.co.ke';
const CLIENT_PASSWORD = 'password123';

const testYear = new Date().getFullYear();
const createdEntitlementIds = [];
const createdAdjustmentIds = [];
const createdLeaveIds = [];

describe('HR-29D leave balances and dashboard', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let adminUserId;
  let advocateUserId;
  let assistantUserId;

  beforeAll(async () => {
    await dbReady;

    const adminRes = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;
    adminUserId = adminRes.body.user.id;

    const advocateRes = await request(app).post('/api/auth/login').send({ email: ADVOCATE_EMAIL, password: ADVOCATE_PASSWORD });
    expect(advocateRes.statusCode).toBe(200);
    advocateToken = advocateRes.body.token;
    advocateUserId = advocateRes.body.user.id;

    const assistantRes = await request(app).post('/api/auth/login').send({ email: ASSISTANT_EMAIL, password: ASSISTANT_PASSWORD });
    expect(assistantRes.statusCode).toBe(200);
    assistantToken = assistantRes.body.token;
    assistantUserId = assistantRes.body.user.id;

    const clientRes = await request(app).post('/api/auth/client-login').send({ email: CLIENT_EMAIL, password: CLIENT_PASSWORD });
    expect(clientRes.statusCode).toBe(200);
    clientToken = clientRes.body.token;
  });

  afterAll(async () => {
    for (const id of createdEntitlementIds) {
      await dbRun('DELETE FROM audit_events WHERE entity_id=?', [id]);
      await dbRun('DELETE FROM hr_leave_entitlements WHERE id=?', [id]);
    }
    for (const id of createdAdjustmentIds) {
      await dbRun('DELETE FROM audit_events WHERE entity_id=?', [id]);
      await dbRun('DELETE FROM hr_leave_balance_adjustments WHERE id=?', [id]);
    }
    for (const id of createdLeaveIds) {
      await dbRun('DELETE FROM audit_events WHERE entity_id=?', [id]);
      await dbRun('DELETE FROM hr_leave_requests WHERE id=?', [id]);
    }
  });

  test('1. hr_leave_entitlements table exists', async () => {
    const row = await dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name='hr_leave_entitlements'");
    expect(row).not.toBeNull();
  });

  test('2. hr_leave_balance_adjustments table exists', async () => {
    const row = await dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name='hr_leave_balance_adjustments'");
    expect(row).not.toBeNull();
  });

  test('3. Admin can set entitlement for staff user', async () => {
    const res = await request(app)
      .put(`/api/hr/leave-entitlements/${advocateUserId}/annual/${testYear}`)
      .set(auth(adminToken))
      .send({ entitlementDays: 30 });
    expect(res.statusCode).toBe(200);
    expect(res.body.entitlementDays).toBe(30);
    expect(res.body.leaveType).toBe('annual');
    expect(res.body.userId).toBe(advocateUserId);
    expect(res.body.remainingDays).toBe(30);
    expect(res.body.projectedRemainingDays).toBe(30);
    createdEntitlementIds.push(res.body.entitlementDays !== undefined ? '' : '');
    // Store for cleanup: find the entitlement id
    const entRow = await dbGet('SELECT id FROM hr_leave_entitlements WHERE userId=? AND leaveType=? AND year=?', [advocateUserId, 'annual', testYear]);
    if (entRow) createdEntitlementIds.push(entRow.id);
  });

  test('4. Admin cannot set entitlement for client user', async () => {
    const clientRes = await request(app).post('/api/auth/client-login').send({ email: CLIENT_EMAIL, password: CLIENT_PASSWORD });
    const clientUserId = clientRes.body.user?.id || '';
    const res = await request(app)
      .put(`/api/hr/leave-entitlements/${clientUserId}/annual/${testYear}`)
      .set(auth(adminToken))
      .send({ entitlementDays: 10 });
    expect(res.statusCode).toBe(403);
  });

  test('5. Advocate/assistant cannot set entitlement', async () => {
    const res1 = await request(app)
      .put(`/api/hr/leave-entitlements/${advocateUserId}/annual/${testYear}`)
      .set(auth(advocateToken))
      .send({ entitlementDays: 20 });
    expect(res1.statusCode).toBe(403);

    const res2 = await request(app)
      .put(`/api/hr/leave-entitlements/${advocateUserId}/annual/${testYear}`)
      .set(auth(assistantToken))
      .send({ entitlementDays: 20 });
    expect(res2.statusCode).toBe(403);
  });

  test('6. Client cannot access balance routes', async () => {
    const res1 = await request(app)
      .get('/api/hr/dashboard')
      .set(auth(clientToken));
    expect(res1.statusCode).toBe(403);

    const res2 = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(clientToken));
    expect(res2.statusCode).toBe(403);

    const res3 = await request(app)
      .put(`/api/hr/leave-entitlements/${advocateUserId}/annual/${testYear}`)
      .set(auth(clientToken))
      .send({ entitlementDays: 10 });
    expect(res3.statusCode).toBe(403);

    const res4 = await request(app)
      .post('/api/hr/leave-balance-adjustments')
      .set(auth(clientToken))
      .send({ userId: advocateUserId, leaveType: 'annual', year: testYear, days: 5 });
    expect(res4.statusCode).toBe(403);

    const res5 = await request(app)
      .get('/api/hr/me/leave-balances')
      .set(auth(clientToken));
    expect(res5.statusCode).toBe(403);
  });

  test('7. Admin can list computed leave balances', async () => {
    const res = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const advBalance = res.body.find(b => b.userId === advocateUserId && b.leaveType === 'annual');
    expect(advBalance).toBeTruthy();
    expect(advBalance.entitlementDays).toBe(30);
  });

  test('8. Self-service user can list own balances only', async () => {
    await request(app)
      .put(`/api/hr/leave-entitlements/${assistantUserId}/annual/${testYear}`)
      .set(auth(adminToken))
      .send({ entitlementDays: 22 });
    const entRow = await dbGet('SELECT id FROM hr_leave_entitlements WHERE userId=? AND leaveType=? AND year=?', [assistantUserId, 'annual', testYear]);
    if (entRow) createdEntitlementIds.push(entRow.id);

    const res = await request(app)
      .get('/api/hr/me/leave-balances')
      .set(auth(advocateToken))
      .query({ year: testYear });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const annual = res.body.find(b => b.leaveType === 'annual');
    expect(annual).toBeTruthy();
    expect(annual.entitlementDays).toBe(30);
  });

  test('9. Self-service user cannot see other staff balances', async () => {
    const res = await request(app)
      .get('/api/hr/me/leave-balances')
      .set(auth(assistantToken))
      .query({ year: testYear });
    expect(res.statusCode).toBe(200);
    const annual = res.body.find(b => b.leaveType === 'annual');
    // Assistant should see their own entitlement, not the advocate's 30
    expect(annual).toBeTruthy();
    expect(annual.entitlementDays).toBe(22);
    // Body should only contain assistant's data - no userId field per row
    // All rows belong to the current user
    const hasOtherUser = res.body.some(b => b.userId !== undefined);
    expect(hasOtherUser).toBe(false);
  });

  test('10. Approved leave reduces remaining balance', async () => {
    const leaveRes = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'annual', startDate: `${testYear}-07-01`, endDate: `${testYear}-07-05`, reason: 'Test approved reduction' });
    expect(leaveRes.statusCode).toBe(201);
    const leaveId = leaveRes.body.id;
    createdLeaveIds.push(leaveId);

    await request(app)
      .patch(`/api/hr/leave-requests/${leaveId}/approve`)
      .set(auth(adminToken))
      .send({});

    const balanceRes = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear, userId: advocateUserId, leaveType: 'annual' });
    expect(balanceRes.statusCode).toBe(200);
    const balance = balanceRes.body.find(b => b.userId === advocateUserId && b.leaveType === 'annual');
    expect(balance).toBeTruthy();
    expect(balance.approvedUsedDays).toBeGreaterThanOrEqual(5);
    expect(balance.remainingDays).toBe(30 - balance.approvedUsedDays);
  });

  test('11. Pending leave appears as pendingRequested but does not reduce remaining', async () => {
    const leaveRes = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'annual', startDate: `${testYear}-08-01`, endDate: `${testYear}-08-03`, reason: 'Test pending' });
    expect(leaveRes.statusCode).toBe(201);
    const leaveId = leaveRes.body.id;
    createdLeaveIds.push(leaveId);

    const balanceRes = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear, userId: advocateUserId, leaveType: 'annual' });
    expect(balanceRes.statusCode).toBe(200);
    const balance = balanceRes.body.find(b => b.userId === advocateUserId && b.leaveType === 'annual');
    expect(balance).toBeTruthy();
    expect(balance.pendingRequestedDays).toBeGreaterThanOrEqual(3);
    expect(balance.remainingDays).toBe(30 - balance.approvedUsedDays);
    expect(balance.projectedRemainingDays).toBe(balance.remainingDays - balance.pendingRequestedDays);
  });

  test('12. Projected remaining subtracts pending from remaining', async () => {
    const balanceRes = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear, userId: advocateUserId, leaveType: 'annual' });
    expect(balanceRes.statusCode).toBe(200);
    const balance = balanceRes.body.find(b => b.userId === advocateUserId && b.leaveType === 'annual');
    expect(balance).toBeTruthy();
    expect(balance.projectedRemainingDays).toBe(balance.remainingDays - balance.pendingRequestedDays);
  });

  test('13. Rejected leave does not affect used or pending', async () => {
    const beforeRes = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear, userId: advocateUserId, leaveType: 'annual' });
    const before = beforeRes.body.find(b => b.userId === advocateUserId && b.leaveType === 'annual');

    const leaveRes = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'annual', startDate: `${testYear}-09-01`, endDate: `${testYear}-09-02`, reason: 'Test reject balance' });
    expect(leaveRes.statusCode).toBe(201);
    const leaveId = leaveRes.body.id;
    createdLeaveIds.push(leaveId);

    await request(app)
      .patch(`/api/hr/leave-requests/${leaveId}/reject`)
      .set(auth(adminToken))
      .send({});

    const afterRes = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear, userId: advocateUserId, leaveType: 'annual' });
    const after = afterRes.body.find(b => b.userId === advocateUserId && b.leaveType === 'annual');

    expect(after.pendingRequestedDays).toBe(before.pendingRequestedDays);
    expect(after.approvedUsedDays).toBe(before.approvedUsedDays);
    expect(after.remainingDays).toBe(before.remainingDays);
  });

  test('14. Cancelled leave does not affect used or pending', async () => {
    const beforeRes = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear, userId: advocateUserId, leaveType: 'annual' });
    const before = beforeRes.body.find(b => b.userId === advocateUserId && b.leaveType === 'annual');

    const leaveRes = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'annual', startDate: `${testYear}-10-01`, endDate: `${testYear}-10-02`, reason: 'Test cancel balance' });
    expect(leaveRes.statusCode).toBe(201);
    const leaveId = leaveRes.body.id;
    createdLeaveIds.push(leaveId);

    await request(app)
      .patch(`/api/hr/me/leave-requests/${leaveId}/cancel`)
      .set(auth(advocateToken));

    const afterRes = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear, userId: advocateUserId, leaveType: 'annual' });
    const after = afterRes.body.find(b => b.userId === advocateUserId && b.leaveType === 'annual');

    expect(after.pendingRequestedDays).toBe(before.pendingRequestedDays);
    expect(after.approvedUsedDays).toBe(before.approvedUsedDays);
    expect(after.remainingDays).toBe(before.remainingDays);
  });

  test('15. Positive adjustment increases remaining', async () => {
    const beforeRes = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear, userId: advocateUserId, leaveType: 'annual' });
    const before = beforeRes.body.find(b => b.userId === advocateUserId && b.leaveType === 'annual');

    const adjRes = await request(app)
      .post('/api/hr/leave-balance-adjustments')
      .set(auth(adminToken))
      .send({ userId: advocateUserId, leaveType: 'annual', year: testYear, days: 5, reason: 'Performance bonus' });
    expect(adjRes.statusCode).toBe(200);

    const adjRow = await dbGet('SELECT id FROM hr_leave_balance_adjustments WHERE userId=? AND leaveType=? AND year=?', [advocateUserId, 'annual', testYear]);
    if (adjRow) createdAdjustmentIds.push(adjRow.id);

    const afterRes = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear, userId: advocateUserId, leaveType: 'annual' });
    const after = afterRes.body.find(b => b.userId === advocateUserId && b.leaveType === 'annual');

    expect(after.adjustmentDays).toBeGreaterThanOrEqual(5);
    expect(after.remainingDays).toBe(before.remainingDays + 5);
  });

  test('16. Negative adjustment decreases remaining', async () => {
    const beforeRes = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear, userId: advocateUserId, leaveType: 'annual' });
    const before = beforeRes.body.find(b => b.userId === advocateUserId && b.leaveType === 'annual');

    const adjRes = await request(app)
      .post('/api/hr/leave-balance-adjustments')
      .set(auth(adminToken))
      .send({ userId: advocateUserId, leaveType: 'annual', year: testYear, days: -3, reason: 'Correction' });
    expect(adjRes.statusCode).toBe(200);

    const adjRow = await dbGet('SELECT id FROM hr_leave_balance_adjustments WHERE userId=? AND leaveType=? AND year=? AND days=-3', [advocateUserId, 'annual', testYear]);
    if (adjRow) createdAdjustmentIds.push(adjRow.id);

    const afterRes = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear, userId: advocateUserId, leaveType: 'annual' });
    const after = afterRes.body.find(b => b.userId === advocateUserId && b.leaveType === 'annual');

    expect(after.remainingDays).toBe(before.remainingDays - 3);
  });

  test('17. Adjustment reason is stored but not included in audit metadata', async () => {
    const adjRes = await request(app)
      .post('/api/hr/leave-balance-adjustments')
      .set(auth(adminToken))
      .send({ userId: advocateUserId, leaveType: 'sick', year: testYear, days: 2, reason: 'Medical leave top-up' });
    expect(adjRes.statusCode).toBe(200);

    const adjRow = await dbGet('SELECT id, reason FROM hr_leave_balance_adjustments WHERE userId=? AND leaveType=? AND year=? AND days=2', [advocateUserId, 'sick', testYear]);
    expect(adjRow).not.toBeNull();
    expect(adjRow.reason).toBe('Medical leave top-up');
    createdAdjustmentIds.push(adjRow.id);

    const auditRows = await dbAll("SELECT metadata_json FROM audit_events WHERE entity_id=? AND action='leave_balance_adjusted'", [adjRow.id]);
    for (const row of auditRows) {
      const meta = JSON.parse(row.metadata_json || '{}');
      const serialized = JSON.stringify(meta);
      expect(serialized).not.toContain('reason');
      expect(serialized).not.toContain('Medical leave top-up');
    }
  });

  test('18. leave_entitlement_set audit event is recorded', async () => {
    const res = await request(app)
      .put(`/api/hr/leave-entitlements/${advocateUserId}/sick/${testYear}`)
      .set(auth(adminToken))
      .send({ entitlementDays: 15 });
    expect(res.statusCode).toBe(200);

    const entRow = await dbGet('SELECT id FROM hr_leave_entitlements WHERE userId=? AND leaveType=? AND year=?', [advocateUserId, 'sick', testYear]);
    if (entRow) createdEntitlementIds.push(entRow.id);

    const auditRows = await dbAll("SELECT action, metadata_json FROM audit_events WHERE entity_id=? AND action='leave_entitlement_set'", [entRow.id]);
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const meta = JSON.parse(auditRows[0].metadata_json || '{}');
    expect(meta.userId).toBe(advocateUserId);
    expect(meta.leaveType).toBe('sick');
    expect(meta.entitlementDays).toBe(15);
  });

  test('19. leave_balance_adjusted audit event is recorded', async () => {
    const adjRes = await request(app)
      .post('/api/hr/leave-balance-adjustments')
      .set(auth(adminToken))
      .send({ userId: advocateUserId, leaveType: 'compassionate', year: testYear, days: 5, reason: 'Audit test' });
    expect(adjRes.statusCode).toBe(200);

    const adjRow = await dbGet('SELECT id FROM hr_leave_balance_adjustments WHERE userId=? AND leaveType=? AND year=? AND days=5', [advocateUserId, 'compassionate', testYear]);
    if (adjRow) createdAdjustmentIds.push(adjRow.id);

    const auditRows = await dbAll("SELECT action, metadata_json FROM audit_events WHERE entity_id=? AND action='leave_balance_adjusted'", [adjRow.id]);
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const meta = JSON.parse(auditRows[0].metadata_json || '{}');
    expect(meta.userId).toBe(advocateUserId);
    expect(meta.leaveType).toBe('compassionate');
    expect(meta.days).toBe(5);
  });

  test('20. Dashboard returns pending leave count', async () => {
    const res = await request(app)
      .get('/api/hr/dashboard')
      .set(auth(adminToken))
      .query({ year: testYear });
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.pendingLeaveCount).toBe('number');
    // There should be at least 1 pending leave from test 11
    expect(res.body.pendingLeaveCount).toBeGreaterThanOrEqual(1);
  });

  test('21. Dashboard returns staff without profiles count', async () => {
    const res = await request(app)
      .get('/api/hr/dashboard')
      .set(auth(adminToken))
      .query({ year: testYear });
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.staffWithoutProfiles).toBe('number');
  });

  test('22. Dashboard returns staff currently on leave today based on approved date range', async () => {
    const res = await request(app)
      .get('/api/hr/dashboard')
      .set(auth(adminToken))
      .query({ year: testYear });
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.staffCurrentlyOnLeave).toBe('number');
  });

  test('23. Dashboard returns upcoming approved leave count', async () => {
    const res = await request(app)
      .get('/api/hr/dashboard')
      .set(auth(adminToken))
      .query({ year: testYear });
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.upcomingApprovedLeaveCount).toBe('number');
  });

  test('24. Dashboard returns low/negative annual balance count', async () => {
    const res = await request(app)
      .get('/api/hr/dashboard')
      .set(auth(adminToken))
      .query({ year: testYear });
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.lowAnnualBalanceCount).toBe('number');
  });

  test('25. Invalid year rejected', async () => {
    const res1 = await request(app)
      .get('/api/hr/dashboard')
      .set(auth(adminToken))
      .query({ year: 1999 });
    expect(res1.statusCode).toBe(400);

    const res2 = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: 2101 });
    expect(res2.statusCode).toBe(400);

    const res3 = await request(app)
      .put(`/api/hr/leave-entitlements/${advocateUserId}/annual/1999`)
      .set(auth(adminToken))
      .send({ entitlementDays: 10 });
    expect(res3.statusCode).toBe(400);

    const res4 = await request(app)
      .post('/api/hr/leave-balance-adjustments')
      .set(auth(adminToken))
      .send({ userId: advocateUserId, leaveType: 'annual', year: 2101, days: 5 });
    expect(res4.statusCode).toBe(400);

    const res5 = await request(app)
      .get('/api/hr/me/leave-balances')
      .set(auth(advocateToken))
      .query({ year: 'abcd' });
    expect(res5.statusCode).toBe(400);
  });

  test('26. Invalid leaveType rejected', async () => {
    const res1 = await request(app)
      .put(`/api/hr/leave-entitlements/${advocateUserId}/invalid_type/${testYear}`)
      .set(auth(adminToken))
      .send({ entitlementDays: 10 });
    expect(res1.statusCode).toBe(400);

    const res2 = await request(app)
      .post('/api/hr/leave-balance-adjustments')
      .set(auth(adminToken))
      .send({ userId: advocateUserId, leaveType: 'invalid_type', year: testYear, days: 5 });
    expect(res2.statusCode).toBe(400);
  });

  test('27. Invalid entitlementDays rejected', async () => {
    const res1 = await request(app)
      .put(`/api/hr/leave-entitlements/${advocateUserId}/annual/${testYear}`)
      .set(auth(adminToken))
      .send({ entitlementDays: -1 });
    expect(res1.statusCode).toBe(400);

    const res2 = await request(app)
      .put(`/api/hr/leave-entitlements/${advocateUserId}/annual/${testYear}`)
      .set(auth(adminToken))
      .send({ entitlementDays: 366 });
    expect(res2.statusCode).toBe(400);

    const res3 = await request(app)
      .put(`/api/hr/leave-entitlements/${advocateUserId}/annual/${testYear}`)
      .set(auth(adminToken))
      .send({ entitlementDays: 'abc' });
    expect(res3.statusCode).toBe(400);
  });

  test('28. Invalid adjustment days rejected', async () => {
    const res1 = await request(app)
      .post('/api/hr/leave-balance-adjustments')
      .set(auth(adminToken))
      .send({ userId: advocateUserId, leaveType: 'annual', year: testYear, days: 0 });
    expect(res1.statusCode).toBe(400);

    const res2 = await request(app)
      .post('/api/hr/leave-balance-adjustments')
      .set(auth(adminToken))
      .send({ userId: advocateUserId, leaveType: 'annual', year: testYear, days: -366 });
    expect(res2.statusCode).toBe(400);

    const res3 = await request(app)
      .post('/api/hr/leave-balance-adjustments')
      .set(auth(adminToken))
      .send({ userId: advocateUserId, leaveType: 'annual', year: testYear, days: 366 });
    expect(res3.statusCode).toBe(400);
  });

  test('29. No hrStatus auto-update occurs when leave is approved or balances are computed', async () => {
    const profile = await dbGet('SELECT hrStatus FROM hr_staff_profiles WHERE userId=?', [advocateUserId]);
    const beforeStatus = profile ? profile.hrStatus : null;

    const res = await request(app)
      .get('/api/hr/leave-balances')
      .set(auth(adminToken))
      .query({ year: testYear, userId: advocateUserId });
    expect(res.statusCode).toBe(200);

    const afterProfile = await dbGet('SELECT hrStatus FROM hr_staff_profiles WHERE userId=?', [advocateUserId]);
    const afterStatus = afterProfile ? afterProfile.hrStatus : null;
    expect(afterStatus).toBe(beforeStatus);

    // Also test that entitlement/adjustment doesn't change hrStatus
    const profile2 = await dbGet('SELECT hrStatus FROM hr_staff_profiles WHERE userId=?', [assistantUserId]);
    const asstBeforeStatus = profile2 ? profile2.hrStatus : null;

    await request(app)
      .put(`/api/hr/leave-entitlements/${assistantUserId}/annual/${testYear}`)
      .set(auth(adminToken))
      .send({ entitlementDays: 22 });

    const afterProfile2 = await dbGet('SELECT hrStatus FROM hr_staff_profiles WHERE userId=?', [assistantUserId]);
    expect(afterProfile2 ? afterProfile2.hrStatus : null).toBe(asstBeforeStatus);
  });

  test('30. No salary/offboarding tables or fields are introduced; balance actions create no HR document/contract rows', async () => {
    const tables = await dbAll("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = tables.map(t => t.name);
    expect(tableNames).not.toContain('hr_contracts');
    expect(tableNames).not.toContain('hr_salary');
    expect(tableNames).not.toContain('hr_offboarding');
    expect(tableNames).not.toContain('hr_notifications');

    // HR-29E intentionally introduced hr_documents and hr_contract_records as a
    // separate phase. The continuing guarantee here is that HR-29D entitlement
    // and balance actions do not create HR document rows or contract records for
    // the staff user, and never mutate those records.
    const hrDocs = await dbGet("SELECT COUNT(*) AS cnt FROM hr_documents WHERE userId=?", [advocateUserId]);
    expect(hrDocs.cnt).toBe(0);
    const hrContracts = await dbGet("SELECT COUNT(*) AS cnt FROM hr_contract_records WHERE userId=?", [advocateUserId]);
    expect(hrContracts.cnt).toBe(0);

    const entColumns = await dbAll("PRAGMA table_info(hr_leave_entitlements)");
    const entColNames = entColumns.map(c => c.name);
    expect(entColNames).not.toContain('salary');
    expect(entColNames).not.toContain('allowance');
    expect(entColNames).not.toContain('contractId');
    expect(entColNames).not.toContain('documentId');

    const adjColumns = await dbAll("PRAGMA table_info(hr_leave_balance_adjustments)");
    const adjColNames = adjColumns.map(c => c.name);
    expect(adjColNames).not.toContain('salary');
    expect(adjColNames).not.toContain('allowance');
  });
});
