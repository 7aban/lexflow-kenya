import { useEffect, useMemo, useState } from 'react';
import Login from './components/Login';
import Toast from './components/Toast';
import {
  apiUrl,
  createCaseNote,
  createClient,
  createMatter,
  createTask,
  createTimeEntry,
  deleteDocument,
  deleteUser,
  downloadInvoicePdf,
  generateInvoice,
  getClients,
  getCurrentUser,
  getDashboard,
  getInvoices,
  getMatter,
  getMatters,
  getTasks,
  getUsers,
  globalSearch,
  register,
  sendMpesaStk,
  sendWhatsAppReminders,
  updateInvoiceStatus,
  updateMatterStatus,
  updateTask,
  uploadMatterDocument,
} from './api';

const tabs = ['Dashboard', 'Matters', 'Tasks', 'Reports', 'Settings', 'Users'];
const stages = ['Intake', 'Pleadings', 'Discovery', 'Hearing', 'Judgment', 'Appeal', 'Closed'];
const C = { ink: '#111827', muted: '#6B7280', line: '#E5E7EB', navy: '#1B3A5C', gold: '#D4A34A', bg: '#F7F8FA', card: '#FFFFFF', red: '#B91C1C', green: '#047857' };
const blankMatter = { clientId: '', title: '', practiceArea: '', assignedTo: '', billingType: 'hourly', billingRate: 15000, fixedFee: 0 };
const roleCanBill = user => ['advocate', 'admin'].includes(user?.role);
const roleCanAdmin = user => user?.role === 'admin';

export default function App() {
  const stored = safeJson(localStorage.getItem('lexflowSession'));
  const [session, setSession] = useState(stored);
  const [user, setUser] = useState(stored?.user || null);
  const [view, setView] = useState('Dashboard');
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dashboard, setDashboard] = useState({});
  const [clients, setClients] = useState([]);
  const [matters, setMatters] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [users, setUsers] = useState([]);
  const [selectedMatterId, setSelectedMatterId] = useState('');
  const [selectedMatter, setSelectedMatter] = useState(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);

  const notify = (message, type = 'success') => setToast({ message, type });
  const logout = () => { localStorage.removeItem('lexflowSession'); localStorage.removeItem('lexflowToken'); setSession(null); setUser(null); setSelectedMatter(null); };
  const onLogin = nextSession => { localStorage.setItem('lexflowSession', JSON.stringify(nextSession)); localStorage.setItem('lexflowToken', nextSession.token); setSession(nextSession); setUser(nextSession.user); notify('Signed in successfully'); };

  useEffect(() => {
    const unauthorized = () => { logout(); setToast({ type: 'error', message: 'Your session expired. Please sign in again.' }); };
    window.addEventListener('lexflow:unauthorized', unauthorized);
    return () => window.removeEventListener('lexflow:unauthorized', unauthorized);
  }, []);

  useEffect(() => { if (session?.token) bootstrap(); }, [session?.token]);
  useEffect(() => { if (selectedMatterId) loadMatter(selectedMatterId); }, [selectedMatterId]);
  useEffect(() => {
    if (!search.trim()) return setResults([]);
    const id = setTimeout(() => globalSearch(search).then(setResults).catch(() => setResults([])), 250);
    return () => clearTimeout(id);
  }, [search]);

  async function bootstrap() {
    setBusy(true);
    try {
      const current = await getCurrentUser();
      setUser(current);
      await Promise.all([loadDashboard(), loadClients(), loadMatters(), loadTasks(), loadInvoices(), roleCanAdmin(current) ? loadUsers() : Promise.resolve()]);
    } catch (err) { notify(err.message, 'error'); }
    finally { setBusy(false); }
  }
  const loadDashboard = async () => setDashboard(await getDashboard());
  const loadClients = async () => setClients(await getClients());
  const loadMatters = async () => setMatters(await getMatters());
  const loadTasks = async () => setTasks(await getTasks());
  const loadInvoices = async () => setInvoices(await getInvoices());
  const loadUsers = async () => setUsers(await getUsers());
  const loadMatter = async id => { const m = await getMatter(id); setSelectedMatter(m); };

  if (!session?.token) return <><Login onLogin={onLogin} /><Toast toast={toast} onClose={() => setToast(null)} /></>;

  const visibleTabs = tabs.filter(t => (t !== 'Users' || roleCanAdmin(user)) && (user?.role !== 'assistant' || ['Dashboard', 'Matters', 'Tasks'].includes(t)));

  return <div style={styles.shell}>
    <aside style={styles.sidebar}>
      <div style={styles.logo}><span style={styles.logoMark}>LF</span><div><strong>LexFlow Kenya</strong><small>{user?.fullName || user?.name} · {user?.role}</small></div></div>
      <nav>{visibleTabs.map(t => <button key={t} onClick={() => setView(t)} style={{ ...styles.nav, ...(view === t ? styles.navActive : {}) }}>{t}</button>)}</nav>
      <button onClick={logout} style={styles.logout}>Logout</button>
    </aside>
    <main style={styles.main}>
      <header style={styles.topbar}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search matters and clients" style={styles.search} />
          {!!results.length && <div style={styles.searchMenu}>{results.map(r => <button key={`${r.type}-${r.id}`} style={styles.searchItem} onClick={() => { if (r.matterId) { setSelectedMatterId(r.matterId); setView('Matters'); } setSearch(''); setResults([]); }}><strong>{r.title}</strong><span>{r.type} · {r.subtitle}</span></button>)}</div>}
        </div>
        {busy && <span style={styles.muted}>Loading...</span>}
      </header>
      {view === 'Dashboard' && <Dashboard dashboard={dashboard} matters={matters} invoices={invoices} />}
      {view === 'Matters' && <Matters user={user} clients={clients} matters={matters} selectedMatter={selectedMatter} setSelectedMatterId={setSelectedMatterId} refresh={async () => { await loadMatters(); if (selectedMatterId) await loadMatter(selectedMatterId); }} notify={notify} />}
      {view === 'Tasks' && <Tasks tasks={tasks} matters={matters} refresh={loadTasks} notify={notify} />}
      {view === 'Reports' && <Reports user={user} invoices={invoices} refresh={loadInvoices} notify={notify} />}
      {view === 'Settings' && <Settings notify={notify} />}
      {view === 'Users' && roleCanAdmin(user) && <Users users={users} refresh={loadUsers} notify={notify} />}
    </main>
    <Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
}

function Dashboard({ dashboard, matters, invoices }) {
  const outstanding = invoices.filter(i => i.status === 'Outstanding').reduce((s, i) => s + Number(i.amount || 0), 0);
  return <section><h1>Dashboard</h1><div style={styles.grid4}>
    <Stat label="Active Matters" value={dashboard.activeMattersCount || matters.length} />
    <Stat label="Month Hours" value={Number(dashboard.monthHours || 0).toFixed(1)} />
    <Stat label="Month Revenue" value={kes(dashboard.monthRevenue)} />
    <Stat label="Outstanding" value={kes(outstanding)} />
  </div><Panel title="Upcoming Court Dates">{(dashboard.upcomingEvents || []).map(e => <Row key={e.id} title={e.title} meta={`${e.date} ${e.time || ''}`} />)}{!(dashboard.upcomingEvents || []).length && <Empty text="No upcoming dates." />}</Panel></section>;
}
function Stat({ label, value }) { return <div style={styles.stat}><span>{label}</span><strong>{value}</strong></div>; }

function Matters({ user, clients, matters, selectedMatter, setSelectedMatterId, refresh, notify }) {
  const [form, setForm] = useState(blankMatter);
  const [time, setTime] = useState({ hours: 1, description: '', rate: 15000 });
  const [note, setNote] = useState('');
  const [task, setTask] = useState('');
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const canManage = roleCanBill(user);
  const unbilled = (selectedMatter?.timeEntries || []).filter(t => !t.billed);
  const hasOutstanding = (selectedMatter?.invoices || []).some(i => i.status === 'Outstanding');
  const canGenerateInvoice = canManage && selectedMatter && !hasOutstanding && ((selectedMatter.billingType === 'fixed' && Number(selectedMatter.fixedFee) > 0) || unbilled.length > 0);

  async function submitMatter(e) { e.preventDefault(); await createMatter(form); setForm(blankMatter); await refresh(); notify('Matter created'); }
  async function changeStage(stage) { await updateMatterStatus(selectedMatter.id, { stage }); await refresh(); notify('Matter stage updated'); }
  async function logTime(e) { e.preventDefault(); await createTimeEntry({ ...time, matterId: selectedMatter.id, attorney: user.fullName || user.name, rate: time.rate || selectedMatter.billingRate }); setTime({ hours: 1, description: '', rate: selectedMatter.billingRate || 15000 }); await refresh(); notify('Time logged'); }
  async function addNote(e) { e.preventDefault(); await createCaseNote(selectedMatter.id, { content: note, author: user.fullName || user.name }); setNote(''); await refresh(); notify('Note saved'); }
  async function addTask(e) { e.preventDefault(); await createTask({ matterId: selectedMatter.id, title: task }); setTask(''); await refresh(); notify('Task added'); }
  async function uploadDoc(e) { const file = e.target.files?.[0]; if (!file) return; await uploadMatterDocument(selectedMatter.id, file); await refresh(); notify('Document uploaded'); e.target.value = ''; }
  async function makeInvoice() { if (!window.confirm('Generate an invoice for this matter now?')) return; setInvoiceBusy(true); try { const invoice = await generateInvoice(selectedMatter.id); await refresh(); notify(`Invoice ${invoice.number || invoice.id} generated`); } catch (err) { notify(err.message, 'error'); } finally { setInvoiceBusy(false); } }

  return <section><div style={styles.split}>
    <div><h1>Matters</h1><Panel title="Matter List">{matters.map(m => <button key={m.id} style={styles.listButton} onClick={() => setSelectedMatterId(m.id)}><strong>{m.reference || m.id}</strong><span>{m.title} · {m.clientName || ''}</span></button>)}</Panel>{canManage && <Panel title="Create Matter"><form onSubmit={submitMatter} style={styles.formGrid}><Select value={form.clientId} onChange={clientId => setForm({ ...form, clientId })} options={clients.map(c => [c.id, c.name])} placeholder="Client" /><Input value={form.title} onChange={title => setForm({ ...form, title })} placeholder="Title" /><Input value={form.practiceArea} onChange={practiceArea => setForm({ ...form, practiceArea })} placeholder="Practice area" /><Select value={form.billingType} onChange={billingType => setForm({ ...form, billingType })} options={[['hourly', 'Hourly'], ['fixed', 'Fixed fee']]} /><Input type="number" value={form.billingType === 'fixed' ? form.fixedFee : form.billingRate} onChange={v => setForm({ ...form, [form.billingType === 'fixed' ? 'fixedFee' : 'billingRate']: Number(v) })} placeholder="Amount/rate" /><button style={styles.primary}>Create</button></form></Panel>}</div>
    <div>{selectedMatter ? <Panel title={`${selectedMatter.reference || ''} ${selectedMatter.title}`}>{canManage && <div style={styles.inline}>{stages.map(s => <button key={s} onClick={() => changeStage(s)} disabled={selectedMatter.stage === s} style={selectedMatter.stage === s ? styles.pillActive : styles.pill}>{s}</button>)}</div>}<p style={styles.muted}>{selectedMatter.clientName} · {selectedMatter.practiceArea} · {selectedMatter.billingType}</p>
      <h3>Time & Billing</h3><form onSubmit={logTime} style={styles.formGrid}><Input type="number" value={time.hours} onChange={hours => setTime({ ...time, hours })} placeholder="Hours" /><Input value={time.description} onChange={description => setTime({ ...time, description })} placeholder="Description" /><Input type="number" value={time.rate} onChange={rate => setTime({ ...time, rate })} placeholder="Rate" /><button style={styles.primary}>Log Time</button></form>
      <div style={styles.table}>{(selectedMatter.timeEntries || []).map(t => <Row key={t.id} title={t.description || t.activity} meta={`${t.date} · ${t.hours}h · ${kes(Number(t.hours || 0) * Number(t.rate || 0))} · ${t.billed ? 'Billed' : 'Unbilled'}`} />)}</div>
      {canGenerateInvoice && <button onClick={makeInvoice} disabled={invoiceBusy} style={styles.primary}>{invoiceBusy ? 'Generating...' : 'Generate Invoice'}</button>}
      <h3>Invoice History</h3>{(selectedMatter.invoices || []).map(i => <Row key={i.id} title={`${i.number || i.id} · ${kes(i.amount)}`} meta={`${i.date} · due ${i.dueDate} · ${i.status}`} action={<button style={styles.link} onClick={() => downloadInvoicePdf(i.id, `${i.number || i.id}.pdf`)}>Download PDF</button>} />)}
      <h3>Documents</h3>{canManage && <input type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={uploadDoc} />}{(selectedMatter.documents || []).map(d => <Row key={d.id} title={d.name} meta={`${d.type} · ${d.size}`} action={<span><a style={styles.link} href={apiUrl(`/api/documents/${d.id}/download`)}>Download</a>{canManage && <button style={styles.dangerLink} onClick={async () => { await deleteDocument(d.id); await refresh(); notify('Document deleted'); }}>Delete</button>}</span>} />)}
      <h3>Tasks</h3><form onSubmit={addTask} style={styles.inline}><Input value={task} onChange={setTask} placeholder="Task title" /><button style={styles.primary}>Add</button></form>{(selectedMatter.tasks || []).map(t => <Row key={t.id} title={t.title} meta={t.completed ? 'Completed' : 'Open'} />)}
      <h3>Case Notes</h3><form onSubmit={addNote} style={styles.inline}><Input value={note} onChange={setNote} placeholder="Add note" /><button style={styles.primary}>Save</button></form>{(selectedMatter.notes || []).map(n => <Row key={n.id} title={n.content} meta={`${n.author} · ${new Date(n.createdAt).toLocaleString()}`} />)}</Panel> : <Panel title="Matter Detail"><Empty text="Select a matter to view details." /></Panel>}</div>
  </div></section>;
}

function Tasks({ tasks, matters, refresh, notify }) {
  const [form, setForm] = useState({ matterId: '', title: '', dueDate: '' });
  async function submit(e) { e.preventDefault(); await createTask(form); setForm({ matterId: '', title: '', dueDate: '' }); await refresh(); notify('Task created'); }
  return <section><h1>Tasks</h1><Panel title="Create Task"><form onSubmit={submit} style={styles.formGrid}><Select value={form.matterId} onChange={matterId => setForm({ ...form, matterId })} options={matters.map(m => [m.id, m.title])} placeholder="Matter" /><Input value={form.title} onChange={title => setForm({ ...form, title })} placeholder="Title" /><Input type="date" value={form.dueDate} onChange={dueDate => setForm({ ...form, dueDate })} /><button style={styles.primary}>Create</button></form></Panel><Panel title="Open Tasks">{tasks.map(t => <Row key={t.id} title={t.title} meta={t.dueDate || 'No due date'} action={<button style={styles.link} onClick={async () => { await updateTask(t.id, { completed: !t.completed }); await refresh(); notify('Task updated'); }}>{t.completed ? 'Reopen' : 'Complete'}</button>} />)}</Panel></section>;
}

function Reports({ user, invoices, refresh, notify }) {
  async function setStatus(id, status) { await updateInvoiceStatus(id, status); await refresh(); notify('Invoice updated'); }
  return <section><h1>Reports</h1><Panel title="Invoices">{invoices.map(i => <Row key={i.id} title={`${i.number || i.id} · ${i.clientName || ''}`} meta={`${i.matterTitle || ''} · ${kes(i.amount)} · ${i.status}`} action={<span><button style={styles.link} onClick={() => downloadInvoicePdf(i.id, `${i.number || i.id}.pdf`)}>PDF</button>{roleCanAdmin(user) && <select value={i.status} onChange={e => setStatus(i.id, e.target.value)} style={styles.selectSmall}><option>Outstanding</option><option>Paid</option><option>Overdue</option></select>}</span>} />)}</Panel><Panel title="Exports"><a style={styles.primaryLink} href={apiUrl('/api/exports/lsk.pdf')}>LSK PDF</a><a style={styles.primaryLink} href={apiUrl('/api/exports/lsk.xls')}>LSK Excel</a><a style={styles.primaryLink} href={apiUrl('/api/exports/itax.pdf')}>iTax PDF</a><a style={styles.primaryLink} href={apiUrl('/api/exports/itax.xls')}>iTax Excel</a></Panel></section>;
}

function Settings({ notify }) {
  return <section><h1>Settings</h1><Panel title="Integrations"><button style={styles.primary} onClick={async () => { await sendWhatsAppReminders({ days: 3 }); notify('WhatsApp reminders queued'); }}>Queue WhatsApp Reminders</button><button style={styles.primary} onClick={async () => { await sendMpesaStk({ phone: '254700000000', amount: 1 }); notify('M-PESA STK push queued'); }}>Test M-PESA STK</button></Panel></section>;
}

function Users({ users, refresh, notify }) {
  const [form, setForm] = useState({ email: '', password: '', fullName: '', role: 'assistant' });
  async function submit(e) { e.preventDefault(); await register(form); setForm({ email: '', password: '', fullName: '', role: 'assistant' }); await refresh(); notify('User created'); }
  return <section><h1>User Management</h1><Panel title="Create User"><form onSubmit={submit} style={styles.formGrid}><Input value={form.fullName} onChange={fullName => setForm({ ...form, fullName })} placeholder="Full name" /><Input value={form.email} onChange={email => setForm({ ...form, email })} placeholder="Email" /><Input type="password" value={form.password} onChange={password => setForm({ ...form, password })} placeholder="Password" /><Select value={form.role} onChange={role => setForm({ ...form, role })} options={[['assistant', 'Assistant'], ['advocate', 'Advocate'], ['admin', 'Admin']]} /><button style={styles.primary}>Create</button></form></Panel><Panel title="Users">{users.map(u => <Row key={u.id} title={u.fullName} meta={`${u.email} · ${u.role}`} action={<button style={styles.dangerLink} onClick={async () => { await deleteUser(u.id); await refresh(); notify('User deleted'); }}>Delete</button>} />)}</Panel></section>;
}

function Panel({ title, children }) { return <div style={styles.panel}><h2>{title}</h2>{children}</div>; }
function Row({ title, meta, action }) { return <div style={styles.row}><div><strong>{title}</strong><span>{meta}</span></div>{action}</div>; }
function Empty({ text }) { return <p style={styles.muted}>{text}</p>; }
function Input({ value, onChange, type = 'text', placeholder = '' }) { return <input type={type} value={value || ''} placeholder={placeholder} onChange={e => onChange(e.target.value)} style={styles.input} />; }
function Select({ value, onChange, options, placeholder }) { return <select value={value || ''} onChange={e => onChange(e.target.value)} style={styles.input}>{placeholder && <option value="">{placeholder}</option>}{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>; }
function kes(n) { return `KSh ${Number(n || 0).toLocaleString('en-KE')}`; }
function safeJson(v) { try { return JSON.parse(v || 'null'); } catch { return null; } }

const styles = {
  shell: { display: 'flex', minHeight: '100vh', background: C.bg, color: C.ink, fontFamily: 'Inter, Segoe UI, system-ui, sans-serif' },
  sidebar: { width: 245, background: C.navy, color: '#fff', padding: 18, display: 'flex', flexDirection: 'column', gap: 16 },
  logo: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }, logoMark: { width: 36, height: 36, background: C.gold, borderRadius: 7, display: 'grid', placeItems: 'center', fontWeight: 800 },
  nav: { width: '100%', textAlign: 'left', padding: '10px 12px', border: 0, borderRadius: 6, background: 'transparent', color: '#D1D5DB', cursor: 'pointer' }, navActive: { background: 'rgba(255,255,255,.14)', color: '#fff' }, logout: { marginTop: 'auto', padding: 10, border: '1px solid rgba(255,255,255,.25)', borderRadius: 6, background: 'transparent', color: '#fff' },
  main: { flex: 1, padding: 24, overflow: 'auto' }, topbar: { display: 'flex', gap: 16, alignItems: 'center', marginBottom: 18 }, search: { width: '100%', padding: '11px 12px', border: `1px solid ${C.line}`, borderRadius: 7 }, searchMenu: { position: 'absolute', top: 44, left: 0, right: 0, background: '#fff', border: `1px solid ${C.line}`, borderRadius: 7, zIndex: 5, boxShadow: '0 10px 30px rgba(17,24,39,.12)' }, searchItem: { display: 'block', width: '100%', textAlign: 'left', padding: 10, border: 0, borderBottom: `1px solid ${C.line}`, background: '#fff' },
  split: { display: 'grid', gridTemplateColumns: '360px minmax(0,1fr)', gap: 18 }, grid4: { display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 14 }, stat: { background: '#fff', border: `1px solid ${C.line}`, borderRadius: 8, padding: 16 }, panel: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16, marginBottom: 16 }, row: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: `1px solid ${C.line}` }, listButton: { display: 'block', width: '100%', textAlign: 'left', padding: 10, border: 0, borderBottom: `1px solid ${C.line}`, background: '#fff', cursor: 'pointer' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, alignItems: 'center' }, inline: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, input: { padding: '9px 10px', border: `1px solid ${C.line}`, borderRadius: 6, font: 'inherit', minWidth: 0 }, primary: { border: 0, borderRadius: 6, background: C.navy, color: '#fff', padding: '9px 12px', fontWeight: 700, cursor: 'pointer' }, pill: { border: `1px solid ${C.line}`, borderRadius: 999, padding: '6px 10px', background: '#fff' }, pillActive: { border: `1px solid ${C.gold}`, borderRadius: 999, padding: '6px 10px', background: '#FFF7E6' },
  link: { border: 0, background: 'transparent', color: C.navy, fontWeight: 700, cursor: 'pointer', marginLeft: 8 }, dangerLink: { border: 0, background: 'transparent', color: C.red, fontWeight: 700, cursor: 'pointer', marginLeft: 8 }, primaryLink: { display: 'inline-block', marginRight: 10, marginBottom: 10, borderRadius: 6, padding: '9px 12px', background: C.navy, color: '#fff', textDecoration: 'none', fontWeight: 700 }, muted: { color: C.muted }, table: { marginTop: 8 }, selectSmall: { marginLeft: 8, padding: 6, borderRadius: 6, border: `1px solid ${C.line}` }
};
