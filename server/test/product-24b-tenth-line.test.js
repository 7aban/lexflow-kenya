'use strict';

const request = require('supertest');
const sqlite3 = require('sqlite3');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(30000);

function parseBinary(res, callback) {
  const chunks = [];
  res.on('data', chunk => chunks.push(Buffer.from(chunk)));
  res.on('end', () => {
    const body = Buffer.concat(chunks);
    const ct = (res.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      try { callback(null, JSON.parse(body.toString())); } catch { callback(null, body); }
    } else {
      callback(null, body);
    }
  });
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

async function pdfBuffer(label, pageCount) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`${label} page ${i + 1}`, { x: 50, y: 150, size: 10, font });
  }
  return Buffer.from(await pdf.save());
}

async function insertDocument({ id, matterId, name, mimeType, type, content }) {
  const mt = mimeType || 'application/pdf';
  const tp = type || 'PDF';
  await dbRun(
    'INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, matterId, name, name, tp, mt, '2026-06-05', Math.max(1, Math.round(content.length / 1024)) + ' KB', content, 'firm', null, null, null, 0, 'p24b-test'],
  );
  return id;
}

async function tenthLineDownload(token, documentId, startNumber, filename) {
  const body = { documentId };
  if (startNumber !== undefined) body.startNumber = startNumber;
  if (filename !== undefined) body.filename = filename;
  return request(app)
    .post('/api/document-tools/tenth-line')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .buffer(true)
    .parse(parseBinary);
}

async function tenthLineSave(token, matterId, documentId, startNumber, filename) {
  const body = { matterId, documentId };
  if (startNumber !== undefined) body.startNumber = startNumber;
  if (filename !== undefined) body.filename = filename;
  return request(app)
    .post('/api/document-tools/tenth-line/save')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

describe('PRODUCT-24B Tenth-line numbering PDF tool', () => {
  let adminToken;
  let advocateToken;
  let otherAdvocateToken;
  let assistantToken;
  let clientToken;
  let matterId;
  let otherMatterId;
  let sourcePdfId;
  let textDocId;

  const suffix = Date.now();

  beforeAll(async () => {
    await dbReady;

    adminToken = await login('/api/auth/login', 'admin@lexflow.co.ke');
    advocateToken = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    otherAdvocateToken = await login('/api/auth/login', 'michael.oduor@achokilaw.co.ke');
    assistantToken = await login('/api/auth/login', 'david.wanjiku@achokilaw.co.ke');
    clientToken = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');

    const clientId = await createClient(adminToken, 'P24B Client ' + suffix, 'p24b.' + suffix + '@example.com');
    const otherClientId = await createClient(adminToken, 'P24B Other Client ' + suffix, 'p24b.other.' + suffix + '@example.com');
    matterId = await createMatter(adminToken, clientId, 'P24B Tenth Matter ' + suffix, 'Sarah Mwangi');
    otherMatterId = await createMatter(adminToken, otherClientId, 'P24B Other Matter ' + suffix, 'Michael Oduor');

    sourcePdfId = await insertDocument({ id: 'DOC_P24B_SRC_' + suffix, matterId: matterId, name: 'p24b-source-' + suffix + '.pdf', content: await pdfBuffer('P24B source', 3) });
    textDocId = await insertDocument({ id: 'DOC_P24B_TXT_' + suffix, matterId: matterId, name: 'p24b-text-' + suffix + '.txt', mimeType: 'text/plain', type: 'Text', content: Buffer.from('P24B text body') });
  });

  test('1. happy path download as admin returns 200, application/pdf, valid PDF magic bytes', async () => {
    const res = await tenthLineDownload(adminToken, sourcePdfId, 10, 'p24b-test-output.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(res.body.length).toBeGreaterThan(200);
  });

  test('2. happy path save as advocate creates new document row', async () => {
    const beforeCount = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await tenthLineSave(advocateToken, matterId, sourcePdfId, 10, 'p24b-saved.pdf');
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
    expect(Buffer.isBuffer(newDoc.content) ? newDoc.content.length : Buffer.from(newDoc.content || '').length).toBeGreaterThan(200);
  });

  test('3. source document content remains unchanged after save', async () => {
    const before = await dbGet('SELECT content FROM documents WHERE id=?', [sourcePdfId]);
    const beforeBuf = Buffer.isBuffer(before.content) ? before.content : Buffer.from(before.content || '');

    await tenthLineSave(adminToken, matterId, sourcePdfId, 10, 'p24b-check-original.pdf');

    const after = await dbGet('SELECT content FROM documents WHERE id=?', [sourcePdfId]);
    const afterBuf = Buffer.isBuffer(after.content) ? after.content : Buffer.from(after.content || '');
    expect(Buffer.compare(beforeBuf, afterBuf)).toBe(0);
  });

  test('4. cross-advocate/inaccessible document denied', async () => {
    const res = await tenthLineDownload(otherAdvocateToken, sourcePdfId, 10, 'p24b-other.pdf');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('5. unauthorized matter access denied on save', async () => {
    const res = await tenthLineSave(otherAdvocateToken, otherMatterId, sourcePdfId, 10, 'p24b-cross.pdf');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('6. client denied', async () => {
    const res = await tenthLineDownload(clientToken, sourcePdfId, 10, 'p24b-client.pdf');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  test('7. non-PDF source rejected', async () => {
    const res = await tenthLineDownload(adminToken, textDocId, 10, 'p24b-text.pdf');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  test('8. missing documentId rejected', async () => {
    const res = await tenthLineDownload(adminToken, undefined, 10, 'p24b-none.pdf');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/documentId is required/i);
  });

  test('9. nonexistent document returns 404', async () => {
    const res = await tenthLineDownload(adminToken, 'NONEXISTENT_DOC_P24B', 10, 'p24b-nonexist.pdf');
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('10. assistant cannot save', async () => {
    const res = await tenthLineSave(assistantToken, matterId, sourcePdfId, 10, 'p24b-assistant-save.pdf');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access required/i);
  });

  test('11. audit events recorded for download and save', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');

    const downloadRes = await tenthLineDownload(adminToken, sourcePdfId, 10, 'p24b-audit-dl.pdf');
    expect(downloadRes.statusCode).toBe(200);

    const saveRes = await tenthLineSave(adminToken, matterId, sourcePdfId, 10, 'p24b-audit-save.pdf');
    expect(saveRes.statusCode).toBe(200);

    const downloadEvent = await dbGet(
      'SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? ORDER BY rowid DESC LIMIT 1',
      [boundary.rowid, 'document_tool_tenth_line_downloaded'],
    );
    expect(downloadEvent).toBeDefined();
    expect(downloadEvent.entity_type).toBe('document_tool');
    expect(downloadEvent.entity_id).toBe(sourcePdfId);

    const dlMeta = JSON.parse(downloadEvent.metadata_json || '{}');
    expect(dlMeta.sourceDocumentId).toBe(sourcePdfId);
    expect(dlMeta.startNumber).toBe(10);
    expect(dlMeta.interval).toBe(10);
    expect(dlMeta.fontSize).toBe(8);
    expect(dlMeta.pageCount).toBe(3);
    expect(dlMeta.inputBytes).toBeGreaterThan(0);
    expect(dlMeta.outputBytes).toBeGreaterThan(0);
    expect(dlMeta.filename).toMatch(/\.pdf$/i);

    const saveEvent = await dbGet(
      'SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? ORDER BY rowid DESC LIMIT 1',
      [boundary.rowid, 'document_tool_tenth_line_saved'],
    );
    expect(saveEvent).toBeDefined();
    expect(saveEvent.entity_type).toBe('document_tool');
    expect(saveEvent.matter_id).toBe(matterId);

    const saveMeta = JSON.parse(saveEvent.metadata_json || '{}');
    expect(saveMeta.sourceDocumentId).toBe(sourcePdfId);
    expect(saveMeta.targetMatterId).toBe(matterId);
    expect(saveMeta.outputDocumentId).toBeTruthy();
    expect(saveMeta.startNumber).toBe(10);
    expect(saveMeta.interval).toBe(10);
    expect(saveMeta.fontSize).toBe(8);
    expect(saveMeta.clientVisible).toBe(false);
  });

  test('12. saved document defaults clientVisible=0', async () => {
    const res = await tenthLineSave(adminToken, matterId, sourcePdfId, 10, 'p24b-client-vis.pdf');
    expect(res.statusCode).toBe(200);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(Number(saved.clientVisible)).toBe(0);
  });
});
