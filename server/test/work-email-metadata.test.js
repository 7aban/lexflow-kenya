const request = require('supertest');
const sqlite3 = require('sqlite3');
const { app, dbReady } = require('../server.js');
const config = require('../lib/config');
const googleOAuth = require('../lib/oauthGoogle');

describe('Work Email Metadata Sync', () => {
  let adminToken;
  let advocateToken;
  let clientToken;
  const rawAccessToken = 'raw-work-email-access-token-25d';
  const rawRefreshToken = 'raw-work-email-refresh-token-25d';
  const clientId = 'test-work-email-client-25d';
  const matterId = 'test-work-email-matter-25d';
  const matterReference = 'LEX-WORK-25D-001';

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

  async function cleanup() {
    await withDb(async ({ run }) => {
      await run(`DELETE FROM work_email_messages WHERE connectedAccountId IN (
        SELECT id FROM connected_accounts WHERE providerAccountId LIKE 'test-work-email-%' OR email LIKE 'work-email-25d-%'
      )`);
      await run(`DELETE FROM connected_account_sync_state WHERE connectedAccountId IN (
        SELECT id FROM connected_accounts WHERE providerAccountId LIKE 'test-work-email-%' OR email LIKE 'work-email-25d-%'
      )`);
      await run(`DELETE FROM connected_account_tokens WHERE connectedAccountId IN (
        SELECT id FROM connected_accounts WHERE providerAccountId LIKE 'test-work-email-%' OR email LIKE 'work-email-25d-%'
      )`);
      await run("DELETE FROM connected_accounts WHERE providerAccountId LIKE 'test-work-email-%' OR email LIKE 'work-email-25d-%'");
      await run("DELETE FROM matters WHERE id=?", [matterId]);
      await run("DELETE FROM clients WHERE id=?", [clientId]);
    });
  }

  async function seedMatter() {
    await withDb(async ({ run }) => {
      await run('INSERT INTO clients (id,name,type,email,status,joinDate) VALUES (?,?,?,?,?,?)', [clientId, 'Work Email Client', 'Corporate', 'legal@workemailclient.co.ke', 'Active', '2026-06-05']);
      await run('INSERT INTO matters (id,reference,clientId,title,practiceArea,stage,assignedTo,openDate,caseNo) VALUES (?,?,?,?,?,?,?,?,?)', [matterId, matterReference, clientId, 'Work Email Contract Review', 'Commercial', 'Active', 'Sarah Mwangi', '2026-06-05', 'COMM-25D-001']);
    });
  }

  async function authToken(path, email, password = 'password123') {
    const res = await request(app).post(path).send({ email, password });
    expect(res.statusCode).toBe(200);
    return res.body.token;
  }

  async function startProvider(provider, token) {
    const res = await request(app)
      .post(`/api/connected-accounts/${provider}/start`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    return new URL(res.body.authorizationUrl).searchParams.get('state');
  }

  async function connectGoogle({ token = adminToken, providerAccountId, email }) {
    const spyGoogle = jest.spyOn(googleOAuth, 'handleConnectedCallback').mockResolvedValue({
      provider: 'google',
      providerAccountId,
      email,
      displayName: 'Work Email Account',
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
        .query({ code: 'test-work-email-google-code', state });
      expect(res.statusCode).toBe(302);
      expect(res.header.location).toContain('connected_account=connected');
      const account = await withDb(({ get }) => get('SELECT * FROM connected_accounts WHERE providerAccountId=?', [providerAccountId]));
      expect(account).toBeTruthy();
      return account;
    } finally {
      spyGoogle.mockRestore();
    }
  }

  function providerMessage(overrides = {}) {
    return {
      providerMessageId: `provider-message-${Date.now()}-${Math.random()}`,
      providerThreadId: 'thread-25d',
      sender: 'legal@workemailclient.co.ke',
      recipientsSummary: 'admin@lexflow.co.ke',
      subject: `Update on ${matterReference}`,
      snippet: 'Metadata preview only for the matching matter.',
      receivedAt: '2026-06-05T08:30:00.000Z',
      hasAttachments: true,
      labels: ['INBOX'],
      folders: ['INBOX'],
      body: 'email body text must not be stored',
      attachmentContent: 'attachment bytes must not be stored',
      ...overrides,
    };
  }

  async function syncAccount(accountId, messages, token = adminToken) {
    const spy = jest.spyOn(googleOAuth, 'fetchEmailMetadata').mockResolvedValueOnce({ messages, cursor: 'next-page-token-25d' });
    const res = await request(app)
      .post(`/api/connected-accounts/${accountId}/sync-email-metadata`)
      .set('Authorization', `Bearer ${token}`);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    return res;
  }

  beforeAll(async () => {
    await dbReady;
    await cleanup();
    await seedMatter();
    adminToken = await authToken('/api/auth/login', 'admin@lexflow.co.ke');
    advocateToken = await authToken('/api/auth/login', 'sarah.mwangi@achokilaw.co.ke');
    clientToken = await authToken('/api/auth/client-login', 'margaret.wairimu@example.co.ke');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup();
  });

  test('staff can sync metadata for own connected account', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-own', email: 'work-email-25d-own@example.test' });
    const res = await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-own-message' })]);
    expect(res.statusCode).toBe(200);
    expect(res.body.importedCount).toBe(1);
    expect(res.body.totalMessages).toBeGreaterThanOrEqual(1);
    expect(res.body.lastSuccessAt).toBeTruthy();
  });

  test('client cannot sync', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-client-denied', email: 'work-email-25d-client-denied@example.test' });
    const res = await request(app)
      .post(`/api/connected-accounts/${account.id}/sync-email-metadata`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('disconnected account cannot sync', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-disconnected', email: 'work-email-25d-disconnected@example.test' });
    await request(app)
      .post(`/api/connected-accounts/${account.id}/disconnect`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const res = await request(app)
      .post(`/api/connected-accounts/${account.id}/sync-email-metadata`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(400);
  });

  test("user cannot sync another user's account", async () => {
    const account = await connectGoogle({ token: advocateToken, providerAccountId: 'test-work-email-advocate-owned', email: 'work-email-25d-advocate@example.test' });
    const res = await request(app)
      .post(`/api/connected-accounts/${account.id}/sync-email-metadata`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(404);
  });

  test('provider client is mocked and no real provider call is made', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-mocked-provider', email: 'work-email-25d-mocked@example.test' });
    const fetchSpy = global.fetch ? jest.spyOn(global, 'fetch') : null;
    const res = await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-mocked-message' })]);
    expect(res.statusCode).toBe(200);
    if (fetchSpy) expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('raw and encrypted token values are not returned by sync, list, or matches', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-token-safe', email: 'work-email-25d-token-safe@example.test' });
    const syncRes = await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-token-safe-message' })]);
    const listRes = await request(app).get('/api/work-email/messages').set('Authorization', `Bearer ${adminToken}`);
    const message = listRes.body.find(row => row.providerMessageId === 'work-email-token-safe-message');
    const matchesRes = await request(app).get(`/api/work-email/messages/${message.id}/matches`).set('Authorization', `Bearer ${adminToken}`);
    const tokenRow = await withDb(({ get }) => get('SELECT * FROM connected_account_tokens WHERE connectedAccountId=?', [account.id]));
    const payload = JSON.stringify([syncRes.body, listRes.body, matchesRes.body]);
    expect(payload).not.toContain(rawAccessToken);
    expect(payload).not.toContain(rawRefreshToken);
    expect(payload).not.toContain(tokenRow.accessTokenEncrypted);
    expect(payload).not.toContain(tokenRow.refreshTokenEncrypted);
    expect(payload.toLowerCase()).not.toContain('accesstoken');
    expect(payload.toLowerCase()).not.toContain('refreshtoken');
    expect(payload.toLowerCase()).not.toContain('encrypted');
  });

  test('metadata is stored without body or attachment content fields', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-metadata-only', email: 'work-email-25d-metadata-only@example.test' });
    await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-metadata-only-message' })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_email_messages WHERE connectedAccountId=? AND providerMessageId=?', [account.id, 'work-email-metadata-only-message']));
    expect(row).toBeTruthy();
    expect(row.subject).toBeTruthy();
    expect(row.hasAttachments).toBe(1);
    expect(Object.keys(row)).not.toContain('body');
    expect(Object.keys(row)).not.toContain('attachmentContent');
    expect(JSON.stringify(row)).not.toContain('email body text must not be stored');
    expect(JSON.stringify(row)).not.toContain('attachment bytes must not be stored');
  });

  test('duplicate providerMessageId upserts rather than duplicates', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-upsert', email: 'work-email-25d-upsert@example.test' });
    await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-upsert-message', subject: 'First subject' })]);
    const res = await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-upsert-message', subject: 'Updated subject' })]);
    expect(res.statusCode).toBe(200);
    expect(res.body.updatedCount).toBe(1);
    const row = await withDb(({ get }) => get('SELECT COUNT(*) count, MAX(subject) subject FROM work_email_messages WHERE connectedAccountId=? AND providerMessageId=?', [account.id, 'work-email-upsert-message']));
    expect(row.count).toBe(1);
    expect(row.subject).toBe('Updated subject');
  });

  test('sync state is created and updated', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-sync-state', email: 'work-email-25d-sync-state@example.test' });
    await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-sync-state-message' })]);
    const state = await withDb(({ get }) => get('SELECT * FROM connected_account_sync_state WHERE connectedAccountId=? AND syncType=?', [account.id, 'email_metadata']));
    expect(state).toBeTruthy();
    expect(state.lastAttemptAt).toBeTruthy();
    expect(state.lastSuccessAt).toBeTruthy();
    expect(state.lastImportedCount).toBe(1);
  });

  test('work email list is staff-only and owner-scoped', async () => {
    const adminAccount = await connectGoogle({ providerAccountId: 'test-work-email-list-admin', email: 'work-email-25d-list-admin@example.test' });
    const advocateAccount = await connectGoogle({ token: advocateToken, providerAccountId: 'test-work-email-list-advocate', email: 'work-email-25d-list-advocate@example.test' });
    await syncAccount(adminAccount.id, [providerMessage({ providerMessageId: 'work-email-list-admin-message' })], adminToken);
    await syncAccount(advocateAccount.id, [providerMessage({ providerMessageId: 'work-email-list-advocate-message' })], advocateToken);
    const clientRes = await request(app).get('/api/work-email/messages').set('Authorization', `Bearer ${clientToken}`);
    expect(clientRes.statusCode).toBe(403);
    const adminRes = await request(app).get('/api/work-email/messages').set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.body.some(row => row.providerMessageId === 'work-email-list-admin-message')).toBe(true);
    expect(adminRes.body.some(row => row.providerMessageId === 'work-email-list-advocate-message')).toBe(false);
  });

  test('matter-match suggestions are generated but not auto-filed', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-match', email: 'work-email-25d-match@example.test' });
    const beforeDocs = await withDb(({ get }) => get('SELECT COUNT(*) count FROM documents WHERE matterId=?', [matterId]));
    await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-match-message', subject: `Please review ${matterReference}` })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_email_messages WHERE connectedAccountId=? AND providerMessageId=?', [account.id, 'work-email-match-message']));
    expect(row.matchedMatterId).toBe(matterId);
    expect(row.matchConfidence).toBeGreaterThan(0.5);
    const matchesRes = await request(app).get(`/api/work-email/messages/${row.id}/matches`).set('Authorization', `Bearer ${adminToken}`);
    expect(matchesRes.statusCode).toBe(200);
    expect(matchesRes.body[0].matterId).toBe(matterId);
    const afterDocs = await withDb(({ get }) => get('SELECT COUNT(*) count FROM documents WHERE matterId=?', [matterId]));
    expect(afterDocs.count).toBe(beforeDocs.count);
  });

  test('audit events are recorded without sensitive metadata', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-audit', email: 'work-email-25d-audit@example.test' });
    await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-audit-message' })]);
    const rows = await withDb(({ all }) => all(
      `SELECT action, metadata_json FROM audit_events
       WHERE action IN ('work_email_sync_started','work_email_sync_completed','work_email_sync_failed','work_email_metadata_imported','work_email_match_suggested')
       ORDER BY timestamp DESC LIMIT 30`,
    ));
    const actions = rows.map(row => row.action);
    expect(actions).toContain('work_email_sync_started');
    expect(actions).toContain('work_email_sync_completed');
    expect(actions).toContain('work_email_metadata_imported');
    expect(actions).toContain('work_email_match_suggested');
    for (const row of rows) {
      const metadata = JSON.stringify(JSON.parse(row.metadata_json || '{}')).toLowerCase();
      expect(metadata).not.toContain(rawAccessToken.toLowerCase());
      expect(metadata).not.toContain(rawRefreshToken.toLowerCase());
      expect(metadata).not.toContain('access_token');
      expect(metadata).not.toContain('refresh_token');
      expect(metadata).not.toContain('encrypted');
      expect(metadata).not.toContain('cursor');
      expect(metadata).not.toContain('email body');
      expect(metadata).not.toContain('attachment bytes');
    }
  });
});
