const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let ownMatterId, otherMatterId;

beforeAll(async () => {
  await dbReady;

  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = adminRes.body.token;

  const advRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
  advocateToken = advRes.body.token;

  const asstRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' });
  assistantToken = asstRes.body.token;

  const clientRes = await request(app)
    .post('/api/auth/client-login')
    .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
  clientToken = clientRes.body.token;

  const mattersRes = await request(app)
    .get('/api/matters')
    .set('Authorization', `Bearer ${advocateToken}`);
  const myMatters = mattersRes.body.filter(m => m.assignedTo === 'Sarah Mwangi');
  ownMatterId = myMatters.length ? myMatters[0].id : null;

  const allMattersRes = await request(app)
    .get('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`);
  const otherMatters = allMattersRes.body.filter(m => m.assignedTo && m.assignedTo !== 'Sarah Mwangi');
  otherMatterId = otherMatters.length ? otherMatters[0].id : null;
});

afterAll(async () => {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  await new Promise((resolve, reject) => {
    db.run('UPDATE firm_settings SET advocateBillingVisibility=1', (err) => err ? reject(err) : resolve());
  });
  db.close();
});

describe('R9e suggestions access and billing hardening', () => {
  test('1. Client gets 403 for suggestions', async () => {
    const res = await request(app)
      .get(`/api/matters/${ownMatterId}/suggestions`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  test('2. Advocate can access own assigned matter suggestions', async () => {
    const res = await request(app)
      .get(`/api/matters/${ownMatterId}/suggestions`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('3. Advocate cannot access another advocate matter', async () => {
    const res = await request(app)
      .get(`/api/matters/${otherMatterId}/suggestions`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('4. Admin can access any matter suggestions', async () => {
    const res = await request(app)
      .get(`/api/matters/${ownMatterId}/suggestions`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('5. Assistant can access any matter suggestions', async () => {
    const res = await request(app)
      .get(`/api/matters/${ownMatterId}/suggestions`)
      .set('Authorization', `Bearer ${assistantToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('6. Non-existent matter returns 404', async () => {
    const res = await request(app)
      .get('/api/matters/nonexistent-id/suggestions')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(404);
  });

  test('7. Advocate with billing visibility disabled receives no billing hint text', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });

    const res = await request(app)
      .get(`/api/matters/${ownMatterId}/suggestions`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    for (const s of res.body) {
      const lower = s.toLowerCase();
      expect(lower).not.toMatch(/unbilled/);
      expect(lower).not.toMatch(/fixed.fee/);
      expect(lower).not.toMatch(/\bretainer\b/);
      expect(lower).not.toMatch(/outstanding.*invoice|invoice.*outstanding/);
    }

    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });
  });

  test('8. Advocate with billing visibility enabled may receive billing hints where seeded data supports', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });

    const res = await request(app)
      .get(`/api/matters/${ownMatterId}/suggestions`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    for (const item of res.body) {
      expect(typeof item).toBe('string');
    }

    const detailRes = await request(app)
      .get(`/api/matters/${ownMatterId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const detail = detailRes.body;
    const hasUnbilled = (detail.timeEntries || []).some(te => !te.billed);
    const isFixedFeeNoInvoice = (detail.billingType || '').toLowerCase() === 'fixed' && Number(detail.fixedFee) > 0 && (!detail.invoices || detail.invoices.length === 0);
    const hasLowRetainer = Number(detail.retainerBalance) > 0 && Number(detail.retainerBalance) < 50000;
    const hasOutstandingOnClosed = (detail.stage || '').toLowerCase() === 'closed' && (detail.invoices || []).some(inv => inv.status === 'Outstanding');
    const expectsBillingHint = hasUnbilled || isFixedFeeNoInvoice || hasLowRetainer || hasOutstandingOnClosed;

    if (expectsBillingHint) {
      const billingKeywords = ['unbilled', 'fixed-fee', 'retainer', 'outstanding invoice'];
      const hasBillingText = res.body.some(s => billingKeywords.some(kw => s.toLowerCase().includes(kw)));
      expect(hasBillingText).toBe(true);
    }
  });

  test('9. Forbidden matter access records audit event', async () => {
    const beforeRes = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ action: 'forbidden_matter_access', entity_type: 'matter' });
    const beforeCount = beforeRes.body.total || 0;

    await request(app)
      .get(`/api/matters/${otherMatterId}/suggestions`)
      .set('Authorization', `Bearer ${advocateToken}`);

    const afterRes = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ action: 'forbidden_matter_access', entity_type: 'matter' });
    const afterCount = afterRes.body.total || 0;

    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  test('10. Response is an array of strings', async () => {
    const res = await request(app)
      .get(`/api/matters/${ownMatterId}/suggestions`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const item of res.body) {
      expect(typeof item).toBe('string');
    }
  });
});
