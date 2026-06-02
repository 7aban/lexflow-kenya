const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app, dbReady } = require('../server.js');

function addDays(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

function dbAll(sql, params = []) {
  const db = new sqlite3.Database(path.join(__dirname, '..', 'lawfirm.db'));
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      db.close();
      err ? reject(err) : resolve(rows);
    });
  });
}

async function latestAudit(action, entityId) {
  const rows = await dbAll(
    'SELECT * FROM audit_events WHERE action=? AND entity_id=? ORDER BY timestamp DESC, id DESC LIMIT 1',
    [action, entityId || ''],
  );
  return rows[0];
}

async function login(email, password = 'password123', client = false) {
  const res = await request(app)
    .post(client ? '/api/auth/client-login' : '/api/auth/login')
    .send({ email, password });
  expect(res.statusCode).toBe(200);
  return res.body;
}

describe('R22 invoice due-date terms', () => {
  const suffix = Date.now();
  let admin;
  let advocate;
  let client;

  async function saveFirmSettings(body) {
    return request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'LexFlow Kenya',
        email: 'accounts@lexflow.co.ke',
        phone: '+254 700 123456',
        address: 'Nairobi, Kenya',
        paymentInstructions: '',
        kraPin: '',
        vatNumber: '',
        invoiceFooterNote: '',
        advocateBillingVisibility: 1,
        ...body,
      });
  }

  async function createMatter({ title, billingType = 'fixed', fixedFee = 30000 }) {
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        clientId: client.user.clientId,
        title: `${title} ${suffix}`,
        practiceArea: 'Commercial Law',
        assignedTo: 'Sarah Mwangi',
        billingType,
        fixedFee,
        billingRate: 15000,
        stage: 'Engagement',
      });
    expect(res.statusCode).toBe(200);
    return res.body;
  }

  async function createHourlyMatter(title) {
    const matter = await createMatter({ title, billingType: 'hourly', fixedFee: 0 });
    const timeRes = await request(app)
      .post('/api/time-entries')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        matterId: matter.id,
        attorney: 'Sarah Mwangi',
        date: addDays(0),
        hours: 2,
        rate: 12000,
        description: 'R22 hourly due-date test',
        billable: true,
      });
    expect(timeRes.statusCode).toBe(200);
    return matter;
  }

  async function generateInvoice(matterId, body = {}) {
    return request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ matterId, ...body });
  }

  beforeAll(async () => {
    await dbReady;
    admin = await login('admin@lexflow.co.ke');
    advocate = await login('sarah.mwangi@achokilaw.co.ke');
    client = await login('margaret.wairimu@example.co.ke', 'password123', true);
    await saveFirmSettings({ defaultInvoiceDueDays: 30 });
  });

  afterAll(async () => {
    if (admin?.token) await saveFirmSettings({ defaultInvoiceDueDays: 30 });
  });

  test('GET firm settings returns defaultInvoiceDueDays default 30', async () => {
    const res = await request(app)
      .get('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.defaultInvoiceDueDays).toBe(30);
  });

  test('admin can update defaultInvoiceDueDays to allowed values', async () => {
    for (const days of [7, 14, 30, 45]) {
      const saveRes = await saveFirmSettings({ defaultInvoiceDueDays: days });
      expect(saveRes.statusCode).toBe(200);
      expect(saveRes.body.defaultInvoiceDueDays).toBe(days);

      const getRes = await request(app)
        .get('/api/firm-settings')
        .set('Authorization', `Bearer ${admin.token}`);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.body.defaultInvoiceDueDays).toBe(days);
    }
  });

  test('invalid defaultInvoiceDueDays falls back to 30 and does not persist unsafe values', async () => {
    const saveRes = await saveFirmSettings({ defaultInvoiceDueDays: 'garbage' });
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.body.defaultInvoiceDueDays).toBe(30);

    const rows = await dbAll('SELECT defaultInvoiceDueDays FROM firm_settings WHERE id=?', ['default']);
    expect(rows[0].defaultInvoiceDueDays).toBe(30);
  });

  test('non-admins cannot update firm settings', async () => {
    for (const token of [advocate.token, client.token]) {
      const res = await request(app)
        .put('/api/firm-settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ defaultInvoiceDueDays: 7 });
      expect(res.statusCode).toBe(403);
    }
  });

  test('invoice generation without dueDate uses firm default due days', async () => {
    await saveFirmSettings({ defaultInvoiceDueDays: 14 });
    const matter = await createMatter({ title: 'R22 Default Due' });
    const res = await generateInvoice(matter.id);
    expect(res.statusCode).toBe(200);
    expect(res.body.dueDate).toBe(addDays(14));
    expect(res.body.status).toBe('Outstanding');
    expect(res.body.number).toMatch(/^INV-\d{4}-\d{6}$/);
  });

  test('invoice generation with valid dueDate override uses the override', async () => {
    await saveFirmSettings({ defaultInvoiceDueDays: 45 });
    const override = addDays(9);
    const matter = await createMatter({ title: 'R22 Override Due' });
    const res = await generateInvoice(matter.id, { dueDate: override });
    expect(res.statusCode).toBe(200);
    expect(res.body.dueDate).toBe(override);
    expect(res.body).not.toHaveProperty('defaultInvoiceDueDays');
    expect(res.body).not.toHaveProperty('dueDateOverrideUsed');

    const event = await latestAudit('invoice_generated', res.body.id);
    expect(event).toBeDefined();
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.invoiceId).toBe(res.body.id);
    expect(metadata.dueDate).toBe(override);
    expect(metadata.defaultInvoiceDueDays).toBe(45);
    expect(metadata.dueDateOverrideUsed).toBe(true);
  });

  test('invoice generation with invalid dueDate is rejected', async () => {
    const matter = await createMatter({ title: 'R22 Invalid Due' });
    for (const dueDate of ['', 'not-a-date', '2026-02-31', addDays(-1)]) {
      const res = await generateInvoice(matter.id, { dueDate });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/dueDate/i);
    }
  });

  test('existing fixed-fee and hourly invoice generation still work', async () => {
    await saveFirmSettings({ defaultInvoiceDueDays: 30 });

    const fixedMatter = await createMatter({ title: 'R22 Fixed Fee', fixedFee: 42000 });
    const fixedRes = await generateInvoice(fixedMatter.id);
    expect(fixedRes.statusCode).toBe(200);
    expect(fixedRes.body.source).toBe('fixed');
    expect(fixedRes.body.amount).toBe(42000);

    const hourlyMatter = await createHourlyMatter('R22 Hourly');
    const hourlyRes = await generateInvoice(hourlyMatter.id);
    expect(hourlyRes.statusCode).toBe(200);
    expect(hourlyRes.body.source).toBe('hourly');
    expect(hourlyRes.body.amount).toBe(24000);
    expect(hourlyRes.body.items.length).toBeGreaterThan(0);
  });

  test('invoice PDF, amount semantics, response shape, and access control remain intact', async () => {
    const matter = await createMatter({ title: 'R22 Shape Pdf Access', fixedFee: 16000 });
    const invoiceRes = await generateInvoice(matter.id);
    expect(invoiceRes.statusCode).toBe(200);
    expect(invoiceRes.body.amount).toBe(16000);
    expect(invoiceRes.body.balance).toBe(16000);
    expect(invoiceRes.body.status).toBe('Outstanding');
    expect(invoiceRes.body.number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(invoiceRes.body).not.toHaveProperty('paymentTerms');
    expect(invoiceRes.body).not.toHaveProperty('terms');
    expect(invoiceRes.body).not.toHaveProperty('defaultInvoiceDueDays');
    expect(invoiceRes.body).not.toHaveProperty('dueDateOverrideUsed');

    const pdfRes = await request(app)
      .get(`/api/invoices/${invoiceRes.body.id}/pdf`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(pdfRes.statusCode).toBe(200);
    expect(pdfRes.headers['content-type']).toMatch(/^application\/pdf/);

    const clientGenerate = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ matterId: matter.id });
    expect(clientGenerate.statusCode).toBe(403);
  });
});
