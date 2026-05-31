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

async function multiPagePdf(pageCount, label) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const page = pdf.addPage([210 * 4, 297 * 4]);
    page.drawText(`${label} page ${i + 1}`, { x: 50, y: 150, size: 10, font });
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
      'r20g-test',
    ],
  );
  return id;
}

function paginateDownloadRequest(token, documentId, startNumber = 1, position = 'bottom-center', filename = 'r20g-paginated.pdf') {
  const body = { documentId, filename };
  if (startNumber !== undefined) body.startNumber = startNumber;
  if (position !== undefined) body.position = position;
  return request(app)
    .post('/api/document-tools/number-pdf-pages')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
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

function paginateSaveRequest(token, matterId, documentId, startNumber = 1, position = 'bottom-center', filename = 'r20g-paginated-save.pdf') {
  return request(app)
    .post('/api/document-tools/number-pdf-pages/save')
    .set('Authorization', `Bearer ${token}`)
    .send({ matterId, documentId, startNumber, position, filename });
}

async function outputPageCount(buffer) {
  const pdf = await PDFDocument.load(buffer);
  return pdf.getPageCount();
}

describe('PRODUCT-14H PDF page numbering tool', () => {
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

  const suffix = Date.now();
  let sarahClientId;
  let testClientToken;

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('/api/auth/login', 'admin@lexflow.co.ke');
    advocateToken = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    assistantToken = await login('/api/auth/login', 'david.wanjiku@achokilaw.co.ke');
    clientToken = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');

    sarahClientId = await createClient(adminToken, `R20g Sarah Client ${suffix}`, `r20g.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20g Michael Client ${suffix}`, `r20g.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `R20g Sarah Paginate Matter ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20g Michael Paginate Matter ${suffix}`, 'Michael Oduor');

    sarahPdf = await insertDocument({ id: `DOC_R20G_SA_${suffix}`, matterId: sarahMatterId, name: `r20g-sarah-${suffix}.pdf`, content: await multiPagePdf(5, `Sarah ${suffix}`) });
    michaelPdf = await insertDocument({ id: `DOC_R20G_MA_${suffix}`, matterId: michaelMatterId, name: `r20g-michael-${suffix}.pdf`, content: await multiPagePdf(3, `Michael ${suffix}`) });
    textDoc = await insertDocument({ id: `DOC_R20G_TXT_${suffix}`, matterId: sarahMatterId, name: `r20g-text-${suffix}.txt`, mimeType: 'text/plain', type: 'Text', content: Buffer.from('R20g text document body') });
    corruptPdf = await insertDocument({ id: `DOC_R20G_BAD_${suffix}`, matterId: sarahMatterId, name: `r20g-corrupt-${suffix}.pdf`, content: Buffer.from('%PDF-r20g-not-a-valid-pdf') });
    largePdf = await insertDocument({ id: `DOC_R20G_LRG_${suffix}`, matterId: sarahMatterId, name: `r20g-large-${suffix}.pdf`, content: Buffer.alloc(21 * 1024 * 1024) });

    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `r20g.client.user.${suffix}@example.com`, password: 'R20gPass!987', fullName: 'R20g Client User', role: 'client', clientId: sarahClientId });
    expect(registerRes.statusCode).toBe(200);
    const loginRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: `r20g.client.user.${suffix}@example.com`, password: 'R20gPass!987' });
    expect(loginRes.statusCode).toBe(200);
    testClientToken = loginRes.body.token;
  });

  test('1. admin temp download success', async () => {
    const res = await paginateDownloadRequest(adminToken, sarahPdf, 1, 'bottom-center');
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('2. advocate (assigned) temp download success', async () => {
    const res = await paginateDownloadRequest(advocateToken, sarahPdf, 1, 'bottom-right');
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('3. assistant temp download success', async () => {
    const res = await paginateDownloadRequest(assistantToken, sarahPdf, 1, 'bottom-left');
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('4. advocate inaccessible matter rejected', async () => {
    const res = await paginateDownloadRequest(advocateToken, michaelPdf);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('5. client rejected', async () => {
    const res = await paginateDownloadRequest(clientToken, sarahPdf);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  test('6. non-PDF document rejected', async () => {
    const res = await paginateDownloadRequest(adminToken, textDoc);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  test('7. nonexistent document rejected', async () => {
    const res = await paginateDownloadRequest(adminToken, 'NONEXISTENT_DOC');
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('8. corrupt PDF rejected safely', async () => {
    const res = await paginateDownloadRequest(adminToken, corruptPdf);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/could not read/i);
  });

  test('9. blank start number defaults to 1', async () => {
    const res = await paginateDownloadRequest(adminToken, sarahPdf, undefined, 'bottom-center');
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('10. start number = 0 rejected', async () => {
    const res = await paginateDownloadRequest(adminToken, sarahPdf, 0);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/positive integer/i);
  });

  test('11. start number negative rejected', async () => {
    const res = await paginateDownloadRequest(adminToken, sarahPdf, -1);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/positive integer/i);
  });

  test('12. start number decimal rejected', async () => {
    const res = await paginateDownloadRequest(adminToken, sarahPdf, 1.5);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/positive integer/i);
  });

  test('13. start number too large (100000) rejected', async () => {
    const res = await paginateDownloadRequest(adminToken, sarahPdf, 100000);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/99999/);
  });

  test('14. invalid position rejected', async () => {
    const res = await paginateDownloadRequest(adminToken, sarahPdf, 1, 'top-left');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/position/);
  });

  test('15. response headers correct for PDF download', async () => {
    const res = await paginateDownloadRequest(adminToken, sarahPdf, 1, 'bottom-center', 'test-output.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/i);
    expect(res.headers['cache-control']).toMatch(/no-store/i);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('16. output page count equals original page count', async () => {
    const res = await paginateDownloadRequest(adminToken, sarahPdf, 1, 'bottom-center');
    expect(res.statusCode).toBe(200);
    const count = await outputPageCount(res.body);
    expect(count).toBe(5);
  });

  test('17. temp route creates no new document row', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await paginateDownloadRequest(adminToken, sarahPdf, 1, 'bottom-center');
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count);
  });

  test('18. audit event document_tool_number_pdf_pages_downloaded created', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await paginateDownloadRequest(adminToken, sarahPdf, 5, 'bottom-right', 'r20g-audit.pdf');
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_number_pdf_pages_downloaded', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');
    expect(event.entity_id).toBe(sarahPdf);

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.sourceDocumentId).toBe(sarahPdf);
    expect(metadata.sourceMatterId).toBe(sarahMatterId);
    expect(metadata.startNumber).toBe(5);
    expect(metadata.position).toBe('bottom-right');
    expect(metadata.pageCount).toBe(5);
    expect(metadata.inputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);
    expect(metadata.filename).toMatch(/\.pdf$/i);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf', 'sarah page']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('19. admin save success', async () => {
    const res = await paginateSaveRequest(adminToken, sarahMatterId, sarahPdf, 1, 'bottom-center', 'r20g-save-admin.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('20. advocate assigned-matter save success', async () => {
    const res = await paginateSaveRequest(advocateToken, sarahMatterId, sarahPdf, 1, 'bottom-right', 'r20g-adv-save.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('21. advocate inaccessible matter save rejected', async () => {
    const res = await paginateSaveRequest(advocateToken, michaelMatterId, michaelPdf, 1);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('22. assistant rejected from save route', async () => {
    const res = await paginateSaveRequest(assistantToken, sarahMatterId, sarahPdf, 1);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('23. client rejected from save route', async () => {
    const res = await paginateSaveRequest(clientToken, sarahMatterId, sarahPdf, 1);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('24. saved doc row source = document_tool', async () => {
    const res = await paginateSaveRequest(adminToken, sarahMatterId, sarahPdf, 1, 'bottom-center', 'r20g-src-check.pdf');
    expect(res.statusCode).toBe(200);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(saved.source).toBe('document_tool');
  });

  test('25. saved doc row mimeType = application/pdf', async () => {
    const res = await paginateSaveRequest(adminToken, sarahMatterId, sarahPdf, 1, 'bottom-center', 'r20g-mime-check.pdf');
    expect(res.statusCode).toBe(200);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(saved.mimeType).toBe('application/pdf');
  });

  test('26. saved doc row clientVisible = 0', async () => {
    const res = await paginateSaveRequest(adminToken, sarahMatterId, sarahPdf, 1, 'bottom-center', 'r20g-cv-check.pdf');
    expect(res.statusCode).toBe(200);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(Number(saved.clientVisible)).toBe(0);
  });

  test('27. saved doc content BLOB present', async () => {
    const res = await paginateSaveRequest(adminToken, sarahMatterId, sarahPdf, 1, 'bottom-center', 'r20g-blob-check.pdf');
    expect(res.statusCode).toBe(200);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(saved.content).toBeDefined();
    expect(Buffer.isBuffer(saved.content) ? saved.content.length : Buffer.from(saved.content).length).toBeGreaterThan(0);
  });

  test('28. saved doc downloadable via GET', async () => {
    const res = await paginateSaveRequest(adminToken, sarahMatterId, sarahPdf, 1, 'bottom-center', 'r20g-dl-check.pdf');
    expect(res.statusCode).toBe(200);
    const download = await request(app)
      .get(`/api/documents/${res.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(download.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('29. saved doc appears in matter documents list', async () => {
    const res = await paginateSaveRequest(adminToken, sarahMatterId, sarahPdf, 1, 'bottom-center', 'r20g-list-check.pdf');
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(docsRes.statusCode).toBe(200);
    const ids = docsRes.body.map(d => d.id);
    expect(ids).toContain(res.body.id);
  });

  test('30. saved doc not in client-visible documents', async () => {
    const res = await paginateSaveRequest(adminToken, sarahMatterId, sarahPdf, 1, 'bottom-center', 'r20g-client-vis.pdf');
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${testClientToken}`);
    expect(docsRes.statusCode).toBe(200);
    const ids = docsRes.body.map(d => d.id);
    expect(ids).not.toContain(res.body.id);
  });

  test('31. existing merge route still passes sanity check', async () => {
    const docA = await insertDocument({ id: `DOC_R20G_SAN_A_${suffix}`, matterId: sarahMatterId, name: `r20g-sanity-a-${suffix}.pdf`, content: await multiPagePdf(2, 'Sanity A') });
    const docB = await insertDocument({ id: `DOC_R20G_SAN_B_${suffix}`, matterId: sarahMatterId, name: `r20g-sanity-b-${suffix}.pdf`, content: await multiPagePdf(2, 'Sanity B') });

    const mergeRes = await request(app)
      .post('/api/document-tools/merge-pdfs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentIds: [docA, docB], filename: 'r20g-sanity-merge.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(mergeRes.statusCode).toBe(200);
    expect(mergeRes.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('32. existing rotate route still passes sanity check', async () => {
    const rotateRes = await request(app)
      .post('/api/document-tools/rotate-pdf')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf, degrees: 90, filename: 'r20g-sanity-rotate.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(rotateRes.statusCode).toBe(200);
    expect(rotateRes.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('33. existing extract route still passes sanity check', async () => {
    const extractRes = await request(app)
      .post('/api/document-tools/extract-pdf-pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf, ranges: '1-2', filename: 'r20g-sanity-extract.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(extractRes.statusCode).toBe(200);
    expect(extractRes.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('34. existing delete route still passes sanity check', async () => {
    const deleteRes = await request(app)
      .post('/api/document-tools/delete-pdf-pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf, pages: '1', filename: 'r20g-sanity-delete.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.slice(0, 4).toString()).toBe('%PDF');
  });
});
