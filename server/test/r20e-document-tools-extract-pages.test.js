const request = require('supertest');
const sqlite3 = require('sqlite3');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(30000);

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

// Each 1-based page p gets a distinct width (200 + (p-1)*5) so page order can be
// verified from the extracted output without reading rendered text.
function pageWidth(pageNumber) {
  return 200 + (pageNumber - 1) * 5;
}

async function multiPagePdf(pageCount, label) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const page = pdf.addPage([pageWidth(i + 1), 300]);
    page.drawText(`${label} page ${i + 1}`, { x: 10, y: 150, size: 10, font });
  }
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
      'r20e-test',
    ],
  );
  return id;
}

function extractRequest(token, documentId, ranges, filename = 'r20e-extracted.pdf') {
  return request(app)
    .post('/api/document-tools/extract-pdf-pages')
    .set('Authorization', `Bearer ${token}`)
    .send({ documentId, ranges, filename })
    .buffer(true)
    .parse((res, callback) => {
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
    });
}

function extractSaveRequest(token, matterId, documentId, ranges, filename = 'r20e-extracted-save.pdf') {
  return request(app)
    .post('/api/document-tools/extract-pdf-pages/save')
    .set('Authorization', `Bearer ${token}`)
    .send({ matterId, documentId, ranges, filename });
}

async function outputPageWidths(buffer) {
  const pdf = await PDFDocument.load(buffer);
  return pdf.getPages().map(page => Math.round(page.getWidth()));
}

describe('PRODUCT-14F extract PDF pages tool', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let sarahMatterId;
  let michaelMatterId;
  let sarahPdf;
  let michaelPdf;
  let textDoc;
  let corruptPdf;
  let largePdf;
  let bigPagePdf;

  const suffix = Date.now();
  let sarahClientId;
  let testClientToken;

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('/api/auth/login', 'admin@lexflow.co.ke');
    advocateToken = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    assistantToken = await login('/api/auth/login', 'david.wanjiku@achokilaw.co.ke');
    clientToken = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');

    sarahClientId = await createClient(adminToken, `R20e Sarah Client ${suffix}`, `r20e.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20e Michael Client ${suffix}`, `r20e.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `R20e Sarah Extract Matter ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20e Michael Extract Matter ${suffix}`, 'Michael Oduor');

    sarahPdf = await insertDocument({ id: `DOC_R20E_SA_${suffix}`, matterId: sarahMatterId, name: `r20e-sarah-${suffix}.pdf`, content: await multiPagePdf(7, `Sarah ${suffix}`) });
    michaelPdf = await insertDocument({ id: `DOC_R20E_MA_${suffix}`, matterId: michaelMatterId, name: `r20e-michael-${suffix}.pdf`, content: await multiPagePdf(3, `Michael ${suffix}`) });
    textDoc = await insertDocument({ id: `DOC_R20E_TXT_${suffix}`, matterId: sarahMatterId, name: `r20e-text-${suffix}.txt`, mimeType: 'text/plain', type: 'Text', content: Buffer.from('R20e text document body') });
    corruptPdf = await insertDocument({ id: `DOC_R20E_BAD_${suffix}`, matterId: sarahMatterId, name: `r20e-corrupt-${suffix}.pdf`, content: Buffer.from('%PDF-r20e-not-a-valid-pdf') });
    largePdf = await insertDocument({ id: `DOC_R20E_LRG_${suffix}`, matterId: sarahMatterId, name: `r20e-large-${suffix}.pdf`, content: Buffer.alloc(21 * 1024 * 1024) });
    bigPagePdf = await insertDocument({ id: `DOC_R20E_BIG_${suffix}`, matterId: sarahMatterId, name: `r20e-big-${suffix}.pdf`, content: await multiPagePdf(251, `Big ${suffix}`) });

    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `r20e.client.user.${suffix}@example.com`, password: 'R20ePass!987', fullName: 'R20e Client User', role: 'client', clientId: sarahClientId });
    expect(registerRes.statusCode).toBe(200);
    const loginRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: `r20e.client.user.${suffix}@example.com`, password: 'R20ePass!987' });
    expect(loginRes.statusCode).toBe(200);
    testClientToken = loginRes.body.token;
  });

  test('1. admin can extract selected pages as temporary download', async () => {
    const res = await extractRequest(adminToken, sarahPdf, '1-3,5,7');
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('2. response has application/pdf, attachment filename, no-store', async () => {
    const res = await extractRequest(adminToken, sarahPdf, '1-2');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/i);
    expect(res.headers['cache-control']).toMatch(/no-store/i);
  });

  test('3. response body starts with %PDF', async () => {
    const res = await extractRequest(adminToken, sarahPdf, '2,4');
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('4. output page count equals requested pages', async () => {
    const res = await extractRequest(adminToken, sarahPdf, '1-3,5,7');
    expect(res.statusCode).toBe(200);
    const widths = await outputPageWidths(res.body);
    expect(widths.length).toBe(5);
  });

  test('5. explicit order is preserved, e.g. 5,1', async () => {
    const res = await extractRequest(adminToken, sarahPdf, '5,1');
    expect(res.statusCode).toBe(200);
    const widths = await outputPageWidths(res.body);
    expect(widths).toEqual([pageWidth(5), pageWidth(1)]);
  });

  test('6. advocate on assigned matter can extract as temporary download', async () => {
    const res = await extractRequest(advocateToken, sarahPdf, '1,2');
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('7. assistant can extract as temporary download, matching requireStaff', async () => {
    const res = await extractRequest(assistantToken, sarahPdf, '1,2');
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('8. advocate on inaccessible matter is rejected', async () => {
    const res = await extractRequest(advocateToken, michaelPdf, '1');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('9. client is rejected', async () => {
    const res = await extractRequest(clientToken, sarahPdf, '1');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  test('10. non-PDF document rejected', async () => {
    const res = await extractRequest(adminToken, textDoc, '1');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  test('11. nonexistent document rejected', async () => {
    const res = await extractRequest(adminToken, 'NONEXISTENT_DOC', '1');
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('12. corrupt PDF rejected safely', async () => {
    const res = await extractRequest(adminToken, corruptPdf, '1');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/could not read/i);
  });

  test('13. input over 20MB rejected', async () => {
    const res = await extractRequest(adminToken, largePdf, '1');
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toMatch(/20 MB/i);
  });

  test('14. invalid ranges rejected', async () => {
    const cases = ['', '0', '-1', '999', '5-2', '1,1', '1-2-3', '1.5'];
    for (const ranges of cases) {
      const res = await extractRequest(adminToken, sarahPdf, ranges);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBeDefined();
    }
  });

  test('15. more than 250 selected pages rejected', async () => {
    const res = await extractRequest(adminToken, bigPagePdf, '1-251');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/250/);
  });

  test('16. temporary download creates no new document row', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await extractRequest(adminToken, sarahPdf, '1,3');
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count);
  });

  test('17. audit event document_tool_extract_pdf_pages_downloaded created with safe metadata', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await extractRequest(adminToken, sarahPdf, '1-2', 'r20e-audit.pdf');
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_extract_pdf_pages_downloaded', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');
    expect(event.entity_id).toBe(sarahPdf);

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.sourceDocumentId).toBe(sarahPdf);
    expect(metadata.sourceMatterId).toBe(sarahMatterId);
    expect(metadata.ranges).toBe('1-2');
    expect(metadata.extractedPageCount).toBe(2);
    expect(metadata.inputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);
    expect(metadata.filename).toMatch(/\.pdf$/i);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf', 'sarah page']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('18. admin can save extracted pages to matter documents', async () => {
    const res = await extractSaveRequest(adminToken, sarahMatterId, sarahPdf, '1-2', 'r20e-save-admin.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.matterId).toBe(sarahMatterId);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('19. save response includes id, mimeType, source, clientVisible', async () => {
    const res = await extractSaveRequest(adminToken, sarahMatterId, sarahPdf, '1,3', 'r20e-save-check.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
    expect(res.body.content).toBeUndefined();
  });

  test('20. advocate on assigned matter can save', async () => {
    const res = await extractSaveRequest(advocateToken, sarahMatterId, sarahPdf, '1-2', 'r20e-adv-save.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('21. advocate on inaccessible matter rejected', async () => {
    const res = await extractSaveRequest(advocateToken, michaelMatterId, michaelPdf, '1');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('22. assistant rejected from save route', async () => {
    const res = await extractSaveRequest(assistantToken, sarahMatterId, sarahPdf, '1');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('23. client rejected from save route', async () => {
    const res = await extractSaveRequest(clientToken, sarahMatterId, sarahPdf, '1');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('24. saved document row has correct field values', async () => {
    const res = await extractSaveRequest(adminToken, sarahMatterId, sarahPdf, '2-4', 'r20e-field-check.pdf');
    expect(res.statusCode).toBe(200);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(saved.matterId).toBe(sarahMatterId);
    expect(saved.source).toBe('document_tool');
    expect(Number(saved.clientVisible)).toBe(0);
    expect(saved.uploadedBy).toBeTruthy();
    expect(saved.content).toBeDefined();
    expect(Buffer.isBuffer(saved.content) ? saved.content.length : Buffer.from(saved.content).length).toBeGreaterThan(0);
    expect(saved.mimeType).toBe('application/pdf');
  });

  test('25. saved doc downloadable via GET /api/documents/:id/download', async () => {
    const res = await extractSaveRequest(adminToken, sarahMatterId, sarahPdf, '1-2', 'r20e-dl.pdf');
    expect(res.statusCode).toBe(200);
    const download = await request(app)
      .get(`/api/documents/${res.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(download.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('26. saved doc appears in GET /api/matters/:id/documents', async () => {
    const res = await extractSaveRequest(adminToken, sarahMatterId, sarahPdf, '1-2', 'r20e-list.pdf');
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(docsRes.statusCode).toBe(200);
    const ids = docsRes.body.map(d => d.id);
    expect(ids).toContain(res.body.id);
  });

  test('27. client cannot see saved doc while clientVisible=0', async () => {
    const res = await extractSaveRequest(adminToken, sarahMatterId, sarahPdf, '1-2', 'r20e-client-vis.pdf');
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${testClientToken}`);
    expect(docsRes.statusCode).toBe(200);
    const ids = docsRes.body.map(d => d.id);
    expect(ids).not.toContain(res.body.id);
  });

  test('28. audit event document_tool_extract_pdf_pages_saved created with safe metadata', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await extractSaveRequest(adminToken, sarahMatterId, sarahPdf, '1-3', 'r20e-audit-save.pdf');
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_extract_pdf_pages_saved', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');
    expect(event.entity_id).toBe(res.body.id);

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.sourceDocumentId).toBe(sarahPdf);
    expect(metadata.targetMatterId).toBe(sarahMatterId);
    expect(metadata.outputDocumentId).toBe(res.body.id);
    expect(metadata.ranges).toBe('1-3');
    expect(metadata.extractedPageCount).toBe(3);
    expect(metadata.inputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);
    expect(metadata.clientVisible).toBe(false);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf', 'sarah page']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('29. existing merge route still passes sanity check', async () => {
    const docA = await insertDocument({ id: `DOC_R20E_SAN_A_${suffix}`, matterId: sarahMatterId, name: `r20e-sanity-a-${suffix}.pdf`, content: await multiPagePdf(2, 'Sanity A') });
    const docB = await insertDocument({ id: `DOC_R20E_SAN_B_${suffix}`, matterId: sarahMatterId, name: `r20e-sanity-b-${suffix}.pdf`, content: await multiPagePdf(2, 'Sanity B') });

    const mergeRes = await request(app)
      .post('/api/document-tools/merge-pdfs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentIds: [docA, docB], filename: 'r20e-sanity-merge.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(mergeRes.statusCode).toBe(200);
    expect(mergeRes.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('30. existing rotate route still passes sanity check', async () => {
    const rotateRes = await request(app)
      .post('/api/document-tools/rotate-pdf')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf, degrees: 90, filename: 'r20e-sanity-rotate.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(rotateRes.statusCode).toBe(200);
    expect(rotateRes.body.slice(0, 4).toString()).toBe('%PDF');
  });
});
