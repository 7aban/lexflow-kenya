const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app, dbReady } = require('../server.js');

function dbAll(sql, params = []) {
  const db = new sqlite3.Database(path.join(__dirname, '..', 'lawfirm.db'));
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      db.close();
      err ? reject(err) : resolve(rows);
    });
  });
}

async function latestAudit(action) {
  const rows = await dbAll(
    'SELECT * FROM audit_events WHERE action=? ORDER BY timestamp DESC, id DESC LIMIT 1',
    [action],
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

function sortedKeys(value) {
  return Object.keys(value || {}).sort();
}

describe('R21 invoice firm billing settings', () => {
  const suffix = Date.now();
  const rawBillingValues = {
    paymentInstructions: `Pay by bank transfer to R21 account ${suffix}. Include the invoice number as the reference.`,
    kraPin: `P${String(suffix).slice(-8)}A`,
    vatNumber: `VAT-${suffix}`,
    invoiceFooterNote: `R21 payment terms note ${suffix}`,
  };

  let admin;
  let assistant;
  let advocate;
  let client;
  let otherClient;
  let invoiceId;
  let otherInvoiceId;
  let paymentId;

  async function createFixedInvoice(title, clientId, assignedTo = 'Sarah Mwangi', fixedFee = 50000) {
    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        clientId,
        title: `${title} ${suffix}`,
        practiceArea: 'Commercial Law',
        assignedTo,
        billingType: 'fixed',
        fixedFee,
        stage: 'Engagement',
      });
    expect(matterRes.statusCode).toBe(200);

    const invoiceRes = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ matterId: matterRes.body.id });
    expect(invoiceRes.statusCode).toBe(200);
    return invoiceRes.body.id;
  }

  beforeAll(async () => {
    await dbReady;
    admin = await login('admin@lexflow.co.ke');
    assistant = await login('david.wanjiku@achokilaw.co.ke');
    advocate = await login('sarah.mwangi@achokilaw.co.ke');
    client = await login('margaret.wairimu@example.co.ke', 'password123', true);
    otherClient = await login('legal@kamaulogistics.co.ke', 'password123', true);

    invoiceId = await createFixedInvoice('R21 Billing Primary', client.user.clientId, 'Sarah Mwangi', 70000);
    otherInvoiceId = await createFixedInvoice('R21 Billing Other Client', otherClient.user.clientId, 'Sarah Mwangi', 45000);

    const paymentRes = await request(app)
      .post(`/api/invoices/${invoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 10000, method: 'Bank Transfer', reference: `R21-PAY-${suffix}`, date: '2026-06-02' });
    expect(paymentRes.statusCode).toBe(200);
    paymentId = paymentRes.body.payment.id;
  });

  afterAll(async () => {
    if (!admin?.token) return;
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'LexFlow Kenya',
        email: 'accounts@lexflow.co.ke',
        phone: '+254 700 123456',
        address: 'Nairobi, Kenya',
        advocateBillingVisibility: 1,
        paymentInstructions: '',
        kraPin: '',
        vatNumber: '',
        invoiceFooterNote: '',
      });
  });

  test('admin can save and read firm billing fields while existing settings persist', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: `R21 Billing Firm ${suffix}`,
        email: 'r21-billing@lexflow.co.ke',
        phone: '+254 700 000000',
        address: 'R21 Billing Address',
        primaryColor: '#123456',
        accentColor: '#abcdef',
        ...rawBillingValues,
      });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      name: `R21 Billing Firm ${suffix}`,
      email: 'r21-billing@lexflow.co.ke',
      phone: '+254 700 000000',
      address: 'R21 Billing Address',
      primaryColor: '#123456',
      accentColor: '#abcdef',
      ...rawBillingValues,
    });

    const getRes = await request(app)
      .get('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).toMatchObject(rawBillingValues);
    expect(getRes.body.email).toBe('r21-billing@lexflow.co.ke');
  });

  test('advocate, assistant, and client cannot update firm settings', async () => {
    for (const token of [advocate.token, assistant.token, client.token]) {
      const res = await request(app)
        .put('/api/firm-settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `R21 Unauthorized ${suffix}`, ...rawBillingValues });
      expect(res.statusCode).toBe(403);
    }
  });

  test('invoice PDFs succeed with populated and blank billing fields', async () => {
    const populated = await request(app)
      .get(`/api/invoices/${invoiceId}/pdf`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(populated.statusCode).toBe(200);
    expect(populated.headers['content-type']).toMatch(/^application\/pdf/);

    const blankSettings = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ paymentInstructions: '', kraPin: '', vatNumber: '', invoiceFooterNote: '', advocateBillingVisibility: 1 });
    expect(blankSettings.statusCode).toBe(200);

    const blank = await request(app)
      .get(`/api/invoices/${invoiceId}/pdf`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(blank.statusCode).toBe(200);
    expect(blank.headers['content-type']).toMatch(/^application\/pdf/);
  });

  test('receipt PDF succeeds when billing fields are populated', async () => {
    const settingsRes = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send(rawBillingValues);
    expect(settingsRes.statusCode).toBe(200);

    const res = await request(app)
      .get(`/api/invoices/${invoiceId}/payments/${paymentId}/receipt.pdf`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
  });

  test('invoice PDF access control remains intact', async () => {
    const own = await request(app)
      .get(`/api/invoices/${invoiceId}/pdf`)
      .set('Authorization', `Bearer ${client.token}`);
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toMatch(/^application\/pdf/);

    const inaccessible = await request(app)
      .get(`/api/invoices/${otherInvoiceId}/pdf`)
      .set('Authorization', `Bearer ${client.token}`);
    expect(inaccessible.statusCode).toBe(403);

    const hidden = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ advocateBillingVisibility: 0, ...rawBillingValues });
    expect(hidden.statusCode).toBe(200);

    const advocateBlocked = await request(app)
      .get(`/api/invoices/${invoiceId}/pdf`)
      .set('Authorization', `Bearer ${advocate.token}`);
    expect(advocateBlocked.statusCode).toBe(403);
    expect(advocateBlocked.body.error).toMatch(/billing access restricted/i);

    const restored = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ advocateBillingVisibility: 1, ...rawBillingValues });
    expect(restored.statusCode).toBe(200);
  });

  test('firm settings audit records field names without raw billing values', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send(rawBillingValues);
    expect(res.statusCode).toBe(200);

    const event = await latestAudit('firm_settings_updated');
    expect(event).toBeDefined();
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.fieldsUpdated).toEqual(expect.arrayContaining([
      'paymentInstructions',
      'kraPin',
      'vatNumber',
      'invoiceFooterNote',
    ]));
    const serialized = JSON.stringify(metadata);
    for (const value of Object.values(rawBillingValues)) {
      expect(serialized).not.toContain(value);
    }
  });

  test('invoice JSON list and detail shapes do not gain firm billing fields', async () => {
    const listBefore = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(listBefore.statusCode).toBe(200);
    const beforeListInvoice = listBefore.body.find(invoice => invoice.id === invoiceId);
    expect(beforeListInvoice).toBeDefined();

    const detailBefore = await request(app)
      .get(`/api/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detailBefore.statusCode).toBe(200);

    const settingsRes = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send(rawBillingValues);
    expect(settingsRes.statusCode).toBe(200);

    const listAfter = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(listAfter.statusCode).toBe(200);
    const afterListInvoice = listAfter.body.find(invoice => invoice.id === invoiceId);
    expect(afterListInvoice).toBeDefined();

    const detailAfter = await request(app)
      .get(`/api/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detailAfter.statusCode).toBe(200);

    expect(sortedKeys(afterListInvoice)).toEqual(sortedKeys(beforeListInvoice));
    expect(sortedKeys(detailAfter.body)).toEqual(sortedKeys(detailBefore.body));
    const invoiceJson = JSON.stringify({ afterListInvoice, detail: detailAfter.body });
    for (const field of Object.keys(rawBillingValues)) {
      expect(invoiceJson).not.toContain(field);
    }
  });
});
