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

describe('LOCAL-PILOT-GLOBAL-DOCUMENTS-EXPLORER-92 / GLOBAL-DOCUMENT-ACTIONS-94', () => {
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
  let archivedNestedDocumentId;
  let tieDocumentOneId;
  let tieDocumentTwoId;
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
    archivedNestedDocumentId = await uploadDocument({ matterId: assignedMatterId, name: 'archived-nested-document.pdf', folderId: archivedChildId });
    clientUploadDocumentId = await uploadDocument({ matterId: assignedMatterId, name: 'client-upload.pdf', token: clientUser.token });

    const archiveFolder = await request(app)
      .patch(`/api/folders/${archivedChildId}/archive`)
      .set(auth(admin.token));
    expect(archiveFolder.statusCode).toBe(200);

    const archiveDocument = await request(app)
      .delete(`/api/documents/${archivedDocumentId}`)
      .set(auth(admin.token));
    expect(archiveDocument.statusCode).toBe(200);
    const archiveNestedDocument = await request(app)
      .delete(`/api/documents/${archivedNestedDocumentId}`)
      .set(auth(admin.token));
    expect(archiveNestedDocument.statusCode).toBe(200);

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
      SET source='generated',type='Word',mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document',templateName='Opinion Template',generatedBy='Explorer Admin',generatedAt='2026-07-08T12:00:00.000Z',version=2
      WHERE id=?`, [generatedDocumentId]);

    tieDocumentOneId = `DOC-TIE-A-${suffix}`;
    tieDocumentTwoId = `DOC-TIE-B-${suffix}`;
    await insertDocument({ id: tieDocumentOneId, matterId: assignedMatterId, name: 'same-name.pdf', uploadedBy: admin.user.id, date: '2026-07-02' });
    await insertDocument({ id: tieDocumentTwoId, matterId: assignedMatterId, name: 'same-name.pdf', uploadedBy: admin.user.id, date: '2026-07-02' });

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

  test('returns count-free filter options from the same document and role scope', async () => {
    const assignedOptions = await request(app)
      .get('/api/documents?limit=1')
      .set(auth(advocateOne.token));
    expect(assignedOptions.statusCode).toBe(200);
    expect(assignedOptions.body.filterOptions.clients).toEqual([
      expect.objectContaining({ id: assignedClientId }),
    ]);
    expect(assignedOptions.body.filterOptions.matters).toEqual([
      expect.objectContaining({ id: assignedMatterId, clientId: assignedClientId }),
    ]);
    expect(assignedOptions.body.filterOptions.types).toEqual(expect.arrayContaining([
      { value: 'pdf', label: 'PDF' },
      { value: 'word', label: 'Word' },
    ]));
    expect(assignedOptions.body.filterOptions.origins).toEqual(expect.arrayContaining([
      { value: 'firm', label: 'Firm upload' },
      { value: 'client', label: 'Client upload' },
      { value: 'generated', label: 'Generated' },
      { value: 'message', label: 'Message attachment' },
    ]));
    const assignedMetadata = JSON.stringify(assignedOptions.body.filterOptions);
    expect(assignedMetadata).not.toContain(hiddenMatterId);
    expect(assignedMetadata).not.toContain(hiddenClientId);
    expect(assignedMetadata).not.toContain('Hidden Explorer');
    expect(assignedMetadata).not.toContain(hiddenFolderId);
    expect(assignedOptions.body.filterOptions).not.toHaveProperty('folders');
    expect(assignedOptions.body.filterOptions).not.toHaveProperty('counts');

    const hiddenOptions = await request(app)
      .get('/api/documents?limit=1')
      .set(auth(advocateTwo.token));
    expect(hiddenOptions.statusCode).toBe(200);
    expect(hiddenOptions.body.filterOptions.clients.map(option => option.id)).toEqual([hiddenClientId]);
    expect(hiddenOptions.body.filterOptions.matters.map(option => option.id)).toEqual([hiddenMatterId]);
    expect(JSON.stringify(hiddenOptions.body.filterOptions)).not.toContain(assignedMatterId);

    const assistantOptions = await request(app)
      .get('/api/documents?limit=1')
      .set(auth(assistant.token));
    expect(assistantOptions.statusCode).toBe(200);
    expect(assistantOptions.body.filterOptions.clients.map(option => option.id)).toEqual(expect.arrayContaining([assignedClientId, hiddenClientId]));
    expect(assistantOptions.body.filterOptions.matters.map(option => option.id)).toEqual(expect.arrayContaining([assignedMatterId, hiddenMatterId]));
    expect(JSON.stringify(assistantOptions.body.filterOptions)).not.toContain('Old Evidence');
    expect(JSON.stringify(assistantOptions.body.filterOptions)).not.toContain(archivedChildId);
  });

  test('applies client, matter, type, source, origin, and visibility filters within scope', async () => {
    const byClient = await request(app)
      .get(`/api/documents?clientId=${encodeURIComponent(assignedClientId)}&limit=100`)
      .set(auth(admin.token));
    expect(byClient.statusCode).toBe(200);
    expect(byClient.body.items.length).toBeGreaterThan(0);
    expect(byClient.body.items.every(item => item.client?.id === assignedClientId)).toBe(true);
    expect(byClient.body.items.map(item => item.id)).not.toContain(hiddenDocumentId);

    const byMatter = await request(app)
      .get(`/api/documents?matterId=${encodeURIComponent(assignedMatterId)}&limit=100`)
      .set(auth(admin.token));
    expect(byMatter.statusCode).toBe(200);
    expect(byMatter.body.items.every(item => item.matter.id === assignedMatterId)).toBe(true);

    const byType = await request(app).get('/api/documents?type=word&limit=100').set(auth(admin.token));
    expect(byType.statusCode).toBe(200);
    expect(byType.body.items.map(item => item.id)).toEqual([generatedDocumentId]);

    const bySource = await request(app).get('/api/documents?source=generated&limit=100').set(auth(admin.token));
    expect(bySource.statusCode).toBe(200);
    expect(bySource.body.items.map(item => item.id)).toEqual([generatedDocumentId]);

    const byOrigin = await request(app).get('/api/documents?origin=message&limit=100').set(auth(admin.token));
    expect(byOrigin.statusCode).toBe(200);
    expect(byOrigin.body.items.map(item => item.id)).toEqual([messageDocumentId]);

    const clientVisible = await request(app).get('/api/documents?visibility=client&limit=100').set(auth(admin.token));
    expect(clientVisible.statusCode).toBe(200);
    expect(clientVisible.body.items.map(item => item.id)).toEqual(expect.arrayContaining([sharedDocumentId, clientUploadDocumentId, messageDocumentId]));
    expect(clientVisible.body.items.every(item => item.visibility === 'client')).toBe(true);

    const internal = await request(app).get('/api/documents?visibility=internal&limit=100').set(auth(admin.token));
    expect(internal.statusCode).toBe(200);
    expect(internal.body.items.every(item => item.visibility === 'internal')).toBe(true);
  });

  test('allows archived opt-in only for admins and assigned advocates without enabling file access', async () => {
    const adminArchived = await request(app)
      .get('/api/documents?status=archived&limit=100')
      .set(auth(admin.token));
    expect(adminArchived.statusCode).toBe(200);
    expect(adminArchived.body.status).toBe('archived');
    expect(adminArchived.body.items.map(item => item.id)).toEqual(expect.arrayContaining([archivedDocumentId, archivedNestedDocumentId]));
    expect(adminArchived.body.items.every(item => item.archived && item.archivedAt)).toBe(true);
    const nestedArchived = adminArchived.body.items.find(item => item.id === archivedNestedDocumentId);
    expect(nestedArchived).toMatchObject({
      folder: { id: archivedChildId, name: 'Old Evidence', archived: true },
      folderPathLabel: 'Closed Cabinet / Old Evidence',
      location: { status: 'archived', folderArchived: true, pathIncomplete: false },
    });

    const adminAll = await request(app).get('/api/documents?status=all&limit=100').set(auth(admin.token));
    expect(adminAll.statusCode).toBe(200);
    expect(adminAll.body.items.map(item => item.id)).toEqual(expect.arrayContaining([nestedDocumentId, archivedDocumentId, archivedNestedDocumentId]));
    expect(adminAll.body.filterOptions.matters.map(option => option.id)).toEqual(expect.arrayContaining([assignedMatterId, hiddenMatterId]));

    const assignedAdvocateArchived = await request(app)
      .get('/api/documents?status=archived&limit=100')
      .set(auth(advocateOne.token));
    expect(assignedAdvocateArchived.statusCode).toBe(200);
    expect(assignedAdvocateArchived.body.items.map(item => item.id)).toEqual(expect.arrayContaining([archivedDocumentId, archivedNestedDocumentId]));
    expect(assignedAdvocateArchived.body.items.every(item => item.matter.id === assignedMatterId)).toBe(true);

    const unassignedAdvocateArchived = await request(app)
      .get('/api/documents?status=archived&limit=100')
      .set(auth(advocateTwo.token));
    expect(unassignedAdvocateArchived.statusCode).toBe(200);
    expect(unassignedAdvocateArchived.body.items).toEqual([]);
    expect(unassignedAdvocateArchived.body.filterOptions.matters).toEqual([]);

    for (const status of ['archived', 'all']) {
      const assistantDenied = await request(app)
        .get(`/api/documents?status=${status}`)
        .set(auth(assistant.token));
      expect(assistantDenied.statusCode).toBe(403);
      expect(assistantDenied.body).toEqual({ error: 'Archived document access denied' });
    }

    const assistantMatterDenied = await request(app)
      .get(`/api/matters/${assignedMatterId}/documents?status=archived`)
      .set(auth(assistant.token));
    expect(assistantMatterDenied.statusCode).toBe(403);

    const clientMatterDenied = await request(app)
      .get(`/api/matters/${assignedMatterId}/documents?status=archived`)
      .set(auth(clientUser.token));
    expect(clientMatterDenied.statusCode).toBe(403);

    for (const token of [admin.token, advocateOne.token]) {
      const archivedDownload = await request(app)
        .get(`/api/documents/${archivedDocumentId}/download`)
        .set(auth(token));
      expect(archivedDownload.statusCode).toBe(404);
      expect(archivedDownload.body).toEqual({ error: 'Document not found' });
    }
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
    expect(expectedIds.filter(id => [tieDocumentOneId, tieDocumentTwoId].includes(id))).toEqual(
      [tieDocumentOneId, tieDocumentTwoId].sort(),
    );

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

    const activeCursor = (await request(app)
      .get('/api/documents?sort=name_asc&limit=1&status=active')
      .set(auth(admin.token))).body.nextCursor;
    const cursorAcrossStatus = await request(app)
      .get(`/api/documents?sort=name_asc&limit=1&status=all&cursor=${encodeURIComponent(activeCursor)}`)
      .set(auth(admin.token));
    expect(cursorAcrossStatus.statusCode).toBe(400);
    expect(cursorAcrossStatus.body).toEqual({ error: 'Invalid cursor' });

    const bounded = await request(app).get('/api/documents?limit=999').set(auth(admin.token));
    expect(bounded.statusCode).toBe(200);
    expect(bounded.body.limit).toBe(100);

    for (const query of [
      'sort=date_desc%20DROP%20TABLE%20documents',
      'type=executable',
      'source=unknown',
      'origin=unknown',
      'visibility=everyone',
      'status=deleted',
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

  test('reuses scoped rename, visibility, archive, restore, and audit contracts for admins and assigned advocates', async () => {
    const actionDocumentId = await uploadDocument({ matterId: assignedMatterId, name: 'global-action-contract.pdf' });

    const renamed = await request(app)
      .patch(`/api/documents/${actionDocumentId}`)
      .set(auth(admin.token))
      .send({ displayName: 'global-action-renamed.pdf' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.body.displayName).toBe('global-action-renamed.pdf');

    const shared = await request(app)
      .patch(`/api/documents/${actionDocumentId}`)
      .set(auth(advocateOne.token))
      .send({ clientVisible: true });
    expect(shared.statusCode).toBe(200);
    expect(Boolean(shared.body.clientVisible)).toBe(true);

    const archived = await request(app)
      .delete(`/api/documents/${actionDocumentId}`)
      .set(auth(advocateOne.token));
    expect(archived.statusCode).toBe(200);
    expect(archived.body).toEqual({ id: actionDocumentId, deleted: true });

    const archivedList = await request(app)
      .get(`/api/documents?status=archived&q=${encodeURIComponent('global-action-renamed')}`)
      .set(auth(admin.token));
    expect(archivedList.statusCode).toBe(200);
    expect(archivedList.body.items).toEqual([
      expect.objectContaining({ id: actionDocumentId, displayName: 'global-action-renamed.pdf', archived: true, visibility: 'client' }),
    ]);

    const archivedRenameDenied = await request(app)
      .patch(`/api/documents/${actionDocumentId}`)
      .set(auth(admin.token))
      .send({ displayName: 'must-not-change.pdf' });
    expect(archivedRenameDenied.statusCode).toBe(404);
    expect(archivedRenameDenied.body).toEqual({ error: 'Document not found' });

    const archivedDownloadDenied = await request(app)
      .get(`/api/documents/${actionDocumentId}/download`)
      .set(auth(admin.token));
    expect(archivedDownloadDenied.statusCode).toBe(404);

    const restored = await request(app)
      .patch(`/api/documents/${actionDocumentId}/restore`)
      .set(auth(advocateOne.token));
    expect(restored.statusCode).toBe(200);
    expect(restored.body).toMatchObject({ id: actionDocumentId, displayName: 'global-action-renamed.pdf' });
    expect(Boolean(restored.body.clientVisible)).toBe(true);

    const activeList = await request(app)
      .get(`/api/documents?q=${encodeURIComponent('global-action-renamed')}&sort=name_asc&limit=1`)
      .set(auth(advocateOne.token));
    expect(activeList.statusCode).toBe(200);
    expect(activeList.body.items).toEqual([
      expect.objectContaining({ id: actionDocumentId, archived: false, visibility: 'client' }),
    ]);

    const auditRows = await dbAll(
      'SELECT action,metadata_json FROM audit_events WHERE entity_id=? ORDER BY rowid',
      [actionDocumentId],
    );
    expect(auditRows.map(row => row.action)).toEqual(expect.arrayContaining([
      'document_updated',
      'document_visibility_updated',
      'document_deleted',
      'document_restored',
    ]));
    const visibilityAudit = auditRows.find(row => row.action === 'document_visibility_updated');
    const visibilityMetadata = JSON.parse(visibilityAudit.metadata_json || '{}');
    expect(visibilityMetadata.oldClientVisible).toBe(false);
    expect(visibilityMetadata.newClientVisible).toBe(true);
    expect(JSON.stringify(visibilityMetadata)).not.toContain('GLOBAL-EXPLORER-CONTENT');
  });

  test('denies unassigned advocates, assistants, clients, inaccessible rows, and stale document mutations safely', async () => {
    const beforeRows = await dbAll('SELECT displayName,clientVisible,deletedAt FROM documents WHERE id=?', [nestedDocumentId]);
    expect(beforeRows).toHaveLength(1);

    for (const [token, expectedStatus] of [
      [advocateTwo.token, 403],
      [assistant.token, 403],
      [clientUser.token, 403],
    ]) {
      const renameDenied = await request(app)
        .patch(`/api/documents/${nestedDocumentId}`)
        .set(auth(token))
        .send({ displayName: 'forbidden-name.pdf' });
      expect(renameDenied.statusCode).toBe(expectedStatus);
      expect(renameDenied.body.error).toMatch(/access denied|Advocate or admin access required/);

      const archiveDenied = await request(app)
        .delete(`/api/documents/${nestedDocumentId}`)
        .set(auth(token));
      expect(archiveDenied.statusCode).toBe(expectedStatus);
      expect(archiveDenied.body.error).toMatch(/access denied|Advocate or admin access required/);
    }

    const inaccessibleDenied = await request(app)
      .patch(`/api/documents/${hiddenDocumentId}`)
      .set(auth(advocateOne.token))
      .send({ clientVisible: true });
    expect(inaccessibleDenied.statusCode).toBe(403);
    expect(inaccessibleDenied.body).toEqual({ error: 'Document access denied' });

    for (const token of [advocateTwo.token, assistant.token, clientUser.token]) {
      const restoreDenied = await request(app)
        .patch(`/api/documents/${archivedDocumentId}/restore`)
        .set(auth(token));
      expect(restoreDenied.statusCode).toBe(403);
      expect(restoreDenied.body.error).toMatch(/access denied|Advocate or admin access required/);
    }

    const staleId = `DOC-STALE-${suffix}`;
    const staleRename = await request(app)
      .patch(`/api/documents/${staleId}`)
      .set(auth(admin.token))
      .send({ displayName: 'missing.pdf' });
    const staleArchive = await request(app)
      .delete(`/api/documents/${staleId}`)
      .set(auth(admin.token));
    const staleRestore = await request(app)
      .patch(`/api/documents/${staleId}/restore`)
      .set(auth(admin.token));
    expect(staleRename.statusCode).toBe(404);
    expect(staleArchive.statusCode).toBe(404);
    expect(staleRestore.statusCode).toBe(404);
    expect(staleRename.body).toEqual({ error: 'Document not found' });
    expect(staleArchive.body).toEqual({ error: 'Document not found' });
    expect(staleRestore.body).toEqual({ error: 'Archived document not found' });

    const afterRows = await dbAll('SELECT displayName,clientVisible,deletedAt FROM documents WHERE id=?', [nestedDocumentId]);
    expect(afterRows).toEqual(beforeRows);
  });

  test('validates rename and visibility payloads and keeps archived documents mutation-restricted', async () => {
    const validationDocumentId = await uploadDocument({ matterId: assignedMatterId, name: 'global-action-validation.pdf' });

    const blank = await request(app)
      .patch(`/api/documents/${validationDocumentId}`)
      .set(auth(admin.token))
      .send({ displayName: '   ' });
    expect(blank.statusCode).toBe(400);
    expect(blank.body).toEqual({ error: 'Document name is required' });

    const tooLong = await request(app)
      .patch(`/api/documents/${validationDocumentId}`)
      .set(auth(admin.token))
      .send({ displayName: `${'a'.repeat(177)}.pdf` });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.body).toEqual({ error: 'Document name must be 180 characters or fewer' });

    const invalidVisibility = await request(app)
      .patch(`/api/documents/${validationDocumentId}`)
      .set(auth(admin.token))
      .send({ clientVisible: 'true' });
    expect(invalidVisibility.statusCode).toBe(400);
    expect(invalidVisibility.body).toEqual({ error: 'Client visibility must be true or false' });

    const unchanged = await dbAll('SELECT displayName,clientVisible,deletedAt FROM documents WHERE id=?', [validationDocumentId]);
    expect(unchanged).toEqual([{ displayName: 'global-action-validation.pdf', clientVisible: 0, deletedAt: null }]);

    const archived = await request(app)
      .delete(`/api/documents/${validationDocumentId}`)
      .set(auth(admin.token));
    expect(archived.statusCode).toBe(200);

    const archivedVisibility = await request(app)
      .patch(`/api/documents/${validationDocumentId}`)
      .set(auth(admin.token))
      .send({ clientVisible: true });
    const archivedAgain = await request(app)
      .delete(`/api/documents/${validationDocumentId}`)
      .set(auth(admin.token));
    expect(archivedVisibility.statusCode).toBe(404);
    expect(archivedAgain.statusCode).toBe(404);
  });
});
