'use strict';

const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(30000);

const auth = token => ({ Authorization: `Bearer ${token}` });

describe('LOCAL-PILOT document access contract', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const password = 'DocumentAccess!56';
  const orphanDocumentId = `DOC-ACCESS-ORPHAN-${suffix}`;
  let adminToken;
  let assignedAdvocateToken;
  let unassignedAdvocateToken;
  let assistantToken;
  let ownClientToken;
  let otherClientToken;
  let ownMatterId;
  let otherMatterId;
  let visibleDocumentId;
  let internalDocumentId;
  let deletableDocumentId;
  let otherClientDocumentId;

  async function login(route, email, loginPassword = 'password123') {
    const response = await request(app).post(route).send({ email, password: loginPassword });
    expect(response.statusCode).toBe(200);
    return response.body.token;
  }

  async function createClientWithLogin(label) {
    const email = `document.access.${label}.${suffix}@example.com`;
    const clientResponse = await request(app)
      .post('/api/clients')
      .set(auth(adminToken))
      .send({ name: `Document Access ${label} ${suffix}`, email });
    expect(clientResponse.statusCode).toBe(200);

    const registration = await request(app)
      .post('/api/auth/register')
      .set(auth(adminToken))
      .send({
        email,
        password,
        fullName: `Document Access ${label}`,
        role: 'client',
        clientId: clientResponse.body.id,
      });
    expect(registration.statusCode).toBe(200);

    return {
      clientId: clientResponse.body.id,
      token: await login('/api/auth/client-login', email, password),
    };
  }

  async function upload(matterId, name, clientVisible = false) {
    const response = await request(app)
      .post(`/api/matters/${matterId}/documents`)
      .set(auth(adminToken))
      .send({
        name,
        mimeType: 'application/pdf',
        data: Buffer.from(`document access contract ${name}`).toString('base64'),
        clientVisible,
      });
    expect(response.statusCode).toBe(200);
    return response.body.id;
  }

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('/api/auth/login', 'admin@lexflow.co.ke');
    assignedAdvocateToken = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    unassignedAdvocateToken = await login('/api/auth/login', 'michael.oduor@achokilaw.co.ke');
    assistantToken = await login('/api/auth/login', 'david.wanjiku@achokilaw.co.ke');

    const ownClient = await createClientWithLogin('own');
    const otherClient = await createClientWithLogin('other');
    ownClientToken = ownClient.token;
    otherClientToken = otherClient.token;

    const ownMatter = await request(app)
      .post('/api/matters')
      .set(auth(adminToken))
      .send({
        clientId: ownClient.clientId,
        title: `Document Access Own Matter ${suffix}`,
        assignedTo: 'Sarah Mwangi',
      });
    expect(ownMatter.statusCode).toBe(200);
    ownMatterId = ownMatter.body.id;

    const otherMatter = await request(app)
      .post('/api/matters')
      .set(auth(adminToken))
      .send({
        clientId: otherClient.clientId,
        title: `Document Access Other Matter ${suffix}`,
        assignedTo: 'Sarah Mwangi',
      });
    expect(otherMatter.statusCode).toBe(200);
    otherMatterId = otherMatter.body.id;

    visibleDocumentId = await upload(ownMatterId, 'client-visible.pdf', true);
    internalDocumentId = await upload(ownMatterId, 'internal.pdf');
    deletableDocumentId = await upload(ownMatterId, 'delete-me.pdf');
    otherClientDocumentId = await upload(otherMatterId, 'other-client-visible.pdf', true);

    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(config.DATABASE_PATH);
      db.run(
        `INSERT INTO documents
          (id,matterId,name,displayName,type,mimeType,date,size,content,source,clientVisible,uploadedBy)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          orphanDocumentId,
          '',
          'orphan.pdf',
          'orphan.pdf',
          'PDF',
          'application/pdf',
          '2026-06-29',
          '1 KB',
          Buffer.from('orphan document'),
          'firm',
          0,
          '',
        ],
        error => db.close(closeError => (error || closeError) ? reject(error || closeError) : resolve()),
      );
    });
  });

  afterAll(async () => {
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(config.DATABASE_PATH);
      db.run('DELETE FROM documents WHERE id=?', [orphanDocumentId], error => {
        db.close(closeError => (error || closeError) ? reject(error || closeError) : resolve());
      });
    });
  });

  test('assigned advocate and admin can download a matter document', async () => {
    for (const token of [assignedAdvocateToken, adminToken]) {
      const response = await request(app)
        .get(`/api/documents/${internalDocumentId}/download`)
        .set(auth(token));
      expect(response.statusCode).toBe(200);
    }
  });

  test('unassigned advocate cannot download by known document ID', async () => {
    const response = await request(app)
      .get(`/api/documents/${internalDocumentId}/download`)
      .set(auth(unassignedAdvocateToken));
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: 'Document access denied' });
  });

  test('assistant download follows the existing firm-wide matter access rule', async () => {
    const response = await request(app)
      .get(`/api/documents/${internalDocumentId}/download`)
      .set(auth(assistantToken));
    expect(response.statusCode).toBe(200);
  });

  test('client can download only visible documents for their own matter', async () => {
    const visible = await request(app)
      .get(`/api/documents/${visibleDocumentId}/download`)
      .set(auth(ownClientToken));
    expect(visible.statusCode).toBe(200);

    const internal = await request(app)
      .get(`/api/documents/${internalDocumentId}/download`)
      .set(auth(ownClientToken));
    expect(internal.statusCode).toBe(403);

    const crossClient = await request(app)
      .get(`/api/documents/${otherClientDocumentId}/download`)
      .set(auth(ownClientToken));
    expect(crossClient.statusCode).toBe(403);

    const reverseCrossClient = await request(app)
      .get(`/api/documents/${visibleDocumentId}/download`)
      .set(auth(otherClientToken));
    expect(reverseCrossClient.statusCode).toBe(403);
  });

  test('unassigned advocate cannot patch metadata by known document ID', async () => {
    const denied = await request(app)
      .patch(`/api/documents/${internalDocumentId}`)
      .set(auth(unassignedAdvocateToken))
      .send({ displayName: 'unauthorized-rename.pdf', clientVisible: true });
    expect(denied.statusCode).toBe(403);

    const unchanged = await request(app)
      .get(`/api/matters/${ownMatterId}/documents`)
      .set(auth(assignedAdvocateToken));
    const document = unchanged.body.find(row => row.id === internalDocumentId);
    expect(document.displayName).toBe('internal.pdf');
    expect(Number(document.clientVisible)).toBe(0);
  });

  test('assigned advocate can patch metadata and list matter documents', async () => {
    const updated = await request(app)
      .patch(`/api/documents/${internalDocumentId}`)
      .set(auth(assignedAdvocateToken))
      .send({ displayName: 'authorized-rename.pdf' });
    expect(updated.statusCode).toBe(200);
    expect(updated.body.displayName).toBe('authorized-rename.pdf');

    const list = await request(app)
      .get(`/api/matters/${ownMatterId}/documents`)
      .set(auth(assignedAdvocateToken));
    expect(list.statusCode).toBe(200);
    expect(list.body.some(row => row.id === internalDocumentId)).toBe(true);
  });

  test('unassigned advocate cannot soft-delete by known document ID', async () => {
    const denied = await request(app)
      .delete(`/api/documents/${deletableDocumentId}`)
      .set(auth(unassignedAdvocateToken));
    expect(denied.statusCode).toBe(403);

    const stillDownloadable = await request(app)
      .get(`/api/documents/${deletableDocumentId}/download`)
      .set(auth(assignedAdvocateToken));
    expect(stillDownloadable.statusCode).toBe(200);
  });

  test('assigned advocate can soft-delete an accessible document', async () => {
    const deleted = await request(app)
      .delete(`/api/documents/${deletableDocumentId}`)
      .set(auth(assignedAdvocateToken));
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toEqual({ id: deletableDocumentId, deleted: true });
  });

  test('unlinked matterless document is denied by default', async () => {
    const download = await request(app)
      .get(`/api/documents/${orphanDocumentId}/download`)
      .set(auth(adminToken));
    expect(download.statusCode).toBe(403);

    const patch = await request(app)
      .patch(`/api/documents/${orphanDocumentId}`)
      .set(auth(adminToken))
      .send({ displayName: 'still-denied.pdf' });
    expect(patch.statusCode).toBe(403);

    const remove = await request(app)
      .delete(`/api/documents/${orphanDocumentId}`)
      .set(auth(adminToken));
    expect(remove.statusCode).toBe(403);
  });
});
