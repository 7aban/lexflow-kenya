const { execFileSync } = require('child_process');
const path = require('path');
const request = require('supertest');
const sqlite3 = require('sqlite3');
const { PDFDocument } = require('pdf-lib');

jest.setTimeout(30000);

const serverRoot = path.join(__dirname, '..');
const seedScript = path.join(serverRoot, 'scripts', 'seed-demo-data.js');

describe('DEMO-27G seeded image documents work with Images-to-PDF', () => {
  let app;
  let dbReady;
  let config;
  let adminToken;

  async function withDb(work) {
    const db = new sqlite3.Database(config.DATABASE_PATH);
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
    const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
    const close = () => new Promise(resolve => db.close(() => resolve()));
    try {
      return await work({ get, all });
    } finally {
      await close();
    }
  }

  function imagesRequest(token, documentIds, { filename = 'seed-demo-images.pdf', pageSize = 'A4' } = {}) {
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

  function hasPngSignature(content) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content || '');
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return buf.length >= 8 && buf.subarray(0, 8).equals(sig);
  }

  beforeAll(async () => {
    execFileSync(process.execPath, [seedScript], { cwd: serverRoot, env: process.env, stdio: 'pipe' });
    config = require('../lib/config');
    ({ app, dbReady } = require('../server.js'));
    await dbReady;
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(loginRes.statusCode).toBe(200);
    adminToken = loginRes.body.token;
  });

  // 1. Seed creates image/png document rows.
  test('seed creates image/png document rows', async () => {
    const row = await withDb(({ get }) => get("SELECT COUNT(*) count FROM documents WHERE mimeType='image/png' AND deletedAt IS NULL"));
    expect(row.count).toBeGreaterThan(0);
  });

  // 2. At least one seeded image/png document starts with a valid PNG signature.
  test('seeded image/png documents start with a valid PNG signature', async () => {
    const rows = await withDb(({ all }) => all("SELECT id, content FROM documents WHERE mimeType='image/png' AND deletedAt IS NULL"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => hasPngSignature(r.content))).toBe(true);
    // Every seeded image/png document should be a real PNG (not placeholder text).
    expect(rows.every(r => hasPngSignature(r.content))).toBe(true);
  });

  // 3 & 4. Images-to-PDF converts one seeded PNG to a one-page PDF.
  test('Images-to-PDF converts a seeded PNG document into a one-page PDF', async () => {
    const doc = await withDb(({ get }) => get("SELECT id, matterId FROM documents WHERE mimeType='image/png' AND matterId IS NOT NULL AND matterId<>'' AND deletedAt IS NULL ORDER BY id LIMIT 1"));
    expect(doc).toBeTruthy();

    const res = await imagesRequest(adminToken, [doc.id]);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf\b/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');

    const pdf = await PDFDocument.load(res.body);
    expect(pdf.getPageCount()).toBe(1);
  });

  // 5. The source image document is not modified by the conversion.
  test('source image document is unchanged after conversion', async () => {
    const before = await withDb(({ get }) => get("SELECT id, content, mimeType FROM documents WHERE mimeType='image/png' AND matterId IS NOT NULL AND matterId<>'' AND deletedAt IS NULL ORDER BY id LIMIT 1"));
    const beforeBuf = Buffer.isBuffer(before.content) ? before.content : Buffer.from(before.content);

    const res = await imagesRequest(adminToken, [before.id]);
    expect(res.statusCode).toBe(200);

    const after = await withDb(({ get }) => get('SELECT content, mimeType FROM documents WHERE id=?', [before.id]));
    const afterBuf = Buffer.isBuffer(after.content) ? after.content : Buffer.from(after.content);
    expect(afterBuf.equals(beforeBuf)).toBe(true);
    expect(after.mimeType).toBe('image/png');
    expect(hasPngSignature(afterBuf)).toBe(true);
  });

  // 6 & 7. Save creates exactly one new document (source=document_tool, clientVisible=0)
  // and no deadline/appearance/task/client_activity side effects.
  test('saving a seeded-image PDF creates exactly one document_tool document and no other side effects', async () => {
    const doc = await withDb(({ get }) => get("SELECT id, matterId FROM documents WHERE mimeType='image/png' AND matterId IS NOT NULL AND matterId<>'' AND deletedAt IS NULL ORDER BY id LIMIT 1"));
    expect(doc).toBeTruthy();

    const before = await withDb(async ({ get }) => ({
      documents: (await get('SELECT COUNT(*) c FROM documents')).c,
      deadlines: (await get('SELECT COUNT(*) c FROM deadlines')).c,
      appearances: (await get('SELECT COUNT(*) c FROM appearances')).c,
      tasks: (await get('SELECT COUNT(*) c FROM tasks')).c,
      clientActivity: (await get('SELECT COUNT(*) c FROM client_activity')).c,
    }));

    const res = await request(app)
      .post('/api/document-tools/images-to-pdf/save')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId: doc.matterId, documentIds: [doc.id], filename: 'seed-demo-images-save.pdf', pageSize: 'A4' });
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('document_tool');
    expect(Number(res.body.clientVisible)).toBe(0);
    expect(res.body.mimeType).toBe('application/pdf');

    const after = await withDb(async ({ get }) => ({
      documents: (await get('SELECT COUNT(*) c FROM documents')).c,
      deadlines: (await get('SELECT COUNT(*) c FROM deadlines')).c,
      appearances: (await get('SELECT COUNT(*) c FROM appearances')).c,
      tasks: (await get('SELECT COUNT(*) c FROM tasks')).c,
      clientActivity: (await get('SELECT COUNT(*) c FROM client_activity')).c,
    }));

    expect(after.documents).toBe(before.documents + 1);
    expect(after.deadlines).toBe(before.deadlines);
    expect(after.appearances).toBe(before.appearances);
    expect(after.tasks).toBe(before.tasks);
    expect(after.clientActivity).toBe(before.clientActivity);

    const saved = await withDb(({ get }) => get('SELECT source, clientVisible FROM documents WHERE id=?', [res.body.id]));
    expect(saved.source).toBe('document_tool');
    expect(Number(saved.clientVisible)).toBe(0);
  });
});
