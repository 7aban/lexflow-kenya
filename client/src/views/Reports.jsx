import { useEffect, useMemo, useState } from 'react';
import { getDeadlines } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Card, Empty, Stat, Table, kes, isInvoiceOverdue } from '../components/ui.jsx';

// PRODUCT-28B: admin-only, read-only firm reports. All figures are aggregated from
// data already loaded by the staff app (matters, invoices, clients) plus a read-only
// deadlines fetch via the existing apiClient helper. Nothing here mutates state.

// Local CSV helpers (duplicated intentionally to keep this view self-contained and
// avoid widening the blast radius into shared components — mirrors the helpers in
// DeadlineCenter.jsx / StaffViews.jsx).
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

// Whole days from today to a YYYY-MM-DD date: negative = past, 0 = today, positive = future.
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

  // --- Matter pipeline by stage ---
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

  // --- Practice-area mix ---
  const practiceMix = useMemo(() => {
    const counts = new Map();
    matters.forEach(m => {
      const area = (m && m.practiceArea && String(m.practiceArea).trim()) ? String(m.practiceArea).trim() : 'Unspecified';
      counts.set(area, (counts.get(area) || 0) + 1);
    });
    return [...counts.entries()].map(([area, count]) => ({ area, count })).sort((a, b) => b.count - a.count);
  }, [matters]);

  // --- Invoice aging / collections (reuses shared derived-overdue rule) ---
  const aging = useMemo(() => {
    const sum = (rows, field) => rows.reduce((acc, inv) => acc + Number(inv[field] || 0), 0);
    const paid = invoices.filter(i => i.status === 'Paid');
    const unpaid = invoices.filter(i => i.status !== 'Paid');
    const overdue = unpaid.filter(i => i.status === 'Overdue' || isInvoiceOverdue(i));
    const outstanding = unpaid.filter(i => !(i.status === 'Overdue' || isInvoiceOverdue(i)));
    const draft = invoices.filter(i => String(i.status || '').toLowerCase() === 'draft');
    return {
      rows: [
        { bucket: 'Paid', count: paid.length, amount: sum(paid, 'amount') },
        { bucket: 'Overdue', count: overdue.length, amount: sum(overdue, 'balance') },
        { bucket: 'Outstanding (not overdue)', count: outstanding.length, amount: sum(outstanding, 'balance') },
        { bucket: 'Draft', count: draft.length, amount: sum(draft, 'balance') },
      ],
      overdueCount: overdue.length,
      outstandingBalance: sum(unpaid, 'balance'),
    };
  }, [invoices]);

  // --- Deadline compliance ---
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
    <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <Card title="Firm reports" hint="Read-only summary of matters, billing, and obligations">
        {noData && deadlinesState !== 'loading' ? (
          <Empty title="No data to report yet" text="Reports populate automatically once matters, invoices, clients, or deadlines exist." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 12, minWidth: 0 }}>
            <Stat label="Active matters" value={activeMatters} tone="navy" />
            <Stat label="Total clients" value={clients.length} tone="navy" />
            <Stat label="Outstanding balance" value={kes(aging.outstandingBalance)} tone="gold" />
            <Stat label="Overdue invoices" value={aging.overdueCount} tone={aging.overdueCount ? 'red' : 'green'} />
            <Stat
              label="Open deadlines"
              value={deadlinesState === 'ready' ? compliance.openCount : deadlinesState === 'loading' ? '…' : '—'}
              tone={deadlinesState === 'ready' && compliance.openCount ? 'gold' : 'navy'}
            />
          </div>
        )}
      </Card>

      <Card
        title="Matter pipeline"
        hint="Matters grouped by stage"
        action={<ExportButton onClick={exportPipeline} disabled={!pipeline.length} />}
      >
        <Table
          columns={['Stage', 'Matters']}
          rows={pipeline.map(r => [r.stage, String(r.count)])}
          empty="No matters yet"
        />
      </Card>

      <Card
        title="Practice-area mix"
        hint="Matters grouped by practice area"
        action={<ExportButton onClick={exportPractice} disabled={!practiceMix.length} />}
      >
        <Table
          columns={['Practice area', 'Matters']}
          rows={practiceMix.map(r => [r.area, String(r.count)])}
          empty="No matters yet"
        />
      </Card>

      <Card
        title="Invoice aging & collections"
        hint="Derived overdue matches the invoice register; stored statuses are unchanged"
        action={<ExportButton onClick={exportAging} disabled={!invoices.length} />}
      >
        <Table
          columns={['Status', 'Invoices', 'Balance']}
          rows={aging.rows.map(r => [r.bucket, String(r.count), kes(r.amount)])}
          empty="No invoices yet"
        />
      </Card>

      <Card
        title="Deadline compliance"
        hint="Court dates and statutory obligations by urgency"
        action={<ExportButton onClick={exportCompliance} disabled={deadlinesState !== 'ready' || !deadlines.length} />}
      >
        {deadlinesState === 'loading' ? (
          <Empty title="Loading deadlines…" text="Compliance figures will appear shortly." />
        ) : deadlinesState === 'error' ? (
          <Empty title="Deadline data unavailable" text="Deadlines could not be loaded right now. Other reports above are unaffected." />
        ) : (
          <Table
            columns={['Bucket', 'Deadlines']}
            rows={compliance.rows.map(r => [r.bucket, String(r.count)])}
            empty="No deadlines yet"
          />
        )}
      </Card>
    </div>
  );
}
