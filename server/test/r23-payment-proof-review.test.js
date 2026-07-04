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

// 1x1 transparent PNG as a data URL (safe, known image MIME).
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// Untrusted HTML disguised with an html MIME type — must never be served inline.
const HTML_PAYLOAD = '<script>alert(1)</script>';
const HTML_DATA_URL = `data:text/html;base64,${Buffer.from(HTML_PAYLOAD).toString('base64')}`;

describe('R23 payment proof review queue', () => {
  const suffix = Date.now();
  let admin;
  let assistant;
  let advocate;
  let client;
  let otherClient;
  let clientId;
  let matterId;
  let invoiceId;
  let crossMatterId;
  let crossProofId;
  let rejectMatterId;
  let rejectInvoiceId;
  let rejectProofId;
  let ownProofId; // proof with attachment on main invoice
  let htmlProofId;
  let linkInvoiceId;
  let linkMatterId;
  let linkProofId;

  async function createFixedInvoice(title, fixedFee = 100000, assignedTo = 'Sarah Mwangi', targetClientId = clientId) {
    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ clientId: targetClientId, title: `${title} ${suffix}`, practiceArea: 'Commercial Law', assignedTo, billingType: 'fixed', fixedFee, stage: 'Engagement' });
    expect(matterRes.statusCode).toBe(200);
    const invoiceRes = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ matterId: matterRes.body.id });
    expect(invoiceRes.statusCode).toBe(200);
    return { matterId: matterRes.body.id, invoiceId: invoiceRes.body.id };
  }

  async function uploadProof(token, body) {
    return request(app).post('/api/payment-proofs').set('Authorization', `Bearer ${token}`).send(body);
  }

  async function queueProof(token, id, status = 'All') {
    const res = await request(app).get(`/api/payment-proofs?status=${status}`).set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    return { res, proof: (res.body.proofs || []).find(p => p.id === id) };
  }

  beforeAll(async () => {
    admin = await login('admin@lexflow.co.ke');
    assistant = await login('david.wanjiku@achokilaw.co.ke');
    advocate = await login('sarah.mwangi@achokilaw.co.ke');
    client = await login('margaret.wairimu@example.co.ke', 'password123', true);
    otherClient = await login('legal@kamaulogistics.co.ke', 'password123', true);
    clientId = client.user.clientId;

    const main = await createFixedInvoice('R23 Main', 100000);
    matterId = main.matterId;
    invoiceId = main.invoiceId;

    // Matter assigned to a different advocate name → Sarah must not see/access it.
    const cross = await createFixedInvoice('R23 Cross', 50000, 'Peter Kago');
    crossMatterId = cross.matterId;
    const crossUpload = await uploadProof(client.token, { invoiceId: cross.invoiceId, matterId: crossMatterId, method: 'M-PESA', reference: `R23-CROSS-${suffix}`, amount: 50000, fileName: 'cross.png', mimeType: 'image/png', data: PNG_DATA_URL });
    expect(crossUpload.statusCode).toBe(200);
    crossProofId = crossUpload.body.id;

    const rej = await createFixedInvoice('R23 Reject', 30000);
    rejectMatterId = rej.matterId;
    rejectInvoiceId = rej.invoiceId;

    const link = await createFixedInvoice('R23 Link', 20000);
    linkMatterId = link.matterId;
    linkInvoiceId = link.invoiceId;
  });

  // 1
  test('client can upload proof for own matter/invoice', async () => {
    const res = await uploadProof(client.token, { invoiceId, matterId, method: 'M-PESA', reference: `R23-OWN-${suffix}`, amount: 40000, note: 'Sent via M-PESA', fileName: 'receipt.png', mimeType: 'image/png', data: PNG_DATA_URL });
    expect(res.statusCode).toBe(200);
    expect(res.body.reference).toBe(`R23-OWN-${suffix}`);
    expect(res.body.status).toBe('Pending');
    expect(res.body).not.toHaveProperty('content');
    ownProofId = res.body.id;
  });

  // 2
  test('client cannot upload proof for another client matter/invoice', async () => {
    const res = await uploadProof(otherClient.token, { invoiceId, matterId, method: 'M-PESA', reference: `R23-STEAL-${suffix}`, amount: 1000 });
    expect(res.statusCode).toBe(403);
  });

  // 3
  test('staff/admin queue lists proof metadata but not BLOB content', async () => {
    const { res, proof } = await queueProof(admin.token, ownProofId);
    expect(Array.isArray(res.body.proofs)).toBe(true);
    expect(proof).toBeDefined();
    expect(proof.reference).toBe(`R23-OWN-${suffix}`);
    expect(proof.invoiceNumber).toBeTruthy();
    expect(proof.clientName).toBeTruthy();
    expect(proof.status).toBe('Pending');
    expect(proof.hasAttachment).toBe(true);
    for (const row of res.body.proofs) {
      expect(row).not.toHaveProperty('content');
    }
    expect(JSON.stringify(res.body)).not.toContain(PNG_DATA_URL.split(',').pop());
  });

  // 4
  test('clients cannot access staff proof queue', async () => {
    const res = await request(app).get('/api/payment-proofs').set('Authorization', `Bearer ${client.token}`);
    expect(res.statusCode).toBe(403);
  });

  // 5
  test('advocate queue is scoped to assigned matters and cross-matter attachment is denied', async () => {
    const { proof } = await queueProof(advocate.token, crossProofId);
    expect(proof).toBeUndefined(); // cross matter assigned to a different advocate
    const own = await queueProof(advocate.token, ownProofId); // Sarah is assigned to the main matter
    expect(own.proof).toBeDefined();
    const attach = await request(app).get(`/api/payment-proofs/${crossProofId}/attachment`).set('Authorization', `Bearer ${advocate.token}`);
    expect(attach.statusCode).toBe(403);
  });

  // 6
  test('billing-hidden advocate cannot view queue or attachment', async () => {
    const hide = await request(app).put('/api/firm-settings').set('Authorization', `Bearer ${admin.token}`).send({ advocateBillingVisibility: 0 });
    expect(hide.statusCode).toBe(200);
    try {
      const q = await request(app).get('/api/payment-proofs').set('Authorization', `Bearer ${advocate.token}`);
      expect(q.statusCode).toBe(403);
      const a = await request(app).get(`/api/payment-proofs/${ownProofId}/attachment`).set('Authorization', `Bearer ${advocate.token}`);
      expect(a.statusCode).toBe(403);
    } finally {
      const restore = await request(app).put('/api/firm-settings').set('Authorization', `Bearer ${admin.token}`).send({ advocateBillingVisibility: 1 });
      expect(restore.statusCode).toBe(200);
    }
  });

  // 7
  test('allowed staff/admin can download proof attachment as a forced attachment', async () => {
    const res = await request(app).get(`/api/payment-proofs/${ownProofId}/attachment`).set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/i);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  // 8
  test('attachment does not inline untrusted content', async () => {
    const up = await uploadProof(client.token, { invoiceId, matterId, method: 'M-PESA', reference: `R23-HTML-${suffix}`, amount: 1, fileName: 'evil.html', mimeType: 'text/html', data: HTML_DATA_URL });
    expect(up.statusCode).toBe(200);
    htmlProofId = up.body.id;
    const res = await request(app).get(`/api/payment-proofs/${htmlProofId}/attachment`).set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(200);
    // Untrusted MIME is not echoed back; served as a generic download with nosniff.
    expect(res.headers['content-type']).toMatch(/^application\/octet-stream/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/i);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  // 9
  test('admin/assistant can accept a proof', async () => {
    const res = await request(app).patch(`/api/payment-proofs/${ownProofId}/review`).set('Authorization', `Bearer ${admin.token}`).send({ status: 'Accepted' });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('Accepted');
    expect(res.body.reviewedAt).toBeTruthy();
  });

  // 10
  test('admin/assistant can reject a proof with a capped review note', async () => {
    // Seed a dedicated rejectable proof
    const up = await uploadProof(client.token, { invoiceId: rejectInvoiceId, matterId: rejectMatterId, method: 'Bank Transfer', reference: `R23-REJ-${suffix}`, amount: 30000, fileName: 'rej.png', mimeType: 'image/png', data: PNG_DATA_URL });
    expect(up.statusCode).toBe(200);
    rejectProofId = up.body.id;
    const longNote = 'x'.repeat(900);
    const res = await request(app).patch(`/api/payment-proofs/${rejectProofId}/review`).set('Authorization', `Bearer ${assistant.token}`).send({ status: 'Rejected', reviewNote: longNote });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('Rejected');
    expect(res.body.reviewNote.length).toBe(500);
  });

  // 11
  test('advocate and client cannot accept/reject proofs', async () => {
    const adv = await request(app).patch(`/api/payment-proofs/${ownProofId}/review`).set('Authorization', `Bearer ${advocate.token}`).send({ status: 'Accepted' });
    expect(adv.statusCode).toBe(403);
    const cli = await request(app).patch(`/api/payment-proofs/${ownProofId}/review`).set('Authorization', `Bearer ${client.token}`).send({ status: 'Accepted' });
    expect(cli.statusCode).toBe(403);
  });

  test('invalid review status is rejected', async () => {
    const res = await request(app).patch(`/api/payment-proofs/${ownProofId}/review`).set('Authorization', `Bearer ${admin.token}`).send({ status: 'Maybe' });
    expect(res.statusCode).toBe(400);
  });

  // 12 + 18 (review audit safe)
  test('review writes a safe audit event without file bytes', async () => {
    const event = await latestAudit('payment_proof_reviewed', rejectProofId);
    const metadata = parseMetadata(event);
    expect(metadata.status).toBe('Rejected');
    expect(metadata.paymentProofId).toBe(rejectProofId);
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(PNG_DATA_URL.split(',').pop());
    expect(serialized.toLowerCase()).not.toContain('content');
  });

  // 13
  test('proof upload alone does not alter invoice paid/balance/status', async () => {
    const res = await request(app).get(`/api/invoices/${linkInvoiceId}`).set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(200);
    const before = { amountPaid: res.body.amountPaid, balance: res.body.balance, status: res.body.status };
    const up = await uploadProof(client.token, { invoiceId: linkInvoiceId, matterId: linkMatterId, method: 'M-PESA', reference: `R23-LINK-${suffix}`, amount: 20000, fileName: 'link.png', mimeType: 'image/png', data: PNG_DATA_URL });
    expect(up.statusCode).toBe(200);
    linkProofId = up.body.id;
    const after = await request(app).get(`/api/invoices/${linkInvoiceId}`).set('Authorization', `Bearer ${admin.token}`);
    expect(after.body.amountPaid).toBe(before.amountPaid);
    expect(after.body.balance).toBe(before.balance);
    expect(after.body.status).toBe(before.status);
    expect(after.body.amountPaid).toBe(0);
    expect(after.body.status).toBe('Outstanding');
  });

  // 14 + 15
  test('recording a payment with proofId links payment and proof, and a receipt becomes available', async () => {
    // Accept the proof first (Accepted proofs are the normal settlement path)
    const review = await request(app).patch(`/api/payment-proofs/${linkProofId}/review`).set('Authorization', `Bearer ${admin.token}`).send({ status: 'Accepted' });
    expect(review.statusCode).toBe(200);
    const pay = await request(app).post(`/api/invoices/${linkInvoiceId}/payments`).set('Authorization', `Bearer ${admin.token}`).send({ amount: 20000, method: 'M-PESA', reference: `R23-PAY-${suffix}`, date: '2026-05-20', proofId: linkProofId });
    expect(pay.statusCode).toBe(200);
    expect(pay.body.payment.proofId).toBe(linkProofId);
    expect(pay.body.payment.receiptNumber).toMatch(/^RCPT-\d{4}-\d{6}$/);
    expect(pay.body.invoice.status).toBe('Paid');
    const paymentId = pay.body.payment.id;
    // Proof now reports the linked payment id in the queue.
    const { proof } = await queueProof(admin.token, linkProofId);
    expect(proof.paymentId).toBe(paymentId);
    // Receipt PDF is available only now that a payment exists.
    const receipt = await request(app).get(`/api/invoices/${linkInvoiceId}/payments/${paymentId}/receipt.pdf`).set('Authorization', `Bearer ${admin.token}`);
    expect(receipt.statusCode).toBe(200);
    expect(receipt.headers['content-type']).toMatch(/^application\/pdf/);
  });

  // 16
  test('a rejected proof cannot be used to record a payment', async () => {
    const res = await request(app).post(`/api/invoices/${rejectInvoiceId}/payments`).set('Authorization', `Bearer ${admin.token}`).send({ amount: 30000, method: 'Bank Transfer', reference: `R23-REJPAY-${suffix}`, date: '2026-05-20', proofId: rejectProofId });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/rejected/i);
  });

  // 17
  test('client dashboard returns proof status/reviewNote only for own proofs', async () => {
    const res = await request(app).get('/api/client/dashboard').set('Authorization', `Bearer ${client.token}`);
    expect(res.statusCode).toBe(200);
    const proofs = res.body.paymentProofs || [];
    expect(proofs.length).toBeGreaterThan(0);
    for (const p of proofs) {
      expect(p.clientId).toBe(clientId);
      expect(p).toHaveProperty('status');
      expect(p).not.toHaveProperty('content');
    }
    const accepted = proofs.find(p => p.id === linkProofId);
    expect(accepted).toBeDefined();
    expect(accepted.status).toBe('Accepted');
    expect(accepted.paymentId).toBeTruthy();
    // Other client's dashboard must not see this client's proofs.
    const otherRes = await request(app).get('/api/client/dashboard').set('Authorization', `Bearer ${otherClient.token}`);
    expect(otherRes.statusCode).toBe(200);
    const otherIds = (otherRes.body.paymentProofs || []).map(p => p.id);
    expect(otherIds).not.toContain(linkProofId);
    expect(otherIds).not.toContain(ownProofId);
  });

  // 18 (upload + attachment audit safe)
  test('proof upload and attachment audit events contain no file bytes', async () => {
    const uploadEvent = await latestAudit('payment_proof_uploaded', ownProofId);
    const uploadMeta = parseMetadata(uploadEvent);
    expect(JSON.stringify(uploadMeta)).not.toContain(PNG_DATA_URL.split(',').pop());
    const downloadEvent = await latestAudit('payment_proof_attachment_downloaded', ownProofId);
    const downloadMeta = parseMetadata(downloadEvent);
    expect(downloadMeta.paymentProofId).toBe(ownProofId);
    expect(JSON.stringify(downloadMeta)).not.toContain(PNG_DATA_URL.split(',').pop());
    expect(JSON.stringify(downloadMeta).toLowerCase()).not.toContain('base64');
  });
});
