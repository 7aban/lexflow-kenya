'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const sqlite3 = require('sqlite3');
const {
  CLIENT_VISIBILITY_INELIGIBILITY_REASONS,
  documentClientVisibilityCapability,
  publicStaffMatterDocument,
} = require('../lib/documents');

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-bulk-visibility-'));
const databasePath = path.join(tempRoot, `bulk-visibility-${suffix}.sqlite`);
fs.closeSync(fs.openSync(databasePath, 'wx'));

const previousEnvironment = {
  DATABASE_PATH: process.env.DATABASE_PATH,
  JWT_SECRET: process.env.JWT_SECRET,
  SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL,
  SEED_ADMIN_NAME: process.env.SEED_ADMIN_NAME,
  SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD,
};

process.env.DATABASE_PATH = databasePath;
process.env.JWT_SECRET = `bulk-visibility-test-secret-${suffix}`;
process.env.SEED_ADMIN_EMAIL = `bulk.visibility.admin.${suffix}@example.com`;
process.env.SEED_ADMIN_NAME = 'Bulk Visibility Admin';
process.env.SEED_ADMIN_PASSWORD = 'BulkVisibilityAdmin!56';

const { app, dbReady } = require('../server.js');

jest.setTimeout(60000);

const password = 'BulkVisibility!56';
const auth = token => ({ Authorization: `Bearer ${token}` });

function withDb(operation) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(databasePath);
    operation(database, (error, result) => {
      database.close(closeError => (error || closeError) ? reject(error || closeError) : resolve(result));
    });
  });
}

function dbRun(sql, params = []) {
  return withDb((database, done) => database.run(sql, params, error => done(error)));
}

function dbAll(sql, params = []) {
  return withDb((database, done) => database.all(sql, params, (error, rows) => done(error, rows)));
}

async function login(email, loginPassword = password, route = '/api/auth/login') {
  const response = await request(app).post(route).send({ email, password: loginPassword });
  expect(response.statusCode).toBe(200);
  return response.body;
}

describe('LOCAL-PILOT-GLOBAL-DOCUMENT-BULK-VISIBILITY-96 / DOCUMENT-VISIBILITY-CAPABILITY-COHERENCE-98 backend', () => {
  const advocateEmail = `bulk.visibility.advocate.${suffix}@example.com`;
  const unassignedAdvocateEmail = `bulk.visibility.unassigned.${suffix}@example.com`;
  const assistantEmail = `bulk.visibility.assistant.${suffix}@example.com`;
  const clientEmail = `bulk.visibility.client.${suffix}@example.com`;

  const documentIds = {
    firmInternal: `DOC-VIS-FIRM-INTERNAL-${suffix}`,
    firmVisible: `DOC-VIS-FIRM-VISIBLE-${suffix}`,
    generatedInternal: `DOC-VIS-GENERATED-${suffix}`,
    clientUpload: `DOC-VIS-CLIENT-${suffix}`,
    message: `DOC-VIS-MESSAGE-${suffix}`,
    notice: `DOC-VIS-NOTICE-${suffix}`,
    archived: `DOC-VIS-ARCHIVED-${suffix}`,
    hidden: `DOC-VIS-HIDDEN-${suffix}`,
  };

  let admin;
  let advocate;
  let unassignedAdvocate;
  let assistant;
  let clientUser;
  let assignedClientId;
  let hiddenClientId;
  let assignedMatterId;
  let hiddenMatterId;

  async function registerUser(email, fullName, role, clientId = '') {
    const response = await request(app)
      .post('/api/auth/register')
      .set(auth(admin.token))
      .send({ email, password, fullName, role, clientId });
    expect(response.statusCode).toBe(200);
  }

  async function createClient(name, email) {
    const response = await request(app)
      .post('/api/clients')
      .set(auth(admin.token))
      .send({ name, email });
    expect(response.statusCode).toBe(200);
    return response.body.id;
  }

  async function createMatter(clientId, title, assignedTo) {
    const response = await request(app)
      .post('/api/matters')
      .set(auth(admin.token))
      .send({ clientId, title, assignedTo });
    expect(response.statusCode).toBe(200);
    return response.body.id;
  }

  async function insertDocument({
    id,
    matterId = assignedMatterId,
    source = 'firm',
    messageId = null,
    noticeId = null,
    clientVisible = 0,
    deletedAt = null,
  }) {
    await dbRun(`INSERT INTO documents (
      id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,
      clientVisible,uploadedBy,deletedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      id,
      matterId,
      `${id}.pdf`,
      `${id}.pdf`,
      'PDF',
      'application/pdf',
      '2026-07-13',
      '1 KB',
      Buffer.from(`DISPOSABLE-BULK-VISIBILITY:${id}`),
      source,
      null,
      messageId,
      noticeId,
      clientVisible,
      admin.user.id,
      deletedAt,
    ]);
  }

  async function successAuditRows(documentId) {
    const [events, legacy] = await Promise.all([
      dbAll("SELECT action,metadata_json FROM audit_events WHERE entity_id=? AND action='document_visibility_updated' ORDER BY rowid", [documentId]),
      dbAll("SELECT action FROM audit_logs WHERE entityId=? AND action='update' ORDER BY rowid", [documentId]),
    ]);
    return { events, legacy };
  }

  beforeAll(async () => {
    await dbReady;
    admin = await login(process.env.SEED_ADMIN_EMAIL, process.env.SEED_ADMIN_PASSWORD);

    await registerUser(advocateEmail, 'Assigned Visibility Advocate', 'advocate');
    await registerUser(unassignedAdvocateEmail, 'Unassigned Visibility Advocate', 'advocate');
    await registerUser(assistantEmail, 'Visibility Assistant', 'assistant');

    assignedClientId = await createClient(`Visibility Client ${suffix}`, clientEmail);
    hiddenClientId = await createClient(`Hidden Visibility Client ${suffix}`, `hidden.visibility.${suffix}@example.com`);
    await registerUser(clientEmail, 'Visibility Client User', 'client', assignedClientId);

    advocate = await login(advocateEmail);
    unassignedAdvocate = await login(unassignedAdvocateEmail);
    assistant = await login(assistantEmail);
    clientUser = await login(clientEmail, password, '/api/auth/client-login');

    assignedMatterId = await createMatter(assignedClientId, `Assigned Visibility Matter ${suffix}`, 'Assigned Visibility Advocate');
    hiddenMatterId = await createMatter(hiddenClientId, `Hidden Visibility Matter ${suffix}`, 'Unassigned Visibility Advocate');

    const conversationId = `CONV-VIS-${suffix}`;
    const messageId = `MSG-VIS-${suffix}`;
    const noticeId = `NOTICE-VIS-${suffix}`;
    await dbRun('INSERT INTO conversations (id,matterId,clientId,subject,createdAt) VALUES (?,?,?,?,?)', [conversationId, assignedMatterId, assignedClientId, 'Visibility context', '2026-07-13T10:00:00.000Z']);
    await dbRun('INSERT INTO messages (id,conversationId,senderId,senderRole,body,createdAt) VALUES (?,?,?,?,?,?)', [messageId, conversationId, admin.user.id, 'admin', 'Disposable visibility message', '2026-07-13T10:00:00.000Z']);
    await dbRun('INSERT INTO firm_notices (id,title,content,createdAt,createdBy,clientId) VALUES (?,?,?,?,?,?)', [noticeId, 'Visibility notice', 'Disposable notice', '2026-07-13T10:00:00.000Z', admin.user.id, assignedClientId]);

    await insertDocument({ id: documentIds.firmInternal });
    await insertDocument({ id: documentIds.firmVisible, clientVisible: 1 });
    await insertDocument({ id: documentIds.generatedInternal, source: 'generated' });
    await insertDocument({ id: documentIds.clientUpload, source: 'client' });
    await insertDocument({ id: documentIds.message, messageId });
    await insertDocument({ id: documentIds.notice, noticeId, clientVisible: 1 });
    await insertDocument({ id: documentIds.archived, deletedAt: '2026-07-13T11:00:00.000Z' });
    await insertDocument({ id: documentIds.hidden, matterId: hiddenMatterId });
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('defines one origin-aware document capability contract', () => {
    expect(documentClientVisibilityCapability({ matterId: 'MATTER', source: 'firm' })).toEqual({ mutable: true, ineligibilityReason: null });
    expect(documentClientVisibilityCapability({ matterId: 'MATTER', source: 'generated' })).toEqual({ mutable: true, ineligibilityReason: null });
    expect(documentClientVisibilityCapability({ matterId: 'MATTER', source: 'client' })).toEqual({
      mutable: false,
      ineligibilityReason: CLIENT_VISIBILITY_INELIGIBILITY_REASONS.CLIENT_UPLOAD,
    });
    expect(documentClientVisibilityCapability({ matterId: 'MATTER', source: 'client', messageId: 'MSG' })).toEqual({
      mutable: false,
      ineligibilityReason: CLIENT_VISIBILITY_INELIGIBILITY_REASONS.MESSAGE_CONTEXT,
    });
    expect(documentClientVisibilityCapability({ matterId: 'MATTER', noticeId: 'NOTICE' })).toEqual({
      mutable: false,
      ineligibilityReason: CLIENT_VISIBILITY_INELIGIBILITY_REASONS.NOTICE_CONTEXT,
    });
    expect(documentClientVisibilityCapability({ matterId: 'MATTER', deletedAt: '2026-07-13T11:00:00.000Z' })).toEqual({
      mutable: false,
      ineligibilityReason: CLIENT_VISIBILITY_INELIGIBILITY_REASONS.ARCHIVED,
    });
    expect(documentClientVisibilityCapability({ source: 'firm' })).toEqual({
      mutable: false,
      ineligibilityReason: CLIENT_VISIBILITY_INELIGIBILITY_REASONS.OUTSIDE_MATTER_CONTEXT,
    });

    const matterlessProjection = publicStaffMatterDocument({
      id: 'DOC-MATTERLESS-CONTEXT',
      matterId: '',
      name: 'matterless.pdf',
      source: 'firm',
      clientVisible: 0,
    });
    expect(matterlessProjection.visibility).toBe('internal');
    expect(matterlessProjection.capabilities.clientVisibility).toEqual({
      mutable: false,
      ineligibilityReason: CLIENT_VISIBILITY_INELIGIBILITY_REASONS.OUTSIDE_MATTER_CONTEXT,
    });
  });

  test('exposes only safe capability metadata from the scoped Global Explorer', async () => {
    const response = await request(app)
      .get('/api/documents?status=all&limit=100&sort=name_asc')
      .set(auth(admin.token));
    expect(response.statusCode).toBe(200);
    const byId = new Map(response.body.items.map(document => [document.id, document]));
    expect(byId.get(documentIds.firmInternal).capabilities.clientVisibility).toEqual({ mutable: true, ineligibilityReason: null });
    expect(byId.get(documentIds.generatedInternal).capabilities.clientVisibility).toEqual({ mutable: true, ineligibilityReason: null });
    expect(byId.get(documentIds.clientUpload).capabilities.clientVisibility).toEqual({ mutable: false, ineligibilityReason: 'client_upload' });
    expect(byId.get(documentIds.message).capabilities.clientVisibility).toEqual({ mutable: false, ineligibilityReason: 'message_context' });
    expect(byId.get(documentIds.notice).capabilities.clientVisibility).toEqual({ mutable: false, ineligibilityReason: 'notice_context' });
    expect(byId.get(documentIds.archived).capabilities.clientVisibility).toEqual({ mutable: false, ineligibilityReason: 'archived' });

    for (const document of response.body.items) {
      expect(document).not.toHaveProperty('messageId');
      expect(document).not.toHaveProperty('noticeId');
      expect(document).not.toHaveProperty('uploadedBy');
      expect(JSON.stringify(document)).not.toContain('DISPOSABLE-BULK-VISIBILITY');
    }

    const assignedList = await request(app).get('/api/documents?limit=100').set(auth(advocate.token));
    expect(assignedList.statusCode).toBe(200);
    expect(assignedList.body.items.map(document => document.id)).not.toContain(documentIds.hidden);

    const assistantList = await request(app).get('/api/documents?limit=100').set(auth(assistant.token));
    expect(assistantList.statusCode).toBe(200);
    expect(assistantList.body.items.find(document => document.id === documentIds.firmInternal).capabilities.clientVisibility.mutable).toBe(true);

    const clientDenied = await request(app).get('/api/documents').set(auth(clientUser.token));
    expect(clientDenied.statusCode).toBe(403);
  });

  test('projects effective visibility and the shared capability into staff matter responses only', async () => {
    const adminDocuments = await request(app)
      .get(`/api/matters/${assignedMatterId}/documents`)
      .set(auth(admin.token));
    expect(adminDocuments.statusCode).toBe(200);
    const byId = new Map(adminDocuments.body.map(document => [document.id, document]));

    expect(byId.get(documentIds.firmInternal)).toMatchObject({
      clientVisible: 0,
      visibility: 'internal',
      capabilities: { clientVisibility: { mutable: true, ineligibilityReason: null } },
    });
    expect(byId.get(documentIds.firmVisible)).toMatchObject({
      clientVisible: 1,
      visibility: 'client',
      capabilities: { clientVisibility: { mutable: true, ineligibilityReason: null } },
    });
    expect(byId.get(documentIds.generatedInternal)).toMatchObject({
      visibility: 'internal',
      capabilities: { clientVisibility: { mutable: true, ineligibilityReason: null } },
    });
    expect(byId.get(documentIds.clientUpload)).toMatchObject({
      clientVisible: 0,
      visibility: 'client',
      capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'client_upload' } },
    });
    expect(byId.get(documentIds.message)).toMatchObject({
      clientVisible: 0,
      visibility: 'client',
      capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'message_context' } },
    });
    expect(byId.get(documentIds.notice)).toMatchObject({
      clientVisible: 1,
      visibility: 'client',
      capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'notice_context' } },
    });

    for (const document of adminDocuments.body) {
      expect(document).not.toHaveProperty('messageClientVisible');
      expect(document).not.toHaveProperty('visibilityDeletedAt');
      expect(document).not.toHaveProperty('deletedAt');
    }

    const advocateMatter = await request(app)
      .get(`/api/matters/${assignedMatterId}`)
      .set(auth(advocate.token));
    expect(advocateMatter.statusCode).toBe(200);
    expect(advocateMatter.body.documents.find(document => document.id === documentIds.message)).toMatchObject({
      visibility: 'client',
      capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'message_context' } },
    });

    const assistantDocuments = await request(app)
      .get(`/api/matters/${assignedMatterId}/documents`)
      .set(auth(assistant.token));
    expect(assistantDocuments.statusCode).toBe(200);
    expect(assistantDocuments.body.find(document => document.id === documentIds.clientUpload)).toMatchObject({
      visibility: 'client',
      capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'client_upload' } },
    });

    const archivedDocuments = await request(app)
      .get(`/api/matters/${assignedMatterId}/documents?status=archived`)
      .set(auth(admin.token));
    expect(archivedDocuments.statusCode).toBe(200);
    expect(archivedDocuments.body).toEqual([
      expect.objectContaining({
        id: documentIds.archived,
        visibility: 'internal',
        capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'archived' } },
      }),
    ]);

    const clientDocuments = await request(app)
      .get(`/api/matters/${assignedMatterId}/documents`)
      .set(auth(clientUser.token));
    expect(clientDocuments.statusCode).toBe(200);
    expect(clientDocuments.body.map(document => document.id)).toEqual(expect.arrayContaining([
      documentIds.clientUpload,
      documentIds.message,
      documentIds.notice,
    ]));
    for (const document of clientDocuments.body) {
      expect(document).not.toHaveProperty('visibility');
      expect(document).not.toHaveProperty('capabilities');
    }

    const clientMatter = await request(app)
      .get(`/api/matters/${assignedMatterId}`)
      .set(auth(clientUser.token));
    expect(clientMatter.statusCode).toBe(200);
    for (const document of clientMatter.body.documents) {
      expect(document).not.toHaveProperty('visibility');
      expect(document).not.toHaveProperty('capabilities');
    }
  });

  test('enforces effective changes for admin and assigned advocate and audits exact old/new values', async () => {
    const noOp = await request(app)
      .patch(`/api/documents/${documentIds.generatedInternal}`)
      .set(auth(admin.token))
      .send({ clientVisible: false });
    expect(noOp.statusCode).toBe(409);
    expect(noOp.body).toEqual({ error: 'Document is already internal', code: 'document_visibility_unchanged' });
    expect(await successAuditRows(documentIds.generatedInternal)).toEqual({ events: [], legacy: [] });

    for (const [documentId, requested, reason] of [
      [documentIds.clientUpload, false, 'client_upload'],
      [documentIds.message, false, 'message_context'],
      [documentIds.notice, false, 'notice_context'],
    ]) {
      const rejected = await request(app)
        .patch(`/api/documents/${documentId}`)
        .set(auth(admin.token))
        .send({ clientVisible: requested });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.body).toMatchObject({ code: 'document_visibility_ineligible', ineligibilityReason: reason });
      expect(await successAuditRows(documentId)).toEqual({ events: [], legacy: [] });
    }

    const adminSuccess = await request(app)
      .patch(`/api/documents/${documentIds.firmInternal}`)
      .set(auth(admin.token))
      .send({ clientVisible: true });
    expect(adminSuccess.statusCode).toBe(200);
    expect(Boolean(adminSuccess.body.clientVisible)).toBe(true);

    const advocateSuccess = await request(app)
      .patch(`/api/documents/${documentIds.firmVisible}`)
      .set(auth(advocate.token))
      .send({ clientVisible: false });
    expect(advocateSuccess.statusCode).toBe(200);
    expect(Boolean(advocateSuccess.body.clientVisible)).toBe(false);

    const adminAudits = await successAuditRows(documentIds.firmInternal);
    const advocateAudits = await successAuditRows(documentIds.firmVisible);
    expect(adminAudits.events).toHaveLength(1);
    expect(adminAudits.legacy).toHaveLength(1);
    expect(JSON.parse(adminAudits.events[0].metadata_json)).toMatchObject({ oldClientVisible: false, newClientVisible: true });
    expect(advocateAudits.events).toHaveLength(1);
    expect(advocateAudits.legacy).toHaveLength(1);
    expect(JSON.parse(advocateAudits.events[0].metadata_json)).toMatchObject({ oldClientVisible: true, newClientVisible: false });

    const clientDocuments = await request(app)
      .get(`/api/matters/${assignedMatterId}/documents`)
      .set(auth(clientUser.token));
    expect(clientDocuments.statusCode).toBe(200);
    const clientDocumentIds = clientDocuments.body.map(document => document.id);
    expect(clientDocumentIds).toContain(documentIds.firmInternal);
    expect(clientDocumentIds).not.toContain(documentIds.firmVisible);
    expect(clientDocumentIds).toEqual(expect.arrayContaining([documentIds.clientUpload, documentIds.message, documentIds.notice]));
  });

  test('denies unauthorized, inaccessible, stale, and archived mutations without visibility success audits', async () => {
    for (const [token, expectedStatus] of [
      [unassignedAdvocate.token, 403],
      [assistant.token, 403],
      [clientUser.token, 403],
    ]) {
      const denied = await request(app)
        .patch(`/api/documents/${documentIds.generatedInternal}`)
        .set(auth(token))
        .send({ clientVisible: true });
      expect(denied.statusCode).toBe(expectedStatus);
    }

    const inaccessible = await request(app)
      .patch(`/api/documents/${documentIds.hidden}`)
      .set(auth(advocate.token))
      .send({ clientVisible: true });
    expect(inaccessible.statusCode).toBe(403);
    expect(inaccessible.body).toEqual({ error: 'Document access denied' });

    const stale = await request(app)
      .patch(`/api/documents/DOC-VIS-STALE-${suffix}`)
      .set(auth(admin.token))
      .send({ clientVisible: true });
    expect(stale.statusCode).toBe(404);
    expect(stale.body).toEqual({ error: 'Document not found' });

    const archived = await request(app)
      .patch(`/api/documents/${documentIds.archived}`)
      .set(auth(admin.token))
      .send({ clientVisible: true });
    expect(archived.statusCode).toBe(404);
    expect(archived.body).toEqual({ error: 'Document not found' });

    expect(await successAuditRows(documentIds.generatedInternal)).toEqual({ events: [], legacy: [] });
    expect(await successAuditRows(documentIds.hidden)).toEqual({ events: [], legacy: [] });
    expect(await successAuditRows(documentIds.archived)).toEqual({ events: [], legacy: [] });

    const unchanged = await dbAll('SELECT id,clientVisible FROM documents WHERE id IN (?,?,?) ORDER BY id', [
      documentIds.generatedInternal,
      documentIds.hidden,
      documentIds.archived,
    ]);
    expect(unchanged.every(document => Number(document.clientVisible) === 0)).toBe(true);
  });
});
