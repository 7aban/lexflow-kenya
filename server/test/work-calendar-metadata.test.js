const request = require('supertest');
const sqlite3 = require('sqlite3');
const { app, dbReady } = require('../server.js');
const config = require('../lib/config');
const googleOAuth = require('../lib/oauthGoogle');

describe('Work Calendar Metadata Sync', () => {
  let adminToken;
  let advocateToken;
  let clientToken;
  const rawAccessToken = 'raw-work-calendar-access-token-25e';
  const rawRefreshToken = 'raw-work-calendar-refresh-token-25e';
  const clientId = 'test-work-calendar-client-25e';
  const matterId = 'test-work-calendar-matter-25e';
  const matterReference = 'LEX-CAL-25E-001';

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
      await run(`DELETE FROM work_calendar_events WHERE connectedAccountId IN (
        SELECT id FROM connected_accounts WHERE providerAccountId LIKE 'test-work-calendar-%' OR email LIKE 'work-calendar-25e-%'
      )`);
      await run(`DELETE FROM connected_account_sync_state WHERE connectedAccountId IN (
        SELECT id FROM connected_accounts WHERE providerAccountId LIKE 'test-work-calendar-%' OR email LIKE 'work-calendar-25e-%'
      )`);
      await run(`DELETE FROM connected_account_tokens WHERE connectedAccountId IN (
        SELECT id FROM connected_accounts WHERE providerAccountId LIKE 'test-work-calendar-%' OR email LIKE 'work-calendar-25e-%'
      )`);
      await run("DELETE FROM connected_accounts WHERE providerAccountId LIKE 'test-work-calendar-%' OR email LIKE 'work-calendar-25e-%'");
      await run("DELETE FROM matters WHERE id=?", [matterId]);
      await run("DELETE FROM clients WHERE id=?", [clientId]);
    });
  }

  async function seedMatter() {
    await withDb(async ({ run }) => {
      await run('INSERT INTO clients (id,name,type,email,status,joinDate) VALUES (?,?,?,?,?,?)', [clientId, 'Work Calendar Client', 'Corporate', 'legal@workcalendarclient.co.ke', 'Active', '2026-06-05']);
      await run('INSERT INTO matters (id,reference,clientId,title,practiceArea,stage,assignedTo,openDate,caseNo) VALUES (?,?,?,?,?,?,?,?,?)', [matterId, matterReference, clientId, 'Work Calendar Contract Review', 'Commercial', 'Active', 'Sarah Mwangi', '2026-06-05', 'COMM-25E-001']);
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
      displayName: 'Work Calendar Account',
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
        .query({ code: 'test-work-calendar-google-code', state });
      expect(res.statusCode).toBe(302);
      expect(res.header.location).toContain('connected_account=connected');
      const account = await withDb(({ get }) => get('SELECT * FROM connected_accounts WHERE providerAccountId=?', [providerAccountId]));
      expect(account).toBeTruthy();
      return account;
    } finally {
      spyGoogle.mockRestore();
    }
  }

  function providerEvent(overrides = {}) {
    return {
      providerEventId: `provider-event-${Date.now()}-${Math.random()}`,
      calendarId: 'primary',
      calendarName: 'primary',
      subject: `Meeting re ${matterReference}`,
      startTime: '2026-06-10T09:00:00.000Z',
      endTime: '2026-06-10T10:00:00.000Z',
      location: 'Conference Room A',
      meetingLink: '',
      organizer: 'legal@workcalendarclient.co.ke',
      attendeesSummary: 'admin@lexflow.co.ke',
      descriptionSnippet: 'Calendar metadata preview.',
      providerUpdatedAt: '2026-06-05T12:00:00.000Z',
      ...overrides,
    };
  }

  async function syncAccount(accountId, events, token = adminToken) {
    const spy = jest.spyOn(googleOAuth, 'fetchCalendarMetadata').mockResolvedValueOnce({ events, cursor: 'next-page-token-25e' });
    const res = await request(app)
      .post(`/api/connected-accounts/${accountId}/sync-calendar-metadata`)
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

  test('staff can sync calendar metadata for own connected account', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-own', email: 'work-calendar-25e-own@example.test' });
    const res = await syncAccount(account.id, [providerEvent({ providerEventId: 'work-calendar-own-event' })]);
    expect(res.statusCode).toBe(200);
    expect(res.body.importedCount).toBe(1);
    expect(res.body.totalEvents).toBeGreaterThanOrEqual(1);
    expect(res.body.lastSuccessAt).toBeTruthy();
  });

  test('client cannot sync', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-client-denied', email: 'work-calendar-25e-client-denied@example.test' });
    const res = await request(app)
      .post(`/api/connected-accounts/${account.id}/sync-calendar-metadata`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('disconnected account cannot sync', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-disconnected', email: 'work-calendar-25e-disconnected@example.test' });
    await request(app)
      .post(`/api/connected-accounts/${account.id}/disconnect`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const res = await request(app)
      .post(`/api/connected-accounts/${account.id}/sync-calendar-metadata`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(400);
  });

  test("user cannot sync another user's account", async () => {
    const account = await connectGoogle({ token: advocateToken, providerAccountId: 'test-work-calendar-advocate', email: 'work-calendar-25e-advocate@example.test' });
    const res = await request(app)
      .post(`/api/connected-accounts/${account.id}/sync-calendar-metadata`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(404);
  });

  test('provider client is mocked and no real provider call is made', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-mocked', email: 'work-calendar-25e-mocked@example.test' });
    const fetchSpy = global.fetch ? jest.spyOn(global, 'fetch') : null;
    const res = await syncAccount(account.id, [providerEvent({ providerEventId: 'work-calendar-mocked-event' })]);
    expect(res.statusCode).toBe(200);
    if (fetchSpy) expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('raw and encrypted token values are not returned by sync, list, or matches', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-token-safe', email: 'work-calendar-25e-token-safe@example.test' });
    const syncRes = await syncAccount(account.id, [providerEvent({ providerEventId: 'work-calendar-token-safe-event' })]);
    const listRes = await request(app).get('/api/work-calendar/events').set('Authorization', `Bearer ${adminToken}`);
    const event = listRes.body.find(row => row.providerEventId === 'work-calendar-token-safe-event');
    const matchesRes = await request(app).get(`/api/work-calendar/events/${event.id}/matches`).set('Authorization', `Bearer ${adminToken}`);
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

  test('full description body is not stored', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-metadata-only', email: 'work-calendar-25e-metadata-only@example.test' });
    await syncAccount(account.id, [providerEvent({ providerEventId: 'work-calendar-metadata-only-event', descriptionSnippet: 'This is a calendar event description that is safe to store as a snippet.' })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_calendar_events WHERE connectedAccountId=? AND providerEventId=?', [account.id, 'work-calendar-metadata-only-event']));
    expect(row).toBeTruthy();
    expect(row.descriptionSnippet).toBeTruthy();
    expect(JSON.stringify(row)).toContain('This is a calendar event description');
    expect(row).not.toHaveProperty('description');
    expect(row).not.toHaveProperty('body');
  });

  test('descriptionSnippet is max 500 chars', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-snippet-limit', email: 'work-calendar-25e-snippet-limit@example.test' });
    const longDesc = 'A'.repeat(1000);
    await syncAccount(account.id, [providerEvent({ providerEventId: 'work-calendar-snippet-limit-event', descriptionSnippet: longDesc })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_calendar_events WHERE connectedAccountId=? AND providerEventId=?', [account.id, 'work-calendar-snippet-limit-event']));
    expect(row.descriptionSnippet.length).toBeLessThanOrEqual(500);
  });

  test('attendeesSummary is stored as a string', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-attendees', email: 'work-calendar-25e-attendees@example.test' });
    await syncAccount(account.id, [providerEvent({ providerEventId: 'work-calendar-attendees-event', attendeesSummary: 'user1@test.com; user2@test.com' })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_calendar_events WHERE connectedAccountId=? AND providerEventId=?', [account.id, 'work-calendar-attendees-event']));
    expect(typeof row.attendeesSummary).toBe('string');
    expect(row.attendeesSummary).toBe('user1@test.com; user2@test.com');
  });

  test('duplicate providerEventId upserts', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-upsert', email: 'work-calendar-25e-upsert@example.test' });
    await syncAccount(account.id, [providerEvent({ providerEventId: 'work-calendar-upsert-event', subject: 'First subject' })]);
    const res = await syncAccount(account.id, [providerEvent({ providerEventId: 'work-calendar-upsert-event', subject: 'Updated subject' })]);
    expect(res.statusCode).toBe(200);
    expect(res.body.updatedCount).toBe(1);
    const row = await withDb(({ get }) => get('SELECT COUNT(*) count, MAX(subject) subject FROM work_calendar_events WHERE connectedAccountId=? AND providerEventId=?', [account.id, 'work-calendar-upsert-event']));
    expect(row.count).toBe(1);
    expect(row.subject).toBe('Updated subject');
  });

  test('sync state uses syncType=calendar_metadata', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-sync-state', email: 'work-calendar-25e-sync-state@example.test' });
    await syncAccount(account.id, [providerEvent({ providerEventId: 'work-calendar-sync-state-event' })]);
    const state = await withDb(({ get }) => get('SELECT * FROM connected_account_sync_state WHERE connectedAccountId=? AND syncType=?', [account.id, 'calendar_metadata']));
    expect(state).toBeTruthy();
    expect(state.lastAttemptAt).toBeTruthy();
    expect(state.lastSuccessAt).toBeTruthy();
    expect(state.lastImportedCount).toBe(1);
  });

  test('list is staff-only and owner-scoped', async () => {
    const adminAccount = await connectGoogle({ providerAccountId: 'test-work-calendar-list-admin', email: 'work-calendar-25e-list-admin@example.test' });
    const advocateAccount = await connectGoogle({ token: advocateToken, providerAccountId: 'test-work-calendar-list-advocate', email: 'work-calendar-25e-list-advocate@example.test' });
    await syncAccount(adminAccount.id, [providerEvent({ providerEventId: 'work-calendar-list-admin-event' })], adminToken);
    await syncAccount(advocateAccount.id, [providerEvent({ providerEventId: 'work-calendar-list-advocate-event' })], advocateToken);
    const clientRes = await request(app).get('/api/work-calendar/events').set('Authorization', `Bearer ${clientToken}`);
    expect(clientRes.statusCode).toBe(403);
    const adminRes = await request(app).get('/api/work-calendar/events').set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.body.some(row => row.providerEventId === 'work-calendar-list-admin-event')).toBe(true);
    expect(adminRes.body.some(row => row.providerEventId === 'work-calendar-list-advocate-event')).toBe(false);
  });

  test('meetingLink is stored as metadata', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-meeting-link', email: 'work-calendar-25e-meeting-link@example.test' });
    const meetingUrl = 'https://meet.google.com/test-abc-def';
    await syncAccount(account.id, [providerEvent({ providerEventId: 'work-calendar-meeting-link-event', meetingLink: meetingUrl })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_calendar_events WHERE connectedAccountId=? AND providerEventId=?', [account.id, 'work-calendar-meeting-link-event']));
    expect(row.meetingLink).toBe(meetingUrl);
    const listRes = await request(app).get('/api/work-calendar/events').set('Authorization', `Bearer ${adminToken}`);
    const listed = listRes.body.find(r => r.providerEventId === 'work-calendar-meeting-link-event');
    expect(listed.meetingLink).toBe(meetingUrl);
  });

  test('matter-match suggestions are generated without creating deadline/appearance/document/timeline records', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-match', email: 'work-calendar-25e-match@example.test' });
    const beforeDocs = await withDb(({ get }) => get('SELECT COUNT(*) count FROM documents WHERE matterId=?', [matterId]));
    const beforeDeadlines = await withDb(({ get }) => get('SELECT COUNT(*) count FROM deadlines WHERE matterId=?', [matterId]));
    const beforeAppearances = await withDb(({ get }) => get('SELECT COUNT(*) count FROM appearances WHERE matterId=?', [matterId]));
    const beforeTasks = await withDb(({ get }) => get('SELECT COUNT(*) count FROM tasks WHERE matterId=?', [matterId]));
    await syncAccount(account.id, [providerEvent({ providerEventId: 'work-calendar-match-event', subject: `Court meeting re ${matterReference}` })]);
    const row = await withDb(({ get }) => get('SELECT * FROM work_calendar_events WHERE connectedAccountId=? AND providerEventId=?', [account.id, 'work-calendar-match-event']));
    expect(row.matchedMatterId).toBe(matterId);
    expect(row.matchConfidence).toBeGreaterThan(0.5);
    const matchesRes = await request(app).get(`/api/work-calendar/events/${row.id}/matches`).set('Authorization', `Bearer ${adminToken}`);
    expect(matchesRes.statusCode).toBe(200);
    expect(matchesRes.body[0].matterId).toBe(matterId);
    const afterDocs = await withDb(({ get }) => get('SELECT COUNT(*) count FROM documents WHERE matterId=?', [matterId]));
    const afterDeadlines = await withDb(({ get }) => get('SELECT COUNT(*) count FROM deadlines WHERE matterId=?', [matterId]));
    const afterAppearances = await withDb(({ get }) => get('SELECT COUNT(*) count FROM appearances WHERE matterId=?', [matterId]));
    const afterTasks = await withDb(({ get }) => get('SELECT COUNT(*) count FROM tasks WHERE matterId=?', [matterId]));
    expect(afterDocs.count).toBe(beforeDocs.count);
    expect(afterDeadlines.count).toBe(beforeDeadlines.count);
    expect(afterAppearances.count).toBe(beforeAppearances.count);
    expect(afterTasks.count).toBe(beforeTasks.count);
  });

  test('audit events are recorded without sensitive metadata', async () => {
    const account = await connectGoogle({ providerAccountId: 'test-work-calendar-audit', email: 'work-calendar-25e-audit@example.test' });
    await syncAccount(account.id, [providerEvent({ providerEventId: 'work-calendar-audit-event' })]);
    const rows = await withDb(({ all }) => all(
      `SELECT action, metadata_json FROM audit_events
       WHERE action IN ('work_calendar_sync_started','work_calendar_sync_completed','work_calendar_sync_failed','work_calendar_metadata_imported','work_calendar_match_suggested')
       ORDER BY timestamp DESC LIMIT 30`,
    ));
    const actions = rows.map(row => row.action);
    expect(actions).toContain('work_calendar_sync_started');
    expect(actions).toContain('work_calendar_sync_completed');
    expect(actions).toContain('work_calendar_metadata_imported');
    expect(actions).toContain('work_calendar_match_suggested');
    for (const row of rows) {
      const metadata = JSON.stringify(JSON.parse(row.metadata_json || '{}')).toLowerCase();
      expect(metadata).not.toContain(rawAccessToken.toLowerCase());
      expect(metadata).not.toContain(rawRefreshToken.toLowerCase());
      expect(metadata).not.toContain('access_token');
      expect(metadata).not.toContain('refresh_token');
      expect(metadata).not.toContain('encrypted');
      expect(metadata).not.toContain('cursor');
    }
  });
});
