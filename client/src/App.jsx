import { useEffect, useMemo, useState } from 'react';

const API_BASE = '/api';

const DS = {
  colors: {
    sidebar: '#0F1B33',
    sidebarSoft: '#172540',
    navy: '#1B3A5C',
    navyDark: '#132B46',
    gold: '#D4A34A',
    goldDark: '#B98B35',
    bg: '#F4F6F8',
    panel: '#FFFFFF',
    border: '#E5E7EB',
    text: '#111827',
    muted: '#6B7280',
    faint: '#F9FAFB',
    success: '#047857',
    successBg: '#ECFDF5',
    warning: '#B45309',
    warningBg: '#FFFBEB',
    danger: '#B91C1C',
    dangerBg: '#FEF2F2',
    info: '#1D4ED8',
    infoBg: '#EFF6FF',
  },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 6, md: 10, lg: 14 },
  shadow: '0 14px 35px rgba(15, 27, 51, 0.08)',
};

const navItems = [
  ['Dashboard', 'D'],
  ['Clients', 'C'],
  ['Matters', 'M'],
  ['Tasks', 'T'],
  ['Invoices', 'I'],
  ['Users', 'U'],
];

function readSession() {
  try {
    const session = JSON.parse(localStorage.getItem('lexflowSession') || 'null');
    if (session?.token) return session;
    const token = localStorage.getItem('lexflowToken');
    return token ? { token, user: null } : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  localStorage.setItem('lexflowSession', JSON.stringify(session));
  localStorage.setItem('lexflowToken', session.token);
}

function clearSession() {
  localStorage.removeItem('lexflowSession');
  localStorage.removeItem('lexflowToken');
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Unable to read file'));
    reader.readAsDataURL(file);
  });
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
  const payload = type.includes('application/json') ? await response.json().catch(() => ({})) : await response.text();
  if (response.status === 401) clearSession();
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

export default function App() {
  const [session, setSession] = useState(readSession);
  const [user, setUser] = useState(session?.user || null);
  const [view, setView] = useState('Dashboard');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [data, setData] = useState({ dashboard: {}, clients: [], matters: [], tasks: [], invoices: [] });

  const isAuthed = Boolean(session?.token);
  const isAdmin = user?.role === 'admin';
  const canManage = ['admin', 'advocate'].includes(user?.role);
  const timerRunning = false;

  useEffect(() => {
    if (isAuthed) loadEverything();
  }, [isAuthed]);

  async function loadEverything() {
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
    } catch (error) {
      setToast({ type: 'danger', message: error.message });
      if (error.message.toLowerCase().includes('auth')) handleLogout();
    } finally {
      setLoading(false);
    }
  }

  function handleLogin(nextSession) {
    saveSession(nextSession);
    setSession(nextSession);
    setUser(nextSession.user || null);
    setToast({ type: 'success', message: 'Welcome back to LexFlow.' });
  }

  function handleLogout() {
    clearSession();
    setSession(null);
    setUser(null);
    setData({ dashboard: {}, clients: [], matters: [], tasks: [], invoices: [] });
  }

  if (!isAuthed) return <LoginPage onLogin={handleLogin} />;

  const visibleNav = navItems.filter(([label]) => label !== 'Users' || isAdmin);
  const subtitle = {
    Dashboard: 'Today\'s practice pulse, revenue position and active work.',
    Clients: 'Client intake, contact records and conflict-ready details.',
    Matters: 'Matter pipeline, billing, documents, notes and invoices.',
    Tasks: 'Open work, deadlines and responsibility tracking.',
    Invoices: 'Outstanding, paid and overdue billing records.',
    Users: 'Access management for advocates, assistants and admins.',
  }[view];

  return (
    <div style={styles.appShell}>
      <aside style={styles.sidebar}>
        <div style={styles.brandBlock}>
          <div style={styles.brandMark}>LF</div>
          <div>
            <div style={styles.brandName}>LexFlow Kenya</div>
            <div style={styles.brandMeta}>Practice Manager</div>
          </div>
        </div>

        <nav style={styles.navList}>
          {visibleNav.map(([label, icon]) => (
            <button key={label} type="button" onClick={() => setView(label)} style={{ ...styles.navItem, ...(view === label ? styles.navItemActive : {}) }}>
              <span style={styles.navIcon}>{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div style={styles.userPanel}>
          <div style={styles.userAvatar}>{(user?.fullName || user?.name || 'U').slice(0, 1).toUpperCase()}</div>
          <div style={{ minWidth: 0 }}>
            <div style={styles.userName}>{user?.fullName || user?.name || 'Signed in'}</div>
            <div style={styles.userRole}>{user?.role || 'user'} {timerRunning && <span style={styles.greenDot} />}</div>
          </div>
          <button type="button" onClick={handleLogout} style={styles.logoutButton}>Out</button>
        </div>
      </aside>

      <main style={styles.mainArea}>
        <TopBar title={view} subtitle={subtitle} query={query} setQuery={setQuery} loading={loading} onRefresh={loadEverything} />
        {loading && <SkeletonGrid />}
        {!loading && view === 'Dashboard' && <Dashboard data={data} />}
        {!loading && view === 'Clients' && <Clients clients={data.clients} reload={loadEverything} notify={setToast} />}
        {!loading && view === 'Matters' && <Matters data={data} canManage={canManage} reload={loadEverything} notify={setToast} />}
        {!loading && view === 'Tasks' && <Tasks data={data} reload={loadEverything} notify={setToast} />}
        {!loading && view === 'Invoices' && <Invoices invoices={data.invoices} isAdmin={isAdmin} reload={loadEverything} notify={setToast} />}
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
    <div style={styles.loginPage}>
      <div style={styles.loginAura} />
      <form onSubmit={submit} style={styles.loginCard}>
        <div style={styles.loginTop}>
          <div style={styles.brandMarkLarge}>LF</div>
          <div>
            <h1 style={styles.loginTitle}>LexFlow Kenya</h1>
            <p style={styles.loginSubtitle}>Secure law practice management</p>
          </div>
        </div>
        {error && <Alert type="danger" message={error} />}
        <Field label="Email"><input style={styles.input} value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" /></Field>
        <Field label="Password"><input style={styles.input} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></Field>
        <button type="submit" disabled={busy} style={{ ...styles.buttonPrimary, width: '100%', marginTop: DS.space.lg }}>{busy ? 'Signing in...' : 'Sign In'}</button>
        <div style={styles.loginHint}>Default admin: admin@lexflow.co.ke / admin123</div>
      </form>
    </div>
  );
}

function TopBar({ title, subtitle, query, setQuery, loading, onRefresh }) {
  return (
    <header style={styles.topBar}>
      <div>
        <h1 style={styles.pageTitle}>{title}</h1>
        <p style={styles.pageSubtitle}>{subtitle}</p>
      </div>
      <div style={styles.topActions}>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search matters, clients..." style={styles.searchInput} />
        <button type="button" onClick={onRefresh} disabled={loading} style={styles.buttonGhost}>{loading ? 'Refreshing' : 'Refresh'}</button>
      </div>
    </header>
  );
}

function Dashboard({ data }) {
  const outstanding = data.invoices.filter(inv => inv.status === 'Outstanding').reduce((sum, inv) => sum + Number(inv.amount || 0), 0);
  const stageCounts = data.matters.reduce((acc, matter) => ({ ...acc, [matter.stage || 'Intake']: (acc[matter.stage || 'Intake'] || 0) + 1 }), {});
  const maxStage = Math.max(1, ...Object.values(stageCounts));
  return (
    <>
      <div style={styles.statsGrid}>
        <Stat label="Active Matters" value={data.dashboard.activeMattersCount ?? data.matters.length} tone="navy" />
        <Stat label="Month Hours" value={Number(data.dashboard.monthHours || 0).toFixed(1)} tone="gold" />
        <Stat label="Month Revenue" value={kes(data.dashboard.monthRevenue)} tone="success" />
        <Stat label="Outstanding" value={kes(outstanding)} tone="danger" />
      </div>
      <div style={styles.dashboardGrid}>
        <Card title="Matter Pipeline">
          {Object.keys(stageCounts).length ? Object.entries(stageCounts).map(([stage, count]) => (
            <div key={stage} style={styles.pipelineRow}>
              <span style={styles.pipelineLabel}>{stage}</span>
              <div style={styles.pipelineTrack}><div style={{ ...styles.pipelineFill, width: `${(count / maxStage) * 100}%` }} /></div>
              <strong>{count}</strong>
            </div>
          )) : <EmptyState title="No matters yet" text="Create your first matter to start the pipeline." />}
        </Card>
        <Card title="Recent Invoices">
          <Table columns={['Invoice', 'Client', 'Amount', 'Status']} rows={data.invoices.slice(0, 5).map(inv => [inv.number || inv.id, inv.clientName || 'Client', kes(inv.amount), <Badge key={inv.id} tone={inv.status === 'Paid' ? 'success' : inv.status === 'Overdue' ? 'danger' : 'warning'}>{inv.status}</Badge>])} empty="No invoices yet." />
        </Card>
      </div>
    </>
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
  return (
    <div style={styles.contentGrid}>
      <Card title="New Client">
        <form onSubmit={submit} style={styles.formGrid}>
          <Field label="Name"><input style={styles.input} required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Type"><select style={styles.input} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}><option>Individual</option><option>Company</option></select></Field>
          <Field label="Contact"><input style={styles.input} value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} /></Field>
          <Field label="Email"><input style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Phone"><input style={styles.input} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field>
          <button style={styles.buttonPrimary}>Create Client</button>
        </form>
      </Card>
      <Card title="Client Directory">
        <Table columns={['Name', 'Type', 'Email', 'Phone', 'Status']} rows={clients.map(c => [c.name, c.type, c.email || '-', c.phone || '-', <Badge key={c.id} tone="success">{c.status || 'Active'}</Badge>])} empty="No clients yet." />
      </Card>
    </div>
  );
}

function Matters({ data, canManage, reload, notify }) {
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [form, setForm] = useState({ clientId: '', title: '', practiceArea: '', billingType: 'hourly', billingRate: 15000, fixedFee: 0 });
  const [time, setTime] = useState({ hours: 1, description: '', rate: 15000 });
  const [note, setNote] = useState('');
  const selected = data.matters.find(m => m.id === selectedId) || data.matters[0];

  useEffect(() => {
    if (!selected?.id) { setDetail(null); return; }
    setSelectedId(selected.id);
    loadDetail(selected.id);
  }, [selected?.id]);

  async function loadDetail(id) {
    setDetailLoading(true);
    try { setDetail(await api(`/matters/${id}`)); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
    finally { setDetailLoading(false); }
  }
  async function createMatter(event) {
    event.preventDefault();
    try { await api('/matters', { method: 'POST', body: form }); setForm({ clientId: '', title: '', practiceArea: '', billingType: 'hourly', billingRate: 15000, fixedFee: 0 }); notify({ type: 'success', message: 'Matter created.' }); await reload(); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function logTime(event) {
    event.preventDefault();
    if (!selected) return;
    try { await api('/time-entries', { method: 'POST', body: { ...time, matterId: selected.id } }); setTime({ hours: 1, description: '', rate: selected.billingRate || 15000 }); notify({ type: 'success', message: 'Time entry logged.' }); await loadDetail(selected.id); await reload(); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function addNote(event) {
    event.preventDefault();
    if (!detail || !note.trim()) return;
    try { await api(`/matters/${detail.id}/notes`, { method: 'POST', body: { content: note } }); setNote(''); notify({ type: 'success', message: 'Case note saved.' }); await loadDetail(detail.id); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function uploadDoc(event) {
    const file = event.target.files?.[0];
    if (!file || !detail) return;
    try { await api(`/matters/${detail.id}/documents`, { method: 'POST', body: { name: file.name, mimeType: file.type || 'application/octet-stream', data: await fileToDataUrl(file) } }); notify({ type: 'success', message: 'Document uploaded.' }); event.target.value = ''; await loadDetail(detail.id); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function generateInvoice() {
    if (!detail) return;
    try { await api('/invoices/generate', { method: 'POST', body: { matterId: detail.id } }); notify({ type: 'success', message: 'Invoice generated.' }); await loadDetail(detail.id); await reload(); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  return (
    <div style={styles.matterLayout}>
      <Card title="Matters">
        {data.matters.length ? data.matters.map(m => (
          <button key={m.id} type="button" onClick={() => setSelectedId(m.id)} style={{ ...styles.matterButton, ...(selected?.id === m.id ? styles.matterButtonActive : {}) }}>
            <strong>{m.title}</strong><span>{m.reference || m.id}</span><span>{m.clientName || 'No client'} · {m.stage || 'Intake'}</span>
          </button>
        )) : <EmptyState title="No matters" text="Create a matter once a client is available." />}
      </Card>
      <div style={{ display: 'grid', gap: DS.space.lg }}>
        {canManage && <Card title="Create Matter"><form onSubmit={createMatter} style={styles.formGrid}><Field label="Client"><select required style={styles.input} value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })}><option value="">Select client</option>{data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="Title"><input required style={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field><Field label="Practice"><input style={styles.input} value={form.practiceArea} onChange={e => setForm({ ...form, practiceArea: e.target.value })} /></Field><Field label="Billing"><select style={styles.input} value={form.billingType} onChange={e => setForm({ ...form, billingType: e.target.value })}><option value="hourly">Hourly</option><option value="fixed">Fixed Fee</option></select></Field><Field label="Rate/Fee"><input type="number" style={styles.input} value={form.billingType === 'fixed' ? form.fixedFee : form.billingRate} onChange={e => setForm({ ...form, [form.billingType === 'fixed' ? 'fixedFee' : 'billingRate']: Number(e.target.value) })} /></Field><button style={styles.buttonPrimary}>Create Matter</button></form></Card>}
        <Card title={detail?.title || selected?.title || 'Matter Detail'} action={detail && canManage ? <button onClick={generateInvoice} style={styles.buttonAccent}>Generate Invoice</button> : null}>
          {detailLoading && <SkeletonGrid rows={2} />}
          {!detailLoading && detail && <div style={styles.detailStack}>
            <div style={styles.metaLine}><Badge tone="info">{detail.stage || 'Intake'}</Badge><span>{detail.reference || detail.id}</span><span>{detail.clientName || 'No client'}</span><span>{detail.practiceArea || 'General'}</span></div>
            <form onSubmit={logTime} style={styles.formGrid}><Field label="Hours"><input type="number" min="0" step="0.1" style={styles.input} value={time.hours} onChange={e => setTime({ ...time, hours: Number(e.target.value) })} /></Field><Field label="Description"><input style={styles.input} value={time.description} onChange={e => setTime({ ...time, description: e.target.value })} /></Field><Field label="Rate"><input type="number" style={styles.input} value={time.rate} onChange={e => setTime({ ...time, rate: Number(e.target.value) })} /></Field><button style={styles.buttonPrimary}>Log Time</button></form>
            <Section title="Documents"><input type="file" accept=".pdf,.doc,.docx" onChange={uploadDoc} style={styles.fileInput} /> <Table columns={['Name', 'Type', 'Size', 'Download']} rows={(detail.documents || []).map(d => [d.name, d.type, d.size, <a key={d.id} style={styles.inlineLink} href={`${API_BASE}/documents/${d.id}/download?token=${encodeURIComponent(readSession()?.token || '')}`}>Download</a>])} empty="No documents uploaded." /></Section>
            <Section title="Case Notes"><form onSubmit={addNote} style={styles.noteForm}><input style={styles.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note" /><button style={styles.buttonGhost}>Save Note</button></form><Table columns={['Note', 'Author', 'Created']} rows={(detail.notes || []).map(n => [n.content, n.author || '-', n.createdAt ? new Date(n.createdAt).toLocaleString() : '-'])} empty="No case notes." /></Section>
            <Section title="Invoices"><Table columns={['Invoice', 'Amount', 'Status', 'PDF']} rows={(detail.invoices || []).map(i => [i.number || i.id, kes(i.amount), <Badge key={i.id} tone={i.status === 'Paid' ? 'success' : 'warning'}>{i.status}</Badge>, <a key={`${i.id}-pdf`} style={styles.inlineLink} href={`${API_BASE}/invoices/${i.id}/pdf?token=${encodeURIComponent(readSession()?.token || '')}`}>PDF</a>])} empty="No invoices for this matter." /></Section>
          </div>}
          {!detailLoading && !detail && <EmptyState title="Select a matter" text="Matter details will appear here." />}
        </Card>
      </div>
    </div>
  );
}

function Tasks({ data, reload, notify }) {
  const [form, setForm] = useState({ matterId: '', title: '', dueDate: '' });
  async function submit(event) {
    event.preventDefault();
    try { await api('/tasks', { method: 'POST', body: form }); setForm({ matterId: '', title: '', dueDate: '' }); notify({ type: 'success', message: 'Task created.' }); await reload(); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function toggle(task) {
    try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: { completed: !task.completed } }); await reload(); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  return <div style={styles.contentGrid}><Card title="Create Task"><form onSubmit={submit} style={styles.formGrid}><Field label="Matter"><select required style={styles.input} value={form.matterId} onChange={e => setForm({ ...form, matterId: e.target.value })}><option value="">Select matter</option>{data.matters.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></Field><Field label="Task"><input required style={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field><Field label="Due"><input type="date" style={styles.input} value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></Field><button style={styles.buttonPrimary}>Create Task</button></form></Card><Card title="Task List"><Table columns={['Task', 'Due', 'Status', 'Action']} rows={data.tasks.map(t => [t.title, t.dueDate || '-', <Badge key={t.id} tone={t.completed ? 'success' : 'warning'}>{t.completed ? 'Done' : 'Open'}</Badge>, <button key={`${t.id}-toggle`} onClick={() => toggle(t)} style={styles.buttonTiny}>{t.completed ? 'Reopen' : 'Complete'}</button>])} empty="No tasks yet." /></Card></div>;
}

function Invoices({ invoices, isAdmin, reload, notify }) {
  async function status(id, value) {
    try { await api(`/invoices/${id}/status`, { method: 'PATCH', body: { status: value } }); notify({ type: 'success', message: 'Invoice updated.' }); await reload(); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  return <Card title="Invoice Register"><Table columns={['Invoice', 'Client', 'Matter', 'Amount', 'Status', 'PDF']} rows={invoices.map(i => [i.number || i.id, i.clientName || '-', i.matterTitle || '-', kes(i.amount), isAdmin ? <select key={i.id} value={i.status} onChange={e => status(i.id, e.target.value)} style={styles.tableSelect}><option>Outstanding</option><option>Paid</option><option>Overdue</option></select> : <Badge key={i.id} tone={i.status === 'Paid' ? 'success' : i.status === 'Overdue' ? 'danger' : 'warning'}>{i.status}</Badge>, <a key={`${i.id}-pdf`} style={styles.inlineLink} href={`${API_BASE}/invoices/${i.id}/pdf?token=${encodeURIComponent(readSession()?.token || '')}`}>Download</a>])} empty="No invoices yet." /></Card>;
}

function Users({ notify }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ email: '', password: '', fullName: '', role: 'assistant' });
  useEffect(() => { load(); }, []);
  async function load() { try { setUsers(await api('/auth/users')); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function submit(event) { event.preventDefault(); try { await api('/auth/register', { method: 'POST', body: form }); setForm({ email: '', password: '', fullName: '', role: 'assistant' }); notify({ type: 'success', message: 'User created.' }); await load(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <div style={styles.contentGrid}><Card title="Create User"><form onSubmit={submit} style={styles.formGrid}><Field label="Full Name"><input required style={styles.input} value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} /></Field><Field label="Email"><input required style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field><Field label="Password"><input required type="password" style={styles.input} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field><Field label="Role"><select style={styles.input} value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}><option value="assistant">Assistant</option><option value="advocate">Advocate</option><option value="admin">Admin</option></select></Field><button style={styles.buttonPrimary}>Create User</button></form></Card><Card title="Users"><Table columns={['Name', 'Email', 'Role']} rows={users.map(u => [u.fullName, u.email, <Badge key={u.id} tone="info">{u.role}</Badge>])} empty="No users found." /></Card></div>;
}

function Card({ title, action, children }) { return <section style={styles.card}><div style={styles.cardHeader}><h2 style={styles.cardTitle}>{title}</h2>{action}</div>{children}</section>; }
function Section({ title, children }) { return <div style={styles.section}><h3 style={styles.sectionTitle}>{title}</h3>{children}</div>; }
function Field({ label, children }) { return <label style={styles.field}><span style={styles.label}>{label}</span>{children}</label>; }
function Stat({ label, value, tone }) { const color = tone === 'gold' ? DS.colors.gold : tone === 'success' ? DS.colors.success : tone === 'danger' ? DS.colors.danger : DS.colors.navy; return <div style={styles.statCard}><div style={{ ...styles.statStripe, background: color }} /><span style={styles.statLabel}>{label}</span><strong style={styles.statValue}>{value}</strong></div>; }
function Badge({ children, tone = 'info' }) { const map = { success: [DS.colors.successBg, DS.colors.success], warning: [DS.colors.warningBg, DS.colors.warning], danger: [DS.colors.dangerBg, DS.colors.danger], info: [DS.colors.infoBg, DS.colors.info] }; const [bg, color] = map[tone] || map.info; return <span style={{ ...styles.badge, background: bg, color }}>{children}</span>; }
function Alert({ type, message }) { return <div style={{ ...styles.alert, ...(type === 'danger' ? styles.alertDanger : styles.alertInfo) }}>{message}</div>; }
function Toast({ toast, onClose }) { if (!toast) return null; const tone = toast.type || 'info'; const palette = { success: [DS.colors.successBg, DS.colors.success], danger: [DS.colors.dangerBg, DS.colors.danger], warning: [DS.colors.warningBg, DS.colors.warning], info: [DS.colors.infoBg, DS.colors.info] }[tone] || [DS.colors.infoBg, DS.colors.info]; return <div style={{ ...styles.toast, background: palette[0], color: palette[1] }}><strong>{toast.message}</strong><button onClick={onClose} style={styles.toastClose}>x</button></div>; }
function EmptyState({ title, text }) { return <div style={styles.empty}><div style={styles.emptyIcon}>-</div><strong>{title}</strong><span>{text}</span></div>; }
function SkeletonGrid({ rows = 4 }) { return <div style={styles.skeletonGrid}>{Array.from({ length: rows }).map((_, index) => <div key={index} style={styles.skeletonCard}><span /><span /><span /></div>)}</div>; }
function Table({ columns, rows, empty }) { if (!rows.length) return <EmptyState title={empty} text="Records will appear here once created." />; return <div style={styles.tableWrap}><table style={styles.table}><thead><tr>{columns.map(col => <th key={col} style={styles.th}>{col}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} style={index % 2 ? styles.trAlt : null}>{row.map((cell, cellIndex) => <td key={cellIndex} style={styles.td}>{cell}</td>)}</tr>)}</tbody></table></div>; }
function kes(value) { return `KSh ${Number(value || 0).toLocaleString('en-KE')}`; }

const styles = {
  appShell: { minHeight: '100vh', display: 'flex', background: DS.colors.bg, color: DS.colors.text, fontFamily: 'Inter, Segoe UI, system-ui, sans-serif' },
  sidebar: { width: 268, background: DS.colors.sidebar, color: '#fff', padding: DS.space.xl, display: 'flex', flexDirection: 'column', gap: DS.space.xl, boxSizing: 'border-box' },
  brandBlock: { display: 'flex', alignItems: 'center', gap: DS.space.md },
  brandMark: { width: 42, height: 42, borderRadius: 10, background: DS.colors.gold, display: 'grid', placeItems: 'center', fontWeight: 900, color: '#fff' },
  brandMarkLarge: { width: 52, height: 52, borderRadius: 14, background: DS.colors.gold, display: 'grid', placeItems: 'center', fontWeight: 900, color: '#fff', boxShadow: '0 12px 30px rgba(212,163,74,.28)' },
  brandName: { fontWeight: 800, fontSize: 17 }, brandMeta: { color: '#AAB4C3', fontSize: 12, marginTop: 2 },
  navList: { display: 'grid', gap: DS.space.sm }, navItem: { display: 'flex', alignItems: 'center', gap: DS.space.md, border: 0, borderRadius: 10, padding: '11px 12px', color: '#CED6E3', background: 'transparent', cursor: 'pointer', fontWeight: 700, transition: 'background .18s ease, color .18s ease, transform .18s ease' }, navItemActive: { background: DS.colors.sidebarSoft, color: '#fff', boxShadow: 'inset 3px 0 0 #D4A34A' }, navIcon: { width: 26, height: 26, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,.09)', fontSize: 12, fontWeight: 900 },
  userPanel: { marginTop: 'auto', borderTop: '1px solid rgba(255,255,255,.12)', paddingTop: DS.space.lg, display: 'grid', gridTemplateColumns: '38px 1fr auto', alignItems: 'center', gap: DS.space.sm }, userAvatar: { width: 38, height: 38, borderRadius: 10, background: '#243653', display: 'grid', placeItems: 'center', fontWeight: 900 }, userName: { fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, userRole: { color: '#AAB4C3', fontSize: 12, textTransform: 'capitalize' }, greenDot: { display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: '#22C55E', marginLeft: 6 }, logoutButton: { border: '1px solid rgba(255,255,255,.18)', background: 'transparent', color: '#fff', borderRadius: 8, padding: '7px 9px', cursor: 'pointer' },
  mainArea: { flex: 1, padding: '26px 30px', minWidth: 0 }, topBar: { display: 'flex', justifyContent: 'space-between', gap: DS.space.xl, alignItems: 'center', marginBottom: DS.space.xl }, pageTitle: { margin: 0, fontSize: 28, letterSpacing: 0 }, pageSubtitle: { margin: '5px 0 0', color: DS.colors.muted, fontSize: 14 }, topActions: { display: 'flex', gap: DS.space.md, alignItems: 'center' }, searchInput: { width: 260, border: `1px solid ${DS.colors.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 13 },
  card: { background: DS.colors.panel, border: `1px solid ${DS.colors.border}`, borderRadius: 10, padding: '18px 20px', boxShadow: DS.shadow, minWidth: 0 }, cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: DS.space.md, marginBottom: DS.space.lg }, cardTitle: { margin: 0, fontSize: 17 }, section: { borderTop: `1px solid ${DS.colors.border}`, paddingTop: DS.space.lg, marginTop: DS.space.lg }, sectionTitle: { margin: '0 0 10px', fontSize: 14 },
  loginPage: { minHeight: '100vh', display: 'grid', placeItems: 'center', background: `linear-gradient(135deg, ${DS.colors.sidebar} 0%, #182C4B 45%, #F4F6F8 45%)`, position: 'relative', overflow: 'hidden', padding: DS.space.xl }, loginAura: { position: 'absolute', width: 420, height: 420, borderRadius: 999, background: 'rgba(212,163,74,.16)', top: -120, right: -80 }, loginCard: { width: 410, maxWidth: '100%', background: '#fff', border: `1px solid ${DS.colors.border}`, borderRadius: 14, padding: 28, boxShadow: '0 26px 70px rgba(15,27,51,.22)', zIndex: 1 }, loginTop: { display: 'flex', alignItems: 'center', gap: DS.space.md, marginBottom: DS.space.xl }, loginTitle: { margin: 0, fontSize: 22 }, loginSubtitle: { margin: '4px 0 0', color: DS.colors.muted, fontSize: 13 }, loginHint: { marginTop: DS.space.md, fontSize: 12, color: DS.colors.muted },
  field: { display: 'grid', gap: DS.space.xs, minWidth: 0 }, label: { fontSize: 11, fontWeight: 800, color: DS.colors.muted, textTransform: 'uppercase' }, input: { width: '100%', boxSizing: 'border-box', border: `1px solid ${DS.colors.border}`, borderRadius: 6, padding: '10px 11px', fontSize: 13, fontFamily: 'inherit', outlineColor: DS.colors.gold, background: '#fff' }, formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: DS.space.md, alignItems: 'end' }, noteForm: { display: 'grid', gridTemplateColumns: '1fr auto', gap: DS.space.md, marginBottom: DS.space.md }, fileInput: { fontSize: 13, marginBottom: DS.space.md },
  buttonPrimary: { border: 0, borderRadius: 8, background: DS.colors.navy, color: '#fff', padding: '10px 13px', fontWeight: 800, cursor: 'pointer' }, buttonAccent: { border: 0, borderRadius: 8, background: DS.colors.gold, color: '#fff', padding: '9px 12px', fontWeight: 800, cursor: 'pointer' }, buttonGhost: { border: `1px solid ${DS.colors.border}`, borderRadius: 8, background: '#fff', color: DS.colors.navy, padding: '10px 12px', fontWeight: 800, cursor: 'pointer' }, buttonTiny: { border: `1px solid ${DS.colors.border}`, borderRadius: 7, background: '#fff', padding: '6px 9px', fontSize: 12, cursor: 'pointer' },
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: DS.space.lg, marginBottom: DS.space.lg }, statCard: { position: 'relative', overflow: 'hidden', background: '#fff', border: `1px solid ${DS.colors.border}`, borderRadius: 10, padding: '18px 20px', boxShadow: DS.shadow, display: 'grid', gap: DS.space.sm }, statStripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 }, statLabel: { color: DS.colors.muted, fontSize: 12, fontWeight: 800, textTransform: 'uppercase' }, statValue: { fontSize: 24 }, dashboardGrid: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, .9fr)', gap: DS.space.lg }, contentGrid: { display: 'grid', gap: DS.space.lg }, matterLayout: { display: 'grid', gridTemplateColumns: '330px minmax(0, 1fr)', gap: DS.space.lg }, matterButton: { width: '100%', display: 'grid', gap: 4, textAlign: 'left', border: 0, borderBottom: `1px solid ${DS.colors.border}`, background: '#fff', padding: '12px 8px', cursor: 'pointer', color: DS.colors.text }, matterButtonActive: { background: '#F8FAFC', boxShadow: `inset 3px 0 0 ${DS.colors.gold}` }, detailStack: { display: 'grid', gap: DS.space.lg }, metaLine: { display: 'flex', flexWrap: 'wrap', gap: DS.space.sm, color: DS.colors.muted, alignItems: 'center' }, pipelineRow: { display: 'grid', gridTemplateColumns: '120px 1fr 30px', gap: DS.space.md, alignItems: 'center', marginBottom: DS.space.md }, pipelineLabel: { color: DS.colors.muted, fontSize: 13 }, pipelineTrack: { height: 9, background: '#EEF2F7', borderRadius: 999, overflow: 'hidden' }, pipelineFill: { height: '100%', background: DS.colors.gold, borderRadius: 999 },
  tableWrap: { overflowX: 'auto', border: `1px solid ${DS.colors.border}`, borderRadius: 10 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 }, th: { textAlign: 'left', padding: '11px 12px', background: '#F3F4F6', color: DS.colors.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0, borderBottom: `1px solid ${DS.colors.border}` }, td: { padding: '11px 12px', borderBottom: `1px solid ${DS.colors.border}`, verticalAlign: 'middle' }, trAlt: { background: '#FAFAFB' }, tableSelect: { border: `1px solid ${DS.colors.border}`, borderRadius: 6, padding: '7px 8px', fontSize: 13 }, inlineLink: { color: DS.colors.navy, fontWeight: 800, textDecoration: 'none' }, badge: { display: 'inline-flex', borderRadius: 999, padding: '4px 9px', fontWeight: 800, fontSize: 12 },
  empty: { minHeight: 130, display: 'grid', placeItems: 'center', textAlign: 'center', color: DS.colors.muted, gap: DS.space.xs }, emptyIcon: { width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 999, background: '#F3F4F6', color: DS.colors.gold, fontWeight: 900 }, skeletonGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: DS.space.lg }, skeletonCard: { height: 120, borderRadius: 10, background: '#fff', border: `1px solid ${DS.colors.border}`, padding: DS.space.lg, display: 'grid', gap: DS.space.sm }, alert: { borderRadius: 8, padding: '10px 12px', fontSize: 13, fontWeight: 700, marginBottom: DS.space.md }, alertDanger: { background: DS.colors.dangerBg, color: DS.colors.danger, border: '1px solid #FECACA' }, alertInfo: { background: DS.colors.infoBg, color: DS.colors.info, border: '1px solid #BFDBFE' }, toast: { position: 'fixed', right: 22, top: 22, zIndex: 1000, minWidth: 280, maxWidth: 420, border: `1px solid ${DS.colors.border}`, borderRadius: 10, padding: '12px 14px', boxShadow: DS.shadow, display: 'flex', justifyContent: 'space-between', gap: DS.space.md, alignItems: 'center' }, toastClose: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontWeight: 900 },
};
