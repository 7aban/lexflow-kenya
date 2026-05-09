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

describe('R14c-1 billable dashboard metrics backend', () => {
  let adminToken;
  let advocateToken;
  let clientId;
  const suffix = Date.now();
  const advocateName = 'Sarah Mwangi';
  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);

  async function createClient() {
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `R14c1 Client ${suffix}`,
        email: `r14c1.client.${suffix}@example.com`,
      });
    expect(res.statusCode).toBe(200);
    return res.body.id;
  }

  async function createMatter(label, overrides = {}) {
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId,
        title: `R14c1 ${label} ${suffix}`,
        assignedTo: advocateName,
        billingType: 'hourly',
        billingRate: 10000,
        fixedFee: 0,
        retainerBalance: 0,
        ...overrides,
      });
    expect(res.statusCode).toBe(200);
    return res.body.id;
  }

  async function createTimeEntry(matterId, overrides = {}) {
    const res = await request(app)
      .post('/api/time-entries')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        matterId,
        attorney: advocateName,
        date: today,
        hours: 1,
        activity: 'Drafting',
        description: `R14c1 time ${suffix}`,
        rate: 10000,
        billed: false,
        billable: true,
        ...overrides,
      });
    expect(res.statusCode).toBe(200);
    return res.body;
  }

  async function createBillablePair(label) {
    const matterId = await createMatter(label);
    const billable = await createTimeEntry(matterId, {
      description: `R14c1 ${label} billable ${suffix}`,
      hours: 2,
      rate: 10000,
      billable: true,
    });
    const nonBillable = await createTimeEntry(matterId, {
      description: `R14c1 ${label} non-billable ${suffix}`,
      hours: 3,
      rate: 10000,
      billable: false,
    });
    return { matterId, billable, nonBillable };
  }

  function findAdvocate(rows) {
    return rows.find(row => row.fullName === advocateName);
  }

  function findCurrentMonth(rows) {
    return rows.find(row => row.month === currentMonth);
  }

  function expectDelta(after, before, expected) {
    expect(Number(after || 0) - Number(before || 0)).toBeCloseTo(expected);
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

    clientId = await createClient();
  });

  afterAll(async () => {
    if (!adminToken) return;
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });
  });

  test('dashboard monthHours and monthRevenue exclude non-billable time', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });

    const adminBefore = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);
    const advocateBefore = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(adminBefore.statusCode).toBe(200);
    expect(advocateBefore.statusCode).toBe(200);

    await createBillablePair('Dashboard Metrics');

    const adminAfter = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);
    const advocateAfter = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(adminAfter.statusCode).toBe(200);
    expect(advocateAfter.statusCode).toBe(200);

    expectDelta(adminAfter.body.monthHours, adminBefore.body.monthHours, 2);
    expectDelta(adminAfter.body.monthRevenue, adminBefore.body.monthRevenue, 20000);
    expectDelta(advocateAfter.body.monthHours, advocateBefore.body.monthHours, 2);
    expectDelta(advocateAfter.body.monthRevenue, advocateBefore.body.monthRevenue, 20000);
  });

  test('performance rows split workload hours from billable metrics', async () => {
    const beforeRes = await request(app)
      .get('/api/performance/advocates?refresh=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(beforeRes.statusCode).toBe(200);
    const before = findAdvocate(beforeRes.body);
    expect(before).toBeDefined();

    await createBillablePair('Performance Metrics');

    const afterRes = await request(app)
      .get('/api/performance/advocates?refresh=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(afterRes.statusCode).toBe(200);
    const after = findAdvocate(afterRes.body);
    expect(after).toBeDefined();

    expectDelta(after.totalHours, before.totalHours, 5);
    expectDelta(after.billableHours, before.billableHours, 2);
    expectDelta(after.nonBillableHours, before.nonBillableHours, 3);
    expectDelta(after.billableAmount, before.billableAmount, 20000);
    expectDelta(after.billedAmount, before.billedAmount, 20000);
    expectDelta(after.thisMonthHours, before.thisMonthHours, 5);
    expectDelta(after.thisMonthBillableHours, before.thisMonthBillableHours, 2);
    expectDelta(after.thisMonthRevenue, before.thisMonthRevenue, 20000);
  });

  test('performance detail keeps six-month shape and uses billable-only revenue', async () => {
    const listBefore = await request(app)
      .get('/api/performance/advocates?refresh=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listBefore.statusCode).toBe(200);
    const advocate = findAdvocate(listBefore.body);
    expect(advocate).toBeDefined();

    const detailBefore = await request(app)
      .get(`/api/performance/advocates/${advocate.userId}?refresh=1`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detailBefore.statusCode).toBe(200);
    expect(detailBefore.body.monthlyBreakdown).toHaveLength(6);
    const monthBefore = findCurrentMonth(detailBefore.body.monthlyBreakdown);
    expect(monthBefore).toBeDefined();

    await createBillablePair('Performance Detail');

    const detailAfter = await request(app)
      .get(`/api/performance/advocates/${advocate.userId}?refresh=1`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detailAfter.statusCode).toBe(200);
    expect(detailAfter.body.monthlyBreakdown).toHaveLength(6);
    const monthAfter = findCurrentMonth(detailAfter.body.monthlyBreakdown);
    expect(monthAfter).toBeDefined();

    expectDelta(monthAfter.hours, monthBefore.hours, 5);
    expectDelta(monthAfter.billableHours, monthBefore.billableHours, 2);
    expectDelta(monthAfter.nonBillableHours, monthBefore.nonBillableHours, 3);
    expectDelta(monthAfter.revenue, monthBefore.revenue, 20000);
  });

  test('suggestions unbilled value excludes non-billable time', async () => {
    const { matterId } = await createBillablePair('Suggestions Metrics');

    const res = await request(app)
      .get(`/api/matters/${matterId}/suggestions`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    const unbilledHint = res.body.find(item => item.toLowerCase().includes('unbilled time'));
    expect(unbilledHint).toBeDefined();
    expect(unbilledHint).toContain('20,000');
    expect(unbilledHint).not.toContain('50,000');
  });

  test('suggestions do not recommend billing when only non-billable time is unbilled', async () => {
    const matterId = await createMatter('Suggestions Non Billable Only');
    await createTimeEntry(matterId, {
      description: `R14c1 suggestions non-billable only ${suffix}`,
      hours: 3,
      rate: 10000,
      billable: false,
    });

    const res = await request(app)
      .get(`/api/matters/${matterId}/suggestions`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.some(item => item.toLowerCase().includes('unbilled time'))).toBe(false);
  });

  test('invoice generation still invoices only billed=0 and billable=1 time entries', async () => {
    const { matterId, billable, nonBillable } = await createBillablePair('Invoice Regression');
    await createTimeEntry(matterId, {
      description: `R14c1 billed billable excluded ${suffix}`,
      hours: 4,
      rate: 10000,
      billed: true,
      billable: true,
    });

    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId });
    expect(res.statusCode).toBe(200);
    expect(Number(res.body.amount)).toBe(20000);

    const itemIds = res.body.items.map(item => item.timeEntryId);
    expect(itemIds).toContain(billable.id);
    expect(itemIds).not.toContain(nonBillable.id);

    const nonBillableRow = await dbGet('SELECT billed FROM time_entries WHERE id=?', [nonBillable.id]);
    expect(Number(nonBillableRow.billed)).toBe(0);
  });

  test('advocateBillingVisibility=0 still hides revenue and billing suggestions', async () => {
    const { matterId } = await createBillablePair('Visibility Hidden');

    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });

    const dashboardRes = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(dashboardRes.statusCode).toBe(200);
    expect(dashboardRes.body.monthRevenue).toBe(0);

    const suggestionsRes = await request(app)
      .get(`/api/matters/${matterId}/suggestions`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(suggestionsRes.statusCode).toBe(200);
    expect(suggestionsRes.body.some(item => item.toLowerCase().includes('unbilled time'))).toBe(false);
  });
});
