import { useEffect, useMemo, useState } from 'react';
import { API_BASE, api, fileToDataUrl, readSession } from '../lib/apiClient.js';
import { styles, StyleTag, theme } from '../theme.jsx';
import { Badge, Card, Empty, Field, kes, Logo, MeetingLink, Skeleton, Stat, statusTone, Table, Toast } from '../components/ui.jsx';
import ClientChatWidget from '../components/ClientChatWidget.jsx';
import MatterDocuments from '../components/MatterDocuments.jsx';

const portalNav = [
  ['Dashboard', 'DB'],
  ['My Matters', 'MT'],
  ['Notices', 'NT'],
  ['Documents', 'DC'],
  ['Account', 'AC'],
];

function tokenQuery() {
  return encodeURIComponent(readSession()?.token || '');
}

function nextEventFor(matter, appearances) {
  return appearances.find(event => event.matterId === matter.id && event.date >= new Date().toISOString().slice(0, 10));
}

export default function ClientApp({ user, firm, logout, notify, toast, setToast }) {
  const [view, setView] = useState('Dashboard');
  const [dashboard, setDashboard] = useState({ client: null, matters: [], documents: [], invoices: [], appearances: [], notices: [], paymentProofs: [] });
  const [selectedId, setSelectedId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [payment, setPayment] = useState({ invoiceId: '', method: 'M-PESA', reference: '', amount: '', note: '', file: null });
  const [loading, setLoading] = useState(true);
  const selected = dashboard.matters.find(m => m.id === selectedId) || dashboard.matters[0];
  const matterDocs = dashboard.documents.filter(d => d.matterId === selected?.id);
  const matterInvoices = dashboard.invoices.filter(i => i.matterId === selected?.id);
  const matterEvents = dashboard.appearances.filter(a => a.matterId === selected?.id);
  const firmName = firm?.name || 'LexFlow Kenya';

  useEffect(() => { load(); }, []);
  useEffect(() => { if (selected?.id) setSelectedId(selected.id); }, [selected?.id]);

  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      activeMatters: dashboard.matters.filter(m => !['Closed', 'Archived'].includes(m.stage)).length,
      upcomingCourt: dashboard.appearances.filter(a => a.date >= today).length,
      recentDocuments: dashboard.documents.slice(0, 10).length,
      unpaidInvoices: dashboard.invoices.filter(i => i.status !== 'Paid').length,
    };
  }, [dashboard]);

  async function load() {
    setLoading(true);
    try { setDashboard(await api('/client/dashboard')); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
    finally { setLoading(false); }
  }

  function switchView(next) {
    setView(next);
    if (next === 'Dashboard') load();
  }

  async function uploadDoc(event) {
    const file = event.target.files?.[0];
    if (!file || !selected) return;
    setUploading(true);
    try {
      await api(`/matters/${selected.id}/documents`, { method: 'POST', body: { name: file.name, mimeType: file.type || 'application/octet-stream', data: await fileToDataUrl(file) } });
      event.target.value = '';
      notify({ type: 'success', message: 'Document shared with the firm.' });
      await load();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
    finally { setUploading(false); }
  }

  async function submitPayment(event) {
    event.preventDefault();
    if (!selected || !payment.reference.trim()) return;
    try {
      await api('/payment-proofs', {
        method: 'POST',
        body: {
          invoiceId: payment.invoiceId,
          matterId: selected.id,
          method: payment.method,
          reference: payment.reference,
          amount: payment.amount,
          note: payment.note,
          fileName: payment.file?.name || '',
          mimeType: payment.file?.type || '',
          data: payment.file ? await fileToDataUrl(payment.file) : '',
        },
      });
      setPayment({ invoiceId: '', method: 'M-PESA', reference: '', amount: '', note: '', file: null });
      notify({ type: 'success', message: 'Payment proof uploaded.' });
      await load();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  return (
    <div className="lf-app-shell" style={{ ...styles.shell, '--lf-primary': firm?.primaryColor || theme.navy800, '--lf-accent': firm?.accentColor || theme.gold }}>
      <StyleTag />
      <aside style={styles.sidebar}>
        <div style={styles.brandPanel}>
          <Logo firm={firm} />
          <div><div style={styles.brand}>{firmName}</div><div style={styles.brandSub}>Client portal</div></div>
        </div>
        <div style={styles.sideSectionLabel}>Portal</div>
        <nav style={styles.navList}>
          {portalNav.map(([label, code]) => (
            <button key={label} type="button" className="lf-nav" onClick={() => switchView(label)} style={{ ...styles.navItem, ...(view === label ? styles.navActive : {}) }}>
              <span style={styles.navNumber}>{code}</span><span>{label}</span>
            </button>
          ))}
        </nav>
        <div style={styles.timerCard}>
          <div style={styles.timerTop}>Secure access</div>
          <strong>{dashboard.matters.length} matter{dashboard.matters.length === 1 ? '' : 's'}</strong>
          <span>Your private client workspace</span>
        </div>
        <div style={styles.userCard}>
          <div style={styles.avatar}>{(user?.fullName || 'C').slice(0, 1).toUpperCase()}</div>
          <div style={{ minWidth: 0 }}><div style={styles.userName}>{user?.fullName || 'Client'}</div><div style={styles.userRole}>client</div></div>
          <button type="button" onClick={logout} style={styles.logout}>Exit</button>
        </div>
      </aside>
      <main style={styles.main}>
        <header style={styles.topbar}>
          <div>
            <div style={styles.eyebrow}>{firmName}</div>
            <h1 style={styles.title}>{view}</h1>
            <p style={styles.subtitle}>Your secure matter portal for documents, court dates, invoices and firm notices.</p>
          </div>
          <div style={styles.topActions}>
            {firm?.websiteURL && <a style={styles.ghostButton} href={firm.websiteURL} target="_blank" rel="noopener noreferrer">Visit website</a>}
            <button type="button" onClick={load} disabled={loading} style={styles.ghostButton}>{loading ? 'Refreshing...' : 'Refresh'}</button>
          </div>
        </header>
        {loading && <Skeleton />}
        {!loading && view === 'Dashboard' && <ClientDashboard data={dashboard} stats={stats} selectMatter={id => { setSelectedId(id); setView('My Matters'); }} />}
        {!loading && view === 'My Matters' && (
          <ClientMatterDetail
            matters={dashboard.matters}
            selected={selected}
            setSelectedId={setSelectedId}
            docs={matterDocs}
            invoices={matterInvoices}
            events={matterEvents}
            proofs={dashboard.paymentProofs.filter(p => p.matterId === selected?.id)}
            uploadDoc={uploadDoc}
            uploading={uploading}
            payment={payment}
            setPayment={setPayment}
            submitPayment={submitPayment}
            notify={notify}
          />
        )}
        {!loading && view === 'Notices' && <Notices notices={dashboard.notices} />}
        {!loading && view === 'Documents' && <Documents documents={dashboard.documents} matters={dashboard.matters} />}
        {!loading && view === 'Account' && <Account user={user} client={dashboard.client} firm={firm} />}
      </main>
      <ClientChatWidget firm={firm} matters={dashboard.matters} selectedMatterId={selected?.id || ''} user={user} notify={notify} />
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

function ClientDashboard({ data, stats, selectMatter }) {
  return (
    <div style={styles.pageStack}>
      <section style={styles.heroCard}>
        <div><div style={styles.heroKicker}>Client workspace</div><h2>Your matters at a glance.</h2><p>Track active files, court appearances, invoices and documents shared by the firm.</p></div>
        <div style={styles.heroFigure}>{data.client?.name || 'Client'}</div>
      </section>
      <div style={styles.statsGrid}>
        <Stat label="Active matters" value={stats.activeMatters} tone="navy" />
        <Stat label="Court dates" value={stats.upcomingCourt} tone="gold" />
        <Stat label="Recent docs" value={stats.recentDocuments} tone="green" />
        <Stat label="Unpaid invoices" value={stats.unpaidInvoices} tone="red" />
      </div>
      <div style={styles.dashboardGrid}>
        <Card title="My matters" hint="Latest matter status">
          <Table columns={['Matter', 'Stage', 'Next Court', 'Action']} rows={data.matters.map(m => {
            const next = nextEventFor(m, data.appearances);
            return [m.title, <Badge key={m.id} tone="blue">{m.stage || 'Intake'}</Badge>, next?.date || '-', <button key={`${m.id}-view`} type="button" style={styles.tinyButton} onClick={() => selectMatter(m.id)}>View</button>];
          })} empty="No matters have been shared yet." />
        </Card>
        <Card title="Notices" hint="Latest firm updates">
          {data.notices.slice(0, 3).length ? data.notices.slice(0, 3).map(notice => <NoticeItem key={notice.id} notice={notice} />) : <Empty title="No notices" text="Firm notices will appear here." />}
        </Card>
      </div>
    </div>
  );
}

function ClientMatterDetail({ matters, selected, setSelectedId, docs, invoices, events, proofs, uploadDoc, uploading, payment, setPayment, submitPayment, notify }) {
  if (!selected) return <Empty title="No matter selected" text="Your matter details will appear here once the firm shares a file." />;
  return (
    <div style={styles.matterGrid}>
      <Card title="My matters" hint={`${matters.length} file(s)`}>
        {matters.map(m => <button key={m.id} type="button" onClick={() => setSelectedId(m.id)} style={{ ...styles.matterButton, ...(selected.id === m.id ? styles.matterActive : {}) }}><strong>{m.title}</strong><span>{m.reference || m.id}</span><small>{m.stage || 'Intake'}</small></button>)}
      </Card>
      <div style={styles.pageStack}>
        <Card title={selected.title} hint={selected.reference || 'Matter overview'}>
          <div style={styles.clientStatusGrid}><Badge tone="blue">{selected.stage || 'Intake'}</Badge><span>{selected.practiceArea || 'General'}</span><span>{selected.assignedTo || 'Firm team'}</span></div>
          <p style={styles.clientDescription}>{selected.description || 'No public description has been added yet.'}</p>
        </Card>
        <Card title="Court appearances" hint="Virtual court links appear on hearing days">
          <Table columns={['Event', 'Date', 'Time', 'Location', 'Virtual Court']} rows={events.map(a => [a.title || a.type || 'Appearance', a.date || '-', a.time || '-', a.location || '-', <MeetingLink key={a.id} event={a} />])} empty="No court dates shared yet." />
        </Card>
        <MatterDocuments matterId={selected.id} clientMode notify={notify} />
        <Card title="Invoices and payment proof" hint="Upload M-PESA or bank transfer confirmation">
          <Table columns={['Invoice', 'Amount', 'Status', 'PDF']} rows={invoices.map(i => [i.number || i.id, kes(i.amount), <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <a key={`${i.id}-pdf`} style={styles.link} href={`${API_BASE}/invoices/${i.id}/pdf?token=${tokenQuery()}`}>PDF</a>])} empty="No invoices shared yet." />
          <form onSubmit={submitPayment} style={{ ...styles.formGrid, marginTop: 14 }}>
            <Field label="Invoice"><select style={styles.input} value={payment.invoiceId} onChange={e => setPayment({ ...payment, invoiceId: e.target.value })}><option value="">General payment</option>{invoices.map(i => <option key={i.id} value={i.id}>{i.number || i.id}</option>)}</select></Field>
            <Field label="Method"><select style={styles.input} value={payment.method} onChange={e => setPayment({ ...payment, method: e.target.value })}><option>M-PESA</option><option>Bank Transfer</option><option>Cash Deposit</option></select></Field>
            <Field label="Reference"><input required style={styles.input} value={payment.reference} onChange={e => setPayment({ ...payment, reference: e.target.value })} placeholder="M-PESA code or bank ref" /></Field>
            <Field label="Amount"><input type="number" style={styles.input} value={payment.amount} onChange={e => setPayment({ ...payment, amount: e.target.value })} /></Field>
            <Field label="Screenshot"><input type="file" accept="image/*,.pdf" style={styles.input} onChange={e => setPayment({ ...payment, file: e.target.files?.[0] || null })} /></Field>
            <Field label="Note"><input style={styles.input} value={payment.note} onChange={e => setPayment({ ...payment, note: e.target.value })} placeholder="Optional note" /></Field>
            <button style={styles.primaryButton}>Upload proof</button>
          </form>
          <Table columns={['Reference', 'Method', 'Amount', 'Uploaded']} rows={proofs.map(p => [p.reference, p.method, kes(p.amount), p.createdAt ? new Date(p.createdAt).toLocaleString() : '-'])} empty="No payment proof uploaded yet." />
        </Card>
      </div>
    </div>
  );
}

function Notices({ notices }) {
  return <Card title="Firm Notices" hint="Updates and bulletins from the firm">{notices.length ? notices.map(notice => <NoticeItem key={notice.id} notice={notice} />) : <Empty title="No notices" text="The firm has not posted any notices yet." />}</Card>;
}

function NoticeItem({ notice }) {
  return <div style={{ padding: '12px 0', borderBottom: `1px solid ${theme.line}` }}><strong>{notice.title}</strong><p>{notice.content}</p><span style={styles.mutedText}>{notice.createdAt ? new Date(notice.createdAt).toLocaleString() : ''}</span></div>;
}

function Documents({ documents, matters }) {
  return <Card title="All Documents" hint="Files shared across your matters"><Table columns={['Name', 'Matter', 'Source', 'Type', 'Download']} rows={documents.map(d => [d.name, matters.find(m => m.id === d.matterId)?.title || d.matterId, <Badge key={`${d.id}-source`} tone={d.source === 'client' ? 'green' : 'blue'}>{d.source === 'client' ? 'Shared by you' : 'Firm'}</Badge>, d.type, <a key={d.id} style={styles.link} href={`${API_BASE}/documents/${d.id}/download?token=${tokenQuery()}`}>Download</a>])} empty="No documents shared yet." /></Card>;
}

function Account({ user, client, firm }) {
  return <div style={styles.dashboardGrid}><Card title="Account" hint="Portal identity"><Table columns={['Field', 'Value']} rows={[['Name', user?.fullName || '-'], ['Email', user?.email || '-'], ['Linked client', client?.name || '-'], ['Phone', client?.phone || '-']]} empty="No account details." /></Card><Card title="Firm Contact" hint={firm?.name || 'Firm'}><Table columns={['Field', 'Value']} rows={[['Email', firm?.email || '-'], ['Phone', firm?.phone || '-'], ['Address', firm?.address || '-'], ['Website', firm?.websiteURL ? <a style={styles.link} href={firm.websiteURL} target="_blank" rel="noopener noreferrer">Open website</a> : '-']]} empty="No firm details." /></Card></div>;
}
