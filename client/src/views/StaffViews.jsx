import { useEffect, useMemo, useState } from 'react';
import { IconBriefcase, IconClock, IconCoin, IconAlertTriangle } from '@tabler/icons-react';
import { api, downloadWithAuth, fileToDataUrl, readSession } from '../lib/apiClient.js';
import { defaultFirmSettings, styles, theme, applyFirmTheme, clearFirmTheme } from '../theme.jsx';
import { getFirmTheme, previewFirmTheme, updateFirmTheme, resetFirmTheme, getThemePresets, getUsers, reassignMatter } from '../api.js';
import { ActionGroup, Badge, Card, ConfirmModal, Empty, Field, kes, MeetingLink, nextCourtDate, ProfileTooltip, Skeleton, Stat, statusTone, Sub, Table } from '../components/ui.jsx';
import MatterDocuments from '../components/MatterDocuments.jsx';
import TaskTimer, { taskTimerActive } from '../components/TaskTimer.jsx';

const BILLABLE_TIME_GUIDANCE = 'Billable time may be included in hourly invoices. Non-billable time is tracked for workload and productivity but excluded from hourly invoice generation.';

function isBillableValue(value) {
  if (value === undefined || value === null) return true;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function BillableBadge({ value }) {
  const billable = isBillableValue(value);
  return <span style={{ ...styles.badge, background: billable ? theme.blueBg : '#F3F4F6', color: billable ? theme.blue : theme.muted }}>{billable ? 'Billable' : 'Non-billable'}</span>;
}

function formatFileSize(bytes = 0) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function noticeFileName(file) {
  return file?.friendlyName || file?.displayName || file?.name || 'Attachment';
}

function parseDateValue(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const dayOnly = new Date(`${value}T00:00:00`);
  return Number.isNaN(dayOnly.getTime()) ? null : dayOnly;
}

function isoDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function formatTimelineDate(value) {
  const parsed = parseDateValue(value);
  if (!parsed) return 'Date not recorded';
  return parsed.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
}

function daysFromToday(value) {
  const parsed = parseDateValue(value);
  const today = parseDateValue(isoDateOnly());
  if (!parsed || !today) return null;
  const targetDay = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const currentDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((targetDay.getTime() - currentDay.getTime()) / 86400000);
}

function formatDayDistance(days) {
  if (days === null || days === undefined) return null;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 0) return `in ${days} days`;
  const overdueDays = Math.abs(days);
  return `${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue`;
}

function buildMatterNextActionHints(detail) {
  if (!detail) return [];

  const tasks = Array.isArray(detail.tasks) ? detail.tasks : [];
  const appearances = Array.isArray(detail.appearances) ? detail.appearances : [];
  const documents = Array.isArray(detail.documents) ? detail.documents : [];
  const notes = Array.isArray(detail.notes) ? detail.notes : [];
  const timeEntries = Array.isArray(detail.timeEntries) ? detail.timeEntries : [];
  const invoices = Array.isArray(detail.invoices) ? detail.invoices : [];
  const hints = [];
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const categoryRank = { urgent: 0, upcoming: 1, risk: 2, 'missing-information': 3, billing: 4, workflow: 5, informational: 6 };

  const addHint = (hint) => {
    const evidence = (Array.isArray(hint.evidence) ? hint.evidence : [])
      .filter(Boolean)
      .map(String)
      .slice(0, 3);
    hints.push({
      title: hint.title,
      category: hint.category,
      severity: hint.severity,
      why: hint.why,
      evidence: evidence.length ? evidence : ['Available matter data'],
      rank: hint.rank ?? 50,
    });
  };

  const openTasks = tasks.filter(task => !task.completed);
  const overdueTasks = openTasks
    .map(task => ({ ...task, daysAway: daysFromToday(task.dueDate) }))
    .filter(task => Number.isFinite(task.daysAway) && task.daysAway < 0)
    .sort((a, b) => a.daysAway - b.daysAway);

  if (overdueTasks.length) {
    const oldest = overdueTasks[0];
    const oldestAge = Math.abs(oldest.daysAway);
    addHint({
      title: `${overdueTasks.length} overdue open task${overdueTasks.length === 1 ? '' : 's'}`,
      category: 'urgent',
      severity: overdueTasks.length >= 3 || oldestAge >= 7 ? 'critical' : 'high',
      why: 'Open tasks are past their due dates and need staff follow-up.',
      evidence: [
        oldest.title || oldest.description || 'Open task',
        `Due ${formatTimelineDate(oldest.dueDate)}`,
        formatDayDistance(oldest.daysAway),
      ],
      rank: 1,
    });
  }

  const upcomingAppearances = appearances
    .map(appearance => ({ ...appearance, daysAway: daysFromToday(appearance.date) }))
    .filter(appearance => Number.isFinite(appearance.daysAway) && appearance.daysAway >= 0)
    .sort((a, b) => a.daysAway - b.daysAway);

  const nextAppearance = upcomingAppearances[0];
  if (nextAppearance && nextAppearance.daysAway <= 7) {
    addHint({
      title: nextAppearance.daysAway === 0 ? 'Court appearance today' : `Court appearance ${formatDayDistance(nextAppearance.daysAway)}`,
      category: 'upcoming',
      severity: 'high',
      why: 'A court date is approaching; confirm attendance, materials, and responsible staff.',
      evidence: [
        formatTimelineDate(nextAppearance.date),
        nextAppearance.court || nextAppearance.location || 'Court appearance',
        nextAppearance.type || nextAppearance.purpose || null,
      ],
      rank: 3,
    });
  }

  if (nextAppearance && !nextAppearance.prepNote) {
    addHint({
      title: 'Court preparation note not recorded',
      category: 'missing-information',
      severity: 'medium',
      why: 'The next court appearance has no prep note in the current matter detail.',
      evidence: [
        formatTimelineDate(nextAppearance.date),
        nextAppearance.court || nextAppearance.location || 'Court appearance',
        'No prep note',
      ],
      rank: 8,
    });
  }

  const solDays = daysFromToday(detail.solDate);
  if (Number.isFinite(solDays)) {
    if (solDays < 0) {
      addHint({
        title: 'Recorded limitation date has passed',
        category: 'risk',
        severity: 'high',
        why: 'Confirm limitation date and underlying facts.',
        evidence: [
          `SOL ${formatTimelineDate(detail.solDate)}`,
          formatDayDistance(solDays),
          detail.stage ? `Stage: ${detail.stage}` : null,
        ],
        rank: 2,
      });
    } else if (solDays <= 30) {
      addHint({
        title: 'Limitation date within 30 days',
        category: 'risk',
        severity: 'high',
        why: 'Confirm limitation date and underlying facts.',
        evidence: [
          `SOL ${formatTimelineDate(detail.solDate)}`,
          formatDayDistance(solDays),
          detail.stage ? `Stage: ${detail.stage}` : null,
        ],
        rank: 4,
      });
    } else {
      addHint({
        title: 'Limitation date recorded',
        category: 'risk',
        severity: 'low',
        why: 'Confirm limitation date and underlying facts remain current.',
        evidence: [
          `SOL ${formatTimelineDate(detail.solDate)}`,
          formatDayDistance(solDays),
          detail.stage ? `Stage: ${detail.stage}` : null,
        ],
        rank: 18,
      });
    }
  }

  if (!documents.length) {
    addHint({
      title: 'No documents recorded',
      category: 'missing-information',
      severity: 'medium',
      why: 'The current matter detail has no document records to support the file.',
      evidence: [
        '0 documents',
        detail.stage ? `Stage: ${detail.stage}` : null,
        detail.assignedTo ? `Assigned: ${detail.assignedTo}` : null,
      ],
      rank: 9,
    });
  }

  if (!notes.length) {
    addHint({
      title: 'No matter notes recorded',
      category: 'workflow',
      severity: 'low',
      why: 'No staff notes are available in the current matter detail.',
      evidence: [
        '0 notes',
        detail.assignedTo ? `Assigned: ${detail.assignedTo}` : null,
        detail.paralegal ? `Paralegal: ${detail.paralegal}` : null,
      ],
      rank: 20,
    });
  }

  const overdueInvoices = invoices
    .map(invoice => ({ ...invoice, daysAway: daysFromToday(invoice.dueDate), statusText: String(invoice.status || '').toLowerCase() }))
    .filter(invoice => invoice.statusText.includes('overdue') || (Number.isFinite(invoice.daysAway) && invoice.daysAway < 0 && !invoice.statusText.includes('paid')))
    .sort((a, b) => (a.daysAway ?? 0) - (b.daysAway ?? 0));

  if (overdueInvoices.length) {
    const oldestInvoice = overdueInvoices[0];
    addHint({
      title: `${overdueInvoices.length} overdue invoice${overdueInvoices.length === 1 ? '' : 's'}`,
      category: 'billing',
      severity: 'medium',
      why: 'An invoice is overdue or marked outstanding in the current matter detail; review status without relying on hidden amounts.',
      evidence: [
        oldestInvoice.invoiceNumber || oldestInvoice.id || 'Invoice',
        oldestInvoice.dueDate ? `Due ${formatTimelineDate(oldestInvoice.dueDate)}` : 'Due date not recorded',
        oldestInvoice.status || 'Status not recorded',
      ],
      rank: 10,
    });
  }

  const unbilledTime = timeEntries.filter(entry => !entry.billed && isBillableValue(entry.billable));
  if (unbilledTime.length) {
    const visibleHours = unbilledTime.reduce((sum, entry) => sum + (Number(entry.hours) || 0), 0);
    const latestEntry = [...unbilledTime]
      .sort((a, b) => (parseDateValue(b.date)?.getTime() || 0) - (parseDateValue(a.date)?.getTime() || 0))[0];
    addHint({
      title: `${unbilledTime.length} unbilled time entr${unbilledTime.length === 1 ? 'y' : 'ies'}`,
      category: 'billing',
      severity: visibleHours >= 5 || unbilledTime.length >= 3 ? 'medium' : 'low',
      why: 'Unbilled time is visible in this matter; review billing status without exposing rates or amounts.',
      evidence: [
        `${visibleHours.toFixed(1)}h logged`,
        latestEntry?.date ? `Latest ${formatTimelineDate(latestEntry.date)}` : null,
        `${unbilledTime.length} entries`,
      ],
      rank: 14,
    });
  }

  if (!hints.length) {
    addHint({
      title: 'Matter appears current from available signals',
      category: 'informational',
      severity: 'low',
      why: 'No overdue open tasks, near court dates, limitation-date risk, missing file basics, overdue invoices, or visible unbilled time were found.',
      evidence: [
        detail.stage ? `Stage: ${detail.stage}` : 'Stage not recorded',
        detail.priority ? `Priority: ${detail.priority}` : null,
        detail.assignedTo ? `Assigned: ${detail.assignedTo}` : null,
      ],
      rank: 30,
    });
  }

  return hints
    .sort((a, b) => {
      const severityDelta = (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
      if (severityDelta) return severityDelta;
      const rankDelta = a.rank - b.rank;
      if (rankDelta) return rankDelta;
      return (categoryRank[a.category] ?? 9) - (categoryRank[b.category] ?? 9);
    })
    .map(({ rank, ...hint }) => hint);
}

export function Dashboard({ data, user, onNavigate }) {
  const isAdvocate = user?.role === 'advocate';
  const outstanding = data.invoices.filter(i => i.status === 'Outstanding').reduce((sum, i) => sum + Number(i.amount || 0), 0);
  const paid = data.invoices.filter(i => i.status === 'Paid').reduce((sum, i) => sum + Number(i.amount || 0), 0);
  const overdueTasks = data.tasks.filter(t => !t.completed && t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10)).length;
  const stages = data.matters.reduce((acc, matter) => ({ ...acc, [matter.stage || 'Intake']: (acc[matter.stage || 'Intake'] || 0) + 1 }), {});
  const maxStage = Math.max(1, ...Object.values(stages));
  const upcomingEvents = data.dashboard.upcomingEvents || [];

  return (
    <div style={styles.pageStack}>
      <section style={styles.heroCard}>
        <div>
          <div style={styles.heroKicker}>{isAdvocate ? 'Your workload' : 'Firm position'}</div>
          <h2>{isAdvocate ? 'Your assigned matters' : 'Firm matters overview'}</h2>
          {isAdvocate ? (
            <p>{data.matters.length} matters assigned, {data.dashboard.overdueTaskCount || 0} overdue task{data.dashboard.overdueTaskCount === 1 ? '' : 's'}. Outstanding: {kes(outstanding)}.</p>
          ) : (
            <p>{data.matters.length} matters, {data.tasks.length} tasks, and {kes(outstanding)} outstanding across active files.</p>
          )}
        </div>
        <div style={styles.heroFigure}>{kes(paid + outstanding)}</div>
      </section>

      {isAdvocate ? data.dashboard.overdueTaskCount : overdueTasks > 0 && (
        <div style={styles.warningPanel}>
          <div style={styles.warningIcon}>!</div>
          <div>
            <strong>{isAdvocate ? data.dashboard.overdueTaskCount : overdueTasks} overdue task{(isAdvocate ? data.dashboard.overdueTaskCount : overdueTasks) === 1 ? '' : 's'} need attention.</strong>
            <span>Review {isAdvocate ? 'your' : 'the'} task board and clear critical deadlines before the close of day.</span>
          </div>
        </div>
      )}

      <div style={styles.statsGrid}>
        <Stat icon={IconBriefcase} label="Active matters" value={data.dashboard.activeMattersCount ?? data.matters.length} tone="navy" onClick={() => onNavigate?.('Matters')} ariaLabel="View active matters" />
        <Stat icon={IconClock} label="Billable hours this month" value={Number(data.dashboard.monthHours || 0).toFixed(1)} tone="gold" onClick={() => onNavigate?.('Tasks')} ariaLabel="View billable hours this month" />
        {user?.role === 'admin' ? (
          <Stat icon={IconCoin} label={isAdvocate ? 'My billed revenue' : 'Revenue month'} value={kes(data.dashboard.monthRevenue)} tone="green" onClick={() => onNavigate?.('Invoices')} ariaLabel="View revenue" />
        ) : (
          <Stat icon={IconCoin} label={isAdvocate ? 'My billed revenue' : 'Revenue month'} value={kes(data.dashboard.monthRevenue)} tone="green" />
        )}
        <Stat icon={IconAlertTriangle} label="Overdue tasks" value={isAdvocate ? data.dashboard.overdueTaskCount : overdueTasks} tone="red" onClick={() => onNavigate?.('Tasks')} ariaLabel="View overdue tasks" />
      </div>

      <div className="lf-dashboard-grid" style={styles.dashboardGrid}>
        <Card title={isAdvocate ? 'My matters' : 'Matter pipeline'} hint={isAdvocate ? 'Assigned files' : 'Stage distribution'}>
          {Object.keys(stages).length ? Object.entries(stages).map(([stage, count]) => (
            <div key={stage} style={styles.pipelineRow}>
              <span>{stage}</span>
              <div style={styles.pipelineTrack}><div style={{ ...styles.pipelineFill, width: `${(count / maxStage) * 100}%` }} /></div>
              <strong>{count}</strong>
            </div>
          )) : <Empty title={isAdvocate ? 'No assigned matters' : 'No matters yet'} text={isAdvocate ? 'Your assigned matters will appear here.' : 'Create a client and matter to populate the board.'} />}
        </Card>
        <Card title="Receivables" hint="Latest invoice status">
          <div className="lf-receivables-cards"><Table columns={['Invoice', 'Client', 'Amount', 'Status']} rows={data.invoices.slice(0, 6).map(i => [i.number || i.id, i.clientName || '-', kes(i.amount), <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>])} empty="No invoices yet." /></div>
        </Card>
      </div>

      <Card title="Upcoming court dates" hint="Appearances and virtual court links">
        <div className="lf-court-dates-cards"><Table columns={['Appearance', 'Matter', 'Date', 'Time', 'Location', 'Virtual Court']} rows={upcomingEvents.map(event => [
          event.title || event.type || 'Court appearance',
          event.matterTitle || event.reference || '-',
          event.date || '-',
          event.time || '-',
          event.location || '-',
          <MeetingLink key={event.id || `${event.date}-${event.title}`} event={event} dashboard />,
        ])} empty="No upcoming court dates." /></div>
      </Card>
    </div>
  );
}

export function Clients({ clients, matters, canManage, isAdmin = false, reload, notify, focus }) {
  const emptyClientForm = { name: '', type: 'Individual', contact: '', email: '', phone: '', remindersEnabled: true, preferredChannel: 'firm_default' };
  const [form, setForm] = useState(emptyClientForm);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [users, setUsers] = useState([]);
  useEffect(() => { if (isAdmin) loadUsers(); }, [isAdmin]);
  useEffect(() => {
    if (!focus?.clientId) return;
    const el = document.getElementById(`client-${focus.clientId}`);
    if (el) {
      const prev = el.style.background;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.background = 'rgba(212, 163, 74, 0.15)';
      setTimeout(() => { el.style.background = prev; }, 1200);
    }
  }, [focus?.clientId, focus?.ts]);
  async function loadUsers() { try { setUsers(await api('/auth/users')); } catch { setUsers([]); } }
  async function submit(event) {
    event.preventDefault();
    try {
      if (editing) await api(`/clients/${editing.id}`, { method: 'PATCH', body: form });
      else await api('/clients', { method: 'POST', body: form });
      setForm(emptyClientForm);
      setEditing(null);
      notify({ type: 'success', message: editing ? 'Client updated.' : 'Client created.' });
      await reload();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  function startEdit(client) {
    setEditing(client);
    setForm({ ...emptyClientForm, name: client.name || '', type: client.type || 'Individual', contact: client.contact || '', email: client.email || '', phone: client.phone || '', remindersEnabled: client.remindersEnabled === undefined ? true : Boolean(Number(client.remindersEnabled)), preferredChannel: client.preferredChannel || 'firm_default' });
  }
  async function deleteClient(client) {
    try {
      await api(`/clients/${client.id}`, { method: 'DELETE' });
      notify({ type: 'success', message: 'Client deleted.' });
      await reload();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function inviteClient(client) {
    if (!client.email) return notify({ type: 'warning', message: 'Add the client email before generating an invitation.' });
    try {
      const invite = await api('/invitations', { method: 'POST', body: { email: client.email, clientId: client.id } });
      await navigator.clipboard?.writeText(invite.url).catch(() => {});
      notify({ type: 'success', message: 'Invitation generated. Link copied if clipboard access is available.' });
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  function portalCell(client) {
    if (!isAdmin) return '-';
    const account = users.find(user => user.role === 'client' && user.clientId === client.id);
    if (account) return <Badge tone="green">Active</Badge>;
    return <button type="button" style={styles.tinyButton} onClick={() => inviteClient(client)}>Send Invitation</button>;
  }
  function reminderCell(client) {
    if (client.remindersEnabled === 0) return <Badge tone="red">Off</Badge>;
    const channel = client.preferredChannel || 'firm_default';
    return <Badge tone={channel === 'none' ? 'red' : channel === 'firm_default' ? 'blue' : 'green'}>{channel === 'firm_default' ? 'Firm default' : channel}</Badge>;
  }
  return <div className="lf-split-grid" style={styles.splitGrid}><Card title={editing ? 'Edit client' : 'New client'} hint={editing ? 'Save client changes and communication preference' : 'Intake record'}><form onSubmit={submit} style={styles.formGrid}><Field label="Name"><input required style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="Type"><select style={styles.input} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}><option>Individual</option><option>Company</option></select></Field><Field label="Contact"><input style={styles.input} value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} /></Field><Field label="Email"><input style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field><Field label="Phone"><input style={styles.input} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field><Field label="Reminders"><select style={styles.input} value={form.remindersEnabled ? 'on' : 'off'} onChange={e => setForm({ ...form, remindersEnabled: e.target.value === 'on' })}><option value="on">On</option><option value="off">Off for this client</option></select></Field><Field label="Preferred Channel"><select style={styles.input} value={form.preferredChannel} onChange={e => setForm({ ...form, preferredChannel: e.target.value })}><option value="firm_default">Firm default</option><option value="both">WhatsApp and Email</option><option value="whatsapp">WhatsApp only</option><option value="email">Email only</option><option value="none">None</option></select></Field><button style={styles.primaryButton}>{editing ? 'Save changes' : 'Create client'}</button>{editing && <button type="button" style={styles.ghostButton} onClick={() => { setEditing(null); setForm(emptyClientForm); }}>Cancel</button>}</form></Card><Card title="Client directory" hint={`${clients.length} records`}><div className="lf-client-cards"><Table columns={['Name', 'Type', 'Email', 'Phone', 'Status', 'Reminders', 'Portal', 'Actions']} rows={clients.map(c => [<span key={c.id} onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY, title: c.name, lines: [`${c.type || 'Client'} / ${c.status || 'Active'}`, `${matters.filter(m => m.clientId === c.id).length} matter(s)`, `Joined ${c.joinDate || '-'}`], initial: (c.name || 'C').slice(0, 1) })} onMouseLeave={() => setTooltip(null)} style={styles.hoverName}>{c.name}</span>, c.type, c.email || '-', c.phone || '-', <Badge key={`${c.id}-status`} tone="green">{c.status || 'Active'}</Badge>, reminderCell(c), portalCell(c), canManage ? <ActionGroup key={`${c.id}-actions`} actions={[[ 'Edit', () => startEdit(c)], ['Delete', () => setConfirm({ title: 'Delete client?', message: 'Are you sure you want to delete this client? This will also remove all related matters.', onConfirm: () => deleteClient(c) })]]} /> : '-'])} rowIds={clients.map(c => `client-${c.id}`)} empty="No clients yet." /></div></Card><ProfileTooltip tooltip={tooltip} /><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></div>;
}export function Matters({ data, canManage, reload, notify, focus, onMatterOpened }) {
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [detailTab, setDetailTab] = useState('Workspace');
  const [editingMatter, setEditingMatter] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null);
  const [editingTime, setEditingTime] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [loading, setLoading] = useState(false);
  const emptyMatterForm = { clientId: '', title: '', practiceArea: '', stage: 'Intake', assignedTo: '', paralegal: '', description: '', court: '', judge: '', caseNo: '', opposingCounsel: '', priority: 'Medium', solDate: '', billingType: 'hourly', billingRate: 15000, fixedFee: 0, retainerBalance: 0, remindersEnabled: 'firm_default', courtRemindersEnabled: 'firm_default', invoiceRemindersEnabled: 'firm_default' };
  const [form, setForm] = useState(emptyMatterForm);
  const [time, setTime] = useState({ hours: 1, description: '', rate: 15000, billable: true });
  const emptyEventForm = { title: '', date: '', time: '9:00 AM', type: 'Hearing', location: '', meetingLink: '', attorney: '', prepNote: '' };
  const [eventForm, setEventForm] = useState(emptyEventForm);
  const [note, setNote] = useState('');
  const [taskTimer, setTaskTimer] = useState(null);
  const [advocates, setAdvocates] = useState([]);
  const [reassignTo, setReassignTo] = useState('');
  const [reassigning, setReassigning] = useState(false);
  const session = readSession();
  const isAdmin = session?.user?.role === 'admin';
  const canViewBilling = isAdmin || session?.user?.role !== 'advocate' || Number(data.firmSettings?.advocateBillingVisibility ?? 1) !== 0;
  const selected = data.matters.find(m => m.id === selectedId) || data.matters[0];
  const nextActionHints = useMemo(() => buildMatterNextActionHints(detail), [detail]);

  useEffect(() => { if (selected?.id) { setSelectedId(selected.id); loadDetail(selected.id); } else { setDetail(null); setSuggestions([]); } }, [selected?.id]);
  useEffect(() => { if (detail && isAdmin) getUsers(true).then(users => { setAdvocates((users || []).filter(u => u.role === 'advocate' && u.isActive)); setReassignTo(detail.assignedTo || ''); }).catch(() => {}); }, [detail?.id]);
  useEffect(() => {
    if (!focus?.matterId) return;
    setSelectedId(focus.matterId);
    setDetailTab('Workspace');
  }, [focus?.matterId, focus?.ts]);

  async function loadDetail(id) {
    setLoading(true);
    try {
      const [matter, smartTips] = await Promise.all([
        api(`/matters/${id}`),
        api(`/matters/${id}/suggestions`),
      ]);
      setDetail(matter);
      setSuggestions(Array.isArray(smartTips) ? smartTips : []);
      onMatterOpened?.(id);
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setLoading(false);
    }
  }
  async function createMatter(event) { event.preventDefault(); try { if (editingMatter && detail) { await api(`/matters/${detail.id}`, { method: 'PATCH', body: form }); setEditingMatter(false); notify({ type: 'success', message: 'Matter updated.' }); await loadDetail(detail.id); } else { await api('/matters', { method: 'POST', body: form }); notify({ type: 'success', message: 'Matter created.' }); } setForm(emptyMatterForm); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function logTime(event) { event.preventDefault(); if (!detail) return; try { const body = { ...time, billable: Boolean(time.billable), matterId: detail.id }; if (!canViewBilling) delete body.rate; await api('/time-entries', { method: 'POST', body }); setTime({ hours: 1, description: '', rate: canViewBilling ? detail.billingRate || 15000 : 0, billable: true }); notify({ type: 'success', message: 'Time logged.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function addNote(event) { event.preventDefault(); if (!detail || !note.trim()) return; try { await api(`/matters/${detail.id}/notes`, { method: 'POST', body: { content: note } }); setNote(''); notify({ type: 'success', message: 'Case note saved.' }); await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function createEvent(event) { event.preventDefault(); if (!detail) return; try { await api('/appearances', { method: 'POST', body: { ...eventForm, matterId: detail.id } }); setEventForm(emptyEventForm); notify({ type: 'success', message: 'Court appearance scheduled.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function uploadDoc(event) { const file = event.target.files?.[0]; if (!file || !detail) return; try { await api(`/matters/${detail.id}/documents`, { method: 'POST', body: { name: file.name, mimeType: file.type || 'application/octet-stream', data: await fileToDataUrl(file) } }); notify({ type: 'success', message: 'Document uploaded.' }); event.target.value = ''; await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function generateInvoice() { if (!detail) return; try { await api('/invoices/generate', { method: 'POST', body: { matterId: detail.id } }); notify({ type: 'success', message: 'Invoice generated.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  function startMatterEdit() { if (!detail) return; setEditingMatter(true); setForm({ ...emptyMatterForm, ...detail }); }
  async function archiveMatter() { if (!detail) return; try { await api(`/matters/${detail.id}/status`, { method: 'PATCH', body: { stage: 'Closed' } }); notify({ type: 'success', message: 'Matter archived.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteMatterRecord() { if (!detail) return; try { const id = detail.id; await api(`/matters/${id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Matter deleted.' }); setDetail(null); setSelectedId(''); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function saveTask(task, values) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: values }); setEditingTask(null); notify({ type: 'success', message: 'Task updated.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteTaskRecord(task) { try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Task deleted.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteDocumentRecord(doc) { try { await api(`/documents/${doc.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Document deleted.' }); await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteInvoiceRecord(invoice) { try { await api(`/invoices/${invoice.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Invoice deleted.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function handleReassign() { if (!detail || !reassignTo || reassignTo === detail.assignedTo) return; setReassigning(true); try { await reassignMatter(detail.id, reassignTo); notify({ type: 'success', message: `Matter reassigned to ${reassignTo}.` }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } finally { setReassigning(false); } }
  async function saveEvent(event, values) { try { await api(`/appearances/${event.id}`, { method: 'PATCH', body: values }); setEditingEvent(null); notify({ type: 'success', message: 'Appearance updated.' }); await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteEventRecord(event) { try { await api(`/appearances/${event.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Appearance deleted.' }); await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function saveTimeEntry(entry, values) { try { const body = { ...values }; if (!canViewBilling) delete body.rate; await api(`/time-entries/${entry.id}`, { method: 'PATCH', body }); setEditingTime(null); notify({ type: 'success', message: 'Time entry updated.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteTimeEntryRecord(entry) { try { await api(`/time-entries/${entry.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Time entry deleted.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }

  return (
    <div className="lf-matter-grid" style={styles.matterGrid}>
      <Card title="Matter list" hint={`${data.matters.length} active files`}>
        {data.matters.length ? data.matters.map(m => (
          <button key={m.id} onClick={() => setSelectedId(m.id)} onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY, title: m.title, lines: [m.reference || m.id, `Stage: ${m.stage || 'Intake'}`, `Priority: ${m.priority || 'Medium'}`, `Advocate: ${m.assignedTo || '-'}`, `Next court: ${nextCourtDate(m)}`], initial: (m.title || 'M').slice(0, 1) })} onMouseLeave={() => setTooltip(null)} style={{ ...styles.matterButton, ...(selected?.id === m.id ? styles.matterActive : {}) }}>
            <strong>{m.title}</strong>
            <span>{m.reference || m.id}</span>
            <small>{m.clientName || 'No client'} / {m.stage || 'Intake'}</small>
          </button>
        )) : <Empty title="No matters" text="Create one after adding a client." />}
      </Card>
      <div style={styles.pageStack}>
        {canManage && (
          <Card title={editingMatter ? 'Edit matter' : 'Open a new matter'} hint={editingMatter ? 'Update matter profile' : 'Matter setup'}>
            <form onSubmit={createMatter} style={styles.formGrid}>
              <Field label="Client"><select required style={styles.input} value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })}><option value="">Select client</option>{data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Title"><input required style={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field>
              <Field label="Practice"><input style={styles.input} value={form.practiceArea} onChange={e => setForm({ ...form, practiceArea: e.target.value })} /></Field>
              <Field label="Stage"><select style={styles.input} value={form.stage} onChange={e => setForm({ ...form, stage: e.target.value })}><option>Intake</option><option>Conflict Check</option><option>Engagement</option><option>Active</option><option>Discovery</option><option>Trial Prep</option><option>On Hold</option><option>Closed</option></select></Field>
              <Field label="Advocate"><input style={styles.input} value={form.assignedTo || ''} onChange={e => setForm({ ...form, assignedTo: e.target.value })} /></Field>
              <Field label="Court"><input style={styles.input} value={form.court || ''} onChange={e => setForm({ ...form, court: e.target.value })} /></Field>
              <Field label="Judge"><input style={styles.input} value={form.judge || ''} onChange={e => setForm({ ...form, judge: e.target.value })} /></Field>
              <Field label="SOL Date"><input type="date" style={styles.input} value={form.solDate || ''} onChange={e => setForm({ ...form, solDate: e.target.value })} /></Field>
              <Field label="Opposing Counsel"><input style={styles.input} value={form.opposingCounsel || ''} onChange={e => setForm({ ...form, opposingCounsel: e.target.value })} /></Field>
              <Field label="Billing"><select style={styles.input} value={form.billingType} onChange={e => setForm({ ...form, billingType: e.target.value })}><option value="hourly">Hourly</option><option value="fixed">Fixed fee</option></select></Field>
              <Field label="Rate/Fee"><input type="number" style={styles.input} value={form.billingType === 'fixed' ? form.fixedFee : form.billingRate} onChange={e => setForm({ ...form, [form.billingType === 'fixed' ? 'fixedFee' : 'billingRate']: Number(e.target.value) })} /></Field>
              <Field label="Matter Reminders"><select style={styles.input} value={form.remindersEnabled || 'firm_default'} onChange={e => setForm({ ...form, remindersEnabled: e.target.value })}><option value="firm_default">Use client/firm default</option><option value="on">On for this matter</option><option value="off">Off for this matter</option></select></Field><Field label="Court Reminders"><select style={styles.input} value={form.courtRemindersEnabled || 'firm_default'} onChange={e => setForm({ ...form, courtRemindersEnabled: e.target.value })}><option value="firm_default">Use matter default</option><option value="on">On</option><option value="off">Off</option></select></Field><Field label="Invoice Reminders"><select style={styles.input} value={form.invoiceRemindersEnabled || 'firm_default'} onChange={e => setForm({ ...form, invoiceRemindersEnabled: e.target.value })}><option value="firm_default">Use matter default</option><option value="on">On</option><option value="off">Off</option></select></Field><Field label="Description"><input style={styles.input} value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} /></Field>
              <button style={styles.primaryButton}>{editingMatter ? 'Save changes' : 'Create matter'}</button>
              {editingMatter && <button type="button" style={styles.ghostButton} onClick={() => { setEditingMatter(false); setForm(emptyMatterForm); }}>Cancel</button>}
            </form>
          </Card>
        )}
        <Card title={detail?.title || 'Matter detail'} hint={detail?.reference || 'Select a file'} action={detail && canManage ? <ActionGroup actions={[['Edit', startMatterEdit], ['Archive', () => setConfirm({ title: 'Archive matter?', message: 'Archive this matter by setting the stage to Closed?', onConfirm: archiveMatter })], ['Delete', () => setConfirm({ title: 'Delete matter?', message: 'Delete this matter and all associated data?', onConfirm: deleteMatterRecord })], ['Invoice', generateInvoice]]} /> : null}>
          {loading && <Skeleton rows={2} />}
          {!loading && detail && (
            <div style={styles.detailStack}>
              <div style={styles.chips}>
                <Badge tone="blue">{detail.stage || 'Intake'}</Badge>
                <span>{detail.clientName || 'No client'}</span>
                <span>{detail.practiceArea || 'General'}</span>
                {isAdmin && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
                    <Badge tone="navy">Advocate: {detail.assignedTo || 'Unassigned'}</Badge>
                    <select style={{ ...styles.input, width: 160, fontSize: 12, padding: '2px 6px' }} value={reassignTo} onChange={e => setReassignTo(e.target.value)}>
                      <option value="">Select advocate</option>
                      {advocates.map(a => <option key={a.id} value={a.fullName}>{a.fullName}</option>)}
                    </select>
                    <button style={{ ...styles.ghostButton, fontSize: 12, padding: '2px 10px' }} disabled={reassigning || !reassignTo || reassignTo === detail.assignedTo} onClick={handleReassign}>{reassigning ? '...' : 'Reassign'}</button>
                  </span>
                )}
              </div>
              <div style={styles.tabList}>
                {['Workspace', 'Assistant', 'Court'].map(tab => (
                  <button key={tab} type="button" onClick={() => setDetailTab(tab)} style={{ ...styles.tabButton, ...(detailTab === tab ? styles.tabActive : {}) }}>{tab}</button>
                ))}
              </div>
              {detailTab === 'Assistant' ? (
                <AssistantSuggestions suggestions={suggestions} />
              ) : detailTab === 'Court' ? (
                <MatterCourtMode detail={detail} nextActionHints={nextActionHints} />
              ) : (
                <>
                  <MatterCommandSummary detail={detail} nextActionHints={nextActionHints} />
                  <MatterNextActionHints hints={nextActionHints} />
                  <MatterActivityTimeline detail={detail} />
                  <form onSubmit={logTime} style={styles.formGrid}>
                    <Field label="Hours"><input type="number" min="0" step="0.1" style={styles.input} value={time.hours} onChange={e => setTime({ ...time, hours: Number(e.target.value) })} /></Field>
                    <Field label="Description"><input style={styles.input} value={time.description} onChange={e => setTime({ ...time, description: e.target.value })} /></Field>
                    {canViewBilling && <Field label="Rate"><input type="number" style={styles.input} value={time.rate} onChange={e => setTime({ ...time, rate: Number(e.target.value) })} /></Field>}
                    <Field label="Billing class"><select style={styles.input} value={time.billable ? 'billable' : 'non_billable'} onChange={e => setTime({ ...time, billable: e.target.value === 'billable' })}><option value="billable">Billable</option><option value="non_billable">Non-billable</option></select></Field>
                    <div style={{ ...styles.formHelper, gridColumn: '1 / -1' }}>{BILLABLE_TIME_GUIDANCE}</div>
                    <button style={styles.primaryButton}>Log time</button>
                  </form>
                  <Sub title="Time entries"><TimeEntryEditorList entries={detail.timeEntries || []} canManage={canManage} canViewBilling={canViewBilling} editingTime={editingTime} setEditingTime={setEditingTime} saveTimeEntry={saveTimeEntry} confirmDelete={entry => setConfirm({ title: 'Delete time entry?', message: 'Delete this time entry?', onConfirm: () => deleteTimeEntryRecord(entry) })} /></Sub>
                  <Sub title="Tasks"><TaskEditorList tasks={detail.tasks || []} entries={detail.timeEntries || []} matter={detail} canManage={canManage} canViewBilling={canViewBilling} editingTask={editingTask} setEditingTask={setEditingTask} saveTask={saveTask} taskTimer={taskTimer} setTaskTimer={setTaskTimer} notify={notify} onTimerSaved={async () => { await loadDetail(detail.id); await reload(); }} confirmDelete={task => setConfirm({ title: 'Delete task?', message: 'Delete this task?', onConfirm: () => deleteTaskRecord(task) })} /></Sub>
                  <Sub title="Court appearances">{canManage && <form onSubmit={createEvent} style={{ ...styles.formGrid, marginBottom: 12 }}><Field label="Title"><input required style={styles.input} value={eventForm.title} onChange={e => setEventForm({ ...eventForm, title: e.target.value })} /></Field><Field label="Date"><input required type="date" style={styles.input} value={eventForm.date} onChange={e => setEventForm({ ...eventForm, date: e.target.value })} /></Field><Field label="Time"><input style={styles.input} value={eventForm.time} onChange={e => setEventForm({ ...eventForm, time: e.target.value })} /></Field><Field label="Type"><input style={styles.input} value={eventForm.type} onChange={e => setEventForm({ ...eventForm, type: e.target.value })} /></Field><Field label="Location"><input style={styles.input} value={eventForm.location} onChange={e => setEventForm({ ...eventForm, location: e.target.value })} /></Field><Field label="Meeting Link"><input type="url" placeholder="https://..." style={styles.input} value={eventForm.meetingLink} onChange={e => setEventForm({ ...eventForm, meetingLink: e.target.value })} /></Field><button style={styles.ghostButton}>Schedule event</button></form>}<AppearanceEditorList events={detail.appearances || []} canManage={canManage} editingEvent={editingEvent} setEditingEvent={setEditingEvent} saveEvent={saveEvent} confirmDelete={event => setConfirm({ title: 'Delete appearance?', message: 'Delete this court appearance?', onConfirm: () => deleteEventRecord(event) })} /></Sub>
                  <Sub title="Documents"><MatterDocuments matterId={detail.id} canManage={canManage} notify={notify} /></Sub>
                  <Sub title="Case notes"><form onSubmit={addNote} style={styles.noteForm}><input style={styles.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note" /><button style={styles.ghostButton}>Save note</button></form><Table columns={['Note', 'Author', 'Created']} rows={(detail.notes || []).map(n => [n.content, n.author || '-', n.createdAt ? new Date(n.createdAt).toLocaleString() : '-'])} empty="No notes yet." /></Sub>
                  <Sub title="Invoices"><Table columns={['Invoice', 'Amount', 'Status', 'PDF', 'Actions']} rows={(detail.invoices || []).map(i => [i.number || i.id, kes(i.amount), <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <DownloadButton key={`${i.id}-pdf`} label="PDF" path={`/api/invoices/${i.id}/pdf`} filename={`${i.number || i.id}.pdf`} notify={notify} />, canManage && i.status !== 'Paid' ? <ActionGroup key={`${i.id}-actions`} actions={[['Delete', () => setConfirm({ title: 'Delete invoice?', message: 'Delete this invoice?', onConfirm: () => deleteInvoiceRecord(i) })]]} /> : '-'])} empty="No invoices yet." /></Sub>
                </>
              )}
            </div>
          )}
          {!loading && !detail && <Empty title="Select a matter" text="Matter detail will appear here." />}
        </Card>
      </div>
      <ProfileTooltip tooltip={tooltip} />
      <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

export function Tasks({ data, canManage, reload, notify, focus }) {
  const [form, setForm] = useState({ matterId: '', title: '', dueDate: '' });
  const [editingTask, setEditingTask] = useState(null);
  const [confirm, setConfirm] = useState(null);

  useEffect(() => {
    if (!focus?.taskId) return;
    const el = document.getElementById(`task-${focus.taskId}`);
    if (el) {
      const prev = el.style.background;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.background = 'rgba(212, 163, 74, 0.15)';
      setTimeout(() => { el.style.background = prev; }, 1200);
    }
  }, [focus?.taskId, focus?.ts]);
  async function submit(event) { event.preventDefault(); try { await api('/tasks', { method: 'POST', body: form }); setForm({ matterId: '', title: '', dueDate: '' }); notify({ type: 'success', message: 'Task created.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function toggle(task) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: { completed: !task.completed } }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function saveTask(task, values) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: values }); setEditingTask(null); notify({ type: 'success', message: 'Task updated.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteTaskRecord(task) { try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Task deleted.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <div className="lf-split-grid lf-task-split-grid" style={styles.splitGrid}><Card title="New task" hint="Deadline control"><form onSubmit={submit} style={styles.formGrid}><Field label="Matter"><select required style={styles.input} value={form.matterId} onChange={e => setForm({ ...form, matterId: e.target.value })}><option value="">Select matter</option>{data.matters.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></Field><Field label="Task"><input required style={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field><Field label="Due"><input type="date" style={styles.input} value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></Field><button style={styles.primaryButton}>Create task</button></form></Card><Card title="Task board" hint={`${data.tasks.length} tasks`}><TaskEditorList tasks={data.tasks} canManage={canManage} editingTask={editingTask} setEditingTask={setEditingTask} saveTask={saveTask} toggle={toggle} confirmDelete={task => setConfirm({ title: 'Delete task?', message: 'Delete this task?', onConfirm: () => deleteTaskRecord(task) })} /></Card><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></div>;
}

export function Invoices({ invoices, isAdmin, canManage, reload, notify }) {
  const [confirm, setConfirm] = useState(null);
  async function setStatus(id, status) { try { await api(`/invoices/${id}/status`, { method: 'PATCH', body: { status } }); notify({ type: 'success', message: 'Invoice updated.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteInvoiceRecord(invoice) { try { await api(`/invoices/${invoice.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Invoice deleted.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <><Card title="Invoice register" hint="Receivables"><div className="lf-invoice-cards"><Table columns={['Invoice', 'Client', 'Matter', 'Amount', 'Status', 'PDF', 'Actions']} rows={invoices.map(i => [i.number || i.id, i.clientName || '-', i.matterTitle || '-', kes(i.amount), isAdmin ? <select key={i.id} style={styles.tableSelect} value={i.status} onChange={e => setStatus(i.id, e.target.value)}><option>Outstanding</option><option>Paid</option><option>Overdue</option></select> : <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <DownloadButton key={`${i.id}-pdf`} label="Download" path={`/api/invoices/${i.id}/pdf`} filename={`${i.number || i.id}.pdf`} notify={notify} />, canManage && i.status !== 'Paid' ? <ActionGroup key={`${i.id}-actions`} actions={[['Delete', () => setConfirm({ title: 'Delete invoice?', message: 'Delete this invoice?', onConfirm: () => deleteInvoiceRecord(i) })]]} /> : '-'])} empty="No invoices yet." /></div></Card><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></>;
}

async function downloadWithNotify(path, filename, notify) {
  try {
    await downloadWithAuth(path, filename);
  } catch (err) {
    notify?.({ type: 'danger', message: err.message });
  }
}

function DownloadButton({ label, path, filename, notify }) {
  return (
    <button type="button" style={{ ...styles.link, border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }} onClick={() => downloadWithNotify(path, filename, notify)}>
      {label}
    </button>
  );
}

export function FirmSettings({ settings, clients = [], reload, notify }) {
  const emptyNoticeForm = { title: '', content: '', clientId: '', files: [] };
  const [form, setForm] = useState({ ...defaultFirmSettings, ...settings });
  const [notices, setNotices] = useState([]);
  const [noticeForm, setNoticeForm] = useState(emptyNoticeForm);
  const [publishingNotice, setPublishingNotice] = useState(false);
  const [theme, setTheme] = useState(null);
  const [presets, setPresets] = useState([]);
  const [themeLoading, setThemeLoading] = useState(false);
  const [themePreview, setThemePreview] = useState(null);
  const [themeError, setThemeError] = useState('');

  useEffect(() => setForm({ ...defaultFirmSettings, ...settings }), [settings]);
  useEffect(() => { loadNotices(); }, []);

  async function loadNotices() {
    try { setNotices(await api('/notices')); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  function setReminderSetting(key, value) {
    setForm(current => ({ ...current, reminderSettings: { ...(current.reminderSettings || {}), [key]: value } }));
  }

  async function chooseLogo(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setForm({ ...form, logo: await fileToDataUrl(file) });
  }

  function chooseNoticeFiles(event) {
    const selected = Array.from(event.target.files || []);
    if (!selected.length) return;
    setNoticeForm(current => {
      const files = [...current.files, ...selected].slice(0, 10);
      if (current.files.length + selected.length > 10) {
        notify({ type: 'warning', message: 'A notice can include up to 10 attachments.' });
      }
      return { ...current, files };
    });
    event.target.value = '';
  }

  function removeNoticeFile(index) {
    setNoticeForm(current => ({ ...current, files: current.files.filter((_, fileIndex) => fileIndex !== index) }));
  }

  useEffect(() => {
    loadTheme();
    loadPresets();
  }, []);

  async function loadTheme() {
    try {
      const data = await getFirmTheme();
      setTheme(data?.theme || null);
      if (data?.theme) applyFirmTheme(data.theme);
    } catch (err) { setThemeError(err.message); }
  }

  async function loadPresets() {
    try { setPresets(await getThemePresets()); }
    catch { setPresets([]); }
  }

  async function handlePreview(presetId) {
    const sourceTheme = presetId ? presets.find(p => p.id === presetId) : theme;
    if (!sourceTheme) return;
    setThemeLoading(true);
    setThemeError('');
    try {
      const data = await previewFirmTheme({ ...sourceTheme, source: presetId ? 'preset' : sourceTheme.source });
      if (data?.theme) {
        setThemePreview(data.theme);
        applyFirmTheme(data.theme);
      }
      if (data?.warnings?.length) setThemeError(`Preview warnings: ${data.warnings.join(', ')}`);
    } catch (err) { setThemeError(err.message); }
    finally { setThemeLoading(false); }
  }

  async function handleSave() {
    if (!themePreview && !theme) return;
    setThemeLoading(true);
    setThemeError('');
    try {
      const payload = themePreview || theme;
      const data = await updateFirmTheme(payload);
      if (data?.theme) {
        setTheme(data.theme);
        setThemePreview(null);
        applyFirmTheme(data.theme);
        notify({ type: 'success', message: 'Theme saved.' });
      }
    } catch (err) { setThemeError(err.message); }
    finally { setThemeLoading(false); }
  }

  async function handleReset() {
    if (!window.confirm('Reset firm theme to default? This clears custom colors.')) return;
    setThemeLoading(true);
    setThemeError('');
    try {
      const data = await resetFirmTheme();
      setTheme(null);
      setThemePreview(null);
      clearFirmTheme();
      if (data?.theme) {
        setTheme(data.theme);
        applyFirmTheme(data.theme);
      }
      notify({ type: 'success', message: data?.message || 'Theme reset to default.' });
    } catch (err) { setThemeError(err.message); }
    finally { setThemeLoading(false); }
  }

  async function submit(event) {
    event.preventDefault();
    try {
      await api('/firm-settings', { method: 'PUT', body: form });
      notify({ type: 'success', message: 'Firm settings saved.' });
      await reload();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  async function createNotice(event) {
    event.preventDefault();
    setPublishingNotice(true);
    try {
      const attachments = await Promise.all(noticeForm.files.map(async file => ({
        name: file.name,
        displayName: file.name,
        mimeType: file.type || 'application/octet-stream',
        data: await fileToDataUrl(file),
      })));
      await api('/notices', { method: 'POST', body: { title: noticeForm.title, content: noticeForm.content, clientId: noticeForm.clientId, attachments } });
      setNoticeForm(emptyNoticeForm);
      notify({ type: 'success', message: attachments.length ? 'Notice published with attachments.' : 'Notice published.' });
      await loadNotices();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
    finally { setPublishingNotice(false); }
  }

  async function deleteNotice(notice) {
    try {
      await api(`/notices/${notice.id}`, { method: 'DELETE' });
      notify({ type: 'success', message: 'Notice deleted.' });
      await loadNotices();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  function attachmentSummary(attachments = []) {
    if (!attachments.length) return <span style={styles.mutedText}>None</span>;
    return (
      <div style={styles.noticeAttachmentSummary}>
        {attachments.slice(0, 3).map(file => <span key={file.id}>{noticeFileName(file)}</span>)}
        {attachments.length > 3 && <span>+{attachments.length - 3} more</span>}
      </div>
    );
  }

  const reminder = form.reminderSettings || {};

  return (
    <div style={styles.pageStack}>
      <Card title="Firm Settings" hint="Branding, invoice identity and client portal contact details">
        <form onSubmit={submit} style={styles.formGrid}>
          <Field label="Firm Name"><input required style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Website URL"><input type="url" style={styles.input} value={form.websiteURL || ''} onChange={e => setForm({ ...form, websiteURL: e.target.value })} /></Field>
          <Field label="Primary Color"><input type="color" style={styles.colorInput} value={form.primaryColor || '#0F1B33'} onChange={e => setForm({ ...form, primaryColor: e.target.value })} /></Field>
          <Field label="Accent Color"><input type="color" style={styles.colorInput} value={form.accentColor || '#D4A34A'} onChange={e => setForm({ ...form, accentColor: e.target.value })} /></Field>
          <Field label="Email"><input style={styles.input} value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Phone"><input style={styles.input} value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Address"><input style={styles.input} value={form.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} /></Field>
          <Field label="Logo"><input type="file" accept="image/*" style={styles.input} onChange={chooseLogo} /></Field>
          <div className="lf-logo-preview" style={styles.logoPreview}>
            {form.logo ? <img src={form.logo} alt="Firm logo preview" /> : <span>LF</span>}
            <button type="button" style={styles.tinyButton} onClick={() => setForm({ ...form, logo: '' })}>Clear logo</button>
          </div>
          <Field label="Allow advocates to see billing information">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={Number(form.advocateBillingVisibility ?? 1) !== 0} onChange={e => setForm({ ...form, advocateBillingVisibility: e.target.checked ? 1 : 0 })} />
              Advocates can view billing data
            </label>
            <div style={styles.formHelper}>When unchecked, advocates cannot see revenue, invoice amounts, invoice PDFs, billing rates, or time-entry rates.</div>
          </Field>
          <button style={styles.primaryButton}>Save settings</button>
        </form>
      </Card>

      <Card title="Firm Branding / Theme" hint="Customize colors and preview firm identity across the workspace">
        <div style={{ ...styles.formGrid, marginBottom: 16 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: theme.muted }}><span>Presets</span></label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              {presets.map(p => (
                <button key={p.id} type="button" onClick={() => handlePreview(p.id)} style={{ ...styles.ghostButton, borderColor: themePreview?.source === 'preset' && themePreview?.id === p.id ? theme.gold : undefined }} disabled={themeLoading}>
                  {p.id === 'lexflow-default' ? 'LexFlow Default' : p.id === 'emerald-gold' ? 'Emerald Gold' : p.id === 'midnight-slate' ? 'Midnight Slate' : p.id}
                </button>
              ))}
              <button type="button" onClick={() => handlePreview(null)} style={styles.ghostButton} disabled={themeLoading}>Custom (current)</button>
            </div>
          </div>
          <Field label="Primary Color"><input type="color" style={styles.colorInput} value={(themePreview || theme)?.primaryColor || '#0F1B33'} onChange={e => { setThemePreview(prev => ({ ...(prev || theme || {}), primaryColor: e.target.value, source: 'manual' })); }} /></Field>
          <Field label="Accent Color"><input type="color" style={styles.colorInput} value={(themePreview || theme)?.accentColor || '#D4A34A'} onChange={e => { setThemePreview(prev => ({ ...(prev || theme || {}), accentColor: e.target.value, source: 'manual' })); }} /></Field>
          <Field label="Background"><input type="color" style={styles.colorInput} value={(themePreview || theme)?.backgroundColor || '#0A0F1A'} onChange={e => { setThemePreview(prev => ({ ...(prev || theme || {}), backgroundColor: e.target.value, source: 'manual' })); }} /></Field>
          <Field label="Surface"><input type="color" style={styles.colorInput} value={(themePreview || theme)?.surfaceColor || '#111827'} onChange={e => { setThemePreview(prev => ({ ...(prev || theme || {}), surfaceColor: e.target.value, source: 'manual' })); }} /></Field>
          <Field label="Text"><input type="color" style={styles.colorInput} value={(themePreview || theme)?.textColor || '#E5E7EB'} onChange={e => { setThemePreview(prev => ({ ...(prev || theme || {}), textColor: e.target.value, source: 'manual' })); }} /></Field>
          <Field label="Text Muted"><input type="color" style={styles.colorInput} value={(themePreview || theme)?.textSecondaryColor || '#9CA3AF'} onChange={e => { setThemePreview(prev => ({ ...(prev || theme || {}), textSecondaryColor: e.target.value, source: 'manual' })); }} /></Field>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <button style={styles.primaryButton} onClick={handleSave} disabled={themeLoading}>{themeLoading ? 'Saving...' : 'Save Theme'}</button>
          <button style={styles.ghostButton} onClick={() => { applyFirmTheme(themePreview || theme || {}); setThemePreview(null); setThemeError(''); }} disabled={!themePreview || themeLoading}>Apply Preview</button>
          <button style={styles.dangerButton} onClick={handleReset} disabled={themeLoading}>{themeLoading ? 'Resetting...' : 'Reset to Default'}</button>
        </div>
        {themeError && <div style={{ ...styles.alert, ...(themeError.startsWith('Preview warnings') ? {} : styles.alertDanger), padding: 10, borderRadius: 6 }}>{themeError}</div>}
        <div style={{ marginTop: 12, padding: 14, borderRadius: 8, background: 'var(--lf-surface, #111827)', border: `1px solid var(--lf-border, ${theme.line})`, color: 'var(--lf-text, #E5E7EB)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8, color: 'var(--lf-text-muted, #9CA3AF)' }}>Theme Preview</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button style={{ border: 0, borderRadius: 6, padding: '6px 14px', background: 'var(--lf-button, #D4A34A)', color: 'var(--lf-button-text, #fff)', fontWeight: 700, cursor: 'pointer' }}>Primary Button</button>
            <button style={{ border: `1px solid var(--lf-border, ${theme.line})`, borderRadius: 6, padding: '6px 14px', background: '#fff', color: 'var(--lf-primary, #0F1B33)', fontWeight: 700, cursor: 'pointer' }}>Ghost Button</button>
          </div>
          <div style={{ padding: 10, borderRadius: 6, background: 'var(--lf-background, #0A0F1A)', border: `1px solid var(--lf-border, ${theme.line})`, fontSize: 12, color: 'var(--lf-text-muted, #9CA3AF)' }}>Surface / Card sample with <a href="#" style={{ color: 'var(--lf-link, #D4A34A)', textDecoration: 'none' }}>link sample</a> and <span style={{ color: 'var(--lf-success, #047857)' }}>success</span>, <span style={{ color: 'var(--lf-warning, #B45309)' }}>warning</span>, <span style={{ color: 'var(--lf-danger, #B91C1C)' }}>danger</span> text.</div>
        </div>
      </Card>

      <Card title="Client Reminder Automation" hint="Quiet reminders for court dates and invoice follow-ups. Templates use firm defaults and run silently in the background.">
        <form onSubmit={submit} style={styles.formGrid}>
          <Field label="Automatic Reminders"><select style={styles.input} value={reminder.remindersEnabled ? 'yes' : 'no'} onChange={e => setReminderSetting('remindersEnabled', e.target.value === 'yes')}><option value="yes">Enabled</option><option value="no">Disabled</option></select></Field>
          <Field label="WhatsApp"><select style={styles.input} value={reminder.whatsappEnabled ? 'yes' : 'no'} onChange={e => setReminderSetting('whatsappEnabled', e.target.value === 'yes')}><option value="no">Off</option><option value="yes">On</option></select></Field>
          <Field label="Email"><select style={styles.input} value={reminder.emailEnabled ? 'yes' : 'no'} onChange={e => setReminderSetting('emailEnabled', e.target.value === 'yes')}><option value="no">Off</option><option value="yes">On</option></select></Field>
          {reminder.whatsappEnabled && <>
            <Field label="Twilio SID"><input style={styles.input} value={reminder.twilioSid || ''} onChange={e => setReminderSetting('twilioSid', e.target.value)} /></Field>
            <Field label="Twilio Token"><input type="password" style={styles.input} value={reminder.twilioToken || ''} onChange={e => setReminderSetting('twilioToken', e.target.value)} /></Field>
            <Field label="WhatsApp From"><input style={styles.input} value={reminder.twilioFromNumber || ''} onChange={e => setReminderSetting('twilioFromNumber', e.target.value)} placeholder="whatsapp:+14155238886" /></Field>
          </>}
          {reminder.emailEnabled && <>
            <Field label="SMTP Host"><input style={styles.input} value={reminder.smtpHost || ''} onChange={e => setReminderSetting('smtpHost', e.target.value)} /></Field>
            <Field label="SMTP Port"><input style={styles.input} value={reminder.smtpPort || ''} onChange={e => setReminderSetting('smtpPort', e.target.value)} /></Field>
            <Field label="SMTP User"><input style={styles.input} value={reminder.smtpUser || ''} onChange={e => setReminderSetting('smtpUser', e.target.value)} /></Field>
            <Field label="SMTP Password"><input type="password" style={styles.input} value={reminder.smtpPass || ''} onChange={e => setReminderSetting('smtpPass', e.target.value)} /></Field>
          </>}
          <div style={styles.formHelper}>When credentials are blank, LexFlow uses console stubs for testing. Real messages send automatically once provider credentials are saved.</div>
          <button style={styles.primaryButton}>Save automation</button>
        </form>
      </Card>

      <Card title="Client Portal Notices" hint="Publish broadcast or client-specific updates with secure attachments">
        <form onSubmit={createNotice} style={styles.formGrid}>
          <Field label="Audience">
            <select style={styles.input} value={noticeForm.clientId} onChange={e => setNoticeForm({ ...noticeForm, clientId: e.target.value })}>
              <option value="">All clients</option>
              {clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
            </select>
          </Field>
          <Field label="Title"><input required style={styles.input} value={noticeForm.title} onChange={e => setNoticeForm({ ...noticeForm, title: e.target.value })} /></Field>
          <Field label="Attachments"><input type="file" multiple accept=".pdf,.doc,.docx,.txt,image/*" style={styles.input} onChange={chooseNoticeFiles} /></Field>
          <Field label="Content">
            <textarea required rows={4} style={{ ...styles.input, minHeight: 104, resize: 'vertical' }} value={noticeForm.content} onChange={e => setNoticeForm({ ...noticeForm, content: e.target.value })} />
          </Field>
          <div style={styles.formHelper}>Attachments are stored in LexFlow and exposed only through authenticated client downloads.</div>
          {!!noticeForm.files.length && (
            <div style={styles.noticeAttachmentPreview}>
              {noticeForm.files.map((file, index) => (
                <div key={`${file.name}-${file.lastModified}-${index}`} style={styles.noticeAttachmentPreviewItem}>
                  <div>
                    <strong>{file.name}</strong>
                    <span>{file.type || 'File'} | {formatFileSize(file.size)}</span>
                  </div>
                  <button type="button" style={styles.dangerTinyButton} onClick={() => removeNoticeFile(index)}>Remove</button>
                </div>
              ))}
            </div>
          )}
          <button disabled={publishingNotice} style={styles.primaryButton}>{publishingNotice ? 'Publishing...' : 'Publish notice'}</button>
        </form>
        <Table
          columns={['Title', 'Audience', 'Attachments', 'Created', 'Actions']}
          rows={notices.map(n => [
            n.title,
            n.clientName ? <Badge key={`${n.id}-audience`} tone="amber">{n.clientName}</Badge> : <Badge key={`${n.id}-audience`} tone="blue">All clients</Badge>,
            attachmentSummary(n.attachments),
            n.createdAt ? new Date(n.createdAt).toLocaleString() : '-',
            <button key={n.id} type="button" style={styles.dangerTinyButton} onClick={() => deleteNotice(n)}>Delete</button>,
          ])}
          empty="No notices yet."
        />
      </Card>
    </div>
  );
}
export function Users({ clients = [], notify }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ email: '', password: '', fullName: '', role: 'assistant', clientId: '' });
  const [includeInactive, setIncludeInactive] = useState(false);
  useEffect(() => { load(); }, [includeInactive]);
  async function load() { try { setUsers(await api(`/auth/users${includeInactive ? '?include_inactive=true' : ''}`)); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function submit(event) { event.preventDefault(); try { await api('/auth/register', { method: 'POST', body: form }); setForm({ email: '', password: '', fullName: '', role: 'assistant', clientId: '' }); notify({ type: 'success', message: 'User created.' }); await load(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function updateRole(userId, newRole, fullName) {
    try {
      await api(`/auth/users/${userId}/role`, { method: 'PATCH', body: { role: newRole } });
      notify({ type: 'success', message: `Role updated for ${fullName}.` });
      await load();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function toggleActive(userId, isActive, fullName) {
    try {
      await api(`/auth/users/${userId}/toggle-active`, { method: 'PATCH', body: { isActive } });
      notify({ type: 'success', message: `${isActive ? 'Activated' : 'Deactivated'} ${fullName}.` });
      await load();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  return <div className="lf-split-grid" style={styles.splitGrid}>
    <Card title="Create user" hint="Role-based access"><form onSubmit={submit} style={styles.formGrid}>
      <Field label="Full name"><input required style={styles.input} value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} /></Field>
      <Field label="Email"><input required style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
      <Field label="Password"><input required type="password" style={styles.input} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>
      <Field label="Role"><select style={styles.input} value={form.role} onChange={e => setForm({ ...form, role: e.target.value, clientId: e.target.value === 'client' ? form.clientId : '' })}><option value="assistant">Assistant</option><option value="advocate">Advocate</option><option value="admin">Admin</option><option value="client">Client</option></select></Field>
      {form.role === 'client' && <><Field label="Linked Client"><select required style={styles.input} value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })}><option value="">Select client</option>{clients.map(c => <option key={c.id}>{c.name}</option>)}</select></Field><div style={styles.formHelper}>Client users can view only the linked client's matters, documents, invoices, and messages. Share credentials manually after creating the account.</div></>}
      <button style={styles.primaryButton}>Create user</button>
    </form></Card>
    <Card title="Team" hint={`${users.length} users`}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13 }}>
        <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} />
        Show inactive users
      </label>
      <div className="lf-user-cards">
        <Table columns={['Name', 'Email', 'Role', 'Status', 'Client', 'Actions']} rows={users.map(u => [
          u.fullName,
          u.email,
          <select key={`role-${u.id}`} style={{ ...styles.input, width: 140 }} value={u.role} disabled={u.role === 'client'} onChange={e => updateRole(u.id, e.target.value, u.fullName)}>
            <option value="assistant">Assistant</option>
            <option value="advocate">Advocate</option>
            <option value="admin">Admin</option>
          </select>,
          <Badge key={`status-${u.id}`} tone={u.isActive ? 'green' : 'red'}>{u.isActive ? 'Active' : 'Inactive'}</Badge>,
          u.clientId ? clients.find(c => c.id === u.clientId)?.name || u.clientId : '-',
          <div key={`actions-${u.id}`} style={{ display: 'flex', gap: 6 }}>
            <button style={styles.tinyButton} onClick={() => toggleActive(u.id, !u.isActive, u.fullName)}>{u.isActive ? 'Deactivate' : 'Activate'}</button>
          </div>,
        ])} empty="No users found." />
      </div>
    </Card>
  </div>;
}

function TaskEditorList({ tasks, entries = [], matter, canManage, canViewBilling = true, editingTask, setEditingTask, saveTask, toggle, confirmDelete, taskTimer, setTaskTimer, notify, onTimerSaved }) {
  if (!tasks.length) return <Empty title="No tasks yet." text="Once records exist, they will appear here." />;
  return (
    <div className="lf-task-cards" style={styles.tableWrap}>
      <table style={styles.table}>
        <thead><tr>{['Task', 'Assignee', 'Due', 'Status', 'Timer', 'Actions'].map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{tasks.map(task => {
          const editing = editingTask?.id === task.id;
          const taskEntries = entries.filter(entry => entry.taskId === task.id);
          const isTiming = taskTimerActive(taskTimer, task.id);
          return (
            <tr key={task.id} id={`task-${task.id}`} style={{ borderLeft: `4px solid ${isTiming ? theme.green : 'transparent'}`, transition: 'border-color .18s ease, background .18s ease' }}>
              <td>{editing ? <input style={styles.input} value={editingTask.title || ''} onChange={e => setEditingTask({ ...editingTask, title: e.target.value })} /> : <div style={{ display: 'grid', gap: 3 }}><strong>{task.title}</strong>{taskEntries.length > 0 && <small style={{ color: theme.muted }}>{taskEntries.reduce((sum, entry) => sum + Number(entry.hours || 0), 0).toFixed(2)} hours logged from {taskEntries.length} entr{taskEntries.length === 1 ? 'y' : 'ies'}</small>}</div>}</td>
              <td>{editing ? <input style={styles.input} value={editingTask.assignee || ''} onChange={e => setEditingTask({ ...editingTask, assignee: e.target.value })} /> : task.assignee || '-'}</td>
              <td>{editing ? <input type="date" style={styles.input} value={editingTask.dueDate || ''} onChange={e => setEditingTask({ ...editingTask, dueDate: e.target.value })} /> : task.dueDate || '-'}</td>
              <td><Badge tone={task.completed ? 'green' : 'amber'}>{task.completed ? 'Done' : 'Open'}</Badge></td>
              <td>{canManage && matter ? <TaskTimer task={{ ...task, timeEntries: taskEntries }} matterId={matter.id} matterRate={canViewBilling ? matter.billingRate || 15000 : 0} showRate={canViewBilling} timer={taskTimer} setTimer={setTaskTimer} notify={notify} onSaved={onTimerSaved} /> : '-'}</td>
              <td>{canManage ? editing ? <ActionGroup actions={[['Save', () => saveTask(task, editingTask)], ['Cancel', () => setEditingTask(null)]]} /> : <ActionGroup actions={[[task.completed ? 'Reopen' : 'Complete', () => toggle ? toggle(task) : saveTask(task, { completed: !task.completed })], ['Edit', () => setEditingTask({ ...task })], ['Delete', () => confirmDelete(task)]]} /> : '-'}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function AppearanceEditorList({ events, canManage, editingEvent, setEditingEvent, saveEvent, confirmDelete }) {
  if (!events.length) return <Empty title="No court appearances." text="Scheduled appearances will appear here." />;
  return (
    <div style={styles.tableWrap} className="lf-appearance-cards">
      <table style={styles.table}>
        <thead><tr>{['Title', 'Date', 'Time', 'Type', 'Location', 'Virtual Court', 'Actions'].map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{events.map(event => {
          const editing = editingEvent?.id === event.id;
          return (
            <tr key={event.id}>
              <td>{editing ? <input style={styles.input} value={editingEvent.title || ''} onChange={e => setEditingEvent({ ...editingEvent, title: e.target.value })} /> : event.title || '-'}</td>
              <td>{editing ? <input type="date" style={styles.input} value={editingEvent.date || ''} onChange={e => setEditingEvent({ ...editingEvent, date: e.target.value })} /> : event.date || '-'}</td>
              <td>{editing ? <input style={styles.input} value={editingEvent.time || ''} onChange={e => setEditingEvent({ ...editingEvent, time: e.target.value })} /> : event.time || '-'}</td>
              <td>{editing ? <input style={styles.input} value={editingEvent.type || ''} onChange={e => setEditingEvent({ ...editingEvent, type: e.target.value })} /> : event.type || '-'}</td>
              <td>{editing ? <input style={styles.input} value={editingEvent.location || ''} onChange={e => setEditingEvent({ ...editingEvent, location: e.target.value })} /> : event.location || '-'}</td>
              <td>{editing ? <input type="url" placeholder="https://..." style={styles.input} value={editingEvent.meetingLink || ''} onChange={e => setEditingEvent({ ...editingEvent, meetingLink: e.target.value })} /> : <MeetingLink event={event} />}</td>
              <td>{canManage ? editing ? <ActionGroup actions={[['Save', () => saveEvent(event, editingEvent)], ['Cancel', () => setEditingEvent(null)]]} /> : <ActionGroup actions={[['Edit', () => setEditingEvent({ ...event })], ['Delete', () => confirmDelete(event)]]} /> : '-'}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function TimeEntryEditorList({ entries, canManage, canViewBilling = true, editingTime, setEditingTime, saveTimeEntry, confirmDelete }) {
  if (!entries.length) return <Empty title="No time entries." text="Logged time will appear here." />;
  const columns = ['Date', 'Description', 'Hours', ...(canViewBilling ? ['Rate'] : []), 'Billing class', 'Invoice status', 'Actions'];
  return (
    <div className={`lf-time-entry-cards${canViewBilling ? '' : ' lf-time-entry-cards-no-rate'}`} style={styles.tableWrap}>
      <table style={styles.table}>
        <thead><tr>{columns.map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{entries.map(entry => {
          const editing = editingTime?.id === entry.id;
          return (
            <tr key={entry.id}>
              <td>{editing ? <input type="date" style={styles.input} value={editingTime.date || ''} onChange={e => setEditingTime({ ...editingTime, date: e.target.value })} /> : entry.date || '-'}</td>
              <td>{editing ? <input style={styles.input} value={editingTime.description || ''} onChange={e => setEditingTime({ ...editingTime, description: e.target.value })} /> : <span>{entry.description || entry.activity || '-'}{entry.taskId ? <small style={{ display: 'block', color: theme.muted }}>Task: {entry.taskId}</small> : null}</span>}</td>
              <td>{editing ? <input type="number" step="0.1" style={styles.input} value={editingTime.hours || 0} onChange={e => setEditingTime({ ...editingTime, hours: Number(e.target.value) })} /> : Number(entry.hours || 0).toFixed(1)}</td>
              {canViewBilling && <td>{editing ? <input type="number" style={styles.input} value={editingTime.rate || 0} onChange={e => setEditingTime({ ...editingTime, rate: Number(e.target.value) })} /> : kes(entry.rate)}</td>}
              <td>{editing ? <select style={styles.tableSelect} value={isBillableValue(editingTime.billable) ? 'billable' : 'non_billable'} onChange={e => setEditingTime({ ...editingTime, billable: e.target.value === 'billable' })}><option value="billable">Billable</option><option value="non_billable">Non-billable</option></select> : <BillableBadge value={entry.billable} />}</td>
              <td><Badge tone={entry.billed ? 'green' : 'amber'}>{entry.billed ? 'Billed' : 'Unbilled'}</Badge></td>
              <td>{canManage ? editing ? <ActionGroup actions={[['Save', () => saveTimeEntry(entry, editingTime)], ['Cancel', () => setEditingTime(null)]]} /> : <ActionGroup actions={[[entry.billed ? 'Unbill' : 'Bill', () => saveTimeEntry(entry, { billed: !entry.billed })], ['Edit', () => setEditingTime({ ...entry })], ['Delete', () => confirmDelete(entry)]]} /> : '-'}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function AssistantSuggestions({ suggestions }) {
  const items = suggestions.length ? suggestions : ['This matter looks up to date. No urgent action is needed right now.'];
  return (
    <div style={styles.assistantPanel}>
      <div style={styles.assistantIntro}>
        <strong>Matter Assistant</strong>
        <span>Rule-based prompts drawn from tasks, billing, documents, notes, and upcoming court dates.</span>
      </div>
      <div style={styles.suggestionList}>
        {items.map((text, index) => {
          const lower = text.toLowerCase();
          const isGood = lower.includes('up to date') || lower.includes('no urgent');
          const isWarning = lower.includes('overdue') || lower.includes('court') || lower.includes('hearing') || lower.includes('retainer') || lower.includes('outstanding');
          return (
            <div key={`${text}-${index}`} style={{ ...styles.suggestionItem, ...(isWarning ? styles.suggestionWarning : isGood ? styles.suggestionGood : {}) }}>
              <span style={styles.suggestionIcon}>{isGood ? 'OK' : isWarning ? '!' : 'TIP'}</span>
              <span>{text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function hintTone(severity) {
  if (severity === 'critical' || severity === 'high') return 'red';
  if (severity === 'medium') return 'amber';
  return 'blue';
}

function hintLabel(value) {
  return String(value || '').replace(/-/g, ' ');
}

function MatterNextActionHints({ hints = [] }) {
  const visibleHints = hints.slice(0, 5);

  return (
    <section aria-label="Matter Next-Action Hints" style={{ border: `1px solid ${theme.line}`, background: '#fff', borderRadius: 10, padding: 14, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 2 }}>
          <strong style={{ fontSize: 13 }}>Next-Action Hints</strong>
          <span style={{ color: theme.muted, fontSize: 12 }}>Rule-based from current matter detail only.</span>
        </div>
        <Badge tone="blue">{visibleHints.length} shown</Badge>
      </div>
      {visibleHints.length ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {visibleHints.map((hint, index) => {
            const tone = hintTone(hint.severity);
            return (
              <div key={`${hint.title}-${index}`} style={{ border: `1px solid ${theme.line}`, borderLeft: `4px solid ${timelineToneColor(tone)}`, borderRadius: 8, background: '#F8FAFC', padding: 10, display: 'grid', gap: 7 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Badge tone={tone}>{hintLabel(hint.severity)}</Badge>
                  <Badge tone="blue">{hintLabel(hint.category)}</Badge>
                </div>
                <strong style={{ fontSize: 13 }}>{hint.title}</strong>
                <span style={{ color: theme.muted, fontSize: 12 }}>{hint.why}</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(hint.evidence || []).map((item, itemIndex) => (
                    <span key={`${item}-${itemIndex}`} style={{ border: `1px solid ${theme.line}`, background: '#fff', borderRadius: 999, color: theme.ink, fontSize: 11, fontWeight: 700, padding: '3px 8px' }}>{item}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <span style={{ color: theme.muted, fontSize: 12 }}>Matter appears current from available signals.</span>
      )}
    </section>
  );
}

function MatterCommandSummary({ detail, nextActionHints = [] }) {
  const summary = useMemo(() => {
    const today = isoDateOnly();
    const notes = detail?.notes || [];
    const entries = detail?.timeEntries || [];
    const appearances = detail?.appearances || [];
    const documents = detail?.documents || [];
    const invoices = detail?.invoices || [];
    const tasks = detail?.tasks || [];

    const latestCandidates = [
      ...notes.map(note => ({ label: `Case note by ${note.author || 'staff'}`, at: note.createdAt })),
      ...entries.map(entry => ({ label: `Time entry (${Number(entry.hours || 0).toFixed(1)}h)`, at: entry.date })),
      ...documents.map(doc => ({ label: `Document: ${doc.displayName || doc.name || 'File'}`, at: doc.date })),
      ...invoices.map(invoice => ({ label: `Invoice ${invoice.number || invoice.id}`, at: invoice.date })),
      ...appearances.map(event => ({ label: `Court event: ${event.title || event.type || 'Appearance'}`, at: event.date })),
    ].map(item => ({ ...item, parsed: parseDateValue(item.at) })).filter(item => item.parsed);

    latestCandidates.sort((a, b) => b.parsed.getTime() - a.parsed.getTime());
    const lastActivity = latestCandidates[0];

    const upcomingAppearance = appearances
      .filter(event => event.date && event.date >= today)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null;

    const nextTask = tasks
      .filter(task => !task.completed && task.dueDate && task.dueDate >= today)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0] || null;

    const nextInvoice = invoices
      .filter(invoice => invoice.status !== 'Paid' && invoice.dueDate && invoice.dueDate >= today)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0] || null;

    const solDate = detail?.solDate || '';
    const upcomingSol = solDate && solDate >= today ? solDate : '';

    const nextCandidates = [
      upcomingAppearance ? { label: `${upcomingAppearance.type || 'Court'} on ${upcomingAppearance.date}`, date: upcomingAppearance.date } : null,
      nextTask ? { label: `Task due ${nextTask.dueDate}: ${nextTask.title}`, date: nextTask.dueDate } : null,
      upcomingSol ? { label: `SOL advisory date ${upcomingSol}`, date: upcomingSol } : null,
      nextInvoice ? { label: `Invoice due ${nextInvoice.dueDate}: ${nextInvoice.number || nextInvoice.id}`, date: nextInvoice.dueDate } : null,
    ].filter(Boolean).sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const overdueTasks = tasks.filter(task => !task.completed && task.dueDate && task.dueDate < today).length;
    const overdueInvoices = invoices.filter(invoice => (invoice.status === 'Overdue') || (invoice.status !== 'Paid' && invoice.dueDate && invoice.dueDate < today)).length;

    return {
      owner: detail?.assignedTo || 'Unassigned',
      paralegal: detail?.paralegal || '',
      stage: detail?.stage || 'Intake',
      lastActivity: lastActivity ? `${lastActivity.label} (${lastActivity.parsed.toLocaleString()})` : 'No recent activity recorded',
      nextStep: nextCandidates[0]?.label || 'No upcoming item recorded',
      court: upcomingAppearance
        ? `${upcomingAppearance.date} - ${upcomingAppearance.type || 'Appearance'}${upcomingAppearance.location ? ` (${upcomingAppearance.location})` : ''}`
        : 'No upcoming court appearance recorded',
      overdue: overdueTasks + overdueInvoices,
      overdueLabel: overdueTasks + overdueInvoices
        ? `${overdueTasks} overdue task${overdueTasks === 1 ? '' : 's'}${overdueInvoices ? `, ${overdueInvoices} overdue invoice${overdueInvoices === 1 ? '' : 's'}` : ''}`
        : 'No overdue work found',
      sol: solDate ? `${solDate} (advisory; confirm statute and facts)` : 'No SOL date recorded',
      topSuggestion: nextActionHints[0]?.title || 'No recommendation available from current matter signals.',
    };
  }, [detail, nextActionHints]);

  return (
    <section aria-label="Matter Command Summary" style={{ border: `1px solid ${theme.line}`, background: '#fff', borderRadius: 10, padding: 14, display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gap: 2 }}>
        <strong style={{ fontSize: 13 }}>Matter Command Summary</strong>
        <span style={{ color: theme.muted, fontSize: 12 }}>Read-only snapshot from current matter data.</span>
      </div>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
        <SummaryCell label="Stage" value={summary.stage} />
        <SummaryCell label="Owner" value={summary.paralegal ? `${summary.owner} / ${summary.paralegal}` : summary.owner} />
        <SummaryCell label="Last activity" value={summary.lastActivity} />
        <SummaryCell label="Next step" value={summary.nextStep} />
        <SummaryCell label="Court" value={summary.court} />
        <SummaryCell label="Overdue" value={summary.overdueLabel} tone={summary.overdue ? 'red' : ''} />
        <SummaryCell label="SOL / Limitation" value={summary.sol} tone={detail?.solDate ? 'amber' : ''} />
        <SummaryCell label="Top suggestion" value={summary.topSuggestion} />
      </div>
    </section>
  );
}

function timelineToneColor(tone) {
  if (tone === 'green') return theme.green;
  if (tone === 'amber') return theme.amber;
  if (tone === 'red') return theme.red;
  return theme.blue;
}

function MatterActivityTimeline({ detail }) {
  const events = useMemo(() => {
    const timeline = [];
    const addEvent = ({ date, source, tone = 'blue', title, detail: secondary }) => {
      timeline.push({
        date,
        parsed: parseDateValue(date),
        source,
        tone,
        title,
        secondary
      });
    };

    if (detail?.openDate) {
      addEvent({
        date: detail.openDate,
        source: 'Matter',
        title: 'Matter opened',
        detail: detail.reference || detail.title || detail.clientName || 'Matter file'
      });
    }

    (Array.isArray(detail?.notes) ? detail.notes : []).forEach(note => {
      addEvent({
        date: note.createdAt,
        source: 'Note',
        title: 'Case note recorded',
        detail: note.author ? `By ${note.author}` : 'Internal note'
      });
    });

    (Array.isArray(detail?.tasks) ? detail.tasks : []).forEach(task => {
      const status = task.completed ? 'Completed' : 'Open';
      addEvent({
        date: task.dueDate,
        source: 'Task',
        tone: task.completed ? 'green' : 'amber',
        title: 'Task due',
        detail: [status, task.title || 'Task', task.assignee && `Responsible: ${task.assignee}`].filter(Boolean).join(' - ')
      });
    });

    (Array.isArray(detail?.appearances) ? detail.appearances : []).forEach(appearance => {
      addEvent({
        date: appearance.date,
        source: 'Court',
        tone: 'red',
        title: 'Court appearance',
        detail: [appearance.title || appearance.type || 'Appearance', appearance.time, appearance.location].filter(Boolean).join(' - ')
      });
    });

    (Array.isArray(detail?.documents) ? detail.documents : []).forEach(document => {
      addEvent({
        date: document.date || document.createdAt,
        source: 'Document',
        title: 'Document added',
        detail: [
          document.displayName || document.name || 'Document',
          document.source === 'client' ? 'Client upload' : document.source === 'firm' ? 'Firm document' : null,
          document.clientVisible ? 'Client-visible' : 'Staff-only'
        ].filter(Boolean).join(' - ')
      });
    });

    (Array.isArray(detail?.timeEntries) ? detail.timeEntries : []).forEach(entry => {
      const hours = Number(entry.hours);
      addEvent({
        date: entry.date,
        source: 'Time',
        tone: 'green',
        title: 'Time logged',
        detail: [Number.isFinite(hours) ? `${hours.toFixed(1)}h` : null, entry.activity || entry.description || 'Matter work'].filter(Boolean).join(' - ')
      });
    });

    (Array.isArray(detail?.invoices) ? detail.invoices : []).forEach(invoice => {
      const label = [invoice.number || invoice.id || 'Invoice', invoice.status || 'Status not set'].filter(Boolean).join(' - ');
      addEvent({
        date: invoice.date,
        source: 'Invoice',
        tone: 'amber',
        title: 'Invoice issued',
        detail: label
      });
      if (invoice.dueDate) {
        addEvent({
          date: invoice.dueDate,
          source: 'Invoice',
          tone: 'amber',
          title: 'Invoice due',
          detail: label
        });
      }
    });

    return timeline.sort((a, b) => {
      const aTime = a.parsed ? a.parsed.getTime() : -Infinity;
      const bTime = b.parsed ? b.parsed.getTime() : -Infinity;
      if (bTime !== aTime) return bTime - aTime;
      return `${a.source}${a.title}`.localeCompare(`${b.source}${b.title}`);
    });
  }, [detail]);

  return (
    <section aria-label="Matter Activity Timeline" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 14, background: '#fff', display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 2 }}>
          <strong style={{ fontSize: 13 }}>Matter Activity Timeline</strong>
          <span style={{ color: theme.muted, fontSize: 12 }}>Read-only sequence from current matter records.</span>
        </div>
        <Badge tone="blue">{events.length} events</Badge>
      </div>
      {events.length === 0 ? (
        <div style={{ border: `1px dashed ${theme.line}`, borderRadius: 8, padding: 12, color: theme.muted, fontSize: 13 }}>
          No activity recorded for this matter yet.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {events.map((event, index) => (
            <div
              key={`${event.source}-${event.title}-${event.date || 'undated'}-${index}`}
              style={{ border: `1px solid ${theme.line}`, borderLeft: `4px solid ${timelineToneColor(event.tone)}`, borderRadius: 8, padding: 10, background: '#F8FAFC', display: 'grid', gap: 6 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: theme.ink }}>{formatTimelineDate(event.date)}</span>
                <Badge tone={event.tone}>{event.source}</Badge>
              </div>
              <strong style={{ fontSize: 13 }}>{event.title}</strong>
              {event.secondary ? <span style={{ color: theme.muted, fontSize: 12 }}>{event.secondary}</span> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SummaryCell({ label, value, tone = '' }) {
  const color = tone === 'red' ? theme.red : tone === 'amber' ? theme.amber : theme.ink;
  return (
    <div style={{ border: `1px solid ${theme.line}`, borderRadius: 8, padding: 10, background: '#fff', display: 'grid', gap: 5 }}>
      <span style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 700, color: theme.muted }}>{label}</span>
      <span style={{ fontSize: 13, color }}>{value}</span>
    </div>
  );
}

function getNextAppearance(detail) {
  const appearances = Array.isArray(detail?.appearances) ? detail.appearances : [];
  const today = isoDateOnly();
  return appearances
    .filter(a => a.date && a.date >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null;
}

function getRecentDocuments(detail) {
  const documents = Array.isArray(detail?.documents) ? detail.documents : [];
  return [...documents]
    .sort((a, b) => {
      const aDate = parseDateValue(a.date || a.createdAt);
      const bDate = parseDateValue(b.date || b.createdAt);
      return (bDate?.getTime() || 0) - (aDate?.getTime() || 0);
    })
    .slice(0, 5);
}

function CourtModeField({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <span style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 700, color: theme.muted }}>{label}</span>
      <div style={{ fontSize: 13, color: theme.ink }}>{value}</div>
    </div>
  );
}

function MatterCourtMode({ detail, nextActionHints }) {
  const nextAppearance = useMemo(() => getNextAppearance(detail), [detail]);
  const recentDocs = useMemo(() => getRecentDocuments(detail), [detail]);
  const recentTimeline = useMemo(() => {
    const timeline = [];
    const addEvent = ({ date, title, detail: secondary }) => {
      const parsed = parseDateValue(date);
      if (!parsed) return;
      timeline.push({ date: parsed, title, secondary });
    };
    (Array.isArray(detail?.notes) ? detail.notes : []).forEach(note => {
      addEvent({ date: note.createdAt, title: 'Case note recorded', detail: note.author ? `By ${note.author}` : 'Internal note' });
    });
    (Array.isArray(detail?.appearances) ? detail.appearances : []).forEach(appearance => {
      addEvent({ date: appearance.date, title: 'Court appearance', detail: [appearance.title || appearance.type || 'Appearance', appearance.time, appearance.location].filter(Boolean).join(' - ') });
    });
    (Array.isArray(detail?.documents) ? detail.documents : []).forEach(doc => {
      addEvent({ date: doc.date || doc.createdAt, title: 'Document added', detail: doc.displayName || doc.name || 'Document' });
    });
    return timeline.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 5);
  }, [detail]);

  return (
    <div className="lf-court-mode-stack" style={{ display: 'grid', gap: 12 }}>
      <div className="lf-court-mode-card" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 10 }}>
        <strong style={{ fontSize: 13 }}>Matter Summary</strong>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          <CourtModeField label="Title" value={detail?.title} />
          <CourtModeField label="Reference" value={detail?.reference} />
          <CourtModeField label="Stage" value={detail?.stage} />
          <CourtModeField label="Advocate" value={detail?.assignedTo} />
          {detail?.paralegal && <CourtModeField label="Paralegal" value={detail.paralegal} />}
          {detail?.court && <CourtModeField label="Court" value={detail.court} />}
          {detail?.judge && <CourtModeField label="Judge" value={detail.judge} />}
          {detail?.caseNo && <CourtModeField label="Case No." value={detail.caseNo} />}
          {detail?.opposingCounsel && <CourtModeField label="Opposing Counsel" value={detail.opposingCounsel} />}
        </div>
      </div>

      {nextAppearance && (
        <div className="lf-court-mode-card" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 10 }}>
          <strong style={{ fontSize: 13 }}>Next Appearance</strong>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <CourtModeField label="Date" value={formatTimelineDate(nextAppearance.date)} />
            {nextAppearance.time && <CourtModeField label="Time" value={nextAppearance.time} />}
            {nextAppearance.type && <CourtModeField label="Type" value={nextAppearance.type} />}
            {nextAppearance.location && <CourtModeField label="Location" value={nextAppearance.location} />}
            {nextAppearance.attorney && <CourtModeField label="Attorney" value={nextAppearance.attorney} />}
            {nextAppearance.prepNote && <CourtModeField label="Prep Note" value={nextAppearance.prepNote} />}
            {nextAppearance.meetingLink && <CourtModeField label="Virtual Court" value={<a href={nextAppearance.meetingLink} target="_blank" rel="noopener noreferrer" style={styles.link}>{nextAppearance.meetingLink}</a>} />}
          </div>
        </div>
      )}

      {detail?.clientName && (
        <div className="lf-court-mode-card" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 10 }}>
          <strong style={{ fontSize: 13 }}>Client Contact</strong>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <CourtModeField label="Name" value={detail.clientName} />
            {detail.clientEmail && <CourtModeField label="Email" value={<a href={`mailto:${detail.clientEmail}`} style={styles.link}>{detail.clientEmail}</a>} />}
            {detail.clientPhone && <CourtModeField label="Phone" value={<a href={`tel:${detail.clientPhone}`} style={styles.link}>{detail.clientPhone}</a>} />}
          </div>
        </div>
      )}

      {detail?.solDate && (
        <div style={{ border: `1px solid #FDE68A`, borderRadius: 10, padding: 14, background: theme.amberBg, color: theme.amber, display: 'grid', gap: 4 }}>
          <strong style={{ fontSize: 13 }}>Limitation / SOL Date</strong>
          <span>{formatTimelineDate(detail.solDate)}{daysFromToday(detail.solDate) < 0 ? ' (passed)' : daysFromToday(detail.solDate) <= 30 ? ' (within 30 days)' : ''}</span>
        </div>
      )}

      {nextActionHints?.length > 0 && (
        <div className="lf-court-mode-card" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 10 }}>
          <strong style={{ fontSize: 13 }}>Action Items</strong>
          <div style={{ display: 'grid', gap: 8 }}>
            {nextActionHints.slice(0, 5).map((hint, i) => (
              <div key={`${hint.title}-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <Badge tone={hintTone(hint.severity)}>{hint.severity}</Badge>
                <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: theme.ink }}>{hint.title}</span>
                  <span style={{ fontSize: 12, color: theme.muted }}>{hint.why}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="lf-court-mode-card" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 10 }}>
        <strong style={{ fontSize: 13 }}>Recent Activity</strong>
        {recentTimeline.length > 0 ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {recentTimeline.map((event, i) => (
              <div key={`tl-${i}`} style={{ display: 'grid', gap: 3, borderLeft: `3px solid ${theme.blue}`, paddingLeft: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: theme.ink }}>{event.date.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                <span style={{ fontSize: 13, color: theme.ink }}>{event.title}</span>
                {event.secondary && <span style={{ fontSize: 12, color: theme.muted }}>{event.secondary}</span>}
              </div>
            ))}
          </div>
        ) : (
          <span style={{ color: theme.muted, fontSize: 12 }}>No recent activity recorded.</span>
        )}
      </div>

      <div className="lf-court-mode-card" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 10 }}>
        <strong style={{ fontSize: 13 }}>Recent Documents</strong>
        {recentDocs.length > 0 ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {recentDocs.map((doc, i) => (
              <div key={`doc-${doc.id || i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: theme.ink, fontWeight: 600 }}>{noticeFileName(doc)}</span>
                <span style={{ fontSize: 12, color: theme.muted, whiteSpace: 'nowrap' }}>{formatFileSize(doc.size)}</span>
              </div>
            ))}
          </div>
        ) : (
          <span style={{ color: theme.muted, fontSize: 12 }}>No documents recorded.</span>
        )}
      </div>
    </div>
  );
}

