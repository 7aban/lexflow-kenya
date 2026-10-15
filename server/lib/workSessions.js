'use strict';

const sqlite3 = require('sqlite3');
const createDb = require('./db');
const createAccess = require('./access');
const createAudit = require('./audit');
const { genId } = require('./utils');
const { nairobiWorkDate, validWorkDate } = require('./dailyWorkReview');

const ACTIVITIES = ['Legal Research', 'Drafting', 'Court Attendance', 'Client Communication', 'Document Review', 'Filing', 'Preparation', 'Other'];
const CONFIRMATION_WINDOW_SECONDS = 120;
const WRITER_ACQUISITION_TIMEOUT_MS = 2000;

class WorkSessionError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}
const fail = (status, message) => { throw new WorkSessionError(status, message); };

// Additive migration, following initDb's CREATE IF NOT EXISTS conventions.
async function initializeWorkSessions({ run }) {
  await run(`CREATE TABLE IF NOT EXISTS work_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    userId TEXT NOT NULL REFERENCES users(id),
    matterId TEXT NOT NULL REFERENCES matters(id),
    taskId TEXT REFERENCES tasks(id),
    activity TEXT NOT NULL CHECK(activity IN (${ACTIVITIES.map(a => `'${a}'`).join(',')})),
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('running','paused','recorded')),
    accumulatedSeconds INTEGER NOT NULL DEFAULT 0 CHECK(typeof(accumulatedSeconds)='integer' AND accumulatedSeconds>=0),
    segmentStartedAt INTEGER,
    lastConfirmedAt INTEGER,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
    timeEntryId TEXT UNIQUE REFERENCES time_entries(id),
    recoveryRequired INTEGER NOT NULL DEFAULT 0 CHECK(recoveryRequired IN (0,1)),
    uncertainSeconds INTEGER NOT NULL DEFAULT 0 CHECK(uncertainSeconds>=0),
    uncertainSince INTEGER,
    recoveryReviewedAt TEXT,
    CHECK((status='running' AND segmentStartedAt IS NOT NULL AND lastConfirmedAt IS NOT NULL)
      OR (status<>'running' AND segmentStartedAt IS NULL)),
    CHECK((status='recorded' AND timeEntryId IS NOT NULL) OR (status<>'recorded' AND timeEntryId IS NULL)),
    CHECK(status<>'running' OR recoveryRequired=0)
  )`);
  await run("CREATE UNIQUE INDEX IF NOT EXISTS idx_work_sessions_one_running ON work_sessions(userId) WHERE status='running'");
  await run('CREATE INDEX IF NOT EXISTS idx_work_sessions_owner_updated ON work_sessions(userId,updatedAt)');
}

/*
 * Time contract for Phase 104B:
 * - Send POST /:id/confirm with the current version at intervals under 120s.
 * - Only confirm/pause/switch confirms elapsed whole seconds; GET never does.
 * - Retain subsecond remainder between confirmations; pause discards <1 second.
 * - A gap >120s (or clock reversal) pauses without crediting ANY of the tail.
 *   This also applies after browser closure or process restart. No background
 *   job bills time. Startup alone neither confirms nor extends the lease.
 * - GET/list persists recovery; mutations encountering recovery return 409 and
 *   must reload. POST /:id/review explicitly discards the uncertain tail. It
 *   never adds it to confirmed time. Historical uncertainty remains visible.
 * - Record only a paused, reviewed session. Seconds / 3600 is stored in the
 *   existing hours column without billing increments or decimal rounding.
 */
function createWorkSessions({ databasePath, now = Date.now }) {
  async function transaction(req, operation) {
    if (!req.user?.userId) fail(401, 'Authentication required');
    if (!['admin', 'advocate', 'assistant'].includes(req.user.role)) fail(403, 'Staff access required');
    // Dedicated connection per transaction: unrelated server.js requests cannot
    // accidentally join this transaction. SQLite serializes writers/processes.
    const connection = await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READWRITE, err => err ? reject(err) : resolve(db));
    });
    const sql = createDb(connection, { configure: false });
    let begun = false;
    try {
      // Native busy waits occupy libuv workers. Enough competing connections
      // can starve the writer's own next query/COMMIT until those waits expire.
      // Yield in JavaScript instead; retry only BEGIN, never a mutation. SQLite
      // still arbitrates writers across processes. Use a monotonic deadline.
      await sql.run('PRAGMA busy_timeout=0');
      const deadline = performance.now() + WRITER_ACQUISITION_TIMEOUT_MS;
      for (;;) {
        try { await sql.run('BEGIN IMMEDIATE'); break; }
        catch (error) {
          const remaining = deadline - performance.now();
          if (!['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code) || remaining <= 0) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 10 + Math.random() * 15)));
        }
      }
      begun = true;
      // Recheck actor inside the write boundary, including role/revocation.
      const actor = await sql.get('SELECT id,fullName,role,tokenVersion FROM users WHERE id=?', [req.user.userId]);
      if (!actor || actor.tokenVersion !== req.user.tokenVersion || actor.role !== req.user.role) fail(401, 'Session invalidated');
      const scopedReq = { ...req, user: { ...req.user, fullName: actor.fullName } };
      const context = { ...sql, req: scopedReq, access: createAccess(sql), audit: createAudit(sql).recordAuditEvent, at: now() };
      const result = await operation(context);
      await sql.run('COMMIT');
      begun = false;
      return result;
    } catch (error) {
      if (begun) await sql.run('ROLLBACK');
      if (['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CONSTRAINT'].includes(error.code)) fail(409, 'Work session conflict; reload and retry');
      throw error;
    } finally {
      await new Promise((resolve, reject) => connection.close(err => err ? reject(err) : resolve()));
    }
  }

  const stamp = c => new Date(c.at).toISOString();
  async function audit(c, action, row) {
    await c.audit(c.req, { action: `work_session_${action}`, entityType: 'work_session', entityId: row.id, matterId: row.matterId,
      metadata: { version: row.version, accumulatedSeconds: row.accumulatedSeconds, timeEntryId: row.timeEntryId } }, { throwOnError: true });
  }
  async function association(c, matterId, taskId) {
    if (typeof matterId !== 'string' || !matterId) fail(400, 'matterId is required');
    if (!(await c.get('SELECT id FROM matters WHERE id=?', [matterId]))) fail(404, 'Matter not found');
    if (!(await c.access.canAccessMatter(c.req, matterId))) fail(403, 'Matter access denied');
    if (taskId !== null && taskId !== undefined && typeof taskId !== 'string') fail(400, 'Invalid taskId');
    if (taskId) {
      const task = await c.get('SELECT id,matterId FROM tasks WHERE id=?', [taskId]);
      if (!task) fail(400, 'Task not found');
      if (task.matterId !== matterId) fail(400, 'Task does not belong to this matter');
      if (!(await c.access.canAccessTask(c.req, taskId))) fail(403, 'Task access denied');
    }
  }
  async function owned(c, id) {
    const row = await c.get('SELECT * FROM work_sessions WHERE id=? AND userId=?', [id, c.req.user.userId]);
    if (!row) fail(404, 'Work session not found');
    await association(c, row.matterId, row.taskId);
    return row;
  }
  function version(row, body) {
    if (!Number.isSafeInteger(body.version) || body.version < 1) fail(400, 'A positive integer version is required');
    if (row.version !== body.version) fail(409, 'Work session version conflict; reload and retry');
  }
  function fields(body, allowed) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Invalid request body');
    if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'Unsupported work session field');
  }
  function activity(value) {
    if (!ACTIVITIES.includes(value)) fail(400, 'Invalid activity');
    return value;
  }
  function description(value) {
    if (typeof value !== 'string' || value.length > 10000) fail(400, 'Invalid description');
    return value;
  }
  async function save(c, row, changes, action) {
    const values = { ...changes, updatedAt: stamp(c), version: row.version + 1 };
    const result = await c.run(`UPDATE work_sessions SET ${Object.keys(values).map(k => `${k}=?`).join(',')} WHERE id=? AND userId=? AND version=?`,
      [...Object.values(values), row.id, c.req.user.userId, row.version]);
    if (result.changes !== 1) fail(409, 'Work session version conflict; reload and retry');
    const saved = { ...row, ...values };
    await audit(c, action, saved);
    return saved;
  }
  async function recover(c) {
    const rows = await c.all("SELECT * FROM work_sessions WHERE userId=? AND status='running'", [c.req.user.userId]);
    for (const row of rows) {
      const gap = c.at - row.lastConfirmedAt;
      if (gap > CONFIRMATION_WINDOW_SECONDS * 1000 || gap < 0) {
        await save(c, row, { status: 'paused', segmentStartedAt: null, recoveryRequired: 1,
          uncertainSeconds: Math.max(0, Math.floor(gap / 1000)), uncertainSince: row.lastConfirmedAt, recoveryReviewedAt: null }, 'recover');
      }
    }
  }
  function elapsed(c, row) { return Math.max(0, Math.floor((c.at - row.lastConfirmedAt) / 1000)); }
  function view(c, row) {
    const pendingSeconds = row.status === 'running' ? elapsed(c, row) : 0;
    return { ...row, pendingSeconds, totalSeconds: row.accumulatedSeconds + pendingSeconds, confirmationWindowSeconds: CONFIRMATION_WINDOW_SECONDS };
  }
  async function checkpoint(c, row, pause) {
    const seconds = elapsed(c, row);
    return save(c, row, { accumulatedSeconds: row.accumulatedSeconds + seconds,
      lastConfirmedAt: row.lastConfirmedAt + seconds * 1000,
      ...(pause ? { status: 'paused', segmentStartedAt: null } : {}) }, pause ? 'pause' : 'confirm');
  }
  async function otherRunning(c, body, targetId) {
    const current = await c.get("SELECT * FROM work_sessions WHERE userId=? AND status='running'", [c.req.user.userId]);
    if (!current || current.id === targetId) {
      if (body.runningSessionId !== undefined || body.runningVersion !== undefined) fail(409, 'Running session changed; reload and retry');
      return;
    }
    // Caller must identify the precise session/version being paused. An old tab
    // cannot silently pause a newly started session belonging to the same user.
    if (body.runningSessionId !== current.id || body.runningVersion !== current.version) fail(409, 'Another session is running; supply its ID and version to switch');
    await association(c, current.matterId, current.taskId);
    await checkpoint(c, current, true);
  }

  return {
    start: (req, body) => transaction(req, async c => {
      fields(body, ['matterId', 'taskId', 'activity', 'description', 'runningSessionId', 'runningVersion']);
      await recover(c);
      await association(c, body.matterId, body.taskId);
      const selectedActivity = activity(body.activity === undefined ? 'Legal Research' : body.activity);
      const selectedDescription = description(body.description === undefined ? '' : body.description);
      await otherRunning(c, body);
      const row = { id: genId('WORK'), userId: c.req.user.userId, matterId: body.matterId, taskId: body.taskId || null,
        activity: selectedActivity, description: selectedDescription, status: 'running', accumulatedSeconds: 0,
        segmentStartedAt: c.at, lastConfirmedAt: c.at, createdAt: stamp(c), updatedAt: stamp(c), version: 1 };
      await c.run(`INSERT INTO work_sessions (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row));
      const saved = await owned(c, row.id);
      await audit(c, 'start', saved);
      return view(c, saved);
    }),
    list: req => transaction(req, async c => {
      await recover(c);
      const scope = c.access.matterAccessScopeSql(c.req, 'm');
      const taskScope = c.access.taskAccessScopeSql(c.req, 't');
      const rows = await c.all(`SELECT w.* FROM work_sessions w JOIN matters m ON m.id=w.matterId
        WHERE w.userId=? AND ${scope.sql} AND (w.taskId IS NULL OR EXISTS
        (SELECT 1 FROM tasks t WHERE t.id=w.taskId AND t.matterId=w.matterId AND ${taskScope.sql})) ORDER BY w.updatedAt DESC,w.id`,
      [c.req.user.userId, ...scope.params, ...taskScope.params]);
      return rows.map(row => view(c, row));
    }),
    retrieve: (req, id) => transaction(req, async c => { await recover(c); return view(c, await owned(c, id)); }),
    update: (req, id, body) => transaction(req, async c => {
      fields(body, ['version', 'activity', 'description']);
      await recover(c);
      const row = await owned(c, id);
      version(row, body);
      if (row.status === 'recorded') fail(409, 'Recorded work session is immutable');
      const changes = {};
      if (body.activity !== undefined) changes.activity = activity(body.activity);
      if (body.description !== undefined) changes.description = description(body.description);
      if (!Object.keys(changes).length) fail(400, 'No supported fields supplied');
      return view(c, await save(c, row, changes, 'update'));
    }),
    transition: (req, id, action, body) => transaction(req, async c => {
      fields(body, action === 'resume' ? ['version', 'runningSessionId', 'runningVersion'] : action === 'review' ? ['version', 'discardUnconfirmed'] : ['version']);
      await recover(c);
      let row = await owned(c, id);
      version(row, body);
      if (row.status === 'recorded') fail(409, 'Recorded work session is immutable');
      if (action === 'review') {
        if (!row.recoveryRequired || body.discardUnconfirmed !== true) fail(400, 'Explicit discardUnconfirmed review is required');
        row = await save(c, row, { recoveryRequired: 0, recoveryReviewedAt: stamp(c) }, 'review');
      } else {
        if (row.recoveryRequired) fail(409, 'Review unconfirmed interval before continuing');
        if (action === 'resume') {
          if (row.status !== 'paused') fail(409, 'Only paused sessions can resume');
          await otherRunning(c, body, id);
          row = await save(c, row, { status: 'running', segmentStartedAt: c.at, lastConfirmedAt: c.at }, 'resume');
        } else {
          if (row.status !== 'running') fail(409, 'Session is not running; reload to review any recovery');
          row = await checkpoint(c, row, action === 'pause');
        }
      }
      return view(c, row);
    }),
    record: (req, id, body) => transaction(req, async c => {
      fields(body, ['version', 'billable', 'rate', 'date']);
      await recover(c);
      const row = await owned(c, id);
      let entry;
      const visible = await c.access.isBillingVisibleFor(c.req);
      if (row.status === 'recorded') {
        // Check before version: a timeout retry carries the pre-record version.
        entry = await c.get('SELECT * FROM time_entries WHERE id=?', [row.timeEntryId]);
        if (!entry) fail(409, 'Recorded time entry no longer exists; automatic recreation is prohibited');
      } else {
        version(row, body);
        if (row.status !== 'paused' || row.recoveryRequired) fail(409, 'Pause and review the session before recording');
        if (typeof body.billable !== 'boolean') fail(400, 'Explicit billable choice is required');
        const rate = body.rate === undefined ? 0 : body.rate;
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || (!visible && rate !== 0)) fail(400, 'Invalid rate');
        const date = body.date === undefined ? nairobiWorkDate(c.at) : body.date;
        if (!validWorkDate(date)) fail(400, 'Invalid date');
        const entryId = genId('TIME');
        await c.run(`INSERT INTO time_entries (id,matterId,taskId,attorney,date,hours,activity,description,rate,billed,billable,performedByUserId)
          VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`, [entryId, row.matterId, row.taskId || '', c.req.user.fullName || '', date,
          row.accumulatedSeconds / 3600, row.activity, row.description, rate, body.billable ? 1 : 0, row.userId]);
        await save(c, row, { status: 'recorded', timeEntryId: entryId }, 'record');
        entry = await c.get('SELECT * FROM time_entries WHERE id=?', [entryId]);
      }
      if (!visible) entry.rate = null;
      return entry;
    }),
  };
}

function registerWorkSessionRoutes(app, { databasePath, requireStaff }) {
  const service = createWorkSessions({ databasePath });
  const handler = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (error) {
      if (error instanceof WorkSessionError) return res.status(error.statusCode).json({ error: error.message });
      // Never leak SQL, paths, or descriptions through database diagnostics.
      res.status(500).json({ error: 'Work session operation failed' });
    }
  };
  app.get('/api/work-sessions', requireStaff, handler(req => service.list(req)));
  app.get('/api/work-sessions/:id', requireStaff, handler(req => service.retrieve(req, req.params.id)));
  app.post('/api/work-sessions', requireStaff, handler(req => service.start(req, req.body)));
  app.patch('/api/work-sessions/:id', requireStaff, handler(req => service.update(req, req.params.id, req.body)));
  for (const action of ['pause', 'resume', 'confirm', 'review']) {
    app.post(`/api/work-sessions/:id/${action}`, requireStaff, handler(req => service.transition(req, req.params.id, action, req.body)));
  }
  app.post('/api/work-sessions/:id/record', requireStaff, handler(req => service.record(req, req.params.id, req.body)));
}

module.exports = { createWorkSessions, initializeWorkSessions, registerWorkSessionRoutes, WorkSessionError, ACTIVITIES, CONFIRMATION_WINDOW_SECONDS };
