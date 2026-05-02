import { useEffect, useState } from 'react';
import { API_BASE, api, fileToDataUrl, readSession } from '../lib/apiClient.js';
import { defaultFirmSettings, styles } from '../theme.jsx';
import { ActionGroup, Badge, Card, ConfirmModal, Empty, Field, kes, MeetingLink, nextCourtDate, ProfileTooltip, Skeleton, Stat, statusTone, Sub, Table } from '../components/ui.jsx';
import MatterDocuments from '../components/MatterDocuments.jsx';

export function Dashboard({ data }) {
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
          <div style={styles.heroKicker}>Firm position</div>
          <h2>Today feels manageable.</h2>
          <p>{data.matters.length} matters, {data.tasks.length} tasks, and {kes(outstanding)} outstanding across active files.</p>
        </div>
        <div style={styles.heroFigure}>{kes(paid + outstanding)}</div>
      </section>

      {overdueTasks > 0 && (
        <div style={styles.warningPanel}>
          <div style={styles.warningIcon}>!</div>
          <div>
            <strong>{overdueTasks} overdue task{overdueTasks === 1 ? '' : 's'} need attention.</strong>
            <span>Review the task board and clear critical deadlines before the close of day.</span>
          </div>
        </div>
      )}

      <div style={styles.statsGrid}>
        <Stat label="Active matters" value={data.dashboard.activeMattersCount ?? data.matters.length} tone="navy" />
        <Stat label="Month hours" value={Number(data.dashboard.monthHours || 0).toFixed(1)} tone="gold" />
        <Stat label="Revenue month" value={kes(data.dashboard.monthRevenue)} tone="green" />
        <Stat label="Overdue tasks" value={overdueTasks} tone="red" />
      </div>

      <div style={styles.dashboardGrid}>
        <Card title="Matter pipeline" hint="Stage distribution">
          {Object.keys(stages).length ? Object.entries(stages).map(([stage, count]) => (
            <div key={stage} style={styles.pipelineRow}>
              <span>{stage}</span>
              <div style={styles.pipelineTrack}><div style={{ ...styles.pipelineFill, width: `${(count / maxStage) * 100}%` }} /></div>
              <strong>{count}</strong>
            </div>
          )) : <Empty title="No matters yet" text="Create a client and matter to populate the board." />}
        </Card>
        <Card title="Receivables" hint="Latest invoice status">
          <Table columns={['Invoice', 'Client', 'Amount', 'Status']} rows={data.invoices.slice(0, 6).map(i => [i.number || i.id, i.clientName || '-', kes(i.amount), <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>])} empty="No invoices yet." />
        </Card>
      </div>

      <Card title="Upcoming court dates" hint="Appearances and virtual court links">
        <Table columns={['Appearance', 'Date', 'Time', 'Location', 'Virtual Court']} rows={upcomingEvents.map(event => [
          event.title || event.type || 'Court appearance',
          event.date || '-',
          event.time || '-',
          event.location || '-',
          <MeetingLink key={event.id || `${event.date}-${event.title}`} event={event} dashboard />,
        ])} empty="No upcoming court dates." />
      </Card>
    </div>
  );
}

export function Clients({ clients, matters, canManage, isAdmin = false, reload, notify }) {
  const emptyClientForm = { name: '', type: 'Individual', contact: '', email: '', phone: '', remindersEnabled: true, preferredChannel: 'firm_default' };
  const [form, setForm] = useState(emptyClientForm);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [users, setUsers] = useState([]);
  useEffect(() => { if (isAdmin) loadUsers(); }, [isAdmin]);
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
  return <div style={styles.splitGrid}><Card title={editing ? 'Edit client' : 'New client'} hint={editing ? 'Save client changes and communication preference' : 'Intake record'}><form onSubmit={submit} style={styles.formGrid}><Field label="Name"><input required style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="Type"><select style={styles.input} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}><option>Individual</option><option>Company</option></select></Field><Field label="Contact"><input style={styles.input} value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} /></Field><Field label="Email"><input style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field><Field label="Phone"><input style={styles.input} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field><Field label="Reminders"><select style={styles.input} value={form.remindersEnabled ? 'on' : 'off'} onChange={e => setForm({ ...form, remindersEnabled: e.target.value === 'on' })}><option value="on">On</option><option value="off">Off for this client</option></select></Field><Field label="Preferred Channel"><select style={styles.input} value={form.preferredChannel} onChange={e => setForm({ ...form, preferredChannel: e.target.value })}><option value="firm_default">Firm default</option><option value="both">WhatsApp and Email</option><option value="whatsapp">WhatsApp only</option><option value="email">Email only</option><option value="none">None</option></select></Field><button style={styles.primaryButton}>{editing ? 'Save changes' : 'Create client'}</button>{editing && <button type="button" style={styles.ghostButton} onClick={() => { setEditing(null); setForm(emptyClientForm); }}>Cancel</button>}</form></Card><Card title="Client directory" hint={`${clients.length} records`}><Table columns={['Name', 'Type', 'Email', 'Phone', 'Status', 'Reminders', 'Portal', 'Actions']} rows={clients.map(c => [<span key={c.id} onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY, title: c.name, lines: [`${c.type || 'Client'} / ${c.status || 'Active'}`, `${matters.filter(m => m.clientId === c.id).length} matter(s)`, `Joined ${c.joinDate || '-'}`], initial: (c.name || 'C').slice(0, 1) })} onMouseLeave={() => setTooltip(null)} style={styles.hoverName}>{c.name}</span>, c.type, c.email || '-', c.phone || '-', <Badge key={`${c.id}-status`} tone="green">{c.status || 'Active'}</Badge>, reminderCell(c), portalCell(c), canManage ? <ActionGroup key={`${c.id}-actions`} actions={[[ 'Edit', () => startEdit(c)], ['Delete', () => setConfirm({ title: 'Delete client?', message: 'Are you sure you want to delete this client? This will also remove all related matters.', onConfirm: () => deleteClient(c) })]]} /> : '-'])} empty="No clients yet." /></Card><ProfileTooltip tooltip={tooltip} /><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></div>;
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
  const [time, setTime] = useState({ hours: 1, description: '', rate: 15000 });
  const emptyEventForm = { title: '', date: '', time: '9:00 AM', type: 'Hearing', location: '', meetingLink: '', attorney: '', prepNote: '' };
  const [eventForm, setEventForm] = useState(emptyEventForm);
  const [note, setNote] = useState('');
  const selected = data.matters.find(m => m.id === selectedId) || data.matters[0];

  useEffect(() => { if (selected?.id) { setSelectedId(selected.id); loadDetail(selected.id); } else { setDetail(null); setSuggestions([]); } }, [selected?.id]);
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
  async function logTime(event) { event.preventDefault(); if (!detail) return; try { await api('/time-entries', { method: 'POST', body: { ...time, matterId: detail.id } }); setTime({ hours: 1, description: '', rate: detail.billingRate || 15000 }); notify({ type: 'success', message: 'Time logged.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
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
  async function saveEvent(event, values) { try { await api(`/appearances/${event.id}`, { method: 'PATCH', body: values }); setEditingEvent(null); notify({ type: 'success', message: 'Appearance updated.' }); await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteEventRecord(event) { try { await api(`/appearances/${event.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Appearance deleted.' }); await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function saveTimeEntry(entry, values) { try { await api(`/time-entries/${entry.id}`, { method: 'PATCH', body: values }); setEditingTime(null); notify({ type: 'success', message: 'Time entry updated.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteTimeEntryRecord(entry) { try { await api(`/time-entries/${entry.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Time entry deleted.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }

  return (
    <div style={styles.matterGrid}>
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
              </div>
              <div style={styles.tabList}>
                {['Workspace', 'Assistant'].map(tab => (
                  <button key={tab} type="button" onClick={() => setDetailTab(tab)} style={{ ...styles.tabButton, ...(detailTab === tab ? styles.tabActive : {}) }}>{tab}</button>
                ))}
              </div>
              {detailTab === 'Assistant' ? (
                <AssistantSuggestions suggestions={suggestions} />
              ) : (
                <>
                  <form onSubmit={logTime} style={styles.formGrid}>
                    <Field label="Hours"><input type="number" min="0" step="0.1" style={styles.input} value={time.hours} onChange={e => setTime({ ...time, hours: Number(e.target.value) })} /></Field>
                    <Field label="Description"><input style={styles.input} value={time.description} onChange={e => setTime({ ...time, description: e.target.value })} /></Field>
                    <Field label="Rate"><input type="number" style={styles.input} value={time.rate} onChange={e => setTime({ ...time, rate: Number(e.target.value) })} /></Field>
                    <button style={styles.primaryButton}>Log time</button>
                  </form>
                  <Sub title="Time entries"><TimeEntryEditorList entries={detail.timeEntries || []} canManage={canManage} editingTime={editingTime} setEditingTime={setEditingTime} saveTimeEntry={saveTimeEntry} confirmDelete={entry => setConfirm({ title: 'Delete time entry?', message: 'Delete this time entry?', onConfirm: () => deleteTimeEntryRecord(entry) })} /></Sub>
                  <Sub title="Tasks"><TaskEditorList tasks={detail.tasks || []} canManage={canManage} editingTask={editingTask} setEditingTask={setEditingTask} saveTask={saveTask} confirmDelete={task => setConfirm({ title: 'Delete task?', message: 'Delete this task?', onConfirm: () => deleteTaskRecord(task) })} /></Sub>
                  <Sub title="Court appearances">{canManage && <form onSubmit={createEvent} style={{ ...styles.formGrid, marginBottom: 12 }}><Field label="Title"><input required style={styles.input} value={eventForm.title} onChange={e => setEventForm({ ...eventForm, title: e.target.value })} /></Field><Field label="Date"><input required type="date" style={styles.input} value={eventForm.date} onChange={e => setEventForm({ ...eventForm, date: e.target.value })} /></Field><Field label="Time"><input style={styles.input} value={eventForm.time} onChange={e => setEventForm({ ...eventForm, time: e.target.value })} /></Field><Field label="Type"><input style={styles.input} value={eventForm.type} onChange={e => setEventForm({ ...eventForm, type: e.target.value })} /></Field><Field label="Location"><input style={styles.input} value={eventForm.location} onChange={e => setEventForm({ ...eventForm, location: e.target.value })} /></Field><Field label="Meeting Link"><input type="url" placeholder="https://..." style={styles.input} value={eventForm.meetingLink} onChange={e => setEventForm({ ...eventForm, meetingLink: e.target.value })} /></Field><button style={styles.ghostButton}>Schedule event</button></form>}<AppearanceEditorList events={detail.appearances || []} canManage={canManage} editingEvent={editingEvent} setEditingEvent={setEditingEvent} saveEvent={saveEvent} confirmDelete={event => setConfirm({ title: 'Delete appearance?', message: 'Delete this court appearance?', onConfirm: () => deleteEventRecord(event) })} /></Sub>
                  <Sub title="Documents"><MatterDocuments matterId={detail.id} canManage={canManage} notify={notify} /></Sub>
                  <Sub title="Case notes"><form onSubmit={addNote} style={styles.noteForm}><input style={styles.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note" /><button style={styles.ghostButton}>Save note</button></form><Table columns={['Note', 'Author', 'Created']} rows={(detail.notes || []).map(n => [n.content, n.author || '-', n.createdAt ? new Date(n.createdAt).toLocaleString() : '-'])} empty="No notes yet." /></Sub>
                  <Sub title="Invoices"><Table columns={['Invoice', 'Amount', 'Status', 'PDF', 'Actions']} rows={(detail.invoices || []).map(i => [i.number || i.id, kes(i.amount), <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <a key={`${i.id}-pdf`} style={styles.link} href={`${API_BASE}/invoices/${i.id}/pdf?token=${encodeURIComponent(readSession()?.token || '')}`}>PDF</a>, canManage && i.status !== 'Paid' ? <ActionGroup key={`${i.id}-actions`} actions={[['Delete', () => setConfirm({ title: 'Delete invoice?', message: 'Delete this invoice?', onConfirm: () => deleteInvoiceRecord(i) })]]} /> : '-'])} empty="No invoices yet." /></Sub>
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

export function Tasks({ data, canManage, reload, notify }) {
  const [form, setForm] = useState({ matterId: '', title: '', dueDate: '' });
  const [editingTask, setEditingTask] = useState(null);
  const [confirm, setConfirm] = useState(null);
  async function submit(event) { event.preventDefault(); try { await api('/tasks', { method: 'POST', body: form }); setForm({ matterId: '', title: '', dueDate: '' }); notify({ type: 'success', message: 'Task created.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function toggle(task) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: { completed: !task.completed } }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function saveTask(task, values) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: values }); setEditingTask(null); notify({ type: 'success', message: 'Task updated.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteTaskRecord(task) { try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Task deleted.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <div style={styles.splitGrid}><Card title="New task" hint="Deadline control"><form onSubmit={submit} style={styles.formGrid}><Field label="Matter"><select required style={styles.input} value={form.matterId} onChange={e => setForm({ ...form, matterId: e.target.value })}><option value="">Select matter</option>{data.matters.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></Field><Field label="Task"><input required style={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field><Field label="Due"><input type="date" style={styles.input} value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></Field><button style={styles.primaryButton}>Create task</button></form></Card><Card title="Task board" hint={`${data.tasks.length} tasks`}><TaskEditorList tasks={data.tasks} canManage={canManage} editingTask={editingTask} setEditingTask={setEditingTask} saveTask={saveTask} toggle={toggle} confirmDelete={task => setConfirm({ title: 'Delete task?', message: 'Delete this task?', onConfirm: () => deleteTaskRecord(task) })} /></Card><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></div>;
}

export function Invoices({ invoices, isAdmin, canManage, reload, notify }) {
  const [confirm, setConfirm] = useState(null);
  async function setStatus(id, status) { try { await api(`/invoices/${id}/status`, { method: 'PATCH', body: { status } }); notify({ type: 'success', message: 'Invoice updated.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteInvoiceRecord(invoice) { try { await api(`/invoices/${invoice.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Invoice deleted.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <><Card title="Invoice register" hint="Receivables"><Table columns={['Invoice', 'Client', 'Matter', 'Amount', 'Status', 'PDF', 'Actions']} rows={invoices.map(i => [i.number || i.id, i.clientName || '-', i.matterTitle || '-', kes(i.amount), isAdmin ? <select key={i.id} style={styles.tableSelect} value={i.status} onChange={e => setStatus(i.id, e.target.value)}><option>Outstanding</option><option>Paid</option><option>Overdue</option></select> : <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <a key={`${i.id}-pdf`} style={styles.link} href={`${API_BASE}/invoices/${i.id}/pdf?token=${encodeURIComponent(readSession()?.token || '')}`}>Download</a>, canManage && i.status !== 'Paid' ? <ActionGroup key={`${i.id}-actions`} actions={[['Delete', () => setConfirm({ title: 'Delete invoice?', message: 'Delete this invoice?', onConfirm: () => deleteInvoiceRecord(i) })]]} /> : '-'])} empty="No invoices yet." /></Card><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></>;
}

export function FirmSettings({ settings, reload, notify }) {
  const [form, setForm] = useState({ ...defaultFirmSettings, ...settings });
  const [notices, setNotices] = useState([]);
  const [noticeForm, setNoticeForm] = useState({ title: '', content: '' });
  useEffect(() => setForm({ ...defaultFirmSettings, ...settings }), [settings]);
  useEffect(() => { loadNotices(); }, []);
  async function loadNotices() { try { setNotices(await api('/notices')); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  function setReminderSetting(key, value) {
    setForm(current => ({ ...current, reminderSettings: { ...(current.reminderSettings || {}), [key]: value } }));
  }
  async function chooseLogo(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setForm({ ...form, logo: await fileToDataUrl(file) });
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
    try {
      await api('/notices', { method: 'POST', body: noticeForm });
      setNoticeForm({ title: '', content: '' });
      notify({ type: 'success', message: 'Notice published.' });
      await loadNotices();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function deleteNotice(notice) {
    try {
      await api(`/notices/${notice.id}`, { method: 'DELETE' });
      notify({ type: 'success', message: 'Notice deleted.' });
      await loadNotices();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  const reminder = form.reminderSettings || {};
  return <div style={styles.pageStack}><Card title="Firm Settings" hint="Branding, invoice identity and client portal contact details"><form onSubmit={submit} style={styles.formGrid}><Field label="Firm Name"><input required style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="Website URL"><input type="url" style={styles.input} value={form.websiteURL || ''} onChange={e => setForm({ ...form, websiteURL: e.target.value })} /></Field><Field label="Primary Color"><input type="color" style={styles.colorInput} value={form.primaryColor || '#0F1B33'} onChange={e => setForm({ ...form, primaryColor: e.target.value })} /></Field><Field label="Accent Color"><input type="color" style={styles.colorInput} value={form.accentColor || '#D4A34A'} onChange={e => setForm({ ...form, accentColor: e.target.value })} /></Field><Field label="Email"><input style={styles.input} value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} /></Field><Field label="Phone"><input style={styles.input} value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field><Field label="Address"><input style={styles.input} value={form.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} /></Field><Field label="Logo"><input type="file" accept="image/*" style={styles.input} onChange={chooseLogo} /></Field><div className="lf-logo-preview" style={styles.logoPreview}>{form.logo ? <img src={form.logo} alt="Firm logo preview" /> : <span>LF</span>}<button type="button" style={styles.tinyButton} onClick={() => setForm({ ...form, logo: '' })}>Clear logo</button></div><button style={styles.primaryButton}>Save settings</button></form></Card><Card title="Client Reminder Automation" hint="Quiet reminders for court dates and invoice follow-ups. Templates use firm defaults and run silently in the background."><form onSubmit={submit} style={styles.formGrid}><Field label="Automatic Reminders"><select style={styles.input} value={reminder.remindersEnabled ? 'yes' : 'no'} onChange={e => setReminderSetting('remindersEnabled', e.target.value === 'yes')}><option value="yes">Enabled</option><option value="no">Disabled</option></select></Field><Field label="WhatsApp"><select style={styles.input} value={reminder.whatsappEnabled ? 'yes' : 'no'} onChange={e => setReminderSetting('whatsappEnabled', e.target.value === 'yes')}><option value="no">Off</option><option value="yes">On</option></select></Field><Field label="Email"><select style={styles.input} value={reminder.emailEnabled ? 'yes' : 'no'} onChange={e => setReminderSetting('emailEnabled', e.target.value === 'yes')}><option value="no">Off</option><option value="yes">On</option></select></Field>{reminder.whatsappEnabled && <><Field label="Twilio SID"><input style={styles.input} value={reminder.twilioSid || ''} onChange={e => setReminderSetting('twilioSid', e.target.value)} /></Field><Field label="Twilio Token"><input type="password" style={styles.input} value={reminder.twilioToken || ''} onChange={e => setReminderSetting('twilioToken', e.target.value)} /></Field><Field label="WhatsApp From"><input style={styles.input} value={reminder.twilioFromNumber || ''} onChange={e => setReminderSetting('twilioFromNumber', e.target.value)} placeholder="whatsapp:+14155238886" /></Field></>}{reminder.emailEnabled && <><Field label="SMTP Host"><input style={styles.input} value={reminder.smtpHost || ''} onChange={e => setReminderSetting('smtpHost', e.target.value)} /></Field><Field label="SMTP Port"><input style={styles.input} value={reminder.smtpPort || ''} onChange={e => setReminderSetting('smtpPort', e.target.value)} /></Field><Field label="SMTP User"><input style={styles.input} value={reminder.smtpUser || ''} onChange={e => setReminderSetting('smtpUser', e.target.value)} /></Field><Field label="SMTP Password"><input type="password" style={styles.input} value={reminder.smtpPass || ''} onChange={e => setReminderSetting('smtpPass', e.target.value)} /></Field></>}<div style={styles.formHelper}>When credentials are blank, LexFlow uses console stubs for testing. Real messages send automatically once provider credentials are saved.</div><button style={styles.primaryButton}>Save automation</button></form></Card><Card title="Client Portal Notices" hint="Publish updates that clients can read in their portal"><form onSubmit={createNotice} style={styles.formGrid}><Field label="Title"><input required style={styles.input} value={noticeForm.title} onChange={e => setNoticeForm({ ...noticeForm, title: e.target.value })} /></Field><Field label="Content"><input required style={styles.input} value={noticeForm.content} onChange={e => setNoticeForm({ ...noticeForm, content: e.target.value })} /></Field><button style={styles.primaryButton}>Publish notice</button></form><Table columns={['Title', 'Content', 'Created', 'Actions']} rows={notices.map(n => [n.title, n.content, n.createdAt ? new Date(n.createdAt).toLocaleString() : '-', <button key={n.id} type="button" style={styles.dangerTinyButton} onClick={() => deleteNotice(n)}>Delete</button>])} empty="No notices yet." /></Card></div>;
}
export function Users({ clients = [], notify }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ email: '', password: '', fullName: '', role: 'assistant', clientId: '' });
  useEffect(() => { load(); }, []);
  async function load() { try { setUsers(await api('/auth/users')); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function submit(event) { event.preventDefault(); try { await api('/auth/register', { method: 'POST', body: form }); setForm({ email: '', password: '', fullName: '', role: 'assistant', clientId: '' }); notify({ type: 'success', message: 'User created.' }); await load(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <div style={styles.splitGrid}><Card title="Create user" hint="Role-based access"><form onSubmit={submit} style={styles.formGrid}><Field label="Full name"><input required style={styles.input} value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} /></Field><Field label="Email"><input required style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field><Field label="Password"><input required type="password" style={styles.input} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field><Field label="Role"><select style={styles.input} value={form.role} onChange={e => setForm({ ...form, role: e.target.value, clientId: e.target.value === 'client' ? form.clientId : '' })}><option value="assistant">Assistant</option><option value="advocate">Advocate</option><option value="admin">Admin</option><option value="client">Client</option></select></Field>{form.role === 'client' && <><Field label="Linked Client"><select required style={styles.input} value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })}><option value="">Select client</option>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><div style={styles.formHelper}>Client users can view only the linked client's matters, documents, invoices, and messages. Share credentials manually after creating the account.</div></>}<button style={styles.primaryButton}>Create user</button></form></Card><Card title="Team" hint={`${users.length} users`}><Table columns={['Name', 'Email', 'Role', 'Client']} rows={users.map(u => [u.fullName, u.email, <Badge key={u.id} tone="blue">{u.role}</Badge>, u.clientId ? clients.find(c => c.id === u.clientId)?.name || u.clientId : '-'])} empty="No users found." /></Card></div>;
}

function TaskEditorList({ tasks, canManage, editingTask, setEditingTask, saveTask, toggle, confirmDelete }) {
  if (!tasks.length) return <Empty title="No tasks yet." text="Once records exist, they will appear here." />;
  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead><tr>{['Task', 'Assignee', 'Due', 'Status', 'Actions'].map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{tasks.map(task => {
          const editing = editingTask?.id === task.id;
          return (
            <tr key={task.id}>
              <td>{editing ? <input style={styles.input} value={editingTask.title || ''} onChange={e => setEditingTask({ ...editingTask, title: e.target.value })} /> : task.title}</td>
              <td>{editing ? <input style={styles.input} value={editingTask.assignee || ''} onChange={e => setEditingTask({ ...editingTask, assignee: e.target.value })} /> : task.assignee || '-'}</td>
              <td>{editing ? <input type="date" style={styles.input} value={editingTask.dueDate || ''} onChange={e => setEditingTask({ ...editingTask, dueDate: e.target.value })} /> : task.dueDate || '-'}</td>
              <td><Badge tone={task.completed ? 'green' : 'amber'}>{task.completed ? 'Done' : 'Open'}</Badge></td>
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
    <div style={styles.tableWrap}>
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

function TimeEntryEditorList({ entries, canManage, editingTime, setEditingTime, saveTimeEntry, confirmDelete }) {
  if (!entries.length) return <Empty title="No time entries." text="Logged time will appear here." />;
  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead><tr>{['Date', 'Description', 'Hours', 'Rate', 'Status', 'Actions'].map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{entries.map(entry => {
          const editing = editingTime?.id === entry.id;
          return (
            <tr key={entry.id}>
              <td>{editing ? <input type="date" style={styles.input} value={editingTime.date || ''} onChange={e => setEditingTime({ ...editingTime, date: e.target.value })} /> : entry.date || '-'}</td>
              <td>{editing ? <input style={styles.input} value={editingTime.description || ''} onChange={e => setEditingTime({ ...editingTime, description: e.target.value })} /> : entry.description || entry.activity || '-'}</td>
              <td>{editing ? <input type="number" step="0.1" style={styles.input} value={editingTime.hours || 0} onChange={e => setEditingTime({ ...editingTime, hours: Number(e.target.value) })} /> : Number(entry.hours || 0).toFixed(1)}</td>
              <td>{editing ? <input type="number" style={styles.input} value={editingTime.rate || 0} onChange={e => setEditingTime({ ...editingTime, rate: Number(e.target.value) })} /> : kes(entry.rate)}</td>
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

