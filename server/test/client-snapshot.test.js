// CLIENT-31C — Client Snapshot v1 (staff-only, read-only aggregation, no schema).
// Verifies access control, aggregated content, billing masking, safe-field rules,
// attention flags, and that the route never writes data or creates tables.
const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken;
let advocateToken;     // Sarah Mwangi — assigned to Margaret's matters
let assistantToken;    // David Wanjiku
let clientToken;       // Margaret (client portal user)
let db;

// Target client = Margaret Wairimu (has matters assigned to Sarah Mwangi).
let margaretId;
let margaretMatterId;
let margaretMatterIds = [];
// A client with NO matter assigned to Sarah Mwangi (Grace Njeri) for the 403 case.
let graceId;

const PREFIX = 'SNAP31C-';
const SECRET_DOC = 'SECRETDOCCONTENT_SNAP31C';
const SECRET_MSG = 'SECRETMESSAGEBODY_SNAP31C';
let originalBillingVisibility = 1;

const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, err => (err ? reject(err) : resolve())));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

const isoDaysFromNow = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  await dbReady;
  db = new sqlite3.Database(config.DATABASE_PATH);

  adminToken = (await request(app).post('/api/auth/login').send({ email: 'admin@lexflow.co.ke', password: 'password123' })).body.token;
  advocateToken = (await request(app).post('/api/auth/login').send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' })).body.token;
  assistantToken = (await request(app).post('/api/auth/login').send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' })).body.token;
  clientToken = (await request(app).post('/api/auth/client-login').send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' })).body.token;

  const margaret = await get("SELECT id FROM clients WHERE name='Margaret Wairimu'");
  margaretId = margaret.id;
  const grace = await get("SELECT id FROM clients WHERE name='Grace Njeri'");
  graceId = grace.id;
  const matter = await get('SELECT id FROM matters WHERE clientId=? ORDER BY openDate DESC LIMIT 1', [margaretId]);
  margaretMatterId = matter.id;
  margaretMatterIds = (await all('SELECT id FROM matters WHERE clientId=?', [margaretId])).map(r => r.id);

  const billing = await get('SELECT advocateBillingVisibility FROM firm_settings LIMIT 1');
  originalBillingVisibility = billing ? Number(billing.advocateBillingVisibility) : 1;

  // Deterministic, prefixed fixtures so assertions are stable and cleanup is exact.
  await run('INSERT INTO appearances (id,matterId,title,date,time,type,location,attorney) VALUES (?,?,?,?,?,?,?,?)',
    [`${PREFIX}AP1`, margaretMatterId, 'Snapshot mention hearing', '2099-12-31', '09:30', 'Mention', 'Court 5', 'Sarah Mwangi']);
  await run('INSERT INTO deadlines (id,matterId,clientId,title,type,dueDate,owner,status,notes,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [`${PREFIX}DL1`, margaretMatterId, margaretId, 'Snapshot statutory filing', 'statutory', isoDaysFromNow(3), 'Sarah Mwangi', 'Open', 'fixture', 'admin', new Date().toISOString()]);
  await run('INSERT INTO document_requests (id,matterId,clientId,staffUserId,title,description,status,createdAt) VALUES (?,?,?,?,?,?,?,?)',
    [`${PREFIX}DR1`, margaretMatterId, margaretId, 'admin', 'Snapshot ID copy', 'fixture', 'pending', new Date().toISOString()]);
  await run('INSERT INTO invoices (id,matterId,clientId,number,date,amount,status,dueDate,description,source) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [`${PREFIX}INV1`, margaretMatterId, margaretId, 'SNAP-INV-1', '2020-01-01', 5000, 'Outstanding', '2020-02-01', 'fixture', 'time']);
  await run('INSERT INTO payment_proofs (id,invoiceId,matterId,clientId,method,reference,amount,note,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [`${PREFIX}PP1`, `${PREFIX}INV1`, margaretMatterId, margaretId, 'mpesa', 'REF1', 5000, 'fixture', 'Pending', new Date().toISOString()]);
  await run('INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,content,source,clientVisible) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [`${PREFIX}DOC1`, margaretMatterId, 'snap-secret.pdf', 'Snapshot Secret', 'pdf', 'application/pdf', '2026-06-08', Buffer.from(SECRET_DOC), 'firm', 0]);
  await run('INSERT INTO conversations (id,matterId,clientId,subject,createdAt) VALUES (?,?,?,?,?)',
    [`${PREFIX}CONV1`, margaretMatterId, margaretId, 'Snapshot thread', new Date().toISOString()]);
  await run('INSERT INTO messages (id,conversationId,senderId,senderRole,body,createdAt) VALUES (?,?,?,?,?,?)',
    [`${PREFIX}MSG1`, `${PREFIX}CONV1`, 'admin', 'admin', SECRET_MSG, new Date().toISOString()]);
});

afterAll(async () => {
  try {
    await run('UPDATE firm_settings SET advocateBillingVisibility=?', [originalBillingVisibility]);
    await run('DELETE FROM messages WHERE id=?', [`${PREFIX}MSG1`]);
    await run('DELETE FROM conversations WHERE id=?', [`${PREFIX}CONV1`]);
    await run('DELETE FROM documents WHERE id=?', [`${PREFIX}DOC1`]);
    await run('DELETE FROM payment_proofs WHERE id=?', [`${PREFIX}PP1`]);
    await run('DELETE FROM invoices WHERE id=?', [`${PREFIX}INV1`]);
    await run('DELETE FROM document_requests WHERE id=?', [`${PREFIX}DR1`]);
    await run('DELETE FROM deadlines WHERE id=?', [`${PREFIX}DL1`]);
    await run('DELETE FROM appearances WHERE id=?', [`${PREFIX}AP1`]);
  } finally {
    db.close();
  }
});

const snapshot = (clientId, token) => request(app).get(`/api/clients/${clientId}/snapshot`).set('Authorization', `Bearer ${token}`);

describe('CLIENT-31C - GET /api/clients/:id/snapshot', () => {
  test('1. Admin can retrieve snapshot', async () => {
    const res = await snapshot(margaretId, adminToken);
    expect(res.statusCode).toBe(200);
    expect(res.body.client.id).toBe(margaretId);
  });

  test('2. Assistant can retrieve snapshot', async () => {
    const res = await snapshot(margaretId, assistantToken);
    expect(res.statusCode).toBe(200);
  });

  test('3. Advocate assigned to a client matter can retrieve snapshot', async () => {
    const res = await snapshot(margaretId, advocateToken);
    expect(res.statusCode).toBe(200);
    expect(res.body.client.id).toBe(margaretId);
  });

  test('4. Advocate not assigned to any client matter gets 403', async () => {
    const res = await snapshot(graceId, advocateToken);
    expect(res.statusCode).toBe(403);
  });

  test('5. Client user gets 403', async () => {
    const res = await snapshot(margaretId, clientToken);
    expect(res.statusCode).toBe(403);
  });

  test('6. Missing client gets 404', async () => {
    const res = await snapshot('does-not-exist-xyz', adminToken);
    expect(res.statusCode).toBe(404);
  });

  test('7. Snapshot includes client identity/contact safe fields', async () => {
    const { body } = await snapshot(margaretId, adminToken);
    expect(body.client).toEqual(expect.objectContaining({
      id: margaretId, name: 'Margaret Wairimu',
      type: expect.any(String), status: expect.any(String), joinDate: expect.any(String),
      contact: expect.any(String), email: expect.any(String), phone: expect.any(String),
      conflictCleared: expect.any(Boolean),
    }));
  });

  test('8. Snapshot includes active and total matter counts', async () => {
    const { body } = await snapshot(margaretId, adminToken);
    expect(typeof body.matters.activeCount).toBe('number');
    expect(typeof body.matters.totalCount).toBe('number');
    expect(body.matters.totalCount).toBeGreaterThanOrEqual(body.matters.activeCount);
    expect(body.matters.totalCount).toBeGreaterThanOrEqual(1);
  });

  test('9. Snapshot includes next appearance when present', async () => {
    // The route returns the soonest future appearance across the client's matters
    // (the seed may provide an earlier one than the fixture — both are valid).
    const { body } = await snapshot(margaretId, adminToken);
    expect(body.matters.nextAppearance).not.toBeNull();
    expect(body.matters.nextAppearance.date >= new Date().toISOString().slice(0, 10)).toBe(true);
    expect(margaretMatterIds).toContain(body.matters.nextAppearance.matterId);
  });

  test('10. Snapshot includes open deadline count and next deadline', async () => {
    const { body } = await snapshot(margaretId, adminToken);
    expect(body.obligations.openDeadlinesCount).toBeGreaterThanOrEqual(1);
    expect(body.obligations.nextDeadline).not.toBeNull();
    expect(body.obligations.nextDeadline).toEqual(expect.objectContaining({ id: expect.any(String), title: expect.any(String), dueDate: expect.any(String) }));
  });

  test('11. Snapshot includes pending document request count', async () => {
    const { body } = await snapshot(margaretId, adminToken);
    expect(body.obligations.pendingDocumentRequestsCount).toBeGreaterThanOrEqual(1);
  });

  test('12. Snapshot includes billing values when billing is visible', async () => {
    const { body } = await snapshot(margaretId, adminToken);
    expect(body.billing.visible).toBe(true);
    expect(body.billing.outstandingBalance).toBeGreaterThanOrEqual(5000);
    expect(body.billing.overdueInvoiceCount).toBeGreaterThanOrEqual(1);
    expect(body.billing.pendingPaymentProofCount).toBeGreaterThanOrEqual(1);
  });

  test('13. Snapshot masks billing when advocate billing visibility is disabled', async () => {
    await run('UPDATE firm_settings SET advocateBillingVisibility=0');
    try {
      const { body } = await snapshot(margaretId, advocateToken);
      expect(body.billing.visible).toBe(false);
      expect(body.billing.outstandingBalance).toBeNull();
      expect(body.billing.overdueInvoiceCount).toBeNull();
      expect(body.billing.pendingPaymentProofCount).toBeNull();
      // Billing-derived attention flags must not leak when billing is masked.
      const keys = body.attentionFlags.map(f => f.key);
      expect(keys).not.toContain('unpaid_fees');
      expect(keys).not.toContain('overdue_invoices');
      expect(keys).not.toContain('pending_payment_proof');
    } finally {
      await run('UPDATE firm_settings SET advocateBillingVisibility=?', [originalBillingVisibility]);
    }
  });

  test('14. Snapshot includes recent document metadata only', async () => {
    const { body } = await snapshot(margaretId, adminToken);
    const doc = body.recentDocuments.find(d => d.id === `${PREFIX}DOC1`);
    expect(doc).toBeDefined();
    expect(doc).toEqual(expect.objectContaining({ id: `${PREFIX}DOC1`, name: 'snap-secret.pdf', mimeType: 'application/pdf' }));
    expect(body.recentDocuments.length).toBeLessThanOrEqual(5);
  });

  test('15. Snapshot does not expose document content/blob/base64', async () => {
    const { body } = await snapshot(margaretId, adminToken);
    for (const d of body.recentDocuments) {
      expect(d).not.toHaveProperty('content');
      expect(d).not.toHaveProperty('contentBase64');
    }
    expect(JSON.stringify(body)).not.toContain(SECRET_DOC);
    expect(JSON.stringify(body)).not.toContain(Buffer.from(SECRET_DOC).toString('base64'));
  });

  test('16. Snapshot does not expose message bodies, tokens, passwordHash, tokenVersion, HR or salary/medical data', async () => {
    const raw = JSON.stringify((await snapshot(margaretId, adminToken)).body);
    for (const forbidden of [SECRET_MSG, 'passwordHash', 'tokenVersion', 'password', 'salary', 'medical', 'metadata_json', 'accessTokenEncrypted']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  test('17. Snapshot returns attention flags derived from existing data', async () => {
    const { body } = await snapshot(margaretId, adminToken);
    expect(Array.isArray(body.attentionFlags)).toBe(true);
    const keys = body.attentionFlags.map(f => f.key);
    expect(keys).toContain('overdue_invoices');
    expect(keys).toContain('unpaid_fees');
    expect(keys).toContain('upcoming_deadline');
    expect(keys).toContain('pending_document_request');
    for (const flag of body.attentionFlags) {
      expect(flag).toEqual(expect.objectContaining({ key: expect.any(String), label: expect.any(String), severity: expect.any(String) }));
    }
  });

  test('18. Route is read-only: no rows created/updated/deleted', async () => {
    const tables = ['clients', 'matters', 'deadlines', 'invoices', 'payment_proofs', 'document_requests', 'appearances', 'documents', 'payments'];
    const before = {};
    for (const t of tables) before[t] = (await get(`SELECT COUNT(*) n FROM ${t}`)).n;
    const res = await snapshot(margaretId, adminToken);
    expect(res.statusCode).toBe(200);
    for (const t of tables) {
      const after = (await get(`SELECT COUNT(*) n FROM ${t}`)).n;
      expect(after).toBe(before[t]);
    }
  });

  test('19. No new tables are created by the route', async () => {
    const listTables = async () => (await all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map(r => r.name);
    const before = await listTables();
    await snapshot(margaretId, adminToken);
    const after = await listTables();
    expect(after).toEqual(before);
  });
});
