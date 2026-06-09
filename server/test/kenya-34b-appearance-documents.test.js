const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

let adminToken, advocateToken, assistantToken, clientToken;
let advocateFullName, accessibleMatterId, inaccessibleMatterId, clientId, clientMatterId;
let appearanceId, otherAppearanceId, clientAppearanceId;
let docInMatterId, docOtherMatterId, clientHiddenDocId, softDeletedDocId;
let linkId;

const createdAppearanceIds = [];
const createdDocumentIds = [];
const createdLinkIds = [];

// 4x4 transparent-ish PNG bytes are not needed; the upload route accepts any base64 body.
const SAMPLE_PDF_B64 = Buffer.from('%PDF-1.4 minimal test document body').toString('base64');

function dbAll(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { d.all(sql, params, (e, r) => { d.close(); e ? reject(e) : resolve(r); }); });
}
function dbGet(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { d.get(sql, params, (e, r) => { d.close(); e ? reject(e) : resolve(r); }); });
}
function dbRun(sql, params = []) {
  const d = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => { d.run(sql, params, function (e) { d.close(); e ? reject(e) : resolve(); }); });
}
async function tableCount(table) { return (await dbGet(`SELECT COUNT(*) AS n FROM ${table}`)).n; }

async function createAppearance(matterId, title) {
  const res = await request(app).post('/api/appearances').set('Authorization', `Bearer ${adminToken}`).send({
    matterId, title, date: '2099-12-01', time: '9:00 AM', type: 'Hearing',
  });
  expect(res.statusCode).toBe(200);
  createdAppearanceIds.push(res.body.id);
  return res.body.id;
}

async function createDocument(matterId, token, { clientVisible = false, name = 'evidence.pdf' } = {}) {
  const res = await request(app).post(`/api/matters/${matterId}/documents`).set('Authorization', `Bearer ${token}`).send({
    name, mimeType: 'application/pdf', data: SAMPLE_PDF_B64, clientVisible,
  });
  expect(res.statusCode).toBe(200);
  createdDocumentIds.push(res.body.id);
  return res.body.id;
}

beforeAll(async () => {
  await dbReady;
  adminToken = (await request(app).post('/api/auth/login').send({ email: 'admin@lexflow.co.ke', password: 'password123' })).body.token;
  advocateToken = (await request(app).post('/api/auth/login').send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' })).body.token;
  assistantToken = (await request(app).post('/api/auth/login').send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' })).body.token;
  clientToken = (await request(app).post('/api/auth/client-login').send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' })).body.token;
  advocateFullName = (await dbGet("SELECT fullName FROM users WHERE email='sarah.mwangi@achokilaw.co.ke'")).fullName;
  accessibleMatterId = (await dbGet('SELECT id FROM matters WHERE assignedTo=? LIMIT 1', [advocateFullName])).id;
  inaccessibleMatterId = (await dbGet("SELECT id FROM matters WHERE COALESCE(assignedTo,'')<>? LIMIT 1", [advocateFullName])).id;
  clientId = (await dbGet("SELECT clientId FROM users WHERE email='margaret.wairimu@example.co.ke' AND role='client'")).clientId;
  clientMatterId = (await dbGet('SELECT id FROM matters WHERE clientId=? LIMIT 1', [clientId])).id;

  appearanceId = await createAppearance(accessibleMatterId, '34B Hearing');
  otherAppearanceId = await createAppearance(inaccessibleMatterId, '34B Other Hearing');
  clientAppearanceId = await createAppearance(clientMatterId, '34B Client Hearing');

  docInMatterId = await createDocument(accessibleMatterId, adminToken, { name: '34b-in-matter.pdf' });
  docOtherMatterId = await createDocument(inaccessibleMatterId, adminToken, { name: '34b-other-matter.pdf' });
  clientHiddenDocId = await createDocument(clientMatterId, adminToken, { clientVisible: false, name: 'KENYA34B-HIDDEN-SECRET.pdf' });
  softDeletedDocId = await createDocument(accessibleMatterId, adminToken, { name: '34b-soft-deleted.pdf' });
  await dbRun('UPDATE documents SET deletedAt=? WHERE id=?', [new Date().toISOString(), softDeletedDocId]);
});

afterAll(async () => {
  for (const id of createdLinkIds) { try { await dbRun('DELETE FROM appearance_documents WHERE id=?', [id]); } catch {} }
  try { await dbRun('DELETE FROM appearance_documents WHERE appearanceId IN (' + createdAppearanceIds.map(() => '?').join(',') + ')', createdAppearanceIds); } catch {}
  for (const id of createdDocumentIds) { try { await dbRun('DELETE FROM documents WHERE id=?', [id]); } catch {} }
  for (const id of createdAppearanceIds) { try { await dbRun('DELETE FROM appearances WHERE id=?', [id]); } catch {} }
  for (const action of ['appearance_document_linked', 'appearance_document_unlinked']) {
    try { await dbRun('DELETE FROM audit_events WHERE action=? AND entity_id LIKE ?', [action, 'ADL%']); } catch {}
  }
});

describe('KENYA-34B appearance document linking', () => {
  test('1. appearance_documents table exists with expected columns', async () => {
    const cols = (await dbAll('PRAGMA table_info(appearance_documents)')).map(c => c.name);
    for (const col of ['id', 'appearanceId', 'documentId', 'matterId', 'label', 'notes', 'createdBy', 'createdAt']) {
      expect(cols).toContain(col);
    }
  });

  test('2. admin and advocate can link a same-matter document to an appearance', async () => {
    const res = await request(app).post(`/api/appearances/${appearanceId}/documents`).set('Authorization', `Bearer ${advocateToken}`).send({ documentId: docInMatterId, label: 'Bundle A' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ appearanceId, documentId: docInMatterId, matterId: accessibleMatterId, label: 'Bundle A' });
    linkId = res.body.id;
    createdLinkIds.push(linkId);

    const second = await createDocument(accessibleMatterId, adminToken, { name: '34b-second.pdf' });
    const adminRes = await request(app).post(`/api/appearances/${appearanceId}/documents`).set('Authorization', `Bearer ${adminToken}`).send({ documentId: second });
    expect(adminRes.statusCode).toBe(200);
    createdLinkIds.push(adminRes.body.id);
  });

  test('3. assistant can GET links but cannot POST or DELETE', async () => {
    const list = await request(app).get(`/api/appearances/${appearanceId}/documents`).set('Authorization', `Bearer ${assistantToken}`);
    expect(list.statusCode).toBe(200);
    const create = await request(app).post(`/api/appearances/${appearanceId}/documents`).set('Authorization', `Bearer ${assistantToken}`).send({ documentId: docInMatterId });
    expect(create.statusCode).toBe(403);
    const del = await request(app).delete(`/api/appearance-documents/${linkId}`).set('Authorization', `Bearer ${assistantToken}`);
    expect(del.statusCode).toBe(403);
  });

  test('4. client gets 403 on GET/POST/DELETE link routes', async () => {
    const list = await request(app).get(`/api/appearances/${appearanceId}/documents`).set('Authorization', `Bearer ${clientToken}`);
    expect(list.statusCode).toBe(403);
    const create = await request(app).post(`/api/appearances/${appearanceId}/documents`).set('Authorization', `Bearer ${clientToken}`).send({ documentId: docInMatterId });
    expect(create.statusCode).toBe(403);
    const del = await request(app).delete(`/api/appearance-documents/${linkId}`).set('Authorization', `Bearer ${clientToken}`);
    expect(del.statusCode).toBe(403);
  });

  test('5. document from a different matter is rejected', async () => {
    const res = await request(app).post(`/api/appearances/${appearanceId}/documents`).set('Authorization', `Bearer ${adminToken}`).send({ documentId: docOtherMatterId });
    expect(res.statusCode).toBe(400);
  });

  test('6. advocate without access to the appearance/matter is denied', async () => {
    const res = await request(app).post(`/api/appearances/${otherAppearanceId}/documents`).set('Authorization', `Bearer ${advocateToken}`).send({ documentId: docOtherMatterId });
    expect(res.statusCode).toBe(403);
    const read = await request(app).get(`/api/appearances/${otherAppearanceId}/documents`).set('Authorization', `Bearer ${advocateToken}`);
    expect(read.statusCode).toBe(403);
  });

  test('7. soft-deleted document cannot be linked', async () => {
    const res = await request(app).post(`/api/appearances/${appearanceId}/documents`).set('Authorization', `Bearer ${adminToken}`).send({ documentId: softDeletedDocId });
    expect(res.statusCode).toBe(404);
  });

  test('8. duplicate link is idempotent (no second row)', async () => {
    const before = (await dbGet('SELECT COUNT(*) AS n FROM appearance_documents WHERE appearanceId=? AND documentId=?', [appearanceId, docInMatterId])).n;
    expect(before).toBe(1);
    const res = await request(app).post(`/api/appearances/${appearanceId}/documents`).set('Authorization', `Bearer ${adminToken}`).send({ documentId: docInMatterId });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(linkId);
    const after = (await dbGet('SELECT COUNT(*) AS n FROM appearance_documents WHERE appearanceId=? AND documentId=?', [appearanceId, docInMatterId])).n;
    expect(after).toBe(1);
  });

  test('9. GET returns safe document fields without BLOB/content', async () => {
    const res = await request(app).get(`/api/appearances/${appearanceId}/documents`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    const link = res.body.find(l => l.documentId === docInMatterId);
    expect(link).toBeTruthy();
    expect(link.document).toMatchObject({ id: docInMatterId });
    expect(link.document).toHaveProperty('displayName');
    expect(link.document).not.toHaveProperty('content');
    expect(JSON.stringify(res.body)).not.toContain(SAMPLE_PDF_B64);
    expect(res.body.every(l => l.appearanceId === appearanceId)).toBe(true);
  });

  test('10. unlink removes only the join row; underlying document remains', async () => {
    const before = await dbGet('SELECT id FROM documents WHERE id=?', [docInMatterId]);
    expect(before).toBeTruthy();
    const res = await request(app).delete(`/api/appearance-documents/${linkId}`).set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ unlinked: true });
    const joinRow = await dbGet('SELECT id FROM appearance_documents WHERE id=?', [linkId]);
    expect(joinRow).toBeFalsy();
    const stillThere = await dbGet('SELECT id FROM documents WHERE id=?', [docInMatterId]);
    expect(stillThere).toBeTruthy();
    // re-link so later visibility tests have data to assert against
    const relink = await request(app).post(`/api/appearances/${appearanceId}/documents`).set('Authorization', `Bearer ${adminToken}`).send({ documentId: docInMatterId });
    expect(relink.statusCode).toBe(200);
    linkId = relink.body.id;
    createdLinkIds.push(linkId);
  });

  test('11. linking a clientVisible=0 document does not expose it in the client dashboard', async () => {
    const link = await request(app).post(`/api/appearances/${clientAppearanceId}/documents`).set('Authorization', `Bearer ${adminToken}`).send({ documentId: clientHiddenDocId, label: 'Hidden bundle' });
    expect(link.statusCode).toBe(200);
    createdLinkIds.push(link.body.id);
    const res = await request(app).get('/api/client/dashboard').set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('KENYA34B-HIDDEN-SECRET');
    expect(JSON.stringify(res.body)).not.toContain('appearance_documents');
    expect(JSON.stringify(res.body)).not.toContain(clientHiddenDocId);
  });

  test('12. linked hidden document is not exposed in client matter detail or client snapshot', async () => {
    const detail = await request(app).get(`/api/matters/${clientMatterId}`).set('Authorization', `Bearer ${clientToken}`);
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain('KENYA34B-HIDDEN-SECRET');
    expect(JSON.stringify(detail.body)).not.toContain(clientHiddenDocId);
    const snap = await request(app).get(`/api/clients/${clientId}/snapshot`).set('Authorization', `Bearer ${adminToken}`);
    expect(snap.statusCode).toBe(200);
    expect(JSON.stringify(snap.body)).not.toContain('appearance_documents');
  });

  test('13. no alternate download route is created; download still uses canAccessDocument', async () => {
    // The link routes must not stream bytes.
    const list = await request(app).get(`/api/appearances/${appearanceId}/documents`).set('Authorization', `Bearer ${adminToken}`);
    expect(String(list.headers['content-type'] || '')).toContain('application/json');
    // The only download path remains /api/documents/:id/download and still blocks clients for a hidden doc.
    const blocked = await request(app).get(`/api/documents/${clientHiddenDocId}/download`).set('Authorization', `Bearer ${clientToken}`);
    expect(blocked.statusCode).toBe(403);
    const allowed = await request(app).get(`/api/documents/${docInMatterId}/download`).set('Authorization', `Bearer ${adminToken}`);
    expect(allowed.statusCode).toBe(200);
  });

  test('14. audit events emitted with whitelisted metadata only', async () => {
    const linkedRow = await dbGet("SELECT metadata_json FROM audit_events WHERE action='appearance_document_linked' ORDER BY created_at DESC LIMIT 1");
    expect(linkedRow).toBeTruthy();
    const meta = JSON.parse(linkedRow.metadata_json);
    expect(Object.keys(meta).sort()).toEqual(['appearanceId', 'documentId', 'label', 'matterId']);
    expect(meta).not.toHaveProperty('notes');
    expect(meta).not.toHaveProperty('content');

    const delRes = await request(app).delete(`/api/appearance-documents/${linkId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(delRes.statusCode).toBe(200);
    const unlinkedRow = await dbGet("SELECT metadata_json FROM audit_events WHERE action='appearance_document_unlinked' ORDER BY created_at DESC LIMIT 1");
    expect(unlinkedRow).toBeTruthy();
    const umeta = JSON.parse(unlinkedRow.metadata_json);
    expect(Object.keys(umeta).sort()).toEqual(['appearanceId', 'documentId', 'label', 'matterId']);
  });

  test('15. 33B outcome behavior remains green (staff appearance keeps outcome field)', async () => {
    const staffMatter = await request(app).get(`/api/matters/${accessibleMatterId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(staffMatter.statusCode).toBe(200);
    const appearance = staffMatter.body.appearances.find(a => a.id === appearanceId);
    expect(appearance).toHaveProperty('outcome');
  });

  test('16. 33C prep checklist behavior remains green (prepItems still attached for staff)', async () => {
    const prep = await request(app).post(`/api/appearances/${appearanceId}/prep-items`).set('Authorization', `Bearer ${adminToken}`).send({ title: '34B prep coexist', category: 'document' });
    expect(prep.statusCode).toBe(200);
    const staffMatter = await request(app).get(`/api/matters/${accessibleMatterId}`).set('Authorization', `Bearer ${adminToken}`);
    const appearance = staffMatter.body.appearances.find(a => a.id === appearanceId);
    expect(Array.isArray(appearance.prepItems)).toBe(true);
    expect(appearance.prepItems.some(i => i.title === '34B prep coexist')).toBe(true);
    await dbRun('DELETE FROM appearance_prep_items WHERE id=?', [prep.body.id]);
  });

  test('17. 33D attendance behavior remains green (attendance fields stripped for clients)', async () => {
    const detail = await request(app).get(`/api/matters/${clientMatterId}`).set('Authorization', `Bearer ${clientToken}`);
    expect(detail.statusCode).toBe(200);
    const appearance = detail.body.appearances.find(a => a.id === clientAppearanceId);
    expect(appearance).toBeTruthy();
    expect(appearance).not.toHaveProperty('attendanceStatus');
    expect(appearance).not.toHaveProperty('outcome');
  });
});
