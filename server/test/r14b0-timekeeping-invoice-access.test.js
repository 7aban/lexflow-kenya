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

describe('R14b-0 timekeeping and invoice access hardening', () => {
  let adminToken;
  let advocateToken;
  let clientId;
  let accessibleMatterId;
  let inaccessibleMatterId;
  let invoiceMatterId;
  let inaccessibleInvoiceMatterId;
  let inaccessibleInvoiceTimeEntryId;
  const suffix = Date.now();

  async function createMatter(title, assignedTo) {
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId,
        title,
        assignedTo,
        billingType: 'hourly',
        billingRate: 12000,
      });
    expect(res.statusCode).toBe(200);
    return res.body.id;
  }

  async function createAdminTimeEntry(matterId, description, billed = false) {
    const res = await request(app)
      .post('/api/time-entries')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        matterId,
        attorney: 'R14b Other Advocate',
        date: '2026-05-09',
        hours: 1.5,
        activity: 'Drafting',
        description,
        rate: 12000,
        billed,
      });
    expect(res.statusCode).toBe(200);
    return res.body.id;
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
        name: `R14b0 Access Client ${suffix}`,
        email: `r14b0.client.${suffix}@example.com`,
      });
    expect(clientRes.statusCode).toBe(200);
    clientId = clientRes.body.id;

    accessibleMatterId = await createMatter(`R14b0 Accessible Time Matter ${suffix}`, 'Sarah Mwangi');
    inaccessibleMatterId = await createMatter(`R14b0 Inaccessible Time Matter ${suffix}`, 'R14b Other Advocate');
    invoiceMatterId = await createMatter(`R14b0 Accessible Invoice Matter ${suffix}`, 'Sarah Mwangi');
    inaccessibleInvoiceMatterId = await createMatter(`R14b0 Inaccessible Invoice Matter ${suffix}`, 'R14b Other Advocate');

    await createAdminTimeEntry(invoiceMatterId, `R14b0 accessible invoice time ${suffix}`);
    inaccessibleInvoiceTimeEntryId = await createAdminTimeEntry(inaccessibleInvoiceMatterId, `R14b0 forbidden invoice time ${suffix}`);
  });

  afterAll(async () => {
    if (!adminToken) return;
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });
  });

  test('authorized user can create time entry for accessible matter', async () => {
    const res = await request(app)
      .post('/api/time-entries')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({
        matterId: accessibleMatterId,
        attorney: 'Sarah Mwangi',
        date: '2026-05-09',
        hours: 1.25,
        activity: 'Legal Research',
        description: `R14b0 authorized time ${suffix}`,
        rate: 12000,
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.matterId).toBe(accessibleMatterId);
  });

  test('unauthorized advocate cannot create time entry for inaccessible matter', async () => {
    const res = await request(app)
      .post('/api/time-entries')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({
        matterId: inaccessibleMatterId,
        attorney: 'Sarah Mwangi',
        date: '2026-05-09',
        hours: 0.75,
        activity: 'Drafting',
        description: `R14b0 forbidden time ${suffix}`,
        rate: 12000,
      });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Matter access denied' });
  });

  test('forbidden time-entry attempt does not insert a row', async () => {
    const marker = `R14b0 no insert ${suffix}`;
    const before = await dbGet('SELECT COUNT(*) count FROM time_entries WHERE matterId=? AND description=?', [inaccessibleMatterId, marker]);

    const res = await request(app)
      .post('/api/time-entries')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({
        matterId: inaccessibleMatterId,
        attorney: 'Sarah Mwangi',
        date: '2026-05-09',
        hours: 0.5,
        activity: 'Preparation',
        description: marker,
        rate: 12000,
      });

    const after = await dbGet('SELECT COUNT(*) count FROM time_entries WHERE matterId=? AND description=?', [inaccessibleMatterId, marker]);
    expect(res.statusCode).toBe(403);
    expect(Number(after.count)).toBe(Number(before.count));
  });

  test('authorized user can generate invoice for accessible matter', async () => {
    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ matterId: invoiceMatterId });

    expect(res.statusCode).toBe(200);
    expect(res.body.matterId).toBe(invoiceMatterId);
    expect(Number(res.body.amount)).toBeGreaterThan(0);
  });

  test('unauthorized advocate cannot generate invoice for inaccessible matter', async () => {
    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ matterId: inaccessibleInvoiceMatterId });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Matter access denied' });
  });

  test('forbidden invoice-generation attempt does not create invoice', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM invoices WHERE matterId=?', [inaccessibleInvoiceMatterId]);

    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ matterId: inaccessibleInvoiceMatterId });

    const after = await dbGet('SELECT COUNT(*) count FROM invoices WHERE matterId=?', [inaccessibleInvoiceMatterId]);
    expect(res.statusCode).toBe(403);
    expect(Number(after.count)).toBe(Number(before.count));
  });

  test('forbidden invoice-generation attempt does not mark time entries as billed', async () => {
    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ matterId: inaccessibleInvoiceMatterId });

    const entry = await dbGet('SELECT billed FROM time_entries WHERE id=?', [inaccessibleInvoiceTimeEntryId]);
    expect(res.statusCode).toBe(403);
    expect(Number(entry.billed)).toBe(0);
  });

  test('existing billing visibility behavior remains intact', async () => {
    const matterId = await createMatter(`R14b0 Billing Visibility Matter ${suffix}`, 'Sarah Mwangi');
    await createAdminTimeEntry(matterId, `R14b0 billing visibility time ${suffix}`);

    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });

    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ matterId });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Billing access restricted' });

    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });
  });
});
