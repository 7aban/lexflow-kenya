import { useEffect, useMemo, useState } from 'react';

const API_BASE = 'http://localhost:5000/api';
const COLORS = {
  bg: '#F3F4F6',
  panel: '#FFFFFF',
  border: '#E5E7EB',
  navy: '#1B3A5C',
  gold: '#D4A34A',
  text: '#111827',
  muted: '#6B7280',
  danger: '#B91C1C',
  success: '#047857',
};

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

async function api(path, options = {}) {
  const session = readSession();
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body,
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json().catch(() => ({})) : await response.text();

  if (response.status === 401) clearSession();
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}

function App() {
  const [session, setSession] = useState(readSession);
  const [user, setUser] = useState(session?.user || null);
  const [view, setView] = useState('Dashboard');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [data, setData] = useState({ dashboard: {}, clients: [], matters: [], tasks: [], invoices: [] });

  const isAuthed = Boolean(session?.token);
  const canManage = ['admin', 'advocate'].includes(user?.role);
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    if (!isAuthed) return;
    loadEverything();
  }, [isAuthed]);

  async function loadEverything() {
    setLoading(true);
    setError('');
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
      setError(err.message);
      if (err.message.toLowerCase().includes('auth')) handleLogout();
    } finally {
      setLoading(false);
    }
  }

  function handleLogin(nextSession) {
    saveSession(nextSession);
    setSession(nextSession);
    setUser(nextSession.user || null);
    setNotice('Signed in successfully.');
  }

  function handleLogout() {
    clearSession();
    setSession(null);
    setUser(null);
    setData({ dashboard: {}, clients: [], matters: [], tasks: [], invoices: [] });
  }

  if (!isAuthed) return <LoginPage onLogin={handleLogin} />;

  return (
    <div style={styles.shell}>
      <aside style={styles.sidebar}>
        <div style={styles.brandRow}>
          <div style={styles.logo}>LF</div>
          <div>
            <strong>LexFlow Kenya</strong>
            <small style={styles.sidebarMeta}>{user?.fullName || user?.name || 'Signed in'} · {user?.role || 'user'}</small>
          </div>
        </div>

        {['Dashboard', 'Matters', 'Tasks', 'Invoices', ...(isAdmin ? ['Users'] : [])].map(item => (
          <button key={item} type="button" onClick={() => setView(item)} style={{ ...styles.navButton, ...(view === item ? styles.navButtonActive : {}) }}>
            {item}
          </button>
        ))}

        <button type="button" onClick={handleLogout} style={styles.logoutButton}>Logout</button>
      </aside>

      <main style={styles.main}>
        <header style={styles.header}>
          <div>
            <h1 style={styles.pageTitle}>{view}</h1>
            <p style={styles.subtle}>Kenyan law practice management for matters, time, invoices and clients.</p>
          </div>
          <button type="button" onClick={loadEverything} style={styles.secondaryButton}>{loading ? 'Refreshing...' : 'Refresh'}</button>
        </header>

        {notice && <Banner tone="success" onClose={() => setNotice('')}>{notice}</Banner>}
        {error && <Banner tone="error" onClose={() => setError('')}>{error}</Banner>}

        {view === 'Dashboard' && <Dashboard data={data} />}
        {view === 'Matters' && <Matters data={data} canManage={canManage} onReload={loadEverything} setNotice={setNotice} setError={setError} />}
        {view === 'Tasks' && <Tasks tasks={data.tasks} matters={data.matters} onReload={loadEverything} setNotice={setNotice} setError={setError} />}
        {view === 'Invoices' && <Invoices invoices={data.invoices} isAdmin={isAdmin} onReload={loadEverything} setNotice={setNotice} setError={setError} />}
        {view === 'Users' && isAdmin && <Users setNotice={setNotice} setError={setError} />}
      </main>
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
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Login failed');
      onLogin(data);
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.loginPage}>
      <form onSubmit={submit} style={styles.loginCard}>
        <div style={styles.loginBrand}>
          <div style={styles.logo}>LF</div>
          <div>
            <h1 style={styles.loginTitle}>LexFlow Kenya</h1>
            <p style={styles.loginSubtitle}>Sign in to manage your practice</p>
          </div>
        </div>

        {error && <div style={styles.loginError}>{error}</div>}

        <label style={styles.label}>Email</label>
        <input style={styles.input} value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" />

        <label style={styles.label}>Password</label>
        <input style={styles.input} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" />

        <button type="submit" disabled={busy} style={styles.primaryButton}>{busy ? 'Signing in...' : 'Sign In'}</button>
        <p style={styles.helperText}>Default admin: admin@lexflow.co.ke / admin123</p>
      </form>
    </div>
  );
}

function Dashboard({ data }) {
  const outstanding = data.invoices.filter(invoice => invoice.status === 'Outstanding').reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0);
  return (
    <>
      <div style={styles.statGrid}>
        <Stat label="Active Matters" value={data.dashboard.activeMattersCount ?? data.matters.length} />
        <Stat label="Month Hours" value={Number(data.dashboard.monthHours || 0).toFixed(1)} />
        <Stat label="Month Revenue" value={kes(data.dashboard.monthRevenue)} />
        <Stat label="Outstanding" value={kes(outstanding)} />
      </div>
      <Panel title="Recent Matters">
        {data.matters.slice(0, 6).map(matter => <Item key={matter.id} title={matter.title} meta={`${matter.reference || matter.id} · ${matter.clientName || 'Client pending'} · ${matter.stage || 'Intake'}`} />)}
        {!data.matters.length && <Empty>No matters yet.</Empty>}
      </Panel>
    </>
  );
}

function Matters({ data, canManage, onReload, setNotice, setError }) {
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState({ clientId: '', title: '', practiceArea: '', billingType: 'hourly', billingRate: 15000, fixedFee: 0 });
  const [time, setTime] = useState({ hours: 1, description: '', rate: 15000 });
  const selected = useMemo(() => data.matters.find(matter => matter.id === selectedId) || data.matters[0], [data.matters, selectedId]);

  async function createMatter(event) {
    event.preventDefault();
    try {
      await api('/matters', { method: 'POST', body: form });
      setNotice('Matter created.');
      setForm({ clientId: '', title: '', practiceArea: '', billingType: 'hourly', billingRate: 15000, fixedFee: 0 });
      await onReload();
    } catch (err) { setError(err.message); }
  }

  async function logTime(event) {
    event.preventDefault();
    if (!selected) return;
    try {
      await api('/time-entries', { method: 'POST', body: { ...time, matterId: selected.id } });
      setNotice('Time entry logged.');
      setTime({ hours: 1, description: '', rate: selected.billingRate || 15000 });
      await onReload();
    } catch (err) { setError(err.message); }
  }

  async function generateInvoice(matterId) {
    try {
      const invoice = await api('/invoices/generate', { method: 'POST', body: { matterId } });
      setNotice(`Invoice ${invoice.number || invoice.id} generated.`);
      await onReload();
    } catch (err) { setError(err.message); }
  }

  return (
    <div style={styles.twoColumn}>
      <Panel title="Matter List">
        {data.matters.map(matter => (
          <button key={matter.id} type="button" onClick={() => setSelectedId(matter.id)} style={{ ...styles.listButton, ...(selected?.id === matter.id ? styles.listButtonActive : {}) }}>
            <strong>{matter.title}</strong>
            <span>{matter.reference || matter.id} · {matter.clientName || 'No client'} · {matter.stage || 'Intake'}</span>
          </button>
        ))}
        {!data.matters.length && <Empty>No matters yet.</Empty>}
      </Panel>

      <div>
        {canManage && (
          <Panel title="Create Matter">
            <form onSubmit={createMatter} style={styles.formGrid}>
              <select style={styles.input} value={form.clientId} onChange={event => setForm({ ...form, clientId: event.target.value })} required>
                <option value="">Select client</option>
                {data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
              </select>
              <input style={styles.input} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="Matter title" required />
              <input style={styles.input} value={form.practiceArea} onChange={event => setForm({ ...form, practiceArea: event.target.value })} placeholder="Practice area" />
              <select style={styles.input} value={form.billingType} onChange={event => setForm({ ...form, billingType: event.target.value })}>
                <option value="hourly">Hourly</option>
                <option value="fixed">Fixed fee</option>
              </select>
              <input style={styles.input} type="number" value={form.billingType === 'fixed' ? form.fixedFee : form.billingRate} onChange={event => setForm({ ...form, [form.billingType === 'fixed' ? 'fixedFee' : 'billingRate']: Number(event.target.value) })} placeholder="Rate or fee" />
              <button style={styles.primaryButton}>Create</button>
            </form>
          </Panel>
        )}

        <Panel title={selected ? selected.title : 'Matter Detail'}>
          {selected ? (
            <>
              <p style={styles.subtle}>{selected.reference || selected.id} · {selected.clientName || 'No client'} · {selected.practiceArea || 'General'} · {selected.billingType || 'hourly'}</p>
              <form onSubmit={logTime} style={styles.formGrid}>
                <input style={styles.input} type="number" min="0" step="0.1" value={time.hours} onChange={event => setTime({ ...time, hours: Number(event.target.value) })} placeholder="Hours" />
                <input style={styles.input} value={time.description} onChange={event => setTime({ ...time, description: event.target.value })} placeholder="Work description" />
                <input style={styles.input} type="number" value={time.rate} onChange={event => setTime({ ...time, rate: Number(event.target.value) })} placeholder="Rate" />
                <button style={styles.primaryButton}>Log Time</button>
              </form>
              {canManage && <button type="button" onClick={() => generateInvoice(selected.id)} style={styles.secondaryButton}>Generate Invoice</button>}
            </>
          ) : <Empty>Select or create a matter.</Empty>}
        </Panel>
      </div>
    </div>
  );
}

function Tasks({ tasks, matters, onReload, setNotice, setError }) {
  const [form, setForm] = useState({ matterId: '', title: '', dueDate: '' });
  async function submit(event) {
    event.preventDefault();
    try {
      await api('/tasks', { method: 'POST', body: form });
      setForm({ matterId: '', title: '', dueDate: '' });
      setNotice('Task created.');
      await onReload();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <Panel title="Create Task">
        <form onSubmit={submit} style={styles.formGrid}>
          <select style={styles.input} value={form.matterId} onChange={event => setForm({ ...form, matterId: event.target.value })} required>
            <option value="">Select matter</option>
            {matters.map(matter => <option key={matter.id} value={matter.id}>{matter.title}</option>)}
          </select>
          <input style={styles.input} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="Task title" required />
          <input style={styles.input} type="date" value={form.dueDate} onChange={event => setForm({ ...form, dueDate: event.target.value })} />
          <button style={styles.primaryButton}>Create</button>
        </form>
      </Panel>
      <Panel title="Tasks">
        {tasks.map(task => <Item key={task.id} title={task.title} meta={`${task.dueDate || 'No due date'} · ${task.completed ? 'Done' : 'Open'}`} />)}
        {!tasks.length && <Empty>No tasks yet.</Empty>}
      </Panel>
    </>
  );
}

function Invoices({ invoices, isAdmin, onReload, setNotice, setError }) {
  async function updateStatus(id, status) {
    try {
      await api(`/invoices/${id}/status`, { method: 'PATCH', body: { status } });
      setNotice('Invoice status updated.');
      await onReload();
    } catch (err) { setError(err.message); }
  }

  return (
    <Panel title="Invoices">
      {invoices.map(invoice => (
        <div key={invoice.id} style={styles.invoiceRow}>
          <div>
            <strong>{invoice.number || invoice.id}</strong>
            <span>{invoice.clientName || 'Client'} · {invoice.matterTitle || 'Matter'} · {kes(invoice.amount)} · {invoice.status}</span>
          </div>
          <div style={styles.actions}>
            <a style={styles.linkButton} href={`${API_BASE}/invoices/${invoice.id}/pdf?token=${encodeURIComponent(readSession()?.token || '')}`} target="_blank" rel="noreferrer">PDF</a>
            {isAdmin && <select style={styles.inputCompact} value={invoice.status} onChange={event => updateStatus(invoice.id, event.target.value)}><option>Outstanding</option><option>Paid</option><option>Overdue</option></select>}
          </div>
        </div>
      ))}
      {!invoices.length && <Empty>No invoices yet.</Empty>}
    </Panel>
  );
}

function Users({ setNotice, setError }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ email: '', password: '', fullName: '', role: 'assistant' });

  useEffect(() => { loadUsers(); }, []);

  async function loadUsers() {
    try { setUsers(await api('/auth/users')); }
    catch (err) { setError(err.message); }
  }

  async function submit(event) {
    event.preventDefault();
    try {
      await api('/auth/register', { method: 'POST', body: form });
      setForm({ email: '', password: '', fullName: '', role: 'assistant' });
      setNotice('User created.');
      await loadUsers();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <Panel title="Create User">
        <form onSubmit={submit} style={styles.formGrid}>
          <input style={styles.input} value={form.fullName} onChange={event => setForm({ ...form, fullName: event.target.value })} placeholder="Full name" required />
          <input style={styles.input} value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} placeholder="Email" required />
          <input style={styles.input} type="password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} placeholder="Password" required />
          <select style={styles.input} value={form.role} onChange={event => setForm({ ...form, role: event.target.value })}><option value="assistant">Assistant</option><option value="advocate">Advocate</option><option value="admin">Admin</option></select>
          <button style={styles.primaryButton}>Create</button>
        </form>
      </Panel>
      <Panel title="Users">
        {users.map(user => <Item key={user.id} title={user.fullName} meta={`${user.email} · ${user.role}`} />)}
        {!users.length && <Empty>No users found.</Empty>}
      </Panel>
    </>
  );
}

function Stat({ label, value }) {
  return <div style={styles.stat}><span>{label}</span><strong>{value}</strong></div>;
}

function Panel({ title, children }) {
  return <section style={styles.panel}><h2 style={styles.panelTitle}>{title}</h2>{children}</section>;
}

function Item({ title, meta }) {
  return <div style={styles.item}><strong>{title}</strong><span>{meta}</span></div>;
}

function Empty({ children }) {
  return <p style={styles.subtle}>{children}</p>;
}

function Banner({ children, tone, onClose }) {
  const isError = tone === 'error';
  return <div style={{ ...styles.banner, ...(isError ? styles.bannerError : styles.bannerSuccess) }}><span>{children}</span><button type="button" onClick={onClose} style={styles.bannerClose}>x</button></div>;
}

function kes(value) {
  return `KSh ${Number(value || 0).toLocaleString('en-KE')}`;
}

const styles = {
  shell: { minHeight: '100vh', display: 'flex', background: COLORS.bg, color: COLORS.text, fontFamily: 'Inter, Segoe UI, system-ui, sans-serif' },
  sidebar: { width: 250, padding: 18, background: COLORS.navy, color: '#fff', display: 'flex', flexDirection: 'column', gap: 10 },
  brandRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 },
  logo: { width: 40, height: 40, borderRadius: 8, background: COLORS.gold, color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 800 },
  sidebarMeta: { display: 'block', color: '#D1D5DB', fontSize: 12, marginTop: 2 },
  navButton: { border: 0, borderRadius: 7, padding: '10px 12px', textAlign: 'left', background: 'transparent', color: '#D1D5DB', cursor: 'pointer', fontWeight: 700 },
  navButtonActive: { background: 'rgba(255,255,255,0.14)', color: '#fff' },
  logoutButton: { marginTop: 'auto', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 7, padding: '10px 12px', background: 'transparent', color: '#fff', cursor: 'pointer' },
  main: { flex: 1, padding: 24, minWidth: 0 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 18 },
  pageTitle: { margin: 0, fontSize: 26 },
  subtle: { color: COLORS.muted, margin: '4px 0 0', lineHeight: 1.5 },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 16 },
  stat: { background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, display: 'grid', gap: 8 },
  panel: { background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, marginBottom: 16 },
  panelTitle: { margin: '0 0 12px', fontSize: 17 },
  twoColumn: { display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)', gap: 16 },
  listButton: { width: '100%', display: 'grid', gap: 4, textAlign: 'left', border: 0, borderBottom: `1px solid ${COLORS.border}`, background: '#fff', padding: '10px 6px', cursor: 'pointer' },
  listButtonActive: { background: '#F8FAFC' },
  item: { display: 'grid', gap: 4, padding: '10px 0', borderBottom: `1px solid ${COLORS.border}` },
  invoiceRow: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: `1px solid ${COLORS.border}` },
  actions: { display: 'flex', alignItems: 'center', gap: 8 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, alignItems: 'center' },
  input: { width: '100%', boxSizing: 'border-box', border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: '10px 11px', font: 'inherit', background: '#fff' },
  inputCompact: { border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: '8px 9px', font: 'inherit', background: '#fff' },
  primaryButton: { border: 0, borderRadius: 7, padding: '10px 12px', background: COLORS.navy, color: '#fff', fontWeight: 800, cursor: 'pointer' },
  secondaryButton: { border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: '10px 12px', background: '#fff', color: COLORS.navy, fontWeight: 800, cursor: 'pointer' },
  linkButton: { borderRadius: 7, padding: '8px 10px', background: COLORS.navy, color: '#fff', textDecoration: 'none', fontWeight: 800, fontSize: 13 },
  banner: { display: 'flex', justifyContent: 'space-between', gap: 12, borderRadius: 8, padding: '10px 12px', marginBottom: 14, fontWeight: 700 },
  bannerSuccess: { background: '#ECFDF5', color: COLORS.success, border: '1px solid #A7F3D0' },
  bannerError: { background: '#FEF2F2', color: COLORS.danger, border: '1px solid #FECACA' },
  bannerClose: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontWeight: 800 },
  loginPage: { minHeight: '100vh', background: COLORS.bg, display: 'grid', placeItems: 'center', padding: 24, fontFamily: 'Inter, Segoe UI, system-ui, sans-serif' },
  loginCard: { width: 390, maxWidth: '100%', boxSizing: 'border-box', background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 24 },
  loginBrand: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 },
  loginTitle: { margin: 0, fontSize: 19 },
  loginSubtitle: { margin: '2px 0 0', color: COLORS.muted, fontSize: 13 },
  label: { display: 'block', margin: '12px 0 6px', color: COLORS.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' },
  loginError: { padding: '9px 11px', borderRadius: 7, background: '#FEF2F2', color: COLORS.danger, border: '1px solid #FECACA', fontSize: 13, marginBottom: 12 },
  helperText: { color: COLORS.muted, fontSize: 12, margin: '12px 0 0' },
};

export default App;
