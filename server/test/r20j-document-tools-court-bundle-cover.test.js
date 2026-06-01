const request = require('supertest');
const sqlite3 = require('sqlite3');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(30000);

// Source test PDFs are created at [210*4, 297*4] = [840, 1188] points.
// The generated cover and index pages are A4 portrait [595.28, 841.89] => 595 x 842.
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
      'r20j-test',
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

function buildBundleBody(matterId, documentIds, opts = {}) {
  const {
    filename,
    paginate = false,
    startNumber = 1,
    position = 'bottom-center',
    includeIndex,
    documentLabels,
    includeCover,
    cover,
  } = opts;
  const body = { matterId, documentIds, filename, paginate };
  if (paginate) {
    body.startNumber = startNumber;
    body.position = position;
  }
  if (includeIndex !== undefined) body.includeIndex = includeIndex;
  if (documentLabels !== undefined) body.documentLabels = documentLabels;
  if (includeCover !== undefined) body.includeCover = includeCover;
  if (cover !== undefined) body.cover = cover;
  return body;
}

function bundleDownloadRequest(token, matterId, documentIds, opts = {}) {
  const body = buildBundleBody(matterId, documentIds, { filename: 'r20j-bundle.pdf', ...opts });
  return request(app)
    .post('/api/document-tools/court-bundle')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .buffer(true)
    .parse(parsePdfResponse);
}

function bundleSaveRequest(token, matterId, documentIds, opts = {}) {
  const body = buildBundleBody(matterId, documentIds, { filename: 'r20j-bundle-save.pdf', ...opts });
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

describe('PRODUCT-14K Court Bundle Cover v1', () => {
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

    const sarahClientId = await createClient(adminToken, `R20j Sarah Client ${suffix}`, `r20j.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20j Michael Client ${suffix}`, `r20j.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `R20j Sarah Bundle Matter ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20j Michael Bundle Matter ${suffix}`, 'Michael Oduor');

    sarahPdf1 = await insertDocument({ id: `DOC_R20J_SA1_${suffix}`, matterId: sarahMatterId, name: `r20j-sarah1-${suffix}.pdf`, content: await multiPagePdf(3, `Sarah1 ${suffix}`) });
    sarahPdf2 = await insertDocument({ id: `DOC_R20J_SA2_${suffix}`, matterId: sarahMatterId, name: `r20j-sarah2-${suffix}.pdf`, content: await multiPagePdf(2, `Sarah2 ${suffix}`) });
    sarahPdf3 = await insertDocument({ id: `DOC_R20J_SA3_${suffix}`, matterId: sarahMatterId, name: `r20j-sarah3-${suffix}.pdf`, content: await multiPagePdf(4, `Sarah3 ${suffix}`) });
    michaelPdf = await insertDocument({ id: `DOC_R20J_MA_${suffix}`, matterId: michaelMatterId, name: `r20j-michael-${suffix}.pdf`, content: await multiPagePdf(3, `Michael ${suffix}`) });
    textDoc = await insertDocument({ id: `DOC_R20J_TXT_${suffix}`, matterId: sarahMatterId, name: `r20j-text-${suffix}.txt`, mimeType: 'text/plain', type: 'Text', content: Buffer.from('R20j text document body') });
    corruptPdf = await insertDocument({ id: `DOC_R20J_BAD_${suffix}`, matterId: sarahMatterId, name: `r20j-corrupt-${suffix}.pdf`, content: Buffer.from('%PDF-r20j-not-a-valid-pdf') });

    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `r20j.client.user.${suffix}@example.com`, password: 'R20jPass!987', fullName: 'R20j Client User', role: 'client', clientId: sarahClientId });
    expect(registerRes.statusCode).toBe(200);
    const loginRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: `r20j.client.user.${suffix}@example.com`, password: 'R20jPass!987' });
    expect(loginRes.statusCode).toBe(200);
    testClientToken = loginRes.body.token;
  });

  const sampleCover = {
    title: 'COURT BUNDLE',
    court: 'HIGH COURT OF KENYA AT NAIROBI',
    caseNumber: 'HCCC E000 OF 2026',
    caseTitle: 'A v B',
    bundleTitle: "DEFENDANT'S BUNDLE OF DOCUMENTS",
    preparedBy: 'T.K. RUTTO & CO. ADVOCATES',
    date: '1 June 2026',
  };

  // --- No-cover backward compatibility ---------------------------------------

  test('1. Existing court bundle without cover still works (page count = sources)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-nocover.pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(5);
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(SOURCE_PAGE); // first page is a source page, no cover
  });

  test('1b. includeCover=false behaves exactly like no-cover and records includeCover=false', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-cover-false.pdf', includeCover: false, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(5);
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(SOURCE_PAGE);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.includeCover).toBe(false);
    expect(metadata.coverFieldCount).toBe(0);
  });

  // --- Cover download --------------------------------------------------------

  test('2. Download with cover only succeeds', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('3. Download with cover + index succeeds', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover, includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('4. Download with cover + pagination succeeds', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover, paginate: true, startNumber: 1, position: 'bottom-center' });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('5. Download with cover + index + pagination succeeds', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover, includeIndex: true, paginate: true, startNumber: 1, position: 'bottom-right' });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('6. Cover response has application/pdf, attachment filename, no-store', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-headers.pdf', includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/i);
    expect(res.headers['content-disposition']).toMatch(/r20j-headers\.pdf/);
    expect(res.headers['cache-control']).toMatch(/no-store/i);
  });

  test('7. Cover response body starts with %PDF', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('8. Output page count equals source pages plus cover/index pages', async () => {
    const coverOnly = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2, sarahPdf3], { includeCover: true, cover: sampleCover });
    expect(coverOnly.statusCode).toBe(200);
    expect(await outputPageCount(coverOnly.body)).toBe(3 + 2 + 4 + 1); // sources + cover

    const coverIndex = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2, sarahPdf3], { includeCover: true, cover: sampleCover, includeIndex: true });
    expect(coverIndex.statusCode).toBe(200);
    expect(await outputPageCount(coverIndex.body)).toBe(3 + 2 + 4 + 2); // sources + cover + index
  });

  test('9. Cover page is inserted first (A4, then source pages)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    const sizes = await pageSizes(res.body);
    expect(sizes).toHaveLength(6); // 3 + 2 + 1 cover
    expect(sizes[0]).toEqual(A4_PAGE);      // cover first
    expect(sizes[1]).toEqual(SOURCE_PAGE);  // documents keep original size
    expect(sizes[5]).toEqual(SOURCE_PAGE);
  });

  test('10. Index follows cover when both are enabled (two A4 front pages, then sources)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover, includeIndex: true });
    expect(res.statusCode).toBe(200);
    const sizes = await pageSizes(res.body);
    expect(sizes).toHaveLength(7); // cover + index + 5 source pages
    expect(sizes[0]).toEqual(A4_PAGE);      // cover physical page 1
    expect(sizes[1]).toEqual(A4_PAGE);      // index physical page 2
    expect(sizes[2]).toEqual(SOURCE_PAGE);  // first document page 3
  });

  test('11. Index starting pages account for the cover page (structure + pagination metadata)', async () => {
    // With cover + index + pagination, every physical page is numbered: cover=1,
    // index=2, first document=3. The audit pageCount and endNumber must reflect
    // the two front-matter pages so printed numbers and starting pages line up.
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-cover-index-pag.pdf', includeCover: true, cover: sampleCover, includeIndex: true, paginate: true, startNumber: 1, position: 'bottom-center' });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(7);
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(A4_PAGE);
    expect(sizes[1]).toEqual(A4_PAGE);
    expect(sizes[2]).toEqual(SOURCE_PAGE);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.pageCount).toBe(7);
    expect(metadata.includeCover).toBe(true);
    expect(metadata.includeIndex).toBe(true);
    expect(metadata.startNumber).toBe(1);
    expect(metadata.endNumber).toBe(7); // 1 + 7 - 1, cover and index counted
  });

  test('12. Pagination includes cover/index under the v1 rule', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-pag-cover.pdf', includeCover: true, cover: sampleCover, paginate: true, startNumber: 5, position: 'bottom-center' });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(6); // 5 source + 1 cover

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.pageCount).toBe(6);
    expect(metadata.startNumber).toBe(5);
    expect(metadata.endNumber).toBe(10); // 5 + 6 - 1, cover counted
  });

  test('13. Blank cover title falls back to COURT BUNDLE (still renders)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: { ...sampleCover, title: '   ' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(A4_PAGE);
  });

  test('14. Long cover fields are sanitized/truncated safely', async () => {
    const longCover = {
      title: 'T'.repeat(400),
      court: 'C'.repeat(400),
      caseNumber: 'N'.repeat(400),
      caseTitle: 'L'.repeat(800),
      bundleTitle: 'B'.repeat(400),
      preparedBy: 'P'.repeat(400),
      date: 'D'.repeat(400),
    };
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: longCover });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(6);
  });

  test('15. Control characters / newlines in cover fields are sanitized safely', async () => {
    const nastyCover = {
      title: 'COURT  BUNDLE',
      court: 'HIGH COURT\nOF KENYA\r\nAT NAIROBI',
      caseNumber: 'HCCC\tE000 OF 2026',
      caseTitle: 'A v B',
      bundleTitle: "DEFENDANT'S BUNDLE",
      preparedBy: 'FIRM NAME',
      date: '1 June 2026',
    };
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: nastyCover });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(6);
  });

  test('16. Non-WinAnsi cover characters are handled safely', async () => {
    const unicodeCover = {
      title: 'COURT 😀 BUNDLE ‮ 中文',
      court: 'HIGH COURT — KENYA 🇰🇪',
      caseNumber: 'HCCC №000',
      caseTitle: 'Ālíce v Böb 漢字',
      bundleTitle: 'BUNDLE ★ OF DOCUMENTS',
      preparedBy: 'FIRM ☃ ADVOCATES',
      date: '1 June 2026 😀',
    };
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: unicodeCover });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(6);
  });

  test('17. Audit download metadata includes includeCover and coverFieldCount', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const partialCover = { title: 'COURT BUNDLE', court: 'HIGH COURT OF KENYA', caseNumber: 'HCCC E1 OF 2026' };
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-audit-cover.pdf', includeCover: true, cover: partialCover });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.includeCover).toBe(true);
    expect(metadata.coverFieldCount).toBe(3);
  });

  test('18. Audit metadata does not include raw cover text', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const secret = 'CONFIDENTIAL_COVER_R20J_DOWNLOAD';
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      filename: 'r20j-audit-raw.pdf',
      includeCover: true,
      cover: { ...sampleCover, caseTitle: secret, preparedBy: `${secret} LLP` },
    });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(secret);
    const lower = serialized.toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf']) {
      expect(lower).not.toContain(forbidden);
    }
  });

  test('19. Temporary cover download creates no new document row', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count);
  });

  // --- Access control on cover download --------------------------------------

  test('20. Admin download success (with cover)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('21. Advocate assigned-matter download success (with cover)', async () => {
    const res = await bundleDownloadRequest(advocateToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('22. Assistant temporary download success, matching requireStaff (with cover)', async () => {
    const res = await bundleDownloadRequest(assistantToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('23. Advocate inaccessible matter rejected (with cover)', async () => {
    const res = await bundleDownloadRequest(advocateToken, michaelMatterId, [michaelPdf], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('24. Client rejected (with cover)', async () => {
    const res = await bundleDownloadRequest(clientToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  test('25. Non-PDF document rejected (with cover)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, textDoc], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  test('26. Duplicate document IDs rejected (with cover)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf1], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
  });

  test('27. Corrupt PDF rejected safely (with cover)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, corruptPdf], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/could not.*read/i);
  });

  // --- Cover save ------------------------------------------------------------

  test('28. Admin save success (with cover)', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-save-admin.pdf', includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('29. Advocate assigned-matter save success (with cover)', async () => {
    const res = await bundleSaveRequest(advocateToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-adv-save.pdf', includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('30. Assistant rejected from save (with cover)', async () => {
    const res = await bundleSaveRequest(assistantToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('31. Client rejected from save (with cover)', async () => {
    const res = await bundleSaveRequest(clientToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('32. Saved row correct: source/mimeType/clientVisible/content BLOB present', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-save-row.pdf', includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);

    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(saved.matterId).toBe(sarahMatterId);
    expect(saved.source).toBe('document_tool');
    expect(saved.mimeType).toBe('application/pdf');
    expect(saved.type).toBe('PDF');
    expect(saved.folderId == null).toBe(true);
    expect(Number(saved.clientVisible)).toBe(0);
    expect(saved.uploadedBy).toBeTruthy();
    expect(Buffer.isBuffer(saved.content) ? saved.content.length : Buffer.from(saved.content).length).toBeGreaterThan(0);
  });

  test('33. Saved cover bundle is downloadable with sources + cover pages', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-save-dl.pdf', includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);

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

  test('34. Saved cover bundle appears in matter documents', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-list.pdf', includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(docsRes.statusCode).toBe(200);
    expect(docsRes.body.map(d => d.id)).toContain(res.body.id);
  });

  test('35. Saved cover bundle not client-visible by default', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-cv.pdf', includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${testClientToken}`);
    expect(docsRes.statusCode).toBe(200);
    expect(docsRes.body.map(d => d.id)).not.toContain(res.body.id);
  });

  test('36. Audit save event is safe (includeCover, coverFieldCount, no raw cover text)', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const secret = 'CONFIDENTIAL_COVER_R20J_SAVE';
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      filename: 'r20j-audit-save.pdf',
      includeCover: true,
      cover: { title: 'COURT BUNDLE', court: 'HIGH COURT', caseTitle: secret },
      includeIndex: true,
      paginate: true,
      startNumber: 1,
      position: 'bottom-left',
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
    expect(metadata.includeCover).toBe(true);
    expect(metadata.coverFieldCount).toBe(3);
    expect(metadata.includeIndex).toBe(true);
    expect(metadata.indexPageCount).toBe(1);
    expect(metadata.clientVisible).toBe(false);
    expect(metadata.pageCount).toBe(7); // cover + index + 5 source pages
    expect(metadata.endNumber).toBe(7);

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(secret);
    const lower = serialized.toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf']) {
      expect(lower).not.toContain(forbidden);
    }
  });

  // --- Sibling-route sanity (no regression from shared file changes) ---------

  test('37. Existing merge route still passes a sanity check', async () => {
    const mergeRes = await request(app)
      .post('/api/document-tools/merge-pdfs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentIds: [sarahPdf1, sarahPdf2], filename: 'r20j-sanity-merge.pdf' })
      .buffer(true)
      .parse(parsePdfResponse);
    expect(mergeRes.statusCode).toBe(200);
    expect(mergeRes.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(mergeRes.body)).toBe(5);
  });

  test('38. Existing rotate route still passes a sanity check', async () => {
    const rotateRes = await request(app)
      .post('/api/document-tools/rotate-pdf')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, degrees: 90, filename: 'r20j-sanity-rotate.pdf' })
      .buffer(true)
      .parse(parsePdfResponse);
    expect(rotateRes.statusCode).toBe(200);
    expect(rotateRes.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(rotateRes.body)).toBe(3);
  });

  test('39. Existing extract route still passes a sanity check', async () => {
    const extractRes = await request(app)
      .post('/api/document-tools/extract-pdf-pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, ranges: '1-2', filename: 'r20j-sanity-extract.pdf' })
      .buffer(true)
      .parse(parsePdfResponse);
    expect(extractRes.statusCode).toBe(200);
    expect(extractRes.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(extractRes.body)).toBe(2);
  });

  test('40. Existing delete route still passes a sanity check', async () => {
    const deleteRes = await request(app)
      .post('/api/document-tools/delete-pdf-pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, pages: '1', filename: 'r20j-sanity-delete.pdf' })
      .buffer(true)
      .parse(parsePdfResponse);
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(deleteRes.body)).toBe(2);
  });

  test('41. Existing page-number route still passes a sanity check', async () => {
    const numberRes = await request(app)
      .post('/api/document-tools/number-pdf-pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, startNumber: 1, position: 'bottom-center', filename: 'r20j-sanity-number.pdf' })
      .buffer(true)
      .parse(parsePdfResponse);
    expect(numberRes.statusCode).toBe(200);
    expect(numberRes.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(numberRes.body)).toBe(3);
  });

  test('42. Existing court-bundle no-index route still passes a sanity check', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-sanity-noindex.pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(5);
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(SOURCE_PAGE);
  });

  test('43. Existing court-bundle index route still passes a sanity check (no cover)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20j-sanity-index.pdf', includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(6); // 5 source + 1 index, no cover
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(A4_PAGE);      // index first when no cover (unchanged behavior)
    expect(sizes[1]).toEqual(SOURCE_PAGE);
  });
});
