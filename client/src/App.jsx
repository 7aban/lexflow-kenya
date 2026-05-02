import { useEffect, useMemo, useState } from 'react';

const API_BASE = '/api';
const AUTH_FAILURE_MESSAGE = 'Session expired. Please log in again.';

const theme = {
  navy900: '#081225',
  navy800: '#0F1B33',
  navy700: '#162744',
  navy600: '#1B3A5C',
  gold: '#D4A34A',
  goldDark: '#B98B35',
  ink: '#101827',
  muted: '#697386',
  line: '#E5E7EB',
  paper: '#FFFFFF',
  wash: '#F5F7FA',
  green: '#047857',
  greenBg: '#ECFDF5',
  red: '#B91C1C',
  redBg: '#FEF2F2',
  amber: '#B45309',
  amberBg: '#FFFBEB',
  blue: '#1D4ED8',
  blueBg: '#EFF6FF',
  shadow: '0 1px 3px rgba(0,0,0,0.08)',
  shadowLift: '0 14px 32px rgba(15,27,51,0.12)',
};

const initialData = { dashboard: {}, clients: [], matters: [], tasks: [], invoices: [] };
const nav = [
  ['Dashboard', 'DB'],
  ['Clients', 'CL'],
  ['Matters', 'MT'],
  ['Tasks', 'TK'],
  ['Invoices', 'IN'],
  ['Users', 'US'],
];
const legalResources = [
  ['Kenya Law', 'https://kenyalaw.org'],
  ['eKLR', 'https://www.eklr.go.ke'],
  ['Judiciary CTS', 'https://cts.judiciary.go.ke'],
  ['NCAJ', 'https://ncaj.go.ke'],
  ['eCitizen', 'https://www.ecitizen.go.ke'],
];

function readSession() {
  try {
    const session = JSON.parse(localStorage.getItem('lexflowSession') || 'null');
    if (session?.token) return session;
    const token = localStorage.getItem('lexflowToken') || localStorage.getItem('token');
    return token ? { token, user: null } : null;
  } catch {
    const token = localStorage.getItem('lexflowToken') || localStorage.getItem('token');
    return token ? { token, user: null } : null;
  }
}

function saveSession(session) {
  localStorage.setItem('lexflowSession', JSON.stringify(session));
  localStorage.setItem('lexflowToken', session.token);
  localStorage.setItem('token', session.token);
}

function clearSession() {
  localStorage.removeItem('lexflowSession');
  localStorage.removeItem('lexflowToken');
  localStorage.removeItem('token');
}

function emitAuthFailure() {
  window.dispatchEvent(new CustomEvent('lexflow:auth-failure', {
    detail: { message: AUTH_FAILURE_MESSAGE },
  }));
}

class AuthExpiredError extends Error {
  constructor() {
    super(AUTH_FAILURE_MESSAGE);
    this.name = 'AuthExpiredError';
    this.isAuthExpired = true;
  }
}

async function api(path, options = {}) {
  const session = readSession();
  const headers = { ...(options.headers || {}) };
  const isFormData = options.body instanceof FormData;
  if (!isFormData) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: options.body && !isFormData ? JSON.stringify(options.body) : options.body,
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json().catch(() => ({})) : await response.text();
  if (response.status === 401) {
    clearSession();
    emitAuthFailure();
    throw new AuthExpiredError();
  }
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Unable to read file'));
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const [session, setSession] = useState(readSession);
  const [user, setUser] = useState(session?.user || null);
  const [view, setView] = useState('Dashboard');
  const [search, setSearch] = useState('');
  const [quickLinksOpen, setQuickLinksOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [data, setData] = useState(initialData);

  const authenticated = Boolean(session?.token);
  const isAdmin = user?.role === 'admin';
  const canManage = ['admin', 'advocate'].includes(user?.role);

  useEffect(() => {
    function handleAuthFailure(event) {
      clearSession();
      setSession(null);
      setUser(null);
      setData(initialData);
      setLoading(false);
      setToast({
        type: 'warning',
        message: event.detail?.message || AUTH_FAILURE_MESSAGE,
      });
    }

    window.addEventListener('lexflow:auth-failure', handleAuthFailure);
    window.addEventListener('lexflow:unauthorized', handleAuthFailure);
    return () => {
      window.removeEventListener('lexflow:auth-failure', handleAuthFailure);
      window.removeEventListener('lexflow:unauthorized', handleAuthFailure);
    };
  }, []);

  useEffect(() => {
    if (authenticated) refresh();
  }, [authenticated]);

  async function refresh() {
    setLoading(true);
    try {
      const [currentUser, dashboard, clients, matters, tasks, invoices] = await Promise.all([
        api('/auth/me'),
        api('/dashboard'),
        api('/clients'),
        api('/matters'),
        api('/tasks'),
        api('/invoices'),
      ]);
      setUser(currentUser);
      setData({ dashboard, clients, matters, tasks, invoices });
    } catch (err) {
      if (err?.isAuthExpired) return;
      setToast({ type: 'danger', message: err.message });
    } finally {
      setLoading(false);
    }
  }

  function login(sessionData) {
    saveSession(sessionData);
    setSession(sessionData);
    setUser(sessionData.user || null);
    setToast({ type: 'success', message: 'Welcome back. Your workspace is ready.' });
  }

  function logout() {
    clearSession();
    setSession(null);
    setUser(null);
    setData(initialData);
  }

  if (!authenticated) {
    return (
      <>
        <LoginPage onLogin={login} />
        <Toast toast={toast} onClose={() => setToast(null)} />
      </>
    );
  }

  const visibleNav = nav.filter(([label]) => label !== 'Users' || isAdmin);
  const subtitles = {
    Dashboard: 'Command center for active work, hearings, billing and firm movement.',
    Clients: 'A polished directory for intake, contacts and relationship context.',
    Matters: 'Matter pipeline, billing, documents, notes and invoice actions.',
    Tasks: 'Daily execution board for deadlines and delegated legal work.',
    Invoices: 'Receivables, invoice status and PDF export for client billing.',
    Users: 'Role-based access for advocates, assistants and administrators.',
  };

  return (
    <div className="lf-app-shell" style={styles.shell}>
      <StyleTag />
      <aside style={styles.sidebar}>
        <div style={styles.brandPanel}>
          <div style={styles.logo}>LF</div>
          <div>
            <div style={styles.brand}>LexFlow</div>
            <div style={styles.brandSub}>Kenya practice suite</div>
          </div>
        </div>

        <div style={styles.sideSectionLabel}>Workspace</div>
        <nav style={styles.navList}>
          {visibleNav.map(([label, number]) => (
            <button key={label} type="button" className="lf-nav" onClick={() => setView(label)} style={{ ...styles.navItem, ...(view === label ? styles.navActive : {}) }}>
              <span style={styles.navNumber}>{number}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div style={styles.quickLinksPanel}>
          <button type="button" className="lf-quick-toggle" onClick={() => setQuickLinksOpen(open => !open)} style={styles.quickLinksHeader} aria-expanded={quickLinksOpen}>
            <span>Legal Resources</span>
            <span style={styles.quickLinksChevron}>{quickLinksOpen ? 'v' : '>'}</span>
          </button>
          {quickLinksOpen && (
            <div style={styles.quickLinksList}>
              {legalResources.map(([name, href]) => (
                <a key={name} className="lf-resource-link" style={styles.quickLink} href={href} target="_blank" rel="noopener noreferrer">
                  <span style={styles.quickLinkIcon}>EX</span>
                  <span>{name}</span>
                </a>
              ))}
            </div>
          )}
        </div>

        <div style={styles.timerCard}>
          <div style={styles.timerTop}><span style={styles.liveDot} /> Timekeeper</div>
          <strong>00:00</strong>
          <span>Ready to log billable time</span>
        </div>

        <div style={styles.userCard}>
          <div style={styles.avatar}>{(user?.fullName || user?.name || 'U').slice(0, 1).toUpperCase()}</div>
          <div style={{ minWidth: 0 }}>
            <div style={styles.userName}>{user?.fullName || user?.name || 'Signed in'}</div>
            <div style={styles.userRole}>{user?.role || 'user'}</div>
          </div>
          <button type="button" onClick={logout} style={styles.logout}>Exit</button>
        </div>
      </aside>

      <main style={styles.main}>
        <header style={styles.topbar}>
          <div>
            <div style={styles.eyebrow}>LexFlow Kenya</div>
            <h1 style={styles.title}>{view}</h1>
            <p style={styles.subtitle}>{subtitles[view]}</p>
          </div>
          <div style={styles.topActions}>
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search workspace" style={styles.search} />
            <button type="button" onClick={refresh} disabled={loading} style={styles.ghostButton}>{loading ? 'Refreshing...' : 'Refresh'}</button>
          </div>
        </header>

        {loading && <Skeleton />}
        {!loading && view === 'Dashboard' && <Dashboard data={data} />}
        {!loading && view === 'Clients' && <Clients clients={data.clients} canManage={canManage} reload={refresh} notify={setToast} />}
        {!loading && view === 'Matters' && <Matters data={data} canManage={canManage} reload={refresh} notify={setToast} />}
        {!loading && view === 'Tasks' && <Tasks data={data} canManage={canManage} reload={refresh} notify={setToast} />}
        {!loading && view === 'Invoices' && <Invoices invoices={data.invoices} isAdmin={isAdmin} canManage={canManage} reload={refresh} notify={setToast} />}
        {!loading && view === 'Users' && isAdmin && <Users notify={setToast} />}
      </main>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('admin@lexflow.co.ke');
  const [password, setPassword] = useState('admin123');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Login failed');
      onLogin(body);
    } catch (err) {
      setError(err.message || 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.loginShell}>
      <StyleTag />
      <div style={styles.loginEditorial}>
        <div style={styles.loginBadge}>Kenyan law practice OS</div>
        <h1>Move matters from intake to invoice with calm control.</h1>
        <p>LexFlow brings clients, matters, deadlines, billing and documents into one focused workspace for modern chambers.</p>
        <div style={styles.loginMetricRow}>
          <div><strong>LSK</strong><span>ready reports</span></div>
          <div><strong>16%</strong><span>VAT invoices</span></div>
          <div><strong>JWT</strong><span>secure access</span></div>
        </div>
      </div>
      <form onSubmit={submit} style={styles.loginCard}>
        <div style={styles.loginLogo}>LF</div>
        <h2>Welcome back</h2>
        <p>Sign in to your LexFlow workspace.</p>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Email"><input style={styles.input} value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" /></Field>
        <Field label="Password"><input style={styles.input} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></Field>
        <button disabled={busy} style={{ ...styles.primaryButton, width: '100%', marginTop: 16 }}>{busy ? 'Signing in...' : 'Sign in securely'}</button>
        <div style={styles.loginHint}>admin@lexflow.co.ke / admin123</div>
      </form>
    </div>
  );
}

function Dashboard({ data }) {
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

function Clients({ clients, canManage, reload, notify }) {
  const [form, setForm] = useState({ name: '', type: 'Individual', contact: '', email: '', phone: '' });
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  async function submit(event) {
    event.preventDefault();
    try {
      if (editing) await api(`/clients/${editing.id}`, { method: 'PATCH', body: form });
      else await api('/clients', { method: 'POST', body: form });
      setForm({ name: '', type: 'Individual', contact: '', email: '', phone: '' });
      setEditing(null);
      notify({ type: 'success', message: editing ? 'Client updated.' : 'Client created.' });
      await reload();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  function startEdit(client) {
    setEditing(client);
    setForm({ name: client.name || '', type: client.type || 'Individual', contact: client.contact || '', email: client.email || '', phone: client.phone || '' });
  }
  async function deleteClient(client) {
    try {
      await api(`/clients/${client.id}`, { method: 'DELETE' });
      notify({ type: 'success', message: 'Client deleted.' });
      await reload();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  return <div style={styles.splitGrid}><Card title={editing ? 'Edit client' : 'New client'} hint={editing ? 'Save client changes' : 'Intake record'}><form onSubmit={submit} style={styles.formGrid}><Field label="Name"><input required style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="Type"><select style={styles.input} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}><option>Individual</option><option>Company</option></select></Field><Field label="Contact"><input style={styles.input} value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} /></Field><Field label="Email"><input style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field><Field label="Phone"><input style={styles.input} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field><button style={styles.primaryButton}>{editing ? 'Save changes' : 'Create client'}</button>{editing && <button type="button" style={styles.ghostButton} onClick={() => { setEditing(null); setForm({ name: '', type: 'Individual', contact: '', email: '', phone: '' }); }}>Cancel</button>}</form></Card><Card title="Client directory" hint={`${clients.length} records`}><Table columns={['Name', 'Type', 'Email', 'Phone', 'Status', 'Actions']} rows={clients.map(c => [c.name, c.type, c.email || '-', c.phone || '-', <Badge key={c.id} tone="green">{c.status || 'Active'}</Badge>, canManage ? <ActionGroup key={`${c.id}-actions`} actions={[['Edit', () => startEdit(c)], ['Delete', () => setConfirm({ title: 'Delete client?', message: 'Are you sure you want to delete this client? This will also remove all related matters.', onConfirm: () => deleteClient(c) })]]} /> : '-'])} empty="No clients yet." /></Card><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></div>;
}

function Matters({ data, canManage, reload, notify }) {
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [detailTab, setDetailTab] = useState('Workspace');
  const [editingMatter, setEditingMatter] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null);
  const [editingTime, setEditingTime] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [loading, setLoading] = useState(false);
  const emptyMatterForm = { clientId: '', title: '', practiceArea: '', stage: 'Intake', assignedTo: '', paralegal: '', description: '', court: '', judge: '', caseNo: '', opposingCounsel: '', priority: 'Medium', solDate: '', billingType: 'hourly', billingRate: 15000, fixedFee: 0, retainerBalance: 0 };
  const [form, setForm] = useState(emptyMatterForm);
  const [time, setTime] = useState({ hours: 1, description: '', rate: 15000 });
  const emptyEventForm = { title: '', date: '', time: '9:00 AM', type: 'Hearing', location: '', meetingLink: '', attorney: '', prepNote: '' };
  const [eventForm, setEventForm] = useState(emptyEventForm);
  const [note, setNote] = useState('');
  const selected = data.matters.find(m => m.id === selectedId) || data.matters[0];

  useEffect(() => { if (selected?.id) { setSelectedId(selected.id); loadDetail(selected.id); } else { setDetail(null); setSuggestions([]); } }, [selected?.id]);

  async function loadDetail(id) {
    setLoading(true);
    try {
      const [matter, smartTips] = await Promise.all([
        api(`/matters/${id}`),
        api(`/matters/${id}/suggestions`),
      ]);
      setDetail(matter);
      setSuggestions(Array.isArray(smartTips) ? smartTips : []);
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
          <button key={m.id} onClick={() => setSelectedId(m.id)} style={{ ...styles.matterButton, ...(selected?.id === m.id ? styles.matterActive : {}) }}>
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
              <Field label="Description"><input style={styles.input} value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} /></Field>
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
                  <Sub title="Documents"><input style={styles.file} type="file" accept=".pdf,.doc,.docx" onChange={uploadDoc} /><Table columns={['Name', 'Type', 'Size', 'Download', 'Actions']} rows={(detail.documents || []).map(d => [d.name, d.type, d.size, <a key={d.id} style={styles.link} href={`${API_BASE}/documents/${d.id}/download?token=${encodeURIComponent(readSession()?.token || '')}`}>Download</a>, canManage ? <ActionGroup key={`${d.id}-actions`} actions={[['Delete', () => setConfirm({ title: 'Delete document?', message: 'Delete this document?', onConfirm: () => deleteDocumentRecord(d) })]]} /> : '-'])} empty="No documents uploaded." /></Sub>
                  <Sub title="Case notes"><form onSubmit={addNote} style={styles.noteForm}><input style={styles.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note" /><button style={styles.ghostButton}>Save note</button></form><Table columns={['Note', 'Author', 'Created']} rows={(detail.notes || []).map(n => [n.content, n.author || '-', n.createdAt ? new Date(n.createdAt).toLocaleString() : '-'])} empty="No notes yet." /></Sub>
                  <Sub title="Invoices"><Table columns={['Invoice', 'Amount', 'Status', 'PDF', 'Actions']} rows={(detail.invoices || []).map(i => [i.number || i.id, kes(i.amount), <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <a key={`${i.id}-pdf`} style={styles.link} href={`${API_BASE}/invoices/${i.id}/pdf?token=${encodeURIComponent(readSession()?.token || '')}`}>PDF</a>, canManage && i.status !== 'Paid' ? <ActionGroup key={`${i.id}-actions`} actions={[['Delete', () => setConfirm({ title: 'Delete invoice?', message: 'Delete this invoice?', onConfirm: () => deleteInvoiceRecord(i) })]]} /> : '-'])} empty="No invoices yet." /></Sub>
                </>
              )}
            </div>
          )}
          {!loading && !detail && <Empty title="Select a matter" text="Matter detail will appear here." />}
        </Card>
      </div>
      <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function Tasks({ data, canManage, reload, notify }) {
  const [form, setForm] = useState({ matterId: '', title: '', dueDate: '' });
  const [editingTask, setEditingTask] = useState(null);
  const [confirm, setConfirm] = useState(null);
  async function submit(event) { event.preventDefault(); try { await api('/tasks', { method: 'POST', body: form }); setForm({ matterId: '', title: '', dueDate: '' }); notify({ type: 'success', message: 'Task created.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function toggle(task) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: { completed: !task.completed } }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function saveTask(task, values) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: values }); setEditingTask(null); notify({ type: 'success', message: 'Task updated.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteTaskRecord(task) { try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Task deleted.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <div style={styles.splitGrid}><Card title="New task" hint="Deadline control"><form onSubmit={submit} style={styles.formGrid}><Field label="Matter"><select required style={styles.input} value={form.matterId} onChange={e => setForm({ ...form, matterId: e.target.value })}><option value="">Select matter</option>{data.matters.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></Field><Field label="Task"><input required style={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field><Field label="Due"><input type="date" style={styles.input} value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></Field><button style={styles.primaryButton}>Create task</button></form></Card><Card title="Task board" hint={`${data.tasks.length} tasks`}><TaskEditorList tasks={data.tasks} canManage={canManage} editingTask={editingTask} setEditingTask={setEditingTask} saveTask={saveTask} toggle={toggle} confirmDelete={task => setConfirm({ title: 'Delete task?', message: 'Delete this task?', onConfirm: () => deleteTaskRecord(task) })} /></Card><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></div>;
}

function Invoices({ invoices, isAdmin, canManage, reload, notify }) {
  const [confirm, setConfirm] = useState(null);
  async function setStatus(id, status) { try { await api(`/invoices/${id}/status`, { method: 'PATCH', body: { status } }); notify({ type: 'success', message: 'Invoice updated.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteInvoiceRecord(invoice) { try { await api(`/invoices/${invoice.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Invoice deleted.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <><Card title="Invoice register" hint="Receivables"><Table columns={['Invoice', 'Client', 'Matter', 'Amount', 'Status', 'PDF', 'Actions']} rows={invoices.map(i => [i.number || i.id, i.clientName || '-', i.matterTitle || '-', kes(i.amount), isAdmin ? <select key={i.id} style={styles.tableSelect} value={i.status} onChange={e => setStatus(i.id, e.target.value)}><option>Outstanding</option><option>Paid</option><option>Overdue</option></select> : <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <a key={`${i.id}-pdf`} style={styles.link} href={`${API_BASE}/invoices/${i.id}/pdf?token=${encodeURIComponent(readSession()?.token || '')}`}>Download</a>, canManage && i.status !== 'Paid' ? <ActionGroup key={`${i.id}-actions`} actions={[['Delete', () => setConfirm({ title: 'Delete invoice?', message: 'Delete this invoice?', onConfirm: () => deleteInvoiceRecord(i) })]]} /> : '-'])} empty="No invoices yet." /></Card><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></>;
}

function Users({ notify }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ email: '', password: '', fullName: '', role: 'assistant' });
  useEffect(() => { load(); }, []);
  async function load() { try { setUsers(await api('/auth/users')); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function submit(event) { event.preventDefault(); try { await api('/auth/register', { method: 'POST', body: form }); setForm({ email: '', password: '', fullName: '', role: 'assistant' }); notify({ type: 'success', message: 'User created.' }); await load(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <div style={styles.splitGrid}><Card title="Create user" hint="Role-based access"><form onSubmit={submit} style={styles.formGrid}><Field label="Full name"><input required style={styles.input} value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} /></Field><Field label="Email"><input required style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field><Field label="Password"><input required type="password" style={styles.input} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field><Field label="Role"><select style={styles.input} value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}><option value="assistant">Assistant</option><option value="advocate">Advocate</option><option value="admin">Admin</option></select></Field><button style={styles.primaryButton}>Create user</button></form></Card><Card title="Team" hint={`${users.length} users`}><Table columns={['Name', 'Email', 'Role']} rows={users.map(u => [u.fullName, u.email, <Badge key={u.id} tone="blue">{u.role}</Badge>])} empty="No users found." /></Card></div>;
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

function MeetingLink({ event, dashboard = false }) {
  const href = (event?.meetingLink || '').trim();
  if (!href) return <span style={styles.mutedText}>-</span>;
  const urgent = dashboard ? isTodayOrTomorrow(event.date) : isToday(event.date);
  if (urgent) {
    return <a style={styles.joinButton} href={href} target="_blank" rel="noopener noreferrer">{dashboard ? 'Join' : 'Join Court'}</a>;
  }
  return <a style={styles.meetingLink} href={href} target="_blank" rel="noopener noreferrer"><span style={styles.videoBadge}>VC</span> Meeting Link</a>;
}

function ActionGroup({ actions }) {
  return <div style={styles.actionGroup}>{actions.map(([label, onClick]) => <button key={label} type="button" onClick={onClick} style={label === 'Delete' ? styles.dangerTinyButton : styles.tinyButton}>{label}</button>)}</div>;
}

function ConfirmModal({ confirm, onClose }) {
  useEffect(() => {
    if (!confirm) return undefined;
    function onKey(event) { if (event.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm, onClose]);
  if (!confirm) return null;
  async function proceed() {
    await confirm.onConfirm();
    onClose();
  }
  return (
    <div style={styles.modalBackdrop} role="dialog" aria-modal="true">
      <div style={styles.modalCard}>
        <div style={styles.modalHead}>
          <h2>{confirm.title || 'Confirm action'}</h2>
          <button type="button" aria-label="Close" onClick={onClose} style={styles.toastClose}>x</button>
        </div>
        <p>{confirm.message}</p>
        <div style={styles.modalActions}>
          <button type="button" style={styles.ghostButton} onClick={onClose}>Cancel</button>
          <button type="button" style={styles.dangerButton} onClick={proceed}>Confirm</button>
        </div>
      </div>
    </div>
  );
}

function Card({ title, hint, action, children }) { return <section style={styles.card}><div style={styles.cardHead}><div><h2>{title}</h2>{hint && <p>{hint}</p>}</div>{action}</div>{children}</section>; }
function Sub({ title, children }) { return <div style={styles.sub}><h3>{title}</h3>{children}</div>; }
function Field({ label, children }) { return <label style={styles.field}><span>{label}</span>{children}</label>; }
function Stat({ label, value, tone }) { const colors = { navy: theme.navy600, gold: theme.gold, green: theme.green, red: theme.red }; const color = colors[tone] || theme.navy600; return <div style={{ ...styles.stat, borderLeftColor: color }}><i style={{ background: `${color}16`, color }}>{label.slice(0, 2).toUpperCase()}</i><span>{label}</span><strong>{value}</strong></div>; }
function Badge({ tone = 'blue', children }) { const map = { green: [theme.greenBg, theme.green], amber: [theme.amberBg, theme.amber], red: [theme.redBg, theme.red], blue: [theme.blueBg, theme.blue] }; const [bg, color] = map[tone] || map.blue; return <span style={{ ...styles.badge, background: bg, color }}>{children}</span>; }
function Alert({ tone, children }) { return <div style={{ ...styles.alert, ...(tone === 'danger' ? styles.alertDanger : {}) }}>{children}</div>; }
function Toast({ toast, onClose }) { if (!toast) return null; const tone = toast.type === 'danger' ? 'red' : toast.type === 'success' ? 'green' : toast.type === 'warning' ? 'amber' : 'blue'; const map = { green: [theme.greenBg, theme.green, '#A7F3D0'], red: [theme.redBg, theme.red, '#FECACA'], amber: [theme.amberBg, theme.amber, '#FDE68A'], blue: [theme.blueBg, theme.blue, '#BFDBFE'] }; const [bg, color, borderColor] = map[tone]; return <div style={{ ...styles.toast, background: bg, color, borderColor }} role="status" aria-live="polite"><strong>{toast.message}</strong><button type="button" aria-label="Dismiss notification" onClick={onClose} style={styles.toastClose}>x</button></div>; }
function Empty({ title, text }) { return <div style={styles.empty}><div style={styles.emptyIcon}>LF</div><strong>{title}</strong><span>{text}</span></div>; }
function Skeleton({ rows = 4 }) { return <div style={styles.skeletonGrid}>{Array.from({ length: rows }).map((_, index) => <div key={index} style={styles.skeleton}><span style={styles.skeletonLineLarge} /><span style={styles.skeletonLine} /><span style={styles.skeletonLineShort} /></div>)}</div>; }
function Table({ columns, rows, empty }) { if (!rows.length) return <Empty title={empty} text="Once records exist, they will appear here." />; return <div style={styles.tableWrap}><table style={styles.table}><thead><tr>{columns.map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>; }
function statusTone(status) { return status === 'Paid' ? 'green' : status === 'Overdue' ? 'red' : 'amber'; }
function kes(value) { return `KSh ${Number(value || 0).toLocaleString('en-KE')}`; }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function isToday(date) { return Boolean(date) && date === todayIso(); }
function isTodayOrTomorrow(date) {
  if (!date) return false;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return date === todayIso() || date === tomorrow;
}

function StyleTag() { return <style>{`
  * { box-sizing: border-box; }
  body { margin: 0; background: #F5F7FA; font: 400 13px/1.45 Segoe UI, Roboto, -apple-system, BlinkMacSystemFont, sans-serif; color: #101827; }
  button, input, select { font: inherit; }
  button { transition: background .16s ease, border-color .16s ease, color .16s ease, box-shadow .16s ease, transform .16s ease; }
  button:not(:disabled):hover { transform: translateY(-1px); }
  button:disabled { opacity: .5; cursor: not-allowed !important; transform: none !important; }
  input:focus, select:focus { outline: 2px solid rgba(212,163,74,.25); border-color: #D4A34A !important; }
  section:hover { box-shadow: 0 8px 22px rgba(15,27,51,.08); }
  .lf-nav:hover { background: rgba(255,255,255,.08) !important; color: #fff !important; }
  .lf-resource-link:hover, .lf-quick-toggle:hover { background: rgba(255,255,255,.08) !important; color: #fff !important; }
  @media (max-width: 980px) {
    #root .lf-app-shell { grid-template-columns: 1fr; }
    #root aside { position: static; min-height: auto; }
    #root main { padding: 16px; }
    #root header { align-items: stretch; flex-direction: column; }
    #root header input { width: 100% !important; }
  }
  @keyframes lfPulse { 0% { opacity: .55; } 50% { opacity: 1; } 100% { opacity: .55; } }
  @keyframes lfSlideIn { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }
  table th { text-align: left; padding: 9px 12px; background: #F3F4F6; color: #6B7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0; font-weight: 700; }
  table td { padding: 10px 12px; border-top: 1px solid #E5E7EB; vertical-align: middle; }
  table tr:nth-child(even) td { background: #FAFAFB; }
  table tbody tr:hover td { background: #F8FAFC; }
  label > span { color: #6B7280; font-size: 11px; font-weight: 700; text-transform: uppercase; }
  section h2 { margin: 0; font-size: 14px; font-weight: 700; color: #101827; }
  section h3 { margin: 0 0 12px; font-size: 13px; font-weight: 700; color: #101827; }
  section p { margin: 4px 0 0; color: #697386; font-size: 12px; }
`}</style>; }

const styles = {
  shell: { minHeight: '100vh', display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', background: '#F5F7FA', color: theme.ink, fontFamily: 'Segoe UI, Roboto, -apple-system, BlinkMacSystemFont, sans-serif', fontSize: 13 },
  sidebar: { position: 'sticky', top: 0, minHeight: '100vh', background: theme.navy800, color: '#fff', padding: 16, display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '1px 0 0 rgba(255,255,255,.05)' },
  brandPanel: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 8px 14px', borderBottom: '1px solid rgba(255,255,255,.10)' },
  logo: { width: 36, height: 36, borderRadius: 8, display: 'grid', placeItems: 'center', background: theme.gold, color: '#fff', fontWeight: 900, fontSize: 13, boxShadow: '0 8px 18px rgba(212,163,74,.20)' },
  brand: { fontSize: 16, fontWeight: 700, letterSpacing: 0 }, brandSub: { fontSize: 11, color: '#9CA8BA', marginTop: 2 }, sideSectionLabel: { color: '#7F8CA3', fontSize: 11, fontWeight: 700, letterSpacing: 0, textTransform: 'uppercase', padding: '0 8px' },
  navList: { display: 'grid', gap: 4 }, navItem: { border: 0, borderLeft: '3px solid transparent', background: 'transparent', color: '#C9D3E2', borderRadius: 6, padding: '9px 10px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontWeight: 600, textAlign: 'left' }, navActive: { background: 'rgba(255,255,255,.10)', color: '#fff', borderLeftColor: theme.gold }, navNumber: { width: 24, height: 24, borderRadius: 6, background: 'rgba(255,255,255,.08)', display: 'grid', placeItems: 'center', fontSize: 10, color: theme.gold, fontWeight: 800 },
  quickLinksPanel: { display: 'grid', gap: 7, paddingTop: 2 }, quickLinksHeader: { border: 0, background: 'transparent', color: '#7F8CA3', borderRadius: 6, padding: '5px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', fontSize: 10, fontWeight: 800, letterSpacing: .8, textTransform: 'uppercase' }, quickLinksChevron: { color: theme.gold, fontSize: 11, fontWeight: 900 }, quickLinksList: { display: 'grid', gap: 3 }, quickLink: { borderLeft: '3px solid transparent', color: '#C9D3E2', borderRadius: 6, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 9, fontWeight: 600, textDecoration: 'none', transition: 'background .16s ease, color .16s ease' }, quickLinkIcon: { width: 24, height: 24, borderRadius: 6, background: 'rgba(255,255,255,.08)', display: 'grid', placeItems: 'center', fontSize: 9, color: theme.gold, fontWeight: 900 },
  timerCard: { marginTop: 'auto', padding: 12, borderRadius: 8, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.10)', display: 'grid', gap: 4 }, timerTop: { color: '#DDE5F1', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }, liveDot: { width: 8, height: 8, borderRadius: 999, background: '#22C55E', boxShadow: '0 0 0 4px rgba(34,197,94,.13)' },
  userCard: { display: 'grid', gridTemplateColumns: '34px 1fr auto', gap: 8, alignItems: 'center', paddingTop: 12, borderTop: '1px solid rgba(255,255,255,.10)' }, avatar: { width: 34, height: 34, borderRadius: 8, background: '#243653', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 12 }, userName: { fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }, userRole: { color: '#AAB4C3', fontSize: 11, textTransform: 'capitalize' }, logout: { border: '1px solid rgba(255,255,255,.18)', color: '#fff', background: 'transparent', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', fontSize: 12 },
  main: { padding: 24, minWidth: 0 }, topbar: { display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', marginBottom: 20 }, eyebrow: { color: theme.goldDark, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0 }, title: { margin: '2px 0 0', fontSize: 20, fontWeight: 700, lineHeight: 1.2 }, subtitle: { margin: '5px 0 0', color: theme.muted, maxWidth: 680 }, topActions: { display: 'flex', gap: 8, alignItems: 'center' }, search: { width: 260, border: `1px solid ${theme.line}`, borderRadius: 6, padding: '7px 11px', background: '#fff', fontSize: 13 },
  pageStack: { display: 'grid', gap: 16 }, heroCard: { borderRadius: 10, background: `linear-gradient(135deg, ${theme.navy800}, #1B3A5C)`, color: '#fff', padding: 24, display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'end', boxShadow: theme.shadow }, heroKicker: { color: theme.gold, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }, heroFigure: { fontSize: 24, fontWeight: 700, color: theme.gold },
  warningPanel: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10, border: '1px solid #FDE68A', background: theme.amberBg, color: theme.amber, boxShadow: theme.shadow }, warningIcon: { width: 28, height: 28, borderRadius: 999, display: 'grid', placeItems: 'center', background: '#FDE68A', fontWeight: 900 }, 
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }, stat: { position: 'relative', overflow: 'hidden', background: '#fff', border: `1px solid ${theme.line}`, borderLeft: '4px solid', borderRadius: 10, padding: 16, boxShadow: theme.shadow, display: 'grid', gap: 6 }, 
  splitGrid: { display: 'grid', gridTemplateColumns: 'minmax(260px,.72fr) minmax(0,1.28fr)', gap: 16 }, dashboardGrid: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16 }, matterGrid: { display: 'grid', gridTemplateColumns: '300px minmax(0,1fr)', gap: 16 },
  card: { background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: '18px 20px', boxShadow: theme.shadow, minWidth: 0, transition: 'box-shadow .16s ease, transform .16s ease' }, cardHead: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 14 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 12, alignItems: 'end' }, field: { display: 'grid', gap: 5 }, input: { width: '100%', border: `1px solid ${theme.line}`, borderRadius: 6, padding: '7px 11px', background: '#fff', fontSize: 13 }, primaryButton: { border: 0, borderRadius: 6, padding: '7px 16px', background: theme.navy600, color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13 }, goldButton: { border: 0, borderRadius: 6, padding: '7px 16px', background: theme.gold, color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13 }, dangerButton: { border: 0, borderRadius: 6, padding: '7px 16px', background: theme.red, color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13 }, ghostButton: { border: `1px solid ${theme.line}`, borderRadius: 6, padding: '7px 16px', background: '#fff', color: theme.navy600, fontWeight: 700, cursor: 'pointer', fontSize: 13 }, actionGroup: { display: 'flex', flexWrap: 'wrap', gap: 6 }, tinyButton: { border: `1px solid ${theme.line}`, borderRadius: 6, padding: '4px 10px', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: theme.navy600 }, dangerTinyButton: { border: '1px solid #FECACA', borderRadius: 6, padding: '4px 10px', background: theme.redBg, cursor: 'pointer', fontSize: 12, fontWeight: 700, color: theme.red },
  tableWrap: { overflowX: 'auto', border: `1px solid ${theme.line}`, borderRadius: 8 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 620 }, badge: { display: 'inline-flex', padding: '4px 8px', borderRadius: 999, fontWeight: 700, fontSize: 12 }, link: { color: theme.navy600, fontWeight: 700, textDecoration: 'none' }, meetingLink: { color: theme.navy600, fontWeight: 700, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }, videoBadge: { width: 22, height: 22, borderRadius: 6, display: 'inline-grid', placeItems: 'center', background: theme.blueBg, color: theme.blue, fontSize: 10, fontWeight: 900 }, joinButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, padding: '5px 10px', background: theme.green, color: '#fff', fontWeight: 800, fontSize: 12, textDecoration: 'none', whiteSpace: 'nowrap', boxShadow: '0 6px 14px rgba(4,120,87,.18)' }, mutedText: { color: theme.muted }, tableSelect: { border: `1px solid ${theme.line}`, borderRadius: 6, padding: '5px 8px', fontSize: 12 },
  pipelineRow: { display: 'grid', gridTemplateColumns: '116px 1fr 30px', gap: 10, alignItems: 'center', marginBottom: 10 }, pipelineTrack: { height: 8, background: '#EEF2F7', borderRadius: 999, overflow: 'hidden' }, pipelineFill: { height: '100%', background: theme.gold, borderRadius: 999 },
  matterButton: { width: '100%', display: 'grid', gap: 4, textAlign: 'left', border: 0, borderLeft: '3px solid transparent', borderBottom: `1px solid ${theme.line}`, background: '#fff', padding: '12px 10px', cursor: 'pointer', borderRadius: 6 }, matterActive: { background: '#F8FAFC', borderLeftColor: theme.gold }, detailStack: { display: 'grid', gap: 16 }, chips: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, color: theme.muted }, tabList: { display: 'flex', gap: 4, borderBottom: `1px solid ${theme.line}` }, tabButton: { border: 0, borderBottom: '2px solid transparent', background: 'transparent', color: theme.muted, padding: '8px 12px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }, tabActive: { color: theme.navy600, borderBottomColor: theme.gold }, assistantPanel: { display: 'grid', gap: 12 }, assistantIntro: { display: 'grid', gap: 4, padding: 14, borderRadius: 10, background: '#F8FAFC', border: `1px solid ${theme.line}`, color: theme.muted }, suggestionList: { display: 'grid', gap: 10 }, suggestionItem: { display: 'grid', gridTemplateColumns: '28px 1fr', gap: 10, alignItems: 'start', padding: '12px 14px', borderRadius: 10, border: `1px solid ${theme.line}`, background: '#fff', boxShadow: theme.shadow, lineHeight: 1.5 }, suggestionWarning: { background: theme.amberBg, borderColor: '#FDE68A', color: theme.amber }, suggestionGood: { background: theme.greenBg, borderColor: '#A7F3D0', color: theme.green }, suggestionIcon: { width: 28, height: 28, display: 'grid', placeItems: 'center', fontSize: 16 }, sub: { borderTop: `1px solid ${theme.line}`, paddingTop: 16 }, noteForm: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, marginBottom: 12 }, file: { marginBottom: 12, fontSize: 12 },
  empty: { minHeight: 136, display: 'grid', placeItems: 'center', textAlign: 'center', color: theme.muted, gap: 6, padding: 18 }, emptyIcon: { width: 42, height: 42, borderRadius: 10, display: 'grid', placeItems: 'center', background: '#F3F4F6', color: theme.navy600, fontWeight: 800 }, skeletonGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }, skeleton: { height: 120, borderRadius: 10, background: '#fff', border: `1px solid ${theme.line}`, boxShadow: theme.shadow, padding: 16, display: 'grid', gap: 10, alignContent: 'start' }, skeletonLineLarge: { height: 18, width: '55%', borderRadius: 6, background: '#E5E7EB', animation: 'lfPulse 1.4s ease-in-out infinite' }, skeletonLine: { height: 12, width: '80%', borderRadius: 6, background: '#EEF2F7', animation: 'lfPulse 1.4s ease-in-out infinite' }, skeletonLineShort: { height: 12, width: '42%', borderRadius: 6, background: '#EEF2F7', animation: 'lfPulse 1.4s ease-in-out infinite' },
  toast: { position: 'fixed', top: 22, right: 22, zIndex: 2000, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', minWidth: 300, maxWidth: 420, padding: '12px 14px', borderRadius: 10, boxShadow: theme.shadowLift, border: '1px solid', animation: 'lfSlideIn .18s ease-out' }, toastClose: { border: 0, background: 'transparent', color: 'inherit', fontWeight: 900, cursor: 'pointer', fontSize: 16 }, modalBackdrop: { position: 'fixed', inset: 0, zIndex: 3000, display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(15,27,51,.28)', backdropFilter: 'blur(4px)' }, modalCard: { width: 420, maxWidth: '100%', background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, boxShadow: theme.shadowLift, padding: 18 }, modalHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }, modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }, alert: { borderRadius: 8, padding: 12, background: theme.blueBg, color: theme.blue, fontWeight: 700 }, alertDanger: { background: theme.redBg, color: theme.red },
  loginShell: { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'linear-gradient(135deg, #F5F7FA, #EEF2F7)', color: '#fff' }, loginEditorial: { display: 'none' }, loginBadge: { display: 'none' }, loginMetricRow: { display: 'none' }, loginCard: { width: 410, maxWidth: 'calc(100vw - 32px)', color: theme.ink, background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 28, boxShadow: theme.shadowLift }, loginLogo: { width: 48, height: 48, borderRadius: 10, background: theme.gold, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 900, marginBottom: 12 }, loginHint: { marginTop: 12, color: theme.muted, fontSize: 12 },
};
