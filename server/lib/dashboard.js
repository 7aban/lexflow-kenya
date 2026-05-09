module.exports = ({ get, all, today, isBillingVisibleFor }) => {
  async function advocateDashboard(fullName, req) {
    const name = fullName || '';
    const [active, hours, overdue, upcomingEvents] = await Promise.all([
      get("SELECT COUNT(*) count FROM matters WHERE stage NOT IN ('Closed','On Hold') AND assignedTo=?", [name]),
      get("SELECT COALESCE(SUM(hours),0) hours, COALESCE(SUM(hours*rate),0) revenue FROM time_entries WHERE date LIKE ? AND attorney=? AND billable=1", [`${today().slice(0, 7)}%`, name]),
      get('SELECT COUNT(*) count FROM tasks WHERE completed=0 AND dueDate < ? AND assignee=?', [today(), name]),
      all('SELECT * FROM appearances WHERE date >= ? AND attorney=? ORDER BY date LIMIT 5', [today(), name]),
    ]);
    const billingVisible = req ? await isBillingVisibleFor(req) : true;
    return {
      activeMattersCount: active.count,
      monthHours: hours.hours,
      monthRevenue: billingVisible ? hours.revenue : 0,
      overdueTaskCount: overdue.count,
      upcomingEvents,
    };
  }

  async function staffDashboard() {
    const [active, hours, overdue, upcomingEvents] = await Promise.all([
      get("SELECT COUNT(*) count FROM matters WHERE stage NOT IN ('Closed','On Hold')"),
      get("SELECT COALESCE(SUM(hours),0) hours, COALESCE(SUM(hours*rate),0) revenue FROM time_entries WHERE date LIKE ? AND billable=1", [`${today().slice(0, 7)}%`]),
      get('SELECT COUNT(*) count FROM tasks WHERE completed=0 AND dueDate < ?', [today()]),
      all('SELECT * FROM appearances WHERE date >= ? ORDER BY date LIMIT 5', [today()]),
    ]);
    return {
      activeMattersCount: active.count,
      monthHours: hours.hours,
      monthRevenue: hours.revenue,
      overdueTaskCount: overdue.count,
      upcomingEvents,
    };
  }

  return { advocateDashboard, staffDashboard };
};
