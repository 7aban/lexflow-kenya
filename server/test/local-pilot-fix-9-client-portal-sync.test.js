// LOCAL-PILOT-FIX-9 — client portal matter + messaging sync.
//
// Root cause covered by this suite: the staff "Linked Client" dropdown in the
// Create User form submitted the client NAME (option had no value attribute),
// and POST /api/auth/register stored it unvalidated, so the portal user's
// users.clientId never matched a real client record. Every portal surface
// (dashboard matters/invoices/documents/court dates, conversations, message
// sending) keys off req.user.clientId, so the portal looked empty and the
// message action stayed disabled while staff Communications kept working.
//
// Fix under test:
// 1. POST /api/auth/register now rejects client users whose clientId does not
//    reference an existing client record ("Linked client not found").
// 2. repairClientUserLinks() (run at server start) heals client users whose
//    clientId exactly matches one client's name but no client id.
// 3. With a correct link, the portal sees the client's matters (all stages —
//    documented policy below), staff threads/messages, and can reply, while
//    other clients' data stays isolated.
const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, repairClientUserLinks } = require('../server.js');

const PORTAL_EMAIL = 'lp-fix9-portal@test.lexflow.co.ke';
const PORTAL_PASSWORD = 'Portal9!sync';
const NAME_LINK_EMAIL = 'lp-fix9-namelink@test.lexflow.co.ke';
const ORPHAN_EMAIL = 'lp-fix9-orphan@test.lexflow.co.ke';
const AMBIGUOUS_EMAIL = 'lp-fix9-ambiguous@test.lexflow.co.ke';
const CLIENT_A_NAME = 'LP-FIX9 Client A';
const CLIENT_B_NAME = 'LP-FIX9 Client B';
const DUPLICATE_NAME = 'LP-FIX9 Duplicate Name';

let adminToken;
let clientToken;
let clientAId;
let clientBId;
let duplicateClientIds = [];
let matterActiveId; // client A, set Active via the status route (owner flow)
let matterClosedId; // client A, Closed stage
let matterBId; // client B, Active
let convAId; // staff-created thread for client A / active matter
let convBId; // staff-created thread for client B (must stay invisible)
const invoiceAId = 'INV-LP9-A';
const invoiceBId = 'INV-LP9-B';
const docVisibleId = 'DOC-LP9-VIS';
const docPrivateId = 'DOC-LP9-PRIV';
const docOtherClientId = 'DOC-LP9-OTHER';
const appearanceAId = 'APP-LP9-A';
const appearanceBId = 'APP-LP9-B';

const db = new sqlite3.Database(config.DATABASE_PATH);
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, err => err ? reject(err) : resolve());
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});

beforeAll(async () => {
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = adminRes.body.token;
  expect(adminToken).toBeDefined();

  const clientARes = await request(app)
    .post('/api/clients')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: CLIENT_A_NAME, type: 'Individual' });
  expect(clientARes.statusCode).toBe(200);
  clientAId = clientARes.body.id;

  const clientBRes = await request(app)
    .post('/api/clients')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: CLIENT_B_NAME, type: 'Individual' });
  expect(clientBRes.statusCode).toBe(200);
  clientBId = clientBRes.body.id;

  // Mirror the owner's pilot flow: create the matter, then set it Active via
  // the status route.
  const matterActiveRes = await request(app)
    .post('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title: 'LP-FIX9 Active Matter', clientId: clientAId, practiceArea: 'Civil', stage: 'Intake' });
  expect(matterActiveRes.statusCode).toBe(200);
  matterActiveId = matterActiveRes.body.id;
  const statusRes = await request(app)
    .patch(`/api/matters/${matterActiveId}/status`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ stage: 'Active' });
  expect(statusRes.statusCode).toBe(200);
  expect(statusRes.body.stage).toBe('Active');

  const matterClosedRes = await request(app)
    .post('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title: 'LP-FIX9 Closed Matter', clientId: clientAId, practiceArea: 'Civil', stage: 'Closed' });
  expect(matterClosedRes.statusCode).toBe(200);
  matterClosedId = matterClosedRes.body.id;

  const matterBRes = await request(app)
    .post('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title: 'LP-FIX9 Unrelated Matter', clientId: clientBId, practiceArea: 'Civil', stage: 'Active' });
  expect(matterBRes.statusCode).toBe(200);
  matterBId = matterBRes.body.id;

  // Portal account correctly linked to client A by record id.
  const registerRes = await request(app)
    .post('/api/auth/register')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: PORTAL_EMAIL, password: PORTAL_PASSWORD, fullName: 'LP Fix9 Portal User', role: 'client', clientId: clientAId });
  expect(registerRes.statusCode).toBe(200);
  expect(registerRes.body.clientId).toBe(clientAId);

  const clientLoginRes = await request(app)
    .post('/api/auth/client-login')
    .send({ email: PORTAL_EMAIL, password: PORTAL_PASSWORD });
  expect(clientLoginRes.statusCode).toBe(200);
  expect(clientLoginRes.body.user.clientId).toBe(clientAId);
  clientToken = clientLoginRes.body.token;

  // Staff thread for the unrelated client B — must never leak to client A.
  const convBRes = await request(app)
    .post('/api/conversations')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ clientId: clientBId, matterId: matterBId, subject: 'LP-FIX9 unrelated thread' });
  expect(convBRes.statusCode).toBe(200);
  convBId = convBRes.body.id;

  // Billing/document/court-date fixtures for both clients (dashboard payload
  // isolation checks).
  await dbRun('INSERT INTO invoices (id,matterId,clientId,number,date,amount,status,dueDate,description,source) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [invoiceAId, matterActiveId, clientAId, 'LP9-A-001', '2026-06-10', 1000, 'Outstanding', '2026-07-10', 'LP-FIX9 invoice A', 'manual']);
  await dbRun('INSERT INTO invoices (id,matterId,clientId,number,date,amount,status,dueDate,description,source) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [invoiceBId, matterBId, clientBId, 'LP9-B-001', '2026-06-10', 2000, 'Outstanding', '2026-07-10', 'LP-FIX9 invoice B', 'manual']);
  await dbRun('INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,clientVisible,uploadedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [docVisibleId, matterActiveId, 'lp9-shared.txt', 'LP9 Shared Document', 'Text', 'text/plain', '2026-06-10', '1 KB', Buffer.from('shared'), 'firm', 1, 'admin']);
  await dbRun('INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,clientVisible,uploadedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [docPrivateId, matterActiveId, 'lp9-private.txt', 'LP9 Staff Only Document', 'Text', 'text/plain', '2026-06-10', '1 KB', Buffer.from('private'), 'firm', 0, 'admin']);
  await dbRun('INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,clientVisible,uploadedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [docOtherClientId, matterBId, 'lp9-other.txt', 'LP9 Other Client Document', 'Text', 'text/plain', '2026-06-10', '1 KB', Buffer.from('other'), 'firm', 1, 'admin']);
  await dbRun('INSERT INTO appearances (id,matterId,title,date,time,type,location,attorney) VALUES (?,?,?,?,?,?,?,?)',
    [appearanceAId, matterActiveId, 'LP9 Mention A', '2026-07-01', '09:00', 'Mention', 'Milimani', 'Admin User']);
  await dbRun('INSERT INTO appearances (id,matterId,title,date,time,type,location,attorney) VALUES (?,?,?,?,?,?,?,?)',
    [appearanceBId, matterBId, 'LP9 Mention B', '2026-07-02', '09:00', 'Mention', 'Milimani', 'Admin User']);
});

afterAll(async () => {
  try {
    for (const email of [PORTAL_EMAIL, NAME_LINK_EMAIL, ORPHAN_EMAIL, AMBIGUOUS_EMAIL]) {
      await dbRun('DELETE FROM users WHERE email=?', [email]);
    }
    for (const convId of [convAId, convBId].filter(Boolean)) {
      await dbRun('DELETE FROM documents WHERE messageId IN (SELECT id FROM messages WHERE conversationId=?)', [convId]);
      await dbRun('DELETE FROM messages WHERE conversationId=?', [convId]);
      await dbRun('DELETE FROM conversations WHERE id=?', [convId]);
    }
    await dbRun('DELETE FROM invoices WHERE id IN (?,?)', [invoiceAId, invoiceBId]);
    await dbRun('DELETE FROM documents WHERE id IN (?,?,?)', [docVisibleId, docPrivateId, docOtherClientId]);
    await dbRun('DELETE FROM appearances WHERE id IN (?,?)', [appearanceAId, appearanceBId]);
    for (const matterId of [matterActiveId, matterClosedId, matterBId].filter(Boolean)) {
      await dbRun('DELETE FROM matter_stage_history WHERE matterId=?', [matterId]);
      await dbRun('DELETE FROM client_activity WHERE matterId=?', [matterId]);
      await dbRun('DELETE FROM notifications WHERE matterId=?', [matterId]);
      await dbRun('DELETE FROM matters WHERE id=?', [matterId]);
    }
    for (const clientId of [clientAId, clientBId, ...duplicateClientIds].filter(Boolean)) {
      await dbRun('DELETE FROM client_activity WHERE clientId=?', [clientId]);
      await dbRun('DELETE FROM clients WHERE id=?', [clientId]);
    }
  } finally {
    db.close();
  }
});

describe('1. Linked portal user sees the client\'s active matter', () => {
  test('client dashboard resolves the linked client record and lists the active matter', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.client?.id).toBe(clientAId);
    const active = res.body.matters.find(m => m.id === matterActiveId);
    expect(active).toBeDefined();
    expect(active.stage).toBe('Active');
    expect(active.clientId).toBe(clientAId);
  });
});

describe('2. Client isolation for matters', () => {
  test('dashboard never includes another client\'s matters', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.matters.some(m => m.id === matterBId)).toBe(false);
    expect(res.body.matters.every(m => m.clientId === clientAId)).toBe(true);
  });

  test('direct fetch of another client\'s matter is denied', async () => {
    const res = await request(app)
      .get(`/api/matters/${matterBId}`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });
});

describe('3. Closed-matter policy (documented)', () => {
  // POLICY: the client dashboard API returns ALL of the linked client's
  // matters regardless of stage; the portal UI derives "active matters" by
  // excluding Closed/Archived stages. Closed matters therefore remain visible
  // in the portal payload (history, invoices, documents stay reachable).
  test('a Closed matter for the linked client is still returned in the dashboard payload', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    const closed = res.body.matters.find(m => m.id === matterClosedId);
    expect(closed).toBeDefined();
    expect(closed.stage).toBe('Closed');
  });
});

describe('4. Staff-to-client messages reach the portal', () => {
  test('staff creates a thread for the client and sends a message', async () => {
    const convRes = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: clientAId, matterId: matterActiveId, subject: 'LP-FIX9 staff thread' });
    expect(convRes.statusCode).toBe(200);
    convAId = convRes.body.id;
    const msgRes = await request(app)
      .post(`/api/conversations/${convAId}/messages`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ body: 'Hello from the firm (LP-FIX9)' });
    expect(msgRes.statusCode).toBe(200);
  });

  test('client conversation list contains the staff thread (and not the unrelated one)', async () => {
    const res = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.some(conv => conv.id === convAId)).toBe(true);
    expect(res.body.some(conv => conv.id === convBId)).toBe(false);
  });

  test('client can read the staff message in the thread', async () => {
    const res = await request(app)
      .get(`/api/conversations/${convAId}/messages`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    const staffMessage = res.body.find(msg => msg.body === 'Hello from the firm (LP-FIX9)');
    expect(staffMessage).toBeDefined();
    expect(staffMessage.senderRole).not.toBe('client');
  });
});

describe('5. Client can reply on an accessible thread', () => {
  test('client reply is accepted', async () => {
    const res = await request(app)
      .post(`/api/conversations/${convAId}/messages`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ body: 'Reply from the client (LP-FIX9)' });
    expect(res.statusCode).toBe(200);
    expect(res.body.senderRole).toBe('client');
  });

  test('staff sees the client reply', async () => {
    const res = await request(app)
      .get(`/api/conversations/${convAId}/messages`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    const reply = res.body.find(msg => msg.body === 'Reply from the client (LP-FIX9)');
    expect(reply).toBeDefined();
    expect(reply.senderRole).toBe('client');
  });
});

describe('6. Client cannot reach unrelated threads or matters', () => {
  test('reading another client\'s thread is denied', async () => {
    const res = await request(app)
      .get(`/api/conversations/${convBId}/messages`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('posting into another client\'s thread is denied', async () => {
    const res = await request(app)
      .post(`/api/conversations/${convBId}/messages`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ body: 'should never land' });
    expect(res.statusCode).toBe(403);
    const leaked = await dbGet('SELECT id FROM messages WHERE conversationId=? AND body=?', [convBId, 'should never land']);
    expect(leaked).toBeUndefined();
  });

  test('starting a conversation on another client\'s matter is denied', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ matterId: matterBId, subject: 'should be blocked' });
    expect(res.statusCode).toBe(403);
  });
});

describe('7. Dashboard invoice/document/court-date isolation (same identity mapping)', () => {
  test('invoices: own invoice present, other client\'s absent', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.invoices.some(inv => inv.id === invoiceAId)).toBe(true);
    expect(res.body.invoices.some(inv => inv.id === invoiceBId)).toBe(false);
  });

  test('documents: client-visible doc present, staff-only and other-client docs absent', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    const ids = res.body.documents.map(doc => doc.id);
    expect(ids).toContain(docVisibleId);
    expect(ids).not.toContain(docPrivateId);
    expect(ids).not.toContain(docOtherClientId);
  });

  test('court dates: own matter\'s appearance present, other client\'s absent', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.appearances.some(a => a.id === appearanceAId)).toBe(true);
    expect(res.body.appearances.some(a => a.id === appearanceBId)).toBe(false);
  });
});

describe('8. Linking workflow hardening (root-cause regression)', () => {
  test('registering a client user with a client NAME as clientId is rejected', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: NAME_LINK_EMAIL, password: PORTAL_PASSWORD, fullName: 'LP Fix9 Name Link', role: 'client', clientId: CLIENT_A_NAME });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Linked client not found');
    const created = await dbGet('SELECT id FROM users WHERE email=?', [NAME_LINK_EMAIL]);
    expect(created).toBeUndefined();
  });

  test('registering a client user without a clientId is still rejected', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: NAME_LINK_EMAIL, password: PORTAL_PASSWORD, fullName: 'LP Fix9 Name Link', role: 'client' });
    expect(res.statusCode).toBe(400);
  });

  test('staff (non-client) registration is unaffected by the new check', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: ORPHAN_EMAIL, password: PORTAL_PASSWORD, fullName: 'LP Fix9 Staffer', role: 'assistant' });
    expect(res.statusCode).toBe(200);
    await dbRun('DELETE FROM users WHERE email=?', [ORPHAN_EMAIL]);
  });
});

describe('9. repairClientUserLinks heals name-linked portal users', () => {
  test('a client user whose clientId is exactly one client\'s name is relinked to the record id', async () => {
    await dbRun('INSERT INTO users (id,email,password,fullName,role,clientId,createdAt,tokenVersion) VALUES (?,?,?,?,?,?,?,?)',
      ['U-LP9-NAMELINK', NAME_LINK_EMAIL, 'x', 'LP Fix9 Name Link', 'client', CLIENT_A_NAME, new Date().toISOString(), 1]);
    await repairClientUserLinks();
    const row = await dbGet('SELECT clientId FROM users WHERE email=?', [NAME_LINK_EMAIL]);
    expect(row.clientId).toBe(clientAId);
  });

  test('a clientId matching no client record and no client name is left untouched', async () => {
    await dbRun('INSERT INTO users (id,email,password,fullName,role,clientId,createdAt,tokenVersion) VALUES (?,?,?,?,?,?,?,?)',
      ['U-LP9-ORPHAN', ORPHAN_EMAIL, 'x', 'LP Fix9 Orphan', 'client', 'No Such Client LP9', new Date().toISOString(), 1]);
    await repairClientUserLinks();
    const row = await dbGet('SELECT clientId FROM users WHERE email=?', [ORPHAN_EMAIL]);
    expect(row.clientId).toBe('No Such Client LP9');
  });

  test('an ambiguous name (two clients share it) is not auto-relinked', async () => {
    const dup1 = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: DUPLICATE_NAME, type: 'Individual' });
    const dup2 = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: DUPLICATE_NAME, type: 'Individual' });
    expect(dup1.statusCode).toBe(200);
    expect(dup2.statusCode).toBe(200);
    duplicateClientIds = [dup1.body.id, dup2.body.id];
    await dbRun('INSERT INTO users (id,email,password,fullName,role,clientId,createdAt,tokenVersion) VALUES (?,?,?,?,?,?,?,?)',
      ['U-LP9-AMBIG', AMBIGUOUS_EMAIL, 'x', 'LP Fix9 Ambiguous', 'client', DUPLICATE_NAME, new Date().toISOString(), 1]);
    await repairClientUserLinks();
    const row = await dbGet('SELECT clientId FROM users WHERE email=?', [AMBIGUOUS_EMAIL]);
    expect(row.clientId).toBe(DUPLICATE_NAME);
  });
});
