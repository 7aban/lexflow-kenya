const request = require('supertest');
const sqlite3 = require('sqlite3');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(30000);

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
      'r20k-test',
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
    includeDividers,
    dividerLabels,
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
  if (includeDividers !== undefined) body.includeDividers = includeDividers;
  if (dividerLabels !== undefined) body.dividerLabels = dividerLabels;
  return body;
}

function bundleDownloadRequest(token, matterId, documentIds, opts = {}) {
  const body = buildBundleBody(matterId, documentIds, { filename: 'r20k-bundle.pdf', ...opts });
  return request(app)
    .post('/api/document-tools/court-bundle')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .buffer(true)
    .parse(parsePdfResponse);
}

function bundleSaveRequest(token, matterId, documentIds, opts = {}) {
  const body = buildBundleBody(matterId, documentIds, { filename: 'r20k-bundle-save.pdf', ...opts });
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

const sampleCover = {
  title: 'COURT BUNDLE',
  court: 'HIGH COURT OF KENYA AT NAIROBI',
  caseNumber: 'HCCC E000 OF 2026',
  caseTitle: 'A v B',
  bundleTitle: "DEFENDANT'S BUNDLE OF DOCUMENTS",
  preparedBy: 'T.K. RUTTO & CO. ADVOCATES',
  date: '1 June 2026',
};

describe('PRODUCT-14L Court Bundle Dividers v1', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let sarahMatterId;
  let michaelMatterId;
  let sarahPdf1; // 3 pages
  let sarahPdf2; // 2 pages
  let sarahPdf3; // 4 pages
  let sarahPdf1n; // doc with displayName
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

    const sarahClientId = await createClient(adminToken, `R20k Sarah Client ${suffix}`, `r20k.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20k Michael Client ${suffix}`, `r20k.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `R20k Sarah Bundle Matter ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20k Michael Bundle Matter ${suffix}`, 'Michael Oduor');

    sarahPdf1 = await insertDocument({ id: `DOC_R20K_SA1_${suffix}`, matterId: sarahMatterId, name: `r20k-sarah1-${suffix}.pdf`, content: await multiPagePdf(3, `Sarah1 ${suffix}`) });
    sarahPdf2 = await insertDocument({ id: `DOC_R20K_SA2_${suffix}`, matterId: sarahMatterId, name: `r20k-sarah2-${suffix}.pdf`, content: await multiPagePdf(2, `Sarah2 ${suffix}`) });
    sarahPdf3 = await insertDocument({ id: `DOC_R20K_SA3_${suffix}`, matterId: sarahMatterId, name: `r20k-sarah3-${suffix}.pdf`, content: await multiPagePdf(4, `Sarah3 ${suffix}`) });
    sarahPdf1n = await insertDocument({ id: `DOC_R20K_SA1N_${suffix}`, matterId: sarahMatterId, name: `r20k-sarah1-named-${suffix}.pdf`, content: await multiPagePdf(1, `Sarah1Named ${suffix}`) });
    await dbRun('UPDATE documents SET displayName=? WHERE id=?', ['PLEADINGS', sarahPdf1n]);
    michaelPdf = await insertDocument({ id: `DOC_R20K_MA_${suffix}`, matterId: michaelMatterId, name: `r20k-michael-${suffix}.pdf`, content: await multiPagePdf(3, `Michael ${suffix}`) });
    textDoc = await insertDocument({ id: `DOC_R20K_TXT_${suffix}`, matterId: sarahMatterId, name: `r20k-text-${suffix}.txt`, mimeType: 'text/plain', type: 'Text', content: Buffer.from('R20k text document body') });
    corruptPdf = await insertDocument({ id: `DOC_R20K_BAD_${suffix}`, matterId: sarahMatterId, name: `r20k-corrupt-${suffix}.pdf`, content: Buffer.from('%PDF-r20k-not-a-valid-pdf') });

    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `r20k.client.user.${suffix}@example.com`, password: 'R20kPass!987', fullName: 'R20k Client User', role: 'client', clientId: sarahClientId });
    expect(registerRes.statusCode).toBe(200);
    const loginRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: `r20k.client.user.${suffix}@example.com`, password: 'R20kPass!987' });
    expect(loginRes.statusCode).toBe(200);
    testClientToken = loginRes.body.token;
  });

  // --- No-divider backward compatibility --------------------------------------

  test('1. Existing court bundle without dividers still works (page count = sources)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-nodiv.pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(5);
  });

  test('2. includeDividers=false behaves like no dividers', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: false });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(5);
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(SOURCE_PAGE);
  });

  // --- Divider download -------------------------------------------------------

  test('3. Download with dividers only succeeds', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('4. Download with cover + dividers succeeds', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true, includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('5. Download with index + dividers succeeds', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true, includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('6. Download with cover + index + dividers succeeds', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true, includeCover: true, cover: sampleCover, includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('7. Download with cover + index + dividers + pagination succeeds', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true, includeCover: true, cover: sampleCover, includeIndex: true, paginate: true, startNumber: 1, position: 'bottom-center' });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('8. Response has application/pdf, attachment filename, no-store', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-headers.pdf', includeDividers: true, includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/i);
    expect(res.headers['content-disposition']).toMatch(/r20k-headers\.pdf/);
    expect(res.headers['cache-control']).toMatch(/no-store/i);
  });

  test('9. Response body starts with %PDF', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('10. Output page count equals source pages plus enabled front matter/dividers', async () => {
    const divOnly = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2, sarahPdf3], { includeDividers: true });
    expect(divOnly.statusCode).toBe(200);
    expect(await outputPageCount(divOnly.body)).toBe(3 + 2 + 4 + 3); // sources + 3 dividers

    const coverDiv = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2, sarahPdf3], { includeDividers: true, includeCover: true, cover: sampleCover });
    expect(coverDiv.statusCode).toBe(200);
    expect(await outputPageCount(coverDiv.body)).toBe(3 + 2 + 4 + 3 + 1); // + cover

    const coverIndexDiv = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2, sarahPdf3], { includeDividers: true, includeCover: true, cover: sampleCover, includeIndex: true });
    expect(coverIndexDiv.statusCode).toBe(200);
    expect(await outputPageCount(coverIndexDiv.body)).toBe(3 + 2 + 4 + 3 + 2); // + cover + index
  });

  test('11. One divider page is inserted per selected document', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true });
    expect(res.statusCode).toBe(200);
    const sizes = await pageSizes(res.body);
    const dividerSizes = sizes.filter(s => s.width === A4_PAGE.width && s.height === A4_PAGE.height);
    expect(dividerSizes).toHaveLength(2);
  });

  test('12. Dividers are inserted before each selected document', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true });
    expect(res.statusCode).toBe(200);
    const sizes = await pageSizes(res.body);
    // Expected: [A4(div0), SOURCE(doc0 p1-3), A4(div1), SOURCE(doc1 p1-2)]
    expect(sizes).toHaveLength(7); // 2 dividers + 5 source pages
    expect(sizes[0]).toEqual(A4_PAGE);      // divider for doc 0
    expect(sizes[1]).toEqual(SOURCE_PAGE);  // doc 0 page 1
    expect(sizes[3]).toEqual(SOURCE_PAGE);  // doc 0 page 3
    expect(sizes[4]).toEqual(A4_PAGE);      // divider for doc 1
    expect(sizes[5]).toEqual(SOURCE_PAGE);  // doc 1 page 1
  });

  test('13. Cover remains first when enabled', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true, includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(A4_PAGE); // cover
  });

  test('14. Index follows cover when both enabled', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true, includeCover: true, cover: sampleCover, includeIndex: true });
    expect(res.statusCode).toBe(200);
    const sizes = await pageSizes(res.body);
    expect(sizes).toHaveLength(9); // cover + index + 2 dividers + 5 source pages
    expect(sizes[0]).toEqual(A4_PAGE); // cover
    expect(sizes[1]).toEqual(A4_PAGE); // index
    expect(sizes[2]).toEqual(A4_PAGE); // divider for doc 0
    expect(sizes[3]).toEqual(SOURCE_PAGE); // doc 0 page 1
    expect(sizes[6]).toEqual(A4_PAGE); // divider for doc 1
  });

  test('15. Dividers follow cover/index and precede documents', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true, includeCover: true, cover: sampleCover, includeIndex: true });
    expect(res.statusCode).toBe(200);
    const sizes = await pageSizes(res.body);
    // cover(1) + index(1) + div0(1) + doc0(3) + div1(1) + doc1(2) = 9
    expect(sizes).toHaveLength(9);
    expect(sizes[0]).toEqual(A4_PAGE); // cover
    expect(sizes[1]).toEqual(A4_PAGE); // index
    expect(sizes[2]).toEqual(A4_PAGE); // divider 0
    expect(sizes[3]).toEqual(SOURCE_PAGE); // first doc starts
    expect(sizes[6]).toEqual(A4_PAGE); // divider 1
    expect(sizes[7]).toEqual(SOURCE_PAGE); // doc 1 starts
  });

  test('16. Index starting pages account for dividers', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-index-pages.pdf', includeDividers: true, includeIndex: true, paginate: true, startNumber: 1, position: 'bottom-center' });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(8); // index + 2 dividers + 5 source pages

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.pageCount).toBe(8);
    expect(metadata.includeDividers).toBe(true);
    expect(metadata.dividerCount).toBe(2);
  });

  test('17. Index starting page for first document equals divider page number', async () => {
    // With index, no cover: page 1=index, page 2=divider for doc 0
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true, includeIndex: true, paginate: true, startNumber: 1, position: 'bottom-center' });
    expect(res.statusCode).toBe(200);
    // index(1) + div0(1) + doc0(3) + div1(1) + doc1(2) = 8 pages
    expect(await outputPageCount(res.body)).toBe(8);
  });

  test('18. Index starting pages correctly offset by divider count', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true, includeCover: true, cover: sampleCover, includeIndex: true, paginate: true, startNumber: 1, position: 'bottom-center' });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(9); // cover + index + 2 dividers + 5 source pages
  });

  test('19. Pagination includes cover/index/dividers under the v1 rule', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-pag-all.pdf', includeDividers: true, includeCover: true, cover: sampleCover, includeIndex: true, paginate: true, startNumber: 1, position: 'bottom-center' });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(9);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.pageCount).toBe(9);
    expect(metadata.startNumber).toBe(1);
    expect(metadata.endNumber).toBe(9); // all 9 pages numbered
  });

  test('20. Divider page numbers are sequential when pagination is enabled', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true, paginate: true, startNumber: 1, position: 'bottom-center' });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(7); // 2 dividers + 5 source pages
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(A4_PAGE); // divider for doc 0
    expect(sizes[1]).toEqual(SOURCE_PAGE);
    expect(sizes[4]).toEqual(A4_PAGE); // divider for doc 1
  });

  // --- Divider labels ---------------------------------------------------------

  test('21. Divider labels use dividerLabels when provided', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      includeDividers: true,
      dividerLabels: { [sarahPdf1]: 'PLEADINGS', [sarahPdf2]: 'EVIDENCE' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(7);
  });

  test('22. Divider labels fall back to documentLabels', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      includeDividers: true,
      includeIndex: true,
      documentLabels: { [sarahPdf1]: 'MEMORANDUM', [sarahPdf2]: 'AFFIDAVIT' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(8);
  });

  test('23. Divider labels fall back to document display name', async () => {
    // sarahPdf1n has displayName='PLEADINGS'
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1n, sarahPdf2], {
      includeDividers: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(5); // 2 dividers + 1+2 source pages
  });

  test('24. Long divider labels are sanitized/truncated safely', async () => {
    const longLabel = 'LONG ' + 'LABEL '.repeat(40);
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      includeDividers: true,
      dividerLabels: { [sarahPdf1]: longLabel },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(7);
  });

  test('25. Control characters/newlines in divider labels are sanitized safely', async () => {
    const nasty = 'MEMO\u0000RANDUM\u0007\n\r\tOF APPEAL';
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      includeDividers: true,
      dividerLabels: { [sarahPdf1]: nasty },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(7);
  });

  test('26. Non-WinAnsi divider labels are handled safely', async () => {
    const unicodeLabel = 'PLEADINGS 😀 中文 ‮';
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      includeDividers: true,
      dividerLabels: { [sarahPdf1]: unicodeLabel },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(7);
  });

  // --- Audit metadata ---------------------------------------------------------

  test('27. Audit metadata includes includeDividers and dividerCount', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-audit-div.pdf', includeDividers: true });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.includeDividers).toBe(true);
    expect(metadata.dividerCount).toBe(2);
  });

  test('28. Audit metadata with includeDividers=false has dividerCount=0', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-audit-nodiv.pdf' });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.includeDividers).toBe(false);
    expect(metadata.dividerCount).toBe(0);
  });

  test('29. Audit metadata does not include raw divider labels', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const secret = 'R20K_CONFIDENTIAL_DIVIDER_LABEL';
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      filename: 'r20k-audit-safe.pdf',
      includeDividers: true,
      dividerLabels: { [sarahPdf1]: secret, [sarahPdf2]: 'Evidence' },
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

  test('30. Temporary download creates no document row', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true });
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count);
  });

  // --- Access control on divider download -------------------------------------

  test('31. Admin download success', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('32. Advocate assigned-matter download success', async () => {
    const res = await bundleDownloadRequest(advocateToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('33. Assistant temporary download success, matching requireStaff', async () => {
    const res = await bundleDownloadRequest(assistantToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('34. Advocate inaccessible matter rejected', async () => {
    const res = await bundleDownloadRequest(advocateToken, michaelMatterId, [michaelPdf], { includeDividers: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('35. Client rejected', async () => {
    const res = await bundleDownloadRequest(clientToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  test('36. Non-PDF document rejected', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, textDoc], { includeDividers: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  test('37. Duplicate document IDs rejected', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf1], { includeDividers: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
  });

  test('38. Corrupt PDF rejected safely', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, corruptPdf], { includeDividers: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/could not.*read/i);
  });

  // --- Divider save -----------------------------------------------------------

  test('39. Admin save success', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-save-admin.pdf', includeDividers: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('40. Advocate assigned-matter save success', async () => {
    const res = await bundleSaveRequest(advocateToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-adv-save.pdf', includeDividers: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('41. Assistant rejected from save', async () => {
    const res = await bundleSaveRequest(assistantToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('42. Client rejected from save', async () => {
    const res = await bundleSaveRequest(clientToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeDividers: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('43. Saved row correct: source/mimeType/clientVisible/content BLOB present', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-save-row.pdf', includeDividers: true });
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

  test('44. Saved doc downloadable', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-save-dl.pdf', includeDividers: true });
    expect(res.statusCode).toBe(200);

    const download = await request(app)
      .get(`/api/documents/${res.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse(parsePdfResponse);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(download.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(download.body)).toBe(7); // 2 dividers + 5 source pages
  });

  test('45. Saved doc appears in matter documents', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-list.pdf', includeDividers: true });
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(docsRes.statusCode).toBe(200);
    expect(docsRes.body.map(d => d.id)).toContain(res.body.id);
  });

  test('46. Saved doc not client-visible by default', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-cv.pdf', includeDividers: true });
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${testClientToken}`);
    expect(docsRes.statusCode).toBe(200);
    expect(docsRes.body.map(d => d.id)).not.toContain(res.body.id);
  });

  // --- Sibling-route sanity ---------------------------------------------------

  test('47. Existing merge route still passes sanity check', async () => {
    const docA = await insertDocument({ id: `DOC_R20K_SAN_A_${suffix}`, matterId: sarahMatterId, name: `r20k-sanity-a-${suffix}.pdf`, content: await multiPagePdf(2, 'Sanity A') });
    const docB = await insertDocument({ id: `DOC_R20K_SAN_B_${suffix}`, matterId: sarahMatterId, name: `r20k-sanity-b-${suffix}.pdf`, content: await multiPagePdf(2, 'Sanity B') });
    const mergeRes = await request(app)
      .post('/api/document-tools/merge-pdfs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentIds: [docA, docB], filename: 'r20k-sanity-merge.pdf' })
      .buffer(true)
      .parse(parsePdfResponse);
    expect(mergeRes.statusCode).toBe(200);
    expect(mergeRes.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(mergeRes.body)).toBe(4);
  });

  test('48. Existing rotate route still passes sanity check', async () => {
    const rotateRes = await request(app)
      .post('/api/document-tools/rotate-pdf')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, degrees: 90, filename: 'r20k-sanity-rotate.pdf' })
      .buffer(true)
      .parse(parsePdfResponse);
    expect(rotateRes.statusCode).toBe(200);
    expect(rotateRes.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(rotateRes.body)).toBe(3);
  });

  test('49. Existing extract route still passes sanity check', async () => {
    const extractRes = await request(app)
      .post('/api/document-tools/extract-pdf-pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, ranges: '1-2', filename: 'r20k-sanity-extract.pdf' })
      .buffer(true)
      .parse(parsePdfResponse);
    expect(extractRes.statusCode).toBe(200);
    expect(extractRes.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(extractRes.body)).toBe(2);
  });

  test('50. Existing delete route still passes sanity check', async () => {
    const deleteRes = await request(app)
      .post('/api/document-tools/delete-pdf-pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, pages: '1', filename: 'r20k-sanity-delete.pdf' })
      .buffer(true)
      .parse(parsePdfResponse);
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(deleteRes.body)).toBe(2);
  });

  test('51. Existing page-number route still passes sanity check', async () => {
    const numberRes = await request(app)
      .post('/api/document-tools/number-pdf-pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentId: sarahPdf1, startNumber: 1, position: 'bottom-center', filename: 'r20k-sanity-number.pdf' })
      .buffer(true)
      .parse(parsePdfResponse);
    expect(numberRes.statusCode).toBe(200);
    expect(numberRes.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(numberRes.body)).toBe(3);
  });

  test('52. Existing court-bundle index route still passes sanity check', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-sanity-index.pdf', includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(6); // 5 source + 1 index
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(A4_PAGE);
    expect(sizes[1]).toEqual(SOURCE_PAGE);
  });

  test('53. Existing court-bundle cover route still passes sanity check', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20k-sanity-cover.pdf', includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(6); // 5 source + 1 cover
    const sizes = await pageSizes(res.body);
    expect(sizes[0]).toEqual(A4_PAGE);
    expect(sizes[1]).toEqual(SOURCE_PAGE);
  });
});
