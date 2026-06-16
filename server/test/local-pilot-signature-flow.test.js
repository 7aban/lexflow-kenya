'use strict';

const request = require('supertest');
const sqlite3 = require('sqlite3');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(30000);

const TINY_PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG_1X1 = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpgAAH/2Q==', 'base64');
const TINY_JPEG_DATA_URI = `data:image/jpeg;base64,${JPEG_1X1.toString('base64')}`;
const PDF_SIGNATURE_IMAGE_MESSAGE = 'For PDF signing, upload a PNG or JPEG signature/stamp image. WebP cannot be embedded in signed PDFs yet.';

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

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

async function login(pathName, email) {
  const res = await request(app).post(pathName).send({ email, password: 'password123' });
  expect(res.statusCode).toBe(200);
  expect(res.body.token).toBeDefined();
  return res.body;
}

async function createClient(adminToken, suffix) {
  const res = await request(app)
    .post('/api/clients')
    .set(auth(adminToken))
    .send({ name: `LP Signature Client ${suffix}`, email: `lp.signature.${suffix}@example.com` });
  expect(res.statusCode).toBe(200);
  return res.body.id;
}

async function createMatter(adminToken, clientId, suffix) {
  const res = await request(app)
    .post('/api/matters')
    .set(auth(adminToken))
    .send({ clientId, title: `LP Signature Matter ${suffix}`, assignedTo: 'Sarah Mwangi' });
  expect(res.statusCode).toBe(200);
  return res.body.id;
}

async function pdfBuffer(label) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 400]);
  page.drawText(label, { x: 30, y: 200, size: 14, font });
  return Buffer.from(await pdf.save());
}

async function insertDocument({ id, matterId, name, content }) {
  await dbRun(
    'INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, matterId, name, name, 'PDF', 'application/pdf', '2026-06-17', Math.max(1, Math.round(content.length / 1024)) + ' KB', content, 'firm', null, null, null, 0, 'local-pilot-signature-flow'],
  );
  return id;
}

async function uploadAsset(token, overrides = {}) {
  const body = {
    ownerType: 'user',
    assetType: 'signature',
    label: `LP signature asset ${Date.now()}`,
    mimeType: 'image/png',
    data: TINY_PNG_DATA_URI,
    ...overrides,
  };
  return request(app).post('/api/signature-assets').set(auth(token)).send(body);
}

describe('LOCAL-PILOT signature flow polish', () => {
  let admin;
  let advocate;
  let assistant;
  let client;
  let matterId;
  let sourcePdfId;
  let pngSignatureId;
  let jpegFirmStampId;
  let webpAssetId;
  let sourcePdfContent;

  const suffix = Date.now();

  beforeAll(async () => {
    await dbReady;

    admin = await login('/api/auth/login', 'admin@lexflow.co.ke');
    advocate = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    assistant = await login('/api/auth/login', 'david.wanjiku@achokilaw.co.ke');
    client = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');

    const clientId = await createClient(admin.token, suffix);
    matterId = await createMatter(admin.token, clientId, suffix);
    sourcePdfContent = await pdfBuffer(`Local pilot signature source ${suffix}`);
    sourcePdfId = await insertDocument({
      id: `DOC_LP_SIG_SRC_${suffix}`,
      matterId,
      name: `local-pilot-signature-source-${suffix}.pdf`,
      content: sourcePdfContent,
    });

    const pngRes = await uploadAsset(advocate.token, { label: `LP PNG signature ${suffix}` });
    expect(pngRes.statusCode).toBe(200);
    pngSignatureId = pngRes.body.id;

    const jpegRes = await uploadAsset(admin.token, {
      ownerType: 'firm',
      assetType: 'stamp',
      label: `LP JPEG firm stamp ${suffix}`,
      mimeType: 'image/jpeg',
      data: TINY_JPEG_DATA_URI,
    });
    expect(jpegRes.statusCode).toBe(200);
    jpegFirmStampId = jpegRes.body.id;

    webpAssetId = `SIG_LP_WEBP_${suffix}`;
    await dbRun(
      'INSERT INTO signature_assets (id,ownerType,ownerId,assetType,label,mimeType,content,size,isDefault,createdBy,createdAt,updatedAt,deletedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [webpAssetId, 'user', advocate.user.id, 'signature', `LP existing WebP ${suffix}`, 'image/webp', Buffer.from('RIFF----WEBP'), 12, 0, advocate.user.id, new Date().toISOString(), null, null],
    );
  });

  test('1. clients cannot access signing and stamping routes', async () => {
    const listRes = await request(app).get('/api/signature-assets').set(auth(client.token));
    expect(listRes.statusCode).toBe(403);

    const downloadRes = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(client.token))
      .send({ documentId: sourcePdfId, assetId: pngSignatureId, pageNumber: 1, x: 50, y: 50, width: 100 });
    expect(downloadRes.statusCode).toBe(403);

    const saveRes = await request(app)
      .post('/api/document-tools/stamp-pdf/save')
      .set(auth(client.token))
      .send({ matterId, documentId: sourcePdfId, assetId: pngSignatureId, pageNumber: 1, x: 50, y: 50, width: 100 });
    expect(saveRes.statusCode).toBe(403);
  });

  test('2. advocate and admin can stamp/sign PDFs with PNG and JPEG assets', async () => {
    const advocateRes = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(advocate.token))
      .send({ documentId: sourcePdfId, assetId: pngSignatureId, pageNumber: 1, x: 50, y: 50, width: 100, filename: 'lp-png-signed.pdf' })
      .buffer(true)
      .parse(parseBinary);
    expect(advocateRes.statusCode).toBe(200);
    expect(advocateRes.body.slice(0, 4).toString()).toBe('%PDF');

    const adminRes = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(admin.token))
      .send({ documentId: sourcePdfId, assetId: jpegFirmStampId, pageNumber: 1, x: 80, y: 80, width: 100, filename: 'lp-jpeg-signed.pdf' })
      .buffer(true)
      .parse(parseBinary);
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('3. save creates a staff-only copy and leaves the source PDF unchanged', async () => {
    const beforeSource = await dbGet('SELECT content FROM documents WHERE id=?', [sourcePdfId]);
    const beforeBuffer = Buffer.isBuffer(beforeSource.content) ? beforeSource.content : Buffer.from(beforeSource.content || '');

    const saveRes = await request(app)
      .post('/api/document-tools/stamp-pdf/save')
      .set(auth(advocate.token))
      .send({ matterId, documentId: sourcePdfId, assetId: pngSignatureId, pageNumber: 1, x: 60, y: 60, width: 100, filename: 'lp-saved-signed.pdf' });
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.body.id).toBeTruthy();
    expect(saveRes.body.source).toBe('document_tool');
    expect(Boolean(saveRes.body.clientVisible)).toBe(false);

    const savedDoc = await dbGet('SELECT * FROM documents WHERE id=?', [saveRes.body.id]);
    expect(savedDoc.matterId).toBe(matterId);
    expect(savedDoc.clientVisible).toBe(0);
    expect(savedDoc.mimeType).toBe('application/pdf');

    const afterSource = await dbGet('SELECT content FROM documents WHERE id=?', [sourcePdfId]);
    const afterBuffer = Buffer.isBuffer(afterSource.content) ? afterSource.content : Buffer.from(afterSource.content || '');
    expect(Buffer.compare(beforeBuffer, afterBuffer)).toBe(0);
    expect(Buffer.compare(afterBuffer, sourcePdfContent)).toBe(0);
  });

  test('4. assistant download policy is unchanged, but assistant cannot save to matter', async () => {
    const downloadRes = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(assistant.token))
      .send({ documentId: sourcePdfId, assetId: jpegFirmStampId, pageNumber: 1, x: 70, y: 70, width: 100 })
      .buffer(true)
      .parse(parseBinary);
    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.body.slice(0, 4).toString()).toBe('%PDF');

    const saveRes = await request(app)
      .post('/api/document-tools/stamp-pdf/save')
      .set(auth(assistant.token))
      .send({ matterId, documentId: sourcePdfId, assetId: jpegFirmStampId, pageNumber: 1, x: 70, y: 70, width: 100 });
    expect(saveRes.statusCode).toBe(403);
    expect(saveRes.body.error).toMatch(/access required/i);
  });

  test('5. WebP upload and existing WebP placement are rejected with a clear message', async () => {
    const uploadRes = await uploadAsset(advocate.token, {
      label: `LP blocked WebP ${suffix}`,
      mimeType: 'image/webp',
      data: TINY_PNG_DATA_URI.replace('image/png', 'image/webp'),
    });
    expect(uploadRes.statusCode).toBe(400);
    expect(uploadRes.body.error).toBe(PDF_SIGNATURE_IMAGE_MESSAGE);

    const placementRes = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(advocate.token))
      .send({ documentId: sourcePdfId, assetId: webpAssetId, pageNumber: 1, x: 50, y: 50, width: 100 });
    expect(placementRes.statusCode).toBe(400);
    expect(placementRes.body.error).toBe(PDF_SIGNATURE_IMAGE_MESSAGE);
  });

  test('6. invalid signature asset MIME type is rejected', async () => {
    const res = await uploadAsset(advocate.token, {
      label: `LP bad GIF ${suffix}`,
      mimeType: 'image/gif',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/jpeg|png/i);
  });

  test('7. direct signing flow continues to use the existing stamp API contract', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await request(app)
      .post('/api/document-tools/stamp-pdf')
      .set(auth(advocate.token))
      .send({ documentId: sourcePdfId, assetId: pngSignatureId, pageNumber: 1, x: 90, y: 90, width: 120, filename: 'lp-direct-sign-existing-api.pdf' })
      .buffer(true)
      .parse(parseBinary);
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      'SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? ORDER BY rowid DESC LIMIT 1',
      [boundary.rowid, 'document_tool_stamp_pdf_downloaded'],
    );
    expect(event).toBeDefined();
    expect(event.entity_id).toBe(sourcePdfId);
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.sourceDocumentId).toBe(sourcePdfId);
    expect(metadata.assetId).toBe(pngSignatureId);
    expect(metadata.filename).toBe('lp-direct-sign-existing-api.pdf');
    expect(metadata).not.toHaveProperty('invoiceId');
    expect(metadata).not.toHaveProperty('brandingMode');
    expect(metadata).not.toHaveProperty('courtBundleId');
  });
});
