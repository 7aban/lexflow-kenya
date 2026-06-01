const request = require('supertest');
const sqlite3 = require('sqlite3');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(30000);

// Source test PDFs are created at [210*4, 297*4] = [840, 1188] points.
// The generated index page is A4 portrait [595.28, 841.89] => rounds to 595 x 842.
const SOURCE_PAGE = { width: 840, height: 1188 };
const A4_PAGE = { width: 595, height: 842 };

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
      'r20i-test',
    ],
  );
  return id;
}

function parsePdfResponse(res, callback) {
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

function bundleDownloadRequest(token, matterId, documentIds, opts = {}) {
  const {
    filename = 'r20i-bundle.pdf',
    paginate = false,
    startNumber = 1,
    position = 'bottom-center',
    includeIndex,
    documentLabels,
  } = opts;
  const body = { matterId, documentIds, filename, paginate };
  if (paginate) {
    body.startNumber = startNumber;
    body.position = position;
  }
  if (includeIndex !== undefined) body.includeIndex = includeIndex;
  if (documentLabels !== undefined) body.documentLabels = documentLabels;
  return request(app)
    .post('/api/document-tools/court-bundle')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .buffer(true)
    .parse(parsePdfResponse);
}

function bundleSaveRequest(token, matterId, documentIds, opts = {}) {
  const {
    filename = 'r20i-bundle-save.pdf',
    paginate = false,
    startNumber = 1,
    position = 'bottom-center',
    includeIndex,
    documentLabels,
  } = opts;
  const body = { matterId, documentIds, filename, paginate };
  if (paginate) {
    body.startNumber = startNumber;
    body.position = position;
  }
  if (includeIndex !== undefined) body.includeIndex = includeIndex;
  if (documentLabels !== undefined) body.documentLabels = documentLabels;
  return request(app)
    .post('/api/document-tools/court-bundle/save')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

async function outputPageCount(buffer) {
  const pdf = await PDFDocument.load(buffer);
  return pdf.getPageCount();
}

async function pageSizes(buffer) {
  const pdf = await PDFDocument.load(buffer);
  return pdf.getPages().map(page => {
    const { width, height } = page.getSize();
    return { width: Math.round(width), height: Math.round(height) };
  });
}

describe('PRODUCT-14J Court Bundle Index v1', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let sarahMatterId;
  let michaelMatterId;
  let sarahPdf1; // 3 pages
  let sarahPdf2; // 2 pages
  let sarahPdf3; // 4 pages
  let michaelPdf;
  let textDoc;
  let corruptPdf;
  let testClientToken;

  const suffix = Date.now();

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('/api/auth/login', 'admin@lexflow.co.ke');
    advocateToken = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    assistantToken = await login('/api/auth/login', 'david.wanjiku@achokilaw.co.ke');
    clientToken = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');

    const sarahClientId = await createClient(adminToken, `R20i Sarah Client ${suffix}`, `r20i.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20i Michael Client ${suffix}`, `r20i.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `R20i Sarah Bundle Matter ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20i Michael Bundle Matter ${suffix}`, 'Michael Oduor');

    sarahPdf1 = await insertDocument({ id: `DOC_R20I_SA1_${suffix}`, matterId: sarahMatterId, name: `r20i-sarah1-${suffix}.pdf`, content: await multiPagePdf(3, `Sarah1 ${suffix}`) });
    sarahPdf2 = await insertDocument({ id: `DOC_R20I_SA2_${suffix}`, matterId: sarahMatterId, name: `r20i-sarah2-${suffix}.pdf`, content: await multiPagePdf(2, `Sarah2 ${suffix}`) });
    sarahPdf3 = await insertDocument({ id: `DOC_R20I_SA3_${suffix}`, matterId: sarahMatterId, name: `r20i-sarah3-${suffix}.pdf`, content: await multiPagePdf(4, `Sarah3 ${suffix}`) });
    michaelPdf = await insertDocument({ id: `DOC_R20I_MA_${suffix}`, matterId: michaelMatterId, name: `r20i-michael-${suffix}.pdf`, content: await multiPagePdf(3, `Michael ${suffix}`) });
    textDoc = await insertDocument({ id: `DOC_R20I_TXT_${suffix}`, matterId: sarahMatterId, name: `r20i-text-${suffix}.txt`, mimeType: 'text/plain', type: 'Text', content: Buffer.from('R20i text document body') });
    corruptPdf = await insertDocument({ id: `DOC_R20I_BAD_${suffix}`, matterId: sarahMatterId, name: `r20i-corrupt-${suffix}.pdf`, content: Buffer.from('%PDF-r20i-not-a-valid-pdf') });

    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `r20i.client.user.${suffix}@example.com`, password: 'R20iPass!987', fullName: 'R20i Client User', role: 'client', clientId: sarahClientId });
    expect(registerRes.statusCode).toBe(200);
    const loginRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: `r20i.client.user.${suffix}@example.com`, password: 'R20iPass!987' });
    expect(loginRes.statusCode).toBe(200);
    testClientToken = loginRes.body.token;
  });

  // --- No-index backward compatibility ---------------------------------------

  test('1. Existing court bundle without index still works (page count = sources)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20i-noindex.pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(5);
  });

  test('2. includeIndex=false behaves exactly like no-index', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeIndex: false });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(5);
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(SOURCE_PAGE); // first page is a source page, not A4 index
  });

  test('3. No-index save still works (source=document_tool, clientVisible=0)', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20i-noindex-save.pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  // --- Index download --------------------------------------------------------

  test('4. Admin download with index, without pagination', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('5. Admin download with index and pagination', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeIndex: true, paginate: true, startNumber: 1, position: 'bottom-center' });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('6. Index response headers and %PDF bytes', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20i-headers.pdf', includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/i);
    expect(res.headers['cache-control']).toMatch(/no-store/i);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('7. Output page count equals selected source pages + 1 index page', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2, sarahPdf3], { includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(3 + 2 + 4 + 1); // 10
  });

  test('8. Index page is the first page and is A4; document pages follow', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeIndex: true });
    expect(res.statusCode).toBe(200);
    const sizes = await pageSizes(res.body);
    expect(sizes).toHaveLength(6);
    expect(sizes[0]).toEqual(A4_PAGE);       // index page first, A4
    expect(sizes[1]).toEqual(SOURCE_PAGE);   // document pages keep their original size
    expect(sizes[5]).toEqual(SOURCE_PAGE);
  });

  test('9. Source document order is preserved after the index page', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf2, sarahPdf1], { includeIndex: true });
    expect(res.statusCode).toBe(200);
    // index(1) + sarahPdf2(2) + sarahPdf1(3) = 6
    expect(await outputPageCount(res.body)).toBe(6);
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(A4_PAGE);
  });

  test('10. Default document names are used when no labels are supplied', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(6);
  });

  test('11. Custom document labels are accepted', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      includeIndex: true,
      documentLabels: { [sarahPdf1]: 'Memorandum of Appeal', [sarahPdf2]: 'Judgment' },
    });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(6);
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(A4_PAGE);
  });

  test('12. Long / unsafe labels are sanitized without crashing', async () => {
    const nasty = `  Memorandum 😀 of ‮ Appeal ${'x'.repeat(200)}`;
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      includeIndex: true,
      documentLabels: { [sarahPdf1]: nasty, [sarahPdf2]: 12345 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(6);
  });

  test('13. documentLabels as a non-object is ignored', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      includeIndex: true,
      documentLabels: ['not', 'an', 'object'],
    });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(6);
  });

  test('14. Pagination includes the index page when enabled', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20i-pag-index.pdf', includeIndex: true, paginate: true, startNumber: 1, position: 'bottom-center' });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(6);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.pageCount).toBe(6);
    expect(metadata.startNumber).toBe(1);
    expect(metadata.endNumber).toBe(6); // 1 + 6 - 1, index counted
  });

  // --- Access control on download with index ---------------------------------

  test('15. Advocate on assigned matter can download with index', async () => {
    const res = await bundleDownloadRequest(advocateToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('16. Assistant can download with index', async () => {
    const res = await bundleDownloadRequest(assistantToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('17. Advocate on inaccessible matter rejected (with index)', async () => {
    const res = await bundleDownloadRequest(advocateToken, michaelMatterId, [michaelPdf], { includeIndex: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('18. Client rejected (with index)', async () => {
    const res = await bundleDownloadRequest(clientToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeIndex: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  test('19. Non-PDF document rejected (with index)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, textDoc], { includeIndex: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  test('20. Duplicate document IDs rejected (with index)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf1], { includeIndex: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
  });

  test('21. Fewer than 2 PDFs rejected (with index)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1], { includeIndex: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/at least 2/i);
  });

  test('22. Different-matter documents rejected (with index)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, michaelPdf], { includeIndex: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/belong to the target matter/i);
  });

  test('23. Corrupt PDF rejected safely (with index)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, corruptPdf], { includeIndex: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/could not.*read/i);
  });

  test('24. Temporary index download creates no new document row', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeIndex: true });
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count);
  });

  test('25. Audit download event includes safe index metadata (no raw label text)', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const secretLabel = 'CONFIDENTIAL_LABEL_R20I_DOWNLOAD';
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      filename: 'r20i-audit-dl.pdf',
      includeIndex: true,
      documentLabels: { [sarahPdf1]: secretLabel },
    });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    expect(event).toBeDefined();
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.includeIndex).toBe(true);
    expect(metadata.indexPageCount).toBe(1);
    expect(metadata.labelCount).toBe(1);

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(secretLabel);
    const lower = serialized.toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf']) {
      expect(lower).not.toContain(forbidden);
    }
  });

  test('26. No-index audit records includeIndex=false and omits indexPageCount', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20i-audit-noindex.pdf' });
    expect(res.statusCode).toBe(200);
    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.includeIndex).toBe(false);
    expect(metadata.indexPageCount).toBeUndefined();
    expect(metadata.labelCount).toBeUndefined();
  });

  // --- Index save ------------------------------------------------------------

  test('27. Admin can save bundle with index', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20i-save-admin.pdf', includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('28. Advocate on assigned matter can save with index', async () => {
    const res = await bundleSaveRequest(advocateToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20i-adv-save.pdf', includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('29. Assistant rejected from save route (with index)', async () => {
    const res = await bundleSaveRequest(assistantToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeIndex: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('30. Client rejected from save route (with index)', async () => {
    const res = await bundleSaveRequest(clientToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeIndex: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('31. Saved index bundle row is correct and downloadable with sources + 1 pages', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20i-save-dl.pdf', includeIndex: true });
    expect(res.statusCode).toBe(200);

    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(saved.matterId).toBe(sarahMatterId);
    expect(saved.source).toBe('document_tool');
    expect(Number(saved.clientVisible)).toBe(0);
    expect(saved.uploadedBy).toBeTruthy();
    expect(Buffer.isBuffer(saved.content) ? saved.content.length : Buffer.from(saved.content).length).toBeGreaterThan(0);

    const download = await request(app)
      .get(`/api/documents/${res.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse(parsePdfResponse);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(download.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(download.body)).toBe(6);
    const sizes = await pageSizes(download.body);
    expect(sizes[0]).toEqual(A4_PAGE);
  });

  test('32. Saved index bundle appears in matter documents', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20i-list.pdf', includeIndex: true });
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(docsRes.statusCode).toBe(200);
    expect(docsRes.body.map(d => d.id)).toContain(res.body.id);
  });

  test('33. Client cannot see saved index bundle while clientVisible=0', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20i-cv.pdf', includeIndex: true });
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${testClientToken}`);
    expect(docsRes.statusCode).toBe(200);
    expect(docsRes.body.map(d => d.id)).not.toContain(res.body.id);
  });

  test('34. Audit save event includes safe index metadata (no raw label text)', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const secretLabel = 'CONFIDENTIAL_LABEL_R20I_SAVE';
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      filename: 'r20i-audit-save.pdf',
      includeIndex: true,
      paginate: true,
      startNumber: 1,
      position: 'bottom-left',
      documentLabels: { [sarahPdf1]: secretLabel, [sarahPdf2]: 'Judgment' },
    });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_saved', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.outputDocumentId).toBe(res.body.id);
    expect(metadata.includeIndex).toBe(true);
    expect(metadata.indexPageCount).toBe(1);
    expect(metadata.labelCount).toBe(2);
    expect(metadata.clientVisible).toBe(false);
    expect(metadata.pageCount).toBe(6);
    expect(metadata.endNumber).toBe(6);

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(secretLabel);
    const lower = serialized.toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf']) {
      expect(lower).not.toContain(forbidden);
    }
  });

  // --- Sibling-route sanity (no regression from shared file changes) ---------

  test('35. Existing page-number route still passes a sanity check', async () => {
    const numberRes = await request(app)
      .post('/api/document-tools/number-pdf-pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, startNumber: 1, position: 'bottom-center', filename: 'r20i-sanity-number.pdf' })
      .buffer(true)
      .parse(parsePdfResponse);
    expect(numberRes.statusCode).toBe(200);
    expect(numberRes.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(numberRes.body)).toBe(3);
  });
});
