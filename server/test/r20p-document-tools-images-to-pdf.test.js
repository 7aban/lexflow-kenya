const request = require('supertest');
const sqlite3 = require('sqlite3');
const zlib = require('zlib');
const { PDFDocument } = require('pdf-lib');
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

// --- Valid PNG generation (zlib + CRC32) so embedPng has real bytes to parse ---
function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const rowLen = width * 3;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (rowLen + 1);
    raw[off] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 3;
      raw[p] = (x * 7) & 0xff;
      raw[p + 1] = (y * 11) & 0xff;
      raw[p + 2] = 128;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// Minimal valid baseline JPEG (1x1) to exercise the embedJpg branch.
const JPEG_1x1 = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpgAAH/2Q==', 'base64');

async function insertDocument({ id, matterId, name, mimeType, type, content }) {
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
      'r20p-test',
    ],
  );
  return id;
}

function imagesRequest(token, documentIds, { filename = 'r20p-images.pdf', pageSize = 'A4' } = {}) {
  return request(app)
    .post('/api/document-tools/images-to-pdf')
    .set('Authorization', `Bearer ${token}`)
    .send({ documentIds, filename, pageSize })
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

function imagesSaveRequest(token, matterId, documentIds, { filename = 'r20p-images-save.pdf', pageSize = 'A4' } = {}) {
  return request(app)
    .post('/api/document-tools/images-to-pdf/save')
    .set('Authorization', `Bearer ${token}`)
    .send({ matterId, documentIds, filename, pageSize });
}

async function outputPageCount(buffer) {
  const pdf = await PDFDocument.load(buffer);
  return pdf.getPageCount();
}

describe('PRODUCT-27E images to PDF tool', () => {
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let sarahMatterId;
  let michaelMatterId;
  let pngA;
  let pngB;
  let pngC;
  let jpgA;
  let michaelPng;
  let textDoc;
  let pdfDoc;
  let webpDoc;

  const suffix = Date.now();
  let sarahClientId;
  let testClientToken;

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('/api/auth/login', 'admin@lexflow.co.ke');
    advocateToken = await login('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    assistantToken = await login('/api/auth/login', 'david.wanjiku@achokilaw.co.ke');
    clientToken = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');

    sarahClientId = await createClient(adminToken, `R20p Sarah Client ${suffix}`, `r20p.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(adminToken, `R20p Michael Client ${suffix}`, `r20p.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(adminToken, sarahClientId, `R20p Sarah Images Matter ${suffix}`, 'Sarah Mwangi');
    michaelMatterId = await createMatter(adminToken, michaelClientId, `R20p Michael Images Matter ${suffix}`, 'Michael Oduor');

    pngA = await insertDocument({ id: `DOC_R20P_PA_${suffix}`, matterId: sarahMatterId, name: `r20p-a-${suffix}.png`, mimeType: 'image/png', type: 'Image', content: makePng(12, 8) });
    pngB = await insertDocument({ id: `DOC_R20P_PB_${suffix}`, matterId: sarahMatterId, name: `r20p-b-${suffix}.png`, mimeType: 'image/png', type: 'Image', content: makePng(20, 16) });
    pngC = await insertDocument({ id: `DOC_R20P_PC_${suffix}`, matterId: sarahMatterId, name: `r20p-c-${suffix}.png`, mimeType: 'image/png', type: 'Image', content: makePng(6, 10) });
    jpgA = await insertDocument({ id: `DOC_R20P_JA_${suffix}`, matterId: sarahMatterId, name: `r20p-a-${suffix}.jpg`, mimeType: 'image/jpeg', type: 'Image', content: JPEG_1x1 });
    michaelPng = await insertDocument({ id: `DOC_R20P_MP_${suffix}`, matterId: michaelMatterId, name: `r20p-m-${suffix}.png`, mimeType: 'image/png', type: 'Image', content: makePng(10, 10) });
    textDoc = await insertDocument({ id: `DOC_R20P_TXT_${suffix}`, matterId: sarahMatterId, name: `r20p-text-${suffix}.txt`, mimeType: 'text/plain', type: 'Text', content: Buffer.from('R20p text document body') });
    pdfDoc = await insertDocument({ id: `DOC_R20P_PDF_${suffix}`, matterId: sarahMatterId, name: `r20p-doc-${suffix}.pdf`, mimeType: 'application/pdf', type: 'PDF', content: Buffer.from('%PDF-1.4 r20p') });
    webpDoc = await insertDocument({ id: `DOC_R20P_WEBP_${suffix}`, matterId: sarahMatterId, name: `r20p-w-${suffix}.webp`, mimeType: 'image/webp', type: 'Image', content: Buffer.from('RIFF....WEBPVP8 r20p') });

    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `r20p.client.user.${suffix}@example.com`, password: 'R20pPass!987', fullName: 'R20p Client User', role: 'client', clientId: sarahClientId });
    expect(registerRes.statusCode).toBe(200);
    const loginRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: `r20p.client.user.${suffix}@example.com`, password: 'R20pPass!987' });
    expect(loginRes.statusCode).toBe(200);
    testClientToken = loginRes.body.token;
  });

  // 1. Happy path download returns valid PDF.
  test('1. admin can convert images to PDF as temporary download', async () => {
    const res = await imagesRequest(adminToken, [pngA, pngB]);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/i);
    expect(res.headers['cache-control']).toMatch(/no-store/i);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  // 2. Output page count equals selected image count.
  test('2. output page count equals selected image count', async () => {
    const res = await imagesRequest(adminToken, [pngA, pngB, pngC]);
    expect(res.statusCode).toBe(200);
    expect(await outputPageCount(res.body)).toBe(3);

    const single = await imagesRequest(adminToken, [pngA]);
    expect(single.statusCode).toBe(200);
    expect(await outputPageCount(single.body)).toBe(1);
  });

  test('2b. JPEG image documents are accepted', async () => {
    const res = await imagesRequest(adminToken, [jpgA, pngA]);
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(await outputPageCount(res.body)).toBe(2);
  });

  test('2c. Letter page size is accepted', async () => {
    const res = await imagesRequest(adminToken, [pngA], { pageSize: 'Letter' });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('2d. invalid page size rejected', async () => {
    const res = await imagesRequest(adminToken, [pngA], { pageSize: 'A3' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/A4 or Letter/i);
  });

  // 3. Save creates a new matter document with source=document_tool.
  test('3. admin can save images PDF with source=document_tool', async () => {
    const res = await imagesSaveRequest(adminToken, sarahMatterId, [pngA, pngB], { filename: 'r20p-save-admin.pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.matterId).toBe(sarahMatterId);
    expect(res.body.source).toBe('document_tool');
    expect(res.body.content).toBeUndefined();
  });

  // 4. Saved document has clientVisible=0.
  test('4. saved document has clientVisible=0', async () => {
    const res = await imagesSaveRequest(adminToken, sarahMatterId, [pngA], { filename: 'r20p-vis.pdf' });
    expect(res.statusCode).toBe(200);
    expect(Number(res.body.clientVisible)).toBe(0);
    const saved = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.id]);
    expect(Number(saved.clientVisible)).toBe(0);
    expect(saved.source).toBe('document_tool');
    expect(saved.uploadedBy).toBeTruthy();
    expect(saved.mimeType).toBe('application/pdf');
  });

  // 5. Original image documents remain unchanged.
  test('5. original image documents remain unchanged after download and save', async () => {
    const before = await dbGet('SELECT content FROM documents WHERE id=?', [pngA]);
    const beforeBuf = Buffer.isBuffer(before.content) ? before.content : Buffer.from(before.content);

    const dl = await imagesRequest(adminToken, [pngA, pngB]);
    expect(dl.statusCode).toBe(200);
    const sv = await imagesSaveRequest(adminToken, sarahMatterId, [pngA, pngB], { filename: 'r20p-unchanged.pdf' });
    expect(sv.statusCode).toBe(200);

    const after = await dbGet('SELECT content, mimeType FROM documents WHERE id=?', [pngA]);
    const afterBuf = Buffer.isBuffer(after.content) ? after.content : Buffer.from(after.content);
    expect(afterBuf.equals(beforeBuf)).toBe(true);
    expect(after.mimeType).toBe('image/png');
  });

  // 6. Client cannot call route.
  test('6. client is rejected from download route', async () => {
    const res = await imagesRequest(clientToken, [pngA]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access/i);
  });

  // 7. Assistant can download (requireStaff) but cannot save (requireAdvocateOrAdmin).
  test('7a. assistant can convert as temporary download', async () => {
    const res = await imagesRequest(assistantToken, [pngA, pngB]);
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('7b. assistant is rejected from save route', async () => {
    const res = await imagesSaveRequest(assistantToken, sarahMatterId, [pngA]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/advocate or admin/i);
  });

  test('7c. advocate on assigned matter can download and save', async () => {
    const dl = await imagesRequest(advocateToken, [pngA, pngC]);
    expect(dl.statusCode).toBe(200);
    const sv = await imagesSaveRequest(advocateToken, sarahMatterId, [pngA, pngC], { filename: 'r20p-adv-save.pdf' });
    expect(sv.statusCode).toBe(200);
    expect(sv.body.source).toBe('document_tool');
    expect(Number(sv.body.clientVisible)).toBe(0);
  });

  // 8. Inaccessible document denied.
  test('8a. advocate on inaccessible matter is rejected on download', async () => {
    const res = await imagesRequest(advocateToken, [michaelPng]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('8b. advocate on inaccessible matter is rejected on save', async () => {
    const res = await imagesSaveRequest(advocateToken, michaelMatterId, [michaelPng]);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('8c. nonexistent document rejected', async () => {
    const res = await imagesRequest(adminToken, ['NONEXISTENT_DOC']);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // 9. Images from different matters rejected.
  test('9a. images from different matters rejected on download', async () => {
    const res = await imagesRequest(adminToken, [pngA, michaelPng]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/same matter/i);
  });

  test('9b. image not belonging to the target matter rejected on save', async () => {
    const res = await imagesSaveRequest(adminToken, michaelMatterId, [pngA]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/belong to the target matter/i);
  });

  // 10. Non-image source rejected.
  test('10a. text document rejected', async () => {
    const res = await imagesRequest(adminToken, [textDoc]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only png and jpeg/i);
  });

  test('10b. PDF document rejected', async () => {
    const res = await imagesRequest(adminToken, [pdfDoc]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only png and jpeg/i);
  });

  // 11. WebP rejected with clear 400.
  test('11. WebP image rejected with a clear message', async () => {
    const res = await imagesRequest(adminToken, [webpDoc]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/webp/i);
  });

  // 12. Empty documentIds rejected.
  test('12. empty or missing documentIds rejected', async () => {
    const empty = await imagesRequest(adminToken, []);
    expect(empty.statusCode).toBe(400);
    expect(empty.body.error).toMatch(/at least 1 image/i);

    const missing = await request(app)
      .post('/api/document-tools/images-to-pdf')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ filename: 'r20p-missing.pdf', pageSize: 'A4' });
    expect(missing.statusCode).toBe(400);
    expect(missing.body.error).toMatch(/must be an array/i);
  });

  // 13. Too many images rejected.
  test('13. more than 10 images rejected', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `DOC_R20P_FAKE_${i}_${suffix}`);
    const res = await imagesRequest(adminToken, ids);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/no more than 10/i);
  });

  test('13b. temporary download creates no new document row', async () => {
    const before = await dbGet('SELECT COUNT(*) count FROM documents');
    const res = await imagesRequest(adminToken, [pngA, pngB]);
    expect(res.statusCode).toBe(200);
    const after = await dbGet('SELECT COUNT(*) count FROM documents');
    expect(after.count).toBe(before.count);
  });

  // 14. Audit events recorded for download and save.
  test('14a. document_tool_images_to_pdf_downloaded audit event has safe metadata', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await imagesRequest(adminToken, [pngA, pngB], { filename: 'r20p-audit.pdf', pageSize: 'A4' });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_images_to_pdf_downloaded', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.sourceDocumentIds).toEqual([pngA, pngB]);
    expect(metadata.sourceMatterId).toBe(sarahMatterId);
    expect(metadata.imageCount).toBe(2);
    expect(metadata.pageSize).toBe('A4');
    expect(metadata.inputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);
    expect(metadata.filename).toMatch(/\.pdf$/i);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', 'ivbor']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('14b. document_tool_images_to_pdf_saved audit event has safe metadata', async () => {
    const boundary = await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events');
    const res = await imagesSaveRequest(adminToken, sarahMatterId, [pngA, pngB, pngC], { filename: 'r20p-audit-save.pdf', pageSize: 'Letter' });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      `SELECT rowid,* FROM audit_events
       WHERE rowid>? AND action=? AND matter_id=?
       ORDER BY rowid DESC LIMIT 1`,
      [boundary.rowid, 'document_tool_images_to_pdf_saved', sarahMatterId],
    );
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document_tool');
    expect(event.entity_id).toBe(res.body.id);

    const metadata = JSON.parse(event.metadata_json || '{}');
    expect(metadata.sourceDocumentIds).toEqual([pngA, pngB, pngC]);
    expect(metadata.targetMatterId).toBe(sarahMatterId);
    expect(metadata.outputDocumentId).toBe(res.body.id);
    expect(metadata.imageCount).toBe(3);
    expect(metadata.pageSize).toBe('Letter');
    expect(metadata.inputBytes).toBeGreaterThan(0);
    expect(metadata.outputBytes).toBeGreaterThan(0);
    expect(metadata.clientVisible).toBe(false);

    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['authorization', 'bearer', 'password', 'secret', 'blob', 'base64', 'ivbor']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('15. saved doc downloadable and staff-listed but hidden from client while clientVisible=0', async () => {
    const res = await imagesSaveRequest(adminToken, sarahMatterId, [pngA, pngB], { filename: 'r20p-list.pdf' });
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
