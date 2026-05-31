'use strict';

const request = require('supertest');
const { app, dbReady } = require('../server.js');

const TINY_PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const TINY_PNG_BASE64 = TINY_PNG_DATA_URI.split(',')[1];
const TINY_PNG_BUFFER = Buffer.from(TINY_PNG_BASE64, 'base64');

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function login(pathName, email) {
  const res = await request(app).post(pathName).send({ email, password: 'password123' });
  expect(res.statusCode).toBe(200);
  expect(res.body.token).toBeDefined();
  return res.body;
}

async function firstMatterForClient(adminToken, clientId) {
  const res = await request(app).get('/api/matters').set(auth(adminToken));
  expect(res.statusCode).toBe(200);
  const matter = res.body.find(row => row.clientId === clientId);
  expect(matter).toBeDefined();
  return matter;
}

async function createConversation(adminToken, clientId, matterId = '') {
  const res = await request(app)
    .post('/api/conversations')
    .set(auth(adminToken))
    .send({ clientId, matterId, subject: 'R19d avatar thread' });
  expect(res.statusCode).toBe(200);
  return res.body;
}

async function sendMessage(token, conversationId, body) {
  const res = await request(app)
    .post(`/api/conversations/${conversationId}/messages`)
    .set(auth(token))
    .send({ body });
  expect(res.statusCode).toBe(200);
  return res.body;
}

function uploadMyAvatar(token, contentType = 'image/png', buffer = TINY_PNG_BUFFER) {
  const ext = contentType.split('/').pop() || 'bin';
  return request(app)
    .post('/api/auth/me/avatar')
    .set(auth(token))
    .attach('avatar', buffer, { filename: `avatar.${ext}`, contentType });
}

function deleteMyAvatar(token) {
  return request(app).delete('/api/auth/me/avatar').set(auth(token));
}

function getMessages(token, conversationId) {
  return request(app).get(`/api/conversations/${conversationId}/messages`).set(auth(token));
}

function getMessageAvatar(token, conversationId, messageId) {
  return request(app).get(`/api/conversations/${conversationId}/messages/${messageId}/avatar`).set(auth(token));
}

function findMessageByBody(messages, body) {
  const message = messages.find(item => item.body === body);
  expect(message).toBeDefined();
  return message;
}

function expectNoImageData(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  expect(serialized).not.toContain(TINY_PNG_BASE64.toLowerCase().slice(0, 24));
  expect(serialized).not.toContain('ivborw0k');
  expect(serialized).not.toContain('data:image');
  expect(serialized).not.toContain('"avatar"');
  expect(serialized).not.toContain('avatarmimetype');
  expect(serialized).not.toContain('"mimetype"');
}

describe('R19d message conversation avatars', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let otherClientToken;
  let adminUser;
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
    adminUser = adminLogin.user;
    clientUser = clientLogin.user;
    otherClientUser = otherClientLogin.user;
    clientMatter = await firstMatterForClient(adminToken, clientUser.clientId);
    // Clean baseline: ensure the senders used by this suite start without avatars.
    await deleteMyAvatar(adminToken);
    await deleteMyAvatar(clientToken);
  });

  afterAll(async () => {
    // Leave shared demo DB as we found it for sibling suites.
    await deleteMyAvatar(adminToken);
    await deleteMyAvatar(clientToken);
  });

  test('messages expose senderHasAvatar as Boolean only, no image data', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    await sendMessage(clientToken, conversation.id, 'R19d boolean check client');
    await sendMessage(adminToken, conversation.id, 'R19d boolean check staff');

    const res = await getMessages(adminToken, conversation.id);
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBe(2);
    for (const message of res.body) {
      expect(typeof message.senderHasAvatar).toBe('boolean');
    }
    expectNoImageData(res.body);
  });

  test('senderHasAvatar flips after upload and removal via existing 13B/13C routes', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    await sendMessage(adminToken, conversation.id, 'R19d toggle staff message');

    let messages = (await getMessages(adminToken, conversation.id)).body;
    expect(findMessageByBody(messages, 'R19d toggle staff message').senderHasAvatar).toBe(false);

    const upload = await uploadMyAvatar(adminToken);
    expect(upload.statusCode).toBe(200);
    expect(upload.body.hasAvatar).toBe(true);

    messages = (await getMessages(adminToken, conversation.id)).body;
    expect(findMessageByBody(messages, 'R19d toggle staff message').senderHasAvatar).toBe(true);

    const remove = await deleteMyAvatar(adminToken);
    expect(remove.statusCode).toBe(200);
    expect(remove.body.hasAvatar).toBe(false);

    messages = (await getMessages(adminToken, conversation.id)).body;
    expect(findMessageByBody(messages, 'R19d toggle staff message').senderHasAvatar).toBe(false);
  });

  test('authorized staff can fetch a visible message sender avatar with image content-type', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    const staffMessage = await sendMessage(adminToken, conversation.id, 'R19d staff fetch message');
    expect((await uploadMyAvatar(adminToken)).statusCode).toBe(200);

    for (const token of [adminToken, advocateToken, assistantToken]) {
      const res = await getMessageAvatar(token, conversation.id, staffMessage.id);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^image\//);
      expect(res.body.length).toBeGreaterThan(0);
      expect(Buffer.compare(res.body, TINY_PNG_BUFFER)).toBe(0);
    }

    await deleteMyAvatar(adminToken);
  });

  test('authorized client can fetch a visible staff sender avatar in own conversation', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    const staffMessage = await sendMessage(adminToken, conversation.id, 'R19d client-views-staff message');
    expect((await uploadMyAvatar(adminToken)).statusCode).toBe(200);

    const res = await getMessageAvatar(clientToken, conversation.id, staffMessage.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\//);
    expect(res.body.length).toBeGreaterThan(0);

    await deleteMyAvatar(adminToken);
  });

  test('message with no sender avatar returns existing not-found behavior', async () => {
    const conversation = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    const staffMessage = await sendMessage(adminToken, conversation.id, 'R19d no-avatar message');
    await deleteMyAvatar(adminToken);

    const res = await getMessageAvatar(adminToken, conversation.id, staffMessage.id);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('No avatar set');
  });

  test('client cannot fetch an avatar from another client inaccessible conversation', async () => {
    const otherMatter = await firstMatterForClient(adminToken, otherClientUser.clientId);
    const conversation = await createConversation(adminToken, otherClientUser.clientId, otherMatter.id);
    const staffMessage = await sendMessage(adminToken, conversation.id, 'R19d cross-client staff message');
    expect((await uploadMyAvatar(adminToken)).statusCode).toBe(200);

    const res = await getMessageAvatar(clientToken, conversation.id, staffMessage.id);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Conversation access denied');

    await deleteMyAvatar(adminToken);
  });

  test('messageId must belong to the given conversation', async () => {
    const conversationA = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    const conversationB = await createConversation(adminToken, clientUser.clientId, clientMatter.id);
    const messageInA = await sendMessage(adminToken, conversationA.id, 'R19d belongs-to message');
    expect((await uploadMyAvatar(adminToken)).statusCode).toBe(200);

    const res = await getMessageAvatar(adminToken, conversationB.id, messageInA.id);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('Message not found');

    await deleteMyAvatar(adminToken);
  });

  test('existing 13B/13C avatar route semantics remain unchanged', async () => {
    expect((await uploadMyAvatar(adminToken)).statusCode).toBe(200);

    // 13B: client is hard-blocked from the staff user-avatar route.
    const clientHitsUserRoute = await request(app)
      .get(`/api/users/${adminUser.id}/avatar`)
      .set(auth(clientToken));
    expect(clientHitsUserRoute.statusCode).toBe(403);

    // 13B: non-admin staff cannot read another user's avatar via the user route.
    const advocateHitsAdminRoute = await request(app)
      .get(`/api/users/${adminUser.id}/avatar`)
      .set(auth(advocateToken));
    expect(advocateHitsAdminRoute.statusCode).toBe(403);

    // 13C: admin can still read its own staff avatar via the user route.
    const adminSelf = await request(app)
      .get(`/api/users/${adminUser.id}/avatar`)
      .set(auth(adminToken));
    expect(adminSelf.statusCode).toBe(200);
    expect(adminSelf.headers['content-type']).toMatch(/^image\//);

    await deleteMyAvatar(adminToken);
  });
});
