const fs = require('fs');
const os = require('os');
const path = require('path');
jest.mock('dotenv', () => ({ config: jest.fn() }), { virtual: true });
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'synthetic-communications-100c-signing-key';
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-100c-')), 'boundary.db');
fs.writeFileSync(process.env.DATABASE_PATH, '');
const request = require('supertest');
const sqlite3 = require('sqlite3');
const { app, dbReady } = require('../server');
const createDb = require('../lib/db');
const createAccess = require('../lib/access');
const createNotifications = require('../lib/notifications');
const { genId } = require('../lib/utils');
const { signAccessToken } = require('../lib/tokens');
jest.setTimeout(30000);

const users = {}, tokens = {};
const avatar = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const attachment = { name: 'synthetic-100c.pdf', mimeType: 'application/pdf', data: Buffer.from('SYNTHETIC-100C-DOCUMENT-BYTES').toString('base64') };
let db, sql, access, notifier, bootstrapAdminId;
const insert = (table, row) => sql.run(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row));
function api(role, method, url, body) {
 let req = request(app)[method](`/api${url}`);
 if (role) req = req.set('Authorization', `Bearer ${tokens[role]}`);
 return body === undefined ? req : req.send(body);
}
async function getIds(role, url) { const response = await api(role, 'get', url); expect(response.status).toBe(200); return response.body.map(row => row.id).sort(); }
async function state() {
 const tables = await sql.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
 const result = {};
 for (const { name } of tables) result[name] = await sql.all(`SELECT * FROM ${name}${name === 'audit_events' ? " WHERE action NOT LIKE 'forbidden_%'" : ''} ORDER BY rowid`);
 return JSON.stringify(result);
}
async function denied(role, method, url, body, status = 403) {
 const before = await state();
 const response = await api(role, method, url, body);
 expect(response.status).toBe(status);
 expect(await state()).toBe(before);
 expect(JSON.stringify(response.body)).not.toMatch(/HIDDEN-100C|SYNTHETIC-100C-DOCUMENT-BYTES/);
}
beforeAll(async () => {
 await dbReady;
 db = new sqlite3.Database(process.env.DATABASE_PATH);
 sql = createDb(db); access = createAccess(sql);
 notifier = createNotifications({ ...sql, genId, canAccessCommunication: access.canAccessCommunication });
 const bootstrappedUsers = await sql.all('SELECT id, role FROM users');
 expect(bootstrappedUsers).toHaveLength(1);
 expect(bootstrappedUsers[0].role).toBe('admin');
 bootstrapAdminId = bootstrappedUsers[0].id;
 for (const [key, role, fullName, clientId] of [['admin', 'admin', 'Boundary Admin', ''], ['assistant', 'assistant', 'Boundary Assistant', ''], ['a', 'advocate', 'Advocate A', ''], ['b', 'advocate', 'Advocate B', ''], ['client', 'client', 'Shared Portal', 'shared'], ['otherClient', 'client', 'Other Portal', 'only-b']]) {
   users[key] = { id: `USER-${key}`, role, fullName, clientId, tokenVersion: 1 };
   await insert('users', { ...users[key], email: `${key}@example.test`, password: 'synthetic-unused-hash', isActive: 1, avatar, avatarMimeType: 'image/png' });
   tokens[key] = signAccessToken(users[key]);
 }
 for (const id of ['shared', 'only-a', 'only-b', 'intake']) await insert('clients', { id, name: `Client ${id}`, email: `${id}@example.test` });
 for (const [id, clientId, assignedTo] of [['A1', 'shared', 'Advocate A'], ['B1', 'shared', 'Advocate B'], ['A2', 'only-a', 'Advocate A'], ['B2', 'only-b', 'Advocate B']]) await insert('matters', { id, clientId, assignedTo, title: `Matter ${id}`, reference: `100C-${id}`, stage: 'Intake' });
 for (const [id, matterId, clientId] of [['CA', 'A1', 'shared'], ['CB', 'B1', 'shared'], ['DELEGATED', 'B2', 'only-b'], ['GENERAL', '', 'shared'], ['INTAKE', null, 'intake'], ['OTHER-GENERAL', '', 'only-b'], ['DANGLING', 'missing-matter', 'shared'], ['MISMATCHED', 'A1', 'only-b']]) {
   const hidden = ['CB', 'DELEGATED', 'OTHER-GENERAL', 'DANGLING', 'MISMATCHED'].includes(id);
   await insert('conversations', { id, matterId, clientId, subject: `${hidden ? 'HIDDEN-100C' : 'Authorized'} ${id}`, status: 'open', createdAt: hidden ? '2099-01-01' : '2026-01-01', lastStaffReadAt: '', lastClientReadAt: '' });
   await insert('messages', { id: `MSG-${id}`, conversationId: id, senderId: clientId === 'only-b' ? users.otherClient.id : users.client.id, senderRole: 'client', body: `${hidden ? 'HIDDEN-100C' : 'Authorized'} ${id} message`, createdAt: '2026-01-02' });
 }
 for (const [id, matterId, messageId, deletedAt] of [['DOC-A', 'A1', 'MSG-CA', null], ['DOC-B', 'B1', 'MSG-CB', null], ['DOC-GENERAL', '', 'MSG-GENERAL', null], ['HIDDEN-100C-CROSS-MATTER', 'B1', 'MSG-CA', null], ['HIDDEN-100C-CROSS-THREAD', 'A1', 'MSG-CB', null], ['HIDDEN-100C-MISSING-THREAD', 'A1', 'missing-message', null], ['DOC-INTERNAL', 'A1', null, null], ['DOC-DELETED', 'A1', 'MSG-CA', '2026-01-01']]) await insert('documents', { id, matterId, messageId, name: `${id}.pdf`, mimeType: 'application/pdf', type: 'PDF', source: 'firm', clientVisible: 0, content: Buffer.from('SYNTHETIC-100C-DOCUMENT-BYTES'), date: '2026-01-01', deletedAt });
 await insert('tasks', { id: 'TASK-DELEGATED', matterId: 'B2', title: 'Delegated task', assignee: 'Advocate A' });
 await insert('appearances', { id: 'AP-DELEGATED', matterId: 'B2', title: 'Delegated appearance', attorney: 'Advocate A', date: '2099-01-01' });
 for (const [id, matterId, clientId, userId] of [['N-A', 'A1', 'shared', users.a.id], ['N-GENERAL', '', 'shared', users.a.id], ['N-DANGLING', 'missing-matter', 'shared', users.a.id], ['N-MISMATCH', 'A1', 'only-b', users.a.id], ['N-UNLINKED', '', '', users.a.id], ['N-OTHER-CLIENT', '', 'only-b', users.a.id], ['N-OTHER-USER', 'A1', 'shared', users.b.id], ['N-ADMIN', 'B1', 'shared', users.admin.id], ['N-ASSISTANT', 'B1', 'shared', users.assistant.id]]) await insert('notifications', { id, userId, matterId, clientId, type: 'client_message', title: id, body: id === 'N-A' || id === 'N-GENERAL' ? 'Authorized preview' : 'HIDDEN-100C historical preview', createdAt: '2026-01-01', readAt: '' });
 for (let index = 0; index < 60; index++) await insert('notifications', { id: `N-HIDDEN-${index}`, userId: users.a.id, matterId: 'B1', clientId: 'shared', type: 'client_message', title: 'HIDDEN-100C title', body: 'HIDDEN-100C preview', createdAt: '2099-01-01', readAt: '' });
});
afterAll(async () => { if (db) await new Promise(resolve => db.close(resolve)); });

test('unauthenticated communications and notification entry points reject reads and writes', async () => {
 for (const url of ['/conversations', '/conversations/CB/messages', '/conversations/CB/messages/MSG-CB/avatar', '/notifications', '/documents/DOC-B/download']) expect((await api(null, 'get', url)).status).toBe(401);
 for (const [method, url, body] of [['post', '/conversations', { matterId: 'A1' }], ['post', '/conversations/CA/read', {}], ['patch', '/conversations/CA/status', { status: 'resolved' }], ['post', '/conversations/CA/messages', { body: 'Rejected' }], ['post', '/notifications/read', { id: 'N-A' }]]) await denied(null, method, url, body, 401);
});
test('advocate lists and filters intersect exact matter/client communication scope', async () => {
 expect(await getIds('a', '/conversations')).toEqual(['CA', 'GENERAL']);
 expect(await getIds('b', '/conversations')).toEqual(['CB', 'DELEGATED', 'GENERAL', 'OTHER-GENERAL']);
 expect(await getIds('a', '/conversations?clientId=shared')).toEqual(['CA', 'GENERAL']);
 expect(await getIds('a', '/conversations?matterId=B1')).toEqual([]);
 expect(await getIds('a', '/conversations?clientId=only-b')).toEqual([]);
 const response = await api('a', 'get', '/conversations');
 expect(JSON.stringify(response.body)).not.toMatch(/HIDDEN-100C|MSG-CB|SYNTHETIC-100C-DOCUMENT-BYTES/);
 expect(response.body.find(row => row.id === 'CA')).toMatchObject({ messageCount: 1, staffUnreadCount: 1, unreadCount: 1 });
});
test.each(['admin', 'assistant'])('%s retains firm-wide conversation listing and intake', async role => {
 expect(await getIds(role, '/conversations')).toEqual(['CA', 'CB', 'DANGLING', 'DELEGATED', 'GENERAL', 'INTAKE', 'MISMATCHED', 'OTHER-GENERAL']);
 for (const body of [{ matterId: 'B2' }, { clientId: 'intake' }]) {
   const response = await api(role, 'post', '/conversations', { ...body, subject: `${role} intake` });
   expect(response.status).toBe(200);
   expect(response.body.clientId).toBe(body.clientId || 'only-b');
   // Keep exact listing fixtures stable for the next role case.
   await sql.run('DELETE FROM conversations WHERE id=?', [response.body.id]);
 }
});
test('matterless conversations use existing client access; broken matter links do not fall back', async () => {
 expect(await access.canAccessConversation({ user: users.a }, 'GENERAL')).toBe(true);
 for (const id of ['INTAKE', 'OTHER-GENERAL', 'DANGLING', 'MISMATCHED']) expect(await access.canAccessConversation({ user: users.a }, id)).toBe(false);
 expect(await access.canAccessConversation({ user: { role: 'unknown' } }, 'GENERAL')).toBe(false);
 expect(await access.canAccessTask({ user: users.a }, 'TASK-DELEGATED')).toBe(true);
 expect(await access.canAccessAppearance({ user: users.a }, 'AP-DELEGATED')).toBe(true);
 expect(await access.canAccessConversation({ user: users.a }, 'DELEGATED')).toBe(false);
});
test.each(['CB', 'DELEGATED', 'DANGLING', 'MISMATCHED', 'OTHER-GENERAL', 'INTAKE'])('advocate cannot read messages/avatar or mutate unauthorized conversation %s', async id => {
 expect((await api('a', 'get', `/conversations/${id}/messages`)).status).toBe(403);
 expect((await api('a', 'get', `/conversations/${id}/messages/MSG-${id}/avatar`)).status).toBe(403);
 await denied('a', 'post', `/conversations/${id}/read`, {});
 await denied('a', 'patch', `/conversations/${id}/status`, { status: 'resolved' });
 await denied('a', 'post', `/conversations/${id}/messages`, { body: 'Rejected preview', attachments: [attachment], matterId: 'A1', clientId: 'shared' });
});
test.each(['admin', 'assistant', 'a'])('%s can read, reply, mark read, triage and fetch sender avatar on an authorized thread', async role => {
 const id = role === 'a' ? 'CA' : 'CB';
 const list = await api(role, 'get', `/conversations/${id}/messages`);
 expect(list.status).toBe(200);
 expect(list.body[0].senderHasAvatar).toBe(true);
 expect(JSON.stringify(list.body)).not.toContain(avatar.toString('base64'));
 expect((await api(role, 'get', `/conversations/${id}/messages/MSG-${id}/avatar`)).status).toBe(200);
 expect((await api(role, 'get', `/conversations/${id}/messages/MSG-GENERAL/avatar`)).status).toBe(404);
 const reply = await api(role, 'post', `/conversations/${id}/messages`, { body: 'Authorized firm reply', attachments: [attachment] });
 expect(reply.status).toBe(200);
 expect(reply.body.attachments).toHaveLength(1);
 expect(reply.body.attachments[0].matterId).toBe(id === 'CA' ? 'A1' : 'B1');
 expect((await api(role, 'post', `/conversations/${id}/read`, {})).body.staffUnreadCount).toBe(0);
 expect((await api(role, 'patch', `/conversations/${id}/status`, { status: 'pending' })).body.status).toBe('pending');
});
test('attachment metadata and bytes require both conversation and document matter authorization', async () => {
 const own = await api('a', 'get', '/conversations/CA/messages');
 const first = own.body.find(message => message.id === 'MSG-CA');
 expect(first.attachments.map(doc => doc.id)).toEqual(['DOC-A']);
 expect(JSON.stringify(own.body)).not.toMatch(/HIDDEN-100C|SYNTHETIC-100C-DOCUMENT-BYTES/);
 const general = await api('a', 'get', '/conversations/GENERAL/messages');
 expect(general.body[0].attachments[0].id).toBe('DOC-GENERAL');
 for (const id of ['DOC-A', 'DOC-GENERAL', 'DOC-INTERNAL']) expect((await api('a', 'get', `/documents/${id}/download`)).status).toBe(200);
 for (const id of ['DOC-B', 'HIDDEN-100C-CROSS-MATTER', 'HIDDEN-100C-CROSS-THREAD', 'HIDDEN-100C-MISSING-THREAD']) expect((await api('a', 'get', `/documents/${id}/download`)).status).toBe(403);
 expect((await api('a', 'get', '/documents/DOC-DELETED/download')).status).toBe(404);
 for (const role of ['admin', 'assistant']) expect((await api(role, 'get', '/documents/DOC-B/download')).status).toBe(200);
});
test('clients retain own-conversation and attachment access without staff triage or cross-client access', async () => {
 expect(await getIds('client', '/conversations?clientId=only-b')).toEqual(['CA', 'CB', 'DANGLING', 'GENERAL']);
 for (const id of ['CA', 'CB', 'GENERAL']) {
   expect((await api('client', 'get', `/conversations/${id}/messages`)).status).toBe(200);
   expect((await api('client', 'post', `/conversations/${id}/read`, {})).status).toBe(200);
 }
 for (const id of ['DOC-A', 'DOC-B', 'DOC-GENERAL']) expect((await api('client', 'get', `/documents/${id}/download`)).status).toBe(200);
 expect((await api('client', 'get', '/documents/DOC-INTERNAL/download')).status).toBe(403);
 expect((await api('otherClient', 'get', '/documents/DOC-A/download')).status).toBe(403);
 expect((await api('otherClient', 'get', '/conversations/CA/messages/MSG-CA/avatar')).status).toBe(403);
 await denied('otherClient', 'post', '/conversations/CA/messages', { body: 'Rejected cross-client reply' });
 await denied('otherClient', 'post', '/conversations/CA/read', {});
 await denied('client', 'patch', '/conversations/CA/status', { status: 'resolved' });
 expect((await api('client', 'get', '/notifications')).status).toBe(403);
});
test.each([
 ['a', { matterId: 'B1', clientId: 'shared' }, 403], ['a', { matterId: 'B2' }, 403],
 ['a', { clientId: 'only-b' }, 403], ['a', { clientId: 'intake' }, 403],
 ['a', { matterId: 'missing-matter', clientId: 'shared' }, 404], ['a', { matterId: 'A1', clientId: 'only-b' }, 400],
 ['client', { matterId: 'B2' }, 403], ['a', { matterId: { id: 'A1' } }, 400],
])('conversation creation rejects unauthorized or inconsistent associations (%#)', async (role, body, status) => { await denied(role, 'post', '/conversations', { ...body, subject: 'Rejected conversation' }, status); });
test('advocate and client legitimate matter/general creation derives persisted associations', async () => {
 for (const role of ['a', 'client']) for (const body of [{ matterId: 'A1' }, { clientId: 'shared' }]) {
   const response = await api(role, 'post', '/conversations', { ...body, subject: 'Authorized new thread' });
   expect(response.status).toBe(200);
   expect(response.body.clientId).toBe('shared');
   expect((await api(role, 'post', `/conversations/${response.body.id}/messages`, { body: 'Authorized first reply' })).status).toBe(200);
 }
});
test('stored notification scope applies before ordering/LIMIT and excludes sensitive stale payloads', async () => {
 const response = await api('a', 'get', '/notifications');
 expect(response.status).toBe(200);
 expect(response.body.map(row => row.id)).toEqual(expect.arrayContaining(['N-A', 'N-GENERAL']));
 expect(response.body.every(row => !row.id.startsWith('N-HIDDEN-'))).toBe(true);
 expect(JSON.stringify(response.body)).not.toMatch(/HIDDEN-100C|missing-matter|only-b|N-OTHER-USER|N-UNLINKED/);
 for (const role of ['admin', 'assistant']) expect(await getIds(role, '/notifications')).toContain(role === 'admin' ? 'N-ADMIN' : 'N-ASSISTANT');
 for (const body of [{ id: 'N-HIDDEN-0' }, { id: 'N-OTHER-USER' }, { id: 'N-MISMATCH' }, { matterId: 'B1' }]) await denied('a', 'post', '/notifications/read', body);
 expect((await api('a', 'post', '/notifications/read', { id: 'N-GENERAL' })).status).toBe(200);
 expect((await sql.get("SELECT readAt FROM notifications WHERE id='N-GENERAL'")).readAt).toBeTruthy();
});
test.each(['conversation', 'general', 'upload', 'request', 'note'])('%s notification creation reaches only authorized staff', async kind => {
 const before = new Set((await sql.all('SELECT id FROM notifications')).map(row => row.id));
 let response;
 if (kind === 'conversation' || kind === 'general') response = await api('client', 'post', `/conversations/${kind === 'general' ? 'GENERAL' : 'CA'}/messages`, { body: `SYNTHETIC-100C-NOTIFICATION-${kind}`, attachments: [attachment] });
 if (kind === 'upload') response = await api('client', 'post', '/matters/A1/documents', attachment);
 if (kind === 'request') {
   const created = await api('admin', 'post', '/document-requests', { matterId: 'A1', title: 'Synthetic 100C request' });
   expect(created.status).toBe(200);
   response = await api('client', 'post', `/document-requests/${created.body.id}/respond`, attachment);
 }
 if (kind === 'note') response = await api('client', 'post', '/matters/A1/notes', { content: 'SYNTHETIC-100C-NOTIFICATION-note' });
 expect(response.status).toBe(200);
 const added = (await sql.all('SELECT * FROM notifications')).filter(row => !before.has(row.id));
 expect(added.map(row => row.userId).sort()).toEqual([bootstrapAdminId, users.admin.id, users.assistant.id, users.a.id, ...(kind === 'general' ? [users.b.id] : [])].sort());
 expect(added.every(row => row.clientId === 'shared' && row.matterId === (kind === 'general' ? '' : 'A1'))).toBe(true);
});
test('notification utility validates persisted associations and does not broadcast unscoped previews', async () => {
 for (const [matterId, clientId] of [['A1', 'only-b'], ['missing-matter', 'shared'], ['', 'missing-client'], ['', '']]) {
   const before = await state();
   await notifier.notifyStaff('client_message', matterId, 'Rejected notification', 'HIDDEN-100C untrusted preview', clientId);
   expect(await state()).toBe(before);
 }
});
test('assignment and client-access removal immediately hide historical notifications and communications', async () => {
 expect(await getIds('a', '/notifications')).toContain('N-A');
 const reassign = await api('admin', 'patch', '/matters/A1/reassign', { assignedTo: 'Advocate B' });
 expect(reassign.status).toBe(200);
 expect(await getIds('a', '/notifications')).toEqual([]);
 expect(await getIds('a', '/conversations?clientId=shared')).toEqual([]);
 expect((await api('a', 'get', '/conversations/CA/messages')).status).toBe(403);
 expect((await api('a', 'get', '/documents/DOC-A/download')).status).toBe(403);
 await denied('a', 'post', '/notifications/read', { id: 'N-A' });
 await denied('a', 'post', '/notifications/read', { matterId: 'A1' });
 expect((await sql.get("SELECT readAt FROM notifications WHERE id='N-A'")).readAt).toBe('');
 expect((await api('b', 'get', '/conversations/CA/messages')).status).toBe(200);
 expect(await getIds('b', '/notifications')).toContain('N-OTHER-USER');
 expect((await api('b', 'post', '/notifications/read', { matterId: 'A1' })).status).toBe(200);
 expect((await sql.get("SELECT readAt FROM notifications WHERE id='N-OTHER-USER'")).readAt).toBeTruthy();
 const before = new Set((await sql.all('SELECT id FROM notifications')).map(row => row.id));
 expect((await api('client', 'post', '/conversations/CA/messages', { body: 'After reassignment' })).status).toBe(200);
 expect((await sql.all('SELECT * FROM notifications')).filter(row => !before.has(row.id)).map(row => row.userId).sort()).toEqual([bootstrapAdminId, users.admin.id, users.assistant.id, users.b.id].sort());
});
