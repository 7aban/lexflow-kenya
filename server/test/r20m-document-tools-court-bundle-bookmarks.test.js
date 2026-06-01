const request = require('supertest');
const sqlite3 = require('sqlite3');
const { PDFDocument, StandardFonts, PDFName } = require('pdf-lib');
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
      'r20m-test',
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
    includeBookmarks,
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
  if (includeBookmarks !== undefined) body.includeBookmarks = includeBookmarks;
  return body;
}

function bundleDownloadRequest(token, matterId, documentIds, opts = {}) {
  const body = buildBundleBody(matterId, documentIds, { filename: 'r20m-bundle.pdf', ...opts });
  return request(app)
    .post('/api/document-tools/court-bundle')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .buffer(true)
    .parse(parsePdfResponse);
}

function bundleSaveRequest(token, matterId, documentIds, opts = {}) {
  const body = buildBundleBody(matterId, documentIds, { filename: 'r20m-bundle-save.pdf', ...opts });
  return request(app)
    .post('/api/document-tools/court-bundle/save')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

async function outputPageCount(buffer) {
  const pdf = await PDFDocument.load(buffer);
  return pdf.getPageCount();
}

// Inspect the low-level /Outlines tree on a generated bundle. Returns null when
// no outline is present, otherwise { count, items: [{ title, pageIndex }] }.
// Titles are decoded from the PDF string objects and destinations are mapped
// back to a 0-based page index by matching the destination's page reference.
async function readOutline(buffer) {
  const pdf = await PDFDocument.load(buffer);
  const ctx = pdf.context;
  const outlinesRef = pdf.catalog.get(PDFName.of('Outlines'));
  if (!outlinesRef) return null;
  const outlines = ctx.lookup(outlinesRef);
  const countObj = outlines.get(PDFName.of('Count'));
  const pages = pdf.getPages();
  const indexOfRef = ref => {
    if (!ref || ref.objectNumber === undefined) return null;
    const idx = pages.findIndex(p => p.ref.objectNumber === ref.objectNumber && p.ref.generationNumber === ref.generationNumber);
    return idx === -1 ? null : idx;
  };
  const items = [];
  let cur = outlines.get(PDFName.of('First'));
  let guard = 0;
  while (cur && guard < 1000) {
    guard += 1;
    const dict = ctx.lookup(cur);
    const titleObj = dict.get(PDFName.of('Title'));
    const title = titleObj && typeof titleObj.decodeText === 'function'
      ? titleObj.decodeText()
      : (titleObj ? titleObj.toString() : '');
    const dest = dict.get(PDFName.of('Dest'));
    const pageIndex = dest && typeof dest.get === 'function' ? indexOfRef(dest.get(0)) : null;
    items.push({ title, pageIndex });
    cur = dict.get(PDFName.of('Next'));
  }
  return { count: countObj ? Number(countObj.toString()) : items.length, items };
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

describe('PRODUCT-14M Court Bundle Bookmarks / PDF Outlines v1', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let sarahMatterId;
  let michaelMatterId;
  let sarahPdf1; // 3 pages
  let sarahPdf2; // 2 pages
  let sarahPdf3; // 4 pages
  let displayNamePdf; // 1 page, displayName overridden
  let blankNamePdf; // 2 pages, name/displayName are control-chars only
  let michaelPdf;
  let testClientToken;

  const suffix = Date.now();

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('/api/auth/login', 'admin@lexflow.co.ke');
    advocateToken = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    assistantToken = await login('/api/auth/login', 'david.wanjiku@achokilaw.co.ke');
    clientToken = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');

    const sarahClientId = await createClient(adminToken, `R20m Sarah Client ${suffix}`, `r20m.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20m Michael Client ${suffix}`, `r20m.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `R20m Sarah Bundle Matter ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20m Michael Bundle Matter ${suffix}`, 'Michael Oduor');

    sarahPdf1 = await insertDocument({ id: `DOC_R20M_SA1_${suffix}`, matterId: sarahMatterId, name: `r20m-sarah1-${suffix}.pdf`, content: await multiPagePdf(3, `Sarah1 ${suffix}`) });
    sarahPdf2 = await insertDocument({ id: `DOC_R20M_SA2_${suffix}`, matterId: sarahMatterId, name: `r20m-sarah2-${suffix}.pdf`, content: await multiPagePdf(2, `Sarah2 ${suffix}`) });
    sarahPdf3 = await insertDocument({ id: `DOC_R20M_SA3_${suffix}`, matterId: sarahMatterId, name: `r20m-sarah3-${suffix}.pdf`, content: await multiPagePdf(4, `Sarah3 ${suffix}`) });

    displayNamePdf = await insertDocument({ id: `DOC_R20M_DN_${suffix}`, matterId: sarahMatterId, name: `r20m-dn-file-${suffix}.pdf`, content: await multiPagePdf(1, `DisplayName ${suffix}`) });
    await dbRun('UPDATE documents SET displayName=? WHERE id=?', ['PLEADINGS BUNDLE', displayNamePdf]);

    blankNamePdf = await insertDocument({ id: `DOC_R20M_BN_${suffix}`, matterId: sarahMatterId, name: `r20m-bn-file-${suffix}.pdf`, content: await multiPagePdf(2, `BlankName ${suffix}`) });
    // Force name + displayName to control-characters-only so they sanitize to empty.
    await dbRun('UPDATE documents SET name=?, displayName=? WHERE id=?', ['', '', blankNamePdf]);

    michaelPdf = await insertDocument({ id: `DOC_R20M_MA_${suffix}`, matterId: michaelMatterId, name: `r20m-michael-${suffix}.pdf`, content: await multiPagePdf(3, `Michael ${suffix}`) });

    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `r20m.client.user.${suffix}@example.com`, password: 'R20mPass!987', fullName: 'R20m Client User', role: 'client', clientId: sarahClientId });
    expect(registerRes.statusCode).toBe(200);
    const loginRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: `r20m.client.user.${suffix}@example.com`, password: 'R20mPass!987' });
    expect(loginRes.statusCode).toBe(200);
    testClientToken = loginRes.body.token;
  });

  // --- 1. No-bookmark backward compatibility ----------------------------------

  test('1a. includeBookmarks omitted -> no /Outlines catalog entry', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCover: true, cover: sampleCover, includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await readOutline(res.body)).toBeNull();
  });

  test('1b. includeBookmarks=false -> no /Outlines catalog entry', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeBookmarks: false, includeDividers: true });
    expect(res.statusCode).toBe(200);
    expect(await readOutline(res.body)).toBeNull();
    expect(await outputPageCount(res.body)).toBe(7); // unchanged: 2 dividers + 5 source pages
  });

  // --- 2. Cover only ----------------------------------------------------------

  test('2. Bookmarks with cover only: Cover Page outline points to the cover page', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeBookmarks: true, includeCover: true, cover: sampleCover });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    expect(outline).not.toBeNull();
    expect(outline.items[0]).toEqual({ title: 'Cover Page', pageIndex: 0 });
    // Layout: [cover, doc0(3), doc1(2)] -> section bookmarks at 1 and 4.
    expect(outline.items.map(i => i.pageIndex)).toEqual([0, 1, 4]);
  });

  // --- 3. Index only ----------------------------------------------------------

  test('3. Bookmarks with index only: Index outline points to the index page', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeBookmarks: true, includeIndex: true });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    expect(outline).not.toBeNull();
    expect(outline.items[0]).toEqual({ title: 'Index', pageIndex: 0 });
    // Layout: [index, doc0(3), doc1(2)] -> section bookmarks at 1 and 4.
    expect(outline.items.map(i => i.pageIndex)).toEqual([0, 1, 4]);
  });

  // --- 4. Dividers only -------------------------------------------------------

  test('4. Bookmarks with dividers only: one section entry per doc, each pointing at the divider page', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2, sarahPdf3], { includeBookmarks: true, includeDividers: true });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    expect(outline).not.toBeNull();
    expect(outline.items).toHaveLength(3); // one per selected document
    // Layout: [div0, doc0(3), div1, doc1(2), div2, doc2(4)] -> dividers at 0, 4, 7.
    expect(outline.items.map(i => i.pageIndex)).toEqual([0, 4, 7]);
  });

  test('4b. Bookmarks without dividers point at the first page of each source document', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2, sarahPdf3], { includeBookmarks: true });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    expect(outline).not.toBeNull();
    expect(outline.items).toHaveLength(3);
    // Layout: [doc0(3), doc1(2), doc2(4)] -> first pages at 0, 3, 5.
    expect(outline.items.map(i => i.pageIndex)).toEqual([0, 3, 5]);
  });

  // --- 5. Cover + index + dividers + pagination -------------------------------

  test('5. Cover + index + dividers + pagination: order is Cover, Index, then sections with correct targets', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeBookmarks: true, includeCover: true, cover: sampleCover, includeIndex: true, includeDividers: true, paginate: true, startNumber: 1, position: 'bottom-center' });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    expect(outline).not.toBeNull();
    expect(outline.items.map(i => i.title)[0]).toBe('Cover Page');
    expect(outline.items.map(i => i.title)[1]).toBe('Index');
    // Layout: [cover, index, div0, doc0(3), div1, doc1(2)] -> 0,1,2,6.
    expect(outline.items.map(i => i.pageIndex)).toEqual([0, 1, 2, 6]);
    expect(outline.count).toBe(4);
  });

  // --- 6. Label fallback cascade ----------------------------------------------

  test('6a. dividerLabels wins over documentLabels', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      includeBookmarks: true,
      includeDividers: true,
      dividerLabels: { [sarahPdf1]: 'DIVIDER WINS' },
      documentLabels: { [sarahPdf1]: 'DOCUMENT LOSES' },
    });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    expect(outline.items[0].title).toBe('DIVIDER WINS');
  });

  test('6b. documentLabels wins over displayName/name', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [displayNamePdf, sarahPdf2], {
      includeBookmarks: true,
      documentLabels: { [displayNamePdf]: 'DOCUMENT LABEL' },
    });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    expect(outline.items[0].title).toBe('DOCUMENT LABEL');
  });

  test('6c. displayName fallback works when no labels are provided', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [displayNamePdf, sarahPdf2], { includeBookmarks: true });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    expect(outline.items[0].title).toBe('PLEADINGS BUNDLE'); // overridden displayName, not the file name
  });

  // --- 7. Label sanitization --------------------------------------------------

  test('7a. Control characters are stripped from bookmark labels', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      includeBookmarks: true,
      dividerLabels: { [sarahPdf1]: 'MEMO RANDUM\n\r\tOF APPEAL' },
      includeDividers: true,
    });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    const title = outline.items[0].title;
    expect(title).toBe('MEMO RANDUM OF APPEAL');
    // No control characters survive.
    expect([...title].every(ch => ch.codePointAt(0) > 0x1f && !(ch.codePointAt(0) >= 0x7f && ch.codePointAt(0) <= 0x9f))).toBe(true);
  });

  test('7b. Non-WinAnsi / unsupported characters are handled safely', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      includeBookmarks: true,
      dividerLabels: { [sarahPdf1]: 'PLEADINGS 😀 中文 ‮' },
      includeDividers: true,
    });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    const title = outline.items[0].title;
    expect(title.length).toBeGreaterThan(0);
    // Every retained character is WinAnsi-safe (<= 0xff).
    expect([...title].every(ch => ch.codePointAt(0) <= 0xff)).toBe(true);
  });

  test('7c. Over-long labels are length-capped', async () => {
    const longLabel = 'LABEL '.repeat(60); // ~360 chars
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      includeBookmarks: true,
      dividerLabels: { [sarahPdf1]: longLabel },
      includeDividers: true,
    });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    expect(outline.items[0].title.length).toBeLessThanOrEqual(120);
  });

  test('7d. A label that sanitizes to empty falls back to "Document"', async () => {
    // blankNamePdf has control-char-only name/displayName, and we pass a
    // control-char-only divider label, so every fallback sanitizes to empty.
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [blankNamePdf, sarahPdf2], {
      includeBookmarks: true,
      includeDividers: true,
      dividerLabels: { [blankNamePdf]: '' },
    });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    expect(outline.items[0].title).toBe('Document');
  });

  // --- 8. Audit metadata ------------------------------------------------------

  test('8a. Audit metadata includes includeBookmarks and bookmarkCount when requested', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20m-audit-bm.pdf', includeBookmarks: true, includeCover: true, cover: sampleCover, includeIndex: true });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.includeBookmarks).toBe(true);
    expect(metadata.bookmarkCount).toBe(4); // cover + index + 2 sections
  });

  test('8b. Audit metadata records includeBookmarks=false and omits bookmarkCount when not requested', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20m-audit-nobm.pdf' });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.includeBookmarks).toBe(false);
    expect(metadata.bookmarkCount).toBeUndefined();
  });

  test('8c. Audit metadata never leaks raw bookmark labels or PDF content', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const secret = 'R20M_CONFIDENTIAL_BOOKMARK_LABEL';
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      filename: 'r20m-audit-safe.pdf',
      includeBookmarks: true,
      includeDividers: true,
      dividerLabels: { [sarahPdf1]: secret, [sarahPdf2]: 'Evidence Bundle' },
    });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('Evidence Bundle');
    expect(serialized).not.toContain('Cover Page');
    const lower = serialized.toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf']) {
      expect(lower).not.toContain(forbidden);
    }
  });

  // --- 9. Save route ----------------------------------------------------------

  test('9a. Saved bundle includes bookmarks and remains source=document_tool, clientVisible=0', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20m-save-bm.pdf', includeBookmarks: true, includeCover: true, cover: sampleCover, includeIndex: true, includeDividers: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);

    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(saved.source).toBe('document_tool');
    expect(Number(saved.clientVisible)).toBe(0);
    const savedContent = Buffer.isBuffer(saved.content) ? saved.content : Buffer.from(saved.content);
    const outline = await readOutline(savedContent);
    expect(outline).not.toBeNull();
    expect(outline.items.map(i => i.title).slice(0, 2)).toEqual(['Cover Page', 'Index']);
  });

  test('9b. Saved bundle without bookmarks has no /Outlines entry', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20m-save-nobm.pdf', includeDividers: true });
    expect(res.statusCode).toBe(200);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    const savedContent = Buffer.isBuffer(saved.content) ? saved.content : Buffer.from(saved.content);
    expect(await readOutline(savedContent)).toBeNull();
  });

  test('9c. Re-downloading a saved bundle preserves the bookmarks', async () => {
    const saveRes = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20m-save-dl.pdf', includeBookmarks: true, includeDividers: true });
    expect(saveRes.statusCode).toBe(200);

    const download = await request(app)
      .get(`/api/documents/${saveRes.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse(parsePdfResponse);
    expect(download.statusCode).toBe(200);
    expect(download.body.slice(0, 4).toString()).toBe('%PDF');
    const outline = await readOutline(download.body);
    expect(outline).not.toBeNull();
    expect(outline.items).toHaveLength(2);
    // dividers-only layout: [div0, doc0(3), div1, doc1(2)] -> 0, 4.
    expect(outline.items.map(i => i.pageIndex)).toEqual([0, 4]);
  });

  test('9d. Saved bundle audit metadata records includeBookmarks and bookmarkCount', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20m-save-audit.pdf', includeBookmarks: true });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_saved', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.includeBookmarks).toBe(true);
    expect(metadata.bookmarkCount).toBe(2);
    expect(metadata.clientVisible).toBe(false);
  });

  // --- Access control ---------------------------------------------------------

  test('10a. Client rejected from bookmark download', async () => {
    const res = await bundleDownloadRequest(clientToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeBookmarks: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  test('10b. Advocate inaccessible matter rejected for bookmark download', async () => {
    const res = await bundleDownloadRequest(advocateToken, michaelMatterId, [michaelPdf], { includeBookmarks: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('10c. Assistant rejected from bookmark save (requireAdvocateOrAdmin)', async () => {
    const res = await bundleSaveRequest(assistantToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeBookmarks: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('10d. Client rejected from bookmark save', async () => {
    const res = await bundleSaveRequest(clientToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeBookmarks: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  // --- Sibling-route sanity ---------------------------------------------------

  test('11. Existing court-bundle divider behaviour unchanged when bookmarks omitted', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20m-sanity-div.pdf', includeDividers: true, includeCover: true, cover: sampleCover, includeIndex: true });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(9); // cover + index + 2 dividers + 5 source pages
    expect(await readOutline(res.body)).toBeNull();
  });
});
