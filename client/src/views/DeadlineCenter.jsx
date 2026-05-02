import { useEffect, useMemo, useState } from 'react';
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

export default function DeadlineCenter({ data, canManage, notify }) {
  const [deadlines, setDeadlines] = useState([]);
  const [guidance, setGuidance] = useState([]);
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

      <Card title="Compliance Guidance" hint="Rule-based prompts for deadlines, statutory filings and risk controls.">
        {loading ? <Skeleton rows={2} /> : (
          <div style={styles.statsGrid}>
            {guidance.map(item => (
              <div key={item.title} style={{ padding: 14, border: `1px solid ${theme.line}`, borderRadius: 10, background: '#fff' }}>
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
      </Card>

      <div style={styles.splitGrid}>
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

      <Card title="Deadline Timeline" hint="Court dates, tasks, invoices, limitation dates and custom obligations in one list.">
        {loading ? <Skeleton rows={3} /> : rows.length ? (
          <Table columns={['Due', 'Type', 'Deadline', 'Matter / Client', 'Owner', 'Status', 'Action']} rows={rows} empty="No deadlines found." />
        ) : (
          <Empty title="No deadlines found" text="Create a custom deadline or add tasks, appearances, invoices and SOL dates to populate this timeline." />
        )}
      </Card>
      <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
