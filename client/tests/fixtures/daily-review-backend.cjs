const path = require('path');
const backend = require('./work-session-backend.cjs');
const { createWorkSessions } = require(path.resolve(__dirname, '../../../server/lib/workSessions'));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
module.exports = async function dailyBackend() {
  const fixture = await backend();
  const insert = (table, row) => fixture.run(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row));
  return { ...fixture, today,
    async seedRecorded() {
      const base = { matterId: '104b-A', attorney: 'Timer Advocate', date: today(), hours: 1.25, activity: 'Drafting', description: 'Stably attributed manual drafting', rate: 7500, billed: 0, billable: 1, performedByUserId: '104b-a' };
      for (const row of [
        { ...base, id: 'daily-manual' },
        { ...base, id: 'daily-missing', matterId: '104b-B', hours: 0.5, billable: 0, description: '   ' },
        { ...base, id: 'daily-legacy', hours: 8, performedByUserId: null, description: 'Legacy unverified preparation' },
        { ...base, id: 'daily-conflict', hours: 7, description: 'Conflicting performer evidence' },
        { ...base, id: 'daily-other', hours: 6, performedByUserId: '104b-b', description: 'Other worker private work' },
        { ...base, id: 'daily-hidden', matterId: '104b-hidden', hours: 5, description: 'Inaccessible recorded work' },
        { ...base, id: 'daily-historical', date: '2024-02-29', hours: 0.1234567, description: 'Historical saved work date' },
      ]) await insert('time_entries', row);
      let now = Date.now() - 100000;
      const service = createWorkSessions({ databasePath: fixture.databasePath, now: () => now });
      const req = { user: { userId: '104b-a', role: 'advocate', fullName: 'Timer Advocate', tokenVersion: 1 }, headers: {} };
      let session = await service.start(req, { matterId: '104b-A', activity: 'Document Review', description: 'Session-linked recorded review' });
      now += 90000;
      session = await service.transition(req, session.id, 'pause', { version: session.version });
      const entry = await service.record(req, session.id, { version: session.version, billable: true, date: today() });
      const stamp = new Date().toISOString();
      await insert('work_sessions', { id: 'daily-conflicting-link', userId: '104b-b', matterId: '104b-A', activity: 'Other', description: 'Private session narrative must not be returned', status: 'recorded', accumulatedSeconds: 25200, createdAt: stamp, updatedAt: stamp, version: 1, timeEntryId: 'daily-conflict' });
      return { entry, expectedTotal: 1.775 };
    },
    async seedOutstanding() {
      const stamp = new Date(Date.now() - 7 * 86400000).toISOString();
      const base = { userId: '104b-a', matterId: '104b-B', activity: 'Preparation', status: 'paused', accumulatedSeconds: 80, createdAt: stamp, updatedAt: stamp, version: 1 };
      await insert('work_sessions', { ...base, id: 'daily-paused', description: 'Older paused preparation' });
      await insert('work_sessions', { ...base, id: 'daily-recovery', description: 'Interrupted preparation', recoveryRequired: 1, uncertainSeconds: 900, uncertainSince: Date.now() - 900000 });
      await insert('work_sessions', { ...base, id: 'daily-running', matterId: '104b-A', description: 'Current running research', status: 'running', segmentStartedAt: Date.now() - 20000, lastConfirmedAt: Date.now() - 20000, accumulatedSeconds: 30 });
    },
  };
};
