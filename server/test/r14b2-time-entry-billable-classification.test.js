const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

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

describe('R14b-2 time-entry billable classification backend', () => {
  let adminToken;
  let advocateToken;
  let clientId;
  const suffix = Date.now();

  async function createMatter(title, overrides = {}) {
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId,
        title,
        assignedTo: 'Sarah Mwangi',
        billingType: 'hourly',
        billingRate: 10000,
        fixedFee: 0,
        ...overrides,
      });
    expect(res.statusCode).toBe(200);
    return res.body.id;
  }

  async function createTimeEntry(matterId, overrides = {}, token = adminToken) {
    const res = await request(app)
      .post('/api/time-entries')
      .set('Authorization', `Bearer ${token}`)
      .send({
        matterId,
        attorney: 'Sarah Mwangi',
        date: '2026-05-09',
        hours: 1,
        activity: 'Drafting',
        description: `R14b2 time ${suffix}`,
        rate: 10000,
        ...overrides,
      });
    expect(res.statusCode).toBe(200);
    return res.body;
  }

  async function createHourlyScenario(label) {
    const matterId = await createMatter(`R14b2 ${label} ${suffix}`);
    const billable = await createTimeEntry(matterId, {
      description: `R14b2 ${label} billable ${suffix}`,
      hours: 2,
      rate: 10000,
      billable: true,
    });
    const nonBillable = await createTimeEntry(matterId, {
      description: `R14b2 ${label} non-billable ${suffix}`,
      hours: 3,
      rate: 10000,
      billable: false,
    });
    return { matterId, billable, nonBillable };
  }

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

    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });

    const clientRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `R14b2 Billable Client ${suffix}`,
        email: `r14b2.client.${suffix}@example.com`,
      });
    expect(clientRes.statusCode).toBe(200);
    clientId = clientRes.body.id;
  });

  afterAll(async () => {
    if (!adminToken) return;
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });
  });

  test('creating a time entry without billable defaults to billable', async () => {
    const matterId = await createMatter(`R14b2 Default Billable Matter ${suffix}`);
    const entry = await createTimeEntry(matterId, {
      description: `R14b2 default billable ${suffix}`,
    });

    const row = await dbGet('SELECT billable FROM time_entries WHERE id=?', [entry.id]);
    expect(Number(entry.billable)).toBe(1);
    expect(Number(row.billable)).toBe(1);
  });

  test('creating a time entry with billable false stores billable=0', async () => {
    const matterId = await createMatter(`R14b2 Non Billable Matter ${suffix}`);
    const entry = await createTimeEntry(matterId, {
      description: `R14b2 stored non-billable ${suffix}`,
      billable: false,
    });

    const row = await dbGet('SELECT billable FROM time_entries WHERE id=?', [entry.id]);
    expect(Number(entry.billable)).toBe(0);
    expect(Number(row.billable)).toBe(0);
  });

  test('updating a time entry can change billable classification', async () => {
    const matterId = await createMatter(`R14b2 Update Billable Matter ${suffix}`);
    const entry = await createTimeEntry(matterId, {
      description: `R14b2 update billable ${suffix}`,
      billable: false,
    });

    const makeBillable = await request(app)
      .patch(`/api/time-entries/${entry.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ billable: true });
    expect(makeBillable.statusCode).toBe(200);
    expect(Number(makeBillable.body.billable)).toBe(1);

    const makeNonBillable = await request(app)
      .patch(`/api/time-entries/${entry.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ billable: false });
    expect(makeNonBillable.statusCode).toBe(200);
    expect(Number(makeNonBillable.body.billable)).toBe(0);
  });

  test('hourly invoice generation includes billable unbilled time', async () => {
    const { matterId } = await createHourlyScenario('Include Billable');

    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId });

    expect(res.statusCode).toBe(200);
    expect(Number(res.body.amount)).toBe(20000);
    expect(res.body.items).toHaveLength(1);
    expect(Number(res.body.items[0].amount)).toBe(20000);
  });

  test('hourly invoice generation excludes non-billable unbilled time', async () => {
    const { matterId, billable, nonBillable } = await createHourlyScenario('Exclude Non Billable');

    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId });

    expect(res.statusCode).toBe(200);
    const itemIds = res.body.items.map(item => item.timeEntryId);
    expect(itemIds).toContain(billable.id);
    expect(itemIds).not.toContain(nonBillable.id);
    expect(Number(res.body.amount)).toBe(20000);
  });

  test('non-billable entries remain unbilled after invoice generation', async () => {
    const { matterId, nonBillable } = await createHourlyScenario('Remain Unbilled');

    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId });
    expect(res.statusCode).toBe(200);

    const row = await dbGet('SELECT billed FROM time_entries WHERE id=?', [nonBillable.id]);
    expect(Number(row.billed)).toBe(0);
  });

  test('fixed-fee invoice generation remains unchanged', async () => {
    const matterId = await createMatter(`R14b2 Fixed Fee Matter ${suffix}`, {
      billingType: 'fixed',
      billingRate: 0,
      fixedFee: 75000,
    });
    await createTimeEntry(matterId, {
      description: `R14b2 fixed fee non-billable time ${suffix}`,
      hours: 9,
      rate: 10000,
      billable: false,
    });

    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId });

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('fixed');
    expect(Number(res.body.amount)).toBe(75000);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].description).toBe('Legal Services (Fixed Fee)');
  });

  test('R14b-0 access controls still block unauthorized time entry and invoice generation', async () => {
    const matterId = await createMatter(`R14b2 Inaccessible Matter ${suffix}`, {
      assignedTo: 'R14b2 Other Advocate',
    });

    const createRes = await request(app)
      .post('/api/time-entries')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({
        matterId,
        attorney: 'Sarah Mwangi',
        date: '2026-05-09',
        hours: 1,
        activity: 'Drafting',
        description: `R14b2 forbidden non-billable ${suffix}`,
        rate: 10000,
        billable: false,
      });
    expect(createRes.statusCode).toBe(403);
    expect(createRes.body).toEqual({ error: 'Matter access denied' });

    await createTimeEntry(matterId, {
      attorney: 'R14b2 Other Advocate',
      description: `R14b2 inaccessible invoice time ${suffix}`,
      billable: true,
    });

    const invoiceRes = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ matterId });
    expect(invoiceRes.statusCode).toBe(403);
    expect(invoiceRes.body).toEqual({ error: 'Matter access denied' });
  });

  test('invoice generation creates no items when only non-billable hourly time exists', async () => {
    const matterId = await createMatter(`R14b2 Only Non Billable Matter ${suffix}`);
    await createTimeEntry(matterId, {
      description: `R14b2 only non-billable ${suffix}`,
      hours: 4,
      rate: 10000,
      billable: false,
    });

    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId });

    const invoices = await dbAll('SELECT * FROM invoices WHERE matterId=?', [matterId]);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'No billable amount found for this matter' });
    expect(invoices).toHaveLength(0);
  });
});
