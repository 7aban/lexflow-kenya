const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

function dbRun(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    db.run(sql, params, err => {
      db.close();
      err ? reject(err) : resolve();
    });
  });
}

function dbGet(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      db.close();
      err ? reject(err) : resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      db.close();
      err ? reject(err) : resolve(rows);
    });
  });
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

const ADMIN_EMAIL = 'admin@lexflow.co.ke';
const ADMIN_PASSWORD = 'password123';
const ADVOCATE_EMAIL = 'sarah.mwangi@achokilaw.co.ke';
const ADVOCATE_PASSWORD = 'password123';
const ASSISTANT_EMAIL = 'david.wanjiku@achokilaw.co.ke';
const ASSISTANT_PASSWORD = 'password123';
const CLIENT_EMAIL = 'margaret.wairimu@example.co.ke';
const CLIENT_PASSWORD = 'password123';

// A small, valid PDF-ish payload encoded as a data URL.
const PDF_BYTES = Buffer.from('%PDF-1.4\nHR-29E test document body\n%%EOF');
const PDF_BASE64 = PDF_BYTES.toString('base64');
const PDF_DATA_URL = `data:application/pdf;base64,${PDF_BASE64}`;

const SECRET_NOTES = 'CONFIDENTIAL-CONTRACT-NOTE-XYZ-do-not-leak';

const createdDocIds = [];
const createdContractIds = [];

describe('HR-29E contracts and HR document records', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let advocateUserId;
  let assistantUserId;
  let clientUserId;

  beforeAll(async () => {
    await dbReady;

    const adminRes = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;

    const advocateRes = await request(app).post('/api/auth/login').send({ email: ADVOCATE_EMAIL, password: ADVOCATE_PASSWORD });
    expect(advocateRes.statusCode).toBe(200);
    advocateToken = advocateRes.body.token;
    advocateUserId = advocateRes.body.user.id;

    const assistantRes = await request(app).post('/api/auth/login').send({ email: ASSISTANT_EMAIL, password: ASSISTANT_PASSWORD });
    expect(assistantRes.statusCode).toBe(200);
    assistantToken = assistantRes.body.token;
    assistantUserId = assistantRes.body.user.id;

    const clientRes = await request(app).post('/api/auth/client-login').send({ email: CLIENT_EMAIL, password: CLIENT_PASSWORD });
    expect(clientRes.statusCode).toBe(200);
    clientToken = clientRes.body.token;
    clientUserId = clientRes.body.user.id;
  });

  afterAll(async () => {
    for (const id of createdContractIds) {
      await dbRun('DELETE FROM audit_events WHERE entity_id=?', [id]);
      await dbRun('DELETE FROM hr_contract_records WHERE id=?', [id]);
    }
    for (const id of createdDocIds) {
      await dbRun('DELETE FROM audit_events WHERE entity_id=?', [id]);
      await dbRun('DELETE FROM hr_documents WHERE id=?', [id]);
    }
  });

  async function uploadDocument(token, overrides = {}) {
    const payload = {
      userId: advocateUserId,
      documentType: 'contract',
      title: 'Employment contract 2026',
      fileName: 'contract-2026.pdf',
      mimeType: 'application/pdf',
      contentBase64: PDF_DATA_URL,
      ...overrides,
    };
    const res = await request(app).post('/api/hr/documents').set(auth(token)).send(payload);
    if (res.statusCode === 201 && res.body?.id) createdDocIds.push(res.body.id);
    return res;
  }

  // --- Schema -------------------------------------------------------------

  test('1. hr_documents table exists', async () => {
    const row = await dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name='hr_documents'");
    expect(row).toBeTruthy();
  });

  test('2. hr_contract_records table exists', async () => {
    const row = await dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name='hr_contract_records'");
    expect(row).toBeTruthy();
  });

  // --- HR documents access control + upload --------------------------------

  test('3. Admin can upload HR document for staff user', async () => {
    const res = await uploadDocument(adminToken);
    expect(res.statusCode).toBe(201);
    expect(res.body.userId).toBe(advocateUserId);
    expect(res.body.documentType).toBe('contract');
    expect(res.body.isActive).toBe(true);
    expect(res.body.content).toBeUndefined();
  });

  test('4. Admin cannot upload HR document for client user', async () => {
    const res = await uploadDocument(adminToken, { userId: clientUserId });
    expect(res.statusCode).toBe(400);
  });

  test('5. Advocate/assistant cannot upload HR document', async () => {
    const res1 = await uploadDocument(advocateToken);
    expect(res1.statusCode).toBe(403);
    const res2 = await uploadDocument(assistantToken);
    expect(res2.statusCode).toBe(403);
  });

  test('6. Client cannot access HR document routes', async () => {
    const list = await request(app).get('/api/hr/documents').set(auth(clientToken));
    expect(list.statusCode).toBe(403);
    const upload = await uploadDocument(clientToken);
    expect(upload.statusCode).toBe(403);
    const contracts = await request(app).get('/api/hr/contracts').set(auth(clientToken));
    expect(contracts.statusCode).toBe(403);
  });

  test('7. HR document list returns metadata only and excludes content', async () => {
    await uploadDocument(adminToken);
    const res = await request(app).get('/api/hr/documents').set(auth(adminToken)).query({ userId: advocateUserId });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    for (const doc of res.body) {
      expect(doc.content).toBeUndefined();
      expect(doc.id).toBeTruthy();
      expect(doc.title).toBeTruthy();
    }
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(PDF_BASE64);
  });

  test('8. HR document content download returns correct MIME/content for admin', async () => {
    const upload = await uploadDocument(adminToken);
    expect(upload.statusCode).toBe(201);
    const res = await request(app).get(`/api/hr/documents/${upload.body.id}/content`).set(auth(adminToken));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(Buffer.from(res.body).equals(PDF_BYTES)).toBe(true);
  });

  test('9. Invalid MIME rejected', async () => {
    const res = await uploadDocument(adminToken, { mimeType: 'application/zip' });
    expect(res.statusCode).toBe(400);
  });

  test('10. Invalid documentType rejected', async () => {
    const res = await uploadDocument(adminToken, { documentType: 'salary_slip' });
    expect(res.statusCode).toBe(400);
  });

  test('11. Empty/invalid base64 rejected', async () => {
    const empty = await uploadDocument(adminToken, { contentBase64: '' });
    expect(empty.statusCode).toBe(400);
    const invalid = await uploadDocument(adminToken, { contentBase64: 'data:application/pdf;base64,@@@not-base64@@@' });
    expect(invalid.statusCode).toBe(400);
  });

  test('12. Soft delete marks document inactive and excludes it from default list', async () => {
    const upload = await uploadDocument(adminToken);
    const id = upload.body.id;
    const del = await request(app).delete(`/api/hr/documents/${id}`).set(auth(adminToken));
    expect(del.statusCode).toBe(200);

    const row = await dbGet('SELECT isActive, deletedBy, deletedAt FROM hr_documents WHERE id=?', [id]);
    expect(row.isActive).toBe(0);
    expect(row.deletedBy).toBeTruthy();
    expect(row.deletedAt).toBeTruthy();

    const defaultList = await request(app).get('/api/hr/documents').set(auth(adminToken)).query({ userId: advocateUserId });
    expect(defaultList.body.some(d => d.id === id)).toBe(false);

    const inactiveList = await request(app).get('/api/hr/documents').set(auth(adminToken)).query({ userId: advocateUserId, includeInactive: 'true' });
    expect(inactiveList.body.some(d => d.id === id)).toBe(true);

    // Inactive documents cannot be downloaded.
    const download = await request(app).get(`/api/hr/documents/${id}/content`).set(auth(adminToken));
    expect(download.statusCode).toBe(404);
  });

  test('13. Audit event hr_document_uploaded recorded without content/base64', async () => {
    const upload = await uploadDocument(adminToken);
    const id = upload.body.id;
    const rows = await dbAll("SELECT metadata_json FROM audit_events WHERE entity_id=? AND action='hr_document_uploaded'", [id]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const meta = JSON.parse(rows[0].metadata_json || '{}');
    expect(meta.documentId).toBe(id);
    expect(meta.userId).toBe(advocateUserId);
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain(PDF_BASE64);
    expect(serialized.toLowerCase()).not.toContain('content');
    expect(serialized).not.toContain('base64');
  });

  test('14. Audit event hr_document_deleted recorded without content/base64', async () => {
    const upload = await uploadDocument(adminToken);
    const id = upload.body.id;
    await request(app).delete(`/api/hr/documents/${id}`).set(auth(adminToken));
    const rows = await dbAll("SELECT metadata_json FROM audit_events WHERE entity_id=? AND action='hr_document_deleted'", [id]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(JSON.parse(rows[0].metadata_json || '{}'));
    expect(serialized).not.toContain(PDF_BASE64);
    expect(serialized).not.toContain('base64');
  });

  // --- Contract records ----------------------------------------------------

  async function createContract(token, overrides = {}) {
    const payload = {
      userId: advocateUserId,
      contractType: 'permanent',
      startDate: '2026-01-01',
      status: 'active',
      ...overrides,
    };
    const res = await request(app).post('/api/hr/contracts').set(auth(token)).send(payload);
    if (res.statusCode === 201 && res.body?.id) createdContractIds.push(res.body.id);
    return res;
  }

  test('15. Admin can create contract record for staff user', async () => {
    const res = await createContract(adminToken);
    expect(res.statusCode).toBe(201);
    expect(res.body.userId).toBe(advocateUserId);
    expect(res.body.contractType).toBe('permanent');
    expect(res.body.status).toBe('active');
    expect(res.body.staff).toBeTruthy();
    expect(res.body.staff.fullName).toBeTruthy();
  });

  test('16. Admin cannot create contract record for client user', async () => {
    const res = await createContract(adminToken, { userId: clientUserId });
    expect(res.statusCode).toBe(400);
  });

  test('17. Invalid contractType rejected', async () => {
    const res = await createContract(adminToken, { contractType: 'gig' });
    expect(res.statusCode).toBe(400);
  });

  test('18. Invalid contract status rejected', async () => {
    const res = await createContract(adminToken, { status: 'paused' });
    expect(res.statusCode).toBe(400);
  });

  test('19. Invalid date rejected', async () => {
    const res1 = await createContract(adminToken, { startDate: '2026-13-45' });
    expect(res1.statusCode).toBe(400);
    const res2 = await createContract(adminToken, { endDate: 'not-a-date' });
    expect(res2.statusCode).toBe(400);
  });

  test('20. Contract can link to active HR document for same user', async () => {
    const upload = await uploadDocument(adminToken);
    const res = await createContract(adminToken, { documentId: upload.body.id });
    expect(res.statusCode).toBe(201);
    expect(res.body.documentId).toBe(upload.body.id);
    expect(res.body.document).toBeTruthy();
    expect(res.body.document.id).toBe(upload.body.id);
    expect(res.body.document.content).toBeUndefined();
  });

  test('21. Contract cannot link to another user\'s HR document', async () => {
    const upload = await uploadDocument(adminToken, { userId: assistantUserId });
    const res = await createContract(adminToken, { userId: advocateUserId, documentId: upload.body.id });
    expect(res.statusCode).toBe(400);
  });

  test('22. Contract cannot link to inactive/deleted document', async () => {
    const upload = await uploadDocument(adminToken);
    await request(app).delete(`/api/hr/documents/${upload.body.id}`).set(auth(adminToken));
    const res = await createContract(adminToken, { documentId: upload.body.id });
    expect(res.statusCode).toBe(400);
  });

  test('23. Admin can update contract record', async () => {
    const created = await createContract(adminToken, { status: 'active' });
    const res = await request(app)
      .patch(`/api/hr/contracts/${created.body.id}`)
      .set(auth(adminToken))
      .send({ status: 'expired', endDate: '2026-12-31' });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('expired');
    expect(res.body.endDate).toBe('2026-12-31');
  });

  test('24. Audit events hr_contract_recorded/hr_contract_updated recorded without notes text', async () => {
    const created = await createContract(adminToken, { notes: SECRET_NOTES });
    expect(created.statusCode).toBe(201);
    const id = created.body.id;

    // Notes are stored on the record itself...
    const stored = await dbGet('SELECT notes FROM hr_contract_records WHERE id=?', [id]);
    expect(stored.notes).toBe(SECRET_NOTES);

    const recordedRows = await dbAll("SELECT metadata_json FROM audit_events WHERE entity_id=? AND action='hr_contract_recorded'", [id]);
    expect(recordedRows.length).toBeGreaterThanOrEqual(1);
    const recordedMeta = JSON.parse(recordedRows[0].metadata_json || '{}');
    expect(recordedMeta.contractId).toBe(id);
    expect(JSON.stringify(recordedMeta)).not.toContain(SECRET_NOTES);
    expect(JSON.stringify(recordedMeta).toLowerCase()).not.toContain('notes');

    const upd = await request(app).patch(`/api/hr/contracts/${id}`).set(auth(adminToken)).send({ notes: `${SECRET_NOTES}-UPDATED`, status: 'superseded' });
    expect(upd.statusCode).toBe(200);
    const updatedRows = await dbAll("SELECT metadata_json FROM audit_events WHERE entity_id=? AND action='hr_contract_updated'", [id]);
    expect(updatedRows.length).toBeGreaterThanOrEqual(1);
    const updatedSerialized = JSON.stringify(updatedRows.map(r => JSON.parse(r.metadata_json || '{}')));
    expect(updatedSerialized).not.toContain(SECRET_NOTES);
    expect(updatedSerialized.toLowerCase()).not.toContain('notes');
  });

  // --- Privacy / no side effects ------------------------------------------

  test('25. Responses do not expose passwordHash/tokenVersion/avatar/auth/private fields', async () => {
    const upload = await uploadDocument(adminToken);
    const contract = await createContract(adminToken, { documentId: upload.body.id, notes: 'x' });

    const docList = await request(app).get('/api/hr/documents').set(auth(adminToken)).query({ userId: advocateUserId });
    const contractList = await request(app).get('/api/hr/contracts').set(auth(adminToken)).query({ userId: advocateUserId });

    const blobs = [JSON.stringify(upload.body), JSON.stringify(contract.body), JSON.stringify(docList.body), JSON.stringify(contractList.body)];
    const forbidden = ['passwordHash', 'password', 'tokenVersion', 'avatar', 'token', 'providerSubject', 'refreshToken', 'accessToken'];
    for (const blob of blobs) {
      for (const field of forbidden) {
        expect(blob).not.toContain(field);
      }
    }
  });

  test('26. No salary/allowance fields introduced', async () => {
    const docCols = (await dbAll('PRAGMA table_info(hr_documents)')).map(c => c.name);
    const contractCols = (await dbAll('PRAGMA table_info(hr_contract_records)')).map(c => c.name);
    for (const col of [...docCols, ...contractCols]) {
      expect(col.toLowerCase()).not.toContain('salary');
      expect(col.toLowerCase()).not.toContain('allowance');
      expect(col.toLowerCase()).not.toContain('wage');
    }
  });

  test('27. No matter document rows are created by HR document upload', async () => {
    const before = await dbGet('SELECT COUNT(*) AS cnt FROM documents');
    await uploadDocument(adminToken);
    const after = await dbGet('SELECT COUNT(*) AS cnt FROM documents');
    expect(after.cnt).toBe(before.cnt);
  });

  test('28. No clientVisible field/semantics used for HR documents', async () => {
    const docCols = (await dbAll('PRAGMA table_info(hr_documents)')).map(c => c.name);
    expect(docCols).not.toContain('clientVisible');
    const upload = await uploadDocument(adminToken);
    expect(upload.body.clientVisible).toBeUndefined();
  });

  test('29. No leave balances/requests are mutated by contract/document actions', async () => {
    const beforeReq = await dbGet('SELECT COUNT(*) AS cnt FROM hr_leave_requests');
    const beforeEnt = await dbGet('SELECT COUNT(*) AS cnt FROM hr_leave_entitlements');
    const beforeAdj = await dbGet('SELECT COUNT(*) AS cnt FROM hr_leave_balance_adjustments');

    const upload = await uploadDocument(adminToken);
    const contract = await createContract(adminToken, { documentId: upload.body.id });
    await request(app).patch(`/api/hr/contracts/${contract.body.id}`).set(auth(adminToken)).send({ status: 'terminated' });
    await request(app).delete(`/api/hr/documents/${upload.body.id}`).set(auth(adminToken));

    const afterReq = await dbGet('SELECT COUNT(*) AS cnt FROM hr_leave_requests');
    const afterEnt = await dbGet('SELECT COUNT(*) AS cnt FROM hr_leave_entitlements');
    const afterAdj = await dbGet('SELECT COUNT(*) AS cnt FROM hr_leave_balance_adjustments');

    expect(afterReq.cnt).toBe(beforeReq.cnt);
    expect(afterEnt.cnt).toBe(beforeEnt.cnt);
    expect(afterAdj.cnt).toBe(beforeAdj.cnt);
  });
});
