const request = require('supertest');
const sqlite3 = require('sqlite3');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(20000);

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

function dbAll(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      db.close();
      err ? reject(err) : resolve(rows);
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
      'r20d-test',
    ],
  );
  return id;
}

function rotateRequest(token, documentId, degrees = 90, filename = 'r20d-rotated.pdf') {
  return request(app)
    .post('/api/document-tools/rotate-pdf')
    .set('Authorization', `Bearer ${token}`)
    .send({ documentId, degrees, filename })
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

function rotateSaveRequest(token, matterId, documentId, degrees = 90, filename = 'r20d-rotated-save.pdf') {
  return request(app)
    .post('/api/document-tools/rotate-pdf/save')
    .set('Authorization', `Bearer ${token}`)
    .send({ matterId, documentId, degrees, filename });
}

describe('PRODUCT-14E rotate PDF tool', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let sarahMatterId;
  let michaelMatterId;
  let sarahPdfA;
  let michaelPdfA;
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

    sarahClientId = await createClient(adminToken, `R20d Sarah Client ${suffix}`, `r20d.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20d Michael Client ${suffix}`, `r20d.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `R20d Sarah Rotate Matter ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20d Michael Rotate Matter ${suffix}`, 'Michael Oduor');

    sarahPdfA = await insertDocument({ id: `DOC_R20D_SA_${suffix}`, matterId: sarahMatterId, name: `r20d-sarah-a-${suffix}.pdf`, content: await pdfBuffer(`Sarah PDF A ${suffix}`) });
    michaelPdfA = await insertDocument({ id: `DOC_R20D_MA_${suffix}`, matterId: michaelMatterId, name: `r20d-michael-a-${suffix}.pdf`, content: await pdfBuffer(`Michael PDF A ${suffix}`) });
    textDoc = await insertDocument({ id: `DOC_R20D_TXT_${suffix}`, matterId: sarahMatterId, name: `r20d-text-${suffix}.txt`, mimeType: 'text/plain', type: 'Text', content: Buffer.from('R20d text document body') });
    corruptPdf = await insertDocument({ id: `DOC_R20D_BAD_${suffix}`, matterId: sarahMatterId, name: `r20d-corrupt-${suffix}.pdf`, content: Buffer.from('%PDF-r20d-not-a-valid-pdf') });
    largePdf = await insertDocument({ id: `DOC_R20D_LRG_${suffix}`, matterId: sarahMatterId, name: `r20d-large-${suffix}.pdf`, content: Buffer.alloc(21 * 1024 * 1024) });

    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `r20d.client.user.${suffix}@example.com`, password: 'R20dPass!987', fullName: 'R20d Client User', role: 'client', clientId: sarahClientId });
    expect(registerRes.statusCode).toBe(200);
    const loginRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: `r20d.client.user.${suffix}@example.com`, password: 'R20dPass!987' });
    expect(loginRes.statusCode).toBe(200);
    testClientToken = loginRes.body.token;
  });

  test('1. admin can rotate PDF 90 degrees as temporary download', async () => {
    const res = await rotateRequest(adminToken, sarahPdfA, 90);
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('2. response has application/pdf, attachment filename, no-store', async () => {
    const res = await rotateRequest(adminToken, sarahPdfA, 90);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/i);
    expect(res.headers['cache-control']).toMatch(/no-store/i);
  });

  test('3. response body starts with %PDF', async () => {
    const res = await rotateRequest(adminToken, sarahPdfA, 90);
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('4. advocate on assigned matter can rotate as temporary download', async () => {
    const res = await rotateRequest(advocateToken, sarahPdfA, 90);
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('5. advocate on inaccessible matter is rejected', async () => {
    const res = await rotateRequest(advocateToken, michaelPdfA, 90);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('6. client is rejected', async () => {
    const res = await rotateRequest(clientToken, sarahPdfA, 90);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  test('7. non-PDF document rejected', async () => {
    const res = await rotateRequest(adminToken, textDoc, 90);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  test('8. nonexistent document rejected', async () => {
    const res = await rotateRequest(adminToken, 'NONEXISTENT_DOC', 90);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('9. invalid degrees 45 rejected', async () => {
    const res = await rotateRequest(adminToken, sarahPdfA, 45);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/degrees/i);
  });

  test('10. invalid degrees 0 rejected', async () => {
    const res = await rotateRequest(adminToken, sarahPdfA, 0);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/degrees/i);
  });

  test('11. corrupt PDF rejected safely', async () => {
    const res = await rotateRequest(adminToken, corruptPdf, 90);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/could not read/i);
  });

  test('12. input over 20MB rejected', async () => {
    const res = await rotateRequest(adminToken, largePdf, 90);
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toMatch(/20 MB/i);
  });

  test('13. temporary download creates no new document row', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await rotateRequest(adminToken, sarahPdfA, 180);
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count);
  });

  test('14. audit event document_tool_rotate_pdf_downloaded created with safe metadata', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await rotateRequest(adminToken, sarahPdfA, 270, 'r20d-audit.pdf');
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_rotate_pdf_downloaded', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');
    expect(event.entity_id).toBe(sarahPdfA);

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.sourceDocumentId).toBe(sarahPdfA);
    expect(metadata.sourceMatterId).toBe(sarahMatterId);
    expect(metadata.degrees).toBe(270);
    expect(metadata.inputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);
    expect(metadata.filename).toMatch(/\.pdf$/i);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf', 'sarah pdf']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('15. admin can save rotated PDF to matter documents', async () => {
    const res = await rotateSaveRequest(adminToken, sarahMatterId, sarahPdfA, 90, 'r20d-save-admin.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.matterId).toBe(sarahMatterId);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('16. save response includes id, mimeType, source, clientVisible', async () => {
    const res = await rotateSaveRequest(adminToken, sarahMatterId, sarahPdfA, 90, 'r20d-save-check.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
    expect(res.body.content).toBeUndefined();
  });

  test('17. advocate on assigned matter can save', async () => {
    const res = await rotateSaveRequest(advocateToken, sarahMatterId, sarahPdfA, 90, 'r20d-adv-save.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('18. advocate on inaccessible matter rejected', async () => {
    const res = await rotateSaveRequest(advocateToken, michaelMatterId, michaelPdfA, 90);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('19. assistant rejected from save route', async () => {
    const res = await rotateSaveRequest(assistantToken, sarahMatterId, sarahPdfA, 90);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('20. client rejected from save route', async () => {
    const res = await rotateSaveRequest(clientToken, sarahMatterId, sarahPdfA, 90);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('21. saved document row has correct field values', async () => {
    const res = await rotateSaveRequest(adminToken, sarahMatterId, sarahPdfA, 180, 'r20d-field-check.pdf');
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

  test('22. no extra rows beyond expected saved document', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await rotateSaveRequest(adminToken, sarahMatterId, sarahPdfA, 90, 'r20d-count-check.pdf');
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count + 1);
  });

  test('23. saved doc downloadable via GET /api/documents/:id/download', async () => {
    const res = await rotateSaveRequest(adminToken, sarahMatterId, sarahPdfA, 90, 'r20d-dl.pdf');
    expect(res.statusCode).toBe(200);
    const download = await request(app)
      .get(`/api/documents/${res.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(download.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('24. saved doc appears in GET /api/matters/:id/documents', async () => {
    const res = await rotateSaveRequest(adminToken, sarahMatterId, sarahPdfA, 90, 'r20d-list.pdf');
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(docsRes.statusCode).toBe(200);
    const ids = docsRes.body.map(d => d.id);
    expect(ids).toContain(res.body.id);
  });

  test('25. client cannot see saved doc while clientVisible=0', async () => {
    const res = await rotateSaveRequest(adminToken, sarahMatterId, sarahPdfA, 90, 'r20d-client-vis.pdf');
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${testClientToken}`);
    expect(docsRes.statusCode).toBe(200);
    const ids = docsRes.body.map(d => d.id);
    expect(ids).not.toContain(res.body.id);
  });

  test('26. audit event document_tool_rotate_pdf_saved created with safe metadata', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await rotateSaveRequest(adminToken, sarahMatterId, sarahPdfA, 180, 'r20d-audit-save.pdf');
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_rotate_pdf_saved', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');
    expect(event.entity_id).toBe(res.body.id);

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.sourceDocumentId).toBe(sarahPdfA);
    expect(metadata.targetMatterId).toBe(sarahMatterId);
    expect(metadata.outputDocumentId).toBe(res.body.id);
    expect(metadata.degrees).toBe(180);
    expect(metadata.inputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);
    expect(metadata.clientVisible).toBe(false);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf', 'sarah pdf']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('27. existing merge routes still pass sanity checks', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const pdfA = await pdfBuffer('Sanity A');
    const pdfB = await pdfBuffer('Sanity B');
    const docA = await insertDocument({ id: `DOC_R20D_SAN_A_${suffix}`, matterId: sarahMatterId, name: `r20d-sanity-a-${suffix}.pdf`, content: pdfA });
    const docB = await insertDocument({ id: `DOC_R20D_SAN_B_${suffix}`, matterId: sarahMatterId, name: `r20d-sanity-b-${suffix}.pdf`, content: pdfB });

    const mergeRes = await request(app)
      .post('/api/document-tools/merge-pdfs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentIds: [docA, docB], filename: 'r20d-sanity-merge.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(mergeRes.statusCode).toBe(200);
    expect(mergeRes.body.slice(0, 4).toString()).toBe('%PDF');

    const saveRes = await request(app)
      .post('/api/document-tools/merge-pdfs/save')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId: sarahMatterId, documentIds: [docA, docB], filename: 'r20d-sanity-merge-save.pdf' });
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.body.source).toBe('document_tool');
  });
});
