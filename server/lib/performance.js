module.exports = ({ get, all, today, addDays }) => {
  function monthStart() {
    return `${today().slice(0, 7)}-01`;
  }

  function sixMonthKeys() {
    const keys = [];
    const base = new Date(`${today().slice(0, 7)}-01T00:00:00`);
    for (let index = 5; index >= 0; index -= 1) {
      const date = new Date(base.getFullYear(), base.getMonth() - index, 1);
      keys.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
    }
    return keys;
  }

  async function advocatePerformanceRows() {
    const advocates = await all("SELECT id userId, fullName, email FROM users WHERE role='advocate' ORDER BY fullName");
    const startMonth = monthStart();
    const lastWeek = addDays(-7);
    const rows = [];
    for (const advocate of advocates) {
      const name = advocate.fullName || '';
      const [matterStats, taskStats, timeStats, invoiceStats, courtStats, monthStats, weekStats] = await Promise.all([
        get("SELECT COUNT(*) totalMatters, SUM(CASE WHEN stage<>'Closed' THEN 1 ELSE 0 END) activeMatters FROM matters WHERE assignedTo=?", [name]),
        get('SELECT SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END) completedTasks, SUM(CASE WHEN completed=0 THEN 1 ELSE 0 END) pendingTasks, SUM(CASE WHEN completed=0 AND dueDate<>"" AND dueDate<? THEN 1 ELSE 0 END) overdueTasks FROM tasks WHERE assignee=?', [name, today()]),
        get('SELECT COALESCE(SUM(hours),0) totalHours, COALESCE(SUM(hours*rate),0) billedAmount FROM time_entries WHERE attorney=?', [name]),
        get('SELECT COUNT(i.id) invoicesGenerated FROM invoices i INNER JOIN matters m ON m.id=i.matterId WHERE m.assignedTo=?', [name]),
        get('SELECT COUNT(*) courtAppearances FROM appearances WHERE attorney=? AND date>=?', [name, today()]),
        get('SELECT COALESCE(SUM(hours),0) thisMonthHours, COALESCE(SUM(hours*rate),0) thisMonthRevenue FROM time_entries WHERE attorney=? AND date>=?', [name, startMonth]),
        get('SELECT COALESCE(SUM(hours),0) last7Hours FROM time_entries WHERE attorney=? AND date>=?', [name, lastWeek]),
      ]);
      rows.push({
        ...advocate,
        activeMatters: Number(matterStats?.activeMatters || 0),
        totalMatters: Number(matterStats?.totalMatters || 0),
        completedTasks: Number(taskStats?.completedTasks || 0),
        pendingTasks: Number(taskStats?.pendingTasks || 0),
        overdueTasks: Number(taskStats?.overdueTasks || 0),
        totalHours: Number(timeStats?.totalHours || 0),
        billedAmount: Number(timeStats?.billedAmount || 0),
        invoicesGenerated: Number(invoiceStats?.invoicesGenerated || 0),
        courtAppearances: Number(courtStats?.courtAppearances || 0),
        thisMonthHours: Number(monthStats?.thisMonthHours || 0),
        thisMonthRevenue: Number(monthStats?.thisMonthRevenue || 0),
        last7Hours: Number(weekStats?.last7Hours || 0),
      });
    }
    return rows;
  }

  let performanceCache = { timestamp: 0, rows: null };

  async function cachedAdvocatePerformance(force = false) {
    const now = Date.now();
    if (!force && performanceCache.rows && now - performanceCache.timestamp < 5 * 60 * 1000) return performanceCache.rows;
    const rows = await advocatePerformanceRows();
    performanceCache = { timestamp: now, rows };
    return rows;
  }

  async function advocatePerformanceDetail(fullName) {
    const monthKeys = sixMonthKeys();
    const startMonth = `${monthKeys[0]}-01`;
    const [activeMatters, monthlyRows, recentTimeEntries] = await Promise.all([
      all(`SELECT m.id,m.title,m.reference,m.stage,(SELECT MIN(a.date) FROM appearances a WHERE a.matterId=m.id AND a.date>=?) nextCourtDate
        FROM matters m WHERE m.assignedTo=? AND m.stage<>'Closed' ORDER BY m.openDate DESC`, [today(), fullName || '']),
      all(`SELECT substr(date,1,7) month, COALESCE(SUM(hours),0) hours, COALESCE(SUM(hours*rate),0) revenue
        FROM time_entries WHERE attorney=? AND date>=? GROUP BY substr(date,1,7) ORDER BY month`, [fullName || '', startMonth]),
      all(`SELECT t.*, m.title matterTitle, m.reference, task.title taskTitle
        FROM time_entries t
        LEFT JOIN matters m ON m.id=t.matterId
        LEFT JOIN tasks task ON task.id=t.taskId
        WHERE t.attorney=?
        ORDER BY t.date DESC, t.id DESC
        LIMIT 10`, [fullName || '']),
    ]);
    const monthlyBreakdown = monthKeys.map(month => {
      const row = monthlyRows.find(item => item.month === month) || {};
      return { month, hours: Number(row.hours || 0), revenue: Number(row.revenue || 0) };
    });
    return { activeMatterList: activeMatters, monthlyBreakdown, recentTimeEntries };
  }

  return { monthStart, sixMonthKeys, advocatePerformanceRows, cachedAdvocatePerformance, advocatePerformanceDetail };
};
