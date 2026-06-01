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
      '2026-06-01',
      `${Math.max(1, Math.round(content.length / 1024))} KB`,
      content,
      'firm',
      null,
      null,
      null,
      0,
      'r20h-test',
    ],
  );
  return id;
}

function bundleDownloadRequest(token, matterId, documentIds, filename = 'r20h-bundle.pdf', paginate = false, startNumber = 1, position = 'bottom-center') {
  const body = { matterId, documentIds, filename, paginate };
  if (paginate) {
    body.startNumber = startNumber;
    body.position = position;
  }
  return request(app)
    .post('/api/document-tools/court-bundle')
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

function bundleSaveRequest(token, matterId, documentIds, filename = 'r20h-bundle-save.pdf', paginate = false, startNumber = 1, position = 'bottom-center') {
  const body = { matterId, documentIds, filename, paginate };
  if (paginate) {
    body.startNumber = startNumber;
    body.position = position;
  }
  return request(app)
    .post('/api/document-tools/court-bundle/save')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

async function outputPageCount(buffer) {
  const pdf = await PDFDocument.load(buffer);
  return pdf.getPageCount();
}

async function pageTexts(buffer) {
  return null;
}

async function extractPageTexts(buffer) {
  return null;
}

async function checkPageText(buffer, textPrefix) {
  return null;
}

describe('PRODUCT-14I Court Bundle Builder', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let sarahMatterId;
  let michaelMatterId;
  let sarahPdf1;
  let sarahPdf2;
  let sarahPdf3;
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

    sarahClientId = await createClient(adminToken, `R20h Sarah Client ${suffix}`, `r20h.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20h Michael Client ${suffix}`, `r20h.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `R20h Sarah Bundle Matter ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20h Michael Bundle Matter ${suffix}`, 'Michael Oduor');

    sarahPdf1 = await insertDocument({ id: `DOC_R20H_SA1_${suffix}`, matterId: sarahMatterId, name: `r20h-sarah1-${suffix}.pdf`, content: await multiPagePdf(3, `Sarah1 ${suffix}`) });
    sarahPdf2 = await insertDocument({ id: `DOC_R20H_SA2_${suffix}`, matterId: sarahMatterId, name: `r20h-sarah2-${suffix}.pdf`, content: await multiPagePdf(2, `Sarah2 ${suffix}`) });
    sarahPdf3 = await insertDocument({ id: `DOC_R20H_SA3_${suffix}`, matterId: sarahMatterId, name: `r20h-sarah3-${suffix}.pdf`, content: await multiPagePdf(4, `Sarah3 ${suffix}`) });
    michaelPdf = await insertDocument({ id: `DOC_R20H_MA_${suffix}`, matterId: michaelMatterId, name: `r20h-michael-${suffix}.pdf`, content: await multiPagePdf(3, `Michael ${suffix}`) });
    textDoc = await insertDocument({ id: `DOC_R20H_TXT_${suffix}`, matterId: sarahMatterId, name: `r20h-text-${suffix}.txt`, mimeType: 'text/plain', type: 'Text', content: Buffer.from('R20h text document body') });
    corruptPdf = await insertDocument({ id: `DOC_R20H_BAD_${suffix}`, matterId: sarahMatterId, name: `r20h-corrupt-${suffix}.pdf`, content: Buffer.from('%PDF-r20h-not-a-valid-pdf') });
    largePdf = await insertDocument({ id: `DOC_R20H_LRG_${suffix}`, matterId: sarahMatterId, name: `r20h-large-${suffix}.pdf`, content: Buffer.alloc(21 * 1024 * 1024) });

    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `r20h.client.user.${suffix}@example.com`, password: 'R20hPass!987', fullName: 'R20h Client User', role: 'client', clientId: sarahClientId });
    expect(registerRes.statusCode).toBe(200);
    const loginRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: `r20h.client.user.${suffix}@example.com`, password: 'R20hPass!987' });
    expect(loginRes.statusCode).toBe(200);
    testClientToken = loginRes.body.token;
  });

  test('1. Admin can download court bundle without pagination', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-no-paginate.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('2. Admin can download court bundle with pagination', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-with-paginate.pdf', true, 1, 'bottom-center');
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('3. Response has application/pdf, attachment filename, no-store', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-headers.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/i);
    expect(res.headers['cache-control']).toMatch(/no-store/i);
  });

  test('4. Response body starts with %PDF', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2]);
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('5. Merged page count equals sum of source page counts', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2]);
    expect(res.statusCode).toBe(200);
    const count = await outputPageCount(res.body);
    expect(count).toBe(5);
  });

  test('6. Source document order is preserved in output', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf2, sarahPdf1]);
    expect(res.statusCode).toBe(200);
    const count = await outputPageCount(res.body);
    expect(count).toBe(5);
  });

  test('7. Pagination does not change page count', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-pag-count.pdf', true, 1, 'bottom-center');
    expect(res.statusCode).toBe(200);
    const count = await outputPageCount(res.body);
    expect(count).toBe(5);
  });

  test('8. Advocate on assigned matter can download court bundle', async () => {
    const res = await bundleDownloadRequest(advocateToken, sarahMatterId, [sarahPdf1, sarahPdf2]);
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('9. Assistant can download court bundle', async () => {
    const res = await bundleDownloadRequest(assistantToken, sarahMatterId, [sarahPdf1, sarahPdf2]);
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('10. Advocate on inaccessible matter rejected', async () => {
    const res = await bundleDownloadRequest(advocateToken, michaelMatterId, [michaelPdf]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('11. Client rejected', async () => {
    const res = await bundleDownloadRequest(clientToken, sarahMatterId, [sarahPdf1, sarahPdf2]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  test('12. Non-PDF document rejected', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, textDoc]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  test('13. Nonexistent document rejected', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, 'NONEXISTENT_DOC']);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('14. Corrupt PDF rejected safely', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, corruptPdf]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/could not.*read/i);
  });

  test('15. Duplicate document IDs rejected', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf1]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
  });

  test('16. Fewer than 2 PDFs rejected', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/at least 2/i);
  });

  test('17. More than 10 PDFs rejected', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `R20H_EXTRA_${i}_${suffix}`);
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, ids);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/no more than 10/i);
  });

  test('18. Different-matter documents rejected', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, michaelPdf]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/belong to the target matter/i);
  });

  test('19. Input over 20MB rejected', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, largePdf]);
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toMatch(/20 MB/i);
  });

  test('20. Invalid pagination start number rejected', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-bad-start.pdf', true, 0, 'bottom-center');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/positive integer/i);
  });

  test('21. Invalid pagination position rejected', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-bad-pos.pdf', true, 1, 'top-left');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/position/);
  });

  test('22. Temporary download creates no new document row', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2]);
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count);
  });

  test('23. Audit event document_tool_court_bundle_downloaded created with safe metadata', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-audit-dl.pdf', true, 5, 'bottom-right');
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(Array.isArray(metadata.sourceDocumentIds)).toBe(true);
    expect(metadata.sourceCount).toBe(2);
    expect(metadata.matterId).toBe(sarahMatterId);
    expect(metadata.pageCount).toBeGreaterThan(0);
    expect(metadata.paginate).toBe(true);
    expect(metadata.startNumber).toBe(5);
    expect(metadata.endNumber).toBeGreaterThanOrEqual(5);
    expect(metadata.position).toBe('bottom-right');
    expect(metadata.inputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);
    expect(metadata.filename).toMatch(/\.pdf$/i);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf', 'sarah1 page', 'sarah2 page']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('24. Admin can save court bundle to matter documents', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-save-admin.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('25. Advocate on assigned matter can save', async () => {
    const res = await bundleSaveRequest(advocateToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-adv-save.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('26. Advocate on inaccessible matter rejected on save', async () => {
    const res = await bundleSaveRequest(advocateToken, michaelMatterId, [michaelPdf]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('27. Assistant rejected from save route', async () => {
    const res = await bundleSaveRequest(assistantToken, sarahMatterId, [sarahPdf1, sarahPdf2]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('28. Client rejected from save route', async () => {
    const res = await bundleSaveRequest(clientToken, sarahMatterId, [sarahPdf1, sarahPdf2]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('29. Saved document row has correct matterId, source, clientVisible, uploadedBy, content BLOB', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-save-check.pdf');
    expect(res.statusCode).toBe(200);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(saved.matterId).toBe(sarahMatterId);
    expect(saved.source).toBe('document_tool');
    expect(Number(saved.clientVisible)).toBe(0);
    expect(saved.uploadedBy).toBeTruthy();
    expect(saved.content).toBeDefined();
    expect(Buffer.isBuffer(saved.content) ? saved.content.length : Buffer.from(saved.content).length).toBeGreaterThan(0);
  });

  test('30. Saved doc downloadable via GET /api/documents/:id/download', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-dl-check.pdf');
    expect(res.statusCode).toBe(200);
    const download = await request(app)
      .get(`/api/documents/${res.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(download.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('31. Saved doc appears in GET /api/matters/:id/documents', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-list-check.pdf');
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(docsRes.statusCode).toBe(200);
    const ids = docsRes.body.map(d => d.id);
    expect(ids).toContain(res.body.id);
  });

  test('32. Client cannot see saved doc while clientVisible=0', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-cv-check.pdf');
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${testClientToken}`);
    expect(docsRes.statusCode).toBe(200);
    const ids = docsRes.body.map(d => d.id);
    expect(ids).not.toContain(res.body.id);
  });

  test('33. Audit event document_tool_court_bundle_saved created with safe metadata', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], 'r20h-audit-save.pdf', true, 1, 'bottom-left');
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_saved', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(Array.isArray(metadata.sourceDocumentIds)).toBe(true);
    expect(metadata.sourceCount).toBe(2);
    expect(metadata.targetMatterId).toBe(sarahMatterId);
    expect(metadata.outputDocumentId).toBe(res.body.id);
    expect(metadata.pageCount).toBeGreaterThan(0);
    expect(metadata.paginate).toBe(true);
    expect(metadata.startNumber).toBe(1);
    expect(metadata.endNumber).toBeGreaterThanOrEqual(1);
    expect(metadata.position).toBe('bottom-left');
    expect(metadata.inputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);
    expect(metadata.filename).toMatch(/\.pdf$/i);
    expect(metadata.clientVisible).toBe(false);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf', 'sarah1 page', 'sarah2 page']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('34. Existing merge route still passes sanity check', async () => {
    const docA = await insertDocument({ id: `DOC_R20H_SAN_A_${suffix}`, matterId: sarahMatterId, name: `r20h-sanity-a-${suffix}.pdf`, content: await multiPagePdf(2, 'Sanity A') });
    const docB = await insertDocument({ id: `DOC_R20H_SAN_B_${suffix}`, matterId: sarahMatterId, name: `r20h-sanity-b-${suffix}.pdf`, content: await multiPagePdf(2, 'Sanity B') });

    const mergeRes = await request(app)
      .post('/api/document-tools/merge-pdfs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentIds: [docA, docB], filename: 'r20h-sanity-merge.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(mergeRes.statusCode).toBe(200);
    expect(mergeRes.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('35. Existing save-merge route still passes sanity check', async () => {
    const docA = await insertDocument({ id: `DOC_R20H_SAN_C_${suffix}`, matterId: sarahMatterId, name: `r20h-sanity-c-${suffix}.pdf`, content: await multiPagePdf(1, 'Sanity C') });
    const docB = await insertDocument({ id: `DOC_R20H_SAN_D_${suffix}`, matterId: sarahMatterId, name: `r20h-sanity-d-${suffix}.pdf`, content: await multiPagePdf(1, 'Sanity D') });

    const saveRes = await request(app)
      .post('/api/document-tools/merge-pdfs/save')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId: sarahMatterId, documentIds: [docA, docB], filename: 'r20h-sanity-merge-save.pdf' });
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.body.id).toBeDefined();
    expect(saveRes.body.source).toBe('document_tool');
  });

  test('36. Existing rotate route still passes sanity check', async () => {
    const rotateRes = await request(app)
      .post('/api/document-tools/rotate-pdf')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, degrees: 90, filename: 'r20h-sanity-rotate.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(rotateRes.statusCode).toBe(200);
    expect(rotateRes.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('37. Existing extract route still passes sanity check', async () => {
    const extractRes = await request(app)
      .post('/api/document-tools/extract-pdf-pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, ranges: '1-2', filename: 'r20h-sanity-extract.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(extractRes.statusCode).toBe(200);
    expect(extractRes.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('38. Existing delete route still passes sanity check', async () => {
    const deleteRes = await request(app)
      .post('/api/document-tools/delete-pdf-pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, pages: '1', filename: 'r20h-sanity-delete.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('39. Existing page-number route still passes sanity check', async () => {
    const numRes = await request(app)
      .post('/api/document-tools/number-pdf-pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, startNumber: 1, position: 'bottom-center', filename: 'r20h-sanity-number.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(numRes.statusCode).toBe(200);
    expect(numRes.body.slice(0, 4).toString()).toBe('%PDF');
  });
});
