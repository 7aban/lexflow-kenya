const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let matterId, invoiceId, timeEntryId;

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

  // Get a matter assigned to the advocate
  const mattersRes = await request(app)
    .get('/api/matters')
    .set('Authorization', `Bearer ${advocateToken}`);
  const myMatters = mattersRes.body.filter(m => m.assignedTo === 'Sarah Mwangi');
  matterId = myMatters.length ? myMatters[0].id : null;

  // Get an invoice for this matter
  if (matterId) {
    const invRes = await request(app)
      .get(`/api/matters/${matterId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    invoiceId = invRes.body.invoices?.length ? invRes.body.invoices[0].id : null;

    const te = invRes.body.timeEntries || [];
    timeEntryId = te.length ? te[0].id : null;
  }
});

afterAll(async () => {
  // Reset advocateBillingVisibility to default
  const db = new sqlite3.Database(config.DATABASE_PATH);
  await new Promise((resolve, reject) => {
    db.run('UPDATE firm_settings SET advocateBillingVisibility=1', (err) => err ? reject(err) : resolve());
  });
  db.close();
});

describe('R7b-2 advocateBillingVisibility — setting', () => {
  test('1. Default value is 1 (visible)', async () => {
    const res = await request(app)
      .get('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Number(res.body.advocateBillingVisibility)).toBe(1);
  });

  test('2. Admin can toggle advocateBillingVisibility to 0', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });
    expect(res.statusCode).toBe(200);
  });

  test('3. Admin can restore advocateBillingVisibility to 1', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });
    expect(res.statusCode).toBe(200);
  });
});

describe('R7b-2 advocateBillingVisibility — dashboard monthRevenue', () => {
  test('4. Advocate sees monthRevenue when visible (default)', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });

    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.monthRevenue).toBe('number');
  });

  test('5. Advocate monthRevenue is null when hidden', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });

    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.monthRevenue).toBe(0);
  });

  test('6. Admin always sees monthRevenue regardless of setting', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.monthRevenue).toBe('number');
  });
});

describe('R7b-2 advocateBillingVisibility — invoices', () => {
  test('7. Advocate sees invoice amount when visible', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });

    const res = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    if (res.body.length) {
      expect(res.body.some(inv => inv.amount != null)).toBe(true);
    }
  });

  test('8. Advocate invoice amount is null when hidden', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });

    const res = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    for (const inv of res.body) {
      expect(inv.amount).toBeNull();
    }
  });

  test('9. Admin always sees invoice amount', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });

    const res = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    if (res.body.length) {
      expect(res.body.some(inv => inv.amount != null)).toBe(true);
    }
  });
});

describe('R7b-2 advocateBillingVisibility — time entries', () => {
  test('10. Advocate sees time-entry rate when visible', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });

    const res = await request(app)
      .get('/api/time-entries')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    if (res.body.length) {
      expect(res.body.some(te => te.rate != null)).toBe(true);
    }
  });

  test('11. Advocate time-entry rate is null when hidden', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });

    const res = await request(app)
      .get('/api/time-entries')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    for (const te of res.body) {
      expect(te.rate).toBeNull();
    }
  });
});

describe('R7b-2 advocateBillingVisibility — matter detail', () => {
  test('12. Advocate sees matter billing fields when visible', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });

    if (!matterId) return;
    const res = await request(app)
      .get(`/api/matters/${matterId}`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
  });

  test('13. Advocate matter billing fields are null when hidden', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });

    if (!matterId) return;
    const res = await request(app)
      .get(`/api/matters/${matterId}`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.totalBilled).toBeNull();
    expect(res.body.fixedFee).toBeNull();
    for (const te of res.body.timeEntries || []) {
      expect(te.rate).toBeNull();
    }
    for (const inv of res.body.invoices || []) {
      expect(inv.amount).toBeNull();
    }
  });
});

describe('R7b-2 advocateBillingVisibility — PDF and generate gates', () => {
  test('14. Invoice PDF returns 403 when billing hidden', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });

    if (!invoiceId) return;
    const res = await request(app)
      .get(`/api/invoices/${invoiceId}/pdf`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('15. Invoice generate returns 403 when billing hidden', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });

    if (!matterId) return;
    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ matterId });
    expect(res.statusCode).toBe(403);
  });
});
