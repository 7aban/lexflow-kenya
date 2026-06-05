'use strict';

const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(30000);

const TINY_PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function parseBinary(res, callback) {
  const chunks = [];
  res.on('data', chunk => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function dbRun(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      db.close();
      err ? reject(err) : resolve(this);
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

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function login(pathName, email) {
  const res = await request(app).post(pathName).send({ email, password: 'password123' });
  expect(res.statusCode).toBe(200);
  expect(res.body.token).toBeDefined();
  return res.body.token;
}

async function createClient(adminToken, name, email) {
  const res = await request(app).post('/api/clients').set('Authorization', `Bearer ${adminToken}`).send({ name, email });
  expect(res.statusCode).toBe(200);
  return res.body.id;
}

async function createMatter(adminToken, clientId, title, assignedTo) {
  const res = await request(app).post('/api/matters').set('Authorization', `Bearer ${adminToken}`).send({ clientId, title, assignedTo });
  expect(res.statusCode).toBe(200);
  return res.body.id;
}

async function pdfBuffer(label, width, height) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([width, height]);
  page.drawText(label, { x: 24, y: height / 2, size: 14, font });
  return Buffer.from(await pdf.save());
}

async function insertDocument({ id, matterId, name, mimeType, type, content }) {
  const mt = mimeType || 'application/pdf';
  const tp = type || 'PDF';
  await dbRun(
    'INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, matterId, name, name, tp, mt, '2026-06-05', Math.max(1, Math.round(content.length / 1024)) + ' KB', content, 'firm', null, null, null, 0, 'p23c-test'],
  );
  return id;
}

async function uploadSignatureAsset(token, overrides) {
  const body = {
    ownerType: 'user',
    assetType: 'signature',
    label: 'P23C test asset ' + Date.now(),
    mimeType: 'image/png',
    data: TINY_PNG_DATA_URI,
  };
  Object.assign(body, overrides || {});
  return request(app).post('/api/signature-assets').set(auth(token)).send(body);
}

async function latestAudit(action, entityId) {
  return dbGet('SELECT * FROM audit_events WHERE action=? AND entity_id=? ORDER BY timestamp DESC LIMIT 1', [action, entityId]);
}

describe('PRODUCT-23C PDF signature/stamp placement', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let otherAdvocateToken;
  let clientToken;
  let matterId;
  let otherMatterId;
  let sourcePdfId;
  let textDocId;
  let signatureAssetId;
  let firmStampAssetId;
  let otherAdvocateAssetId;
  let softDeletedAssetId;

  const suffix = Date.now();

  beforeAll(async () => {
    await dbReady;

    adminToken = await login('/api/auth/login', 'admin@lexflow.co.ke');
    advocateToken = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    otherAdvocateToken = await login('/api/auth/login', 'michael.oduor@achokilaw.co.ke');
    assistantToken = await login('/api/auth/login', 'david.wanjiku@achokilaw.co.ke');
    clientToken = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');

    const clientId = await createClient(adminToken, 'P23C Client ' + suffix, 'p23c.' + suffix + '@example.com');
    const otherClientId = await createClient(adminToken, 'P23C Other Client ' + suffix, 'p23c.other.' + suffix + '@example.com');
    matterId = await createMatter(adminToken, clientId, 'P23C Stamp Matter ' + suffix, 'Sarah Mwangi');
    otherMatterId = await createMatter(adminToken, otherClientId, 'P23C Other Matter ' + suffix, 'Michael Oduor');

    sourcePdfId = await insertDocument({ id: 'DOC_P23C_SRC_' + suffix, matterId: matterId, name: 'p23c-source-' + suffix + '.pdf', content: await pdfBuffer('P23C source ' + suffix, 400, 400) });
    textDocId = await insertDocument({ id: 'DOC_P23C_TXT_' + suffix, matterId: matterId, name: 'p23c-text-' + suffix + '.txt', mimeType: 'text/plain', type: 'Text', content: Buffer.from('P23C text body') });

    const sigRes = await uploadSignatureAsset(advocateToken, { label: 'P23C Sarah sig ' + suffix });
    expect(sigRes.statusCode).toBe(200);
    signatureAssetId = sigRes.body.id;

    const stampRes = await uploadSignatureAsset(adminToken, { ownerType: 'firm', assetType: 'stamp', label: 'P23C firm stamp ' + suffix });
    expect(stampRes.statusCode).toBe(200);
    firmStampAssetId = stampRes.body.id;

    const otherSigRes = await uploadSignatureAsset(otherAdvocateToken, { label: 'P23C Michael sig ' + suffix });
    expect(otherSigRes.statusCode).toBe(200);
    otherAdvocateAssetId = otherSigRes.body.id;

    const delRes = await uploadSignatureAsset(advocateToken, { label: 'P23C delete me ' + suffix });
    expect(delRes.statusCode).toBe(200);
    softDeletedAssetId = delRes.body.id;
    const patchRes = await request(app).patch('/api/signature-assets/' + softDeletedAssetId).set(auth(advocateToken)).send({ deleted: true });
    expect(patchRes.statusCode).toBe(200);
  });

  test('1. happy path: stamp and download returns valid PDF', async () => {
    const res = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(advocateToken))
      .send({ documentId: sourcePdfId, assetId: signatureAssetId, pageNumber: 1, x: 50, y: 50, width: 100, filename: 'p23c-stamped.pdf' })
      .buffer(true)
      .parse(parseBinary);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(res.body.length).toBeGreaterThan(200);
  });

  test('2. happy path: stamp and save creates new document in matter', async () => {
    const beforeCount = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await request(app)
      .post('/api/document-tools/stamp-pdf/save')
      .set(auth(advocateToken))
      .send({ matterId, documentId: sourcePdfId, assetId: signatureAssetId, pageNumber: 1, x: 50, y: 50, width: 100, filename: 'p23c-saved-stamped.pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeTruthy();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.source).toBe('document_tool');

    const afterCount = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(Number(afterCount.count)).toBe(Number(beforeCount.count) + 1);

    const newDoc = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(newDoc).toBeDefined();
    expect(newDoc.matterId).toBe(matterId);
    expect(newDoc.displayName).toMatch(/\.pdf$/);
    expect(newDoc.clientVisible).toBe(0);
    expect(newDoc.uploadedBy).toBeTruthy();
    expect(Buffer.isBuffer(newDoc.content) ? newDoc.content.length : Buffer.from(newDoc.content || '').length).toBeGreaterThan(200);
  });

  test('3. source document content remains unchanged after stamp save', async () => {
    const before = await dbGet('SELECT content FROM documents WHERE id=?', [sourcePdfId]);
    const beforeBuf = Buffer.isBuffer(before.content) ? before.content : Buffer.from(before.content || '');

    await request(app)
      .post('/api/document-tools/stamp-pdf/save')
      .set(auth(advocateToken))
      .send({ matterId, documentId: sourcePdfId, assetId: signatureAssetId, pageNumber: 1, x: 50, y: 50, width: 100, filename: 'p23c-check-original.pdf' });

    const after = await dbGet('SELECT content FROM documents WHERE id=?', [sourcePdfId]);
    const afterBuf = Buffer.isBuffer(after.content) ? after.content : Buffer.from(after.content || '');
    expect(Buffer.compare(beforeBuf, afterBuf)).toBe(0);
  });

  test('4. advocate cannot use another advocate personal signature asset', async () => {
    const res = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(advocateToken))
      .send({ documentId: sourcePdfId, assetId: otherAdvocateAssetId, pageNumber: 1, x: 50, y: 50, width: 100 });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('5. document access denied for unauthorized user', async () => {
    const res = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(otherAdvocateToken))
      .send({ documentId: sourcePdfId, assetId: signatureAssetId, pageNumber: 1, x: 50, y: 50, width: 100 });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('6. client cannot call stamp route', async () => {
    const res = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(clientToken))
      .send({ documentId: sourcePdfId, assetId: signatureAssetId, pageNumber: 1, x: 50, y: 50, width: 100 });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access required/i);
  });

  test('7. non-PDF source document rejected', async () => {
    const res = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(advocateToken))
      .send({ documentId: textDocId, assetId: signatureAssetId, pageNumber: 1, x: 50, y: 50, width: 100 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  test('8. page number out of range rejected', async () => {
    const res = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(advocateToken))
      .send({ documentId: sourcePdfId, assetId: signatureAssetId, pageNumber: 999, x: 50, y: 50, width: 100 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/out of range/i);
  });

  test('9. invalid asset ID returns 404', async () => {
    const res = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(advocateToken))
      .send({ documentId: sourcePdfId, assetId: 'NONEXISTENT_ASSET', pageNumber: 1, x: 50, y: 50, width: 100 });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('10. soft-deleted asset rejected', async () => {
    const res = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(advocateToken))
      .send({ documentId: sourcePdfId, assetId: softDeletedAssetId, pageNumber: 1, x: 50, y: 50, width: 100 });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('11. audit events recorded for download and save', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');

    const downloadRes = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(advocateToken))
      .send({ documentId: sourcePdfId, assetId: signatureAssetId, pageNumber: 1, x: 50, y: 50, width: 100, filename: 'p23c-audit-test.pdf' })
      .buffer(true)
      .parse(parseBinary);
    expect(downloadRes.statusCode).toBe(200);

    const saveRes = await request(app)
      .post('/api/document-tools/stamp-pdf/save')
      .set(auth(advocateToken))
      .send({ matterId, documentId: sourcePdfId, assetId: signatureAssetId, pageNumber: 1, x: 50, y: 50, width: 100, filename: 'p23c-audit-save.pdf' });
    expect(saveRes.statusCode).toBe(200);

    const downloadEvent = await dbGet(
      'SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? ORDER BY rowid DESC LIMIT 1',
      [boundary.rowid, 'document_tool_stamp_pdf_downloaded'],
    );
    expect(downloadEvent).toBeDefined();
    expect(downloadEvent.entity_type).toBe('document_tool');
    expect(downloadEvent.entity_id).toBe(sourcePdfId);
    expect(downloadEvent.matter_id).toBe(matterId);

    const dlMeta = JSON.parse(downloadEvent.metadata_json || '{}');
    expect(dlMeta.sourceDocumentId).toBe(sourcePdfId);
    expect(dlMeta.assetId).toBe(signatureAssetId);
    expect(dlMeta.assetType).toBe('signature');
    expect(dlMeta.pageNumber).toBe(1);
    expect(dlMeta.placementX).toBe(50);
    expect(dlMeta.placementY).toBe(50);
    expect(dlMeta.width).toBe(100);
    expect(dlMeta.height).toBeGreaterThan(0);
    expect(dlMeta.filename).toMatch(/\.pdf$/);
    expect(dlMeta.inputBytes).toBeGreaterThan(0);
    expect(dlMeta.outputBytes).toBeGreaterThan(0);

    const saveEvent = await dbGet(
      'SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? ORDER BY rowid DESC LIMIT 1',
      [boundary.rowid, 'document_tool_stamp_pdf_saved'],
    );
    expect(saveEvent).toBeDefined();
    expect(saveEvent.entity_type).toBe('document_tool');
    expect(saveEvent.matter_id).toBe(matterId);

    const saveMeta = JSON.parse(saveEvent.metadata_json || '{}');
    expect(saveMeta.sourceDocumentId).toBe(sourcePdfId);
    expect(saveMeta.targetMatterId).toBe(matterId);
    expect(saveMeta.outputDocumentId).toBeTruthy();
    expect(saveMeta.assetId).toBe(signatureAssetId);
    expect(saveMeta.pageNumber).toBe(1);
  });

  test('12. assistant can download with firm stamp access but cannot save', async () => {
    const downloadRes = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(assistantToken))
      .send({ documentId: sourcePdfId, assetId: firmStampAssetId, pageNumber: 1, x: 50, y: 50, width: 100 })
      .buffer(true)
      .parse(parseBinary);
    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.body.slice(0, 4).toString()).toBe('%PDF');

    const saveRes = await request(app)
      .post('/api/document-tools/stamp-pdf/save')
      .set(auth(assistantToken))
      .send({ matterId, documentId: sourcePdfId, assetId: firmStampAssetId, pageNumber: 1, x: 50, y: 50, width: 100 });
    expect(saveRes.statusCode).toBe(403);
    expect(saveRes.body.error).toMatch(/access required/i);
  });
});
