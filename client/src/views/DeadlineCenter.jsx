import { useCallback, useEffect, useMemo, useState } from 'react';
import { createDeadline, deleteDeadline, getComplianceGuidance, getDeadlines, updateDeadline } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Badge, Card, ConfirmModal, Empty, Field, Skeleton, Stat, Table } from '../components/ui.jsx';

const blankForm = { title: '', type: 'statutory', dueDate: '', owner: '', matterId: '', clientId: '', notes: '' };
const typeOptions = ['all', 'Court Date', 'Internal Task', 'SOL / Limitation', 'Invoice Due', 'client', 'internal', 'statutory', 'tax', 'regulatory'];

function dayDiff(date) {
  if (!date) return null;
  const start = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00`);
  const end = new Date(`${date}T00:00:00`);
  if (Number.isNaN(end.getTime())) return null;
  return Math.round((end - start) / 86400000);
}

function deadlineTone(row) {
  if (row.status === 'Done') return 'green';
  const days = dayDiff(row.dueDate);
  if (days !== null && days < 0) return 'red';
  if (days !== null && days <= 7) return 'amber';
  return 'blue';
}

function guidanceTone(tone) {
  if (tone === 'danger') return 'red';
  if (tone === 'success') return 'green';
  if (tone === 'warning') return 'amber';
  return 'blue';
}

function prettyType(value) {
  return String(value || '-').replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function dueLabel(date) {
  const days = dayDiff(date);
  if (days === null) return date || '-';
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

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

export default function DeadlineCenter({ data, canManage, notify, focus }) {
  const [deadlines, setDeadlines] = useState([]);
  const [guidance, setGuidance] = useState([]);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [filters, setFilters] = useState({ type: '', status: '' });
  const [form, setForm] = useState(blankForm);
  const [confirm, setConfirm] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [deadlineRows, guidanceRows] = await Promise.all([
        getDeadlines({ type: filters.type, status: filters.status }),
        getComplianceGuidance(),
      ]);
      setDeadlines(deadlineRows);
      setGuidance(guidanceRows);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [filters.type, filters.status]);
  useEffect(() => {
    if (!focus?.appearanceId) return;
    const targetId = `appearance:${focus.appearanceId}`;
    const el = document.getElementById(`deadline-${targetId}`);
    if (el) {
      const prev = el.style.background;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.background = 'rgba(212, 163, 74, 0.15)';
      setTimeout(() => { el.style.background = prev; }, 1200);
    }
  }, [deadlines, focus?.appearanceId, focus?.ts]);

  const summary = useMemo(() => {
    const open = deadlines.filter(row => row.status !== 'Done');
    return {
      overdue: open.filter(row => dayDiff(row.dueDate) < 0).length,
      week: open.filter(row => {
        const days = dayDiff(row.dueDate);
        return days !== null && days >= 0 && days <= 7;
      }).length,
      month: open.filter(row => {
        const days = dayDiff(row.dueDate);
        return days !== null && days >= 0 && days <= 30;
      }).length,
      open: open.length,
    };
  }, [deadlines]);

  const scrollToTimeline = useCallback(() => {
    const el = document.querySelector('.lf-deadline-cards');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const courtItems = useMemo(() => {
    return (deadlines || []).filter(d => d.type === 'Court Date' && d.status !== 'Done');
  }, [deadlines]);

  const todayIso = new Date().toISOString().slice(0, 10);

  const upcomingCourtItems = useMemo(() => {
    return (courtItems || [])
      .filter(d => d && d.dueDate && d.dueDate >= todayIso)
      .slice()
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
      .slice(0, 5);
  }, [courtItems, todayIso]);

  const todayCourtItems = useMemo(() => {
    return courtItems.filter(d => d.dueDate === todayIso);
  }, [courtItems, todayIso]);

  const weekCourtCount = useMemo(() => {
    const weekLater = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    return courtItems.filter(d => d.dueDate && d.dueDate >= todayIso && d.dueDate <= weekLater).length;
  }, [courtItems, todayIso]);

  async function submit(event) {
    event.preventDefault();
    if (!canManage) return notify?.({ type: 'warning', message: 'Only advocates and admins can add custom deadlines.' });
    setSaving(true);
    try {
      await createDeadline({
        ...form,
        matterId: form.matterId || null,
        clientId: form.clientId || null,
      });
      setForm(blankForm);
      notify?.({ type: 'success', message: 'Deadline added.' });
      await load();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(row, status) {
    try {
      await updateDeadline(row.sourceId, { status });
      setDeadlines(current => current.map(item => item.id === row.id ? { ...item, status } : item));
      notify?.({ type: 'success', message: status === 'Done' ? 'Deadline marked done.' : 'Deadline reopened.' });
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
      await load();
    }
  }

  async function remove(row) {
    try {
      await deleteDeadline(row.sourceId);
      setDeadlines(current => current.filter(item => item.id !== row.id));
      notify?.({ type: 'success', message: 'Deadline deleted.' });
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    }
  }

  const matterOptions = data.matters || [];
  const clientOptions = data.clients || [];
  const rows = deadlines.map(row => [
    <div key={`${row.id}-due`} style={{ display: 'grid', gap: 2 }}>
      <strong>{row.dueDate || '-'}</strong>
      <span style={{ color: theme.muted, fontSize: 12 }}>{dueLabel(row.dueDate)}</span>
    </div>,
    <Badge key={`${row.id}-type`} tone={deadlineTone(row)}>{prettyType(row.type)}</Badge>,
    <div key={`${row.id}-title`} style={{ display: 'grid', gap: 3 }}>
      <strong>{row.title}</strong>
      {row.notes && <span style={{ color: theme.muted, fontSize: 12 }}>{row.notes}</span>}
    </div>,
    row.matterTitle || row.reference || row.clientName || '-',
    row.owner || '-',
    <Badge key={`${row.id}-status`} tone={row.status === 'Done' ? 'green' : deadlineTone(row)}>{row.status || 'Open'}</Badge>,
    row.source === 'custom' && canManage ? (
      <div key={`${row.id}-actions`} style={styles.actionGroup}>
        <button type="button" style={styles.tinyButton} onClick={() => setStatus(row, row.status === 'Done' ? 'Open' : 'Done')}>
          {row.status === 'Done' ? 'Reopen' : 'Done'}
        </button>
        <button type="button" style={styles.dangerTinyButton} onClick={() => setConfirm({ title: 'Delete deadline?', message: `Delete "${row.title}"?`, onConfirm: () => remove(row) })}>Delete</button>
      </div>
    ) : <span key={`${row.id}-system`} style={styles.mutedText}>System</span>,
  ]);

  return (
    <div style={styles.pageStack}>
      <div style={styles.statsGrid}>
        <Stat label="Overdue" value={summary.overdue} tone="red" />
        <Stat label="Next 7 days" value={summary.week} tone="gold" />
        <Stat label="Next 30 days" value={summary.month} tone="gold" />
        <Stat label="Open deadlines" value={summary.open} tone="navy" />
      </div>

      <div style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <strong style={{ fontSize: 15 }}>Court diary</strong>
          {courtItems.length > 0 && <button type="button" onClick={scrollToTimeline} style={styles.ghostButton}>View in timeline</button>}
        </div>
        {upcomingCourtItems.length ? (
          <>
            <div style={{ display: 'grid', gap: 8 }}>
              {upcomingCourtItems.map((item, index) => {
                const isToday = item.dueDate === todayIso;
                return (
                  <div key={item.id || `${item.dueDate}-${index}`} style={{ border: `1px solid ${theme.line}`, borderRadius: 8, padding: 14, display: 'grid', gap: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <Badge tone={isToday ? 'red' : 'blue'}>{isToday ? 'Today' : index === 0 ? 'Next court date' : dueLabel(item.dueDate)}</Badge>
                      <span style={{ fontSize: 12, color: theme.muted, textAlign: 'right' }}>{item.dueDate}</span>
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 600, color: theme.ink }}>{item.title || 'Court appearance'}</span>
                    {(item.matterTitle || item.clientName) && (
                      <span style={{ fontSize: 12, color: theme.muted }}>
                        {item.matterTitle ? `Matter: ${item.matterTitle}${item.clientName ? ` · ${item.clientName}` : ''}` : item.clientName}
                      </span>
                    )}
                    {item.notes && <span style={{ fontSize: 12, color: theme.muted, fontStyle: 'italic' }}>{item.notes}</span>}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: theme.muted }}><strong style={{ color: theme.ink }}>{weekCourtCount}</strong> court date{weekCourtCount !== 1 ? 's' : ''} next 7 days</span>
              {todayCourtItems.length > 0 && <Badge tone="red">{todayCourtItems.length} today</Badge>}
            </div>
          </>
        ) : (
          <span style={{ color: theme.muted, fontSize: 13 }}>No court appearances recorded.</span>
        )}
      </div>

      <Card title="Compliance Guidance" hint="Rule-based prompts for deadlines, statutory filings and risk controls.">
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <p style={{ margin: 0, color: theme.muted }}>Review filing, service, and limitation reminders when planning deadline work.</p>
            <button
              type="button"
              style={styles.ghostButton}
              aria-expanded={guidanceOpen}
              aria-controls="deadline-compliance-guidance"
              onClick={() => setGuidanceOpen(open => !open)}
            >
              {guidanceOpen ? 'Hide guidance' : 'Show guidance'}
            </button>
          </div>
          {guidanceOpen && (
            <div id="deadline-compliance-guidance">
              {loading ? <Skeleton rows={2} /> : (
                <div className="lf-deadline-guidance-cards" style={styles.statsGrid}>
                  {guidance.map(item => (
                    <div key={item.title} className="lf-deadline-guidance-card" style={{ padding: 14, border: `1px solid ${theme.line}`, borderRadius: 10, background: '#fff', boxShadow: theme.shadow, transition: 'box-shadow .16s ease, transform .16s ease' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'start' }}>
                        <strong>{item.title}</strong>
                        <Badge tone={guidanceTone(item.tone)}>{item.tone}</Badge>
                      </div>
                      <p>{item.summary}</p>
                      <div style={{ marginTop: 10, color: theme.navy600, fontWeight: 700, fontSize: 12 }}>{item.action}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      <div className="lf-split-grid" style={styles.splitGrid}>
        <Card title="Add Deadline" hint="Capture client promises, internal bring-ups, tax and statutory filing dates.">
          <form onSubmit={submit} style={styles.formGrid}>
            <Field label="Title">
              <input required style={styles.input} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="e.g. File VAT return" />
            </Field>
            <Field label="Type">
              <select title="Choose statutory or tax for filing obligations; client for client response dates; internal for firm bring-ups." style={styles.input} value={form.type} onChange={event => setForm({ ...form, type: event.target.value })}>
                <option value="statutory">Statutory</option>
                <option value="tax">Tax</option>
                <option value="regulatory">Regulatory</option>
                <option value="client">Client</option>
                <option value="internal">Internal</option>
              </select>
            </Field>
            <Field label="Due Date">
              <input required type="date" style={styles.input} value={form.dueDate} onChange={event => setForm({ ...form, dueDate: event.target.value })} />
            </Field>
            <Field label="Matter">
              <select style={styles.input} value={form.matterId} onChange={event => setForm({ ...form, matterId: event.target.value })}>
                <option value="">No matter</option>
                {matterOptions.map(matter => <option key={matter.id} value={matter.id}>{matter.reference || matter.id} - {matter.title}</option>)}
              </select>
            </Field>
            <Field label="Client">
              <select style={styles.input} value={form.clientId} onChange={event => setForm({ ...form, clientId: event.target.value })}>
                <option value="">No client</option>
                {clientOptions.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
              </select>
            </Field>
            <Field label="Owner">
              <input style={styles.input} value={form.owner} onChange={event => setForm({ ...form, owner: event.target.value })} placeholder="Responsible person" />
            </Field>
            <Field label="Notes">
              <input style={styles.input} value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} placeholder="Action required or filing context" />
            </Field>
            <button type="submit" style={styles.primaryButton} disabled={!canManage || saving}>{saving ? 'Saving...' : 'Add deadline'}</button>
          </form>
          {!canManage && <p>Assistants can view the calendar of obligations, but only advocates and admins can create custom deadlines.</p>}
        </Card>

        <Card title="Filters" hint="Use this to focus on statutory, court or internal obligations.">
          <div style={styles.formGrid}>
            <Field label="Type">
              <select style={styles.input} value={filters.type || 'all'} onChange={event => setFilters(current => ({ ...current, type: event.target.value === 'all' ? '' : event.target.value }))}>
                {typeOptions.map(option => <option key={option} value={option}>{option === 'all' ? 'All' : prettyType(option)}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select style={styles.input} value={filters.status} onChange={event => setFilters(current => ({ ...current, status: event.target.value }))}>
                <option value="">All</option>
                <option value="Open">Open</option>
                <option value="Done">Done</option>
              </select>
            </Field>
            <button type="button" style={styles.ghostButton} onClick={() => setFilters({ type: '', status: '' })}>Reset</button>
          </div>
        </Card>
      </div>

      <Card title="Deadline Timeline" hint="Court dates, tasks, invoices, limitation dates and custom obligations in one list." action={
        <button type="button" style={styles.ghostButton} disabled={deadlines.length === 0} onClick={() => downloadCsv('lexflow-deadlines.csv', ['Due Date', 'Type', 'Title', 'Matter / Client', 'Owner', 'Status'], deadlines.map(d => [d.dueDate, d.type, d.title, d.matterTitle || d.reference || d.clientName || '', d.owner, d.status || 'Open']))}>Export CSV</button>
      }>
        {loading ? <Skeleton rows={3} /> : rows.length ? (
          <div className="lf-deadline-cards">
            <Table columns={['Due', 'Type', 'Deadline', 'Matter / Client', 'Owner', 'Status', 'Action']} rows={rows} rowIds={deadlines.map(r => `deadline-${r.id}`)} empty="No deadlines found." />
          </div>
        ) : (
          <Empty title="No deadlines found" text="Create a custom deadline or add tasks, appearances, invoices and SOL dates to populate this timeline." />
        )}
      </Card>
      <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
