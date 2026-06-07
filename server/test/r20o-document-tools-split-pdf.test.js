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
// verified from the reordered output without reading rendered text.
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
      '2026-06-06',
      `${Math.max(1, Math.round(content.length / 1024))} KB`,
      content,
      'firm',
      null,
      null,
      null,
      0,
      'r20o-test',
    ],
  );
  return id;
}

function splitRequest(token, documentId, order, filename = 'r20o-reordered.pdf') {
  return request(app)
    .post('/api/document-tools/split-pdf')
    .set('Authorization', `Bearer ${token}`)
    .send({ documentId, order, filename })
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

function splitSaveRequest(token, matterId, documentId, order, filename = 'r20o-reordered-save.pdf') {
  return request(app)
    .post('/api/document-tools/split-pdf/save')
    .set('Authorization', `Bearer ${token}`)
    .send({ matterId, documentId, order, filename });
}

async function outputPageWidths(buffer) {
  const pdf = await PDFDocument.load(buffer);
  return pdf.getPages().map(page => Math.round(page.getWidth()));
}

describe('PRODUCT-27D split / reorder PDF pages tool', () => {
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

    sarahClientId = await createClient(adminToken, `R20o Sarah Client ${suffix}`, `r20o.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20o Michael Client ${suffix}`, `r20o.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `R20o Sarah Split Matter ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20o Michael Split Matter ${suffix}`, 'Michael Oduor');

    sarahPdf = await insertDocument({ id: `DOC_R20O_SA_${suffix}`, matterId: sarahMatterId, name: `r20o-sarah-${suffix}.pdf`, content: await multiPagePdf(5, `Sarah ${suffix}`) });
    michaelPdf = await insertDocument({ id: `DOC_R20O_MA_${suffix}`, matterId: michaelMatterId, name: `r20o-michael-${suffix}.pdf`, content: await multiPagePdf(3, `Michael ${suffix}`) });
    textDoc = await insertDocument({ id: `DOC_R20O_TXT_${suffix}`, matterId: sarahMatterId, name: `r20o-text-${suffix}.txt`, mimeType: 'text/plain', type: 'Text', content: Buffer.from('R20o text document body') });
    corruptPdf = await insertDocument({ id: `DOC_R20O_BAD_${suffix}`, matterId: sarahMatterId, name: `r20o-corrupt-${suffix}.pdf`, content: Buffer.from('%PDF-r20o-not-a-valid-pdf') });
    largePdf = await insertDocument({ id: `DOC_R20O_LRG_${suffix}`, matterId: sarahMatterId, name: `r20o-large-${suffix}.pdf`, content: Buffer.alloc(21 * 1024 * 1024) });
    bigPagePdf = await insertDocument({ id: `DOC_R20O_BIG_${suffix}`, matterId: sarahMatterId, name: `r20o-big-${suffix}.pdf`, content: await multiPagePdf(251, `Big ${suffix}`) });

    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `r20o.client.user.${suffix}@example.com`, password: 'R20oPass!987', fullName: 'R20o Client User', role: 'client', clientId: sarahClientId });
    expect(registerRes.statusCode).toBe(200);
    const loginRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: `r20o.client.user.${suffix}@example.com`, password: 'R20oPass!987' });
    expect(loginRes.statusCode).toBe(200);
    testClientToken = loginRes.body.token;
  });

  // 1. Happy path download returns valid PDF.
  test('1. admin can reorder pages as temporary download (valid PDF)', async () => {
    const res = await splitRequest(adminToken, sarahPdf, '3,1,2');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/i);
    expect(res.headers['cache-control']).toMatch(/no-store/i);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  // 2. Reordered output preserves requested order.
  test('2. reordered output preserves the exact requested order', async () => {
    const res = await splitRequest(adminToken, sarahPdf, '3,1,2');
    expect(res.statusCode).toBe(200);
    const widths = await outputPageWidths(res.body);
    expect(widths).toEqual([pageWidth(3), pageWidth(1), pageWidth(2)]);
  });

  test('2b. simple range expands in order, e.g. 1-3,5', async () => {
    const res = await splitRequest(adminToken, sarahPdf, '1-3,5');
    expect(res.statusCode).toBe(200);
    const widths = await outputPageWidths(res.body);
    expect(widths).toEqual([pageWidth(1), pageWidth(2), pageWidth(3), pageWidth(5)]);
  });

  // 3. Repeated page numbers duplicate pages.
  test('3. repeated page numbers duplicate pages', async () => {
    const res = await splitRequest(adminToken, sarahPdf, '2,2,5');
    expect(res.statusCode).toBe(200);
    const widths = await outputPageWidths(res.body);
    expect(widths).toEqual([pageWidth(2), pageWidth(2), pageWidth(5)]);
  });

  // 4. Save creates a new matter document with source=document_tool.
  test('4. admin can save reordered pages with source=document_tool', async () => {
    const res = await splitSaveRequest(adminToken, sarahMatterId, sarahPdf, '3,1,2', 'r20o-save-admin.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.matterId).toBe(sarahMatterId);
    expect(res.body.source).toBe('document_tool');
    expect(res.body.content).toBeUndefined();
  });

  // 5. Saved document has clientVisible=0.
  test('5. saved document has clientVisible=0', async () => {
    const res = await splitSaveRequest(adminToken, sarahMatterId, sarahPdf, '1,2', 'r20o-vis.pdf');
    expect(res.statusCode).toBe(200);
    expect(Number(res.body.clientVisible)).toBe(0);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(Number(saved.clientVisible)).toBe(0);
    expect(saved.source).toBe('document_tool');
    expect(saved.uploadedBy).toBeTruthy();
  });

  // 6. Original source document content remains unchanged.
  test('6. original source document content is unchanged after download and save', async () => {
    const before = await dbGet('SELECT content FROM documents WHERE id=?', [sarahPdf]);
    const beforeBuf = Buffer.isBuffer(before.content) ? before.content : Buffer.from(before.content);

    const dl = await splitRequest(adminToken, sarahPdf, '5,4,3,2,1');
    expect(dl.statusCode).toBe(200);
    const sv = await splitSaveRequest(adminToken, sarahMatterId, sarahPdf, '5,4,3,2,1', 'r20o-unchanged.pdf');
    expect(sv.statusCode).toBe(200);

    const after = await dbGet('SELECT content FROM documents WHERE id=?', [sarahPdf]);
    const afterBuf = Buffer.isBuffer(after.content) ? after.content : Buffer.from(after.content);
    expect(afterBuf.equals(beforeBuf)).toBe(true);

    // Source page order/sizes are intact.
    const widths = await outputPageWidths(afterBuf);
    expect(widths).toEqual([pageWidth(1), pageWidth(2), pageWidth(3), pageWidth(4), pageWidth(5)]);
  });

  // 7. Client cannot call route.
  test('7. client is rejected from download route', async () => {
    const res = await splitRequest(clientToken, sarahPdf, '1');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  // 8. Assistant can download (requireStaff) but cannot save (requireAdvocateOrAdmin).
  test('8a. assistant can reorder as temporary download', async () => {
    const res = await splitRequest(assistantToken, sarahPdf, '1,2');
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('8b. assistant is rejected from save route', async () => {
    const res = await splitSaveRequest(assistantToken, sarahMatterId, sarahPdf, '1,2');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('8c. advocate on assigned matter can download and save', async () => {
    const dl = await splitRequest(advocateToken, sarahPdf, '2,1');
    expect(dl.statusCode).toBe(200);
    expect(dl.body.slice(0, 4).toString()).toBe('%PDF');
    const sv = await splitSaveRequest(advocateToken, sarahMatterId, sarahPdf, '2,1', 'r20o-adv-save.pdf');
    expect(sv.statusCode).toBe(200);
    expect(sv.body.source).toBe('document_tool');
    expect(Number(sv.body.clientVisible)).toBe(0);
  });

  // 9. Cross-matter or inaccessible document denied.
  test('9a. advocate on inaccessible matter is rejected on download', async () => {
    const res = await splitRequest(advocateToken, michaelPdf, '1');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('9b. advocate on inaccessible matter is rejected on save', async () => {
    const res = await splitSaveRequest(advocateToken, michaelMatterId, michaelPdf, '1');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('9c. document not belonging to the target matter is rejected on save', async () => {
    const res = await splitSaveRequest(adminToken, michaelMatterId, sarahPdf, '1');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/belong to the target matter/i);
  });

  test('9d. nonexistent document rejected', async () => {
    const res = await splitRequest(adminToken, 'NONEXISTENT_DOC', '1');
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // 10. Non-PDF source rejected.
  test('10. non-PDF document rejected', async () => {
    const res = await splitRequest(adminToken, textDoc, '1');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  test('10b. corrupt PDF rejected safely', async () => {
    const res = await splitRequest(adminToken, corruptPdf, '1');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/could not read/i);
  });

  test('10c. input over 20MB rejected', async () => {
    const res = await splitRequest(adminToken, largePdf, '1');
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toMatch(/20 MB/i);
  });

  // 11. Missing/empty order rejected.
  test('11. missing or empty order rejected', async () => {
    const missing = await request(app)
      .post('/api/document-tools/split-pdf')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf, filename: 'r20o-missing.pdf' });
    expect(missing.statusCode).toBe(400);
    expect(missing.body.error).toMatch(/order is required/i);

    const empty = await splitRequest(adminToken, sarahPdf, '   ');
    expect(empty.statusCode).toBe(400);
    expect(empty.body.error).toMatch(/order is required/i);
  });

  // 12. Out-of-range / invalid order rejected.
  test('12. invalid or out-of-range order rejected', async () => {
    const cases = ['0', '-1', '999', '5-2', '1-2-3', '1.5', 'abc', '2,,3'];
    for (const order of cases) {
      const res = await splitRequest(adminToken, sarahPdf, order);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBeDefined();
    }
  });

  test('12b. more than 250 output pages rejected', async () => {
    const res = await splitRequest(adminToken, bigPagePdf, '1-251');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/250/);
  });

  test('12c. temporary download creates no new document row', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await splitRequest(adminToken, sarahPdf, '1,3');
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count);
  });

  // 13. Audit events recorded for download and save.
  test('13a. document_tool_split_pdf_downloaded audit event has safe metadata', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await splitRequest(adminToken, sarahPdf, '3,1,2', 'r20o-audit.pdf');
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_split_pdf_downloaded', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');
    expect(event.entity_id).toBe(sarahPdf);

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.sourceDocumentId).toBe(sarahPdf);
    expect(metadata.sourceMatterId).toBe(sarahMatterId);
    expect(metadata.order).toBe('3,1,2');
    expect(metadata.pageCount).toBe(5);
    expect(metadata.outputPageCount).toBe(3);
    expect(metadata.inputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);
    expect(metadata.filename).toMatch(/\.pdf$/i);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf', 'sarah page']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('13b. document_tool_split_pdf_saved audit event has safe metadata', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await splitSaveRequest(adminToken, sarahMatterId, sarahPdf, '2,2,5', 'r20o-audit-save.pdf');
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_split_pdf_saved', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');
    expect(event.entity_id).toBe(res.body.id);

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.sourceDocumentId).toBe(sarahPdf);
    expect(metadata.targetMatterId).toBe(sarahMatterId);
    expect(metadata.outputDocumentId).toBe(res.body.id);
    expect(metadata.order).toBe('2,2,5');
    expect(metadata.pageCount).toBe(5);
    expect(metadata.outputPageCount).toBe(3);
    expect(metadata.inputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);
    expect(metadata.clientVisible).toBe(false);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf', 'sarah page']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('14. saved doc downloadable and listed for staff but hidden from client while clientVisible=0', async () => {
    const res = await splitSaveRequest(adminToken, sarahMatterId, sarahPdf, '1-2', 'r20o-list.pdf');
    expect(res.statusCode).toBe(200);

    const download = await request(app)
      .get(`/api/documents/${res.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(download.statusCode).toBe(200);
    expect(download.body.slice(0, 4).toString()).toBe('%PDF');

    const staffDocs = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(staffDocs.statusCode).toBe(200);
    expect(staffDocs.body.map(d => d.id)).toContain(res.body.id);

    const clientDocs = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${testClientToken}`);
    expect(clientDocs.statusCode).toBe(200);
    expect(clientDocs.body.map(d => d.id)).not.toContain(res.body.id);
  });
});
