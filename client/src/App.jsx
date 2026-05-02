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
        {!loading && view === 'Clients' && <Clients clients={data.clients} reload={refresh} notify={setToast} />}
        {!loading && view === 'Matters' && <Matters data={data} canManage={canManage} reload={refresh} notify={setToast} />}
        {!loading && view === 'Tasks' && <Tasks data={data} reload={refresh} notify={setToast} />}
        {!loading && view === 'Invoices' && <Invoices invoices={data.invoices} isAdmin={isAdmin} reload={refresh} notify={setToast} />}
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
    </div>
  );
}

function Clients({ clients, reload, notify }) {
  const [form, setForm] = useState({ name: '', type: 'Individual', contact: '', email: '', phone: '' });
  async function submit(event) {
    event.preventDefault();
    try {
      await api('/clients', { method: 'POST', body: form });
      setForm({ name: '', type: 'Individual', contact: '', email: '', phone: '' });
      notify({ type: 'success', message: 'Client created.' });
      await reload();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  return <div style={styles.splitGrid}><Card title="New client" hint="Intake record"><form onSubmit={submit} style={styles.formGrid}><Field label="Name"><input required style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="Type"><select style={styles.input} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}><option>Individual</option><option>Company</option></select></Field><Field label="Contact"><input style={styles.input} value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} /></Field><Field label="Email"><input style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field><Field label="Phone"><input style={styles.input} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field><button style={styles.primaryButton}>Create client</button></form></Card><Card title="Client directory" hint={`${clients.length} records`}><Table columns={['Name', 'Type', 'Email', 'Phone', 'Status']} rows={clients.map(c => [c.name, c.type, c.email || '-', c.phone || '-', <Badge key={c.id} tone="green">{c.status || 'Active'}</Badge>])} empty="No clients yet." /></Card></div>;
}

function Matters({ data, canManage, reload, notify }) {
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ clientId: '', title: '', practiceArea: '', billingType: 'hourly', billingRate: 15000, fixedFee: 0 });
  const [time, setTime] = useState({ hours: 1, description: '', rate: 15000 });
  const [note, setNote] = useState('');
  const selected = data.matters.find(m => m.id === selectedId) || data.matters[0];

  useEffect(() => { if (selected?.id) { setSelectedId(selected.id); loadDetail(selected.id); } else setDetail(null); }, [selected?.id]);

  async function loadDetail(id) { setLoading(true); try { setDetail(await api(`/matters/${id}`)); } catch (err) { notify({ type: 'danger', message: err.message }); } finally { setLoading(false); } }
  async function createMatter(event) { event.preventDefault(); try { await api('/matters', { method: 'POST', body: form }); setForm({ clientId: '', title: '', practiceArea: '', billingType: 'hourly', billingRate: 15000, fixedFee: 0 }); notify({ type: 'success', message: 'Matter created.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function logTime(event) { event.preventDefault(); if (!detail) return; try { await api('/time-entries', { method: 'POST', body: { ...time, matterId: detail.id } }); setTime({ hours: 1, description: '', rate: detail.billingRate || 15000 }); notify({ type: 'success', message: 'Time logged.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function addNote(event) { event.preventDefault(); if (!detail || !note.trim()) return; try { await api(`/matters/${detail.id}/notes`, { method: 'POST', body: { content: note } }); setNote(''); notify({ type: 'success', message: 'Case note saved.' }); await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function uploadDoc(event) { const file = event.target.files?.[0]; if (!file || !detail) return; try { await api(`/matters/${detail.id}/documents`, { method: 'POST', body: { name: file.name, mimeType: file.type || 'application/octet-stream', data: await fileToDataUrl(file) } }); notify({ type: 'success', message: 'Document uploaded.' }); event.target.value = ''; await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function generateInvoice() { if (!detail) return; try { await api('/invoices/generate', { method: 'POST', body: { matterId: detail.id } }); notify({ type: 'success', message: 'Invoice generated.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }

  return <div style={styles.matterGrid}><Card title="Matter list" hint={`${data.matters.length} active files`}>{data.matters.length ? data.matters.map(m => <button key={m.id} onClick={() => setSelectedId(m.id)} style={{ ...styles.matterButton, ...(selected?.id === m.id ? styles.matterActive : {}) }}><strong>{m.title}</strong><span>{m.reference || m.id}</span><small>{m.clientName || 'No client'} / {m.stage || 'Intake'}</small></button>) : <Empty title="No matters" text="Create one after adding a client." />}</Card><div style={styles.pageStack}>{canManage && <Card title="Open a new matter" hint="Matter setup"><form onSubmit={createMatter} style={styles.formGrid}><Field label="Client"><select required style={styles.input} value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })}><option value="">Select client</option>{data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="Title"><input required style={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field><Field label="Practice"><input style={styles.input} value={form.practiceArea} onChange={e => setForm({ ...form, practiceArea: e.target.value })} /></Field><Field label="Billing"><select style={styles.input} value={form.billingType} onChange={e => setForm({ ...form, billingType: e.target.value })}><option value="hourly">Hourly</option><option value="fixed">Fixed fee</option></select></Field><Field label="Rate/Fee"><input type="number" style={styles.input} value={form.billingType === 'fixed' ? form.fixedFee : form.billingRate} onChange={e => setForm({ ...form, [form.billingType === 'fixed' ? 'fixedFee' : 'billingRate']: Number(e.target.value) })} /></Field><button style={styles.primaryButton}>Create matter</button></form></Card>}<Card title={detail?.title || 'Matter detail'} hint={detail?.reference || 'Select a file'} action={detail && canManage ? <button onClick={generateInvoice} style={styles.goldButton}>Generate invoice</button> : null}>{loading && <Skeleton rows={2} />}{!loading && detail && <div style={styles.detailStack}><div style={styles.chips}><Badge tone="blue">{detail.stage || 'Intake'}</Badge><span>{detail.clientName || 'No client'}</span><span>{detail.practiceArea || 'General'}</span></div><form onSubmit={logTime} style={styles.formGrid}><Field label="Hours"><input type="number" min="0" step="0.1" style={styles.input} value={time.hours} onChange={e => setTime({ ...time, hours: Number(e.target.value) })} /></Field><Field label="Description"><input style={styles.input} value={time.description} onChange={e => setTime({ ...time, description: e.target.value })} /></Field><Field label="Rate"><input type="number" style={styles.input} value={time.rate} onChange={e => setTime({ ...time, rate: Number(e.target.value) })} /></Field><button style={styles.primaryButton}>Log time</button></form><Sub title="Documents"><input style={styles.file} type="file" accept=".pdf,.doc,.docx" onChange={uploadDoc} /><Table columns={['Name', 'Type', 'Size', 'Download']} rows={(detail.documents || []).map(d => [d.name, d.type, d.size, <a key={d.id} style={styles.link} href={`${API_BASE}/documents/${d.id}/download?token=${encodeURIComponent(readSession()?.token || '')}`}>Download</a>])} empty="No documents uploaded." /></Sub><Sub title="Case notes"><form onSubmit={addNote} style={styles.noteForm}><input style={styles.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note" /><button style={styles.ghostButton}>Save note</button></form><Table columns={['Note', 'Author', 'Created']} rows={(detail.notes || []).map(n => [n.content, n.author || '-', n.createdAt ? new Date(n.createdAt).toLocaleString() : '-'])} empty="No notes yet." /></Sub><Sub title="Invoices"><Table columns={['Invoice', 'Amount', 'Status', 'PDF']} rows={(detail.invoices || []).map(i => [i.number || i.id, kes(i.amount), <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <a key={`${i.id}-pdf`} style={styles.link} href={`${API_BASE}/invoices/${i.id}/pdf?token=${encodeURIComponent(readSession()?.token || '')}`}>PDF</a>])} empty="No invoices yet." /></Sub></div>}{!loading && !detail && <Empty title="Select a matter" text="Matter detail will appear here." />}</Card></div></div>;
}

function Tasks({ data, reload, notify }) {
  const [form, setForm] = useState({ matterId: '', title: '', dueDate: '' });
  async function submit(event) { event.preventDefault(); try { await api('/tasks', { method: 'POST', body: form }); setForm({ matterId: '', title: '', dueDate: '' }); notify({ type: 'success', message: 'Task created.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function toggle(task) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: { completed: !task.completed } }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <div style={styles.splitGrid}><Card title="New task" hint="Deadline control"><form onSubmit={submit} style={styles.formGrid}><Field label="Matter"><select required style={styles.input} value={form.matterId} onChange={e => setForm({ ...form, matterId: e.target.value })}><option value="">Select matter</option>{data.matters.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></Field><Field label="Task"><input required style={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field><Field label="Due"><input type="date" style={styles.input} value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></Field><button style={styles.primaryButton}>Create task</button></form></Card><Card title="Task board" hint={`${data.tasks.length} tasks`}><Table columns={['Task', 'Due', 'Status', 'Action']} rows={data.tasks.map(t => [t.title, t.dueDate || '-', <Badge key={t.id} tone={t.completed ? 'green' : 'amber'}>{t.completed ? 'Done' : 'Open'}</Badge>, <button key={`${t.id}-toggle`} onClick={() => toggle(t)} style={styles.tinyButton}>{t.completed ? 'Reopen' : 'Complete'}</button>])} empty="No tasks yet." /></Card></div>;
}

function Invoices({ invoices, isAdmin, reload, notify }) {
  async function setStatus(id, status) { try { await api(`/invoices/${id}/status`, { method: 'PATCH', body: { status } }); notify({ type: 'success', message: 'Invoice updated.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <Card title="Invoice register" hint="Receivables"><Table columns={['Invoice', 'Client', 'Matter', 'Amount', 'Status', 'PDF']} rows={invoices.map(i => [i.number || i.id, i.clientName || '-', i.matterTitle || '-', kes(i.amount), isAdmin ? <select key={i.id} style={styles.tableSelect} value={i.status} onChange={e => setStatus(i.id, e.target.value)}><option>Outstanding</option><option>Paid</option><option>Overdue</option></select> : <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <a key={`${i.id}-pdf`} style={styles.link} href={`${API_BASE}/invoices/${i.id}/pdf?token=${encodeURIComponent(readSession()?.token || '')}`}>Download</a>])} empty="No invoices yet." /></Card>;
}

function Users({ notify }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ email: '', password: '', fullName: '', role: 'assistant' });
  useEffect(() => { load(); }, []);
  async function load() { try { setUsers(await api('/auth/users')); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function submit(event) { event.preventDefault(); try { await api('/auth/register', { method: 'POST', body: form }); setForm({ email: '', password: '', fullName: '', role: 'assistant' }); notify({ type: 'success', message: 'User created.' }); await load(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <div style={styles.splitGrid}><Card title="Create user" hint="Role-based access"><form onSubmit={submit} style={styles.formGrid}><Field label="Full name"><input required style={styles.input} value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} /></Field><Field label="Email"><input required style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field><Field label="Password"><input required type="password" style={styles.input} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field><Field label="Role"><select style={styles.input} value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}><option value="assistant">Assistant</option><option value="advocate">Advocate</option><option value="admin">Admin</option></select></Field><button style={styles.primaryButton}>Create user</button></form></Card><Card title="Team" hint={`${users.length} users`}><Table columns={['Name', 'Email', 'Role']} rows={users.map(u => [u.fullName, u.email, <Badge key={u.id} tone="blue">{u.role}</Badge>])} empty="No users found." /></Card></div>;
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
  timerCard: { marginTop: 'auto', padding: 12, borderRadius: 8, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.10)', display: 'grid', gap: 4 }, timerTop: { color: '#DDE5F1', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }, liveDot: { width: 8, height: 8, borderRadius: 999, background: '#22C55E', boxShadow: '0 0 0 4px rgba(34,197,94,.13)' },
  userCard: { display: 'grid', gridTemplateColumns: '34px 1fr auto', gap: 8, alignItems: 'center', paddingTop: 12, borderTop: '1px solid rgba(255,255,255,.10)' }, avatar: { width: 34, height: 34, borderRadius: 8, background: '#243653', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 12 }, userName: { fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }, userRole: { color: '#AAB4C3', fontSize: 11, textTransform: 'capitalize' }, logout: { border: '1px solid rgba(255,255,255,.18)', color: '#fff', background: 'transparent', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', fontSize: 12 },
  main: { padding: 24, minWidth: 0 }, topbar: { display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', marginBottom: 20 }, eyebrow: { color: theme.goldDark, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0 }, title: { margin: '2px 0 0', fontSize: 20, fontWeight: 700, lineHeight: 1.2 }, subtitle: { margin: '5px 0 0', color: theme.muted, maxWidth: 680 }, topActions: { display: 'flex', gap: 8, alignItems: 'center' }, search: { width: 260, border: `1px solid ${theme.line}`, borderRadius: 6, padding: '7px 11px', background: '#fff', fontSize: 13 },
  pageStack: { display: 'grid', gap: 16 }, heroCard: { borderRadius: 10, background: `linear-gradient(135deg, ${theme.navy800}, #1B3A5C)`, color: '#fff', padding: 24, display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'end', boxShadow: theme.shadow }, heroKicker: { color: theme.gold, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }, heroFigure: { fontSize: 24, fontWeight: 700, color: theme.gold },
  warningPanel: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10, border: '1px solid #FDE68A', background: theme.amberBg, color: theme.amber, boxShadow: theme.shadow }, warningIcon: { width: 28, height: 28, borderRadius: 999, display: 'grid', placeItems: 'center', background: '#FDE68A', fontWeight: 900 }, 
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }, stat: { position: 'relative', overflow: 'hidden', background: '#fff', border: `1px solid ${theme.line}`, borderLeft: '4px solid', borderRadius: 10, padding: 16, boxShadow: theme.shadow, display: 'grid', gap: 6 }, 
  splitGrid: { display: 'grid', gridTemplateColumns: 'minmax(260px,.72fr) minmax(0,1.28fr)', gap: 16 }, dashboardGrid: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16 }, matterGrid: { display: 'grid', gridTemplateColumns: '300px minmax(0,1fr)', gap: 16 },
  card: { background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: '18px 20px', boxShadow: theme.shadow, minWidth: 0, transition: 'box-shadow .16s ease, transform .16s ease' }, cardHead: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 14 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 12, alignItems: 'end' }, field: { display: 'grid', gap: 5 }, input: { width: '100%', border: `1px solid ${theme.line}`, borderRadius: 6, padding: '7px 11px', background: '#fff', fontSize: 13 }, primaryButton: { border: 0, borderRadius: 6, padding: '7px 16px', background: theme.navy600, color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13 }, goldButton: { border: 0, borderRadius: 6, padding: '7px 16px', background: theme.gold, color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13 }, ghostButton: { border: `1px solid ${theme.line}`, borderRadius: 6, padding: '7px 16px', background: '#fff', color: theme.navy600, fontWeight: 700, cursor: 'pointer', fontSize: 13 }, tinyButton: { border: `1px solid ${theme.line}`, borderRadius: 6, padding: '4px 10px', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: theme.navy600 },
  tableWrap: { overflowX: 'auto', border: `1px solid ${theme.line}`, borderRadius: 8 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 620 }, badge: { display: 'inline-flex', padding: '4px 8px', borderRadius: 999, fontWeight: 700, fontSize: 12 }, link: { color: theme.navy600, fontWeight: 700, textDecoration: 'none' }, tableSelect: { border: `1px solid ${theme.line}`, borderRadius: 6, padding: '5px 8px', fontSize: 12 },
  pipelineRow: { display: 'grid', gridTemplateColumns: '116px 1fr 30px', gap: 10, alignItems: 'center', marginBottom: 10 }, pipelineTrack: { height: 8, background: '#EEF2F7', borderRadius: 999, overflow: 'hidden' }, pipelineFill: { height: '100%', background: theme.gold, borderRadius: 999 },
  matterButton: { width: '100%', display: 'grid', gap: 4, textAlign: 'left', border: 0, borderLeft: '3px solid transparent', borderBottom: `1px solid ${theme.line}`, background: '#fff', padding: '12px 10px', cursor: 'pointer', borderRadius: 6 }, matterActive: { background: '#F8FAFC', borderLeftColor: theme.gold }, detailStack: { display: 'grid', gap: 16 }, chips: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, color: theme.muted }, sub: { borderTop: `1px solid ${theme.line}`, paddingTop: 16 }, noteForm: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, marginBottom: 12 }, file: { marginBottom: 12, fontSize: 12 },
  empty: { minHeight: 136, display: 'grid', placeItems: 'center', textAlign: 'center', color: theme.muted, gap: 6, padding: 18 }, emptyIcon: { width: 42, height: 42, borderRadius: 10, display: 'grid', placeItems: 'center', background: '#F3F4F6', color: theme.navy600, fontWeight: 800 }, skeletonGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }, skeleton: { height: 120, borderRadius: 10, background: '#fff', border: `1px solid ${theme.line}`, boxShadow: theme.shadow, padding: 16, display: 'grid', gap: 10, alignContent: 'start' }, skeletonLineLarge: { height: 18, width: '55%', borderRadius: 6, background: '#E5E7EB', animation: 'lfPulse 1.4s ease-in-out infinite' }, skeletonLine: { height: 12, width: '80%', borderRadius: 6, background: '#EEF2F7', animation: 'lfPulse 1.4s ease-in-out infinite' }, skeletonLineShort: { height: 12, width: '42%', borderRadius: 6, background: '#EEF2F7', animation: 'lfPulse 1.4s ease-in-out infinite' },
  toast: { position: 'fixed', top: 22, right: 22, zIndex: 2000, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', minWidth: 300, maxWidth: 420, padding: '12px 14px', borderRadius: 10, boxShadow: theme.shadowLift, border: '1px solid', animation: 'lfSlideIn .18s ease-out' }, toastClose: { border: 0, background: 'transparent', color: 'inherit', fontWeight: 900, cursor: 'pointer', fontSize: 16 }, alert: { borderRadius: 8, padding: 12, background: theme.blueBg, color: theme.blue, fontWeight: 700 }, alertDanger: { background: theme.redBg, color: theme.red },
  loginShell: { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'linear-gradient(135deg, #F5F7FA, #EEF2F7)', color: '#fff' }, loginEditorial: { display: 'none' }, loginBadge: { display: 'none' }, loginMetricRow: { display: 'none' }, loginCard: { width: 410, maxWidth: 'calc(100vw - 32px)', color: theme.ink, background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 28, boxShadow: theme.shadowLift }, loginLogo: { width: 48, height: 48, borderRadius: 10, background: theme.gold, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 900, marginBottom: 12 }, loginHint: { marginTop: 12, color: theme.muted, fontSize: 12 },
};
