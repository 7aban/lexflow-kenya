const { execFileSync } = require('child_process');
const path = require('path');
const request = require('supertest');
const sqlite3 = require('sqlite3');

const serverRoot = path.join(__dirname, '..');
const seedScript = path.join(serverRoot, 'scripts', 'seed-demo-data.js');

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    value.forEach(item => collectKeys(item, keys));
    return keys;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => {
      keys.push(key);
      collectKeys(child, keys);
    });
  }
  return keys;
}

describe('Seed demo integration metadata', () => {
  let app;
  let dbReady;
  let config;
  let adminToken;

  async function withDb(work) {
    const db = new sqlite3.Database(config.DATABASE_PATH);
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function onRun(err) { err ? reject(err) : resolve(this); }));
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
    const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
    const close = () => new Promise(resolve => db.close(() => resolve()));
    try {
      return await work({ run, get, all });
    } finally {
      await close();
    }
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

  test('seed creates integration tables on the demo database', async () => {
    const tables = await withDb(({ all }) => all(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name IN (
         'connected_accounts',
         'connected_account_tokens',
         'connected_account_sync_state',
         'work_email_messages',
         'work_calendar_events',
         'work_metadata_matter_links'
       )
       ORDER BY name`,
    ));
    expect(tables.map(row => row.name).sort()).toEqual([
      'connected_account_sync_state',
      'connected_account_tokens',
      'connected_accounts',
      'work_calendar_events',
      'work_email_messages',
      'work_metadata_matter_links',
    ]);
  });

  test('seed creates exactly two seed-admin connected accounts without token or sync-state rows', async () => {
    const summary = await withDb(async ({ all, get }) => {
      const accounts = await all('SELECT * FROM connected_accounts ORDER BY provider');
      const tokenCount = await get('SELECT COUNT(*) count FROM connected_account_tokens');
      const syncStateCount = await get('SELECT COUNT(*) count FROM connected_account_sync_state');
      return { accounts, tokenCount: tokenCount.count, syncStateCount: syncStateCount.count };
    });

    expect(summary.accounts).toHaveLength(2);
    expect(summary.accounts.map(account => account.userId)).toEqual(['seed-admin', 'seed-admin']);
    expect(summary.accounts.map(account => account.status)).toEqual(['connected', 'connected']);
    expect(summary.accounts.map(account => account.provider).sort()).toEqual(['google', 'microsoft']);
    expect(summary.accounts.map(account => account.providerAccountId).sort()).toEqual([
      'demo-google-metadata-seed',
      'demo-microsoft-metadata-seed',
    ]);
    expect(summary.tokenCount).toBe(0);
    expect(summary.syncStateCount).toBe(0);
  });

  test('seed creates four email metadata rows with confirmed, suggested-only, and unmatched states', async () => {
    const rows = await withDb(({ all }) => all(
      `SELECT wem.*, wml.id confirmedLinkId
       FROM work_email_messages wem
       LEFT JOIN work_metadata_matter_links wml
         ON wml.sourceType='email' AND wml.sourceId=wem.id AND wml.status='confirmed'
       ORDER BY wem.providerMessageId`,
    ));

    expect(rows).toHaveLength(4);
    expect(rows.filter(row => row.confirmedLinkId)).toHaveLength(1);
    expect(rows.filter(row => row.matchedMatterId && !row.confirmedLinkId)).toHaveLength(2);
    expect(rows.filter(row => row.matchedMatterId === null && row.matchConfidence === null && row.matchReason === null)).toHaveLength(1);
    expect(rows.find(row => row.providerMessageId === 'demo-email-confirmed-lex-2026-0001').hasAttachments).toBe(1);
    expect(rows.some(row => row.subject.includes('LEX-2026-0001'))).toBe(true);
    expect(rows.some(row => row.snippet.includes('Kamau Logistics'))).toBe(true);
    expect(rows.some(row => row.subject.includes('MCCC/E401/2025'))).toBe(true);
  });

  test('seed creates four calendar metadata rows with confirmed, suggested-only, and unmatched states', async () => {
    const rows = await withDb(({ all }) => all(
      `SELECT wce.*, wml.id confirmedLinkId
       FROM work_calendar_events wce
       LEFT JOIN work_metadata_matter_links wml
         ON wml.sourceType='calendar' AND wml.sourceId=wce.id AND wml.status='confirmed'
       ORDER BY wce.providerEventId`,
    ));

    expect(rows).toHaveLength(4);
    expect(rows.filter(row => row.confirmedLinkId)).toHaveLength(1);
    expect(rows.filter(row => row.matchedMatterId && !row.confirmedLinkId)).toHaveLength(2);
    expect(rows.filter(row => row.matchedMatterId === null && row.matchConfidence === null && row.matchReason === null)).toHaveLength(1);
    expect(rows.some(row => row.subject.includes('CHRPET/E045/2025'))).toBe(true);
    expect(rows.some(row => row.subject.includes('HCCC/E771/2025'))).toBe(true);
    expect(rows.some(row => row.subject.includes('LEX-2026-0001'))).toBe(true);
  });

  test('seed creates exactly two active confirmed links pointing at existing sources and matters', async () => {
    const links = await withDb(({ all }) => all(
      `SELECT wml.*, m.id matterExists, wem.id emailSourceExists, wce.id calendarSourceExists
       FROM work_metadata_matter_links wml
       LEFT JOIN matters m ON m.id=wml.matterId
       LEFT JOIN work_email_messages wem ON wml.sourceType='email' AND wem.id=wml.sourceId
       LEFT JOIN work_calendar_events wce ON wml.sourceType='calendar' AND wce.id=wml.sourceId
       WHERE wml.status='confirmed'
       ORDER BY wml.sourceType`,
    ));

    expect(links).toHaveLength(2);
    expect(links.map(link => link.sourceType).sort()).toEqual(['calendar', 'email']);
    for (const link of links) {
      expect(link.confirmedBy).toBe('seed-admin');
      expect(link.confirmedAt).toBeTruthy();
      expect(link.unlinkedBy).toBeNull();
      expect(link.unlinkedAt).toBeNull();
      expect(link.matterExists).toBe(link.matterId);
      expect(link.suggestedMatterId).toBe(link.matterId);
      expect(link.emailSourceExists || link.calendarSourceExists).toBe(link.sourceId);
    }
  });

  test('seed stores metadata only without body, attachment content, or full calendar description columns', async () => {
    const metadataShape = await withDb(async ({ all }) => {
      const emailColumns = await all('PRAGMA table_info(work_email_messages)');
      const calendarColumns = await all('PRAGMA table_info(work_calendar_events)');
      const calendarRows = await all('SELECT descriptionSnippet FROM work_calendar_events');
      return {
        emailColumns: emailColumns.map(column => column.name),
        calendarColumns: calendarColumns.map(column => column.name),
        calendarRows,
      };
    });

    expect(metadataShape.emailColumns).not.toContain('body');
    expect(metadataShape.emailColumns).not.toContain('attachmentContent');
    expect(metadataShape.emailColumns).not.toContain('attachmentsJson');
    expect(metadataShape.calendarColumns).not.toContain('description');
    expect(metadataShape.calendarColumns).not.toContain('body');
    expect(metadataShape.calendarRows.every(row => String(row.descriptionSnippet || '').length <= 160)).toBe(true);
  });

  test('seeded metadata does not create documents, deadlines, appearances, tasks, or client activity records', async () => {
    const counts = await withDb(async ({ all, get }) => {
      const sourceRows = await all(`
        SELECT id FROM work_email_messages
        UNION ALL
        SELECT id FROM work_calendar_events
      `);
      const sourceIds = sourceRows.map(row => row.id);
      const placeholders = sourceIds.map(() => '?').join(',');
      const emptyResult = { count: 0 };
      const documents = placeholders ? await get(`SELECT COUNT(*) count FROM documents WHERE messageId IN (${placeholders})`, sourceIds) : emptyResult;
      const clientActivity = placeholders ? await get(`SELECT COUNT(*) count FROM client_activity WHERE entityId IN (${placeholders})`, sourceIds) : emptyResult;
      const tasks = placeholders ? await get(`SELECT COUNT(*) count FROM tasks WHERE id IN (${placeholders})`, sourceIds) : emptyResult;
      const deadlines = placeholders ? await get(`SELECT COUNT(*) count FROM deadlines WHERE id IN (${placeholders})`, sourceIds) : emptyResult;
      const appearances = placeholders ? await get(`SELECT COUNT(*) count FROM appearances WHERE id IN (${placeholders})`, sourceIds) : emptyResult;
      return {
        documents: documents.count,
        clientActivity: clientActivity.count,
        tasks: tasks.count,
        deadlines: deadlines.count,
        appearances: appearances.count,
      };
    });

    expect(counts).toEqual({
      documents: 0,
      clientActivity: 0,
      tasks: 0,
      deadlines: 0,
      appearances: 0,
    });
  });

  test('admin list APIs return seeded metadata without token or encrypted fields', async () => {
    const [accountsRes, emailRes, calendarRes] = await Promise.all([
      request(app).get('/api/connected-accounts').set('Authorization', `Bearer ${adminToken}`),
      request(app).get('/api/work-email/messages').set('Authorization', `Bearer ${adminToken}`),
      request(app).get('/api/work-calendar/events').set('Authorization', `Bearer ${adminToken}`),
    ]);

    expect(accountsRes.statusCode).toBe(200);
    expect(emailRes.statusCode).toBe(200);
    expect(calendarRes.statusCode).toBe(200);
    expect(accountsRes.body).toHaveLength(2);
    expect(emailRes.body).toHaveLength(4);
    expect(calendarRes.body).toHaveLength(4);
    expect(emailRes.body.some(row => row.providerMessageId === 'demo-email-confirmed-lex-2026-0001' && row.confirmedMatterId)).toBe(true);
    expect(calendarRes.body.some(row => row.providerEventId === 'demo-calendar-confirmed-lex-2026-0005' && row.confirmedMatterId)).toBe(true);

    const payload = [accountsRes.body, emailRes.body, calendarRes.body];
    const keys = collectKeys(payload).map(key => key.toLowerCase());
    expect(keys.some(key => key.includes('token'))).toBe(false);
    expect(keys.some(key => key.includes('encrypted'))).toBe(false);
    expect(JSON.stringify(payload).toLowerCase()).not.toContain('accesstoken');
    expect(JSON.stringify(payload).toLowerCase()).not.toContain('refreshtoken');
  });
});
