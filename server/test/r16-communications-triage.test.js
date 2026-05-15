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
  const matter = mattersRes.body.find(row => row.clientId === clientId);
  expect(matter).toBeDefined();
  return matter;
}

async function createConversation(adminToken, clientId, matterId = '') {
  const res = await request(app)
    .post('/api/conversations')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ clientId, matterId, subject: 'R16 triage thread' });
  expect(res.statusCode).toBe(200);
  expect(res.body.status).toBe('open');
  return res.body;
}

async function sendMessage(token, conversationId, body, attachments = []) {
  const res = await request(app)
    .post(`/api/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${token}`)
    .send({ body, attachments });
  expect(res.statusCode).toBe(200);
  return res.body;
}

describe('R16 communications triage', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let otherClientToken;
  let clientUser;
  let otherClientUser;
  let clientMatter;

  beforeAll(async () => {
    await dbReady;
    const adminLogin = await login('/api/auth/login', 'admin@lexflow.co.ke');
    const advocateLogin = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    const assistantLogin = await login('/api/auth/login', 'david.wanjiku@achokilaw.co.ke');
    const clientLogin = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');
    const otherClientLogin = await login('/api/auth/client-login', 'legal@kamaulogistics.co.ke');
    adminToken = adminLogin.token;
    advocateToken = advocateLogin.token;
    assistantToken = assistantLogin.token;
    clientToken = clientLogin.token;
    otherClientToken = otherClientLogin.token;
    clientUser = clientLogin.user;
    otherClientUser = otherClientLogin.user;
    clientMatter = await firstMatterForClient(adminToken, clientUser.clientId);
  });

  test('client message creates staff unread state and staff mark-read clears it', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    await sendMessage(clientToken, conversation.id, 'R16 client unread marker');

    const staffList = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(staffList.statusCode).toBe(200);
    const staffThread = staffList.body.find(row => row.id === conversation.id);
    expect(staffThread.status).toBe('open');
    expect(staffThread.staffUnreadCount).toBe(1);
    expect(staffThread.unreadCount).toBe(1);
    expect(staffThread.isUnread).toBe(true);

    const readRes = await request(app)
      .post(`/api/conversations/${conversation.id}/read`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(readRes.statusCode).toBe(200);
    expect(readRes.body.staffUnreadCount).toBe(0);
    expect(readRes.body.unreadCount).toBe(0);

    const auditRows = await dbAll(
      'SELECT metadata_json FROM audit_events WHERE action=? AND entity_id=? ORDER BY timestamp DESC LIMIT 1',
      ['conversation_mark_read', conversation.id],
    );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].metadata_json).toContain('"side":"staff"');
    expect(auditRows[0].metadata_json).not.toContain('R16 client unread marker');
  });

  test('staff reply creates client unread state and client mark-read clears it', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    await sendMessage(adminToken, conversation.id, 'R16 firm reply marker');

    const clientList = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(clientList.statusCode).toBe(200);
    const clientThread = clientList.body.find(row => row.id === conversation.id);
    expect(clientThread.clientUnreadCount).toBe(1);
    expect(clientThread.unreadCount).toBe(1);
    expect(clientThread.isUnread).toBe(true);
    expect(clientThread.staffUnreadCount).toBeUndefined();

    const readRes = await request(app)
      .post(`/api/conversations/${conversation.id}/read`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({});
    expect(readRes.statusCode).toBe(200);
    expect(readRes.body.clientUnreadCount).toBe(0);
    expect(readRes.body.unreadCount).toBe(0);
  });

  test('staff can change status to open pending and resolved', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    for (const status of ['pending', 'resolved', 'open']) {
      const res = await request(app)
        .patch(`/api/conversations/${conversation.id}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe(status);
      expect(res.body.statusUpdatedAt).toBeTruthy();
    }
  });

  test('conversation list includes triage and last-message metadata', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    await sendMessage(clientToken, conversation.id, 'R16 metadata marker');

    const res = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    const thread = res.body.find(row => row.id === conversation.id);
    expect(thread.status).toBe('open');
    expect(thread.lastMessageAt).toBeTruthy();
    expect(thread.lastMessageSenderRole).toBe('client');
    expect(thread.lastStaffReadAt).toBeDefined();
    expect(thread.lastClientReadAt).toBeTruthy();
    expect(thread.messageCount).toBe(1);
  });

  test('status updates write structured audit metadata without message body', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    await sendMessage(clientToken, conversation.id, 'R16 status audit body must not appear');
    const res = await request(app)
      .patch(`/api/conversations/${conversation.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'pending' });
    expect(res.statusCode).toBe(200);

    const auditRows = await dbAll(
      'SELECT metadata_json FROM audit_events WHERE action=? AND entity_id=? ORDER BY timestamp DESC LIMIT 1',
      ['conversation_status_update', conversation.id],
    );
    expect(auditRows.length).toBe(1);
    const metadata = JSON.parse(auditRows[0].metadata_json || '{}');
    expect(metadata.oldStatus).toBe('open');
    expect(metadata.newStatus).toBe('pending');
    expect(auditRows[0].metadata_json).not.toContain('R16 status audit body must not appear');
  });

  test('invalid status is rejected', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    const invalidRes = await request(app)
      .patch(`/api/conversations/${conversation.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'waiting_on_magic' });
    expect(invalidRes.statusCode).toBe(400);
  });

  test('client cannot change staff workflow status', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    const clientRes = await request(app)
      .patch(`/api/conversations/${conversation.id}/status`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ status: 'resolved' });
    expect(clientRes.statusCode).toBe(403);
  });

  test('client conversation list excludes another client conversation', async () => {
    const otherMatter = await firstMatterForClient(adminToken, otherClientUser.clientId);
    const conversation = await createConversation(adminToken, otherClientUser.clientId, otherMatter.id);

    const clientList = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(clientList.statusCode).toBe(200);
    expect(clientList.body.some(row => row.id === conversation.id)).toBe(false);
  });

  test('client cannot access or mark another client conversation read', async () => {
    const otherMatter = await firstMatterForClient(adminToken, otherClientUser.clientId);
    const conversation = await createConversation(adminToken, otherClientUser.clientId, otherMatter.id);

    const messagesRes = await request(app)
      .get(`/api/conversations/${conversation.id}/messages`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(messagesRes.statusCode).toBe(403);

    const readRes = await request(app)
      .post(`/api/conversations/${conversation.id}/read`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({});
    expect(readRes.statusCode).toBe(403);
  });

  test('assistant advocate and admin follow existing staff communications access rules', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    await sendMessage(clientToken, conversation.id, 'R16 staff boundary marker');

    const assistantRead = await request(app)
      .post(`/api/conversations/${conversation.id}/read`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({});
    expect(assistantRead.statusCode).toBe(200);

    const advocateStatus = await request(app)
      .patch(`/api/conversations/${conversation.id}/status`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ status: 'pending' });
    expect(advocateStatus.statusCode).toBe(200);
    expect(advocateStatus.body.status).toBe('pending');

    const adminMessages = await request(app)
      .get(`/api/conversations/${conversation.id}/messages`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminMessages.statusCode).toBe(200);
    expect(adminMessages.body.some(message => message.body === 'R16 staff boundary marker')).toBe(true);
  });

  test('communication attachments remain accessible under existing rules', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    const message = await sendMessage(adminToken, conversation.id, 'R16 attachment triage message', [{
      name: 'r16-triage.pdf',
      displayName: 'r16-triage.pdf',
      mimeType: 'application/pdf',
      data: `data:application/pdf;base64,${Buffer.from('R16 attachment body').toString('base64')}`,
    }]);
    expect(message.attachments.length).toBe(1);
    const attachmentId = message.attachments[0].id;

    const ownDownload = await request(app)
      .get(`/api/documents/${attachmentId}/download`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(ownDownload.statusCode).toBe(200);

    const otherDownload = await request(app)
      .get(`/api/documents/${attachmentId}/download`)
      .set('Authorization', `Bearer ${otherClientToken}`);
    expect(otherDownload.statusCode).toBe(403);
  });
});
