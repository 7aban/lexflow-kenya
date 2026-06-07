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

const validLeavePayload = {
  leaveType: 'annual',
  startDate: '2026-07-01',
  endDate: '2026-07-05',
  reason: 'Family vacation',
};

describe('HR-29C leave requests and approval workflow', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let adminUserId;
  let advocateUserId;
  let assistantUserId;
  let createdLeaveId;

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
    if (createdLeaveId) {
      await dbRun('DELETE FROM audit_events WHERE entity_id=?', [createdLeaveId]);
      await dbRun('DELETE FROM hr_leave_requests WHERE id=?', [createdLeaveId]);
    }
  });

  test('1. Table exists', async () => {
    const row = await dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name='hr_leave_requests'");
    expect(row).not.toBeNull();
  });

  test('2. Staff can submit own leave request', async () => {
    const res = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send(validLeavePayload);

    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.userId).toBe(advocateUserId);
    expect(res.body.leaveType).toBe('annual');
    expect(res.body.startDate).toBe('2026-07-01');
    expect(res.body.endDate).toBe('2026-07-05');
    expect(res.body.days).toBe(5);
    expect(res.body.status).toBe('pending');
    expect(res.body.reason).toBe('Family vacation');
    expect(res.body.requestedAt).toBeTruthy();
    expect(res.body.createdAt).toBeTruthy();
    createdLeaveId = res.body.id;
  });

  test('3. Staff can list own leave requests', async () => {
    const res = await request(app)
      .get('/api/hr/me/leave-requests')
      .set(auth(advocateToken));

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body.some(r => r.id === createdLeaveId)).toBe(true);
  });

  test('4. Staff cannot see another user leave through self-service', async () => {
    const res = await request(app)
      .get('/api/hr/me/leave-requests')
      .set(auth(assistantToken));

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(r => r.id === createdLeaveId)).toBe(false);
  });

  test('5. Staff can cancel own pending request', async () => {
    const createRes = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'sick', startDate: '2026-08-01', endDate: '2026-08-02', reason: 'Test cancel' });
    expect(createRes.statusCode).toBe(201);
    const cancelId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/hr/me/leave-requests/${cancelId}/cancel`)
      .set(auth(advocateToken));

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.cancelledBy).toBe(advocateUserId);

    await dbRun('DELETE FROM audit_events WHERE entity_id=?', [cancelId]);
    await dbRun('DELETE FROM hr_leave_requests WHERE id=?', [cancelId]);
  });

  test('6. Staff cannot cancel own approved request', async () => {
    const createRes = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'sick', startDate: '2026-09-01', endDate: '2026-09-02', reason: 'Test cancel approved' });
    expect(createRes.statusCode).toBe(201);
    const testId = createRes.body.id;

    await dbRun('UPDATE hr_leave_requests SET status=? WHERE id=?', ['approved', testId]);

    const res = await request(app)
      .patch(`/api/hr/me/leave-requests/${testId}/cancel`)
      .set(auth(advocateToken));

    expect(res.statusCode).toBe(400);

    await dbRun('DELETE FROM audit_events WHERE entity_id=?', [testId]);
    await dbRun('DELETE FROM hr_leave_requests WHERE id=?', [testId]);
  });

  test('7. Client cannot use self-service HR leave route', async () => {
    const res = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(clientToken))
      .send(validLeavePayload);

    expect(res.statusCode).toBe(403);
  });

  test('8. Admin can list all leave requests', async () => {
    const res = await request(app)
      .get('/api/hr/leave-requests')
      .set(auth(adminToken));

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(r => r.id === createdLeaveId)).toBe(true);
  });

  test('9. Advocate/assistant cannot access admin leave list', async () => {
    const advRes = await request(app)
      .get('/api/hr/leave-requests')
      .set(auth(advocateToken));
    const asstRes = await request(app)
      .get('/api/hr/leave-requests')
      .set(auth(assistantToken));

    expect(advRes.statusCode).toBe(403);
    expect(asstRes.statusCode).toBe(403);
  });

  test('10. Client cannot access admin leave list', async () => {
    const res = await request(app)
      .get('/api/hr/leave-requests')
      .set(auth(clientToken));

    expect(res.statusCode).toBe(403);
  });

  test('11. Admin can approve pending request', async () => {
    const res = await request(app)
      .patch(`/api/hr/leave-requests/${createdLeaveId}/approve`)
      .set(auth(adminToken))
      .send({ decisionNote: 'Approved for family vacation' });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.decidedBy).toBe(adminUserId);
    expect(res.body.decidedAt).toBeTruthy();
    expect(res.body.decisionNote).toBe('Approved for family vacation');
  });

  test('12. Admin can reject pending request', async () => {
    const createRes = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'unpaid', startDate: '2026-10-01', endDate: '2026-10-03', reason: 'Rejection test' });
    expect(createRes.statusCode).toBe(201);
    const rejectId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/hr/leave-requests/${rejectId}/reject`)
      .set(auth(adminToken))
      .send({ decisionNote: 'Not enough cover' });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.decidedBy).toBe(adminUserId);
    expect(res.body.decisionNote).toBe('Not enough cover');

    await dbRun('DELETE FROM audit_events WHERE entity_id=?', [rejectId]);
    await dbRun('DELETE FROM hr_leave_requests WHERE id=?', [rejectId]);
  });

  test('13. Admin can cancel pending request', async () => {
    const createRes = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'compassionate', startDate: '2026-11-01', endDate: '2026-11-02', reason: 'Admin cancel test' });
    expect(createRes.statusCode).toBe(201);
    const cancelId2 = createRes.body.id;

    const res = await request(app)
      .patch(`/api/hr/leave-requests/${cancelId2}/cancel`)
      .set(auth(adminToken));

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.cancelledBy).toBe(adminUserId);

    await dbRun('DELETE FROM audit_events WHERE entity_id=?', [cancelId2]);
    await dbRun('DELETE FROM hr_leave_requests WHERE id=?', [cancelId2]);
  });

  test('14. Admin cannot approve already approved/rejected/cancelled request', async () => {
    const approveAgain = await request(app)
      .patch(`/api/hr/leave-requests/${createdLeaveId}/approve`)
      .set(auth(adminToken));
    expect(approveAgain.statusCode).toBe(400);

    const rejRes = await request(app)
      .patch(`/api/hr/leave-requests/${createdLeaveId}/reject`)
      .set(auth(adminToken));
    expect(rejRes.statusCode).toBe(400);

    const cancelRes = await request(app)
      .patch(`/api/hr/leave-requests/${createdLeaveId}/cancel`)
      .set(auth(adminToken));
    expect(cancelRes.statusCode).toBe(400);
  });

  test('15. Invalid leaveType rejected', async () => {
    const res = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ ...validLeavePayload, leaveType: 'invalid_type' });
    expect(res.statusCode).toBe(400);
  });

  test('16. Missing startDate rejected', async () => {
    const res = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'annual', endDate: '2026-07-05', reason: 'no start' });
    expect(res.statusCode).toBe(400);
  });

  test('17. Missing endDate rejected', async () => {
    const res = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'annual', startDate: '2026-07-01', reason: 'no end' });
    expect(res.statusCode).toBe(400);
  });

  test('18. endDate before startDate rejected', async () => {
    const res = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'annual', startDate: '2026-07-10', endDate: '2026-07-05', reason: 'reversed' });
    expect(res.statusCode).toBe(400);
  });

  test('19. Reason too long rejected', async () => {
    const res = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'annual', startDate: '2026-07-01', endDate: '2026-07-05', reason: 'x'.repeat(2001) });
    expect(res.statusCode).toBe(400);
  });

  test('20. days are calculated inclusively', async () => {
    const res = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'sick', startDate: '2026-07-01', endDate: '2026-07-01', reason: 'Single day' });
    expect(res.statusCode).toBe(201);
    expect(res.body.days).toBe(1);

    await dbRun('DELETE FROM audit_events WHERE entity_id=?', [res.body.id]);
    await dbRun('DELETE FROM hr_leave_requests WHERE id=?', [res.body.id]);

    const res2 = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'sick', startDate: '2026-07-01', endDate: '2026-07-07', reason: 'Full week' });
    expect(res2.statusCode).toBe(201);
    expect(res2.body.days).toBe(7);

    await dbRun('DELETE FROM audit_events WHERE entity_id=?', [res2.body.id]);
    await dbRun('DELETE FROM hr_leave_requests WHERE id=?', [res2.body.id]);
  });

  test('21. leave_requested audit event recorded', async () => {
    const rows = await dbAll("SELECT action, metadata_json FROM audit_events WHERE entity_id=? AND action='leave_requested'", [createdLeaveId]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some(r => r.action === 'leave_requested')).toBe(true);
  });

  test('22. leave_approved audit event recorded', async () => {
    const rows = await dbAll("SELECT action, metadata_json FROM audit_events WHERE entity_id=? AND action='leave_approved'", [createdLeaveId]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some(r => r.action === 'leave_approved')).toBe(true);
  });

  test('23. leave_rejected audit event recorded', async () => {
    const rejRes = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'unpaid', startDate: '2026-12-01', endDate: '2026-12-02', reason: 'Audit reject test' });
    expect(rejRes.statusCode).toBe(201);
    const rejId = rejRes.body.id;

    await request(app)
      .patch(`/api/hr/leave-requests/${rejId}/reject`)
      .set(auth(adminToken))
      .send({ decisionNote: 'Rejected for audit' });

    const rows = await dbAll("SELECT action, metadata_json FROM audit_events WHERE entity_id=? AND action='leave_rejected'", [rejId]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some(r => r.action === 'leave_rejected')).toBe(true);

    await dbRun('DELETE FROM audit_events WHERE entity_id=?', [rejId]);
    await dbRun('DELETE FROM hr_leave_requests WHERE id=?', [rejId]);
  });

  test('24. leave_cancelled audit event recorded', async () => {
    const createRes = await request(app)
      .post('/api/hr/me/leave-requests')
      .set(auth(advocateToken))
      .send({ leaveType: 'sick', startDate: '2026-12-10', endDate: '2026-12-11', reason: 'Audit cancel test' });
    expect(createRes.statusCode).toBe(201);
    const cId = createRes.body.id;

    await request(app)
      .patch(`/api/hr/me/leave-requests/${cId}/cancel`)
      .set(auth(advocateToken));

    const rows = await dbAll("SELECT action, metadata_json FROM audit_events WHERE entity_id=? AND action='leave_cancelled'", [cId]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some(r => r.action === 'leave_cancelled')).toBe(true);

    await dbRun('DELETE FROM audit_events WHERE entity_id=?', [cId]);
    await dbRun('DELETE FROM hr_leave_requests WHERE id=?', [cId]);
  });

  test('25. Audit metadata excludes reason and decisionNote', async () => {
    const rows = await dbAll("SELECT action, metadata_json FROM audit_events WHERE entity_id=? AND action IN ('leave_requested','leave_approved','leave_rejected','leave_cancelled')", [createdLeaveId]);
    for (const row of rows) {
      const meta = JSON.parse(row.metadata_json || '{}');
      const serialized = JSON.stringify(meta);
      expect(serialized).not.toContain('reason');
      expect(serialized).not.toContain('decisionNote');
      expect(serialized).not.toContain('Family vacation');
      expect(serialized).not.toContain('Approved for family vacation');
      expect(meta.requestId).toBe(createdLeaveId);
      expect(meta.userId).toBe(advocateUserId);
      expect(meta.leaveType).toBeTruthy();
      expect(meta.startDate).toBeTruthy();
      expect(meta.endDate).toBeTruthy();
      expect(meta.days).toBeTruthy();
      expect(meta.status).toBeTruthy();
    }
  });

  test('26. Schema/response contains no medical diagnosis field', async () => {
    const res = await request(app)
      .get(`/api/hr/leave-requests/${createdLeaveId}`)
      .set(auth(adminToken));
    expect(res.statusCode).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('diagnosis');
    expect(serialized).not.toContain('medical');
    expect(serialized).not.toContain('medicalDetail');

    const tableInfo = await dbAll("PRAGMA table_info(hr_leave_requests)");
    const colNames = tableInfo.map(c => c.name);
    expect(colNames).not.toContain('diagnosis');
    expect(colNames).not.toContain('medicalDetail');
    expect(colNames).not.toContain('medical_notes');
  });

  test('27. Leave approval does not create entitlement/adjustment rows or other HR side effects', async () => {
    const entsAfter = await dbGet("SELECT COUNT(*) AS cnt FROM hr_leave_entitlements WHERE userId=? AND leaveType=?", [advocateUserId, 'annual']);
    expect(entsAfter.cnt).toBe(0);

    const adjsAfter = await dbGet("SELECT COUNT(*) AS cnt FROM hr_leave_balance_adjustments WHERE userId=? AND leaveType=?", [advocateUserId, 'annual']);
    expect(adjsAfter.cnt).toBe(0);

    const tables = await dbAll("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = tables.map(t => t.name);
    expect(tableNames).not.toContain('hr_contracts');
    expect(tableNames).not.toContain('hr_salary');
    expect(tableNames).not.toContain('hr_offboarding');
    expect(tableNames).not.toContain('hr_notifications');
    expect(tableNames).not.toContain('leave_balances');

    // HR-29E intentionally introduced hr_documents and hr_contract_records as a
    // separate phase. The continuing guarantee here is that HR-29C leave-request
    // actions do not create HR document rows or contract records for the staff
    // user, and never mutate those records.
    const hrDocs = await dbGet("SELECT COUNT(*) AS cnt FROM hr_documents WHERE userId=?", [advocateUserId]);
    expect(hrDocs.cnt).toBe(0);
    const hrContracts = await dbGet("SELECT COUNT(*) AS cnt FROM hr_contract_records WHERE userId=?", [advocateUserId]);
    expect(hrContracts.cnt).toBe(0);
  });
});
