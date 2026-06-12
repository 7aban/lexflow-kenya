import { useEffect, useMemo, useState } from 'react';
import { getDeadlines } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Card, Empty, Stat, Table, kes, isInvoiceOverdue } from '../components/ui.jsx';

// PRODUCT-28B: admin-only, read-only firm reports. All figures are aggregated from
// data already loaded by the staff app (matters, invoices, clients) plus a read-only
// deadlines fetch via the existing apiClient helper. Nothing here mutates state.

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text.replace(/^ +/, ''))) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function downloadCsv(filename, columns, rows) {
  if (!rows.length) return;
  const csv = [columns, ...rows].map(cells => cells.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function dayDiff(date) {
  const raw = date ? String(date).slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  const due = new Date(y, m - 1, d);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}

function ExportButton({ onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{ ...styles.ghostButton, fontSize: 12, padding: '5px 12px', opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      Export CSV
    </button>
  );
}

function maxValue(rows, key = 'count') {
  return Math.max(1, ...rows.map(row => Number(row[key] || 0)));
}

function ReportBars({ rows, valueKey = 'count', formatValue = value => value, tone = 'gold', emptyTitle, emptyText }) {
  const max = maxValue(rows, valueKey);
  const fill = tone === 'red' ? theme.red : tone === 'green' ? theme.green : tone === 'blue' ? theme.blue : theme.gold;
  if (!rows.length) return <Empty title={emptyTitle} text={emptyText} />;
  return (
    <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
      {rows.map(row => {
        const rawValue = Number(row[valueKey] || 0);
        const width = `${Math.max(rawValue > 0 ? 5 : 0, Math.round((rawValue / max) * 100))}%`;
        return (
          <div key={row.label} style={{ display: 'grid', gap: 5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: theme.ink, minWidth: 0, overflowWrap: 'anywhere' }}>{row.label}</span>
              <span style={{ fontSize: 12, color: theme.muted, whiteSpace: 'nowrap' }}>{formatValue(rawValue, row)}</span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: '#EEF2F7', overflow: 'hidden' }} aria-hidden="true">
              <div style={{ width, height: '100%', borderRadius: 999, background: fill }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function reportTable(className, columns, rows, empty) {
  const labelledRows = rows.map(row => row.map((cell, index) => (
    <span key={`${columns[index]}-${index}`} className="lf-report-cell">
      <span className="lf-report-mobile-label">{columns[index]}</span>
      <span>{cell}</span>
    </span>
  )));
  return (
    <div className={className}>
      <Table columns={columns} rows={labelledRows} empty={empty} />
    </div>
  );
}

export default function Reports({ data = {}, notify }) {
  const matters = Array.isArray(data.matters) ? data.matters : [];
  const invoices = Array.isArray(data.invoices) ? data.invoices : [];
  const clients = Array.isArray(data.clients) ? data.clients : [];

  const [deadlines, setDeadlines] = useState([]);
  const [deadlinesState, setDeadlinesState] = useState('loading'); // loading | ready | error

  useEffect(() => {
    let active = true;
    setDeadlinesState('loading');
    getDeadlines()
      .then(rows => {
        if (!active) return;
        setDeadlines(Array.isArray(rows) ? rows : []);
        setDeadlinesState('ready');
      })
      .catch(() => {
        if (!active) return;
        setDeadlines([]);
        setDeadlinesState('error');
      });
    return () => { active = false; };
  }, []);

  const pipeline = useMemo(() => {
    const counts = new Map();
    matters.forEach(m => {
      const stage = (m && m.stage) ? String(m.stage) : 'Intake';
      counts.set(stage, (counts.get(stage) || 0) + 1);
    });
    return [...counts.entries()].map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count);
  }, [matters]);

  const activeMatters = useMemo(
    () => matters.filter(m => String((m && m.stage) || 'Intake').toLowerCase() !== 'closed').length,
    [matters],
  );

  const closedMatters = Math.max(0, matters.length - activeMatters);

  const practiceMix = useMemo(() => {
    const counts = new Map();
    matters.forEach(m => {
      const area = (m && m.practiceArea && String(m.practiceArea).trim()) ? String(m.practiceArea).trim() : 'Unspecified';
      counts.set(area, (counts.get(area) || 0) + 1);
    });
    return [...counts.entries()].map(([area, count]) => ({ area, count })).sort((a, b) => b.count - a.count);
  }, [matters]);

  const aging = useMemo(() => {
    const sum = (rows, field) => rows.reduce((acc, inv) => acc + Number(inv[field] || 0), 0);
    const paid = invoices.filter(i => i.status === 'Paid');
    const unpaid = invoices.filter(i => i.status !== 'Paid');
    const overdue = unpaid.filter(i => i.status === 'Overdue' || isInvoiceOverdue(i));
    const outstanding = unpaid.filter(i => !(i.status === 'Overdue' || isInvoiceOverdue(i)) && String(i.status || '').toLowerCase() !== 'draft');
    const draft = invoices.filter(i => String(i.status || '').toLowerCase() === 'draft');
    const billedTotal = sum(invoices, 'amount');
    const collectedTotal = sum(paid, 'amount');
    const outstandingBalance = sum(unpaid, 'balance');
    return {
      rows: [
        { bucket: 'Collected', count: paid.length, amount: collectedTotal },
        { bucket: 'Overdue', count: overdue.length, amount: sum(overdue, 'balance') },
        { bucket: 'Outstanding', count: outstanding.length, amount: sum(outstanding, 'balance') },
        { bucket: 'Draft', count: draft.length, amount: sum(draft, 'balance') },
      ],
      overdueCount: overdue.length,
      outstandingBalance,
      billedTotal,
      collectedTotal,
    };
  }, [invoices]);

  const compliance = useMemo(() => {
    const isDone = row => String(row.status || '').toLowerCase() === 'done';
    let overdue = 0;
    let dueSoon = 0;
    let upcoming = 0;
    let completed = 0;
    deadlines.forEach(row => {
      if (isDone(row)) { completed += 1; return; }
      const days = dayDiff(row.dueDate);
      if (days === null) { upcoming += 1; return; }
      if (days < 0) overdue += 1;
      else if (days <= 7) dueSoon += 1;
      else upcoming += 1;
    });
    return {
      rows: [
        { bucket: 'Overdue', count: overdue },
        { bucket: 'Due within 7 days', count: dueSoon },
        { bucket: 'Upcoming', count: upcoming },
        { bucket: 'Completed', count: completed },
      ],
      openCount: overdue + dueSoon + upcoming,
    };
  }, [deadlines]);

  const noData = matters.length === 0 && invoices.length === 0 && clients.length === 0 && deadlines.length === 0;
  const pipelineBars = pipeline.map(row => ({ label: row.stage, count: row.count }));
  const practiceBars = practiceMix.map(row => ({ label: row.area, count: row.count }));
  const agingBars = aging.rows.map(row => ({ label: row.bucket, amount: row.amount, count: row.count }));
  const complianceBars = compliance.rows.map(row => ({ label: row.bucket, count: row.count }));

  function exportPipeline() {
    downloadCsv('matter-pipeline.csv', ['Stage', 'Matters'], pipeline.map(r => [r.stage, r.count]));
    notify?.({ type: 'success', message: 'Matter pipeline exported.' });
  }
  function exportPractice() {
    downloadCsv('practice-area-mix.csv', ['Practice area', 'Matters'], practiceMix.map(r => [r.area, r.count]));
    notify?.({ type: 'success', message: 'Practice-area mix exported.' });
  }
  function exportAging() {
    downloadCsv('invoice-aging.csv', ['Status', 'Invoices', 'Balance (KSh)'], aging.rows.map(r => [r.bucket, r.count, Number(r.amount || 0)]));
    notify?.({ type: 'success', message: 'Invoice aging exported.' });
  }
  function exportCompliance() {
    downloadCsv('deadline-compliance.csv', ['Bucket', 'Deadlines'], compliance.rows.map(r => [r.bucket, r.count]));
    notify?.({ type: 'success', message: 'Deadline compliance exported.' });
  }

  return (
    <div className="lf-reports-page" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <Card title="Reports overview" hint="Billing, collections, matter activity, and workload trends from current LexFlow records.">
        {noData && deadlinesState !== 'loading' ? (
          <Empty title="No report data yet" text="Reports populate once matters, invoices, clients, or deadlines are recorded." />
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            <p style={{ margin: 0, color: theme.muted, maxWidth: 760 }}>
              Use these read-only summaries for partner review. Billed is the total invoice amount, collected is paid invoices, and outstanding is the unpaid balance.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 12, minWidth: 0 }}>
              <Stat label="Open matters" value={activeMatters} tone="navy" />
              <Stat label="Closed matters" value={closedMatters} tone="green" />
              <Stat label="Billed" value={kes(aging.billedTotal)} tone="navy" />
              <Stat label="Collected" value={kes(aging.collectedTotal)} tone="green" />
              <Stat label="Outstanding" value={kes(aging.outstandingBalance)} tone={aging.outstandingBalance ? 'gold' : 'green'} />
              <Stat label="Overdue invoices" value={aging.overdueCount} tone={aging.overdueCount ? 'red' : 'green'} />
              <Stat
                label="Open deadlines"
                value={deadlinesState === 'ready' ? compliance.openCount : deadlinesState === 'loading' ? '...' : '-'}
                tone={deadlinesState === 'ready' && compliance.openCount ? 'gold' : 'navy'}
              />
            </div>
          </div>
        )}
      </Card>

      <div className="lf-split-grid" style={styles.splitGrid}>
        <Card
          title="Matter activity"
          hint="Open and closed matters grouped by current stage."
          action={<ExportButton onClick={exportPipeline} disabled={!pipeline.length} />}
        >
          <ReportBars
            rows={pipelineBars}
            emptyTitle="No matter activity yet"
            emptyText="Matter activity appears after client matters are opened."
          />
          {reportTable(
            'lf-report-cards lf-report-pipeline-cards',
            ['Stage', 'Matters'],
            pipeline.map(r => [r.stage, String(r.count)]),
            'No matters yet',
          )}
        </Card>

        <Card
          title="Workload by practice area"
          hint="Matter count by practice area, using the matter profile value where available."
          action={<ExportButton onClick={exportPractice} disabled={!practiceMix.length} />}
        >
          <ReportBars
            rows={practiceBars}
            tone="blue"
            emptyTitle="No practice-area records yet"
            emptyText="Practice-area mix appears after matters are created and classified."
          />
          {reportTable(
            'lf-report-cards lf-report-practice-cards',
            ['Practice area', 'Matters'],
            practiceMix.map(r => [r.area, String(r.count)]),
            'No matters yet',
          )}
        </Card>
      </div>

      <Card
        title="Billing and collections"
        hint="Billed, collected, outstanding, overdue, and draft invoice balances. Unpaid invoices are not counted as collected."
        action={<ExportButton onClick={exportAging} disabled={!invoices.length} />}
      >
        <ReportBars
          rows={agingBars}
          valueKey="amount"
          tone={aging.overdueCount ? 'red' : 'green'}
          formatValue={value => kes(value)}
          emptyTitle="No billing data yet"
          emptyText="Billing reports appear after invoices are generated or marked paid."
        />
        {reportTable(
          'lf-report-cards lf-report-aging-cards',
          ['Status', 'Invoices', 'Amount'],
          aging.rows.map(r => [r.bucket, String(r.count), kes(r.amount)]),
          'No invoices yet',
        )}
      </Card>

      <Card
        title="Deadline workload"
        hint="Court dates, filing dates, and statutory obligations grouped by urgency."
        action={<ExportButton onClick={exportCompliance} disabled={deadlinesState !== 'ready' || !deadlines.length} />}
      >
        {deadlinesState === 'loading' ? (
          <Empty title="Loading deadline workload" text="Deadline and court diary figures will appear shortly." />
        ) : deadlinesState === 'error' ? (
          <Empty title="Deadline data unavailable" text="Deadlines could not be loaded right now. Other reports above are unaffected." />
        ) : (
          <>
            <ReportBars
              rows={complianceBars}
              tone={compliance.rows.some(row => row.bucket === 'Overdue' && row.count > 0) ? 'red' : 'gold'}
              emptyTitle="No deadline workload yet"
              emptyText="Deadline workload appears after court dates, task due dates, invoices, or custom deadlines exist."
            />
            {reportTable(
              'lf-report-cards lf-report-compliance-cards',
              ['Bucket', 'Deadlines'],
              compliance.rows.map(r => [r.bucket, String(r.count)]),
              'No deadlines yet',
            )}
          </>
        )}
      </Card>
    </div>
  );
}
