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
      'r20c-test',
    ],
  );
  return id;
}

function saveRequest(token, matterId, documentIds, filename = 'r20c-merged.pdf', extra = {}) {
  return request(app)
    .post('/api/document-tools/merge-pdfs/save')
    .set('Authorization', `Bearer ${token}`)
    .send({ matterId, documentIds, filename, ...extra });
}

describe('PRODUCT-14D save merged PDF to matter documents', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let sarahMatterId;
  let michaelMatterId;
  let sarahPdfA;
  let sarahPdfB;
  let sarahPdfC;
  let michaelPdfA;
  let michaelPdfB;
  let textDoc;
  let corruptPdf;

  const suffix = Date.now();
  let sarahClientId;
  let testClientToken;

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('/api/auth/login', 'admin@lexflow.co.ke');
    advocateToken = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    assistantToken = await login('/api/auth/login', 'david.wanjiku@achokilaw.co.ke');
    clientToken = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');

    sarahClientId = await createClient(adminToken, `R20c Sarah Client ${suffix}`, `r20c.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20c Michael Client ${suffix}`, `r20c.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `R20c Sarah Save Matter ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20c Michael Save Matter ${suffix}`, 'Michael Oduor');

    sarahPdfA = await insertDocument({ id: `DOC_R20C_SA_${suffix}`, matterId: sarahMatterId, name: `r20c-sarah-a-${suffix}.pdf`, content: await pdfBuffer(`Sarah PDF A ${suffix}`) });
    sarahPdfB = await insertDocument({ id: `DOC_R20C_SB_${suffix}`, matterId: sarahMatterId, name: `r20c-sarah-b-${suffix}.pdf`, content: await pdfBuffer(`Sarah PDF B ${suffix}`) });
    sarahPdfC = await insertDocument({ id: `DOC_R20C_SC_${suffix}`, matterId: sarahMatterId, name: `r20c-sarah-c-${suffix}.pdf`, content: await pdfBuffer(`Sarah PDF C ${suffix}`) });
    michaelPdfA = await insertDocument({ id: `DOC_R20C_MA_${suffix}`, matterId: michaelMatterId, name: `r20c-michael-a-${suffix}.pdf`, content: await pdfBuffer(`Michael PDF A ${suffix}`) });
    michaelPdfB = await insertDocument({ id: `DOC_R20C_MB_${suffix}`, matterId: michaelMatterId, name: `r20c-michael-b-${suffix}.pdf`, content: await pdfBuffer(`Michael PDF B ${suffix}`) });
    textDoc = await insertDocument({ id: `DOC_R20C_TXT_${suffix}`, matterId: sarahMatterId, name: `r20c-text-${suffix}.txt`, mimeType: 'text/plain', type: 'Text', content: Buffer.from('R20c text document body') });
    corruptPdf = await insertDocument({ id: `DOC_R20C_BAD_${suffix}`, matterId: sarahMatterId, name: `r20c-corrupt-${suffix}.pdf`, content: Buffer.from('%PDF-r20c-not-a-valid-pdf') });

    // Create a client user linked to sarah's client for visibility testing
    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `r20c.client.user.${suffix}@example.com`, password: 'R20cPass!987', fullName: 'R20c Client User', role: 'client', clientId: sarahClientId });
    expect(registerRes.statusCode).toBe(200);
    const loginRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: `r20c.client.user.${suffix}@example.com`, password: 'R20cPass!987' });
    expect(loginRes.statusCode).toBe(200);
    testClientToken = loginRes.body.token;
  });

  test('admin can save merged PDF output to a matter', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await saveRequest(adminToken, sarahMatterId, [sarahPdfA, sarahPdfB], 'r20c-admin-save.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.matterId).toBe(sarahMatterId);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
    expect(res.body.content).toBeUndefined();
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count + 1);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(saved).toBeDefined();
    expect(saved.matterId).toBe(sarahMatterId);
    expect(saved.mimeType).toBe('application/pdf');
    expect(saved.source).toBe('document_tool');
    expect(Number(saved.clientVisible)).toBe(0);
    expect(saved.uploadedBy).toBeDefined();
    expect(saved.content).toBeDefined();
    expect(Buffer.isBuffer(saved.content) ? saved.content.length : Buffer.from(saved.content).length).toBeGreaterThan(0);
  });

  test('advocate can save merged PDF output to an assigned matter', async () => {
    const res = await saveRequest(advocateToken, sarahMatterId, [sarahPdfA, sarahPdfB], 'r20c-adv-save.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
  });

  test('advocate cannot save to an inaccessible matter', async () => {
    const res = await saveRequest(advocateToken, michaelMatterId, [michaelPdfA, michaelPdfB]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('assistant is rejected', async () => {
    const res = await saveRequest(assistantToken, sarahMatterId, [sarahPdfA, sarahPdfB]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('client is rejected', async () => {
    const res = await saveRequest(clientToken, sarahMatterId, [sarahPdfA, sarahPdfB]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('non-PDF document rejected', async () => {
    const res = await saveRequest(adminToken, sarahMatterId, [sarahPdfA, textDoc]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only pdf/i);
  });

  test('fewer than 2 PDFs rejected', async () => {
    const res = await saveRequest(adminToken, sarahMatterId, [sarahPdfA]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/at least 2/i);
  });

  test('more than 10 PDFs rejected', async () => {
    const res = await saveRequest(adminToken, sarahMatterId, Array.from({ length: 11 }, (_, index) => `DOC_R20C_OVER_${suffix}_${index}`));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/no more than 10/i);
  });

  test('duplicate document IDs rejected', async () => {
    const res = await saveRequest(adminToken, sarahMatterId, [sarahPdfA, sarahPdfA]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
  });

  test('different-matter source documents rejected', async () => {
    const res = await saveRequest(adminToken, sarahMatterId, [sarahPdfA, michaelPdfA]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/target matter/i);
  });

  test('corrupt PDF rejected safely', async () => {
    const res = await saveRequest(adminToken, sarahMatterId, [sarahPdfA, corruptPdf]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/could not be read/i);
  });

  test('saved document row has correct field values', async () => {
    const res = await saveRequest(adminToken, sarahMatterId, [sarahPdfA, sarahPdfB], 'r20c-field-check.pdf');
    expect(res.statusCode).toBe(200);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(saved.source).toBe('document_tool');
    expect(saved.mimeType).toBe('application/pdf');
    expect(saved.matterId).toBe(sarahMatterId);
    expect(Number(saved.clientVisible)).toBe(0);
    expect(saved.uploadedBy).toBeTruthy();
    expect(saved.content).toBeDefined();
  });

  test('no extra document rows beyond the one expected output row', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await saveRequest(adminToken, sarahMatterId, [sarahPdfB, sarahPdfC], 'r20c-count-check.pdf');
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count + 1);
  });

  test('saved document is downloadable through GET /api/documents/:id/download', async () => {
    const res = await saveRequest(adminToken, sarahMatterId, [sarahPdfA, sarahPdfB], 'r20c-dl.pdf');
    expect(res.statusCode).toBe(200);
    const download = await request(app)
      .get(`/api/documents/${res.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(download.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('saved document appears in GET /api/matters/:id/documents', async () => {
    const res = await saveRequest(adminToken, sarahMatterId, [sarahPdfA, sarahPdfB], 'r20c-list.pdf');
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(docsRes.statusCode).toBe(200);
    const ids = docsRes.body.map(d => d.id);
    expect(ids).toContain(res.body.id);
  });

  test('client cannot see saved document while clientVisible=0', async () => {
    const res = await saveRequest(adminToken, sarahMatterId, [sarahPdfA, sarahPdfB], 'r20c-client-vis.pdf');
    expect(res.statusCode).toBe(200);
    const docsRes = await request(app)
      .get(`/api/matters/${sarahMatterId}/documents`)
      .set('Authorization', `Bearer ${testClientToken}`);
    expect(docsRes.statusCode).toBe(200);
    const ids = docsRes.body.map(d => d.id);
    expect(ids).not.toContain(res.body.id);
  });

  test('audit event document_tool_merge_pdf_saved is created with safe metadata only', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await saveRequest(adminToken, sarahMatterId, [sarahPdfA, sarahPdfB], 'r20c-audit.pdf');
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_merge_pdf_saved', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');
    expect(event.entity_id).toBe(res.body.id);

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.sourceDocumentIds).toEqual([sarahPdfA, sarahPdfB]);
    expect(metadata.sourceCount).toBe(2);
    expect(metadata.targetMatterId).toBe(sarahMatterId);
    expect(metadata.outputDocumentId).toBe(res.body.id);
    expect(metadata.combinedInputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);
    expect(metadata.clientVisible).toBe(false);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', '%pdf', 'sarah pdf']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('existing temporary merge route still passes a targeted sanity check', async () => {
    const res = await request(app)
      .post('/api/document-tools/merge-pdfs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ documentIds: [sarahPdfA, sarahPdfB], filename: 'r20c-sanity.pdf' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });
});
