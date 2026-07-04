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

async function latestAudit(action, entityId) {
  const rows = await dbAll(
    'SELECT * FROM audit_events WHERE action=? AND entity_id=? ORDER BY timestamp DESC LIMIT 1',
    [action, entityId || ''],
  );
  return rows[0];
}

function parseSafeMetadata(event) {
  expect(event).toBeDefined();
  const metadata = JSON.parse(event.metadata_json || '{}');
  const serialized = JSON.stringify(metadata).toLowerCase();
  for (const forbidden of ['token', 'authorization', 'bearer', 'password', 'secret', 'rawbody']) {
    expect(serialized).not.toContain(forbidden);
  }
  return metadata;
}

describe('R13h invoice lifecycle structured audit events', () => {
  let adminToken;
  let advocateToken;
  let clientToken;
  let testClientId;
  let margaretClientId;
  let testMatterId;
  let createdInvoiceId;
  let clientMatterId;
  let clientInvoiceId;

  beforeAll(async () => {
    await dbReady;
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;

    const advRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    expect(advRes.statusCode).toBe(200);
    advocateToken = advRes.body.token;

    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(clientRes.statusCode).toBe(200);
    clientToken = clientRes.body.token;
    margaretClientId = clientRes.body.user.clientId;
    expect(margaretClientId).toBeTruthy();

    const clientsRes = await request(app)
      .get('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(clientsRes.statusCode).toBe(200);
    expect(clientsRes.body.length).toBeGreaterThan(0);
    testClientId = clientsRes.body[0].id;

    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId: margaretClientId,
        title: 'R13h Client Matter',
        practiceArea: 'Civil Litigation',
        billingType: 'fixed',
        fixedFee: '50000',
        stage: 'Intake',
      });
    expect(matterRes.statusCode).toBe(200);
    expect(matterRes.body).toHaveProperty('id');
    clientMatterId = matterRes.body.id;

    const invRes = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId: clientMatterId });
    expect(invRes.statusCode).toBe(200);
    expect(invRes.body).toHaveProperty('id');
    clientInvoiceId = invRes.body.id;
  });

  test('successful invoice generation creates structured invoice_generated audit event', async () => {
    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId: testClientId,
        title: 'R13h Invoice Test Matter',
        practiceArea: 'Civil Litigation',
        billingType: 'fixed',
        fixedFee: '50000',
        stage: 'Intake',
      });
    expect(matterRes.statusCode).toBe(200);
    expect(matterRes.body).toHaveProperty('id');
    testMatterId = matterRes.body.id;

    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId: testMatterId });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('id');
    createdInvoiceId = res.body.id;

    const event = await latestAudit('invoice_generated', createdInvoiceId);
    expect(event).toBeDefined();
    expect(event.action).toBe('invoice_generated');
    expect(event.entity_type).toBe('invoice');
    expect(event.entity_id).toBe(createdInvoiceId);

    const metadata = parseSafeMetadata(event);
    expect(metadata.invoiceId).toBe(createdInvoiceId);
    expect(metadata.amount).toBe(50000);
    expect(metadata.matterId).toBe(testMatterId);
  });

  test('successful invoice status change creates structured invoice_status_updated audit event', async () => {
    const res = await request(app)
      .patch(`/api/invoices/${createdInvoiceId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'Paid' });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('Paid');

    const event = await latestAudit('invoice_status_updated', createdInvoiceId);
    expect(event).toBeDefined();
    expect(event.action).toBe('invoice_status_updated');
    expect(event.entity_type).toBe('invoice');
    expect(event.entity_id).toBe(createdInvoiceId);

    const metadata = parseSafeMetadata(event);
    expect(metadata.invoiceId).toBe(createdInvoiceId);
    expect(metadata.oldStatus).toBe('Outstanding');
    expect(metadata.newStatus).toBe('Paid');
  });

  test('successful payment proof upload creates structured payment_proof_uploaded audit event', async () => {
    const res = await request(app)
      .post('/api/payment-proofs')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({
        invoiceId: clientInvoiceId,
        matterId: clientMatterId,
        method: 'M-PESA',
        reference: `R13H-REF-${Date.now()}`,
        amount: 50000,
        note: 'Test payment proof',
      });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('id');

    const event = await latestAudit('payment_proof_uploaded', res.body.id);
    expect(event).toBeDefined();
    expect(event.action).toBe('payment_proof_uploaded');
    expect(event.entity_type).toBe('payment_proof');
    expect(event.entity_id).toBe(res.body.id);

    const metadata = parseSafeMetadata(event);
    expect(metadata.invoiceId).toBe(clientInvoiceId);
    expect(metadata.matterId).toBe(clientMatterId);
    expect(metadata.method).toBe('M-PESA');
    expect(metadata.amount).toBe(50000);
  });

  test('unauthorized user cannot generate invoice and no success lifecycle event is created', async () => {
    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId: testClientId,
        title: 'R13h Unauthorized Matter',
        practiceArea: 'Test',
        billingType: 'fixed',
        fixedFee: '10000',
      });
    expect(matterRes.statusCode).toBe(200);

    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ matterId: matterRes.body.id });
    expect(res.statusCode).toBe(403);

    const rows = await dbAll("SELECT * FROM audit_events WHERE action='invoice_generated' AND metadata_json LIKE ?", ['%R13h Unauthorized Matter%']);
    expect(rows.length).toBe(0);
  });

  test('audit metadata does not contain token, Authorization, Bearer, password, secret, or raw request body', async () => {
    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId: testClientId,
        title: 'R13h Safe Metadata',
        practiceArea: 'Test',
        billingType: 'fixed',
        fixedFee: '25000',
      });
    expect(matterRes.statusCode).toBe(200);

    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId: matterRes.body.id });
    expect(res.statusCode).toBe(200);

    const event = await latestAudit('invoice_generated', res.body.id);
    expect(event).toBeDefined();
    parseSafeMetadata(event);
  });

  test('admin can query invoice lifecycle events through /api/audit-events', async () => {
    const auditRes = await request(app)
      .get(`/api/audit-events?action=invoice_generated&entity_id=${encodeURIComponent(createdInvoiceId)}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.body.rows.some(row => row.action === 'invoice_generated' && row.entity_id === createdInvoiceId)).toBe(true);
  });

  test('non-admin cannot query /api/audit-events', async () => {
    const res = await request(app)
      .get('/api/audit-events')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('existing invoice_deleted behavior remains unchanged', async () => {
    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId: testClientId,
        title: 'R13h Delete Invoice Test',
        practiceArea: 'Test',
        billingType: 'fixed',
        fixedFee: '15000',
      });
    expect(matterRes.statusCode).toBe(200);

    const invRes = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId: matterRes.body.id });
    expect(invRes.statusCode).toBe(200);

    const delRes = await request(app)
      .delete(`/api/invoices/${invRes.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(delRes.statusCode).toBe(200);
    expect(delRes.body.deleted).toBe(true);

    const event = await latestAudit('invoice_deleted', invRes.body.id);
    expect(event).toBeDefined();
    expect(event.action).toBe('invoice_deleted');
    expect(event.entity_type).toBe('invoice');
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.number).toBeDefined();
    expect(metadata.status).toBe('Outstanding');
  });
});
