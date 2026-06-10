// LOCAL-PILOT-FIX-2 — owner pilot blockers:
// 1. password minimum length lowered to 8 (complexity rules unchanged),
// 2. OAuth availability endpoint (UI clarity) without breaking email/password login,
// 3. invoice creation: manual invoices + unbilled/outstanding tracking guards.
const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app } = require('../server.js');

const TEST_EMAIL = 'local-pilot-fix2@test.lexflow.co.ke';
const PASSWORD_8 = 'Pilot8!a'; // exactly 8 chars, meets complexity rules
const PASSWORD_8_NEXT = 'Next8!ab'; // exactly 8 chars, meets complexity rules
const PASSWORD_7 = 'Pi8!abc'; // 7 chars — under the new minimum

let adminToken;
let fix2Token;
let clientId;
let matterId;
const createdInvoiceIds = [];
let timeEntryId;

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

  // Dedicated client + matter so seeded billing data other suites rely on is
  // never mutated by invoice generation in this suite.
  const clientRes = await request(app)
    .post('/api/clients')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'LP-FIX2 Billing Client', type: 'Individual' });
  expect(clientRes.statusCode).toBe(200);
  clientId = clientRes.body.id;

  const matterRes = await request(app)
    .post('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title: 'LP-FIX2 Billing Matter', clientId, practiceArea: 'Civil', stage: 'Active' });
  expect(matterRes.statusCode).toBe(200);
  matterId = matterRes.body.id;
});

afterAll(async () => {
  try {
    await dbRun('DELETE FROM users WHERE email=?', [TEST_EMAIL]);
    for (const invoiceId of createdInvoiceIds) {
      await dbRun('DELETE FROM invoice_items WHERE invoiceId=?', [invoiceId]);
      await dbRun('DELETE FROM invoices WHERE id=?', [invoiceId]);
    }
    if (timeEntryId) await dbRun('DELETE FROM time_entries WHERE id=?', [timeEntryId]);
    if (matterId) {
      await dbRun('DELETE FROM matter_stage_history WHERE matterId=?', [matterId]);
      await dbRun('DELETE FROM matters WHERE id=?', [matterId]);
    }
    if (clientId) await dbRun('DELETE FROM clients WHERE id=?', [clientId]);
  } finally {
    db.close();
  }
});

describe('P0-1 Password policy minimum 8', () => {
  test('8-character policy-compliant password is accepted on register', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: TEST_EMAIL, password: PASSWORD_8, fullName: 'LP Fix2 User', role: 'assistant' });
    expect(res.statusCode).toBe(200);
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: PASSWORD_8 });
    expect(loginRes.statusCode).toBe(200);
    fix2Token = loginRes.body.token;
  });

  test('password under 8 characters is rejected with the length error', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'too-short@test.lexflow.co.ke', password: PASSWORD_7, fullName: 'Too Short', role: 'assistant' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Password does not meet security requirements');
    expect(res.body.details.join(' ')).toContain('at least 8 characters');
  });

  test('change-password accepts an 8-character new password', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${fix2Token}`)
      .send({ currentPassword: PASSWORD_8, newPassword: PASSWORD_8_NEXT });
    expect(res.statusCode).toBe(200);
  });

  test('old password is rejected after the change', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: PASSWORD_8 });
    expect(res.statusCode).toBe(401);
  });

  test('changed password works', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: PASSWORD_8_NEXT });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  test('change-password still rejects an under-8 new password', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: PASSWORD_8_NEXT });
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ currentPassword: PASSWORD_8_NEXT, newPassword: PASSWORD_7 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Password does not meet security requirements');
  });
});

describe('P0-2 OAuth clarity', () => {
  test('availability endpoint returns per-provider booleans for staff', async () => {
    const res = await request(app)
      .get('/api/connected-accounts/availability')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.google).toBe('boolean');
    expect(typeof res.body.microsoft).toBe('boolean');
    // Booleans only — never values that could leak configuration secrets.
    expect(JSON.stringify(res.body)).not.toMatch(/secret|client_id|clientId/i);
  });

  test('availability endpoint requires authentication', async () => {
    const res = await request(app).get('/api/connected-accounts/availability');
    expect(res.statusCode).toBe(401);
  });

  test('email/password login works regardless of OAuth configuration', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
  });
});

describe('P0-3 Invoice creation and tracking', () => {
  test('manual invoice can be created with a stated amount', async () => {
    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId, manual: true, amount: 15000, description: 'Pilot consultation fee' });
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('manual');
    expect(res.body.amount).toBe(15000);
    expect(res.body.status).toBe('Outstanding');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].description).toBe('Pilot consultation fee');
    createdInvoiceIds.push(res.body.id);
  });

  test('manual invoice rejects a missing or non-positive amount', async () => {
    const missing = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId, manual: true });
    expect(missing.statusCode).toBe(400);
    const negative = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId, manual: true, amount: -50 });
    expect(negative.statusCode).toBe(400);
  });

  test('manual invoice appears in the invoice list with full balance outstanding', async () => {
    const res = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    const invoice = res.body.find(i => i.id === createdInvoiceIds[0]);
    expect(invoice).toBeTruthy();
    expect(Number(invoice.amountPaid || 0)).toBe(0);
    expect(Number(invoice.balance)).toBe(15000);
  });

  test('unbilled time generates an invoice and is marked billed (tracking guard)', async () => {
    const entryRes = await request(app)
      .post('/api/time-entries')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId, hours: 2, rate: 5000, description: 'Pilot drafting work', billable: 1 });
    expect(entryRes.statusCode).toBe(200);
    timeEntryId = entryRes.body.id;
    expect(Number(entryRes.body.billed)).toBe(0);

    const genRes = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId });
    expect(genRes.statusCode).toBe(200);
    expect(genRes.body.source).toBe('hourly');
    expect(genRes.body.amount).toBe(10000);
    createdInvoiceIds.push(genRes.body.id);

    const entryAfter = await request(app)
      .get(`/api/time-entries/${timeEntryId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(Number(entryAfter.body.billed)).toBe(1);
  });

  test('matter with no unbilled time still returns the known clear error', async () => {
    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('No billable amount found for this matter');
  });

  test('clients cannot create invoices (access-control regression)', async () => {
    const clientLogin = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(clientLogin.statusCode).toBe(200);
    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${clientLogin.body.token}`)
      .send({ matterId, manual: true, amount: 100 });
    expect(res.statusCode).toBe(403);
  });
});
