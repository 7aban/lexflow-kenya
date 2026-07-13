'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const sqlite3 = require('sqlite3');

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-global-documents-explorer-'));
const databasePath = path.join(tempRoot, `explorer-${suffix}.sqlite`);
fs.closeSync(fs.openSync(databasePath, 'wx'));
const previousEnvironment = {
  DATABASE_PATH: process.env.DATABASE_PATH,
  JWT_SECRET: process.env.JWT_SECRET,
  SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL,
  SEED_ADMIN_NAME: process.env.SEED_ADMIN_NAME,
  SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD,
};

process.env.DATABASE_PATH = databasePath;
process.env.JWT_SECRET = `global-documents-explorer-test-secret-${suffix}`;
process.env.SEED_ADMIN_EMAIL = `explorer.admin.${suffix}@example.com`;
process.env.SEED_ADMIN_NAME = 'Explorer Admin';
process.env.SEED_ADMIN_PASSWORD = 'ExplorerAdmin!56';

const { app, dbReady } = require('../server.js');

jest.setTimeout(60000);

const auth = token => ({ Authorization: `Bearer ${token}` });
const staffPassword = 'ExplorerAccess!56';

function withDb(operation) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(databasePath);
    operation(db, (error, result) => {
      db.close(closeError => (error || closeError) ? reject(error || closeError) : resolve(result));
    });
  });
}

function dbRun(sql, params = []) {
  return withDb((db, done) => db.run(sql, params, error => done(error)));
}

function dbAll(sql, params = []) {
  return withDb((db, done) => db.all(sql, params, (error, rows) => done(error, rows)));
}

async function login(email, password = staffPassword, route = '/api/auth/login') {
  const response = await request(app).post(route).send({ email, password });
  expect(response.statusCode).toBe(200);
  return response.body;
}

describe('LOCAL-PILOT-GLOBAL-DOCUMENTS-EXPLORER-92', () => {
  const advocateOneEmail = `explorer.advocate.one.${suffix}@example.com`;
  const advocateTwoEmail = `explorer.advocate.two.${suffix}@example.com`;
  const assistantEmail = `explorer.assistant.${suffix}@example.com`;
  const clientEmail = `explorer.client.${suffix}@example.com`;

  let admin;
  let advocateOne;
  let advocateTwo;
  let assistant;
  let clientUser;
  let assignedClientId;
  let hiddenClientId;
  let assignedMatterId;
  let hiddenMatterId;
  let activeRootId;
  let activeChildId;
  let archivedRootId;
  let archivedChildId;
  let hiddenFolderId;
  let nestedDocumentId;
  let sharedDocumentId;
  let generatedDocumentId;
  let messageDocumentId;
  let clientUploadDocumentId;
  let archivedLocationDocumentId;
  let hiddenDocumentId;
  let archivedDocumentId;
  let matterlessNoticeDocumentId;
  let matterlessMessageDocumentId;
  let orphanDocumentId;

  async function registerUser(email, fullName, role, clientId = '') {
    const response = await request(app)
      .post('/api/auth/register')
      .set(auth(admin.token))
      .send({ email, password: staffPassword, fullName, role, clientId });
    expect(response.statusCode).toBe(200);
    return response.body;
  }

  async function createClient(name, email = '') {
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

  async function createFolder(matterId, name, parentId) {
    const body = { name };
    if (parentId !== undefined) body.parentId = parentId;
    const response = await request(app)
      .post(`/api/matters/${matterId}/folders`)
      .set(auth(admin.token))
      .send(body);
    expect(response.statusCode).toBe(200);
    return response.body.id;
  }

  async function uploadDocument({ matterId, name, folderId, clientVisible = false, token = admin.token }) {
    const body = {
      name,
      mimeType: 'application/pdf',
      data: Buffer.from(`GLOBAL-EXPLORER-CONTENT:${name}`).toString('base64'),
      clientVisible,
    };
    if (folderId) body.folderId = folderId;
    const response = await request(app)
      .post(`/api/matters/${matterId}/documents`)
      .set(auth(token))
      .send(body);
    expect(response.statusCode).toBe(200);
    return response.body.id;
  }

  async function insertDocument({
    id,
    matterId = '',
    name,
    source = 'firm',
    folderId = null,
    messageId = null,
    noticeId = null,
    clientVisible = 0,
    uploadedBy = '',
    templateName = null,
    generatedBy = null,
    generatedAt = null,
    version = 1,
    deletedAt = null,
    date = '2026-07-01',
  }) {
    await dbRun(`INSERT INTO documents (
        id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,
        clientVisible,uploadedBy,templateName,generatedBy,generatedAt,version,deletedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      id,
      matterId,
      name,
      name,
      'PDF',
      'application/pdf',
      date,
      '2 KB',
      Buffer.from(`NEVER-RETURN-CONTENT:${name}`),
      source,
      folderId,
      messageId,
      noticeId,
      clientVisible,
      uploadedBy,
      templateName,
      generatedBy,
      generatedAt,
      version,
      deletedAt,
    ]);
  }

  beforeAll(async () => {
    await dbReady;
    admin = await login(process.env.SEED_ADMIN_EMAIL, process.env.SEED_ADMIN_PASSWORD);

    await registerUser(advocateOneEmail, 'Advocate One', 'advocate');
    await registerUser(advocateTwoEmail, 'Advocate Two', 'advocate');
    await registerUser(assistantEmail, 'Explorer Assistant', 'assistant');

    assignedClientId = await createClient(`Assigned Explorer Client ${suffix}`, clientEmail);
    hiddenClientId = await createClient(`Hidden Explorer Client ${suffix}`, `hidden.${suffix}@example.com`);
    await registerUser(clientEmail, 'Explorer Client', 'client', assignedClientId);

    advocateOne = await login(advocateOneEmail);
    advocateTwo = await login(advocateTwoEmail);
    assistant = await login(assistantEmail);
    clientUser = await login(clientEmail, staffPassword, '/api/auth/client-login');

    assignedMatterId = await createMatter(assignedClientId, `Assigned Explorer Matter ${suffix}`, 'Advocate One');
    hiddenMatterId = await createMatter(hiddenClientId, `Hidden Explorer Matter ${suffix}`, 'Advocate Two');

    activeRootId = await createFolder(assignedMatterId, 'Case Files');
    activeChildId = await createFolder(assignedMatterId, '2026 Evidence', activeRootId);
    archivedRootId = await createFolder(assignedMatterId, 'Closed Cabinet');
    archivedChildId = await createFolder(assignedMatterId, 'Old Evidence', archivedRootId);
    hiddenFolderId = await createFolder(hiddenMatterId, 'Hidden Strategy Folder');

    nestedDocumentId = await uploadDocument({ matterId: assignedMatterId, name: 'chronology.pdf', folderId: activeChildId });
    sharedDocumentId = await uploadDocument({ matterId: assignedMatterId, name: 'client-share.pdf', clientVisible: true });
    generatedDocumentId = await uploadDocument({ matterId: assignedMatterId, name: 'generated-opinion.pdf', folderId: activeRootId });
    archivedLocationDocumentId = await uploadDocument({ matterId: assignedMatterId, name: 'historical-record.pdf', folderId: archivedChildId });
    hiddenDocumentId = await uploadDocument({ matterId: hiddenMatterId, name: 'zzzz-hidden-strategy.pdf', folderId: hiddenFolderId });
    archivedDocumentId = await uploadDocument({ matterId: assignedMatterId, name: 'archived-document.pdf' });
    clientUploadDocumentId = await uploadDocument({ matterId: assignedMatterId, name: 'client-upload.pdf', token: clientUser.token });

    const archiveFolder = await request(app)
      .patch(`/api/folders/${archivedChildId}/archive`)
      .set(auth(admin.token));
    expect(archiveFolder.statusCode).toBe(200);

    const archiveDocument = await request(app)
      .delete(`/api/documents/${archivedDocumentId}`)
      .set(auth(admin.token));
    expect(archiveDocument.statusCode).toBe(200);

    await dbRun(`UPDATE documents SET date=CASE id
      WHEN ? THEN '2026-07-10'
      WHEN ? THEN '2026-07-09'
      WHEN ? THEN '2026-07-08'
      WHEN ? THEN '2026-07-07'
      WHEN ? THEN '2026-07-06'
      WHEN ? THEN '2099-01-01'
      WHEN ? THEN '2026-07-05'
      ELSE date END`, [
      nestedDocumentId,
      sharedDocumentId,
      generatedDocumentId,
      archivedLocationDocumentId,
      clientUploadDocumentId,
      hiddenDocumentId,
      archivedDocumentId,
    ]);
    await dbRun(`UPDATE documents
      SET source='generated',templateName='Opinion Template',generatedBy='Explorer Admin',generatedAt='2026-07-08T12:00:00.000Z',version=2
      WHERE id=?`, [generatedDocumentId]);

    const conversationId = `CONV-EXPLORER-${suffix}`;
    const messageId = `MSG-EXPLORER-${suffix}`;
    await dbRun('INSERT INTO conversations (id,matterId,clientId,subject,createdAt) VALUES (?,?,?,?,?)', [conversationId, assignedMatterId, assignedClientId, 'Matter message', '2026-07-04T10:00:00.000Z']);
    await dbRun('INSERT INTO messages (id,conversationId,senderId,senderRole,body,createdAt) VALUES (?,?,?,?,?,?)', [messageId, conversationId, admin.user.id, 'admin', 'Message with attachment', '2026-07-04T10:00:00.000Z']);
    messageDocumentId = `DOC-MESSAGE-${suffix}`;
    await insertDocument({ id: messageDocumentId, matterId: assignedMatterId, name: 'message-attachment.pdf', messageId, uploadedBy: admin.user.id, date: '2026-07-04' });

    const matterlessNoticeId = `NOTICE-MATTERLESS-${suffix}`;
    matterlessNoticeDocumentId = `DOC-NOTICE-MATTERLESS-${suffix}`;
    await dbRun('INSERT INTO firm_notices (id,title,content,createdAt,createdBy,clientId) VALUES (?,?,?,?,?,?)', [matterlessNoticeId, 'Broadcast', 'Matterless notice', '2026-07-03T10:00:00.000Z', admin.user.id, '']);
    await insertDocument({ id: matterlessNoticeDocumentId, name: 'matterless-notice-secret.pdf', noticeId: matterlessNoticeId, clientVisible: 1, uploadedBy: admin.user.id, date: '2099-02-01' });

    const matterlessConversationId = `CONV-MATTERLESS-${suffix}`;
    const matterlessMessageId = `MSG-MATTERLESS-${suffix}`;
    matterlessMessageDocumentId = `DOC-MESSAGE-MATTERLESS-${suffix}`;
    await dbRun('INSERT INTO conversations (id,matterId,clientId,subject,createdAt) VALUES (?,?,?,?,?)', [matterlessConversationId, '', assignedClientId, 'Matterless conversation', '2026-07-03T10:00:00.000Z']);
    await dbRun('INSERT INTO messages (id,conversationId,senderId,senderRole,body,createdAt) VALUES (?,?,?,?,?,?)', [matterlessMessageId, matterlessConversationId, admin.user.id, 'admin', 'Matterless message', '2026-07-03T10:00:00.000Z']);
    await insertDocument({ id: matterlessMessageDocumentId, name: 'matterless-message-secret.pdf', messageId: matterlessMessageId, uploadedBy: admin.user.id, date: '2099-03-01' });

    orphanDocumentId = `DOC-ORPHAN-${suffix}`;
    await insertDocument({ id: orphanDocumentId, name: 'matterless-orphan-secret.pdf', uploadedBy: admin.user.id, date: '2099-04-01' });
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('enforces the staff role matrix and matter scope before pagination without returning unsafe metadata', async () => {
    const unauthenticated = await request(app).get('/api/documents');
    expect(unauthenticated.statusCode).toBe(401);

    const clientDenied = await request(app).get('/api/documents').set(auth(clientUser.token));
    expect(clientDenied.statusCode).toBe(403);
    expect(clientDenied.body).toEqual({ error: 'Staff access required' });

    const adminList = await request(app).get('/api/documents?limit=100').set(auth(admin.token));
    expect(adminList.statusCode).toBe(200);
    const adminIds = adminList.body.items.map(item => item.id);
    expect(adminIds).toEqual(expect.arrayContaining([nestedDocumentId, hiddenDocumentId, messageDocumentId]));
    expect(adminIds).not.toEqual(expect.arrayContaining([
      archivedDocumentId,
      matterlessNoticeDocumentId,
      matterlessMessageDocumentId,
      orphanDocumentId,
    ]));

    const advocateList = await request(app).get('/api/documents?limit=1').set(auth(advocateOne.token));
    expect(advocateList.statusCode).toBe(200);
    expect(advocateList.body.items).toHaveLength(1);
    expect(advocateList.body.items[0].matter.id).toBe(assignedMatterId);
    expect(advocateList.body.items[0].id).not.toBe(hiddenDocumentId);

    const advocateTwoList = await request(app).get('/api/documents?limit=100').set(auth(advocateTwo.token));
    expect(advocateTwoList.statusCode).toBe(200);
    expect(advocateTwoList.body.items.map(item => item.id)).toEqual([hiddenDocumentId]);

    const assistantList = await request(app).get('/api/documents?limit=100').set(auth(assistant.token));
    expect(assistantList.statusCode).toBe(200);
    expect(assistantList.body.items.map(item => item.id)).toEqual(expect.arrayContaining([nestedDocumentId, hiddenDocumentId]));

    for (const item of adminList.body.items) {
      expect(item.matter.id).toBeTruthy();
      expect(item).not.toHaveProperty('content');
      expect(item).not.toHaveProperty('uploadedBy');
      expect(item).not.toHaveProperty('messageId');
      expect(item).not.toHaveProperty('noticeId');
      expect(JSON.stringify(item)).not.toContain('NEVER-RETURN-CONTENT');
    }
    expect(adminList.body).not.toHaveProperty('total');
    expect(adminList.body).not.toHaveProperty('count');
    expect(adminList.body).not.toHaveProperty('facets');
  });

  test('prevents row, search, filter, archived-path, and cursor metadata leakage', async () => {
    const hiddenSearch = await request(app)
      .get('/api/documents?q=zzzz-hidden-strategy')
      .set(auth(advocateOne.token));
    expect(hiddenSearch.statusCode).toBe(200);
    expect(hiddenSearch.body.items).toEqual([]);

    for (const query of [
      `matterId=${encodeURIComponent(hiddenMatterId)}`,
      `clientId=${encodeURIComponent(hiddenClientId)}`,
      `folderId=${encodeURIComponent(hiddenFolderId)}`,
    ]) {
      const response = await request(app).get(`/api/documents?${query}`).set(auth(advocateOne.token));
      expect(response.statusCode).toBe(200);
      expect(response.body.items).toEqual([]);
    }

    const assistantArchivedSearch = await request(app)
      .get('/api/documents?q=Old%20Evidence')
      .set(auth(assistant.token));
    expect(assistantArchivedSearch.statusCode).toBe(200);
    expect(assistantArchivedSearch.body.items).toEqual([]);

    const assistantArchivedFilter = await request(app)
      .get(`/api/documents?folderId=${encodeURIComponent(archivedChildId)}`)
      .set(auth(assistant.token));
    expect(assistantArchivedFilter.statusCode).toBe(200);
    expect(assistantArchivedFilter.body.items).toEqual([]);

    const firstPage = await request(app)
      .get('/api/documents?limit=1&sort=name_asc')
      .set(auth(advocateOne.token));
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.body.nextCursor).toBeTruthy();
    const cursorPayload = JSON.parse(Buffer.from(firstPage.body.nextCursor.split('.')[0], 'base64url').toString('utf8'));
    expect(Object.keys(cursorPayload).sort()).toEqual(['id', 'key', 'scope', 'sort', 'v'].sort());
    expect(JSON.stringify(cursorPayload)).not.toContain('Hidden Explorer');
    expect(JSON.stringify(cursorPayload)).not.toContain(hiddenMatterId);
    expect(JSON.stringify(cursorPayload)).not.toContain(hiddenClientId);

    const cursorAcrossFilters = await request(app)
      .get(`/api/documents?limit=1&sort=name_asc&type=pdf&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set(auth(advocateOne.token));
    expect(cursorAcrossFilters.statusCode).toBe(400);
    expect(cursorAcrossFilters.body).toEqual({ error: 'Invalid cursor' });

    const tampered = `${firstPage.body.nextCursor.slice(0, -1)}${firstPage.body.nextCursor.endsWith('a') ? 'b' : 'a'}`;
    const tamperedCursor = await request(app)
      .get(`/api/documents?limit=1&sort=name_asc&cursor=${encodeURIComponent(tampered)}`)
      .set(auth(advocateOne.token));
    expect(tamperedCursor.statusCode).toBe(400);
    expect(tamperedCursor.body).toEqual({ error: 'Invalid cursor' });
  });

  test('reconstructs nested paths, classifies origin and visibility, and redacts archived locations for assistants', async () => {
    const nestedSearch = await request(app)
      .get('/api/documents?q=Case%20Files&limit=100')
      .set(auth(admin.token));
    expect(nestedSearch.statusCode).toBe(200);
    const nested = nestedSearch.body.items.find(item => item.id === nestedDocumentId);
    expect(nested).toMatchObject({
      folder: { id: activeChildId, name: '2026 Evidence', archived: false },
      folderPathLabel: 'Case Files / 2026 Evidence',
      location: { status: 'active', folderArchived: false, pathIncomplete: false },
      uploaderDisplay: 'Explorer Admin',
      visibility: 'internal',
      origin: 'firm',
      archived: false,
      archivedAt: null,
    });
    expect(nested.folderPath.map(folder => folder.id)).toEqual([activeRootId, activeChildId]);

    const adminArchivedLocation = await request(app)
      .get('/api/documents?q=historical-record')
      .set(auth(admin.token));
    const archivedLocation = adminArchivedLocation.body.items.find(item => item.id === archivedLocationDocumentId);
    expect(archivedLocation.folderPathLabel).toBe('Closed Cabinet / Old Evidence');
    expect(archivedLocation.location).toEqual({ status: 'archived', folderArchived: true, pathIncomplete: false });
    expect(archivedLocation.folder).toEqual({ id: archivedChildId, name: 'Old Evidence', archived: true });

    const assistantArchivedLocation = await request(app)
      .get('/api/documents?q=historical-record')
      .set(auth(assistant.token));
    const redactedLocation = assistantArchivedLocation.body.items.find(item => item.id === archivedLocationDocumentId);
    expect(redactedLocation.folder).toBeNull();
    expect(redactedLocation.folderPath).toEqual([]);
    expect(redactedLocation.folderPathLabel).toBe('Archived location');
    expect(redactedLocation.location).toEqual({ status: 'archived_hidden', folderArchived: true, pathIncomplete: false });
    expect(JSON.stringify(redactedLocation)).not.toContain('Old Evidence');
    expect(JSON.stringify(redactedLocation)).not.toContain(archivedChildId);

    const generated = (await request(app).get('/api/documents?source=generated').set(auth(admin.token))).body.items;
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({
      id: generatedDocumentId,
      source: 'generated',
      origin: 'generated',
      uploaderDisplay: 'Explorer Admin',
      generation: {
        templateName: 'Opinion Template',
        generatedBy: 'Explorer Admin',
        generatedAt: '2026-07-08T12:00:00.000Z',
        version: 2,
      },
    });

    const messages = (await request(app).get('/api/documents?origin=message').set(auth(admin.token))).body.items;
    expect(messages.map(item => item.id)).toEqual([messageDocumentId]);
    expect(messages[0].visibility).toBe('client');
    const clientVisible = (await request(app).get('/api/documents?visibility=client&limit=100').set(auth(admin.token))).body.items.map(item => item.id);
    expect(clientVisible).toEqual(expect.arrayContaining([sharedDocumentId, clientUploadDocumentId, messageDocumentId]));
  });

  test('provides stable bounded cursor pagination and rejects unsafe query values', async () => {
    const complete = await request(app)
      .get('/api/documents?sort=name_asc&limit=100')
      .set(auth(advocateOne.token));
    expect(complete.statusCode).toBe(200);
    const expectedIds = complete.body.items.map(item => item.id);
    expect(expectedIds.length).toBeGreaterThan(3);

    const pagedIds = [];
    let cursor = '';
    for (let page = 0; page < 20; page += 1) {
      const suffixQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const response = await request(app)
        .get(`/api/documents?sort=name_asc&limit=2${suffixQuery}`)
        .set(auth(advocateOne.token));
      expect(response.statusCode).toBe(200);
      pagedIds.push(...response.body.items.map(item => item.id));
      if (!response.body.hasMore) {
        expect(response.body.nextCursor).toBeNull();
        break;
      }
      expect(response.body.nextCursor).toBeTruthy();
      cursor = response.body.nextCursor;
    }
    expect(pagedIds).toEqual(expectedIds);
    expect(new Set(pagedIds).size).toBe(pagedIds.length);

    const bounded = await request(app).get('/api/documents?limit=999').set(auth(admin.token));
    expect(bounded.statusCode).toBe(200);
    expect(bounded.body.limit).toBe(100);

    for (const query of [
      'sort=date_desc%20DROP%20TABLE%20documents',
      'type=executable',
      'source=unknown',
      'origin=unknown',
      'visibility=everyone',
      'status=archived',
      'limit=not-a-number',
    ]) {
      const response = await request(app).get(`/api/documents?${query}`).set(auth(admin.token));
      expect(response.statusCode).toBe(400);
    }

    const escapedWildcard = await request(app).get('/api/documents?q=%25').set(auth(admin.token));
    expect(escapedWildcard.statusCode).toBe(200);
    expect(escapedWildcard.body.items).toEqual([]);
  });

  test('reuses existing download authorization and audit behavior', async () => {
    for (const token of [admin.token, advocateOne.token, assistant.token]) {
      const response = await request(app)
        .get(`/api/documents/${nestedDocumentId}/download`)
        .set(auth(token));
      expect(response.statusCode).toBe(200);
      expect(response.text || response.body).toBeTruthy();
    }

    const unassignedDenied = await request(app)
      .get(`/api/documents/${nestedDocumentId}/download`)
      .set(auth(advocateTwo.token));
    expect(unassignedDenied.statusCode).toBe(403);

    const clientDenied = await request(app)
      .get(`/api/documents/${nestedDocumentId}/download`)
      .set(auth(clientUser.token));
    expect(clientDenied.statusCode).toBe(403);

    const actions = await dbAll('SELECT action FROM audit_events WHERE entity_id=?', [nestedDocumentId]);
    expect(actions.filter(row => row.action === 'document_accessed').length).toBeGreaterThanOrEqual(3);
    expect(actions.filter(row => row.action === 'document_downloaded').length).toBeGreaterThanOrEqual(3);
  });
});
