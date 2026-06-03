const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app, dbReady } = require('../server.js');

const DB_PATH = path.join(__dirname, '..', 'lawfirm.db');
jest.setTimeout(30000);

function withDb(callback) {
  const db = new sqlite3.Database(DB_PATH);
  return new Promise((resolve, reject) => {
    callback(db, (err, value) => {
      db.close();
      err ? reject(err) : resolve(value);
    });
  });
}

function dbAll(sql, params = []) {
  return withDb((db, done) => db.all(sql, params, done));
}

function dbGet(sql, params = []) {
  return withDb((db, done) => db.get(sql, params, done));
}

function dbRun(sql, params = []) {
  return withDb((db, done) => db.run(sql, params, err => done(err)));
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

describe('R24 admin payment void safeguards', () => {
  const suffix = Date.now();
  let admin;
  let assistant;
  let advocate;
  let client;
  let clientId;
  let roleInvoice;
  let rolePayment;
  let fullInvoice;
  let fullPayment;
  let cappedInvoice;
  let cappedPayment;
  let proofInvoice;
  let proofMatterId;
  let proofId;
  let proofPayment;

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
    return { matterId: matterRes.body.id, invoiceId: invoiceRes.body.id, number: invoiceRes.body.number };
  }

  async function recordPayment(invoiceId, amount, reference, proof = '') {
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount, method: 'Bank Transfer', reference, date: '2026-05-24', proofId: proof });
    expect(res.statusCode).toBe(200);
    return { invoice: res.body.invoice, payment: res.body.payment };
  }

  async function voidPayment(token, invoiceId, paymentId, reason) {
    return request(app)
      .post(`/api/invoices/${invoiceId}/payments/${paymentId}/void`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason });
  }

  beforeAll(async () => {
    await dbReady;
    admin = await login('admin@lexflow.co.ke');
    assistant = await login('david.wanjiku@achokilaw.co.ke');
    advocate = await login('sarah.mwangi@achokilaw.co.ke');
    client = await login('margaret.wairimu@example.co.ke', 'password123', true);
    clientId = client.user.clientId;

    roleInvoice = await createFixedInvoice('R24 Role Guard', 30000);
    rolePayment = (await recordPayment(roleInvoice.invoiceId, 10000, `R24-ROLE-${suffix}`)).payment;

    fullInvoice = await createFixedInvoice('R24 Full Status', 45000);
    fullPayment = (await recordPayment(fullInvoice.invoiceId, 45000, `R24-FULL-${suffix}`)).payment;
    await dbRun('UPDATE invoices SET dueDate=? WHERE id=?', ['2026-01-15', fullInvoice.invoiceId]);

    cappedInvoice = await createFixedInvoice('R24 Reason Cap', 25000);
    cappedPayment = (await recordPayment(cappedInvoice.invoiceId, 5000, `R24-CAP-${suffix}`)).payment;

    const proofFixture = await createFixedInvoice('R24 Proof Link', 20000);
    proofInvoice = proofFixture.invoiceId;
    proofMatterId = proofFixture.matterId;
    const proofUpload = await request(app)
      .post('/api/payment-proofs')
      .set('Authorization', `Bearer ${client.token}`)
      .send({
        invoiceId: proofInvoice,
        matterId: proofMatterId,
        method: 'M-PESA',
        reference: `R24-PROOF-${suffix}`,
        amount: 20000,
        note: 'Proof note must remain',
      });
    expect(proofUpload.statusCode).toBe(200);
    proofId = proofUpload.body.id;
    const review = await request(app)
      .patch(`/api/payment-proofs/${proofId}/review`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'Accepted', reviewNote: 'Accepted for settlement' });
    expect(review.statusCode).toBe(200);
    proofPayment = (await recordPayment(proofInvoice, 20000, `R24-PROOF-PAY-${suffix}`, proofId)).payment;
  });

  test('reason is required before an admin can void', async () => {
    const res = await voidPayment(admin.token, roleInvoice.invoiceId, rolePayment.id, '   ');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/reason/i);

    const row = await dbGet('SELECT voidedAt FROM payments WHERE id=?', [rolePayment.id]);
    expect(row.voidedAt).toBeFalsy();
  });

  test('assistant, advocate, and client cannot void payments', async () => {
    for (const token of [assistant.token, advocate.token, client.token]) {
      const res = await voidPayment(token, roleInvoice.invoiceId, rolePayment.id, 'Incorrect allocation');
      expect(res.statusCode).toBe(403);
    }

    const row = await dbGet('SELECT voidedAt FROM payments WHERE id=?', [rolePayment.id]);
    expect(row.voidedAt).toBeFalsy();
  });

  test('admin can soft-void a payment without deleting receipt or original fields', async () => {
    const beforeInvoice = await request(app)
      .get(`/api/invoices/${roleInvoice.invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(beforeInvoice.statusCode).toBe(200);
    const beforePayment = await dbGet('SELECT * FROM payments WHERE id=?', [rolePayment.id]);
    const beforeSeq = await dbGet('SELECT lastSeq FROM receipt_sequences WHERE year=?', ['2026']);

    const res = await voidPayment(admin.token, roleInvoice.invoiceId, rolePayment.id, 'Duplicate bank posting');
    expect(res.statusCode).toBe(200);
    expect(res.body.payment.id).toBe(rolePayment.id);
    expect(res.body.payment.voided).toBe(true);
    expect(res.body.payment.voidReason).toBe('Duplicate bank posting');
    expect(res.body.invoice.amountPaid).toBe(0);
    expect(res.body.invoice.balance).toBe(30000);
    expect(res.body.invoice.paymentCount).toBe(0);
    expect(res.body.invoice.isPaid).toBe(false);

    const afterPayment = await dbGet('SELECT * FROM payments WHERE id=?', [rolePayment.id]);
    expect(afterPayment).toBeDefined();
    expect(afterPayment.voidedAt).toBeTruthy();
    expect(afterPayment.voidedBy).toBe(admin.user.id);
    expect(afterPayment.amount).toBe(beforePayment.amount);
    expect(afterPayment.method).toBe(beforePayment.method);
    expect(afterPayment.reference).toBe(beforePayment.reference);
    expect(afterPayment.date).toBe(beforePayment.date);
    expect(afterPayment.note).toBe(beforePayment.note);
    expect(afterPayment.proofId).toBe(beforePayment.proofId);
    expect(afterPayment.createdBy).toBe(beforePayment.createdBy);
    expect(afterPayment.createdAt).toBe(beforePayment.createdAt);
    expect(afterPayment.receiptNumber).toBe(beforePayment.receiptNumber);
    expect(afterPayment.receiptIssuedAt).toBe(beforePayment.receiptIssuedAt);

    const afterInvoice = await request(app)
      .get(`/api/invoices/${roleInvoice.invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(afterInvoice.statusCode).toBe(200);
    expect(afterInvoice.body.number).toBe(beforeInvoice.body.number);
    expect(afterInvoice.body.amount).toBe(beforeInvoice.body.amount);
    expect(afterInvoice.body.amountPaid).toBe(0);
    expect(afterInvoice.body.balance).toBe(30000);
    expect(afterInvoice.body.paymentCount).toBe(0);
    expect(afterInvoice.body.isPaid).toBe(false);

    const afterSeq = await dbGet('SELECT lastSeq FROM receipt_sequences WHERE year=?', ['2026']);
    expect(afterSeq.lastSeq).toBe(beforeSeq.lastSeq);
  });

  test('voided payment is returned with staff-only void details and cannot be voided twice', async () => {
    const list = await request(app)
      .get(`/api/invoices/${roleInvoice.invoiceId}/payments`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(list.statusCode).toBe(200);
    const payment = list.body.payments.find(row => row.id === rolePayment.id);
    expect(payment).toBeDefined();
    expect(payment.voided).toBe(true);
    expect(payment.voidedAt).toBeTruthy();
    expect(payment.voidedBy).toBe(admin.user.id);
    expect(payment.voidReason).toBe('Duplicate bank posting');

    const second = await voidPayment(admin.token, roleInvoice.invoiceId, rolePayment.id, 'Try again');
    expect(second.statusCode).toBe(400);
    expect(second.body.error).toMatch(/already voided/i);
  });

  test('receipt PDF for a voided payment is blocked but receipt number stays for audit', async () => {
    const res = await request(app)
      .get(`/api/invoices/${roleInvoice.invoiceId}/payments/${rolePayment.id}/receipt.pdf`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect([409, 410]).toContain(res.statusCode);
    expect(res.body.error).toMatch(/voided/i);

    const row = await dbGet('SELECT receiptNumber FROM payments WHERE id=?', [rolePayment.id]);
    expect(row.receiptNumber).toBe(rolePayment.receiptNumber);
  });

  test('voiding a fully paid invoice flips Paid to Outstanding without setting Overdue automatically', async () => {
    const paidBefore = await request(app)
      .get(`/api/invoices/${fullInvoice.invoiceId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(paidBefore.statusCode).toBe(200);
    expect(paidBefore.body.status).toBe('Paid');
    expect(paidBefore.body.balance).toBe(0);

    const res = await voidPayment(admin.token, fullInvoice.invoiceId, fullPayment.id, 'Payment reversed by bank');
    expect(res.statusCode).toBe(200);
    expect(res.body.invoice.status).toBe('Outstanding');
    expect(res.body.invoice.amountPaid).toBe(0);
    expect(res.body.invoice.balance).toBe(45000);

    const stored = await dbGet('SELECT status,dueDate FROM invoices WHERE id=?', [fullInvoice.invoiceId]);
    expect(stored.dueDate).toBe('2026-01-15');
    expect(stored.status).toBe('Outstanding');
  });

  test('void reason is trimmed and capped safely', async () => {
    const longReason = `   ${'x'.repeat(650)}   `;
    const res = await voidPayment(admin.token, cappedInvoice.invoiceId, cappedPayment.id, longReason);
    expect(res.statusCode).toBe(200);
    expect(res.body.payment.voidReason).toHaveLength(500);
    expect(res.body.payment.voidReason).toBe('x'.repeat(500));

    const row = await dbGet('SELECT voidReason FROM payments WHERE id=?', [cappedPayment.id]);
    expect(row.voidReason).toBe('x'.repeat(500));
  });

  test('payment_voided and status audit events use safe metadata', async () => {
    const voidEvent = await latestAudit('payment_voided', rolePayment.id);
    const voidMeta = parseMetadata(voidEvent);
    expect(voidMeta.invoiceId).toBe(roleInvoice.invoiceId);
    expect(voidMeta.paymentId).toBe(rolePayment.id);
    expect(voidMeta.amount).toBe(10000);
    expect(voidMeta.previousAmountPaid).toBe(10000);
    expect(voidMeta.newAmountPaid).toBe(0);
    expect(voidMeta.previousBalance).toBe(20000);
    expect(voidMeta.newBalance).toBe(30000);
    expect(voidMeta.previousStatus).toBe('Outstanding');
    expect(voidMeta.newStatus).toBe('Outstanding');
    expect(voidMeta.proofUnlinked).toBe(false);
    expect(voidMeta.reasonLength).toBe('Duplicate bank posting'.length);
    expect(JSON.stringify(voidMeta).toLowerCase()).not.toContain('duplicate bank posting');

    const statusEvent = await latestAudit('invoice_status_updated', fullInvoice.invoiceId);
    const statusMeta = parseMetadata(statusEvent);
    expect(statusMeta.invoiceId).toBe(fullInvoice.invoiceId);
    expect(statusMeta.oldStatus).toBe('Paid');
    expect(statusMeta.newStatus).toBe('Outstanding');
    expect(statusMeta.reason).toBe('payment_voided');
    expect(statusMeta.paymentId).toBe(fullPayment.id);
  });

  test('proof-linked payment void clears paymentId without changing proof review fields', async () => {
    const beforeProof = await dbGet('SELECT status,reviewNote,reviewedBy,reviewedAt,paymentId FROM payment_proofs WHERE id=?', [proofId]);
    expect(beforeProof.paymentId).toBe(proofPayment.id);
    expect(beforeProof.status).toBe('Accepted');

    const res = await voidPayment(admin.token, proofInvoice, proofPayment.id, 'Recorded against the wrong deposit');
    expect(res.statusCode).toBe(200);
    expect(res.body.payment.proofId).toBe(proofId);

    const afterProof = await dbGet('SELECT status,reviewNote,reviewedBy,reviewedAt,paymentId FROM payment_proofs WHERE id=?', [proofId]);
    expect(afterProof.paymentId).toBeFalsy();
    expect(afterProof.status).toBe(beforeProof.status);
    expect(afterProof.reviewNote).toBe(beforeProof.reviewNote);
    expect(afterProof.reviewedBy).toBe(beforeProof.reviewedBy);
    expect(afterProof.reviewedAt).toBe(beforeProof.reviewedAt);

    const voidEvent = await latestAudit('payment_voided', proofPayment.id);
    const metadata = parseMetadata(voidEvent);
    expect(metadata.proofUnlinked).toBe(true);
  });

  test('proof queue balance excludes voided payment and accepted proof can be re-recorded', async () => {
    const queue = await request(app)
      .get('/api/payment-proofs?status=All')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(queue.statusCode).toBe(200);
    const proof = queue.body.proofs.find(row => row.id === proofId);
    expect(proof).toBeDefined();
    expect(proof.status).toBe('Accepted');
    expect(proof.paymentId).toBe('');
    expect(proof.invoiceAmountPaid).toBe(0);
    expect(proof.invoiceBalance).toBe(20000);

    const repay = await recordPayment(proofInvoice, 20000, `R24-PROOF-REPAY-${suffix}`, proofId);
    expect(repay.payment.id).not.toBe(proofPayment.id);
    expect(repay.invoice.status).toBe('Paid');

    const relinked = await dbGet('SELECT paymentId,status,reviewNote FROM payment_proofs WHERE id=?', [proofId]);
    expect(relinked.paymentId).toBe(repay.payment.id);
    expect(relinked.status).toBe('Accepted');
    expect(relinked.reviewNote).toBe('Accepted for settlement');
  });

  test('client payment data includes voided indicator but omits internal reason', async () => {
    const list = await request(app)
      .get(`/api/invoices/${roleInvoice.invoiceId}/payments`)
      .set('Authorization', `Bearer ${client.token}`);
    expect(list.statusCode).toBe(200);
    const listedPayment = list.body.payments.find(row => row.id === rolePayment.id);
    expect(listedPayment).toBeDefined();
    expect(listedPayment.voided).toBe(true);
    expect(listedPayment.voidedAt).toBeTruthy();
    expect(listedPayment).not.toHaveProperty('voidReason');

    const dashboard = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${client.token}`);
    expect(dashboard.statusCode).toBe(200);
    const dashboardPayment = (dashboard.body.invoicePayments || []).find(row => row.id === rolePayment.id);
    expect(dashboardPayment).toBeDefined();
    expect(dashboardPayment.voided).toBe(true);
    expect(dashboardPayment.voidedAt).toBeTruthy();
    expect(dashboardPayment).not.toHaveProperty('voidReason');
  });
});
