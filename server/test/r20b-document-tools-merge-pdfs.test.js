const request = require('supertest');
const sqlite3 = require('sqlite3');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(20000);

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
  const res = await request(app)
    .post(pathName)
    .send({ email, password: 'password123' });
  expect(res.statusCode).toBe(200);
  expect(res.body.token).toBeDefined();
  return res.body.token;
}

async function createClient(adminToken, name, email) {
  const res = await request(app)
    .post('/api/clients')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name, email });
  expect(res.statusCode).toBe(200);
  return res.body.id;
}

async function createMatter(adminToken, clientId, title, assignedTo) {
  const res = await request(app)
    .post('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ clientId, title, assignedTo });
  expect(res.statusCode).toBe(200);
  return res.body.id;
}

async function pdfBuffer(label) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([300, 180]);
  page.drawText(label, { x: 24, y: 120, size: 14, font });
  return Buffer.from(await pdf.save());
}

async function insertDocument({ id, matterId, name, mimeType = 'application/pdf', type = 'PDF', content }) {
  await dbRun(
    `INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      matterId,
      name,
      name,
      type,
      mimeType,
      '2026-05-31',
      `${Math.max(1, Math.round(content.length / 1024))} KB`,
      content,
      'firm',
      null,
      null,
      null,
      0,
      'r20b-test',
    ],
  );
  return id;
}

function mergeRequest(token, documentIds, filename = 'r20b-merged.pdf') {
  return request(app)
    .post('/api/document-tools/merge-pdfs')
    .set('Authorization', `Bearer ${token}`)
    .send({ documentIds, filename });
}

function mergeDownloadRequest(token, documentIds, filename = 'r20b-merged.pdf') {
  return mergeRequest(token, documentIds, filename)
    .buffer(true)
    .parse(parseBinary);
}

describe('PRODUCT-14C temporary PDF merge tool', () => {
  let adminToken;
  let advocateToken;
  let clientToken;
  let sarahMatterId;
  let michaelMatterId;
  let sarahPdfA;
  let sarahPdfB;
  let michaelPdfA;
  let michaelPdfB;
  let textDoc;
  let corruptPdf;

  const suffix = Date.now();

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('/api/auth/login', 'admin@lexflow.co.ke');
    advocateToken = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    clientToken = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');

    const sarahClientId = await createClient(adminToken, `R20b Sarah Client ${suffix}`, `r20b.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20b Michael Client ${suffix}`, `r20b.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `R20b Sarah Merge Matter ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20b Michael Merge Matter ${suffix}`, 'Michael Oduor');

    sarahPdfA = await insertDocument({ id: `DOC_R20B_SA_${suffix}`, matterId: sarahMatterId, name: `r20b-sarah-a-${suffix}.pdf`, content: await pdfBuffer(`Sarah PDF A ${suffix}`) });
    sarahPdfB = await insertDocument({ id: `DOC_R20B_SB_${suffix}`, matterId: sarahMatterId, name: `r20b-sarah-b-${suffix}.pdf`, content: await pdfBuffer(`Sarah PDF B ${suffix}`) });
    michaelPdfA = await insertDocument({ id: `DOC_R20B_MA_${suffix}`, matterId: michaelMatterId, name: `r20b-michael-a-${suffix}.pdf`, content: await pdfBuffer(`Michael PDF A ${suffix}`) });
    michaelPdfB = await insertDocument({ id: `DOC_R20B_MB_${suffix}`, matterId: michaelMatterId, name: `r20b-michael-b-${suffix}.pdf`, content: await pdfBuffer(`Michael PDF B ${suffix}`) });
    textDoc = await insertDocument({ id: `DOC_R20B_TXT_${suffix}`, matterId: sarahMatterId, name: `r20b-text-${suffix}.txt`, mimeType: 'text/plain', type: 'Text', content: Buffer.from('R20b text document body') });
    corruptPdf = await insertDocument({ id: `DOC_R20B_BAD_${suffix}`, matterId: sarahMatterId, name: `r20b-corrupt-${suffix}.pdf`, content: Buffer.from('%PDF-r20b-not-a-valid-pdf') });
  });

  test('admin can merge two accessible matter PDF documents', async () => {
    const res = await mergeDownloadRequest(adminToken, [sarahPdfA, sarahPdfB]);
    expect(res.statusCode).toBe(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(100);
  });

  test('response headers are application/pdf and attachment filename ends .pdf', async () => {
    const res = await mergeDownloadRequest(adminToken, [sarahPdfA, sarahPdfB], 'r20b-header-output');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(res.headers['content-disposition']).toMatch(/attachment;\s*filename="r20b-header-output\.pdf"/);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  test('response body starts with %PDF', async () => {
    const res = await mergeDownloadRequest(adminToken, [sarahPdfA, sarahPdfB]);
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('advocate can merge PDFs from an assigned matter', async () => {
    const res = await mergeDownloadRequest(advocateToken, [sarahPdfA, sarahPdfB], 'r20b-advocate.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('advocate cannot merge PDFs from an inaccessible matter', async () => {
    const res = await mergeRequest(advocateToken, [michaelPdfA, michaelPdfB]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/document access denied/i);
  });

  test('client cannot call merge route', async () => {
    const res = await request(app)
      .post('/api/document-tools/merge-pdfs')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ documentIds: [sarahPdfA, sarahPdfB], filename: 'client.pdf' });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access required/i);
  });

  test('non-PDF document is rejected', async () => {
    const res = await mergeRequest(adminToken, [sarahPdfA, textDoc]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  test('fewer than 2 PDFs rejected', async () => {
    const res = await mergeRequest(adminToken, [sarahPdfA]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/at least 2/i);
  });

  test('more than 10 PDFs rejected', async () => {
    const res = await mergeRequest(adminToken, Array.from({ length: 11 }, (_, index) => `DOC_R20B_OVER_${suffix}_${index}`));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/no more than 10/i);
  });

  test('duplicate document IDs rejected', async () => {
    const res = await mergeRequest(adminToken, [sarahPdfA, sarahPdfA]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
  });

  test('different-matter documents rejected', async () => {
    const res = await mergeRequest(adminToken, [sarahPdfA, michaelPdfA]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/same matter/i);
  });

  test('corrupt PDF rejected safely', async () => {
    const res = await mergeRequest(adminToken, [sarahPdfA, corruptPdf]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/could not be read/i);
  });

  test('no new documents row is created by merge', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await mergeDownloadRequest(adminToken, [sarahPdfA, sarahPdfB]);
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count);
  });

  test('audit event is created with safe metadata only', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await mergeDownloadRequest(adminToken, [sarahPdfA, sarahPdfB], 'r20b-audit.pdf');
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_merge_pdf_downloaded', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');
    expect(event.entity_id).toBe(sarahMatterId);

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.sourceDocumentIds).toEqual([sarahPdfA, sarahPdfB]);
    expect(metadata.documentCount).toBe(2);
    expect(metadata.matterId).toBe(sarahMatterId);
    expect(metadata.combinedInputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf', 'sarah pdf']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
