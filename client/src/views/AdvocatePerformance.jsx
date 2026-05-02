import { useEffect, useMemo, useState } from 'react';
import { getAdvocatePerformance, getAdvocatePerformanceDetail } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Alert, Badge, Card, Empty, Field, kes, Skeleton, Stat, Table } from '../components/ui.jsx';

function num(value) {
  return Number(value || 0);
}

function fmtHours(value) {
  return num(value).toFixed(1);
}

function sortValue(row, key) {
  if (key === 'name') return row.fullName || '';
  return num(row[key]);
}

function monthLabel(month) {
  if (!month) return '-';
  const date = new Date(`${month}-01T00:00:00`);
  return Number.isNaN(date.getTime()) ? month : date.toLocaleDateString('en-KE', { month: 'short' });
}

export default function AdvocatePerformance({ notify }) {
  const [advocates, setAdvocates] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState({ key: 'thisMonthHours', dir: 'desc' });
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => { load(false); }, []);

  async function load(refresh = false) {
    setLoading(true);
    try {
      setAdvocates(await getAdvocatePerformance(refresh));
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setLoading(false);
    }
  }

  async function openDetail(advocate, refresh = false) {
    setSelected(advocate);
    setDetailLoading(true);
    try {
      setDetail(await getAdvocatePerformanceDetail(advocate.userId, refresh));
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setDetailLoading(false);
    }
  }

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const rows = needle ? advocates.filter(row => `${row.fullName} ${row.email}`.toLowerCase().includes(needle)) : advocates;
    return [...rows].sort((a, b) => {
      const left = sortValue(a, sort.key);
      const right = sortValue(b, sort.key);
      const result = typeof left === 'string' ? left.localeCompare(right) : left - right;
      return sort.dir === 'asc' ? result : -result;
    });
  }, [advocates, filter, sort]);

  const totals = useMemo(() => ({
    advocates: advocates.length,
    activeMatters: advocates.reduce((sum, row) => sum + num(row.activeMatters), 0),
    monthHours: advocates.reduce((sum, row) => sum + num(row.thisMonthHours), 0),
    monthRevenue: advocates.reduce((sum, row) => sum + num(row.thisMonthRevenue), 0),
  }), [advocates]);

  const alerts = advocates.flatMap(row => {
    const items = [];
    if (num(row.overdueTasks) > 3) items.push(`${row.fullName} has ${row.overdueTasks} overdue tasks.`);
    if (num(row.last7Hours) === 0) items.push(`${row.fullName} has no time logged in the last 7 days.`);
    return items;
  });

  function setSortKey(key) {
    setSort(current => ({ key, dir: current.key === key && current.dir === 'desc' ? 'asc' : 'desc' }));
  }

  const tableRows = visible.map(row => [
    <button key={`${row.userId}-name`} type="button" style={{ ...styles.tinyButton, fontWeight: 800 }} onClick={() => openDetail(row)}>{row.fullName}</button>,
    row.activeMatters,
    <span key={`${row.userId}-tasks`}>
      <strong>{row.completedTasks}</strong> / {row.pendingTasks}
      {num(row.overdueTasks) > 0 && <Badge tone="red">{row.overdueTasks} overdue</Badge>}
    </span>,
    fmtHours(row.thisMonthHours),
    kes(row.thisMonthRevenue),
    row.courtAppearances,
  ]);

  return (
    <div style={styles.pageStack}>
      <div style={styles.statsGrid}>
        <Stat label="Advocates" value={totals.advocates} tone="navy" />
        <Stat label="Active matters" value={totals.activeMatters} tone="gold" />
        <Stat label="Month hours" value={fmtHours(totals.monthHours)} tone="green" />
        <Stat label="Month revenue" value={kes(totals.monthRevenue)} tone="red" />
      </div>

      {alerts.length > 0 && (
        <Alert tone="danger">
          {alerts.slice(0, 4).map(item => <div key={item}>{item}</div>)}
          {alerts.length > 4 && <div>{alerts.length - 4} more performance alerts require review.</div>}
        </Alert>
      )}

      <Card
        title="Advocate Performance"
        hint="Caseload, task execution, time capture and upcoming court attendance."
        action={<button type="button" style={styles.ghostButton} disabled={loading} onClick={() => load(true)}>{loading ? 'Refreshing...' : 'Refresh'}</button>}
      >
        <div style={{ ...styles.formGrid, marginBottom: 14 }}>
          <Field label="Filter">
            <input style={styles.input} value={filter} onChange={event => setFilter(event.target.value)} placeholder="Search advocate name or email" />
          </Field>
          <Field label="Sort">
            <select style={styles.input} value={sort.key} onChange={event => setSortKey(event.target.value)}>
              <option value="thisMonthHours">Month hours</option>
              <option value="thisMonthRevenue">Month revenue</option>
              <option value="activeMatters">Active matters</option>
              <option value="overdueTasks">Overdue tasks</option>
              <option value="courtAppearances">Court appearances</option>
              <option value="name">Name</option>
            </select>
          </Field>
        </div>
        {loading ? <Skeleton rows={3} /> : (
          <Table
            columns={['Name', 'Active Matters', 'Tasks Done / Pending', 'Hours This Month', 'Revenue This Month', 'Upcoming Court']}
            rows={tableRows}
            empty="No advocate users found."
          />
        )}
      </Card>
      <PerformanceDrawer advocate={selected} detail={detail} loading={detailLoading} onClose={() => { setSelected(null); setDetail(null); }} />
    </div>
  );
}

function PerformanceDrawer({ advocate, detail, loading, onClose }) {
  const open = Boolean(advocate);
  const chart = detail?.monthlyBreakdown || [];
  const maxHours = Math.max(1, ...chart.map(row => num(row.hours)));
  const maxRevenue = Math.max(1, ...chart.map(row => num(row.revenue)));

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: open ? 2600 : -1,
          pointerEvents: open ? 'auto' : 'none',
          background: open ? 'rgba(15,27,51,.18)' : 'rgba(15,27,51,0)',
          transition: 'background .18s ease',
        }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          zIndex: 2700,
          width: 560,
          maxWidth: 'calc(100vw - 24px)',
          background: '#fff',
          borderLeft: `1px solid ${theme.line}`,
          boxShadow: theme.shadowLift,
          transform: open ? 'translateX(0)' : 'translateX(105%)',
          transition: 'transform .22s ease',
          display: 'grid',
          gridTemplateRows: 'auto 1fr',
        }}
      >
        <div style={{ padding: 18, borderBottom: `1px solid ${theme.line}`, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <div>
            <div style={styles.eyebrow}>Advocate detail</div>
            <h2 style={{ margin: '2px 0 0', fontSize: 18 }}>{advocate?.fullName || 'Advocate'}</h2>
            <p>{advocate?.email || ''}</p>
          </div>
          <button type="button" aria-label="Close performance detail" onClick={onClose} style={styles.toastClose}>x</button>
        </div>
        <div style={{ padding: 18, overflowY: 'auto', display: 'grid', gap: 16 }}>
          {loading ? <Skeleton rows={3} /> : detail ? (
            <>
              <div style={styles.statsGrid}>
                <Stat label="Active" value={detail.activeMatters} tone="navy" />
                <Stat label="Month hrs" value={fmtHours(detail.thisMonthHours)} tone="green" />
                <Stat label="Revenue" value={kes(detail.thisMonthRevenue)} tone="gold" />
              </div>
              <Card title="Six-month output" hint="Hours and revenue trend">
                <div style={{ display: 'grid', gap: 12 }}>
                  {chart.map(row => (
                    <div key={row.month} style={{ display: 'grid', gridTemplateColumns: '44px 1fr 90px', gap: 10, alignItems: 'center' }}>
                      <strong>{monthLabel(row.month)}</strong>
                      <div style={{ display: 'grid', gap: 5 }}>
                        <div style={{ height: 8, borderRadius: 999, background: '#EEF2F7', overflow: 'hidden' }}><div style={{ width: `${(num(row.hours) / maxHours) * 100}%`, height: '100%', background: theme.green }} /></div>
                        <div style={{ height: 8, borderRadius: 999, background: '#EEF2F7', overflow: 'hidden' }}><div style={{ width: `${(num(row.revenue) / maxRevenue) * 100}%`, height: '100%', background: theme.gold }} /></div>
                      </div>
                      <span style={{ color: theme.muted, fontSize: 12 }}>{fmtHours(row.hours)}h</span>
                    </div>
                  ))}
                </div>
              </Card>
              <Card title="Active matters" hint="Assigned files still open">
                <Table columns={['Matter', 'Stage', 'Next Court']} rows={(detail.activeMatterList || []).map(matter => [matter.title, <Badge key={matter.id} tone="blue">{matter.stage || 'Active'}</Badge>, matter.nextCourtDate || '-'])} empty="No active matters assigned." />
              </Card>
              <Card title="Recent time entries" hint="Last 10 records">
                <Table columns={['Date', 'Matter', 'Task', 'Hours', 'Amount']} rows={(detail.recentTimeEntries || []).map(entry => [entry.date || '-', entry.matterTitle || entry.reference || '-', entry.taskTitle || '-', fmtHours(entry.hours), kes(num(entry.hours) * num(entry.rate))])} empty="No time entries recorded." />
              </Card>
            </>
          ) : <Empty title="No detail loaded" text="Select an advocate to view their performance profile." />}
        </div>
      </aside>
    </>
  );
}
