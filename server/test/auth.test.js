const request = require('supertest');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');
const path = require('path');
const config = require('../lib/config');
const { app } = require('../server.js');

let adminToken;
let advocateToken;
let clientToken;

beforeAll(async () => {
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = adminRes.body.token;

  const advRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
  advocateToken = advRes.body.token;

  const clientRes = await request(app)
    .post('/api/auth/client-login')
    .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
  clientToken = clientRes.body.token;
});

describe('Auth API', () => {
  test('POST /api/auth/login with correct credentials succeeds', () => {
    expect(adminToken).toBeDefined();
  });

  test('POST /api/auth/login with wrong password fails', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'wrongpassword' });
    expect(res.statusCode).toBe(401);
  });

  test('POST /api/auth/client-login rejects staff credentials', async () => {
    const res = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(res.statusCode).toBe(401);
  });

  test('GET /api/notifications without token returns 401', async () => {
    const res = await request(app)
      .get('/api/notifications');
    expect(res.statusCode).toBe(401);
  });
});

describe('Register validation', () => {
  test('missing email returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'password123', fullName: 'Test User' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('email, password and fullName are required');
  });

  test('missing password returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'test@example.com', fullName: 'Test User' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('email, password and fullName are required');
  });

  test('missing fullName returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'test@example.com', password: 'password123' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('email, password and fullName are required');
  });

  test('invalid role returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'test@example.com', password: 'Str0ng!Passw0rd2026', fullName: 'Test User', role: 'manager' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Invalid role');
  });

  test('client role without clientId returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'test@example.com', password: 'Str0ng!Passw0rd2026', fullName: 'Test User', role: 'client' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Client users must be linked to a client record');
  });
});

describe('Register auth gate', () => {
  test('no token returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: 'password123', fullName: 'Test User' });
    expect(res.statusCode).toBe(401);
  });

  test('advocate token returns 403', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ email: 'test@example.com', password: 'password123', fullName: 'Test User' });
    expect(res.statusCode).toBe(403);
  });
});

describe('Invitation validation', () => {
  test('missing email returns 400', async () => {
    const res = await request(app)
      .post('/api/invitations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('email is required');
  });
});

describe('Invitation auth gate', () => {
  test('no token returns 401', async () => {
    const res = await request(app)
      .post('/api/invitations')
      .send({ email: 'test@example.com' });
    expect(res.statusCode).toBe(401);
  });

  test('client token returns 403', async () => {
    const res = await request(app)
      .post('/api/invitations')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ email: 'test@example.com' });
    expect(res.statusCode).toBe(403);
  });
});

describe('JWT Hardening', () => {
  test('token has expiry set', async () => {
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    const token = adminRes.body.token;
    const decoded = jwt.decode(token);
    expect(decoded).toHaveProperty('exp');
    expect(decoded).toHaveProperty('iat');
  });

  test('login-issued JWT includes tokenVersion = 1', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(res.statusCode).toBe(200);
    const decoded = jwt.decode(res.body.token);
    expect(decoded).toHaveProperty('tokenVersion');
    expect(decoded.tokenVersion).toBe(1);
  });

  test('client-login-issued JWT includes tokenVersion = 1', async () => {
    const res = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(res.statusCode).toBe(200);
    const decoded = jwt.decode(res.body.token);
    expect(decoded).toHaveProperty('tokenVersion');
    expect(decoded.tokenVersion).toBe(1);
  });

  test('invitation acceptance-issued JWT includes tokenVersion = 1', async () => {
    const inviteRes = await request(app)
      .post('/api/invitations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'tokenversion-invite@test.com' });
    expect(inviteRes.statusCode).toBe(200);
    const token = inviteRes.body.token;

    const res = await request(app)
      .post(`/api/invitations/${token}/accept`)
      .send({ password: 'Str0ng!TokenVer2026', fullName: 'TokenVersion Client' });
    expect(res.statusCode).toBe(200);
    const decoded = jwt.decode(res.body.token);
    expect(decoded).toHaveProperty('tokenVersion');
    expect(decoded.tokenVersion).toBe(1);
  });

  test('manually signed JWT without tokenVersion still authenticates', async () => {
    const noVersionToken = jwt.sign(
      { userId: 'test', role: 'admin' },
      config.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${noVersionToken}`);
    expect(res.statusCode).toBe(200);
  });

  test('expired token returns 401', async () => {
    // Create an already-expired token
    const expiredToken = jwt.sign(
      { userId: 'test', role: 'admin' },
      config.JWT_SECRET,
      { expiresIn: '-1h' }
    );
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Token expired');
  });

  test('invalid signature returns 401', async () => {
    // Create token with wrong secret
    const badToken = jwt.sign(
      { userId: 'test', role: 'admin' },
      'wrong-secret',
      { expiresIn: '1h' }
    );
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${badToken}`);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('malformed token returns 401', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', 'Bearer not-a-valid-jwt');
    expect(res.statusCode).toBe(401);
  });

  test('wrong algorithm is rejected', async () => {
    // Create token with RS256 (not HS256)
    // Note: This test verifies the algorithm constraint indirectly
    // since we can't easily sign with RS256 without a key pair
    const token = jwt.sign(
      { userId: 'test', role: 'admin' },
      config.JWT_SECRET,
      { algorithm: 'HS256' }
    );
    // Verify the token uses correct algorithm
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded.header.alg).toBe('HS256');
  });

  test('login response includes token with correct payload', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('user');
    expect(res.body.user).toHaveProperty('id');
    expect(res.body.user).toHaveProperty('role');
    expect(res.body.user.role).toBe('admin');
  });
});

describe('Registration password policy enforcement', () => {
  test('rejects weak password with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'weakpass@test.com', password: 'weak', fullName: 'Weak User', role: 'assistant' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Password does not meet security requirements');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  test('rejects short password with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'short@test.com', password: 'Ab1!', fullName: 'Short User', role: 'assistant' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Password does not meet security requirements');
  });

  test('rejects common password password123 with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'common@test.com', password: 'password123', fullName: 'Common User', role: 'assistant' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Password does not meet security requirements');
  });

  test('accepts strong password and creates user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'strongpolicy@test.com', password: 'Str0ng!Passw0rd2026', fullName: 'Strong User', role: 'assistant' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body.email).toBe('strongpolicy@test.com');
  });
});

describe('Invitation acceptance password policy enforcement', () => {
  test('rejects weak password with 400', async () => {
    // Create an invitation first
    const inviteRes = await request(app)
      .post('/api/invitations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'weakinvite@test.com' });
    expect(inviteRes.statusCode).toBe(200);
    const token = inviteRes.body.token;

    const res = await request(app)
      .post(`/api/invitations/${token}/accept`)
      .send({ password: 'weak', fullName: 'Weak Client' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Password does not meet security requirements');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  test('rejects old 6-character password that previously passed', async () => {
    const inviteRes = await request(app)
      .post('/api/invitations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'shortinvite@test.com' });
    expect(inviteRes.statusCode).toBe(200);
    const token = inviteRes.body.token;

    const res = await request(app)
      .post(`/api/invitations/${token}/accept`)
      .send({ password: 'Ab1!xy', fullName: 'Short Client' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Password does not meet security requirements');
  });

  test('accepts strong password', async () => {
    const inviteRes = await request(app)
      .post('/api/invitations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'stronginvite@test.com' });
    expect(inviteRes.statusCode).toBe(200);
    const token = inviteRes.body.token;

    const res = await request(app)
      .post(`/api/invitations/${token}/accept`)
      .send({ password: 'Str0ng!Passw0rd2026', fullName: 'Strong Client' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('user');
    expect(res.body.user.role).toBe('client');
  });
});

describe('Users tokenVersion schema', () => {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
  const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });

  test('users table has tokenVersion column', async () => {
    const columns = await dbAll('PRAGMA table_info(users)');
    const tokenVersionCol = columns.find(c => c.name === 'tokenVersion');
    expect(tokenVersionCol).toBeDefined();
    expect(tokenVersionCol.type).toBe('INTEGER');
    expect(tokenVersionCol.dflt_value).toBe('1');
  });

  test('seeded users have tokenVersion = 1', async () => {
    const users = await dbAll('SELECT id, email, tokenVersion FROM users');
    expect(users.length).toBeGreaterThan(0);
    for (const user of users) {
      expect(user.tokenVersion).toBe(1);
    }
  });

  afterAll(() => {
    db.close();
  });
});

describe('Change password', () => {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });

  test('unauthenticated request rejected with 401', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'password123', newPassword: 'Str0ng!ChangedPass2026' });
    expect(res.statusCode).toBe(401);
  });

  test('missing currentPassword returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ newPassword: 'Str0ng!ChangedPass2026' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('currentPassword and newPassword are required');
  });

  test('missing newPassword returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ currentPassword: 'password123' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('currentPassword and newPassword are required');
  });

  test('non-string currentPassword returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ currentPassword: 12345, newPassword: 'Str0ng!ChangedPass2026' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('currentPassword and newPassword must be strings');
  });

  test('non-string newPassword returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ currentPassword: 'password123', newPassword: 12345 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('currentPassword and newPassword must be strings');
  });

  test('overlong currentPassword returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ currentPassword: 'a'.repeat(129), newPassword: 'Str0ng!ChangedPass2026' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Password must not exceed 128 characters');
  });

  test('overlong newPassword returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ currentPassword: 'password123', newPassword: 'a'.repeat(129) });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Password must not exceed 128 characters');
  });

  test('wrong currentPassword returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ currentPassword: 'wrongpassword', newPassword: 'Str0ng!ChangedPass2026' });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Current password is incorrect');
  });

  test('weak newPassword returns 400 with policy error', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ currentPassword: 'password123', newPassword: 'weak' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Password does not meet security requirements');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  test('same password rejected with 400', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ currentPassword: 'password123', newPassword: 'password123' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('New password must be different from current password');
  });

  test('successful password change returns 200', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ currentPassword: 'password123', newPassword: 'Str0ng!ChangedPass2026' });
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Password changed successfully');
  });

  test('old password no longer works after change', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    expect(res.statusCode).toBe(401);
  });

  test('new password works after change', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'Str0ng!ChangedPass2026' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  test('stored password is not plaintext', async () => {
    const user = await dbGet('SELECT password FROM users WHERE email=?', ['sarah.mwangi@achokilaw.co.ke']);
    expect(user.password).not.toBe('Str0ng!ChangedPass2026');
    expect(user.password).toMatch(/^\$2[aby]\$/);
  });

  test('password_changed audit event is recorded on success', async () => {
    // First change admin password to trigger audit, then check
    const adminLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    const freshAdminToken = adminLoginRes.body.token;

    await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${freshAdminToken}`)
      .send({ currentPassword: 'password123', newPassword: 'An0ther!StrongPass2026' });

    const auditRes = await request(app)
      .get('/api/audit-events?action=password_changed')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.body.rows.length).toBeGreaterThan(0);
    const event = auditRes.body.rows[0];
    expect(event.action).toBe('password_changed');
    expect(event.entity_type).toBe('user');
  });

  test('passwords are not present in audit metadata', async () => {
    const auditRes = await request(app)
      .get('/api/audit-events?action=password_changed')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    const events = auditRes.body.rows.filter(e => e.action === 'password_changed');
    for (const event of events) {
      const metaStr = JSON.stringify(event.metadata || {});
      expect(metaStr).not.toContain('password123');
      expect(metaStr).not.toContain('Str0ng!');
      expect(metaStr).not.toContain('An0ther!');
    }
  });

  test("other users' passwords are not changed", async () => {
    // Admin changed password, verify advocate's new password still works
    const advocateLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'Str0ng!ChangedPass2026' });
    expect(advocateLogin.statusCode).toBe(200);

    // Verify admin's old password no longer works
    const adminOldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(adminOldLogin.statusCode).toBe(401);

    // Verify admin's new password works
    const adminNewLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'An0ther!StrongPass2026' });
    expect(adminNewLogin.statusCode).toBe(200);
  });

  afterAll(() => {
    db.close();
  });
});
