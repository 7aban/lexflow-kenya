const request = require('supertest');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { app } = require('../server.js');

describe('R3c Client Isolation & Audit Completion', () => {
  let adminToken;
  let advocateToken;
  let clientToken;
  let clientUserId;
  let matterId;
  let documentId;
  let softDeletedDocId;

  beforeAll(async () => {
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    adminToken = adminRes.body.token;

    const advRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    advocateToken = advRes.body.token;

    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    clientToken = clientRes.body.token;
    clientUserId = clientRes.body.user.id;
    const clientId = clientRes.body.user.clientId;

    const mattersRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${clientToken}`);
    if (mattersRes.body.length > 0) {
      matterId = mattersRes.body[0].id;
    }

    const docsRes = await request(app)
      .get(`/api/matters/${matterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`);
    if (docsRes.body.length > 0) {
      documentId = docsRes.body[0].id;
    } else {
      const uploadRes = await request(app)
        .post(`/api/matters/${matterId}/documents`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'test-r3c.pdf',
          mimeType: 'application/pdf',
          data: Buffer.from('%PDF-fake-content-for-r3c-test').toString('base64'),
          clientVisible: 1,
        });
      documentId = uploadRes.body.id;
    }

    const softDocRes = await request(app)
      .post(`/api/matters/${matterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'soft-delete-test.pdf',
        mimeType: 'application/pdf',
        data: Buffer.from('%PDF-soft-delete-test-content').toString('base64'),
        clientVisible: 1,
      });
    softDeletedDocId = softDocRes.body.id;

    await request(app)
      .delete(`/api/documents/${softDeletedDocId}`)
      .set('Authorization', `Bearer ${adminToken}`);
  });

  describe('A. Client portal document isolation after soft-delete', () => {
    test('A1. Soft-deleted document is not returned in client portal document list', async () => {
      const docsRes = await request(app)
        .get(`/api/matters/${matterId}/documents`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(docsRes.statusCode).toBe(200);
      expect(Array.isArray(docsRes.body)).toBe(true);
      const found = docsRes.body.find(d => d.id === softDeletedDocId);
      expect(found).toBeUndefined();
    });

    test('A2. Soft-deleted document is not returned in staff ordinary matter document list', async () => {
      const docsRes = await request(app)
        .get(`/api/matters/${matterId}/documents`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(docsRes.statusCode).toBe(200);
      const found = docsRes.body.find(d => d.id === softDeletedDocId);
      expect(found).toBeUndefined();
    });

    test('A3. Soft-deleted document cannot be downloaded by a client', async () => {
      const dlRes = await request(app)
        .get(`/api/documents/${softDeletedDocId}/download`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(dlRes.statusCode).toBe(404);
    });

    test('A4. Soft-deleted document cannot be downloaded by staff through ordinary download route', async () => {
      const dlRes = await request(app)
        .get(`/api/documents/${softDeletedDocId}/download`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(dlRes.statusCode).toBe(404);
    });

    test('A5. Soft-deleted document is not returned in client dashboard', async () => {
      const dashRes = await request(app)
        .get('/api/client/dashboard')
        .set('Authorization', `Bearer ${clientToken}`);
      expect(dashRes.statusCode).toBe(200);
      const found = dashRes.body.documents?.find(d => d.id === softDeletedDocId);
      expect(found).toBeUndefined();
    });

    test('A6. Soft-deleted document is not returned in matter detail view for client', async () => {
      const matterRes = await request(app)
        .get(`/api/matters/${matterId}`)
        .set('Authorization', `Bearer ${clientToken}`);
      expect(matterRes.statusCode).toBe(200);
      const found = matterRes.body.documents?.find(d => d.id === softDeletedDocId);
      expect(found).toBeUndefined();
    });

    test('A7. Non-deleted document still accessible after isolation fixes', async () => {
      const dlRes = await request(app)
        .get(`/api/documents/${documentId}/download`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(dlRes.statusCode).toBe(200);
      expect(dlRes.headers['content-type']).toBeDefined();
    });
  });

  describe('B. Backup audit events', () => {
    beforeAll(async () => {
      await execAsync('node scripts/backup.js', {
        cwd: __dirname + '/..',
        env: { ...process.env, NODE_ENV: 'test', LEXFLOW_BACKUP_KEY: process.env.LEXFLOW_BACKUP_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', LEXFLOW_BACKUP_RETENTION_COUNT: '10' },
      });
    }, 15000);

    test('B1. backup_created audit event is recorded on successful backup', async () => {
      const sqlite3 = require('sqlite3');
      const config = require('../lib/config');

      const events = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(config.DATABASE_PATH);
        db.all(
          `SELECT * FROM audit_events WHERE action='backup_created' ORDER BY timestamp DESC, id DESC LIMIT 1`,
          (err, rows) => {
            db.close();
            if (err) return reject(err);
            resolve(rows || []);
          },
        );
      });

      expect(events.length).toBeGreaterThan(0);
      const lastEvent = events[0];
      expect(lastEvent.action).toBe('backup_created');
      expect(lastEvent.actor_role).toBe('system');
    });

    test('B2. backup_created metadata excludes key/secrets/decrypted data', async () => {
      const sqlite3 = require('sqlite3');
      const config = require('../lib/config');

      const events = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(config.DATABASE_PATH);
        db.all(
          `SELECT metadata_json FROM audit_events WHERE action='backup_created' ORDER BY timestamp DESC LIMIT 1`,
          (err, rows) => {
            db.close();
            if (err) return reject(err);
            resolve(rows || []);
          },
        );
      });

      expect(events.length).toBeGreaterThan(0);
      const metadata = JSON.parse(events[0].metadata_json);
      const keys = Object.keys(metadata);
      expect(keys.some(k => k.toLowerCase().includes('key') && k.toLowerCase() !== 'backup_key')).toBe(false);
      expect(keys.some(k => k.toLowerCase().includes('secret'))).toBe(false);
      expect(keys.some(k => k.toLowerCase().includes('decrypt'))).toBe(false);
    });
  });

  describe('C. Destructive action audit events', () => {
    test('C1. Creating and deleting a test task produces task_deleted audit event', async () => {
      const mattersRes = await request(app)
        .get('/api/matters')
        .set('Authorization', `Bearer ${adminToken}`);
      const testMatterId = mattersRes.body[0]?.id;

      const taskRes = await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ matterId: testMatterId, title: 'R3c audit test task', completed: false });
      expect(taskRes.statusCode).toBe(200);
      const taskId = taskRes.body.id;

      const deleteRes = await request(app)
        .delete(`/api/tasks/${taskId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(deleteRes.statusCode).toBe(200);

      const sqlite3 = require('sqlite3');
      const config = require('../lib/config');

      const events = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(config.DATABASE_PATH);
        db.all(
          `SELECT * FROM audit_events WHERE action='task_deleted' AND entity_id=? ORDER BY timestamp DESC, id DESC LIMIT 1`,
          [taskId],
          (err, rows) => {
            db.close();
            if (err) return reject(err);
            resolve(rows || []);
          },
        );
      });

      expect(events.length).toBe(1);
    });

    test('C2. firm_settings_updated audit event is created when settings are updated', async () => {
      const settingsRes = await request(app)
        .put('/api/firm-settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'LexFlow Kenya', address: 'R3c audit test address' });
      expect(settingsRes.statusCode).toBe(200);

      const sqlite3 = require('sqlite3');
      const config = require('../lib/config');

      const events = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(config.DATABASE_PATH);
        db.all(
          `SELECT * FROM audit_events WHERE action='firm_settings_updated' ORDER BY timestamp DESC, id DESC LIMIT 1`,
          (err, rows) => {
            db.close();
            if (err) return reject(err);
            resolve(rows || []);
          },
        );
      });

      expect(events.length).toBeGreaterThan(0);
      const lastEvent = events[0];
      const metadata = JSON.parse(lastEvent.metadata_json);
      expect(metadata).toBeDefined();
      expect(metadata.fieldsUpdated).toBeDefined();
    });

    test('C3. Audit metadata excludes secrets, JWTs, file contents, backup keys', async () => {
      const sqlite3 = require('sqlite3');
      const config = require('../lib/config');

      const events = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(config.DATABASE_PATH);
        db.all(
          `SELECT metadata_json FROM audit_events ORDER BY timestamp DESC, id DESC LIMIT 50`,
          (err, rows) => {
            db.close();
            if (err) return reject(err);
            resolve(rows || []);
          },
        );
      });

      const forbiddenPatterns = ['backup_key', 'password123', 'token', 'jwt', 'secret', 'decrypted', 'private_key'];
      for (const event of events) {
        const metadata = JSON.parse(event.metadata_json || '{}');
        for (const key of Object.keys(metadata)) {
          const val = String(metadata[key] || '');
          for (const pattern of forbiddenPatterns) {
            expect(key.toLowerCase().includes(pattern) && val === '[REDACTED]' || !key.toLowerCase().includes(pattern)).toBe(true);
          }
        }
      }
    });
  });
});
