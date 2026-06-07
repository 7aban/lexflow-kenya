const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

function dbRun(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { db.run(sql, params, err => { db.close(); err ? reject(err) : resolve(); }); });
}
function dbGet(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { db.get(sql, params, (err, row) => { db.close(); err ? reject(err) : resolve(row); }); });
}
function auth(token) { return { Authorization: `Bearer ${token}` }; }

const ADMIN = { email: 'admin@lexflow.co.ke', password: 'password123' };
const ADVOCATE = { email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' };
const ASSISTANT = { email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' };
const CLIENT = { email: 'margaret.wairimu@example.co.ke', password: 'password123' };

const RUN = Date.now();
const SECRET_DOC_BLOB = 'SECRET_DOC_BLOB_CONTENT_DO_NOT_LEAK';
const MATTER_ID = `MAT-TL-${RUN}`;
const OTHER_MATTER_ID = `MAT-TL-OTHER-${RUN}`;
const createdMatterIds = [MATTER_ID, OTHER_MATTER_ID];

describe('TIMELINE-30B unified matter timeline read route', () => {
  let adminToken, advocateToken, assistantToken, clientToken;
  let advocateName;
  let originalBillingVisibility;

  beforeAll(async () => {
    await dbReady;
    const a = await request(app).post('/api/auth/login').send(ADMIN); adminToken = a.body.token;
    const adv = await request(app).post('/api/auth/login').send(ADVOCATE); advocateToken = adv.body.token; advocateName = adv.body.user.fullName;
    const asst = await request(app).post('/api/auth/login').send(ASSISTANT); assistantToken = asst.body.token;
    const cl = await request(app).post('/api/auth/client-login').send(CLIENT); clientToken = cl.body.token;

    const bill = await dbGet('SELECT advocateBillingVisibility FROM firm_settings LIMIT 1');
    originalBillingVisibility = bill ? bill.advocateBillingVisibility : 1;

    // Matter assigned to the advocate (so advocate access matches by fullName).
    await dbRun("INSERT INTO matters (id, reference, clientId, title, stage, assignedTo, openDate, priority, billingType) VALUES (?,?,?,?,?,?,?,?,?)",
      [MATTER_ID, `TL-${RUN}`, '', 'Timeline test matter', 'Active', advocateName, '2026-01-01', 'Medium', 'hourly']);
    // A matter NOT assigned to the advocate.
    await dbRun("INSERT INTO matters (id, reference, clientId, title, stage, assignedTo, openDate, priority, billingType) VALUES (?,?,?,?,?,?,?,?,?)",
      [OTHER_MATTER_ID, `TL-OTHER-${RUN}`, '', 'Other matter', 'Active', 'Nobody Unassigned', '2026-01-02', 'Medium', 'hourly']);

    // One row per event source on MATTER_ID, with distinct ascending dates.
    await dbRun("INSERT INTO case_notes (id, matterId, content, author, createdAt) VALUES (?,?,?,?,?)",
      [`CN-${RUN}`, MATTER_ID, 'Timeline note body', advocateName, '2026-02-01T09:00:00.000Z']);
    await dbRun("INSERT INTO tasks (id, matterId, title, completed, assignee, dueDate) VALUES (?,?,?,?,?,?)",
      [`TK-${RUN}`, MATTER_ID, 'Timeline task', 0, advocateName, '2026-03-01']);
    await dbRun("INSERT INTO appearances (id, matterId, title, date, time, type, location, attorney) VALUES (?,?,?,?,?,?,?,?)",
      [`AP-${RUN}`, MATTER_ID, 'Mention', '2026-04-01', '10:00', 'Mention', 'Milimani', advocateName]);
    await dbRun("INSERT INTO documents (id, matterId, name, displayName, type, mimeType, date, size, content, source, clientVisible, uploadedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [`DOC-${RUN}`, MATTER_ID, 'pleading.pdf', 'Pleading', 'PDF', 'application/pdf', '2026-05-01', '1 KB', Buffer.from(SECRET_DOC_BLOB), 'firm', 0, advocateName]);
    await dbRun("INSERT INTO time_entries (id, matterId, attorney, date, hours, activity, description, rate, billed, billable) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [`TE-${RUN}`, MATTER_ID, advocateName, '2026-06-01', 2.5, 'Drafting', 'Drafted pleadings', 150, 0, 1]);
    await dbRun("INSERT INTO invoices (id, matterId, clientId, number, date, amount, status, dueDate, description, source) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [`INV-${RUN}`, MATTER_ID, '', `INV-TL-${RUN}`, '2026-07-01', 5000, 'Outstanding', '2026-07-31', 'Fees', 'time']);
    await dbRun("INSERT INTO deadlines (id, matterId, clientId, title, type, dueDate, owner, status, notes, createdBy, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [`DL-${RUN}`, MATTER_ID, '', 'File response', 'court', '2026-08-01', advocateName, 'Open', '', '', '2026-07-15T09:00:00.000Z']);
    await dbRun("INSERT INTO payments (id, invoiceId, matterId, clientId, amount, method, reference, date, note, createdBy, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [`PAY-${RUN}`, `INV-${RUN}`, MATTER_ID, '', 3000, 'mpesa', 'REF123', '2026-09-01', '', adminToken ? 'admin' : '', '2026-09-01T09:00:00.000Z']);
    await dbRun("INSERT INTO matter_checklist_items (id, matterId, title, completed, position, dueDate, assignee, createdBy, createdAt) VALUES (?,?,?,?,?,?,?,?,?)",
      [`CK-${RUN}`, MATTER_ID, 'Conflict check', 0, 0, '2026-02-15', advocateName, advocateName, '2026-02-10T09:00:00.000Z']);
  });

  afterAll(async () => {
    await dbRun('UPDATE firm_settings SET advocateBillingVisibility=?', [originalBillingVisibility]);
    await dbRun('DELETE FROM case_notes WHERE id=?', [`CN-${RUN}`]);
    await dbRun('DELETE FROM tasks WHERE id=?', [`TK-${RUN}`]);
    await dbRun('DELETE FROM appearances WHERE id=?', [`AP-${RUN}`]);
    await dbRun('DELETE FROM documents WHERE id=?', [`DOC-${RUN}`]);
    await dbRun('DELETE FROM time_entries WHERE id=?', [`TE-${RUN}`]);
    await dbRun('DELETE FROM payments WHERE id=?', [`PAY-${RUN}`]);
    await dbRun('DELETE FROM invoices WHERE id=?', [`INV-${RUN}`]);
    await dbRun('DELETE FROM deadlines WHERE id=?', [`DL-${RUN}`]);
    await dbRun('DELETE FROM matter_checklist_items WHERE id=?', [`CK-${RUN}`]);
    for (const id of createdMatterIds) {
      await dbRun('DELETE FROM audit_events WHERE entity_id=?', [id]);
      await dbRun('DELETE FROM matters WHERE id=?', [id]);
    }
  });

  async function timeline(token, matterId = MATTER_ID, query = {}) {
    return request(app).get(`/api/matters/${matterId}/timeline`).set(auth(token)).query(query);
  }

  test('1. Admin can retrieve timeline for a matter', async () => {
    const res = await timeline(adminToken);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.count).toBeGreaterThan(0);
  });

  test('2. Assistant can retrieve timeline', async () => {
    const res = await timeline(assistantToken);
    expect(res.statusCode).toBe(200);
    expect(res.body.events.length).toBeGreaterThan(0);
  });

  test('3. Advocate can retrieve assigned matter timeline', async () => {
    const res = await timeline(advocateToken);
    expect(res.statusCode).toBe(200);
    expect(res.body.events.length).toBeGreaterThan(0);
  });

  test('4. Advocate cannot retrieve unassigned matter timeline', async () => {
    const res = await timeline(advocateToken, OTHER_MATTER_ID);
    expect(res.statusCode).toBe(403);
  });

  test('5. Client gets 403', async () => {
    const res = await timeline(clientToken);
    expect(res.statusCode).toBe(403);
  });

  test('6. Missing matter gets 404', async () => {
    const res = await timeline(adminToken, `MAT-NOPE-${RUN}`);
    expect(res.statusCode).toBe(404);
  });

  test('7-15. Timeline includes each v1 event source', async () => {
    const res = await timeline(adminToken);
    const types = new Set(res.body.events.map(e => e.type));
    for (const t of ['matter_opened', 'note', 'task', 'appearance', 'document', 'time_entry', 'invoice', 'deadline', 'payment']) {
      expect(types.has(t)).toBe(true);
    }
  });

  test('16. Events are normalized to required shape', async () => {
    const res = await timeline(adminToken);
    for (const e of res.body.events) {
      for (const key of ['id', 'type', 'title', 'date', 'summary', 'actor', 'sourceId', 'sourceType', 'matterId', 'metadata']) {
        expect(e).toHaveProperty(key);
      }
      expect(e.matterId).toBe(MATTER_ID);
      expect(typeof e.metadata).toBe('object');
    }
  });

  test('17. Events sort descending by date', async () => {
    const res = await timeline(adminToken);
    const times = res.body.events.map(e => Date.parse(e.date));
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
    }
  });

  test('18. type filter works', async () => {
    const res = await timeline(adminToken, MATTER_ID, { type: 'deadline' });
    expect(res.statusCode).toBe(200);
    expect(res.body.events.length).toBeGreaterThanOrEqual(1);
    expect(res.body.events.every(e => e.type === 'deadline')).toBe(true);
  });

  test('18b. invalid type filter rejected', async () => {
    const res = await timeline(adminToken, MATTER_ID, { type: 'salary' });
    expect(res.statusCode).toBe(400);
  });

  test('19. limit works and is capped', async () => {
    const limited = await timeline(adminToken, MATTER_ID, { limit: 2 });
    expect(limited.body.events.length).toBe(2);
    const over = await timeline(adminToken, MATTER_ID, { limit: 99999 });
    expect(over.statusCode).toBe(200);
    expect(over.body.events.length).toBeLessThanOrEqual(500);
  });

  test('20. Document event does not expose content/blob/base64', async () => {
    const res = await timeline(adminToken);
    const docEvent = res.body.events.find(e => e.type === 'document');
    expect(docEvent).toBeTruthy();
    expect(docEvent.metadata).not.toHaveProperty('content');
    expect(JSON.stringify(res.body)).not.toContain(SECRET_DOC_BLOB);
    expect(JSON.stringify(res.body)).not.toContain(Buffer.from(SECRET_DOC_BLOB).toString('base64'));
  });

  test('21. Response excludes sensitive fields', async () => {
    const res = await timeline(adminToken);
    const blob = JSON.stringify(res.body);
    for (const forbidden of ['passwordHash', 'tokenVersion', 'accessToken', 'refreshToken', 'providerSubject', 'salary', 'allowance', 'medical']) {
      expect(blob).not.toContain(forbidden);
    }
  });

  test('22. Billing monetary fields masked for advocate without billing visibility', async () => {
    // Admin (always billing-visible) sees amounts.
    const adminRes = await timeline(adminToken);
    const adminInvoice = adminRes.body.events.find(e => e.type === 'invoice');
    expect(adminInvoice.metadata).toHaveProperty('amount');
    const adminTime = adminRes.body.events.find(e => e.type === 'time_entry');
    expect(adminTime.metadata).toHaveProperty('rate');

    // Hide advocate billing, then advocate must not receive monetary fields.
    await dbRun('UPDATE firm_settings SET advocateBillingVisibility=0');
    try {
      const advRes = await timeline(advocateToken);
      const invoice = advRes.body.events.find(e => e.type === 'invoice');
      const time = advRes.body.events.find(e => e.type === 'time_entry');
      const payment = advRes.body.events.find(e => e.type === 'payment');
      expect(invoice.metadata).not.toHaveProperty('amount');
      expect(time.metadata).not.toHaveProperty('rate');
      expect(payment.metadata).not.toHaveProperty('amount');
    } finally {
      await dbRun('UPDATE firm_settings SET advocateBillingVisibility=?', [originalBillingVisibility]);
    }
  });

  test('23. Route is read-only: no rows created/updated/deleted', async () => {
    const count = async (t) => (await dbGet(`SELECT COUNT(*) c FROM ${t} WHERE matterId=?`, [MATTER_ID])).c;
    const before = { notes: await count('case_notes'), tasks: await count('tasks'), docs: await count('documents'), inv: await count('invoices') };
    await timeline(adminToken);
    await timeline(adminToken, MATTER_ID, { type: 'note' });
    const after = { notes: await count('case_notes'), tasks: await count('tasks'), docs: await count('documents'), inv: await count('invoices') };
    expect(after).toEqual(before);
  });

  test('24. The 30B timeline route adds no timeline tables and is read-only', async () => {
    // TIMELINE-30D intentionally introduced matter_stage_history in a later phase, so it
    // is no longer asserted absent here. The 30B route must still not create timeline
    // tables of its own, and merely viewing the timeline must not write stage history.
    const tables = (await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(config.DATABASE_PATH);
      db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows) => { db.close(); err ? reject(err) : resolve(rows); });
    })).map(t => t.name);
    expect(tables).not.toContain('matter_timeline');
    expect(tables).not.toContain('matter_timeline_events');

    const before = (await dbGet('SELECT COUNT(*) c FROM matter_stage_history WHERE matterId=?', [MATTER_ID])).c;
    await timeline(adminToken);
    const after = (await dbGet('SELECT COUNT(*) c FROM matter_stage_history WHERE matterId=?', [MATTER_ID])).c;
    expect(after).toBe(before);
  });
});
