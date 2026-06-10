// LOCAL-PILOT-FIX-1 — owner pilot blockers:
// 1. self-service password change (backend already existed; now exposed in UI),
// 2. LEXFLOW_DISABLE_RATE_LIMIT env switch for local pilot runs,
// 3. document upload 413 (per-path JSON body limits + clear JSON 413 error).
const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app } = require('../server.js');

const TEST_EMAIL = 'local-pilot-blockers@test.lexflow.co.ke';
const START_PASSWORD = 'PilotStart2026!x';
const NEW_PASSWORD = 'PilotNext2026!y';

let adminToken;
let pilotToken;
let pilotUserId;
let matterId;
const uploadedDocumentIds = [];

const db = new sqlite3.Database(config.DATABASE_PATH);
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, err => err ? reject(err) : resolve());
});

beforeAll(async () => {
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = adminRes.body.token;
  expect(adminToken).toBeDefined();

  // Dedicated user so this suite never touches the seeded credentials other
  // suites (auth.test.js etc.) depend on.
  const registerRes = await request(app)
    .post('/api/auth/register')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: TEST_EMAIL, password: START_PASSWORD, fullName: 'Pilot Blockers Test User', role: 'assistant' });
  expect(registerRes.statusCode).toBe(200);
  pilotUserId = registerRes.body.id || registerRes.body.user?.id;

  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email: TEST_EMAIL, password: START_PASSWORD });
  pilotToken = loginRes.body.token;
  expect(pilotToken).toBeDefined();

  const mattersRes = await request(app)
    .get('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`);
  const matters = Array.isArray(mattersRes.body) ? mattersRes.body : (mattersRes.body.matters || []);
  expect(matters.length).toBeGreaterThan(0);
  matterId = matters[0].id;
});

afterAll(async () => {
  try {
    await dbRun('DELETE FROM users WHERE email=?', [TEST_EMAIL]);
    for (const docId of uploadedDocumentIds) {
      await dbRun('DELETE FROM documents WHERE id=?', [docId]);
    }
  } finally {
    db.close();
  }
});

describe('P0-1 Password change', () => {
  test('wrong current password is rejected and does not change the password', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${pilotToken}`)
      .send({ currentPassword: 'definitely-wrong-Password1!', newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Current password is incorrect');
    // Old password still works.
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: START_PASSWORD });
    expect(loginRes.statusCode).toBe(200);
  });

  test('client users can also reach the change-password route (not staff-only)', async () => {
    const clientLogin = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(clientLogin.statusCode).toBe(200);
    // Wrong current password on purpose: proves the route is reachable for
    // clients (no 403) without actually changing seeded credentials.
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${clientLogin.body.token}`)
      .send({ currentPassword: 'definitely-wrong-Password1!', newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Current password is incorrect');
  });

  test('authenticated user can change own password', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${pilotToken}`)
      .send({ currentPassword: START_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Password changed successfully');
  });

  test('old password no longer works after change', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: START_PASSWORD });
    expect(res.statusCode).toBe(401);
  });

  test('new password works after change', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: NEW_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  test('old token is invalidated after change (tokenVersion bump)', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${pilotToken}`);
    expect(res.statusCode).toBe(401);
  });
});

describe('P0-2 Rate limit env switch', () => {
  function loadFreshConfig(env) {
    const saved = {};
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    let freshConfig;
    jest.isolateModules(() => {
      freshConfig = require('../lib/config');
    });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return freshConfig;
  }

  test('LEXFLOW_DISABLE_RATE_LIMIT=true disables limits outside production', () => {
    const fresh = loadFreshConfig({ NODE_ENV: 'development', LEXFLOW_DISABLE_RATE_LIMIT: 'true' });
    expect(fresh.DISABLE_RATE_LIMIT).toBe(true);
    expect(fresh.rateLimitConfig(900000, 100).max).toBe(999999);
  });

  test('default development behaviour is unchanged without the flag', () => {
    const fresh = loadFreshConfig({ NODE_ENV: 'development', LEXFLOW_DISABLE_RATE_LIMIT: undefined });
    expect(fresh.DISABLE_RATE_LIMIT).toBe(false);
    const limiter = fresh.rateLimitConfig(900000, 100);
    expect(limiter.max).toBe(100);
    expect(limiter.windowMs).toBe(900000);
  });

  test('the flag is ignored in production', () => {
    const fresh = loadFreshConfig({
      NODE_ENV: 'production',
      LEXFLOW_DISABLE_RATE_LIMIT: 'true',
      JWT_SECRET: 'production-test-secret-not-default-0123456789',
    });
    expect(fresh.DISABLE_RATE_LIMIT).toBe(false);
    expect(fresh.rateLimitConfig(900000, 100).max).toBe(100);
  });
});

describe('P0-3 Document upload body limits', () => {
  test('normal document upload succeeds (2 MB file, over the old 1mb global cap)', async () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 0x61).toString('base64');
    const res = await request(app)
      .post(`/api/matters/${matterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'pilot-upload-test.pdf', mimeType: 'application/pdf', data: `data:application/pdf;base64,${data}` });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    uploadedDocumentIds.push(res.body.id);
  });

  test('oversized upload returns a clear JSON 413 without crashing', async () => {
    // ~40 MB of base64 — over the 34mb upload body limit (≈25 MB raw file).
    const res = await request(app)
      .post(`/api/matters/${matterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'too-big.pdf', mimeType: 'application/pdf', data: 'A'.repeat(40 * 1024 * 1024) });
    expect(res.statusCode).toBe(413);
    expect(res.body.code).toBe('payload_too_large');
    expect(res.body.error).toContain(`maximum upload size is ${config.UPLOAD_MAX_FILE_MB} MB`);
    // Server is still healthy afterwards.
    const health = await request(app).get('/health');
    expect(health.statusCode).toBe(200);
  });

  test('non-upload routes keep the standard 1mb body limit', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ currentPassword: 'x'.repeat(2 * 1024 * 1024), newPassword: 'irrelevant' });
    expect(res.statusCode).toBe(413);
    expect(res.body.code).toBe('payload_too_large');
    expect(res.body.error).toBe('Request body is too large.');
  });

  test('file type policy is unchanged (disallowed mime still rejected)', async () => {
    const res = await request(app)
      .post(`/api/matters/${matterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('hello').toString('base64') });
    expect(res.statusCode).toBe(400);
  });

  test('upload still requires authentication', async () => {
    const res = await request(app)
      .post(`/api/matters/${matterId}/documents`)
      .send({ name: 'anon.pdf', mimeType: 'application/pdf', data: Buffer.from('hello').toString('base64') });
    expect(res.statusCode).toBe(401);
  });
});
