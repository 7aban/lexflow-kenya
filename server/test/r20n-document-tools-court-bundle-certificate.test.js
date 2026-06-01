const request = require('supertest');
const sqlite3 = require('sqlite3');
const { PDFDocument, StandardFonts, PDFName } = require('pdf-lib');
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
      'r20n-test',
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
    includeCertificate,
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
  if (includeCertificate !== undefined) body.includeCertificate = includeCertificate;
  return body;
}

function bundleDownloadRequest(token, matterId, documentIds, opts = {}) {
  const body = buildBundleBody(matterId, documentIds, { filename: 'r20n-bundle.pdf', ...opts });
  return request(app)
    .post('/api/document-tools/court-bundle')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .buffer(true)
    .parse(parsePdfResponse);
}

function bundleSaveRequest(token, matterId, documentIds, opts = {}) {
  const body = buildBundleBody(matterId, documentIds, { filename: 'r20n-bundle-save.pdf', ...opts });
  return request(app)
    .post('/api/document-tools/court-bundle/save')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

async function outputPageCount(buffer) {
  const pdf = await PDFDocument.load(buffer);
  return pdf.getPageCount();
}

// Inspect the low-level /Outlines tree. Returns null when no outline is present,
// otherwise { count, items: [{ title, pageIndex }] }. Mirrors the r20m reader.
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

describe('PRODUCT-14N Court Bundle Filing Certificate v1', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let sarahMatterId;
  let michaelMatterId;
  let weirdMatterId;
  let sarahPdf1; // 3 pages
  let sarahPdf2; // 2 pages
  let michaelPdf;
  let weirdPdf1;
  let weirdPdf2;

  const suffix = Date.now();
  const SECRET_MATTER = 'R20N_SECRET_MATTER_TITLE';
  const SECRET_CLIENT = 'R20N_SECRET_CLIENT_NAME';

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('/api/auth/login', 'admin@lexflow.co.ke');
    advocateToken = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    assistantToken = await login('/api/auth/login', 'david.wanjiku@achokilaw.co.ke');
    clientToken = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');

    const sarahClientId = await createClient(adminToken, `${SECRET_CLIENT} ${suffix}`, `r20n.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20n Michael Client ${suffix}`, `r20n.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `${SECRET_MATTER} ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20n Michael Bundle Matter ${suffix}`, 'Michael Oduor');

    sarahPdf1 = await insertDocument({ id: `DOC_R20N_SA1_${suffix}`, matterId: sarahMatterId, name: `r20n-sarah1-${suffix}.pdf`, content: await multiPagePdf(3, `Sarah1 ${suffix}`) });
    sarahPdf2 = await insertDocument({ id: `DOC_R20N_SA2_${suffix}`, matterId: sarahMatterId, name: `r20n-sarah2-${suffix}.pdf`, content: await multiPagePdf(2, `Sarah2 ${suffix}`) });
    michaelPdf = await insertDocument({ id: `DOC_R20N_MA_${suffix}`, matterId: michaelMatterId, name: `r20n-michael-${suffix}.pdf`, content: await multiPagePdf(3, `Michael ${suffix}`) });

    // Sanitization fixture: client + matter names with control characters and
    // non-WinAnsi code points (emoji, CJK) that must not crash PDF generation.
    const weirdClientId = await createClient(adminToken, `R20n Cli ent 中文 🚀 ${suffix}`, `r20n.weird.${suffix}@example.com`);
    weirdMatterId = await createMatter(adminToken, weirdClientId, `R20n Matter  éè 📚 ${suffix}`, 'Sarah Mwangi');
    weirdPdf1 = await insertDocument({ id: `DOC_R20N_WE1_${suffix}`, matterId: weirdMatterId, name: `r20n-weird1-${suffix}.pdf`, content: await multiPagePdf(2, `Weird1 ${suffix}`) });
    weirdPdf2 = await insertDocument({ id: `DOC_R20N_WE2_${suffix}`, matterId: weirdMatterId, name: `r20n-weird2-${suffix}.pdf`, content: await multiPagePdf(1, `Weird2 ${suffix}`) });
  });

  // --- 1. Default omitted -> backward compatible ------------------------------

  test('1a. includeCertificate omitted -> page count unchanged vs baseline', async () => {
    const baseline = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2]);
    expect(baseline.statusCode).toBe(200);
    expect(baseline.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(baseline.body)).toBe(5); // 3 + 2 source pages
  });

  test('1b. includeCertificate=false -> page count unchanged', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCertificate: false });
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(5);
  });

  // --- 2. Certificate included ------------------------------------------------

  test('2a. includeCertificate=true adds exactly one page', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCertificate: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(6); // 5 source + 1 certificate
  });

  test('2b. Certificate page is the final page (bookmark target == last index)', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCertificate: true, includeBookmarks: true });
    expect(res.statusCode).toBe(200);
    const pageCount = await outputPageCount(res.body);
    const outline = await readOutline(res.body);
    expect(outline).not.toBeNull();
    const last = outline.items[outline.items.length - 1];
    expect(last.title).toBe('Bundle Certificate');
    expect(last.pageIndex).toBe(pageCount - 1);
  });

  // --- 3. Index behaviour -----------------------------------------------------

  test('3a. Certificate is not an index row; source starting pages unchanged', async () => {
    const opts = { includeIndex: true, includeBookmarks: true };
    const without = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], opts);
    const withCert = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { ...opts, includeCertificate: true });
    expect(without.statusCode).toBe(200);
    expect(withCert.statusCode).toBe(200);

    const oWithout = await readOutline(without.body);
    const oWith = await readOutline(withCert.body);
    // Without certificate: Index + one bookmark per source document, no more.
    expect(oWithout.items[0].title).toBe('Index');
    expect(oWithout.items.map(i => i.title)).not.toContain('Bundle Certificate');
    // With certificate: identical front matter plus exactly one trailing entry.
    expect(oWith.items).toHaveLength(oWithout.items.length + 1);
    expect(oWith.items.slice(0, oWithout.items.length)).toEqual(oWithout.items);
    expect(oWith.items[oWith.items.length - 1].title).toBe('Bundle Certificate');
    // Source-document starting positions (index + section page indices) unchanged.
    expect(oWith.items.slice(0, oWithout.items.length).map(i => i.pageIndex)).toEqual(oWithout.items.map(i => i.pageIndex));
    // Certificate did not displace the index page count.
    expect(await outputPageCount(withCert.body)).toBe((await outputPageCount(without.body)) + 1);
  });

  // --- 4. Pagination ----------------------------------------------------------

  test('4a. Trailing certificate page is numbered; end number increments by one', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const without = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20n-pg-no.pdf', paginate: true, startNumber: 1 });
    expect(without.statusCode).toBe(200);
    const evWithout = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const mWithout = JSON.parse(evWithout.metadata_json || '{}');

    const boundary2 = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const withCert = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20n-pg-yes.pdf', paginate: true, startNumber: 1, includeCertificate: true });
    expect(withCert.statusCode).toBe(200);
    const evWith = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary2.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const mWith = JSON.parse(evWith.metadata_json || '{}');

    expect(mWith.pageCount).toBe(mWithout.pageCount + 1);
    expect(mWith.endNumber).toBe(mWithout.endNumber + 1);
    // The trailing certificate page carries the final printed number.
    expect(mWith.endNumber).toBe(mWith.startNumber + mWith.pageCount - 1);
  });

  // --- 5. Bookmark behaviour --------------------------------------------------

  test('5a. Bundle Certificate outline exists, points to last page, and is last', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeBookmarks: true, includeCover: true, cover: sampleCover, includeIndex: true, includeCertificate: true });
    expect(res.statusCode).toBe(200);
    const pageCount = await outputPageCount(res.body);
    const outline = await readOutline(res.body);
    expect(outline).not.toBeNull();
    const titles = outline.items.map(i => i.title);
    expect(titles[0]).toBe('Cover Page');
    expect(titles[1]).toBe('Index');
    expect(titles[titles.length - 1]).toBe('Bundle Certificate');
    expect(outline.items[outline.items.length - 1].pageIndex).toBe(pageCount - 1);
  });

  test('5b. No certificate bookmark when bookmarks enabled but certificate omitted', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeBookmarks: true });
    expect(res.statusCode).toBe(200);
    const outline = await readOutline(res.body);
    expect(outline.items.map(i => i.title)).not.toContain('Bundle Certificate');
  });

  // --- 6. Combined bundle -----------------------------------------------------

  test('6. Cover + index + dividers + pagination + bookmarks + certificate is valid and certificate is last', async () => {
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], {
      filename: 'r20n-combined.pdf',
      includeCover: true,
      cover: sampleCover,
      includeIndex: true,
      includeDividers: true,
      paginate: true,
      startNumber: 1,
      includeBookmarks: true,
      includeCertificate: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    // cover + index + 2 dividers + 5 source pages + 1 certificate = 10.
    const pageCount = await outputPageCount(res.body);
    expect(pageCount).toBe(10);
    const outline = await readOutline(res.body);
    const last = outline.items[outline.items.length - 1];
    expect(last.title).toBe('Bundle Certificate');
    expect(last.pageIndex).toBe(pageCount - 1);
  });

  // --- 7. Save route ----------------------------------------------------------

  test('7a. Saved bundle includes certificate; remains source=document_tool, clientVisible=0', async () => {
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20n-save-cert.pdf', includeCertificate: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);

    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(saved.source).toBe('document_tool');
    expect(Number(saved.clientVisible)).toBe(0);
    const savedContent = Buffer.isBuffer(saved.content) ? saved.content : Buffer.from(saved.content);
    expect(await outputPageCount(savedContent)).toBe(6); // 5 source + certificate
  });

  test('7b. Re-downloaded saved bundle preserves the certificate and its bookmark', async () => {
    const saveRes = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20n-save-dl.pdf', includeCertificate: true, includeBookmarks: true });
    expect(saveRes.statusCode).toBe(200);

    const download = await request(app)
      .get(`/api/documents/${saveRes.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse(parsePdfResponse);
    expect(download.statusCode).toBe(200);
    expect(download.body.slice(0, 4).toString()).toBe('%PDF');
    const pageCount = await outputPageCount(download.body);
    const outline = await readOutline(download.body);
    expect(outline).not.toBeNull();
    const last = outline.items[outline.items.length - 1];
    expect(last.title).toBe('Bundle Certificate');
    expect(last.pageIndex).toBe(pageCount - 1);
  });

  // --- 8. Audit / privacy -----------------------------------------------------

  test('8a. Download audit metadata includes includeCertificate=true when requested', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20n-audit-cert.pdf', includeCertificate: true });
    expect(res.statusCode).toBe(200);
    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.includeCertificate).toBe(true);
  });

  test('8b. Download audit metadata records includeCertificate=false when omitted', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20n-audit-nocert.pdf' });
    expect(res.statusCode).toBe(200);
    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.includeCertificate).toBe(false);
  });

  test('8c. Save audit metadata includes includeCertificate=true', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleSaveRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20n-save-audit.pdf', includeCertificate: true });
    expect(res.statusCode).toBe(200);
    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_saved', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.includeCertificate).toBe(true);
  });

  test('8d. Certificate audit metadata never leaks certificate text, firm/matter/client/user names, or PDF content', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await bundleDownloadRequest(adminToken, sarahMatterId, [sarahPdf1, sarahPdf2], { filename: 'r20n-audit-safe.pdf', includeCertificate: true, includeBookmarks: true });
    expect(res.statusCode).toBe(200);
    const event = await dbGet(
      `SELECT rowid,* FROM audit_events WHERE rowid>? AND action=? AND matter_id=? ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_court_bundle_downloaded', sarahMatterId],
    );
    const metadata = JSON.parse(event.metadata_json || '{}');
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(SECRET_MATTER);
    expect(serialized).not.toContain(SECRET_CLIENT);
    expect(serialized).not.toContain('BUNDLE GENERATION CERTIFICATE');
    expect(serialized).not.toContain('does not certify compliance');
    expect(serialized).not.toContain('Bundle Certificate');
    const lower = serialized.toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf']) {
      expect(lower).not.toContain(forbidden);
    }
  });

  // --- 9. Sanitization --------------------------------------------------------

  test('9a. Control-char / non-WinAnsi firm/matter/client/user strings do not crash generation', async () => {
    const res = await bundleDownloadRequest(adminToken, weirdMatterId, [weirdPdf1, weirdPdf2], { includeCertificate: true, includeBookmarks: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    const pageCount = await outputPageCount(res.body);
    expect(pageCount).toBe(4); // 2 + 1 source + 1 certificate
    const outline = await readOutline(res.body);
    expect(outline.items[outline.items.length - 1].title).toBe('Bundle Certificate');
  });

  test('9b. Saved weird-name bundle with certificate is valid and stays staff-only', async () => {
    const res = await bundleSaveRequest(adminToken, weirdMatterId, [weirdPdf1, weirdPdf2], { filename: 'r20n-weird-save.pdf', includeCertificate: true });
    expect(res.statusCode).toBe(200);
    expect(Number(res.body.clientVisible)).toBe(0);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    const savedContent = Buffer.isBuffer(saved.content) ? saved.content : Buffer.from(saved.content);
    expect(await outputPageCount(savedContent)).toBe(4);
  });

  // --- 10. Access control -----------------------------------------------------

  test('10a. Client rejected from certificate download', async () => {
    const res = await bundleDownloadRequest(clientToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCertificate: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  test('10b. Advocate inaccessible matter rejected for certificate download', async () => {
    const res = await bundleDownloadRequest(advocateToken, michaelMatterId, [michaelPdf], { includeCertificate: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('10c. Assistant rejected from certificate save (requireAdvocateOrAdmin)', async () => {
    const res = await bundleSaveRequest(assistantToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCertificate: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('10d. Client rejected from certificate save', async () => {
    const res = await bundleSaveRequest(clientToken, sarahMatterId, [sarahPdf1, sarahPdf2], { includeCertificate: true });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });
});
