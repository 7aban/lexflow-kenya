'use strict';

// Time-entry work dates only. Other application dates retain their existing contract.
const timeZone = 'Africa/Nairobi';
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
const nairobiWorkDate = (at = Date.now()) => dateFormatter.format(new Date(at));
function validWorkDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

// The caller has the same staff + matter-create permission as the legacy POST.
// Selecting an ID never grants the actor access to another matter.
async function manualPerformer({ get, canAccessMatter }, req) {
  const body = req.body;
  if (body.attorney !== undefined && body.attorney !== null && typeof body.attorney !== 'string') return { status: 400, error: 'Invalid attorney' };
  if (body.performedByUserId === undefined) {
    return { attorney: body.attorney || req.user.fullName || '',
      performedByUserId: body.attorney === undefined ? req.user.userId : null };
  }
  if (typeof body.performedByUserId !== 'string' || !body.performedByUserId.trim()) {
    return { status: 400, error: 'Invalid performer ID' };
  }
  const performer = await get('SELECT id,fullName,role,isActive FROM users WHERE id=?', [body.performedByUserId]);
  if (!performer || !['admin', 'advocate', 'assistant'].includes(performer.role) || Number(performer.isActive) !== 1) {
    return { status: 400, error: 'Performer must be an active staff user' };
  }
  if (!(await canAccessMatter({ user: { userId: performer.id, fullName: performer.fullName, role: performer.role } }, body.matterId))) {
    return { status: 403, error: 'Performer cannot access this matter' };
  }
  if (body.attorney && body.attorney !== performer.fullName) return { status: 400, error: 'Attorney does not match the selected performer' };
  return { attorney: performer.fullName || '', performedByUserId: performer.id };
}

async function dailyWorkReview({ all, matterAccessScopeSql }, req, date) {
  const scope = matterAccessScopeSql(req, 'm');
  const actorId = req.user.userId;
  // Read one scoped snapshot. No session service calls: even conservative recovery
  // writes belong to the existing work-session GET contract, not this endpoint.
  const rows = await all(`SELECT te.id,te.matterId,m.reference AS matterReference,m.title AS matterTitle,
      te.date,te.activity,te.description,te.hours,te.billable,te.attorney,te.performedByUserId,
      w.userId AS sessionOwner
    FROM time_entries te JOIN matters m ON m.id=te.matterId
    LEFT JOIN work_sessions w ON w.timeEntryId=te.id AND w.status='recorded' AND w.matterId=te.matterId
    WHERE te.date=? AND ${scope.sql} AND (te.performedByUserId=? OR w.userId=?
      OR (te.performedByUserId IS NULL AND w.userId IS NULL AND te.attorney=?))
    ORDER BY m.reference,m.id,te.id`, [date, ...scope.params, actorId, actorId, req.user.fullName || '']);
  const entries = [], unverifiedEntries = [];
  const totals = { billableHours: 0, nonBillableHours: 0, totalHours: 0 };
  for (const row of rows) {
    const stable = row.performedByUserId === actorId, session = row.sessionOwner === actorId;
    const conflict = row.performedByUserId && row.sessionOwner && row.performedByUserId !== row.sessionOwner;
    const confirmed = !conflict && (stable || session);
    const entry = { id: row.id, matterId: row.matterId, matterReference: row.matterReference,
      matterTitle: row.matterTitle, date: row.date, activity: row.activity, description: row.description,
      hours: row.hours, billable: Number(row.billable) === 1,
      source: session && !conflict ? 'persistent_session' : 'unknown',
      attribution: conflict ? 'conflicting_attribution' : stable && session ? 'stable_user_id_and_session_owner'
        : stable ? 'stable_user_id' : session ? 'session_owner' : 'legacy_name_unverified',
      performedByUserId: confirmed ? actorId : null };
    if (!confirmed) { unverifiedEntries.push(entry); continue; }
    entries.push(entry);
    const hours = Number(entry.hours);
    totals[entry.billable ? 'billableHours' : 'nonBillableHours'] += hours;
  }
  totals.totalHours = totals.billableHours + totals.nonBillableHours;
  // Financial values and private session IDs/descriptions are deliberately absent.
  return { date, timeZone, entries, unverifiedEntries, totals };
}

module.exports = { nairobiWorkDate, validWorkDate, manualPerformer, dailyWorkReview };
