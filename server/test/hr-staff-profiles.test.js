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

function expectNoPrivateAuthFields(payload) {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain('password');
  expect(serialized).not.toContain('passwordHash');
  expect(serialized).not.toContain('tokenVersion');
  expect(serialized).not.toContain('avatar');
  expect(serialized).not.toContain('resetToken');
  expect(serialized).not.toContain('accessToken');
  expect(serialized).not.toContain('refreshToken');
}

const hrPayload = {
  jobTitle: 'HR Test Assistant',
  department: 'Operations',
  practiceTeam: 'Litigation Support',
  employmentType: 'assistant',
  startDate: '2026-06-01',
  contractEndDate: '',
  supervisorUserId: '',
  workEmail: 'hr29b.staff@example.com',
  workPhone: '+254700000001',
  emergencyContactName: 'Jane Emergency',
  emergencyContactPhone: '+254700000002',
  hrStatus: 'active',
  adminNotes: 'Confidential HR-29B admin note',
};

describe('HR-29B staff HR profile basics', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let clientUserId;
  let testStaffUserId;
  let createdProfileId;
  const testStaffEmail = `hr29b.${Date.now()}@example.com`;

  beforeAll(async () => {
    await dbReady;

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;

    const advocateRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    expect(advocateRes.statusCode).toBe(200);
    advocateToken = advocateRes.body.token;

    const assistantRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' });
    expect(assistantRes.statusCode).toBe(200);
    assistantToken = assistantRes.body.token;

    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(clientRes.statusCode).toBe(200);
    clientToken = clientRes.body.token;
    clientUserId = clientRes.body.user.id;

    const registerRes = await request(app)
      .post('/api/auth/register')
      .set(auth(adminToken))
      .send({
        email: testStaffEmail,
        password: 'Str0ng!Passw0rd2026',
        fullName: 'HR Twenty Nine B',
        role: 'assistant',
      });
    expect(registerRes.statusCode).toBe(200);
    testStaffUserId = registerRes.body.id;
  });

  afterAll(async () => {
    if (createdProfileId) {
      await dbRun('DELETE FROM audit_events WHERE entity_id=?', [createdProfileId]);
    }
    if (testStaffUserId) {
      await dbRun('DELETE FROM hr_staff_profiles WHERE userId=?', [testStaffUserId]);
      await dbRun('DELETE FROM users WHERE id=?', [testStaffUserId]);
    }
  });

  test('Admin can list staff HR rows', async () => {
    const res = await request(app)
      .get('/api/hr/staff')
      .set(auth(adminToken));

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(row => row.userId === testStaffUserId)).toBe(true);
    res.body.forEach(row => {
      expect(['admin', 'advocate', 'assistant']).toContain(row.role);
      expect(row).toHaveProperty('isActive');
      expect(row).toHaveProperty('profile');
    });
  });

  test('Client users are excluded from HR staff list', async () => {
    const res = await request(app)
      .get('/api/hr/staff')
      .set(auth(adminToken));

    expect(res.statusCode).toBe(200);
    expect(res.body.some(row => row.role === 'client')).toBe(false);
    expect(res.body.some(row => row.userId === clientUserId)).toBe(false);
  });

  test('Client role cannot access HR routes', async () => {
    const res = await request(app)
      .get('/api/hr/staff')
      .set(auth(clientToken));

    expect(res.statusCode).toBe(403);
  });

  test('Advocate and assistant roles cannot access admin HR routes', async () => {
    const advocateRes = await request(app)
      .get('/api/hr/staff')
      .set(auth(advocateToken));
    const assistantRes = await request(app)
      .get(`/api/hr/staff/${testStaffUserId}/profile`)
      .set(auth(assistantToken));

    expect(advocateRes.statusCode).toBe(403);
    expect(assistantRes.statusCode).toBe(403);
  });

  test('Admin can create HR profile for staff user', async () => {
    const res = await request(app)
      .post(`/api/hr/staff/${testStaffUserId}/profile`)
      .set(auth(adminToken))
      .send(hrPayload);

    expect(res.statusCode).toBe(201);
    expect(res.body.staff.userId).toBe(testStaffUserId);
    expect(res.body.profile.userId).toBe(testStaffUserId);
    expect(res.body.profile.jobTitle).toBe(hrPayload.jobTitle);
    expect(res.body.profile.employmentType).toBe('assistant');
    createdProfileId = res.body.profile.id;
  });

  test('Admin cannot create HR profile for client user', async () => {
    const res = await request(app)
      .post(`/api/hr/staff/${clientUserId}/profile`)
      .set(auth(adminToken))
      .send(hrPayload);

    expect(res.statusCode).toBe(400);
  });

  test('Duplicate profile create is rejected', async () => {
    const res = await request(app)
      .post(`/api/hr/staff/${testStaffUserId}/profile`)
      .set(auth(adminToken))
      .send({ ...hrPayload, jobTitle: 'Duplicate HR Profile' });

    expect(res.statusCode).toBe(409);
  });

  test('Admin can update HR profile', async () => {
    const res = await request(app)
      .patch(`/api/hr/staff/${testStaffUserId}/profile`)
      .set(auth(adminToken))
      .send({
        jobTitle: 'Senior HR Test Assistant',
        department: 'Practice Operations',
        hrStatus: 'on_leave',
        adminNotes: 'Updated confidential HR-29B admin note',
        emergencyContactName: 'John Emergency',
        emergencyContactPhone: '+254700000003',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.profile.id).toBe(createdProfileId);
    expect(res.body.profile.jobTitle).toBe('Senior HR Test Assistant');
    expect(res.body.profile.department).toBe('Practice Operations');
    expect(res.body.profile.hrStatus).toBe('on_leave');
  });

  test('Invalid employmentType is rejected', async () => {
    const res = await request(app)
      .patch(`/api/hr/staff/${testStaffUserId}/profile`)
      .set(auth(adminToken))
      .send({ employmentType: 'partner' });

    expect(res.statusCode).toBe(400);
  });

  test('Invalid hrStatus is rejected', async () => {
    const res = await request(app)
      .patch(`/api/hr/staff/${testStaffUserId}/profile`)
      .set(auth(adminToken))
      .send({ hrStatus: 'terminated' });

    expect(res.statusCode).toBe(400);
  });

  test('Responses do not expose private auth fields', async () => {
    const listRes = await request(app)
      .get('/api/hr/staff')
      .set(auth(adminToken));
    const profileRes = await request(app)
      .get(`/api/hr/staff/${testStaffUserId}/profile`)
      .set(auth(adminToken));

    expect(listRes.statusCode).toBe(200);
    expect(profileRes.statusCode).toBe(200);
    expectNoPrivateAuthFields(listRes.body);
    expectNoPrivateAuthFields(profileRes.body);
  });

  test('Audit events are recorded and omit sensitive HR details', async () => {
    const rows = await dbAll(
      "SELECT action, entity_type, entity_id, metadata_json FROM audit_events WHERE entity_id=? AND action IN ('hr_profile_created','hr_profile_updated') ORDER BY timestamp ASC",
      [createdProfileId],
    );

    expect(rows.some(row => row.action === 'hr_profile_created')).toBe(true);
    expect(rows.some(row => row.action === 'hr_profile_updated')).toBe(true);
    rows.forEach(row => {
      expect(row.entity_type).toBe('hr_staff_profile');
      expect(row.entity_id).toBe(createdProfileId);
      const serialized = JSON.stringify(JSON.parse(row.metadata_json || '{}'));
      expect(serialized).not.toContain(hrPayload.adminNotes);
      expect(serialized).not.toContain('Updated confidential HR-29B admin note');
      expect(serialized).not.toContain(hrPayload.emergencyContactName);
      expect(serialized).not.toContain(hrPayload.emergencyContactPhone);
      expect(serialized).not.toContain('John Emergency');
      expect(serialized).not.toContain('+254700000003');
      expect(serialized).not.toContain('adminNotes');
      expect(serialized).not.toContain('emergencyContactName');
      expect(serialized).not.toContain('emergencyContactPhone');
    });
  });
});
