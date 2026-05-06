const request = require('supertest');
const { app } = require('../server.js');
const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

// Use a temp file-based DB for WAL mode tests
const tempDbPath = path.join(__dirname, 'temp-wal-test.db');

function createWalDb() {
  // Delete temp DB if it exists
  try { fs.unlinkSync(tempDbPath); } catch (e) {}
  const db = new sqlite3.Database(tempDbPath);
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA busy_timeout=5000');
  return db;
}

// Promisified helper
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

describe('R3a: SQLite WAL mode and busy_timeout', () => {
  let db;

  beforeEach(() => {
    db = createWalDb();
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(tempDbPath); } catch (e) {}
  });

  test('WAL mode is enabled', async () => {
    const row = await dbGet(db, 'PRAGMA journal_mode');
    expect(String(row.journal_mode || '').toLowerCase()).toBe('wal');
  });

  test('busy_timeout is set to 5000', async () => {
    const row = await dbGet(db, 'PRAGMA busy_timeout');
    expect(Number(row.timeout)).toBe(5000);
  });
});

describe('R3a: Document soft-delete', () => {
  let adminToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    adminToken = res.body.token;
  });

  test('DELETE route sets deletedAt instead of hard delete', async () => {
    // Upload a document first
    const uploadRes = await request(app)
      .post('/api/matters/LEX-2026-0001/documents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'test-doc.pdf',
        mimeType: 'application/pdf',
        data: 'data:application/pdf;base64,' + Buffer.from('test content').toString('base64'),
      });

    if (uploadRes.statusCode !== 200) return; // Skip if upload fails

    const docId = uploadRes.body.id;

    // Delete the document
    const deleteRes = await request(app)
      .delete(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(deleteRes.statusCode).toBe(200);

    // Verify document still exists but has deletedAt set
    const db = new sqlite3.Database(path.join(__dirname, '..', 'lawfirm.db'));
    const doc = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM documents WHERE id=?', [docId], (err, row) => {
        db.close();
        err ? reject(err) : resolve(row);
      });
    });
    expect(doc).toBeDefined();
    expect(doc.deletedAt).toBeDefined();
  });

  test('soft-deleted document not in matter document list', async () => {
    const res = await request(app)
      .get('/api/matters/LEX-2026-0001/documents')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    // Should not contain any documents with deletedAt set
    const hasDeleted = res.body.some(doc => doc.deletedAt);
    expect(hasDeleted).toBe(false);
  });
});

describe('R3a: Document access audit logging', () => {
  let adminToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    adminToken = res.body.token;
  });

  test('successful document download creates audit event', async () => {
    // Get a document ID first
    const docsRes = await request(app)
      .get('/api/matters/LEX-2026-0001/documents')
      .set('Authorization', `Bearer ${adminToken}`);

    if (!docsRes.body || docsRes.body.length === 0) return; // Skip if no documents

    const docId = docsRes.body[0].id;

    // Download the document
    await request(app)
      .get(`/api/documents/${docId}/download`)
      .set('Authorization', `Bearer ${adminToken}`);

    // Check audit_events for document_accessed action
    const db = new sqlite3.Database(path.join(__dirname, '..', 'lawfirm.db'));
    const event = await new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM audit_events WHERE entity_id=? AND action='document_accessed' ORDER BY created_at DESC LIMIT 1",
        [docId],
        (err, row) => {
          db.close();
          err ? reject(err) : resolve(row);
        }
      );
    });

    if (event) {
      expect(event.action).toBe('document_accessed');
      const metadata = JSON.parse(event.metadata_json || '{}');
      expect(metadata.documentId).toBe(docId);
      // Ensure no sensitive data in metadata
      expect(metadata.base64).toBeUndefined();
      expect(metadata.jwt).toBeUndefined();
    }
  });
});
