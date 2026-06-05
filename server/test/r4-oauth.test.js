const request = require('supertest');
const crypto = require('crypto');
const { app } = require('../server.js');
const config = require('../lib/config');
const googleOAuth = require('../lib/oauthGoogle');
const microsoftOAuth = require('../lib/oauthMicrosoft');

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
      await run("DELETE FROM oauth_accounts WHERE providerSubject LIKE 'test-subject-%'");
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

  async function withDb(work) {
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(config.DATABASE_PATH);
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
    const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
    const close = () => new Promise((resolve) => db.close(() => resolve()));
    try {
      return await work({ run, get, all });
    } finally {
      await close();
    }
  }

  async function withAllowedDomains(domains, work) {
    const original = config.OAUTH_ALLOWED_DOMAINS;
    config.OAUTH_ALLOWED_DOMAINS = domains;
    try {
      return await work();
    } finally {
      config.OAUTH_ALLOWED_DOMAINS = original;
    }
  }

  function callbackLocation(res) {
    return new URL(res.header.location);
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

    test('B6. Reusing a valid state nonce is rejected', () => {
      const { verifyState } = require('../lib/oauthState');
      const state = signState('google');
      const first = verifyState(state, 'google');
      const second = verifyState(state, 'google');
      expect(first.valid).toBe(true);
      expect(second.valid).toBe(false);
      expect(second.error).toContain('already been used');
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

    test('C4. Callback rejects inactive staff and does not issue an exchange code', async () => {
      const providerSubject = `test-subject-inactive-${Date.now()}`;
      const userId = `test-oauth-inactive-${Date.now()}`;
      const email = `inactive-oauth-${Date.now()}@lexflow.co.ke`;
      const spyGoogle = jest.spyOn(googleOAuth, 'handleCallback').mockResolvedValue({
        provider: 'google',
        providerSubject,
        email,
        emailVerified: true,
      });

      try {
        await withDb(({ run }) => run(
          'INSERT INTO users (id,email,password,fullName,role,createdAt,isActive) VALUES (?,?,?,?,?,?,?)',
          [userId, email, 'hashed', 'Inactive OAuth User', 'assistant', new Date().toISOString(), 0],
        ));

        const res = await request(app)
          .get('/api/auth/oauth/google/callback')
          .query({ code: 'inactive-code', state: signState('google') });
        expect(res.status).toBe(302);
        const url = callbackLocation(res);
        expect(url.searchParams.get('code')).toBeNull();
        expect(url.searchParams.get('error')).toBeTruthy();

        const event = await withDb(({ get }) => get(
          "SELECT metadata_json FROM audit_events WHERE action='oauth_login_failed' ORDER BY timestamp DESC LIMIT 1",
        ));
        expect(JSON.parse(event.metadata_json).reason).toBe('inactive_account');
      } finally {
        spyGoogle.mockRestore();
        await withDb(async ({ run }) => {
          await run('DELETE FROM oauth_accounts WHERE providerSubject=?', [providerSubject]);
          await run('DELETE FROM users WHERE id=?', [userId]);
        });
      }
    });
  });

  describe('D. OAuth allowed-domain policy', () => {
    test('D1. Allowed domains are normalized and accepted', async () => {
      const providerSubject = `test-subject-domain-allowed-${Date.now()}`;
      const spyGoogle = jest.spyOn(googleOAuth, 'handleCallback').mockResolvedValue({
        provider: 'google',
        providerSubject,
        email: ' Admin@LexFlow.CO.KE ',
        emailVerified: true,
      });

      try {
        await withAllowedDomains([' LexFlow.CO.KE '], async () => {
          const callbackRes = await request(app)
            .get('/api/auth/oauth/google/callback')
            .query({ code: 'domain-allowed-code', state: signState('google') });
          const url = callbackLocation(callbackRes);
          const exchangeCode = url.searchParams.get('code');
          expect(exchangeCode).toBeTruthy();

          const exchangeRes = await request(app)
            .post('/api/auth/oauth/exchange')
            .send({ code: exchangeCode });
          expect(exchangeRes.status).toBe(200);
          expect(exchangeRes.body.token).toBeDefined();
        });
      } finally {
        spyGoogle.mockRestore();
        await withDb(({ run }) => run('DELETE FROM oauth_accounts WHERE providerSubject=?', [providerSubject]));
      }
    });

    test('D2. Disallowed Google email domain is rejected', async () => {
      const providerSubject = `test-subject-domain-rejected-${Date.now()}`;
      const spyGoogle = jest.spyOn(googleOAuth, 'handleCallback').mockResolvedValue({
        provider: 'google',
        providerSubject,
        email: 'admin@example.com',
        emailVerified: true,
      });

      try {
        await withAllowedDomains(['lexflow.co.ke'], async () => {
          const res = await request(app)
            .get('/api/auth/oauth/google/callback')
            .query({ code: 'domain-rejected-code', state: signState('google') });
          const url = callbackLocation(res);
          expect(url.searchParams.get('code')).toBeNull();
          expect(url.searchParams.get('error')).toBeTruthy();
        });
      } finally {
        spyGoogle.mockRestore();
        await withDb(({ run }) => run('DELETE FROM oauth_accounts WHERE providerSubject=?', [providerSubject]));
      }
    });

    test('D3. Empty allowed-domain list preserves current behavior', async () => {
      const providerSubject = `test-subject-domain-empty-${Date.now()}`;
      const spyGoogle = jest.spyOn(googleOAuth, 'handleCallback').mockResolvedValue({
        provider: 'google',
        providerSubject,
        email: 'admin@lexflow.co.ke',
        emailVerified: true,
      });

      try {
        await withAllowedDomains(null, async () => {
          const callbackRes = await request(app)
            .get('/api/auth/oauth/google/callback')
            .query({ code: 'domain-empty-code', state: signState('google') });
          const url = callbackLocation(callbackRes);
          const exchangeCode = url.searchParams.get('code');
          expect(exchangeCode).toBeTruthy();

          const exchangeRes = await request(app)
            .post('/api/auth/oauth/exchange')
            .send({ code: exchangeCode });
          expect(exchangeRes.status).toBe(200);
        });
      } finally {
        spyGoogle.mockRestore();
        await withDb(({ run }) => run('DELETE FROM oauth_accounts WHERE providerSubject=?', [providerSubject]));
      }
    });

    test('D4. Microsoft callback uses the same allowed-domain policy', async () => {
      const providerSubject = `test-subject-ms-domain-rejected-${Date.now()}`;
      const spyMicrosoft = jest.spyOn(microsoftOAuth, 'handleCallback').mockResolvedValue({
        provider: 'microsoft',
        providerSubject,
        email: 'admin@example.com',
        emailVerified: null,
      });

      try {
        await withAllowedDomains(['lexflow.co.ke'], async () => {
          const res = await request(app)
            .get('/api/auth/oauth/microsoft/callback')
            .query({ code: 'ms-domain-rejected-code', state: signState('microsoft') });
          const url = callbackLocation(res);
          expect(url.searchParams.get('code')).toBeNull();
          expect(url.searchParams.get('error')).toBeTruthy();
        });
      } finally {
        spyMicrosoft.mockRestore();
        await withDb(({ run }) => run('DELETE FROM oauth_accounts WHERE providerSubject=?', [providerSubject]));
      }
    });
  });

  describe('E. OAuth account management', () => {
    test('E1. Staff can view own linked providers (empty)', async () => {
      const res = await request(app)
        .get('/api/auth/oauth/accounts')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('E2. Staff cannot unlink non-existent provider', async () => {
      const res = await request(app)
        .delete('/api/auth/oauth/accounts/google')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(404);
    });

    test('E3. Client cannot access OAuth accounts', async () => {
      const res = await request(app)
        .get('/api/auth/oauth/accounts')
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.statusCode).toBe(403);
    });
  });

  describe('F. OAuth user deletion cleanup', () => {
    test('F1. Deleting a user cascades to oauth_accounts', async () => {
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

  describe('G. Audit logging for OAuth', () => {
    test('G1. OAuth login started creates audit event', async () => {
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

    test('G2. OAuth login failure creates audit event', async () => {
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

    test('G3. OAuth audit metadata excludes tokens/secrets', async () => {
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

  describe('H. Microsoft verified-email semantics', () => {
    test('H1. Microsoft Graph profile does not overclaim email verification', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'test-ms-access-token' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'test-ms-profile', mail: 'admin@lexflow.co.ke' }),
        });

      try {
        const profile = await microsoftOAuth.handleCallback('ms-code');
        expect(profile.provider).toBe('microsoft');
        expect(profile.email).toBe('admin@lexflow.co.ke');
        expect(profile.emailVerified).toBeNull();
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('H2. Microsoft unknown verification is accepted but stored as unverified', async () => {
      const providerSubject = `test-subject-ms-unknown-verified-${Date.now()}`;
      const spyMicrosoft = jest.spyOn(microsoftOAuth, 'handleCallback').mockResolvedValue({
        provider: 'microsoft',
        providerSubject,
        email: 'admin@lexflow.co.ke',
        emailVerified: null,
      });

      try {
        const callbackRes = await request(app)
          .get('/api/auth/oauth/microsoft/callback')
          .query({ code: 'ms-unknown-verified-code', state: signState('microsoft') });
        const url = callbackLocation(callbackRes);
        const exchangeCode = url.searchParams.get('code');
        expect(exchangeCode).toBeTruthy();

        const exchangeRes = await request(app)
          .post('/api/auth/oauth/exchange')
          .send({ code: exchangeCode });
        expect(exchangeRes.status).toBe(200);

        const account = await withDb(({ get }) => get(
          'SELECT emailVerified FROM oauth_accounts WHERE provider=? AND providerSubject=?',
          ['microsoft', providerSubject],
        ));
        expect(account.emailVerified).toBe(0);
      } finally {
        spyMicrosoft.mockRestore();
        await withDb(({ run }) => run('DELETE FROM oauth_accounts WHERE providerSubject=?', [providerSubject]));
      }
    });
  });

  describe('I. OAuth account link conflicts', () => {
    test('I1. Provider subject linked to another staff user is rejected', async () => {
      const providerSubject = `test-subject-link-conflict-${Date.now()}`;
      const spyGoogle = jest.spyOn(googleOAuth, 'handleCallback').mockResolvedValue({
        provider: 'google',
        providerSubject,
        email: 'admin@lexflow.co.ke',
        emailVerified: true,
      });

      try {
        await withDb(async ({ get, run }) => {
          const advocate = await get('SELECT id FROM users WHERE lower(email)=lower(?)', ['sarah.mwangi@achokilaw.co.ke']);
          await run(
            'INSERT INTO oauth_accounts (id,userId,provider,providerSubject,email,emailVerified,createdAt,updatedAt,lastLoginAt) VALUES (?,?,?,?,?,?,?,?,?)',
            [`oa-conflict-${Date.now()}`, advocate.id, 'google', providerSubject, 'sarah.mwangi@achokilaw.co.ke', 1, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
          );
        });

        const res = await request(app)
          .get('/api/auth/oauth/google/callback')
          .query({ code: 'link-conflict-code', state: signState('google') });
        const url = callbackLocation(res);
        expect(url.searchParams.get('code')).toBeNull();
        expect(url.searchParams.get('error')).toBeTruthy();

        const event = await withDb(({ get }) => get(
          "SELECT metadata_json FROM audit_events WHERE action='oauth_login_failed' ORDER BY timestamp DESC LIMIT 1",
        ));
        expect(JSON.parse(event.metadata_json).reason).toBe('oauth_link_conflict');
      } finally {
        spyGoogle.mockRestore();
        await withDb(({ run }) => run('DELETE FROM oauth_accounts WHERE providerSubject=?', [providerSubject]));
      }
    });
  });

  describe('J. OAuth one-time code exchange', () => {
    let spyGoogle;
    let spyMicrosoft;

    beforeAll(async () => {
      const sqlite3 = require('sqlite3');
      const cfg = require('../lib/config');
      const db = new sqlite3.Database(cfg.DATABASE_PATH);
      await new Promise((resolve, reject) => {
        db.run("DELETE FROM oauth_accounts WHERE providerSubject LIKE 'test-subject-%'", (err) => {
          err ? reject(err) : resolve();
        });
      });
      db.close();

      spyGoogle = jest.spyOn(googleOAuth, 'handleCallback').mockResolvedValue({
        provider: 'google',
        providerSubject: 'test-subject-google',
        email: 'admin@lexflow.co.ke',
        emailVerified: true,
      });
      spyMicrosoft = jest.spyOn(microsoftOAuth, 'handleCallback').mockResolvedValue({
        provider: 'microsoft',
        providerSubject: 'test-subject-microsoft',
        email: 'admin@lexflow.co.ke',
        emailVerified: true,
      });
    });

    afterAll(() => {
      spyGoogle.mockRestore();
      spyMicrosoft.mockRestore();
    });

    test('J1. Google callback redirect uses code= not token=', async () => {
      const res = await request(app)
        .get('/api/auth/oauth/google/callback')
        .query({ code: 'any-code', state: signState('google') });
      expect(res.status).toBe(302);
      const location = res.header.location;
      expect(location).not.toContain('token=');
      expect(location).not.toContain('user=');
      expect(location).toContain('code=');
      const url = new URL(location);
      expect(url.searchParams.get('code')).toBeTruthy();
    });

    test('J2. Microsoft callback redirect uses code= not token=', async () => {
      const res = await request(app)
        .get('/api/auth/oauth/microsoft/callback')
        .query({ code: 'any-code', state: signState('microsoft') });
      expect(res.status).toBe(302);
      const location = res.header.location;
      expect(location).not.toContain('token=');
      expect(location).not.toContain('user=');
      expect(location).toContain('code=');
      const url = new URL(location);
      expect(url.searchParams.get('code')).toBeTruthy();
    });

    test('J3. Successful exchange returns token and user', async () => {
      const callbackRes = await request(app)
        .get('/api/auth/oauth/google/callback')
        .query({ code: 'g3-code', state: signState('google') });
      const url = new URL(callbackRes.header.location);
      const exchangeCode = url.searchParams.get('code');
      expect(exchangeCode).toBeTruthy();

      const exchangeRes = await request(app)
        .post('/api/auth/oauth/exchange')
        .send({ code: exchangeCode });
      expect(exchangeRes.status).toBe(200);
      expect(exchangeRes.body.token).toBeDefined();
      expect(exchangeRes.body.token).toEqual(expect.any(String));
      expect(exchangeRes.body.user).toBeDefined();
      expect(exchangeRes.body.user.email).toBe('admin@lexflow.co.ke');
    });

    test('J4. Exchange code is single-use', async () => {
      const callbackRes = await request(app)
        .get('/api/auth/oauth/google/callback')
        .query({ code: 'g4-code', state: signState('google') });
      const url = new URL(callbackRes.header.location);
      const exchangeCode = url.searchParams.get('code');

      const first = await request(app)
        .post('/api/auth/oauth/exchange')
        .send({ code: exchangeCode });
      expect(first.status).toBe(200);
      expect(first.body.token).toBeDefined();

      const second = await request(app)
        .post('/api/auth/oauth/exchange')
        .send({ code: exchangeCode });
      expect(second.status).toBe(400);
    });

    test('J5. Missing exchange code returns 400', async () => {
      const res = await request(app)
        .post('/api/auth/oauth/exchange')
        .send({});
      expect(res.status).toBe(400);
    });

    test('J6. Invalid exchange code returns 400', async () => {
      const res = await request(app)
        .post('/api/auth/oauth/exchange')
        .send({ code: 'this-code-does-not-exist-in-the-map' });
      expect(res.status).toBe(400);
    });

    test('J7. Expired exchange code returns 400', async () => {
      const callbackRes = await request(app)
        .get('/api/auth/oauth/google/callback')
        .query({ code: 'g7-exp', state: signState('google') });
      const url = new URL(callbackRes.header.location);
      const exchangeCode = url.searchParams.get('code');
      expect(exchangeCode).toBeTruthy();
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
      jest.advanceTimersByTime(61000);
      const expiredRes = await request(app)
        .post('/api/auth/oauth/exchange')
        .send({ code: exchangeCode });
      expect(expiredRes.status).toBe(400);
      jest.useRealTimers();
    });

    test('J8. Replayed callback state does not issue a second exchange code', async () => {
      const state = signState('google');
      const firstRes = await request(app)
        .get('/api/auth/oauth/google/callback')
        .query({ code: 'j8-code-1', state });
      const firstUrl = callbackLocation(firstRes);
      const firstCode = firstUrl.searchParams.get('code');
      expect(firstCode).toBeTruthy();

      const exchangeRes = await request(app)
        .post('/api/auth/oauth/exchange')
        .send({ code: firstCode });
      expect(exchangeRes.status).toBe(200);

      const replayRes = await request(app)
        .get('/api/auth/oauth/google/callback')
        .query({ code: 'j8-code-2', state });
      const replayUrl = callbackLocation(replayRes);
      expect(replayUrl.searchParams.get('code')).toBeNull();
      expect(replayUrl.searchParams.get('error')).toBeTruthy();
    });
  });
});
