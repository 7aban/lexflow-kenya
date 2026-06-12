const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app } = require('../server.js');

const RUN = `LP22-${Date.now()}`;
const CLIENT_A_EMAIL = `lp22-a-${Date.now()}@test.lexflow.co.ke`;
const CLIENT_B_EMAIL = `lp22-b-${Date.now()}@test.lexflow.co.ke`;
const CLIENT_PASS = 'Portal22!Pass';

const db = new sqlite3.Database(config.DATABASE_PATH);
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, err => err ? reject(err) : resolve());
});

let adminToken;
let clientAToken;
let clientAId;
let clientBId;
let matterAId;
let matterBId;
const invoiceAId = `${RUN}-INV-A`;
const invoiceBId = `${RUN}-INV-B`;
const visibleDocAId = `${RUN}-DOC-A-VISIBLE`;
const privateDocAId = `${RUN}-DOC-A-PRIVATE`;
const visibleDocBId = `${RUN}-DOC-B-VISIBLE`;
const noticeAId = `${RUN}-NOTICE-A`;
const noticeBId = `${RUN}-NOTICE-B`;

beforeAll(async () => {
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  expect(adminRes.statusCode).toBe(200);
  adminToken = adminRes.body.token;

  const clientA = await request(app)
    .post('/api/clients')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `${RUN} Client A`, type: 'Individual', email: CLIENT_A_EMAIL });
  expect(clientA.statusCode).toBe(200);
  clientAId = clientA.body.id;

  const clientB = await request(app)
    .post('/api/clients')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `${RUN} Client B`, type: 'Individual', email: CLIENT_B_EMAIL });
  expect(clientB.statusCode).toBe(200);
  clientBId = clientB.body.id;

  const userA = await request(app)
    .post('/api/auth/register')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: CLIENT_A_EMAIL, password: CLIENT_PASS, fullName: `${RUN} Portal A`, role: 'client', clientId: clientAId });
  expect(userA.statusCode).toBe(200);

  const userB = await request(app)
    .post('/api/auth/register')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: CLIENT_B_EMAIL, password: CLIENT_PASS, fullName: `${RUN} Portal B`, role: 'client', clientId: clientBId });
  expect(userB.statusCode).toBe(200);

  const loginA = await request(app)
    .post('/api/auth/client-login')
    .send({ email: CLIENT_A_EMAIL, password: CLIENT_PASS });
  expect(loginA.statusCode).toBe(200);
  expect(loginA.body.user.role).toBe('client');
  expect(loginA.body.user.clientId).toBe(clientAId);
  clientAToken = loginA.body.token;

  const matterA = await request(app)
    .post('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title: `${RUN} Matter A`, clientId: clientAId, practiceArea: 'Civil', stage: 'Active' });
  expect(matterA.statusCode).toBe(200);
  matterAId = matterA.body.id;

  const matterB = await request(app)
    .post('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title: `${RUN} Matter B`, clientId: clientBId, practiceArea: 'Civil', stage: 'Active' });
  expect(matterB.statusCode).toBe(200);
  matterBId = matterB.body.id;

  await dbRun('INSERT INTO invoices (id,matterId,clientId,number,date,amount,status,dueDate,description,source) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [invoiceAId, matterAId, clientAId, `${RUN}-A-001`, '2026-06-12', 1000, 'Outstanding', '2026-07-12', 'Client A invoice', 'manual']);
  await dbRun('INSERT INTO invoices (id,matterId,clientId,number,date,amount,status,dueDate,description,source) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [invoiceBId, matterBId, clientBId, `${RUN}-B-001`, '2026-06-12', 2000, 'Outstanding', '2026-07-12', 'Client B invoice', 'manual']);
  await dbRun('INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,clientVisible,uploadedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [visibleDocAId, matterAId, `${RUN}-visible-a.txt`, 'Client A visible document', 'Text', 'text/plain', '2026-06-12', '1 KB', Buffer.from('visible-a'), 'firm', 1, 'admin']);
  await dbRun('INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,clientVisible,uploadedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [privateDocAId, matterAId, `${RUN}-private-a.txt`, 'Client A private document', 'Text', 'text/plain', '2026-06-12', '1 KB', Buffer.from('private-a'), 'firm', 0, 'admin']);
  await dbRun('INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,clientVisible,uploadedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [visibleDocBId, matterBId, `${RUN}-visible-b.txt`, 'Client B visible document', 'Text', 'text/plain', '2026-06-12', '1 KB', Buffer.from('visible-b'), 'firm', 1, 'admin']);
  await dbRun('INSERT INTO firm_notices (id,title,content,createdAt,createdBy,clientId) VALUES (?,?,?,?,?,?)',
    [noticeAId, `${RUN} Notice A`, 'Visible to client A', '2026-06-12T08:00:00.000Z', 'Admin', clientAId]);
  await dbRun('INSERT INTO firm_notices (id,title,content,createdAt,createdBy,clientId) VALUES (?,?,?,?,?,?)',
    [noticeBId, `${RUN} Notice B`, 'Visible to client B', '2026-06-12T08:00:00.000Z', 'Admin', clientBId]);
});

afterAll(async () => {
  try {
    await dbRun('DELETE FROM firm_notices WHERE id IN (?,?)', [noticeAId, noticeBId]);
    await dbRun('DELETE FROM documents WHERE id IN (?,?,?)', [visibleDocAId, privateDocAId, visibleDocBId]);
    await dbRun('DELETE FROM invoices WHERE id IN (?,?)', [invoiceAId, invoiceBId]);
    for (const matterId of [matterAId, matterBId].filter(Boolean)) {
      await dbRun('DELETE FROM matter_stage_history WHERE matterId=?', [matterId]);
      await dbRun('DELETE FROM client_activity WHERE matterId=?', [matterId]);
      await dbRun('DELETE FROM notifications WHERE matterId=?', [matterId]);
      await dbRun('DELETE FROM matters WHERE id=?', [matterId]);
    }
    await dbRun('DELETE FROM users WHERE email IN (?,?)', [CLIENT_A_EMAIL, CLIENT_B_EMAIL]);
    await dbRun('DELETE FROM client_activity WHERE clientId IN (?,?)', [clientAId, clientBId]);
    await dbRun('DELETE FROM clients WHERE id IN (?,?)', [clientAId, clientBId]);
  } finally {
    db.close();
  }
});

describe('LOCAL-PILOT-FIX-22 client portal route/access regression', () => {
  test('client login works through the client-login route', async () => {
    const res = await request(app)
      .post('/api/auth/client-login')
      .send({ email: CLIENT_A_EMAIL, password: CLIENT_PASS });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe('client');
    expect(res.body.user.clientId).toBe(clientAId);
  });

  test('client dashboard endpoint works for a linked client', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientAToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.client.id).toBe(clientAId);
    expect(res.body.matters.some(m => m.id === matterAId)).toBe(true);
  });

  test('client sees only own matters, documents, invoices, and notices', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientAToken}`);
    expect(res.statusCode).toBe(200);

    expect(res.body.matters.every(m => m.clientId === clientAId)).toBe(true);
    expect(res.body.matters.some(m => m.id === matterBId)).toBe(false);

    const documentIds = res.body.documents.map(d => d.id);
    expect(documentIds).toContain(visibleDocAId);
    expect(documentIds).not.toContain(privateDocAId);
    expect(documentIds).not.toContain(visibleDocBId);

    const invoiceIds = res.body.invoices.map(i => i.id);
    expect(invoiceIds).toContain(invoiceAId);
    expect(invoiceIds).not.toContain(invoiceBId);

    const noticeIds = res.body.notices.map(n => n.id);
    expect(noticeIds).toContain(noticeAId);
    expect(noticeIds).not.toContain(noticeBId);
  });

  test('staff-only routes remain blocked for a client token', async () => {
    const res = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${clientAToken}`);
    expect(res.statusCode).toBe(403);
  });
});
