const request = require('supertest');
const sqlite3 = require('sqlite3');
const { app, dbReady } = require('../server.js');
const config = require('../lib/config');
const googleOAuth = require('../lib/oauthGoogle');
const microsoftOAuth = require('../lib/oauthMicrosoft');

describe('Connected Accounts Foundation', () => {
  let adminToken;
  let advocateToken;
  let clientToken;
  let primaryAccountId;
  let advocateAccountId;
  const rawAccessToken = 'raw-google-access-token-connected-25c';
  const rawRefreshToken = 'raw-google-refresh-token-connected-25c';

  async function withDb(work) {
    const db = new sqlite3.Database(config.DATABASE_PATH);
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
    const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
    const close = () => new Promise(resolve => db.close(() => resolve()));
    try {
      return await work({ run, get, all });
    } finally {
      await close();
    }
  }

  async function cleanupConnectedAccounts() {
    await withDb(async ({ run }) => {
      await run(`DELETE FROM connected_account_tokens WHERE connectedAccountId IN (
        SELECT id FROM connected_accounts WHERE providerAccountId LIKE 'test-connected-%' OR email LIKE 'connected-25c-%'
      )`);
      await run("DELETE FROM connected_accounts WHERE providerAccountId LIKE 'test-connected-%' OR email LIKE 'connected-25c-%'");
    });
  }

  async function authToken(path, email, password = 'password123') {
    const res = await request(app).post(path).send({ email, password });
    expect(res.statusCode).toBe(200);
    return res.body.token;
  }

  async function startProvider(provider, token = adminToken) {
    const res = await request(app)
      .post(`/api/connected-accounts/${provider}/start`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.authorizationUrl).toBeTruthy();
    return new URL(res.body.authorizationUrl).searchParams.get('state');
  }

  async function connectGoogle({ token = adminToken, providerAccountId, email = 'connected-25c-google@example.test' }) {
    const spyGoogle = jest.spyOn(googleOAuth, 'handleConnectedCallback').mockResolvedValue({
      provider: 'google',
      providerAccountId,
      email,
      displayName: 'Google Connected Account',
      scopes: googleOAuth.GOOGLE_CONNECTED_SCOPES,
      tokens: {
        accessToken: rawAccessToken,
        refreshToken: rawRefreshToken,
        tokenType: 'Bearer',
        expiresAt: '2030-01-01T00:00:00.000Z',
        scope: googleOAuth.GOOGLE_CONNECTED_SCOPES,
      },
    });
    try {
      const state = await startProvider('google', token);
      const res = await request(app)
        .get('/api/connected-accounts/google/callback')
        .query({ code: 'test-connected-google-code', state });
      expect(res.statusCode).toBe(302);
      expect(res.header.location).toContain('connected_account=connected');
      expect(res.header.location).not.toContain(rawAccessToken);
      expect(res.header.location).not.toContain(rawRefreshToken);
      const account = await withDb(({ get }) => get('SELECT * FROM connected_accounts WHERE providerAccountId=?', [providerAccountId]));
      expect(account).toBeTruthy();
      return account;
    } finally {
      spyGoogle.mockRestore();
    }
  }

  beforeAll(async () => {
    await dbReady;
    await cleanupConnectedAccounts();
    adminToken = await authToken('/api/auth/login', 'admin@lexflow.co.ke');
    advocateToken = await authToken('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    clientToken = await authToken('/api/auth/client-login', 'margaret.wairimu@example.co.ke');
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await cleanupConnectedAccounts();
  });

  test('staff can list connected accounts and response excludes token fields', async () => {
    const res = await request(app)
      .get('/api/connected-accounts')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const account of res.body) {
      expect(Object.keys(account).some(key => key.toLowerCase().includes('token'))).toBe(false);
      expect(Object.keys(account).some(key => key.toLowerCase().includes('encrypted'))).toBe(false);
    }
  });

  test('client cannot list connected accounts', async () => {
    const res = await request(app)
      .get('/api/connected-accounts')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('staff can start Google connected-account OAuth and receives authorizationUrl', async () => {
    const res = await request(app)
      .post('/api/connected-accounts/google/start')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.authorizationUrl).toContain('accounts.google.com');
    expect(new URL(res.body.authorizationUrl).searchParams.get('redirect_uri')).toBe('http://localhost:5000/api/connected-accounts/google/callback');
  });

  test('staff can start Microsoft connected-account OAuth and receives authorizationUrl', async () => {
    const res = await request(app)
      .post('/api/connected-accounts/microsoft/start')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.authorizationUrl).toContain('login.microsoftonline.com');
    expect(new URL(res.body.authorizationUrl).searchParams.get('redirect_uri')).toBe('http://localhost:5000/api/connected-accounts/microsoft/callback');
  });

  test('unsupported provider is rejected', async () => {
    const res = await request(app)
      .post('/api/connected-accounts/dropbox/start')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(400);
  });

  test('callback stores connected account metadata and encrypted tokens', async () => {
    const account = await connectGoogle({
      providerAccountId: 'test-connected-primary',
      email: 'connected-25c-primary@example.test',
    });
    primaryAccountId = account.id;
    expect(account.provider).toBe('google');
    expect(account.email).toBe('connected-25c-primary@example.test');
    expect(account.status).toBe('connected');
    const tokenRow = await withDb(({ get }) => get('SELECT * FROM connected_account_tokens WHERE connectedAccountId=?', [primaryAccountId]));
    expect(tokenRow).toBeTruthy();
    expect(tokenRow.accessTokenEncrypted).toMatch(/^v1:/);
    expect(tokenRow.refreshTokenEncrypted).toMatch(/^v1:/);
  });

  test('raw access and refresh tokens are not stored in plaintext', async () => {
    const tokenRow = await withDb(({ get }) => get('SELECT * FROM connected_account_tokens WHERE connectedAccountId=?', [primaryAccountId]));
    expect(tokenRow.accessTokenEncrypted).not.toBe(rawAccessToken);
    expect(tokenRow.refreshTokenEncrypted).not.toBe(rawRefreshToken);
    expect(tokenRow.accessTokenEncrypted).not.toContain(rawAccessToken);
    expect(tokenRow.refreshTokenEncrypted).not.toContain(rawRefreshToken);
  });

  test('list endpoint does not expose encrypted token fields', async () => {
    const res = await request(app)
      .get('/api/connected-accounts')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    const account = res.body.find(row => row.id === primaryAccountId);
    expect(account).toBeTruthy();
    expect(JSON.stringify(account)).not.toContain('accessTokenEncrypted');
    expect(JSON.stringify(account)).not.toContain('refreshTokenEncrypted');
    expect(JSON.stringify(account)).not.toContain(rawAccessToken);
    expect(JSON.stringify(account)).not.toContain(rawRefreshToken);
  });

  test('disconnect marks account disconnected and does not hard delete', async () => {
    const res = await request(app)
      .post(`/api/connected-accounts/${primaryAccountId}/disconnect`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('disconnected');
    expect(res.body.disconnectedAt).toBeTruthy();
    const account = await withDb(({ get }) => get('SELECT * FROM connected_accounts WHERE id=?', [primaryAccountId]));
    const tokenRow = await withDb(({ get }) => get('SELECT * FROM connected_account_tokens WHERE connectedAccountId=?', [primaryAccountId]));
    expect(account).toBeTruthy();
    expect(account.status).toBe('disconnected');
    expect(tokenRow).toBeTruthy();
  });

  test("user cannot disconnect another user's connected account", async () => {
    const account = await connectGoogle({
      token: advocateToken,
      providerAccountId: 'test-connected-advocate',
      email: 'connected-25c-advocate@example.test',
    });
    advocateAccountId = account.id;

    const res = await request(app)
      .post(`/api/connected-accounts/${advocateAccountId}/disconnect`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(404);

    const stored = await withDb(({ get }) => get('SELECT status FROM connected_accounts WHERE id=?', [advocateAccountId]));
    expect(stored.status).toBe('connected');
  });

  test('audit events are recorded for connect, disconnect, and failure without token metadata', async () => {
    const rows = await withDb(({ all }) => all(
      `SELECT action, metadata_json FROM audit_events
       WHERE action IN ('connected_account_connected','connected_account_disconnected','connected_account_failed')
       ORDER BY timestamp DESC LIMIT 20`,
    ));
    const actions = rows.map(row => row.action);
    expect(actions).toContain('connected_account_connected');
    expect(actions).toContain('connected_account_disconnected');
    expect(actions).toContain('connected_account_failed');
    for (const row of rows) {
      const metadata = JSON.stringify(JSON.parse(row.metadata_json || '{}'));
      expect(metadata).not.toContain(rawAccessToken);
      expect(metadata).not.toContain(rawRefreshToken);
      expect(metadata.toLowerCase()).not.toContain('access_token');
      expect(metadata.toLowerCase()).not.toContain('refresh_token');
      expect(metadata.toLowerCase()).not.toContain('secret');
    }
  });
});
