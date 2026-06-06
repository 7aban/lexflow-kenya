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
  const overrideClientId = 'test-work-email-client-25f-override';
  const overrideMatterId = 'test-work-email-matter-25f-override';
  const inaccessibleClientId = 'test-work-email-client-25f-inaccessible';
  const inaccessibleMatterId = 'test-work-email-matter-25f-inaccessible';

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
      await run(`DELETE FROM work_metadata_matter_links WHERE sourceType='email' AND (
        sourceId IN (
          SELECT id FROM work_email_messages WHERE connectedAccountId IN (
            SELECT id FROM connected_accounts WHERE providerAccountId LIKE 'test-work-email-%' OR email LIKE 'work-email-25d-%'
          )
        )
        OR matterId IN (?,?,?)
      )`, [matterId, overrideMatterId, inaccessibleMatterId]);
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
      await run("DELETE FROM matters WHERE id IN (?,?,?)", [matterId, overrideMatterId, inaccessibleMatterId]);
      await run("DELETE FROM clients WHERE id IN (?,?,?)", [clientId, overrideClientId, inaccessibleClientId]);
    });
  }

  async function seedMatter() {
    await withDb(async ({ run }) => {
      await run('INSERT INTO clients (id,name,type,email,status,joinDate) VALUES (?,?,?,?,?,?)', [clientId, 'Work Email Client', 'Corporate', 'legal@workemailclient.co.ke', 'Active', '2026-06-05']);
      await run('INSERT INTO matters (id,reference,clientId,title,practiceArea,stage,assignedTo,openDate,caseNo) VALUES (?,?,?,?,?,?,?,?,?)', [matterId, matterReference, clientId, 'Work Email Contract Review', 'Commercial', 'Active', 'Sarah Mwangi', '2026-06-05', 'COMM-25D-001']);
      await run('INSERT INTO clients (id,name,type,email,status,joinDate) VALUES (?,?,?,?,?,?)', [overrideClientId, 'Work Email Override Client', 'Corporate', 'override@workemailclient.co.ke', 'Active', '2026-06-05']);
      await run('INSERT INTO matters (id,reference,clientId,title,practiceArea,stage,assignedTo,openDate,caseNo) VALUES (?,?,?,?,?,?,?,?,?)', [overrideMatterId, 'LEX-WORK-25F-OVERRIDE', overrideClientId, 'Work Email Override Matter', 'Commercial', 'Active', 'Sarah Mwangi', '2026-06-05', 'COMM-25F-OVERRIDE']);
      await run('INSERT INTO clients (id,name,type,email,status,joinDate) VALUES (?,?,?,?,?,?)', [inaccessibleClientId, 'Work Email Inaccessible Client', 'Corporate', 'inaccessible@workemailclient.co.ke', 'Active', '2026-06-05']);
      await run('INSERT INTO matters (id,reference,clientId,title,practiceArea,stage,assignedTo,openDate,caseNo) VALUES (?,?,?,?,?,?,?,?,?)', [inaccessibleMatterId, 'LEX-WORK-25F-DENIED', inaccessibleClientId, 'Work Email Inaccessible Matter', 'Commercial', 'Active', 'Other Advocate', '2026-06-05', 'COMM-25F-DENIED']);
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

  async function sideEffectCounts() {
    return withDb(async ({ get }) => {
      const ids = [matterId, overrideMatterId, inaccessibleMatterId];
      const docs = await get('SELECT COUNT(*) count FROM documents WHERE matterId IN (?,?,?)', ids);
      const deadlines = await get('SELECT COUNT(*) count FROM deadlines WHERE matterId IN (?,?,?)', ids);
      const appearances = await get('SELECT COUNT(*) count FROM appearances WHERE matterId IN (?,?,?)', ids);
      const tasks = await get('SELECT COUNT(*) count FROM tasks WHERE matterId IN (?,?,?)', ids);
      const activity = await get('SELECT COUNT(*) count FROM client_activity WHERE matterId IN (?,?,?)', ids);
      return {
        documents: docs.count,
        deadlines: deadlines.count,
        appearances: appearances.count,
        tasks: tasks.count,
        clientActivity: activity.count,
      };
    });
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

  test('staff can confirm suggested email match', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-confirm-suggested', email: 'work-email-25d-confirm-suggested@example.test' });
    await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-confirm-suggested-message', subject: `Please review ${matterReference}` })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_email_messages WHERE connectedAccountId=? AND providerMessageId=?', [account.id, 'work-email-confirm-suggested-message']));
    const res = await request(app)
      .post(`/api/work-email/messages/${row.id}/confirm-matter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.statusCode).toBe(200);
    expect(res.body.confirmedMatterId).toBe(matterId);
    expect(res.body.confirmedMatterTitle).toBeTruthy();
    expect(res.body.confirmationStatus).toBe('confirmed');
    expect(res.body.confirmationSource).toBe('suggested');
    const links = await withDb(({ all }) => all('SELECT * FROM work_metadata_matter_links WHERE sourceType=? AND sourceId=?', ['email', row.id]));
    expect(links.filter(link => link.status === 'confirmed')).toHaveLength(1);
    expect(links[0].matterId).toBe(matterId);
  });

  test('staff can override email match to another accessible matter', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-confirm-override', email: 'work-email-25d-confirm-override@example.test' });
    await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-confirm-override-message', subject: `Please review ${matterReference}` })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_email_messages WHERE connectedAccountId=? AND providerMessageId=?', [account.id, 'work-email-confirm-override-message']));
    const res = await request(app)
      .post(`/api/work-email/messages/${row.id}/confirm-matter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId: overrideMatterId });
    expect(res.statusCode).toBe(200);
    expect(res.body.matchedMatterId).toBe(matterId);
    expect(res.body.confirmedMatterId).toBe(overrideMatterId);
    expect(res.body.confirmationSource).toBe('manual_override');
  });

  test('staff can unlink confirmed email match', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-unlink', email: 'work-email-25d-unlink@example.test' });
    await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-unlink-message', subject: `Please review ${matterReference}` })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_email_messages WHERE connectedAccountId=? AND providerMessageId=?', [account.id, 'work-email-unlink-message']));
    await request(app)
      .post(`/api/work-email/messages/${row.id}/confirm-matter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);
    const res = await request(app)
      .post(`/api/work-email/messages/${row.id}/unlink-matter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.statusCode).toBe(200);
    expect(res.body.confirmedMatterId).toBe('');
    expect(res.body.confirmationStatus).toBe('');
    const links = await withDb(({ all }) => all('SELECT status, matterId, unlinkedBy, unlinkedAt FROM work_metadata_matter_links WHERE sourceType=? AND sourceId=?', ['email', row.id]));
    expect(links.filter(link => link.status === 'confirmed')).toHaveLength(0);
    expect(links.filter(link => link.status === 'unlinked')).toHaveLength(1);
    expect(links[0].unlinkedBy).toBeTruthy();
    expect(links[0].unlinkedAt).toBeTruthy();
  });

  test('changing email confirmed matter unlinks prior active link and creates a new confirmed link', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-change', email: 'work-email-25d-change@example.test' });
    await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-change-message', subject: `Please review ${matterReference}` })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_email_messages WHERE connectedAccountId=? AND providerMessageId=?', [account.id, 'work-email-change-message']));
    await request(app)
      .post(`/api/work-email/messages/${row.id}/confirm-matter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);
    const changeRes = await request(app)
      .post(`/api/work-email/messages/${row.id}/confirm-matter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId: overrideMatterId });
    expect(changeRes.statusCode).toBe(200);
    expect(changeRes.body.confirmedMatterId).toBe(overrideMatterId);
    const links = await withDb(({ all }) => all('SELECT status, matterId FROM work_metadata_matter_links WHERE sourceType=? AND sourceId=? ORDER BY createdAt', ['email', row.id]));
    expect(links.filter(link => link.status === 'confirmed')).toHaveLength(1);
    expect(links.find(link => link.status === 'confirmed').matterId).toBe(overrideMatterId);
    expect(links.filter(link => link.status === 'unlinked')).toHaveLength(1);
    expect(links.find(link => link.status === 'unlinked').matterId).toBe(matterId);
  });

  test('email confirmation routes reject clients, wrong owners, and inaccessible matters', async () => {
    const adminAccount = await connectGoogle({ providerAccountId: 'test-work-email-confirm-access-admin', email: 'work-email-25d-confirm-access-admin@example.test' });
    await syncAccount(adminAccount.id, [providerMessage({ providerMessageId: 'work-email-confirm-access-admin-message', subject: `Please review ${matterReference}` })], adminToken);
    const adminMessage = await withDb(({ get }) => get('SELECT * FROM work_email_messages WHERE connectedAccountId=? AND providerMessageId=?', [adminAccount.id, 'work-email-confirm-access-admin-message']));
    const clientRes = await request(app)
      .post(`/api/work-email/messages/${adminMessage.id}/confirm-matter`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({});
    expect(clientRes.statusCode).toBe(403);

    const advocateAccount = await connectGoogle({ token: advocateToken, providerAccountId: 'test-work-email-confirm-access-advocate', email: 'work-email-25d-confirm-access-advocate@example.test' });
    await syncAccount(advocateAccount.id, [providerMessage({ providerMessageId: 'work-email-confirm-access-advocate-message', subject: `Please review ${matterReference}` })], advocateToken);
    const advocateMessage = await withDb(({ get }) => get('SELECT * FROM work_email_messages WHERE connectedAccountId=? AND providerMessageId=?', [advocateAccount.id, 'work-email-confirm-access-advocate-message']));
    const wrongOwnerRes = await request(app)
      .post(`/api/work-email/messages/${advocateMessage.id}/confirm-matter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(wrongOwnerRes.statusCode).toBe(404);
    const inaccessibleRes = await request(app)
      .post(`/api/work-email/messages/${advocateMessage.id}/confirm-matter`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ matterId: inaccessibleMatterId });
    expect(inaccessibleRes.statusCode).toBe(403);
  });

  test('email confirmation responses stay metadata-only and do not create filing records', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-confirm-safe', email: 'work-email-25d-confirm-safe@example.test' });
    await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-confirm-safe-message', body: 'email body text must not be stored', attachmentContent: 'attachment bytes must not be stored' })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_email_messages WHERE connectedAccountId=? AND providerMessageId=?', [account.id, 'work-email-confirm-safe-message']));
    const beforeCounts = await sideEffectCounts();
    const confirmRes = await request(app)
      .post(`/api/work-email/messages/${row.id}/confirm-matter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(confirmRes.statusCode).toBe(200);
    const listRes = await request(app).get('/api/work-email/messages').set('Authorization', `Bearer ${adminToken}`);
    const listed = listRes.body.find(item => item.providerMessageId === 'work-email-confirm-safe-message');
    expect(listed.confirmedMatterId).toBe(matterId);
    const advocateListRes = await request(app).get('/api/work-email/messages').set('Authorization', `Bearer ${advocateToken}`);
    expect(advocateListRes.body.some(item => item.providerMessageId === 'work-email-confirm-safe-message')).toBe(false);
    const unlinkRes = await request(app)
      .post(`/api/work-email/messages/${row.id}/unlink-matter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(unlinkRes.statusCode).toBe(200);
    const afterCounts = await sideEffectCounts();
    expect(afterCounts).toEqual(beforeCounts);
    const payload = JSON.stringify([confirmRes.body, listRes.body, unlinkRes.body]);
    expect(payload).not.toContain(rawAccessToken);
    expect(payload).not.toContain(rawRefreshToken);
    expect(payload.toLowerCase()).not.toContain('accesstoken');
    expect(payload.toLowerCase()).not.toContain('refreshtoken');
    expect(payload.toLowerCase()).not.toContain('encrypted');
    expect(payload).not.toContain('email body text must not be stored');
    expect(payload).not.toContain('attachment bytes must not be stored');
  });

  test('email confirmation audit events are recorded without sensitive metadata', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-email-confirm-audit', email: 'work-email-25d-confirm-audit@example.test' });
    await syncAccount(account.id, [providerMessage({ providerMessageId: 'work-email-confirm-audit-message' })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_email_messages WHERE connectedAccountId=? AND providerMessageId=?', [account.id, 'work-email-confirm-audit-message']));
    await request(app)
      .post(`/api/work-email/messages/${row.id}/confirm-matter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);
    await request(app)
      .post(`/api/work-email/messages/${row.id}/unlink-matter`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);
    const rows = await withDb(({ all }) => all(
      `SELECT action, metadata_json FROM audit_events
       WHERE action IN ('work_email_match_confirmed','work_email_match_unlinked')
       ORDER BY timestamp DESC LIMIT 20`,
    ));
    const actions = rows.map(item => item.action);
    expect(actions).toContain('work_email_match_confirmed');
    expect(actions).toContain('work_email_match_unlinked');
    for (const auditRow of rows) {
      const metadata = JSON.stringify(JSON.parse(auditRow.metadata_json || '{}')).toLowerCase();
      expect(metadata).not.toContain(rawAccessToken.toLowerCase());
      expect(metadata).not.toContain(rawRefreshToken.toLowerCase());
      expect(metadata).not.toContain('access_token');
      expect(metadata).not.toContain('refresh_token');
      expect(metadata).not.toContain('email body');
      expect(metadata).not.toContain('attachment bytes');
    }
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
