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
  expect(event.actor_role).toBeTruthy();
  expect(event.actor_email).toBeTruthy();
  const metadata = JSON.parse(event.metadata_json || '{}');
  const serialized = JSON.stringify(metadata).toLowerCase();
  for (const forbidden of ['token', 'authorization', 'bearer', 'password', 'secret', 'blob', 'should_not_appear']) {
    expect(serialized).not.toContain(forbidden);
  }
  return metadata;
}

async function login(pathName, email) {
  const res = await request(app)
    .post(pathName)
    .send({ email, password: 'password123' });
  expect(res.statusCode).toBe(200);
  expect(res.body.token).toBeDefined();
  return res.body;
}

async function firstMatterForClient(adminToken, clientId) {
  const mattersRes = await request(app)
    .get('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(mattersRes.statusCode).toBe(200);
  const matter = mattersRes.body.find(row => row.clientId === clientId) || mattersRes.body[0];
  expect(matter).toBeDefined();
  return matter;
}

describe('R13b document and download audit events', () => {
  let adminToken;
  let clientToken;
  let clientUser;

  beforeAll(async () => {
    const adminLogin = await login('/api/auth/login', 'admin@lexflow.co.ke');
    adminToken = adminLogin.token;

    const clientLogin = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');
    clientToken = clientLogin.token;
    clientUser = clientLogin.user;
  });

  test('successful document download creates structured download audit event', async () => {
    const matter = await firstMatterForClient(adminToken, clientUser.clientId);
    const uploadRes = await request(app)
      .post(`/api/matters/${matter.id}/documents`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'r13b-download.pdf',
        mimeType: 'application/pdf',
        data: `data:application/pdf;base64,${Buffer.from('SHOULD_NOT_APPEAR document body').toString('base64')}`,
        clientVisible: true,
      });
    expect(uploadRes.statusCode).toBe(200);

    const downloadRes = await request(app)
      .get(`/api/documents/${uploadRes.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(downloadRes.statusCode).toBe(200);

    const event = await latestAudit('document_downloaded', uploadRes.body.id);
    expect(event.action).toBe('document_downloaded');
    expect(event.entity_type).toBe('document');
    expect(event.entity_id).toBe(uploadRes.body.id);
    expect(event.matter_id).toBe(matter.id);
    expect(event.client_id).toBe(matter.clientId);
    const metadata = parseMetadata(event);
    expect(metadata.context).toBe('client_visible_document');
    expect(metadata.route).toBe('document_download');
    expect(metadata.documentId).toBe(uploadRes.body.id);
  });

  test('forbidden document download records forbidden event without success event', async () => {
    const matter = await firstMatterForClient(adminToken, clientUser.clientId);
    const uploadRes = await request(app)
      .post(`/api/matters/${matter.id}/documents`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'r13b-forbidden.pdf',
        mimeType: 'application/pdf',
        data: `data:application/pdf;base64,${Buffer.from('SHOULD_NOT_APPEAR forbidden body').toString('base64')}`,
        clientVisible: false,
      });
    expect(uploadRes.statusCode).toBe(200);

    const downloadRes = await request(app)
      .get(`/api/documents/${uploadRes.body.id}/download`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(downloadRes.statusCode).toBe(403);

    const forbidden = await latestAudit('forbidden_document_access', uploadRes.body.id);
    expect(forbidden.action).toBe('forbidden_document_access');
    expect(forbidden.entity_type).toBe('document');
    const metadata = parseMetadata(forbidden);
    expect(metadata.route).toBe('document_download');

    const successRows = await dbAll(
      'SELECT * FROM audit_events WHERE action=? AND entity_id=?',
      ['document_downloaded', uploadRes.body.id],
    );
    expect(successRows).toHaveLength(0);
  });

  test('invoice PDF download audit covers success and forbidden paths', async () => {
    const clientInvoices = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(clientInvoices.statusCode).toBe(200);
    expect(clientInvoices.body.length).toBeGreaterThan(0);

    const ownInvoice = clientInvoices.body[0];
    const pdfRes = await request(app)
      .get(`/api/invoices/${ownInvoice.id}/pdf`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(pdfRes.statusCode).toBe(200);

    const success = await latestAudit('invoice_pdf_downloaded', ownInvoice.id);
    expect(success.action).toBe('invoice_pdf_downloaded');
    expect(success.entity_type).toBe('invoice');
    expect(success.entity_id).toBe(ownInvoice.id);
    expect(success.matter_id).toBe(ownInvoice.matterId);
    expect(success.client_id).toBe(clientUser.clientId);
    const successMetadata = parseMetadata(success);
    expect(successMetadata.route).toBe('invoice_pdf_download');
    expect(successMetadata.invoiceId).toBe(ownInvoice.id);

    const allInvoices = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(allInvoices.statusCode).toBe(200);
    const otherInvoice = allInvoices.body.find(row => row.clientId !== clientUser.clientId);
    expect(otherInvoice).toBeDefined();

    const boundaryRows = await dbAll('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const auditBoundary = Number(boundaryRows[0]?.rowid || 0);

    const forbiddenRes = await request(app)
      .get(`/api/invoices/${otherInvoice.id}/pdf`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(forbiddenRes.statusCode).toBe(403);

    const forbiddenRows = await dbAll(
      'SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND entity_id=? AND actor_email=?',
      [auditBoundary, 'forbidden_invoice_access', otherInvoice.id, clientUser.email],
    );
    expect(forbiddenRows).toHaveLength(1);
    const forbidden = forbiddenRows[0];
    expect(forbidden.action).toBe('forbidden_invoice_access');
    parseMetadata(forbidden);

    const forbiddenSuccessRows = await dbAll(
      'SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND entity_id=? AND actor_email=?',
      [auditBoundary, 'invoice_pdf_downloaded', otherInvoice.id, clientUser.email],
    );
    expect(forbiddenSuccessRows).toHaveLength(0);
  });

  test('document upload, update, visibility, and delete create structured audit events', async () => {
    const matter = await firstMatterForClient(adminToken, clientUser.clientId);
    const uploadRes = await request(app)
      .post(`/api/matters/${matter.id}/documents`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'r13b-lifecycle.pdf',
        mimeType: 'application/pdf',
        data: `data:application/pdf;base64,${Buffer.from('SHOULD_NOT_APPEAR lifecycle body').toString('base64')}`,
      });
    expect(uploadRes.statusCode).toBe(200);
    const docId = uploadRes.body.id;

    const uploaded = await latestAudit('document_uploaded', docId);
    expect(uploaded.action).toBe('document_uploaded');
    expect(uploaded.matter_id).toBe(matter.id);
    const uploadMetadata = parseMetadata(uploaded);
    expect(uploadMetadata.context).toBe('matter_document');

    const updateRes = await request(app)
      .patch(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ displayName: 'r13b-lifecycle-renamed.pdf' });
    expect(updateRes.statusCode).toBe(200);

    const updated = await latestAudit('document_updated', docId);
    expect(updated.action).toBe('document_updated');
    const updateMetadata = parseMetadata(updated);
    expect(updateMetadata.changedFields).toContain('displayName');

    const visibilityRes = await request(app)
      .patch(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientVisible: true });
    expect(visibilityRes.statusCode).toBe(200);

    const visibility = await latestAudit('document_visibility_updated', docId);
    expect(visibility.action).toBe('document_visibility_updated');
    const visibilityMetadata = parseMetadata(visibility);
    expect(visibilityMetadata.oldClientVisible).toBe(false);
    expect(visibilityMetadata.newClientVisible).toBe(true);

    const deleteRes = await request(app)
      .delete(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleteRes.statusCode).toBe(200);

    const deleted = await latestAudit('document_deleted', docId);
    expect(deleted.action).toBe('document_deleted');
    const deleteMetadata = parseMetadata(deleted);
    expect(deleteMetadata.route).toBe('document_delete');
  });

  test('communication attachment download is distinguished in audit metadata', async () => {
    const createConversation = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: clientUser.clientId, subject: 'R13b attachment audit' });
    expect(createConversation.statusCode).toBe(200);

    const messageRes = await request(app)
      .post(`/api/conversations/${createConversation.body.id}/messages`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        body: 'R13b attachment audit message',
        attachments: [{
          name: 'r13b-attachment.pdf',
          displayName: 'r13b-attachment.pdf',
          mimeType: 'application/pdf',
          data: `data:application/pdf;base64,${Buffer.from('SHOULD_NOT_APPEAR attachment body').toString('base64')}`,
        }],
      });
    expect(messageRes.statusCode).toBe(200);
    expect(messageRes.body.attachments.length).toBe(1);
    const attachmentId = messageRes.body.attachments[0].id;

    const downloadRes = await request(app)
      .get(`/api/documents/${attachmentId}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(downloadRes.statusCode).toBe(200);

    const event = await latestAudit('document_downloaded', attachmentId);
    expect(event.action).toBe('document_downloaded');
    const metadata = parseMetadata(event);
    expect(metadata.context).toBe('communication_attachment');
    expect(metadata.route).toBe('document_download');
  });
});
