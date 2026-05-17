const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app } = require('../server.js');

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
    'SELECT * FROM audit_events WHERE action=? AND entity_id=? ORDER BY timestamp DESC LIMIT 1',
    [action, entityId],
  );
  return rows[0];
}

function parseMetadata(event) {
  expect(event).toBeDefined();
  return JSON.parse(event.metadata_json || '{}');
}

async function login(email, password = 'password123', client = false) {
  const res = await request(app)
    .post(client ? '/api/auth/client-login' : '/api/auth/login')
    .send({ email, password });
  expect(res.statusCode).toBe(200);
  return res.body;
}

describe('R16-4 invoice payment records', () => {
  const suffix = Date.now();
  let admin;
  let assistant;
  let advocate;
  let client;
  let otherClient;
  let clientId;
  let otherClientId;
  let invoiceId;
  let fullInvoiceId;
  let overpayInvoiceId;
  let proofInvoiceId;
  let hiddenInvoiceId;
  let matterId;
  let partialPaymentId;

  async function createFixedInvoice(title, fixedFee = 100000, assignedTo = 'Sarah Mwangi', targetClientId = clientId) {
    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        clientId: targetClientId,
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
    return { matterId: matterRes.body.id, invoiceId: invoiceRes.body.id };
  }

  beforeAll(async () => {
    admin = await login('admin@lexflow.co.ke');
    assistant = await login('david.wanjiku@achokilaw.co.ke');
    advocate = await login('sarah.mwangi@achokilaw.co.ke');
    client = await login('margaret.wairimu@example.co.ke', 'password123', true);
    otherClient = await login('legal@kamaulogistics.co.ke', 'password123', true);
    clientId = client.user.clientId;
    otherClientId = otherClient.user.clientId;

    const created = await createFixedInvoice('R16-4 Partial Payment', 100000);
    matterId = created.matterId;
    invoiceId = created.invoiceId;
    fullInvoiceId = (await createFixedInvoice('R16-4 Full Payment', 45000)).invoiceId;
    overpayInvoiceId = (await createFixedInvoice('R16-4 Overpayment', 30000)).invoiceId;
    proofInvoiceId = (await createFixedInvoice('R16-4 Proof Preservation', 25000)).invoiceId;
    hiddenInvoiceId = (await createFixedInvoice('R16-4 Advocate Hidden', 35000)).invoiceId;
  });

  test('admin can record a payment on an accessible invoice', async () => {
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 40000, method: 'Bank Transfer', reference: `R16-PART-${suffix}`, date: '2026-05-17', note: 'Confidential settlement note' });

    expect(res.statusCode).toBe(200);
    expect(res.body.payment.amount).toBe(40000);
    expect(res.body.invoice.amountPaid).toBe(40000);
    expect(res.body.invoice.balance).toBe(60000);
    expect(res.body.invoice.status).toBe('Outstanding');
    partialPaymentId = res.body.payment.id;
  });

  test('assistant can record a payment on an accessible invoice', async () => {
    const res = await request(app)
      .post(`/api/invoices/${overpayInvoiceId}/payments`)
      .set('Authorization', `Bearer ${assistant.token}`)
      .send({ amount: 5000, method: 'Cash Deposit', reference: `R16-ASST-${suffix}`, date: '2026-05-17' });

    expect(res.statusCode).toBe(200);
    expect(res.body.invoice.amountPaid).toBe(5000);
    expect(res.body.invoice.balance).toBe(25000);
  });

  test('client cannot record a payment', async () => {
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/payments`)
      .set('Authorization', `Bearer ${client.token}`)
      .send({ amount: 1000 });

    expect(res.statusCode).toBe(403);
  });

  test('advocate cannot record a payment', async () => {
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/payments`)
      .set('Authorization', `Bearer ${advocate.token}`)
      .send({ amount: 1000 });

    expect(res.statusCode).toBe(403);
  });

  test('client can view payment summary for own invoice', async () => {
    const res = await request(app)
      .get(`/api/invoices/${invoiceId}/payments`)
      .set('Authorization', `Bearer ${client.token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.invoice.amountPaid).toBe(40000);
    expect(res.body.invoice.balance).toBe(60000);
    expect(res.body.payments.some(payment => payment.id === partialPaymentId)).toBe(true);
    expect(res.body.payments.find(payment => payment.id === partialPaymentId).note).toBe('');
  });

  test('client cannot view another client invoice payments', async () => {
    const res = await request(app)
      .get(`/api/invoices/${invoiceId}/payments`)
      .set('Authorization', `Bearer ${otherClient.token}`);

    expect(res.statusCode).toBe(403);
  });

  test('amount paid and balance are computed correctly after partial payment', async () => {
    const res = await request(app)
      .get(`/api/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.amount).toBe(100000);
    expect(res.body.amountPaid).toBe(40000);
    expect(res.body.balance).toBe(60000);
    expect(res.body.paymentCount).toBe(1);
  });

  test('full payment updates invoice status to Paid', async () => {
    const res = await request(app)
      .post(`/api/invoices/${fullInvoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 45000, method: 'M-PESA', reference: `R16-FULL-${suffix}`, date: '2026-05-17' });

    expect(res.statusCode).toBe(200);
    expect(res.body.invoice.amountPaid).toBe(45000);
    expect(res.body.invoice.balance).toBe(0);
    expect(res.body.invoice.status).toBe('Paid');
  });

  test('overpayment is rejected', async () => {
    const res = await request(app)
      .post(`/api/invoices/${overpayInvoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 25000.01, method: 'Bank Transfer', reference: `R16-OVER-${suffix}`, date: '2026-05-17' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/exceeds invoice balance/i);
  });

  test('invalid, zero, and negative amounts are rejected', async () => {
    for (const amount of [0, -1, 'not-a-number']) {
      const res = await request(app)
        .post(`/api/invoices/${overpayInvoiceId}/payments`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ amount, date: '2026-05-17' });
      expect(res.statusCode).toBe(400);
    }
  });

  test('payment proof upload still works after payments migration', async () => {
    const res = await request(app)
      .post('/api/payment-proofs')
      .set('Authorization', `Bearer ${client.token}`)
      .send({
        invoiceId: proofInvoiceId,
        matterId,
        method: 'M-PESA',
        reference: `R16-PROOF-${suffix}`,
        amount: 25000,
        note: 'Client proof note',
      });

    expect(res.statusCode).toBe(403);

    const ownProof = await request(app)
      .post('/api/payment-proofs')
      .set('Authorization', `Bearer ${client.token}`)
      .send({
        invoiceId: invoiceId,
        matterId,
        method: 'M-PESA',
        reference: `R16-PROOF-OWN-${suffix}`,
        amount: 40000,
        note: 'Client proof note',
      });

    expect(ownProof.statusCode).toBe(200);
    expect(ownProof.body.reference).toBe(`R16-PROOF-OWN-${suffix}`);
  });

  test('existing invoice PDF download still works', async () => {
    const res = await request(app)
      .get(`/api/invoices/${invoiceId}/pdf`)
      .set('Authorization', `Bearer ${client.token}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
  });

  test('audit event invoice_payment_recorded is created without note or proof contents', async () => {
    const event = await latestAudit('invoice_payment_recorded', invoiceId);
    const metadata = parseMetadata(event);
    expect(metadata.invoiceId).toBe(invoiceId);
    expect(metadata.amount).toBe(40000);
    const serialized = JSON.stringify(metadata).toLowerCase();
    expect(serialized).not.toContain('confidential settlement note');
    expect(serialized).not.toContain('client proof note');
    expect(serialized).not.toContain('content');
    expect(serialized).not.toContain('body');
  });

  test('status audit metadata is safe and correct when payment marks invoice Paid', async () => {
    const event = await latestAudit('invoice_status_updated', fullInvoiceId);
    const metadata = parseMetadata(event);
    expect(metadata.invoiceId).toBe(fullInvoiceId);
    expect(metadata.oldStatus).toBe('Outstanding');
    expect(metadata.newStatus).toBe('Paid');
    expect(metadata.reason).toBe('payment_recorded');
    expect(metadata.amountPaid).toBe(45000);
    expect(metadata.balance).toBe(0);
    expect(JSON.stringify(metadata).toLowerCase()).not.toContain('note');
  });

  test('billing visibility blocks advocate access to invoice payments', async () => {
    const hiddenRes = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ advocateBillingVisibility: 0 });
    expect(hiddenRes.statusCode).toBe(200);

    const res = await request(app)
      .get(`/api/invoices/${hiddenInvoiceId}/payments`)
      .set('Authorization', `Bearer ${advocate.token}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/billing access restricted/i);

    const restoreRes = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ advocateBillingVisibility: 1 });
    expect(restoreRes.statusCode).toBe(200);
  });
});
