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

describe('LOCAL-PILOT-NESTED-FOLDER-FOUNDATION-88', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let adminToken;
  let assignedAdvocateToken;
  let unassignedAdvocateToken;
  let assistantToken;
  let clientToken;
  let clientId;
  let accessibleMatterId;
  let inaccessibleMatterId;
  let pdfData;

  async function login(email, password = 'password123', route = '/api/auth/login') {
    const response = await request(app).post(route).send({ email, password });
    expect(response.statusCode).toBe(200);
    return response.body.token;
  }

  async function createFolder({
    token = adminToken,
    matterId = accessibleMatterId,
    name,
    parentId,
  }) {
    const body = { name };
    if (parentId !== undefined) body.parentId = parentId;
    return request(app)
      .post(`/api/matters/${matterId}/folders`)
      .set(auth(token))
      .send(body);
  }

  async function uploadPdf({
    token = adminToken,
    matterId = accessibleMatterId,
    name,
    folderId,
  }) {
    const body = { name, mimeType: 'application/pdf', data: pdfData };
    if (folderId !== undefined) body.folderId = folderId;
    return request(app)
      .post(`/api/matters/${matterId}/documents`)
      .set(auth(token))
      .send(body);
  }

  async function auditBoundary() {
    return (await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events')).rowid;
  }

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('admin@lexflow.co.ke');
    assignedAdvocateToken = await login('sarah.mwangi@achokilaw.co.ke');
    unassignedAdvocateToken = await login('michael.oduor@achokilaw.co.ke');
    assistantToken = await login('david.wanjiku@achokilaw.co.ke');

    const clientEmail = `nested.folder.${suffix}@example.com`;
    const client = await request(app)
      .post('/api/clients')
      .set(auth(adminToken))
      .send({ name: `Nested Folder Client ${suffix}`, email: clientEmail });
    expect(client.statusCode).toBe(200);
    clientId = client.body.id;

    const registration = await request(app)
      .post('/api/auth/register')
      .set(auth(adminToken))
      .send({
        email: clientEmail,
        password: 'NestedFolder!56',
        fullName: `Nested Folder Client ${suffix}`,
        role: 'client',
        clientId,
      });
    expect(registration.statusCode).toBe(200);
    clientToken = await login(clientEmail, 'NestedFolder!56', '/api/auth/client-login');

    const accessibleMatter = await request(app)
      .post('/api/matters')
      .set(auth(adminToken))
      .send({ clientId, title: `Nested Accessible ${suffix}`, assignedTo: 'Sarah Mwangi' });
    expect(accessibleMatter.statusCode).toBe(200);
    accessibleMatterId = accessibleMatter.body.id;

    const inaccessibleMatter = await request(app)
      .post('/api/matters')
      .set(auth(adminToken))
      .send({ clientId, title: `Nested Inaccessible ${suffix}`, assignedTo: 'Michael Oduor' });
    expect(inaccessibleMatter.statusCode).toBe(200);
    inaccessibleMatterId = inaccessibleMatter.body.id;

    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    pdfData = Buffer.from(await pdf.save()).toString('base64');
  });

  test('fresh schema and idempotent legacy migration add nullable parentId without rewriting folders or documents', async () => {
    const columns = await dbAll('PRAGMA table_info(folders)');
    expect(columns.filter(column => column.name === 'parentId')).toHaveLength(1);
    expect((await dbGet('SELECT COUNT(*) count FROM folders WHERE parentId IS NOT NULL')).count).toBe(0);
    expect(await dbAll('PRAGMA foreign_key_list(folders)')).toEqual([]);

    const databasePath = path.join(os.tmpdir(), `lexflow-nested-folder-legacy-${suffix}.sqlite`);
    removeTemporaryDatabase(databasePath);
    try {
      await dbRun(
        'CREATE TABLE folders (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT NOT NULL, createdBy TEXT, createdAt TEXT, archivedAt TEXT)',
        [],
        databasePath,
      );
      await dbRun(
        `CREATE TABLE documents (
          id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT, displayName TEXT, type TEXT, mimeType TEXT,
          date TEXT, size TEXT, content BLOB, source TEXT DEFAULT 'firm', folderId TEXT, messageId TEXT,
          noticeId TEXT, clientVisible INTEGER DEFAULT 0, uploadedBy TEXT, deletedAt TEXT, templateId TEXT,
          templateName TEXT, generatedBy TEXT, generatedAt TEXT, version INTEGER DEFAULT 1
        )`,
        [],
        databasePath,
      );
      await dbRun(
        'INSERT INTO folders (id,matterId,name,createdBy,createdAt,archivedAt) VALUES (?,?,?,?,?,NULL)',
        ['FOL-LEGACY-NESTED', 'MAT-LEGACY-NESTED', 'Legacy Root', 'legacy-user', '2026-07-12T00:00:00.000Z'],
        databasePath,
      );
      await dbRun(
        'INSERT INTO documents (id,matterId,name,folderId) VALUES (?,?,?,?)',
        ['DOC-LEGACY-NESTED', 'MAT-LEGACY-NESTED', 'legacy.pdf', 'FOL-LEGACY-NESTED'],
        databasePath,
      );

      initializeDatabaseInChild(databasePath);
      initializeDatabaseInChild(databasePath);

      const migratedColumns = await dbAll('PRAGMA table_info(folders)', [], databasePath);
      expect(migratedColumns.filter(column => column.name === 'parentId')).toHaveLength(1);
      expect(await dbGet(
        'SELECT id,matterId,name,parentId FROM folders WHERE id=?',
        ['FOL-LEGACY-NESTED'],
        databasePath,
      )).toEqual({
        id: 'FOL-LEGACY-NESTED',
        matterId: 'MAT-LEGACY-NESTED',
        name: 'Legacy Root',
        parentId: null,
      });
      expect(await dbGet(
        'SELECT id,matterId,name,folderId FROM documents WHERE id=?',
        ['DOC-LEGACY-NESTED'],
        databasePath,
      )).toEqual({
        id: 'DOC-LEGACY-NESTED',
        matterId: 'MAT-LEGACY-NESTED',
        name: 'legacy.pdf',
        folderId: 'FOL-LEGACY-NESTED',
      });
      const indexes = await dbAll("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_folders_matterId_parentId'", [], databasePath);
      expect(indexes).toHaveLength(1);
    } finally {
      removeTemporaryDatabase(databasePath);
    }
  });

  test('root, child, and grandchild creation stays flat with sibling uniqueness and direct document semantics', async () => {
    const root = await createFolder({ name: `Flat Root ${suffix}` });
    const child = await createFolder({ name: `Flat Child ${suffix}`, parentId: root.body.id });
    const grandchild = await createFolder({ name: `Flat Grandchild ${suffix}`, parentId: child.body.id });
    const secondRoot = await createFolder({ name: `Flat Second Root ${suffix}` });
    expect([root.statusCode, child.statusCode, grandchild.statusCode, secondRoot.statusCode]).toEqual([200, 200, 200, 200]);
    expect(root.body.parentId).toBeNull();
    expect(child.body.parentId).toBe(root.body.id);
    expect(grandchild.body.parentId).toBe(child.body.id);

    const duplicateSibling = await createFolder({ name: child.body.name.toUpperCase(), parentId: root.body.id });
    expect(duplicateSibling.statusCode).toBe(400);
    expect(duplicateSibling.body).toEqual({ error: 'Folder already exists for this matter' });

    const sameNameDifferentParent = await createFolder({ name: child.body.name, parentId: secondRoot.body.id });
    expect(sameNameDifferentParent.statusCode).toBe(200);
    expect(sameNameDifferentParent.body.parentId).toBe(secondRoot.body.id);

    const archivedSibling = await createFolder({ name: `Archived Sibling ${suffix}`, parentId: root.body.id });
    expect((await request(app).patch(`/api/folders/${archivedSibling.body.id}/archive`).set(auth(adminToken))).statusCode).toBe(200);
    const duplicateArchivedSibling = await createFolder({ name: archivedSibling.body.name.toUpperCase(), parentId: root.body.id });
    expect(duplicateArchivedSibling.statusCode).toBe(400);
    expect(duplicateArchivedSibling.body).toEqual({ error: 'Folder already exists for this matter' });

    const rootDocument = await uploadPdf({ name: `root-direct-${suffix}.pdf`, folderId: root.body.id });
    const childDocument = await uploadPdf({ name: `child-direct-${suffix}.pdf`, folderId: child.body.id });
    expect([rootDocument.statusCode, childDocument.statusCode]).toEqual([200, 200]);
    const beforeDocuments = await dbAll(
      'SELECT id,folderId FROM documents WHERE id IN (?,?) ORDER BY id',
      [rootDocument.body.id, childDocument.body.id],
    );

    const renamedGrandchild = await request(app)
      .patch(`/api/folders/${grandchild.body.id}`)
      .set(auth(adminToken))
      .send({ name: `Flat Grandchild Renamed ${suffix}`, parentId: root.body.id });
    expect(renamedGrandchild.statusCode).toBe(200);
    expect(renamedGrandchild.body.parentId).toBe(child.body.id);
    expect(await dbAll(
      'SELECT id,folderId FROM documents WHERE id IN (?,?) ORDER BY id',
      [rootDocument.body.id, childDocument.body.id],
    )).toEqual(beforeDocuments);

    const active = await request(app).get(`/api/matters/${accessibleMatterId}/folders`).set(auth(adminToken));
    expect(active.statusCode).toBe(200);
    expect(Array.isArray(active.body)).toBe(true);
    const activeById = new Map(active.body.map(folder => [folder.id, folder]));
    expect(activeById.get(root.body.id)).toMatchObject({ parentId: null, documentCount: 1 });
    expect(activeById.get(child.body.id)).toMatchObject({ parentId: root.body.id, documentCount: 1 });
    expect(activeById.get(grandchild.body.id)).toMatchObject({ parentId: child.body.id, documentCount: 0 });
    expect(active.body.filter(folder => !folder.virtual).every(folder => Object.hasOwn(folder, 'parentId') && folder.children === undefined)).toBe(true);
    expect(active.body.filter(folder => folder.virtual).every(folder => folder.parentId === undefined)).toBe(true);

    const archived = await request(app)
      .get(`/api/matters/${accessibleMatterId}/folders?status=archived`)
      .set(auth(adminToken));
    expect(archived.statusCode).toBe(200);
    expect(archived.body.find(folder => folder.id === archivedSibling.body.id)).toMatchObject({ parentId: root.body.id });
    expect(archived.body.every(folder => folder.children === undefined)).toBe(true);

    const rootFilter = await request(app)
      .get(`/api/matters/${accessibleMatterId}/documents?folderId=${root.body.id}`)
      .set(auth(adminToken));
    const childFilter = await request(app)
      .get(`/api/matters/${accessibleMatterId}/documents?folderId=${child.body.id}`)
      .set(auth(adminToken));
    expect(rootFilter.body.map(document => document.id)).toEqual([rootDocument.body.id]);
    expect(childFilter.body.map(document => document.id)).toEqual([childDocument.body.id]);
  });

  test('active same-matter ancestry, depth eight, virtual parents, and Client Uploads root protection are enforced', async () => {
    const depthRoot = await createFolder({ name: `Depth 1 ${suffix}` });
    expect(depthRoot.statusCode).toBe(200);
    let deepest = depthRoot;
    for (let depth = 2; depth <= 8; depth += 1) {
      deepest = await createFolder({ name: `Depth ${depth} ${suffix}`, parentId: deepest.body.id });
      expect(deepest.statusCode).toBe(200);
    }
    const tooDeep = await createFolder({ name: `Depth 9 ${suffix}`, parentId: deepest.body.id });
    expect(tooDeep.statusCode).toBe(400);
    expect(tooDeep.body).toEqual({ error: 'Folder hierarchy cannot exceed 8 levels' });

    const clientUploads = await createFolder({ name: 'cLiEnT UpLoAdS' });
    expect(clientUploads.statusCode).toBe(200);
    expect(clientUploads.body.parentId).toBeNull();
    const protectedChild = await createFolder({ name: `Forbidden Child ${suffix}`, parentId: clientUploads.body.id });
    expect(protectedChild.statusCode).toBe(400);
    expect(protectedChild.body).toEqual({ error: 'Client Uploads cannot contain child folders' });
    const nestedSystemName = await createFolder({ name: 'Client Uploads', parentId: depthRoot.body.id });
    expect(nestedSystemName.statusCode).toBe(400);
    expect(nestedSystemName.body).toEqual({ error: 'Client Uploads must remain a root folder' });

    for (const parentId of ['all', 'uncategorised']) {
      const virtualParent = await createFolder({ name: `Virtual ${parentId} ${suffix}`, parentId });
      expect(virtualParent.statusCode).toBe(400);
      expect(virtualParent.body).toEqual({ error: 'Parent folder not found for this matter' });
    }

    const archivedParent = await createFolder({ name: `Archived Parent ${suffix}` });
    expect((await request(app).patch(`/api/folders/${archivedParent.body.id}/archive`).set(auth(adminToken))).statusCode).toBe(200);
    const underArchivedParent = await createFolder({ name: `Under Archived ${suffix}`, parentId: archivedParent.body.id });
    expect(underArchivedParent.statusCode).toBe(400);
    expect(underArchivedParent.body).toEqual({ error: 'Parent folder not found for this matter' });

    const ancestor = await createFolder({ name: `Archived Ancestor ${suffix}` });
    const ancestorChild = await createFolder({ name: `Archived Ancestor Child ${suffix}`, parentId: ancestor.body.id });
    await dbRun('UPDATE folders SET archivedAt=? WHERE id=?', ['2026-07-13T08:00:00.000Z', ancestor.body.id]);
    const underArchivedAncestor = await createFolder({ name: `Under Archived Ancestor ${suffix}`, parentId: ancestorChild.body.id });
    expect(underArchivedAncestor.statusCode).toBe(400);
    expect(underArchivedAncestor.body).toEqual({ error: 'Parent folder not found for this matter' });
    await dbRun('UPDATE folders SET archivedAt=NULL WHERE id=?', [ancestor.body.id]);

    const crossMatterParent = await createFolder({ matterId: inaccessibleMatterId, name: `Cross Matter Parent ${suffix}` });
    expect(crossMatterParent.statusCode).toBe(200);
    const missingParent = await createFolder({ name: `Missing Parent Child ${suffix}`, parentId: `FOL-MISSING-${suffix}` });
    const crossMatter = await createFolder({ name: `Cross Matter Child ${suffix}`, parentId: crossMatterParent.body.id });
    expect(missingParent.statusCode).toBe(400);
    expect(crossMatter.statusCode).toBe(400);
    expect(crossMatter.body).toEqual(missingParent.body);
  });

  test('nested creation preserves advocate/admin permissions and generic cross-matter parent failures', async () => {
    const parent = await createFolder({ name: `Permission Parent ${suffix}` });
    const advocateChild = await createFolder({
      token: assignedAdvocateToken,
      name: `Advocate Child ${suffix}`,
      parentId: parent.body.id,
    });
    expect(advocateChild.statusCode).toBe(200);
    expect(advocateChild.body.parentId).toBe(parent.body.id);

    for (const [token, label] of [
      [assistantToken, 'assistant'],
      [clientToken, 'client'],
      [unassignedAdvocateToken, 'unassigned'],
    ]) {
      const denied = await createFolder({ token, name: `Denied ${label} ${suffix}`, parentId: parent.body.id });
      expect(denied.statusCode).toBe(403);
    }

    const inaccessibleParent = await createFolder({ matterId: inaccessibleMatterId, name: `Permission Cross Parent ${suffix}` });
    const advocateCrossParent = await createFolder({
      token: assignedAdvocateToken,
      name: `Permission Cross Child ${suffix}`,
      parentId: inaccessibleParent.body.id,
    });
    expect(advocateCrossParent.statusCode).toBe(400);
    expect(advocateCrossParent.body).toEqual({ error: 'Parent folder not found for this matter' });
  });

  test('active or archived children block parent archive/delete and child restore requires an active full parent chain', async () => {
    const parent = await createFolder({ name: `Lifecycle Parent ${suffix}` });
    const child = await createFolder({ name: `Lifecycle Child ${suffix}`, parentId: parent.body.id });

    const activeChildArchiveGuard = await request(app)
      .patch(`/api/folders/${parent.body.id}/archive`)
      .set(auth(adminToken));
    expect(activeChildArchiveGuard.statusCode).toBe(400);
    expect(activeChildArchiveGuard.body).toEqual({ error: 'Folder must not contain child folders before it can be archived' });
    const activeChildDeleteGuard = await request(app).delete(`/api/folders/${parent.body.id}`).set(auth(adminToken));
    expect(activeChildDeleteGuard.statusCode).toBe(400);
    expect(activeChildDeleteGuard.body).toEqual({ error: 'Folder must not contain child folders before it can be deleted' });

    const archivedChild = await request(app).patch(`/api/folders/${child.body.id}/archive`).set(auth(adminToken));
    expect(archivedChild.statusCode).toBe(200);
    expect((await request(app).patch(`/api/folders/${parent.body.id}/archive`).set(auth(adminToken))).body).toEqual({
      error: 'Folder must not contain child folders before it can be archived',
    });
    expect((await request(app).delete(`/api/folders/${parent.body.id}`).set(auth(adminToken))).body).toEqual({
      error: 'Folder must not contain child folders before it can be deleted',
    });

    await dbRun('UPDATE folders SET archivedAt=? WHERE id=?', ['2026-07-13T09:00:00.000Z', parent.body.id]);
    const blockedRestore = await request(app).patch(`/api/folders/${child.body.id}/restore`).set(auth(adminToken));
    expect(blockedRestore.statusCode).toBe(400);
    expect(blockedRestore.body).toEqual({ error: 'Parent folders must be active before this folder can be restored' });
    expect((await dbGet('SELECT archivedAt FROM folders WHERE id=?', [child.body.id])).archivedAt).toBeTruthy();

    expect((await request(app).patch(`/api/folders/${parent.body.id}/restore`).set(auth(adminToken))).statusCode).toBe(200);
    expect((await request(app).patch(`/api/folders/${child.body.id}/restore`).set(auth(adminToken))).statusCode).toBe(200);
    expect((await request(app).delete(`/api/folders/${child.body.id}`).set(auth(adminToken))).statusCode).toBe(200);
    expect((await request(app).patch(`/api/folders/${parent.body.id}/archive`).set(auth(adminToken))).statusCode).toBe(200);
    expect((await request(app).patch(`/api/folders/${parent.body.id}/restore`).set(auth(adminToken))).statusCode).toBe(200);
    expect((await request(app).delete(`/api/folders/${parent.body.id}`).set(auth(adminToken))).statusCode).toBe(200);
  });

  test('upload, move, and merge-save reject archived ancestors and preserve document rows through hierarchy lifecycle', async () => {
    const parent = await createFolder({ name: `Destination Parent ${suffix}` });
    const child = await createFolder({ name: `Destination Child ${suffix}`, parentId: parent.body.id });
    const firstSource = await uploadPdf({ name: `destination-source-a-${suffix}.pdf` });
    const secondSource = await uploadPdf({ name: `destination-source-b-${suffix}.pdf` });
    expect([firstSource.statusCode, secondSource.statusCode]).toEqual([200, 200]);
    const sourceIds = [firstSource.body.id, secondSource.body.id];

    await dbRun('UPDATE folders SET archivedAt=? WHERE id=?', ['2026-07-13T10:00:00.000Z', parent.body.id]);
    let documentCount = (await dbGet('SELECT COUNT(*) count FROM documents')).count;

    const rejectedUpload = await uploadPdf({ name: `rejected-ancestor-${suffix}.pdf`, folderId: child.body.id });
    expect(rejectedUpload.statusCode).toBe(400);
    expect(rejectedUpload.body).toEqual({ error: 'Folder not found for this matter' });
    expect((await dbGet('SELECT COUNT(*) count FROM documents')).count).toBe(documentCount);

    const beforeMove = await dbGet('SELECT folderId FROM documents WHERE id=?', [firstSource.body.id]);
    const rejectedMove = await request(app)
      .patch(`/api/documents/${firstSource.body.id}`)
      .set(auth(adminToken))
      .send({ folderId: child.body.id });
    expect(rejectedMove.statusCode).toBe(400);
    expect(rejectedMove.body).toEqual({ error: 'Folder not found for this matter' });
    expect(await dbGet('SELECT folderId FROM documents WHERE id=?', [firstSource.body.id])).toEqual(beforeMove);

    const rejectedMerge = await request(app)
      .post('/api/document-tools/merge-pdfs/save')
      .set(auth(adminToken))
      .send({ matterId: accessibleMatterId, documentIds: sourceIds, filename: `rejected-merge-${suffix}.pdf`, folderId: child.body.id });
    expect(rejectedMerge.statusCode).toBe(400);
    expect(rejectedMerge.body).toEqual({ error: 'Folder not found for this matter' });
    expect((await dbGet('SELECT COUNT(*) count FROM documents')).count).toBe(documentCount);

    expect((await request(app).patch(`/api/folders/${parent.body.id}/restore`).set(auth(adminToken))).statusCode).toBe(200);
    const acceptedUpload = await uploadPdf({ name: `accepted-ancestor-${suffix}.pdf`, folderId: child.body.id });
    const acceptedMove = await request(app)
      .patch(`/api/documents/${firstSource.body.id}`)
      .set(auth(adminToken))
      .send({ folderId: child.body.id });
    const acceptedMerge = await request(app)
      .post('/api/document-tools/merge-pdfs/save')
      .set(auth(adminToken))
      .send({ matterId: accessibleMatterId, documentIds: sourceIds, filename: `accepted-merge-${suffix}.pdf`, folderId: child.body.id });
    const directParentDocument = await uploadPdf({ name: `direct-parent-${suffix}.pdf`, folderId: parent.body.id });
    expect([acceptedUpload.statusCode, acceptedMove.statusCode, acceptedMerge.statusCode, directParentDocument.statusCode]).toEqual([200, 200, 200, 200]);
    documentCount += 3;
    expect((await dbGet('SELECT COUNT(*) count FROM documents')).count).toBe(documentCount);

    const activeFolders = await request(app).get(`/api/matters/${accessibleMatterId}/folders`).set(auth(adminToken));
    expect(activeFolders.body.find(folder => folder.id === parent.body.id).documentCount).toBe(1);
    expect(activeFolders.body.find(folder => folder.id === child.body.id).documentCount).toBe(3);

    const parentDocuments = await request(app)
      .get(`/api/matters/${accessibleMatterId}/documents?folderId=${parent.body.id}`)
      .set(auth(adminToken));
    const childDocuments = await request(app)
      .get(`/api/matters/${accessibleMatterId}/documents?folderId=${child.body.id}`)
      .set(auth(adminToken));
    expect(parentDocuments.body.map(document => document.id)).toEqual([directParentDocument.body.id]);
    expect(childDocuments.body.map(document => document.id).sort()).toEqual([
      firstSource.body.id,
      acceptedUpload.body.id,
      acceptedMerge.body.id,
    ].sort());

    const preservedIds = [firstSource.body.id, secondSource.body.id, acceptedUpload.body.id, acceptedMerge.body.id, directParentDocument.body.id];
    const beforeLifecycle = await dbAll(
      `SELECT id,folderId FROM documents WHERE id IN (${preservedIds.map(() => '?').join(',')}) ORDER BY id`,
      preservedIds,
    );
    expect((await request(app).patch(`/api/folders/${child.body.id}/archive`).set(auth(adminToken))).statusCode).toBe(200);
    expect(await dbAll(
      `SELECT id,folderId FROM documents WHERE id IN (${preservedIds.map(() => '?').join(',')}) ORDER BY id`,
      preservedIds,
    )).toEqual(beforeLifecycle);
    expect((await request(app).patch(`/api/folders/${child.body.id}/restore`).set(auth(adminToken))).statusCode).toBe(200);
    expect(await dbAll(
      `SELECT id,folderId FROM documents WHERE id IN (${preservedIds.map(() => '?').join(',')}) ORDER BY id`,
      preservedIds,
    )).toEqual(beforeLifecycle);
  });

  test('folder lifecycle responses and structured audit metadata include the stable parentId', async () => {
    const parent = await createFolder({ name: `Audit Parent ${suffix}` });
    const boundary = await auditBoundary();
    const child = await createFolder({ name: `Audit Child ${suffix}`, parentId: parent.body.id });
    expect(child.statusCode).toBe(200);
    expect(child.body.parentId).toBe(parent.body.id);

    const renamed = await request(app)
      .patch(`/api/folders/${child.body.id}`)
      .set(auth(adminToken))
      .send({ name: `Audit Child Renamed ${suffix}` });
    const archived = await request(app).patch(`/api/folders/${child.body.id}/archive`).set(auth(adminToken));
    const restored = await request(app).patch(`/api/folders/${child.body.id}/restore`).set(auth(adminToken));
    const deleted = await request(app).delete(`/api/folders/${child.body.id}`).set(auth(adminToken));
    expect([renamed.statusCode, archived.statusCode, restored.statusCode, deleted.statusCode]).toEqual([200, 200, 200, 200]);
    expect([renamed.body.parentId, archived.body.parentId, restored.body.parentId]).toEqual([
      parent.body.id,
      parent.body.id,
      parent.body.id,
    ]);

    const events = await dbAll(
      `SELECT action,metadata_json FROM audit_events
       WHERE rowid>? AND entity_id=? AND action IN ('folder_created','folder_renamed','folder_archived','folder_restored','folder_deleted')
       ORDER BY rowid`,
      [boundary, child.body.id],
    );
    expect(events.map(event => event.action)).toEqual([
      'folder_created',
      'folder_renamed',
      'folder_archived',
      'folder_restored',
      'folder_deleted',
    ]);
    expect(events.map(event => JSON.parse(event.metadata_json).parentId)).toEqual(Array(5).fill(parent.body.id));
  });
});
