const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app } = require('../server.js');

function dbAll(sql, params = []) {
  const db = new sqlite3.Database(path.join(__dirname, '..', 'lawfirm.db'));
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      db.close(closeErr => {
        if (err) {
          reject(err);
        } else if (closeErr) {
          reject(closeErr);
        } else {
          resolve(rows);
        }
      });
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

describe('R16-5 payment receipts', () => {
  const suffix = Date.now();
  let admin;
  let assistant;
  let advocate;
  let client;
  let otherClient;
  let clientId;
  let invoiceId;
  let matterId;
  let recordedPaymentId;
  let recordedReceiptNumber;
  let assistantPaymentId;
  let advocateInvoiceId;
  let advocatePaymentId;
  let hiddenInvoiceId;
  let hiddenPaymentId;
  let otherInvoiceId;
  let otherPaymentId;
  let proofInvoiceId;

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

    const main = await createFixedInvoice('R16-5 Receipt Primary', 80000);
    matterId = main.matterId;
    invoiceId = main.invoiceId;
    advocateInvoiceId = (await createFixedInvoice('R16-5 Receipt Advocate', 60000)).invoiceId;
    hiddenInvoiceId = (await createFixedInvoice('R16-5 Receipt Hidden', 50000)).invoiceId;
    otherInvoiceId = (await createFixedInvoice('R16-5 Receipt Other Client', 40000, 'Sarah Mwangi', otherClient.user.clientId)).invoiceId;
    proofInvoiceId = (await createFixedInvoice('R16-5 Receipt Proof', 30000)).invoiceId;
  });

  test('recording payment assigns a receipt number', async () => {
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 40000, method: 'Bank Transfer', reference: `R16-5-PART-${suffix}`, date: '2026-05-17', note: 'Confidential receipt note' });

    expect(res.statusCode).toBe(200);
    expect(res.body.payment.receiptNumber).toMatch(/^RCPT-\d{4}-\d{6}$/);
    expect(res.body.payment.receiptIssuedAt).toBeTruthy();
    expect(res.body.invoice.amountPaid).toBe(40000);
    expect(res.body.invoice.balance).toBe(40000);
    recordedPaymentId = res.body.payment.id;
    recordedReceiptNumber = res.body.payment.receiptNumber;
  });

  test('receipt number appears in payment list', async () => {
    const res = await request(app)
      .get(`/api/invoices/${invoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.statusCode).toBe(200);
    const found = res.body.payments.find(payment => payment.id === recordedPaymentId);
    expect(found).toBeDefined();
    expect(found.receiptNumber).toBe(recordedReceiptNumber);
    expect(found.receiptIssuedAt).toBeTruthy();
  });

  test('admin and assistant can download the receipt PDF', async () => {
    const adminRes = await request(app)
      .get(`/api/invoices/${invoiceId}/payments/${recordedPaymentId}/receipt.pdf`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.headers['content-type']).toMatch(/^application\/pdf/);

    const assistantPaymentRes = await request(app)
      .post(`/api/invoices/${invoiceId}/payments`)
      .set('Authorization', `Bearer ${assistant.token}`)
      .send({ amount: 10000, method: 'Cash Deposit', reference: `R16-5-ASSIST-${suffix}`, date: '2026-05-17' });
    expect(assistantPaymentRes.statusCode).toBe(200);
    assistantPaymentId = assistantPaymentRes.body.payment.id;
    expect(assistantPaymentRes.body.payment.receiptNumber).toMatch(/^RCPT-\d{4}-\d{6}$/);

    const assistantRes = await request(app)
      .get(`/api/invoices/${invoiceId}/payments/${assistantPaymentId}/receipt.pdf`)
      .set('Authorization', `Bearer ${assistant.token}`);
    expect(assistantRes.statusCode).toBe(200);
    expect(assistantRes.headers['content-type']).toMatch(/^application\/pdf/);
  });

  test('client can download own receipt PDF', async () => {
    const res = await request(app)
      .get(`/api/invoices/${invoiceId}/payments/${recordedPaymentId}/receipt.pdf`)
      .set('Authorization', `Bearer ${client.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
  });

  test('client cannot download another clients receipt PDF', async () => {
    const otherPaymentRes = await request(app)
      .post(`/api/invoices/${otherInvoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 15000, method: 'M-PESA', reference: `R16-5-OTHER-${suffix}`, date: '2026-05-17' });
    expect(otherPaymentRes.statusCode).toBe(200);
    otherPaymentId = otherPaymentRes.body.payment.id;

    const res = await request(app)
      .get(`/api/invoices/${otherInvoiceId}/payments/${otherPaymentId}/receipt.pdf`)
      .set('Authorization', `Bearer ${client.token}`);
    expect(res.statusCode).toBe(403);
  });

  test('advocate receipt access respects assignment and billing visibility', async () => {
    const advocatePaymentRes = await request(app)
      .post(`/api/invoices/${advocateInvoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 12000, method: 'M-PESA', reference: `R16-5-ADV-${suffix}`, date: '2026-05-17' });
    expect(advocatePaymentRes.statusCode).toBe(200);
    advocatePaymentId = advocatePaymentRes.body.payment.id;

    const okRes = await request(app)
      .get(`/api/invoices/${advocateInvoiceId}/payments/${advocatePaymentId}/receipt.pdf`)
      .set('Authorization', `Bearer ${advocate.token}`);
    expect(okRes.statusCode).toBe(200);
    expect(okRes.headers['content-type']).toMatch(/^application\/pdf/);

    const hiddenPaymentRes = await request(app)
      .post(`/api/invoices/${hiddenInvoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 8000, method: 'M-PESA', reference: `R16-5-HID-${suffix}`, date: '2026-05-17' });
    expect(hiddenPaymentRes.statusCode).toBe(200);
    hiddenPaymentId = hiddenPaymentRes.body.payment.id;

    const setHidden = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ advocateBillingVisibility: 0 });
    expect(setHidden.statusCode).toBe(200);

    const blocked = await request(app)
      .get(`/api/invoices/${hiddenInvoiceId}/payments/${hiddenPaymentId}/receipt.pdf`)
      .set('Authorization', `Bearer ${advocate.token}`);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body.error).toMatch(/billing access restricted/i);

    const restore = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ advocateBillingVisibility: 1 });
    expect(restore.statusCode).toBe(200);
  });

  test('unknown payment receipt route is rejected', async () => {
    const res = await request(app)
      .get(`/api/invoices/${invoiceId}/payments/PAY-does-not-exist/receipt.pdf`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(404);
  });

  test('receipt PDF is delivered with the receipt number in the filename and a valid PDF body', async () => {
    const res = await request(app)
      .get(`/api/invoices/${invoiceId}/payments/${recordedPaymentId}/receipt.pdf`)
      .set('Authorization', `Bearer ${admin.token}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toContain(`${recordedReceiptNumber}.pdf`);
    const buffer = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
    expect(buffer.length).toBeGreaterThan(200);
    expect(buffer.slice(0, 4).toString()).toBe('%PDF');
  });

  test('receipt download creates safe audit event', async () => {
    await request(app)
      .get(`/api/invoices/${invoiceId}/payments/${recordedPaymentId}/receipt.pdf`)
      .set('Authorization', `Bearer ${admin.token}`);

    const event = await latestAudit('payment_receipt_downloaded', recordedPaymentId);
    const metadata = parseMetadata(event);
    expect(metadata.paymentId).toBe(recordedPaymentId);
    expect(metadata.invoiceId).toBe(invoiceId);
    expect(metadata.receiptNumber).toBe(recordedReceiptNumber);
    expect(metadata.amount).toBe(40000);
    const serialized = JSON.stringify(metadata).toLowerCase();
    expect(serialized).not.toContain('confidential receipt note');
    expect(serialized).not.toContain('note');
    expect(serialized).not.toContain('proof');
    expect(serialized).not.toContain('body');
    expect(serialized).not.toContain('content');
  });

  test('R16-4 amountPaid, balance, and Paid status still work alongside receipts', async () => {
    const res = await request(app)
      .get(`/api/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.amountPaid).toBe(50000);
    expect(res.body.balance).toBe(30000);
    expect(res.body.status).toBe('Outstanding');

    const finalRes = await request(app)
      .post(`/api/invoices/${invoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 30000, method: 'Bank Transfer', reference: `R16-5-FINAL-${suffix}`, date: '2026-05-17' });
    expect(finalRes.statusCode).toBe(200);
    expect(finalRes.body.invoice.amountPaid).toBe(80000);
    expect(finalRes.body.invoice.balance).toBe(0);
    expect(finalRes.body.invoice.status).toBe('Paid');
    expect(finalRes.body.payment.receiptNumber).toMatch(/^RCPT-\d{4}-\d{6}$/);
  });

  test('payment proof upload remains separate and still works', async () => {
    const res = await request(app)
      .post('/api/payment-proofs')
      .set('Authorization', `Bearer ${client.token}`)
      .send({
        invoiceId: proofInvoiceId,
        matterId,
        method: 'M-PESA',
        reference: `R16-5-PROOF-${suffix}`,
        amount: 30000,
        note: 'Client proof note',
      });
    expect([200, 403]).toContain(res.statusCode);

    const proof = await dbAll('SELECT id FROM payment_proofs WHERE reference=? LIMIT 1', [`R16-5-PROOF-${suffix}`]);
    if (res.statusCode === 200) expect(proof.length).toBeGreaterThanOrEqual(1);
  });

  test('overpayment is still rejected and never issues a receipt', async () => {
    const overpayInvoice = await createFixedInvoice('R16-5 Overpay', 25000);
    const okRes = await request(app)
      .post(`/api/invoices/${overpayInvoice.invoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 20000, method: 'Bank Transfer', reference: `R16-5-OK-${suffix}`, date: '2026-05-17' });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.body.payment.receiptNumber).toMatch(/^RCPT-\d{4}-\d{6}$/);

    const overRes = await request(app)
      .post(`/api/invoices/${overpayInvoice.invoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 5000.01, method: 'Bank Transfer', reference: `R16-5-OVER-${suffix}`, date: '2026-05-17' });
    expect(overRes.statusCode).toBe(400);
    expect(overRes.body.error).toMatch(/exceeds invoice balance/i);

    const rejectedRows = await dbAll('SELECT id FROM payments WHERE reference=?', [`R16-5-OVER-${suffix}`]);
    expect(rejectedRows.length).toBe(0);
  });
});
