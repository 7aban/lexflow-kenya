'use strict';

const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(30000);

const auth = token => ({ Authorization: `Bearer ${token}` });

describe('LOCAL-PILOT folder lifecycle structured audit', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const lifecycleActions = ['folder_created', 'folder_renamed', 'folder_deleted'];
  let adminToken;
  let assignedAdvocateToken;
  let unassignedAdvocateToken;
  let assistantToken;
  let clientToken;
  let clientId;
  let accessibleMatterId;
  let inaccessibleMatterId;
  const createdFolderIds = [];
  const createdDocumentIds = [];

  function withDb(operation) {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(config.DATABASE_PATH);
      operation(db, (error, result) => {
        db.close(closeError => (error || closeError) ? reject(error || closeError) : resolve(result));
      });
    });
  }

  function dbGet(sql, params = []) {
    return withDb((db, done) => db.get(sql, params, (error, row) => done(error, row)));
  }

  function dbAll(sql, params = []) {
    return withDb((db, done) => db.all(sql, params, (error, rows) => done(error, rows)));
  }

  function dbRun(sql, params = []) {
    return withDb((db, done) => db.run(sql, params, error => done(error)));
  }

  async function login(email) {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'password123' });
    expect(response.statusCode).toBe(200);
    return response.body.token;
  }

  async function auditBoundary() {
    const row = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    return row.rowid;
  }

  async function lifecycleEventsSince(boundary) {
    return dbAll(
      `SELECT rowid, * FROM audit_events
       WHERE rowid>? AND action IN (?,?,?)
       ORDER BY rowid`,
      [boundary, ...lifecycleActions],
    );
  }

  async function createFolder(token, matterId, name) {
    const response = await request(app)
      .post(`/api/matters/${matterId}/folders`)
      .set(auth(token))
      .send({ name });
    if (response.statusCode === 200) createdFolderIds.push(response.body.id);
    return response;
  }

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('admin@lexflow.co.ke');
    assignedAdvocateToken = await login('sarah.mwangi@achokilaw.co.ke');
    unassignedAdvocateToken = await login('michael.oduor@achokilaw.co.ke');
    assistantToken = await login('david.wanjiku@achokilaw.co.ke');

    const clientEmail = `folder.audit.${suffix}@example.com`;
    const clientResponse = await request(app)
      .post('/api/clients')
      .set(auth(adminToken))
      .send({ name: `Folder Audit Client ${suffix}`, email: clientEmail });
    expect(clientResponse.statusCode).toBe(200);
    clientId = clientResponse.body.id;

    const registration = await request(app)
      .post('/api/auth/register')
      .set(auth(adminToken))
      .send({
        email: clientEmail,
        password: 'FolderAudit!56',
        fullName: `Folder Audit Client ${suffix}`,
        role: 'client',
        clientId,
      });
    expect(registration.statusCode).toBe(200);

    const clientLogin = await request(app)
      .post('/api/auth/client-login')
      .send({ email: clientEmail, password: 'FolderAudit!56' });
    expect(clientLogin.statusCode).toBe(200);
    clientToken = clientLogin.body.token;

    const accessibleMatter = await request(app)
      .post('/api/matters')
      .set(auth(adminToken))
      .send({ clientId, title: `Folder Audit Accessible ${suffix}`, assignedTo: 'Sarah Mwangi' });
    expect(accessibleMatter.statusCode).toBe(200);
    accessibleMatterId = accessibleMatter.body.id;

    const inaccessibleMatter = await request(app)
      .post('/api/matters')
      .set(auth(adminToken))
      .send({ clientId, title: `Folder Audit Inaccessible ${suffix}`, assignedTo: 'Michael Oduor' });
    expect(inaccessibleMatter.statusCode).toBe(200);
    inaccessibleMatterId = inaccessibleMatter.body.id;
  });

  afterAll(async () => {
    if (createdDocumentIds.length) {
      await dbRun(`DELETE FROM documents WHERE id IN (${createdDocumentIds.map(() => '?').join(',')})`, createdDocumentIds);
    }
    if (createdFolderIds.length) {
      await dbRun(`DELETE FROM folders WHERE id IN (${createdFolderIds.map(() => '?').join(',')})`, createdFolderIds);
    }
  });

  test('admin create, rename, and delete preserve responses and emit safe structured events', async () => {
    const originalName = `Admin Folder ${suffix}`;
    const renamedName = `Admin Folder Renamed ${suffix}`;
    const boundary = await auditBoundary();

    const created = await createFolder(adminToken, accessibleMatterId, originalName);
    expect(created.statusCode).toBe(200);
    expect(Object.keys(created.body).sort()).toEqual(['createdAt', 'createdBy', 'id', 'matterId', 'name']);
    expect(created.body).toEqual({
      id: created.body.id,
      matterId: accessibleMatterId,
      name: originalName,
      createdBy: expect.any(String),
      createdAt: expect.any(String),
    });

    const renamed = await request(app)
      .patch(`/api/folders/${created.body.id}`)
      .set(auth(adminToken))
      .send({ name: renamedName });
    expect(renamed.statusCode).toBe(200);
    expect(Object.keys(renamed.body).sort()).toEqual(['createdAt', 'createdBy', 'id', 'matterId', 'name']);
    expect(renamed.body).toEqual({ ...created.body, name: renamedName });

    const deleted = await request(app)
      .delete(`/api/folders/${created.body.id}`)
      .set(auth(adminToken));
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toEqual({ id: created.body.id, deleted: true });

    const events = await lifecycleEventsSince(boundary);
    expect(events).toHaveLength(3);
    expect(events.map(event => [event.action, event.entity_type, event.entity_id, event.matter_id])).toEqual([
      ['folder_created', 'folder', created.body.id, accessibleMatterId],
      ['folder_renamed', 'folder', created.body.id, accessibleMatterId],
      ['folder_deleted', 'folder', created.body.id, accessibleMatterId],
    ]);
    expect(JSON.parse(events[0].metadata_json)).toEqual({ folderName: originalName, matterId: accessibleMatterId });
    expect(JSON.parse(events[1].metadata_json)).toEqual({ previousName: originalName, newName: renamedName, matterId: accessibleMatterId });
    expect(JSON.parse(events[2].metadata_json)).toEqual({ folderName: renamedName, matterId: accessibleMatterId });
  });

  test('assigned advocate can perform the audited lifecycle on an accessible matter', async () => {
    const originalName = `Advocate Folder ${suffix}`;
    const renamedName = `Advocate Folder Renamed ${suffix}`;
    const boundary = await auditBoundary();
    const created = await createFolder(assignedAdvocateToken, accessibleMatterId, originalName);
    expect(created.statusCode).toBe(200);

    const renamed = await request(app)
      .patch(`/api/folders/${created.body.id}`)
      .set(auth(assignedAdvocateToken))
      .send({ name: renamedName });
    expect(renamed.statusCode).toBe(200);

    const deleted = await request(app)
      .delete(`/api/folders/${created.body.id}`)
      .set(auth(assignedAdvocateToken));
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toEqual({ id: created.body.id, deleted: true });

    const events = await lifecycleEventsSince(boundary);
    expect(events.map(event => event.action)).toEqual(lifecycleActions);
    expect(events.every(event => event.entity_id === created.body.id && event.matter_id === accessibleMatterId)).toBe(true);
  });

  test('assistant, client, and cross-matter advocate rejection emit no lifecycle success event', async () => {
    for (const [token, matterId, expectedStatus] of [
      [assistantToken, accessibleMatterId, 403],
      [clientToken, accessibleMatterId, 403],
      [assignedAdvocateToken, inaccessibleMatterId, 403],
    ]) {
      const boundary = await auditBoundary();
      const response = await createFolder(token, matterId, `Rejected Folder ${suffix}-${boundary}`);
      expect(response.statusCode).toBe(expectedStatus);
      expect(await lifecycleEventsSince(boundary)).toEqual([]);
    }
  });

  test('duplicate and empty names, missing folders, and non-empty delete emit no lifecycle success event', async () => {
    const folder = await createFolder(adminToken, accessibleMatterId, `Guard Folder ${suffix}`);
    expect(folder.statusCode).toBe(200);

    let boundary = await auditBoundary();
    const duplicate = await createFolder(adminToken, accessibleMatterId, folder.body.name);
    expect(duplicate.statusCode).toBe(400);
    expect(await lifecycleEventsSince(boundary)).toEqual([]);

    boundary = await auditBoundary();
    const emptyRename = await request(app)
      .patch(`/api/folders/${folder.body.id}`)
      .set(auth(adminToken))
      .send({ name: '   ' });
    expect(emptyRename.statusCode).toBe(400);
    expect(await lifecycleEventsSince(boundary)).toEqual([]);

    boundary = await auditBoundary();
    const missing = await request(app)
      .delete(`/api/folders/FOL-MISSING-${suffix}`)
      .set(auth(adminToken));
    expect(missing.statusCode).toBe(404);
    expect(await lifecycleEventsSince(boundary)).toEqual([]);

    const document = await request(app)
      .post(`/api/matters/${accessibleMatterId}/documents`)
      .set(auth(adminToken))
      .send({
        name: `non-empty-${suffix}.pdf`,
        mimeType: 'application/pdf',
        data: Buffer.from('folder lifecycle non-empty guard').toString('base64'),
        folderId: folder.body.id,
      });
    expect(document.statusCode).toBe(200);
    createdDocumentIds.push(document.body.id);

    boundary = await auditBoundary();
    const nonEmptyDelete = await request(app)
      .delete(`/api/folders/${folder.body.id}`)
      .set(auth(adminToken));
    expect(nonEmptyDelete.statusCode).toBe(400);
    expect(nonEmptyDelete.body).toEqual({ error: 'Folder must be empty before it can be deleted' });
    expect(await lifecycleEventsSince(boundary)).toEqual([]);
  });
});
