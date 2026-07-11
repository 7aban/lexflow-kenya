'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const sqlite3 = require('sqlite3');
const { PDFDocument } = require('pdf-lib');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(60000);

const auth = token => ({ Authorization: `Bearer ${token}` });

function withDb(databasePath, operation) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(databasePath);
    operation(db, (error, result) => {
      db.close(closeError => (error || closeError) ? reject(error || closeError) : resolve(result));
    });
  });
}

function dbRun(sql, params = [], databasePath = config.DATABASE_PATH) {
  return withDb(databasePath, (db, done) => db.run(sql, params, error => done(error)));
}

function dbGet(sql, params = [], databasePath = config.DATABASE_PATH) {
  return withDb(databasePath, (db, done) => db.get(sql, params, (error, row) => done(error, row)));
}

function dbAll(sql, params = [], databasePath = config.DATABASE_PATH) {
  return withDb(databasePath, (db, done) => db.all(sql, params, (error, rows) => done(error, rows)));
}

function removeTemporaryDatabase(databasePath) {
  for (const candidate of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
    fs.rmSync(candidate, { force: true });
  }
}

function initializeDatabaseInChild(databasePath) {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const script = `
    const { dbReady } = require(${JSON.stringify(serverPath)});
    dbReady.then(() => process.exit(0)).catch(error => {
      console.error(error);
      process.exit(1);
    });
  `;
  execFileSync(process.execPath, ['-e', script], {
    cwd: path.dirname(serverPath),
    env: { ...process.env, NODE_ENV: 'test', DATABASE_PATH: databasePath },
    stdio: 'pipe',
    timeout: 30000,
  });
}

describe('LOCAL-PILOT folder archive/restore foundation', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const activeListFolderId = `FOL-ACTIVE-LIST-${suffix}`;
  const archivedListFolderId = `FOL-ARCHIVED-LIST-${suffix}`;
  const inaccessibleActiveFolderId = `FOL-INACCESSIBLE-ACTIVE-${suffix}`;
  let adminToken;
  let assignedAdvocateToken;
  let unassignedAdvocateToken;
  let assistantToken;
  let clientToken;
  let clientId;
  let accessibleMatterId;
  let inaccessibleMatterId;
  let clientUploadsFolderId;
  let pdfData;

  async function login(email) {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'password123' });
    expect(response.statusCode).toBe(200);
    return response.body.token;
  }

  async function createFolder(token, matterId, name) {
    return request(app)
      .post(`/api/matters/${matterId}/folders`)
      .set(auth(token))
      .send({ name });
  }

  async function insertFolder({ id, matterId, name, archivedAt = null }) {
    await dbRun(
      'INSERT INTO folders (id,matterId,name,createdBy,createdAt,archivedAt) VALUES (?,?,?,?,?,?)',
      [id, matterId, name, 'folder-foundation-test', new Date().toISOString(), archivedAt],
    );
  }

  async function uploadPdf({ token = adminToken, matterId = accessibleMatterId, name, folderId, clientVisible = false }) {
    return request(app)
      .post(`/api/matters/${matterId}/documents`)
      .set(auth(token))
      .send({ name, mimeType: 'application/pdf', data: pdfData, folderId, clientVisible });
  }

  async function auditBoundary() {
    return (await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events')).rowid;
  }

  async function lifecycleEventsSince(boundary) {
    return dbAll(
      `SELECT rowid, * FROM audit_events
       WHERE rowid>? AND action IN ('folder_archived','folder_restored')
       ORDER BY rowid`,
      [boundary],
    );
  }

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('admin@lexflow.co.ke');
    assignedAdvocateToken = await login('sarah.mwangi@achokilaw.co.ke');
    unassignedAdvocateToken = await login('michael.oduor@achokilaw.co.ke');
    assistantToken = await login('david.wanjiku@achokilaw.co.ke');

    const clientEmail = `folder.foundation.${suffix}@example.com`;
    const clientResponse = await request(app)
      .post('/api/clients')
      .set(auth(adminToken))
      .send({ name: `Folder Foundation Client ${suffix}`, email: clientEmail });
    expect(clientResponse.statusCode).toBe(200);
    clientId = clientResponse.body.id;

    const registration = await request(app)
      .post('/api/auth/register')
      .set(auth(adminToken))
      .send({
        email: clientEmail,
        password: 'FolderFoundation!56',
        fullName: `Folder Foundation Client ${suffix}`,
        role: 'client',
        clientId,
      });
    expect(registration.statusCode).toBe(200);

    const clientLogin = await request(app)
      .post('/api/auth/client-login')
      .send({ email: clientEmail, password: 'FolderFoundation!56' });
    expect(clientLogin.statusCode).toBe(200);
    clientToken = clientLogin.body.token;

    const accessibleMatter = await request(app)
      .post('/api/matters')
      .set(auth(adminToken))
      .send({ clientId, title: `Folder Foundation Accessible ${suffix}`, assignedTo: 'Sarah Mwangi' });
    expect(accessibleMatter.statusCode).toBe(200);
    accessibleMatterId = accessibleMatter.body.id;

    const inaccessibleMatter = await request(app)
      .post('/api/matters')
      .set(auth(adminToken))
      .send({ clientId, title: `Folder Foundation Inaccessible ${suffix}`, assignedTo: 'Michael Oduor' });
    expect(inaccessibleMatter.statusCode).toBe(200);
    inaccessibleMatterId = inaccessibleMatter.body.id;

    await insertFolder({ id: activeListFolderId, matterId: accessibleMatterId, name: `Active List ${suffix}` });
    await insertFolder({ id: archivedListFolderId, matterId: accessibleMatterId, name: `Archived List ${suffix}`, archivedAt: '2026-07-10T08:00:00.000Z' });
    await insertFolder({ id: inaccessibleActiveFolderId, matterId: inaccessibleMatterId, name: `Inaccessible Active ${suffix}` });

    const clientUploads = await createFolder(adminToken, accessibleMatterId, 'cLiEnT UpLoAdS');
    expect(clientUploads.statusCode).toBe(200);
    clientUploadsFolderId = clientUploads.body.id;

    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    pdfData = Buffer.from(await pdf.save()).toString('base64');
  });

  test('isolated seeded schema includes archivedAt', async () => {
    const columns = await dbAll('PRAGMA table_info(folders)');
    expect(columns.map(column => column.name)).toContain('archivedAt');
    expect(columns.filter(column => column.name === 'archivedAt')).toHaveLength(1);
  });

  test('legacy folder schema initializes twice idempotently and gains archivedAt', async () => {
    const databasePath = path.join(os.tmpdir(), `lexflow-folder-legacy-${suffix}.sqlite`);
    removeTemporaryDatabase(databasePath);
    try {
      await dbRun('CREATE TABLE folders (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT NOT NULL, createdBy TEXT, createdAt TEXT)', [], databasePath);
      await dbRun(
        'INSERT INTO folders (id,matterId,name,createdBy,createdAt) VALUES (?,?,?,?,?)',
        ['FOL-LEGACY', 'MAT-LEGACY', 'Legacy Folder', 'legacy-user', '2026-07-09T00:00:00.000Z'],
        databasePath,
      );

      initializeDatabaseInChild(databasePath);
      initializeDatabaseInChild(databasePath);

      const columns = await dbAll('PRAGMA table_info(folders)', [], databasePath);
      expect(columns.filter(column => column.name === 'archivedAt')).toHaveLength(1);
      expect(await dbGet('SELECT id,matterId,name,createdBy,createdAt,archivedAt FROM folders WHERE id=?', ['FOL-LEGACY'], databasePath)).toEqual({
        id: 'FOL-LEGACY',
        matterId: 'MAT-LEGACY',
        name: 'Legacy Folder',
        createdBy: 'legacy-user',
        createdAt: '2026-07-09T00:00:00.000Z',
        archivedAt: null,
      });
    } finally {
      removeTemporaryDatabase(databasePath);
    }
  });

  test('active and archived folder lists are isolated with stable response shapes', async () => {
    const active = await request(app)
      .get(`/api/matters/${accessibleMatterId}/folders`)
      .set(auth(adminToken));
    expect(active.statusCode).toBe(200);
    expect(active.body.map(folder => folder.id)).toEqual(expect.arrayContaining(['all', 'uncategorised', activeListFolderId, clientUploadsFolderId]));
    expect(active.body.map(folder => folder.id)).not.toContain(archivedListFolderId);
    const activeRealFolder = active.body.find(folder => folder.id === activeListFolderId);
    expect(Object.keys(activeRealFolder).sort()).toEqual(['createdAt', 'createdBy', 'documentCount', 'id', 'matterId', 'name']);
    expect(active.body.every(folder => folder.archivedAt === undefined)).toBe(true);

    const archived = await request(app)
      .get(`/api/matters/${accessibleMatterId}/folders?status=archived`)
      .set(auth(adminToken));
    expect(archived.statusCode).toBe(200);
    const archivedIds = archived.body.map(folder => folder.id);
    expect(archivedIds).toContain(archivedListFolderId);
    expect(archivedIds).not.toContain('all');
    expect(archivedIds).not.toContain('uncategorised');
    expect(archivedIds).not.toContain(activeListFolderId);
    expect(archived.body.every(folder => Object.keys(folder).sort().join(',') === 'archivedAt,createdAt,createdBy,id,matterId,name')).toBe(true);
    expect(archived.body.every(folder => folder.archivedAt && folder.virtual === undefined)).toBe(true);

    const clientActive = await request(app)
      .get(`/api/matters/${accessibleMatterId}/folders`)
      .set(auth(clientToken));
    expect(clientActive.statusCode).toBe(200);
    expect(clientActive.body.map(folder => folder.id)).toEqual(['all', clientUploadsFolderId]);
    expect(clientActive.body.every(folder => folder.archivedAt === undefined)).toBe(true);

    for (const token of [clientToken, assistantToken, unassignedAdvocateToken]) {
      const denied = await request(app)
        .get(`/api/matters/${accessibleMatterId}/folders?status=archived`)
        .set(auth(token));
      expect(denied.statusCode).toBe(403);
    }

    const assignedAdvocate = await request(app)
      .get(`/api/matters/${accessibleMatterId}/folders?status=archived`)
      .set(auth(assignedAdvocateToken));
    expect(assignedAdvocate.statusCode).toBe(200);
    expect(assignedAdvocate.body.map(folder => folder.id)).toContain(archivedListFolderId);
  });

  test('admin archive and restore mutate only folder lifecycle state and emit structured events', async () => {
    const folderName = `Admin Lifecycle ${suffix}`;
    const folder = await createFolder(adminToken, accessibleMatterId, folderName);
    expect(folder.statusCode).toBe(200);

    const sharedDocument = await uploadPdf({ name: `shared-${suffix}.pdf`, folderId: folder.body.id, clientVisible: true });
    const internalDocument = await uploadPdf({ name: `internal-${suffix}.pdf`, folderId: folder.body.id });
    const archivedDocument = await uploadPdf({ name: `archived-${suffix}.pdf`, folderId: folder.body.id });
    expect(sharedDocument.statusCode).toBe(200);
    expect(internalDocument.statusCode).toBe(200);
    expect(archivedDocument.statusCode).toBe(200);

    const documentArchive = await request(app)
      .delete(`/api/documents/${archivedDocument.body.id}`)
      .set(auth(adminToken));
    expect(documentArchive.statusCode).toBe(200);

    const documentIds = [sharedDocument.body.id, internalDocument.body.id, archivedDocument.body.id];
    const beforeDocuments = await dbAll(
      `SELECT id,folderId,deletedAt,clientVisible FROM documents
       WHERE id IN (${documentIds.map(() => '?').join(',')}) ORDER BY id`,
      documentIds,
    );

    let boundary = await auditBoundary();
    const archived = await request(app)
      .patch(`/api/folders/${folder.body.id}/archive`)
      .set(auth(adminToken));
    expect(archived.statusCode).toBe(200);
    expect(Object.keys(archived.body).sort()).toEqual(['archivedAt', 'createdAt', 'createdBy', 'id', 'matterId', 'name']);
    expect(archived.body).toEqual({ ...folder.body, archivedAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(archived.body.archivedAt))).toBe(false);
    expect(await dbAll(
      `SELECT id,folderId,deletedAt,clientVisible FROM documents
       WHERE id IN (${documentIds.map(() => '?').join(',')}) ORDER BY id`,
      documentIds,
    )).toEqual(beforeDocuments);

    let events = await lifecycleEventsSince(boundary);
    expect(events).toHaveLength(1);
    expect([events[0].action, events[0].entity_type, events[0].entity_id, events[0].matter_id]).toEqual([
      'folder_archived', 'folder', folder.body.id, accessibleMatterId,
    ]);
    expect(JSON.parse(events[0].metadata_json)).toEqual({ folderName, matterId: accessibleMatterId });

    const activeFolders = await request(app).get(`/api/matters/${accessibleMatterId}/folders`).set(auth(adminToken));
    const archivedFolders = await request(app).get(`/api/matters/${accessibleMatterId}/folders?status=archived`).set(auth(adminToken));
    expect(activeFolders.body.map(row => row.id)).not.toContain(folder.body.id);
    expect(archivedFolders.body.find(row => row.id === folder.body.id)).toEqual(archived.body);

    const activeDocuments = await request(app).get(`/api/matters/${accessibleMatterId}/documents`).set(auth(adminToken));
    const archivedDocuments = await request(app).get(`/api/matters/${accessibleMatterId}/documents?status=archived`).set(auth(adminToken));
    expect(activeDocuments.body.map(row => row.id)).toEqual(expect.arrayContaining([sharedDocument.body.id, internalDocument.body.id]));
    expect(archivedDocuments.body.map(row => row.id)).toContain(archivedDocument.body.id);

    const clientDocuments = await request(app).get(`/api/matters/${accessibleMatterId}/documents`).set(auth(clientToken));
    expect(clientDocuments.body.map(row => row.id)).toContain(sharedDocument.body.id);
    expect(clientDocuments.body.map(row => row.id)).not.toContain(internalDocument.body.id);

    boundary = await auditBoundary();
    const restored = await request(app)
      .patch(`/api/folders/${folder.body.id}/restore`)
      .set(auth(adminToken));
    expect(restored.statusCode).toBe(200);
    expect(restored.body).toEqual({ ...folder.body, archivedAt: null });
    expect(await dbAll(
      `SELECT id,folderId,deletedAt,clientVisible FROM documents
       WHERE id IN (${documentIds.map(() => '?').join(',')}) ORDER BY id`,
      documentIds,
    )).toEqual(beforeDocuments);

    events = await lifecycleEventsSince(boundary);
    expect(events).toHaveLength(1);
    expect([events[0].action, events[0].entity_type, events[0].entity_id, events[0].matter_id]).toEqual([
      'folder_restored', 'folder', folder.body.id, accessibleMatterId,
    ]);
    expect(JSON.parse(events[0].metadata_json)).toEqual({ folderName, matterId: accessibleMatterId });
  });

  test('assigned advocate can archive and restore a custom folder on an accessible matter', async () => {
    const folder = await createFolder(adminToken, accessibleMatterId, `Advocate Lifecycle ${suffix}`);
    expect(folder.statusCode).toBe(200);
    const boundary = await auditBoundary();

    const archived = await request(app)
      .patch(`/api/folders/${folder.body.id}/archive`)
      .set(auth(assignedAdvocateToken));
    expect(archived.statusCode).toBe(200);
    expect(archived.body.archivedAt).toEqual(expect.any(String));

    const restored = await request(app)
      .patch(`/api/folders/${folder.body.id}/restore`)
      .set(auth(assignedAdvocateToken));
    expect(restored.statusCode).toBe(200);
    expect(restored.body.archivedAt).toBeNull();

    const events = await lifecycleEventsSince(boundary);
    expect(events.map(event => event.action)).toEqual(['folder_archived', 'folder_restored']);
    expect(events.every(event => event.entity_id === folder.body.id && event.matter_id === accessibleMatterId)).toBe(true);
  });

  test('assistant, client, and cross-matter advocate cannot archive or restore', async () => {
    const activeFolder = await createFolder(adminToken, accessibleMatterId, `Permission Active ${suffix}`);
    expect(activeFolder.statusCode).toBe(200);

    const archivedFolderId = `FOL-PERMISSION-ARCHIVED-${suffix}`;
    const inaccessibleArchivedFolderId = `FOL-PERMISSION-CROSS-ARCHIVED-${suffix}`;
    await insertFolder({ id: archivedFolderId, matterId: accessibleMatterId, name: `Permission Archived ${suffix}`, archivedAt: '2026-07-10T09:00:00.000Z' });
    await insertFolder({ id: inaccessibleArchivedFolderId, matterId: inaccessibleMatterId, name: `Permission Cross Archived ${suffix}`, archivedAt: '2026-07-10T09:00:00.000Z' });

    const attempts = [
      [assistantToken, activeFolder.body.id, 'archive'],
      [clientToken, activeFolder.body.id, 'archive'],
      [assistantToken, archivedFolderId, 'restore'],
      [clientToken, archivedFolderId, 'restore'],
      [assignedAdvocateToken, inaccessibleActiveFolderId, 'archive'],
      [assignedAdvocateToken, inaccessibleArchivedFolderId, 'restore'],
    ];
    for (const [token, folderId, action] of attempts) {
      const boundary = await auditBoundary();
      const response = await request(app)
        .patch(`/api/folders/${folderId}/${action}`)
        .set(auth(token));
      expect(response.statusCode).toBe(403);
      expect(await lifecycleEventsSince(boundary)).toEqual([]);
    }

    expect((await dbGet('SELECT archivedAt FROM folders WHERE id=?', [activeFolder.body.id])).archivedAt).toBeNull();
    expect((await dbGet('SELECT archivedAt FROM folders WHERE id=?', [archivedFolderId])).archivedAt).toBeTruthy();
    expect((await dbGet('SELECT archivedAt FROM folders WHERE id=?', [inaccessibleActiveFolderId])).archivedAt).toBeNull();
    expect((await dbGet('SELECT archivedAt FROM folders WHERE id=?', [inaccessibleArchivedFolderId])).archivedAt).toBeTruthy();
  });

  test('Client Uploads cannot be archived or restored', async () => {
    let boundary = await auditBoundary();
    const archived = await request(app)
      .patch(`/api/folders/${clientUploadsFolderId}/archive`)
      .set(auth(adminToken));
    expect(archived.statusCode).toBe(400);
    expect(archived.body).toEqual({ error: 'System folders cannot be archived' });
    expect(await lifecycleEventsSince(boundary)).toEqual([]);

    await dbRun('UPDATE folders SET archivedAt=? WHERE id=?', ['2026-07-10T10:00:00.000Z', clientUploadsFolderId]);
    try {
      boundary = await auditBoundary();
      const restored = await request(app)
        .patch(`/api/folders/${clientUploadsFolderId}/restore`)
        .set(auth(adminToken));
      expect(restored.statusCode).toBe(400);
      expect(restored.body).toEqual({ error: 'System folders cannot be restored' });
      expect(await lifecycleEventsSince(boundary)).toEqual([]);
    } finally {
      await dbRun('UPDATE folders SET archivedAt=NULL WHERE id=?', [clientUploadsFolderId]);
    }
  });

  test('invalid lifecycle state, missing folders, and virtual folder IDs emit no success event', async () => {
    const boundary = await auditBoundary();
    const alreadyArchived = await request(app)
      .patch(`/api/folders/${archivedListFolderId}/archive`)
      .set(auth(adminToken));
    expect(alreadyArchived.statusCode).toBe(400);
    expect(alreadyArchived.body).toEqual({ error: 'Folder is already archived' });

    const notArchived = await request(app)
      .patch(`/api/folders/${activeListFolderId}/restore`)
      .set(auth(adminToken));
    expect(notArchived.statusCode).toBe(400);
    expect(notArchived.body).toEqual({ error: 'Folder is not archived' });

    for (const [folderId, action] of [
      [`FOL-MISSING-${suffix}`, 'archive'],
      [`FOL-MISSING-${suffix}`, 'restore'],
      ['all', 'archive'],
      ['uncategorised', 'restore'],
    ]) {
      const response = await request(app)
        .patch(`/api/folders/${folderId}/${action}`)
        .set(auth(adminToken));
      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ error: 'Folder not found' });
    }
    expect(await lifecycleEventsSince(boundary)).toEqual([]);
  });

  test('duplicate checks include archived names and archived folders cannot be renamed or deleted', async () => {
    const archivedName = `Archived Duplicate ${suffix}`;
    const archivedFolderId = `FOL-DUPLICATE-ARCHIVED-${suffix}`;
    await insertFolder({ id: archivedFolderId, matterId: accessibleMatterId, name: archivedName, archivedAt: '2026-07-10T11:00:00.000Z' });

    const duplicateCreate = await createFolder(adminToken, accessibleMatterId, archivedName.toUpperCase());
    expect(duplicateCreate.statusCode).toBe(400);
    expect(duplicateCreate.body).toEqual({ error: 'Folder already exists for this matter' });

    const renameSource = await createFolder(adminToken, accessibleMatterId, `Rename Source ${suffix}`);
    expect(renameSource.statusCode).toBe(200);
    const duplicateRename = await request(app)
      .patch(`/api/folders/${renameSource.body.id}`)
      .set(auth(adminToken))
      .send({ name: archivedName.toLowerCase() });
    expect(duplicateRename.statusCode).toBe(400);
    expect(duplicateRename.body).toEqual({ error: 'Folder already exists for this matter' });

    const archivedRename = await request(app)
      .patch(`/api/folders/${archivedFolderId}`)
      .set(auth(adminToken))
      .send({ name: `Should Not Rename ${suffix}` });
    expect(archivedRename.statusCode).toBe(400);
    expect(archivedRename.body).toEqual({ error: 'Archived folders cannot be renamed' });

    const archivedDelete = await request(app)
      .delete(`/api/folders/${archivedFolderId}`)
      .set(auth(adminToken));
    expect(archivedDelete.statusCode).toBe(400);
    expect(archivedDelete.body).toEqual({ error: 'Archived folders must be restored before deletion' });
    expect(await dbGet('SELECT name,archivedAt FROM folders WHERE id=?', [archivedFolderId])).toEqual({
      name: archivedName,
      archivedAt: '2026-07-10T11:00:00.000Z',
    });
  });

  test('hard delete still works for empty active custom folders', async () => {
    const folder = await createFolder(adminToken, accessibleMatterId, `Empty Delete ${suffix}`);
    expect(folder.statusCode).toBe(200);
    const deleted = await request(app)
      .delete(`/api/folders/${folder.body.id}`)
      .set(auth(adminToken));
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toEqual({ id: folder.body.id, deleted: true });
    expect(await dbGet('SELECT id FROM folders WHERE id=?', [folder.body.id])).toBeUndefined();
  });

  test('hard delete counts archived documents when checking folder emptiness', async () => {
    const folder = await createFolder(adminToken, accessibleMatterId, `Archived Document Guard ${suffix}`);
    expect(folder.statusCode).toBe(200);
    const document = await uploadPdf({ name: `delete-guard-${suffix}.pdf`, folderId: folder.body.id });
    expect(document.statusCode).toBe(200);

    const archivedDocument = await request(app)
      .delete(`/api/documents/${document.body.id}`)
      .set(auth(adminToken));
    expect(archivedDocument.statusCode).toBe(200);
    expect((await dbGet('SELECT deletedAt FROM documents WHERE id=?', [document.body.id])).deletedAt).toBeTruthy();

    const deletedFolder = await request(app)
      .delete(`/api/folders/${folder.body.id}`)
      .set(auth(adminToken));
    expect(deletedFolder.statusCode).toBe(400);
    expect(deletedFolder.body).toEqual({ error: 'Folder must be empty before it can be deleted' });
    expect(await dbGet('SELECT id FROM folders WHERE id=?', [folder.body.id])).toEqual({ id: folder.body.id });
  });

  test('upload and document move reject archived folder targets', async () => {
    const beforeUploadCount = (await dbGet('SELECT COUNT(*) count FROM documents')).count;
    const rejectedUpload = await uploadPdf({ name: `archived-target-${suffix}.pdf`, folderId: archivedListFolderId });
    expect(rejectedUpload.statusCode).toBe(400);
    expect(rejectedUpload.body).toEqual({ error: 'Folder not found for this matter' });
    expect((await dbGet('SELECT COUNT(*) count FROM documents')).count).toBe(beforeUploadCount);

    const movable = await uploadPdf({ name: `move-source-${suffix}.pdf` });
    expect(movable.statusCode).toBe(200);
    const beforeMove = await dbGet('SELECT folderId FROM documents WHERE id=?', [movable.body.id]);
    const rejectedMove = await request(app)
      .patch(`/api/documents/${movable.body.id}`)
      .set(auth(adminToken))
      .send({ folderId: archivedListFolderId });
    expect(rejectedMove.statusCode).toBe(400);
    expect(rejectedMove.body).toEqual({ error: 'Folder not found for this matter' });
    expect(await dbGet('SELECT folderId FROM documents WHERE id=?', [movable.body.id])).toEqual(beforeMove);
  });

  test('merge-save rejects archived and cross-matter folder targets while accepting an active same-matter target', async () => {
    const sourceA = await uploadPdf({ name: `merge-source-a-${suffix}.pdf` });
    const sourceB = await uploadPdf({ name: `merge-source-b-${suffix}.pdf` });
    expect(sourceA.statusCode).toBe(200);
    expect(sourceB.statusCode).toBe(200);
    const documentIds = [sourceA.body.id, sourceB.body.id];

    let beforeCount = (await dbGet('SELECT COUNT(*) count FROM documents')).count;
    const archivedTarget = await request(app)
      .post('/api/document-tools/merge-pdfs/save')
      .set(auth(adminToken))
      .send({ matterId: accessibleMatterId, documentIds, filename: `archived-target-${suffix}.pdf`, folderId: archivedListFolderId });
    expect(archivedTarget.statusCode).toBe(400);
    expect(archivedTarget.body).toEqual({ error: 'Folder not found for this matter' });
    expect((await dbGet('SELECT COUNT(*) count FROM documents')).count).toBe(beforeCount);

    const crossMatterTarget = await request(app)
      .post('/api/document-tools/merge-pdfs/save')
      .set(auth(adminToken))
      .send({ matterId: accessibleMatterId, documentIds, filename: `cross-target-${suffix}.pdf`, folderId: inaccessibleActiveFolderId });
    expect(crossMatterTarget.statusCode).toBe(400);
    expect(crossMatterTarget.body).toEqual({ error: 'Folder not found for this matter' });
    expect((await dbGet('SELECT COUNT(*) count FROM documents')).count).toBe(beforeCount);

    const activeTarget = await request(app)
      .post('/api/document-tools/merge-pdfs/save')
      .set(auth(adminToken))
      .send({ matterId: accessibleMatterId, documentIds, filename: `active-target-${suffix}.pdf`, folderId: activeListFolderId });
    expect(activeTarget.statusCode).toBe(200);
    expect(activeTarget.body.folderId).toBe(activeListFolderId);
    beforeCount += 1;
    expect((await dbGet('SELECT COUNT(*) count FROM documents')).count).toBe(beforeCount);
  });
});
