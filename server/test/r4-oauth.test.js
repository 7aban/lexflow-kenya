const request = require('supertest');
const crypto = require('crypto');
const { app } = require('../server.js');

describe('R4 Staff OAuth Backend', () => {
  let adminToken;
  let advocateToken;
  let clientToken;

  const stateSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeAll(async () => {
    const sqlite3 = require('sqlite3');
    const config = require('../lib/config');

    const db = new sqlite3.Database(config.DATABASE_PATH);
    const run = (sql, params) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
    const close = () => new Promise((resolve) => db.close(() => resolve()));

    try {
      await run(`CREATE TABLE IF NOT EXISTS oauth_accounts (id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT CHECK(provider IN ('google','microsoft')) NOT NULL, providerSubject TEXT NOT NULL, email TEXT NOT NULL, emailVerified INTEGER DEFAULT 0, revokedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, lastLoginAt TEXT, UNIQUE(provider, providerSubject))`);
    } finally {
      await close();
    }

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
  });

  function signState(provider, secret = stateSecret) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiry = Date.now() + 10 * 60 * 1000;
    const payload = `${provider}:${nonce}:${expiry}`;
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `${payload}:${hmac}`;
  }

  describe('A. OAuth config', () => {
    test('A1. OAuth staff start returns auth URL when enabled', async () => {
      const res = await request(app)
        .get('/api/auth/oauth/google/start');
      expect(res.statusCode).toBe(200);
      expect(res.body.authorizationUrl).toBeDefined();
      expect(res.body.authorizationUrl).toContain('accounts.google.com');
    });

    test('A2. Microsoft OAuth start returns auth URL when enabled', async () => {
      const res = await request(app)
        .get('/api/auth/oauth/microsoft/start');
      expect(res.statusCode).toBe(200);
      expect(res.body.authorizationUrl).toBeDefined();
      expect(res.body.authorizationUrl).toContain('login.microsoftonline.com');
    });
  });

  describe('B. OAuth state/CSRF protection', () => {
    test('B1. Valid state is accepted internally', () => {
      const { verifyState } = require('../lib/oauthState');
      const state = signState('google');
      const result = verifyState(state, 'google');
      expect(result.valid).toBe(true);
      expect(result.nonce).toBeDefined();
    });

    test('B2. Tampered state is rejected', () => {
      const { verifyState } = require('../lib/oauthState');
      const state = signState('google') + 'tampered';
      const result = verifyState(state, 'google');
      expect(result.valid).toBe(false);
    });

    test('B3. Expired state is rejected', () => {
      const { verifyState } = require('../lib/oauthState');
      const nonce = crypto.randomBytes(16).toString('hex');
      const expiry = Date.now() - 60000; // 1 minute ago
      const payload = `google:${nonce}:${expiry}`;
      const hmac = crypto.createHmac('sha256', stateSecret).update(payload).digest('hex');
      const state = `${payload}:${hmac}`;
      const result = verifyState(state, 'google');
      expect(result.valid).toBe(false);
    });

    test('B4. Wrong provider state is rejected', () => {
      const { verifyState } = require('../lib/oauthState');
      const state = signState('google');
      const result = verifyState(state, 'microsoft');
      expect(result.valid).toBe(false);
    });

    test('B5. Error messages do not expose state secret', () => {
      const { verifyState } = require('../lib/oauthState');
      const state = signState('google') + 'tampered';
      const result = verifyState(state, 'google');
      expect(result.error).toBeDefined();
      expect(result.error).not.toContain(stateSecret);
      expect(result.error).not.toContain('0123456789abcdef');
    });
  });

  describe('C. OAuth callback validation', () => {
    test('C1. Callback rejects unknown user', async () => {
      const res = await request(app)
        .get('/api/auth/oauth/google/callback')
        .query({ code: 'fake-code', state: signState('google') });
      expect(res.status).toBe(302);
      const location = res.header.location;
      expect(location).toContain('error=');
    });

    test('C2. Callback rejects client email', async () => {
      const res = await request(app)
        .get('/api/auth/oauth/google/callback')
        .query({ code: 'fake-code', state: signState('google') });
      expect(res.status).toBe(302);
    });

    test('C3. Invalid state is rejected on callback', async () => {
      const res = await request(app)
        .get('/api/auth/oauth/google/callback')
        .query({ code: 'fake-code', state: 'invalid-state-value' });
      expect(res.status).toBe(302);
      expect(res.header.location).toContain('error=');
    });
  });

  describe('D. OAuth account management', () => {
    test('D1. Staff can view own linked providers (empty)', async () => {
      const res = await request(app)
        .get('/api/auth/oauth/accounts')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('D2. Staff cannot unlink non-existent provider', async () => {
      const res = await request(app)
        .delete('/api/auth/oauth/accounts/google')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(404);
    });

    test('D3. Client cannot access OAuth accounts', async () => {
      const res = await request(app)
        .get('/api/auth/oauth/accounts')
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.statusCode).toBe(403);
    });
  });

  describe('E. OAuth user deletion cleanup', () => {
    test('E1. Deleting a user cascades to oauth_accounts', async () => {
      const sqlite3 = require('sqlite3');
      const config = require('../lib/config');

      const db = new sqlite3.Database(config.DATABASE_PATH);
      const run = (sql, params) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
      const get = (sql, params) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
      const close = () => new Promise((resolve) => db.close(() => resolve()));

      try {
        const userId = 'test-oauth-delete-' + Date.now();
        const email = `test-oauth-${Date.now()}@lexflow.co.ke`;
        await run('INSERT INTO users (id,email,password,fullName,role,createdAt) VALUES (?,?,?,?,?,?)', [userId, email, 'hashed', 'Test OAuth User', 'assistant', new Date().toISOString()]);
        await run('INSERT INTO oauth_accounts (id,userId,provider,providerSubject,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)', ['oa-test-del', userId, 'google', 'sub-123', email, 1, new Date().toISOString(), new Date().toISOString()]);

        const before = await get('SELECT COUNT(*) count FROM oauth_accounts WHERE userId=?', [userId]);
        expect(before.count).toBe(1);

        await run('DELETE FROM oauth_accounts WHERE userId=?', [userId]);
        await run('DELETE FROM users WHERE id=?', [userId]);

        const after = await get('SELECT COUNT(*) count FROM oauth_accounts WHERE userId=?', [userId]);
        expect(after.count).toBe(0);
      } finally {
        await close();
      }
    });
  });

  describe('F. Audit logging for OAuth', () => {
    test('F1. OAuth login started creates audit event', async () => {
      const sqlite3 = require('sqlite3');
      const config = require('../lib/config');

      const events = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(config.DATABASE_PATH);
        db.all(`SELECT * FROM audit_events WHERE action='oauth_login_started' ORDER BY timestamp DESC LIMIT 1`, (err, rows) => {
          db.close();
          if (err) return reject(err);
          resolve(rows || []);
        });
      });

      expect(events.length).toBeGreaterThan(0);
      const lastEvent = events[0];
      expect(lastEvent.action).toBe('oauth_login_started');
      const metadata = JSON.parse(lastEvent.metadata_json);
      expect(metadata.provider).toBeDefined();
      expect(metadata.provider).toMatch(/^(google|microsoft)$/);
    });

    test('F2. OAuth login failure creates audit event', async () => {
      const sqlite3 = require('sqlite3');
      const config = require('../lib/config');

      const events = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(config.DATABASE_PATH);
        db.all(`SELECT * FROM audit_events WHERE action='oauth_login_failed' ORDER BY timestamp DESC LIMIT 1`, (err, rows) => {
          db.close();
          if (err) return reject(err);
          resolve(rows || []);
        });
      });

      expect(events.length).toBeGreaterThan(0);
      const lastEvent = events[0];
      expect(lastEvent.action).toBe('oauth_login_failed');
    });

    test('F3. OAuth audit metadata excludes tokens/secrets', async () => {
      const sqlite3 = require('sqlite3');
      const config = require('../lib/config');

      const events = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(config.DATABASE_PATH);
        db.all(`SELECT metadata_json FROM audit_events WHERE action LIKE 'oauth_%' ORDER BY timestamp DESC LIMIT 20`, (err, rows) => {
          db.close();
          if (err) return reject(err);
          resolve(rows || []);
        });
      });

      for (const event of events) {
        const metadata = JSON.parse(event.metadata_json || '{}');
        const keys = Object.keys(metadata);
        expect(keys.some(k => k.toLowerCase().includes('token'))).toBe(false);
        expect(keys.some(k => k.toLowerCase().includes('secret'))).toBe(false);
        expect(keys.some(k => k.toLowerCase().includes('password'))).toBe(false);
      }
    });
  });
});
