import { useEffect, useMemo, useRef, useState } from 'react';
import { IconLayoutDashboard, IconBriefcase, IconBell, IconFile, IconInvoice, IconUserCircle, IconCalendarEvent } from '@tabler/icons-react';
import { api, deleteMyAvatar, downloadWithAuth, fileToDataUrl, getMyAvatar, uploadMyAvatar } from '../lib/apiClient.js';
import { styles, StyleTag, theme, loadAndApplyFirmTheme } from '../theme.jsx';
import { Badge, Card, Empty, Field, kes, Logo, MeetingLink, Skeleton, statusTone, Table, Toast, isInvoiceOverdue, invoiceDisplayStatus, invoiceDueDistanceText } from '../components/ui.jsx';
import ClientChatWidget from '../components/ClientChatWidget.jsx';
import MatterDocuments from '../components/MatterDocuments.jsx';

const portalIcons = {
  Dashboard: IconLayoutDashboard,
  'My Matters': IconBriefcase,
  Notices: IconBell,
  Documents: IconFile,
  Invoices: IconInvoice,
  Account: IconUserCircle,
  'Court Dates': IconCalendarEvent,
};

const portalNav = ['Dashboard', 'My Matters', 'Notices', 'Documents', 'Invoices', 'Account', 'Court Dates'];
const AVATAR_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const AVATAR_MAX_BYTES = 512 * 1024;

function AvatarCircle({ src, name, size = 30 }) {
  const initial = (name || 'C').slice(0, 1).toUpperCase();
  return (
    <div style={{ ...styles.avatar, width: size, height: size, fontSize: Math.max(12, Math.round(size * 0.38)) }}>
      {src
        ? <img src={src} alt={name || ''} style={styles.avatarImg} />
        : initial}
    </div>
  );
}

function avatarFileError(file) {
  if (!file) return 'Choose a photo first.';
  if (!AVATAR_ALLOWED_MIME.includes(file.type)) return 'Only JPEG, PNG, and WebP images are supported.';
  if (file.size > AVATAR_MAX_BYTES) return 'Image must be 512 KB or smaller.';
  return '';
}

function PortalNavigation({ view, onSelect, onNavigate }) {
  return (
    <nav style={styles.navList}>
      {portalNav.map(label => {
        const PortalIcon = portalIcons[label];
        return (
          <button key={label} type="button" className="lf-nav" onClick={() => { onSelect(label); onNavigate?.(); }} style={{ ...styles.navItem, ...(view === label ? styles.navActive : {}) }}>
            <span style={styles.navNumber}>{PortalIcon ? <PortalIcon size={16} /> : null}</span><span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function noticeFileName(file) {
  return file?.friendlyName || file?.displayName || file?.name || 'Attachment';
}

function noticeFileType(file) {
  return String(file?.type || 'File').slice(0, 4).toUpperCase();
}

function nextEventFor(matter, appearances) {
  return appearances.find(event => event.matterId === matter.id && event.date >= new Date().toISOString().slice(0, 10));
}

// PRODUCT-15M display-only proof-status guidance. Reads existing payment_proofs
// fields only (status / paymentId / reviewNote); it never mutates proof state,
// invoice status, balances or settlement. A populated paymentId means the firm
// has separately recorded a payment — accepted proof alone is NOT settlement.
const proofPromptColor = { green: '#16A34A', blue: '#2563EB', red: '#DC2626', amber: '#6B7280' };
function getProofPrompt(proof) {
  if (!proof) return { title: 'Awaiting review', tone: 'amber', body: 'Proof uploaded — awaiting firm review.' };
  if (proof.paymentId) return { title: 'Payment recorded', tone: 'green', body: 'Payment recorded.' };
  if (proof.status === 'Accepted') return { title: 'Proof accepted', tone: 'blue', body: 'Proof accepted — payment recording pending.' };
  if (proof.status === 'Rejected') return { title: 'Action needed', tone: 'red', body: 'Action needed — see firm note.' };
  return { title: 'Awaiting review', tone: 'amber', body: 'Proof uploaded — awaiting firm review.' };
}

export default function ClientApp({ user, firm, logout, notify, toast, setToast }) {
  const [view, setView] = useState('Dashboard');
  const [dashboard, setDashboard] = useState({ client: null, matters: [], documents: [], invoices: [], appearances: [], notices: [], paymentProofs: [], invoicePayments: [] });
  const [selectedId, setSelectedId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [payment, setPayment] = useState({ invoiceId: '', method: 'M-PESA', reference: '', amount: '', note: '', file: null });
  const [loading, setLoading] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selfHasAvatar, setSelfHasAvatar] = useState(Boolean(user?.hasAvatar));
  const [myAvatarUrl, setMyAvatarUrl] = useState(null);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const myAvatarUrlRef = useRef(null);
  const selected = dashboard.matters.find(m => m.id === selectedId) || dashboard.matters[0];
  const matterDocs = dashboard.documents.filter(d => d.matterId === selected?.id);
  const matterInvoices = dashboard.invoices.filter(i => i.matterId === selected?.id);
  const matterEvents = dashboard.appearances.filter(a => a.matterId === selected?.id);
  const firmName = firm?.name || 'LexFlow Kenya';

  useEffect(() => { load(); loadAndApplyFirmTheme(); }, []);
  useEffect(() => { setSelfHasAvatar(Boolean(user?.hasAvatar)); setAvatarVersion(v => v + 1); }, [user?.id, user?.hasAvatar]);
  useEffect(() => {
    function revokeExisting() {
      if (myAvatarUrlRef.current) {
        URL.revokeObjectURL(myAvatarUrlRef.current);
        myAvatarUrlRef.current = null;
      }
    }
    if (!user?.id || !selfHasAvatar) {
      revokeExisting();
      setMyAvatarUrl(null);
      return undefined;
    }
    let alive = true;
    getMyAvatar().then(url => {
      if (!alive) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      revokeExisting();
      myAvatarUrlRef.current = url;
      setMyAvatarUrl(url);
    });
    return () => { alive = false; revokeExisting(); };
  }, [user?.id, selfHasAvatar, avatarVersion]);
  useEffect(() => { if (selected?.id) setSelectedId(selected.id); }, [selected?.id]);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    function handleEscape(event) {
      if (event.key === 'Escape') setMobileMenuOpen(false);
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [mobileMenuOpen]);

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

  function switchMobileView(next) {
    switchView(next);
    setMobileMenuOpen(false);
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

  async function handleAvatarUpload(file) {
    const error = avatarFileError(file);
    if (error) return notify({ type: 'danger', message: error });
    try {
      const result = await uploadMyAvatar(file);
      setSelfHasAvatar(Boolean(result?.hasAvatar));
      setAvatarVersion(v => v + 1);
      notify({ type: 'success', message: 'Profile photo updated.' });
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    }
  }

  async function handleAvatarRemove() {
    try {
      await deleteMyAvatar();
      setSelfHasAvatar(false);
      setAvatarVersion(v => v + 1);
      notify({ type: 'success', message: 'Profile photo removed.' });
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    }
  }

  return (
    <div className="lf-app-shell" style={{ ...styles.shell, '--lf-primary': firm?.primaryColor || theme.navy800, '--lf-accent': firm?.accentColor || theme.gold }}>
      <StyleTag />
      <aside className="lf-desktop-sidebar" style={styles.sidebar}>
        <div style={styles.brandPanel}>
          <Logo firm={firm} />
          <div><div style={styles.brand}>{firmName}</div><div style={styles.brandSub}>Client portal</div></div>
        </div>
        <div style={styles.sideSectionLabel}>Portal</div>
        <PortalNavigation view={view} onSelect={switchView} />
        <div style={styles.timerCard}>
          <div style={styles.timerTop}>Secure access</div>
          <strong>{dashboard.matters.length} matter{dashboard.matters.length === 1 ? '' : 's'}</strong>
          <span>Your private client workspace</span>
        </div>
        <div style={styles.userCard}>
          <AvatarCircle src={myAvatarUrl} name={user?.fullName || 'Client'} />
          <div style={{ minWidth: 0 }}><div style={styles.userName}>{user?.fullName || 'Client'}</div><div style={styles.userRole}>client</div></div>
          <button type="button" onClick={logout} style={styles.logout}>Exit</button>
        </div>
      </aside>
      {mobileMenuOpen && (
        <div className="lf-mobile-drawer-layer" style={styles.mobileDrawerLayer}>
          <button type="button" aria-label="Close portal navigation menu" title="Close portal navigation menu" style={styles.mobileBackdrop} onClick={() => setMobileMenuOpen(false)} />
          <aside aria-label="Client portal mobile navigation" style={styles.mobileDrawer}>
            <div style={styles.mobileDrawerHead}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <Logo firm={firm} />
                <div style={{ minWidth: 0 }}>
                  <div style={styles.brand}>{firmName}</div>
                  <div style={styles.brandSub}>Client portal</div>
                </div>
              </div>
              <button type="button" aria-label="Close portal navigation menu" title="Close portal navigation menu" onClick={() => setMobileMenuOpen(false)} style={styles.mobileCloseButton}>x</button>
            </div>
            <div style={styles.sideSectionLabel}>Portal</div>
            <PortalNavigation view={view} onSelect={switchMobileView} />
            <div style={styles.timerCard}>
              <div style={styles.timerTop}>Secure access</div>
              <strong>{dashboard.matters.length} matter{dashboard.matters.length === 1 ? '' : 's'}</strong>
              <span>Your private client workspace</span>
            </div>
            <div style={styles.userCard}>
              <AvatarCircle src={myAvatarUrl} name={user?.fullName || 'Client'} />
              <div style={{ minWidth: 0 }}><div style={styles.userName}>{user?.fullName || 'Client'}</div><div style={styles.userRole}>client</div></div>
              <button type="button" onClick={() => { setMobileMenuOpen(false); logout(); }} style={styles.logout}>Exit</button>
            </div>
          </aside>
        </div>
      )}
      <main style={styles.main}>
        <header className="lf-topbar" style={styles.topbar}>
          <div className="lf-topbar-title" style={styles.topbarTitle}>
            <button type="button" className="lf-mobile-only" aria-label="Open portal navigation menu" title="Open portal navigation menu" onClick={() => setMobileMenuOpen(true)} style={styles.mobileMenuButton}>Menu</button>
            <div style={{ minWidth: 0 }}>
              <div style={styles.eyebrow}>{firmName}</div>
              <h1 style={styles.title}>{view}</h1>
              <p style={styles.subtitle}>Your secure matter portal for documents, court dates, invoices and firm notices.</p>
            </div>
          </div>
          <div className="lf-top-actions" style={styles.topActions}>
            {firm?.websiteURL && <a style={styles.ghostButton} href={firm.websiteURL} target="_blank" rel="noopener noreferrer">Visit website</a>}
            <button type="button" onClick={load} disabled={loading} style={styles.ghostButton}>{loading ? 'Refreshing...' : 'Refresh'}</button>
          </div>
        </header>
        {loading && <Skeleton />}
        {!loading && view === 'Dashboard' && <ClientDashboard data={dashboard} stats={stats} user={user} avatarUrl={myAvatarUrl} selectMatter={id => { setSelectedId(id); setView('My Matters'); }} onNavigate={switchView} />}
        {!loading && view === 'My Matters' && (
          <ClientMatterDetail
            matters={dashboard.matters}
            selected={selected}
            setSelectedId={setSelectedId}
            docs={matterDocs}
            invoices={matterInvoices}
            events={matterEvents}
            notices={dashboard.notices}
            proofs={dashboard.paymentProofs.filter(p => p.matterId === selected?.id)}
            invoicePayments={(dashboard.invoicePayments || []).filter(p => p.matterId === selected?.id)}
            uploadDoc={uploadDoc}
            uploading={uploading}
            payment={payment}
            setPayment={setPayment}
            submitPayment={submitPayment}
            notify={notify}
            onNavigate={switchView}
          />
        )}
        {!loading && view === 'Notices' && <Notices notices={dashboard.notices} matters={dashboard.matters} notify={notify} />}
        {!loading && view === 'Documents' && <Documents documents={dashboard.documents} matters={dashboard.matters} notify={notify} />}
        {!loading && view === 'Invoices' && <BillingInvoices data={dashboard} matters={dashboard.matters} firm={firm} notify={notify} selectMatter={id => { setSelectedId(id); setView('My Matters'); }} onNavigate={switchView} />}
        {!loading && view === 'Account' && <Account user={user} client={dashboard.client} firm={firm} matters={dashboard.matters} avatarUrl={myAvatarUrl} hasAvatar={selfHasAvatar} onAvatarUpload={handleAvatarUpload} onAvatarRemove={handleAvatarRemove} onNavigate={switchView} />}
        {!loading && view === 'Court Dates' && <CourtDates appearances={dashboard.appearances} matters={dashboard.matters} />}
      </main>
      <ClientChatWidget firm={firm} matters={dashboard.matters} selectedMatterId={selected?.id || ''} user={user} notify={notify} />
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

function ClientDashboard({ data, stats, user, avatarUrl, selectMatter, onNavigate }) {
  const today = new Date().toISOString().slice(0, 10);
  const nextCourt = data.appearances.filter(a => a.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  const matterForInvoices = data.invoices.length > 0 ? data.matters.find(m => data.invoices.some(i => i.matterId === m.id)) || data.matters[0] : null;
  const identityName = data.client?.name || user?.fullName || 'Client';
  return (
    <div style={styles.pageStack}>
      <section style={{ ...styles.heroCard, background: 'linear-gradient(135deg, #112219, #1A3628)' }}>
        <div><div style={styles.heroKicker}>Client workspace</div><h2>Your matters at a glance.</h2><p>Track active files, court appearances, invoices and documents shared by the firm.</p></div>
        <div style={{ ...styles.heroFigure, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, minWidth: 0 }}>
          <AvatarCircle src={avatarUrl} name={identityName} size={46} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{identityName}</span>
        </div>
      </section>
      <section style={{ background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 14 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>Matter status</h3>
        {data.matters.length > 0 ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 16px', fontSize: 13, lineHeight: 1.8 }}>
              <span>{stats.activeMatters} active matter{stats.activeMatters === 1 ? '' : 's'}</span>
              {nextCourt && <span>Next court: {nextCourt.date}</span>}
              <span>{data.documents.length} document{data.documents.length === 1 ? '' : 's'}</span>
              {stats.unpaidInvoices > 0 && <span>{stats.unpaidInvoices} unpaid invoice{stats.unpaidInvoices === 1 ? '' : 's'}</span>}
              {data.notices.length > 0 && <span>Latest: {data.notices[0].title}</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {data.documents.length > 0 && <button type="button" onClick={() => onNavigate('Documents')} style={styles.tinyButton}>View documents</button>}
              {matterForInvoices && <button type="button" onClick={() => selectMatter(matterForInvoices.id)} style={styles.tinyButton}>View invoices</button>}
              {data.notices.length > 0 && <button type="button" onClick={() => onNavigate('Notices')} style={styles.tinyButton}>View updates</button>}
            </div>
          </>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>Your matter updates will appear here when available.</p>
        )}
      </section>
      <NextActions data={data} selectMatter={selectMatter} onNavigate={onNavigate} />
      <div style={styles.dashStatsGrid}>
        <div style={styles.dashStatCard}>
          <span style={{ ...styles.dashStatTopBar, background: '#1A3628' }} aria-hidden="true" />
          <div style={styles.dashStatHead}><span style={styles.dashStatLabel}>Active matters</span></div>
          <div style={styles.dashStatValue}>{stats.activeMatters}</div>
        </div>
        <div style={styles.dashStatCard}>
          <span style={{ ...styles.dashStatTopBar, background: theme.gold }} aria-hidden="true" />
          <div style={styles.dashStatHead}><span style={styles.dashStatLabel}>Court dates</span></div>
          <div style={styles.dashStatValue}>{stats.upcomingCourt}</div>
        </div>
        <div style={styles.dashStatCard}>
          <span style={{ ...styles.dashStatTopBar, background: theme.green }} aria-hidden="true" />
          <div style={styles.dashStatHead}><span style={styles.dashStatLabel}>Recent docs</span></div>
          <div style={styles.dashStatValue}>{stats.recentDocuments}</div>
        </div>
        <div style={styles.dashStatCard}>
          <span style={{ ...styles.dashStatTopBar, background: theme.red }} aria-hidden="true" />
          <div style={styles.dashStatHead}><span style={styles.dashStatLabel}>Unpaid invoices</span></div>
          <div style={styles.dashStatValue}>{stats.unpaidInvoices}</div>
        </div>
      </div>
      <ActivityTimeline data={data} onNavigate={onNavigate} />
      <section style={{ background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 14 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 600 }}>Updates & messages</h3>
        {data.notices.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, lineHeight: 1.6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', overflow: 'hidden' }}>
              <span style={{ color: '#6B7280', whiteSpace: 'nowrap', flexShrink: 0 }}>Latest update:</span>
              <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.notices[0].title}</span>
              {data.notices[0].createdAt && <span style={{ color: '#9CA3AF', fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}>{data.notices[0].createdAt.slice(0, 10)}</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: '#6B7280', whiteSpace: 'nowrap' }}>Updates on file:</span>
              <span style={{ fontWeight: 500 }}>{data.notices.length} notice{data.notices.length !== 1 ? 's' : ''}</span>
            </div>
            {nextCourt && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', overflow: 'hidden' }}>
                <span style={{ color: '#6B7280', whiteSpace: 'nowrap', flexShrink: 0 }}>Next court:</span>
                <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{nextCourt.date}</span>
                {nextCourt.title && <span style={{ color: '#9CA3AF', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nextCourt.title}</span>}
              </div>
            )}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>No new updates yet.</p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => onNavigate('Notices')} style={styles.tinyButton}>View updates</button>
          {data.documents.length > 0 && <button type="button" onClick={() => onNavigate('Documents')} style={styles.tinyButton}>View documents</button>}
        </div>
      </section>
      <div className="lf-dashboard-grid" style={styles.dashboardGrid}>
        <Card title="My matters" hint="Latest matter status">
          <div className="lf-client-matters-cards"><Table columns={['Matter', 'Stage', 'Next Court', 'Action']} rows={data.matters.map(m => {
            const next = nextEventFor(m, data.appearances);
            return [m.title, <Badge key={m.id} tone="blue">{m.stage || 'Intake'}</Badge>, next?.date || '-', <button key={`${m.id}-view`} type="button" style={styles.tinyButton} onClick={() => selectMatter(m.id)}>View</button>];
          })} empty="No matters have been shared yet." /></div>
        </Card>
        <Card title="Notices" hint="Latest firm updates">
          {data.notices.slice(0, 3).length ? data.notices.slice(0, 3).map(notice => <NoticeItem key={notice.id} notice={notice} />) : <Empty title="No notices" text="Firm notices will appear here." />}
        </Card>
      </div>
    </div>
  );
}

function NextActions({ data, selectMatter, onNavigate }) {
  const today = new Date().toISOString().slice(0, 10);
  const items = [];

  const unpaid = data.invoices.filter(i => i.status !== 'Paid');
  if (unpaid.length > 0) {
    const inv = unpaid[0];
    const matter = data.matters.find(m => data.invoices.some(i => i.matterId === m.id && i.status !== 'Paid'));
    items.push({
      key: 'invoice',
      label: 'Invoice awaiting payment',
      detail: [inv.number, inv.status, inv.amount ? kes(inv.amount) : ''].filter(Boolean).join(' · '),
      action: () => matter ? selectMatter(matter.id) : onNavigate('My Matters'),
      btn: 'View invoice',
    });
  }

  const nextCourt = data.appearances.filter(a => a.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (nextCourt) {
    items.push({
      key: 'court',
      label: 'Upcoming court date',
      detail: [nextCourt.type || nextCourt.title || 'Appearance', nextCourt.date + (nextCourt.time ? ' ' + nextCourt.time : '')].filter(Boolean).join(' · '),
      action: () => onNavigate('My Matters'),
      btn: 'View details',
    });
  }

  const notice = data.notices[0];
  if (notice && items.length < 3) {
    items.push({
      key: 'notice',
      label: 'New update from the firm',
      detail: [notice.title, notice.createdAt ? notice.createdAt.slice(0, 10) : ''].filter(Boolean).join(' · '),
      action: () => onNavigate('Notices'),
      btn: 'View update',
    });
  }

  const doc = data.documents[0];
  if (doc && items.length < 4) {
    items.push({
      key: 'doc',
      label: 'Recently shared document',
      detail: [(doc.displayName || doc.name || 'Document'), doc.createdAt ? doc.createdAt.slice(0, 10) : ''].filter(Boolean).join(' · '),
      action: () => onNavigate('Documents'),
      btn: 'View document',
    });
  }

  return (
    <section style={{ background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 14 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>What needs your attention</h3>
      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>You're up to date. We'll show important actions here when something needs your attention.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map(item => (
            <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', background: theme.wash, borderRadius: 6, fontSize: 13, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                <span style={{ fontWeight: 500, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                <span style={{ color: '#6B7280', fontSize: 12 }}>{item.detail}</span>
              </div>
              <button type="button" style={{ ...styles.tinyButton, flexShrink: 0 }} onClick={item.action}>{item.btn}</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function MatterSnapshot({ selected, events, docs, invoices, notices }) {
  const today = new Date().toISOString().slice(0, 10);
  const nextCourt = events.filter(a => a.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  const matterNotice = notices.find(n => n.matterId === selected?.id);
  const latestDoc = [...docs].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
  const unpaidInv = invoices.filter(i => i.status !== 'Paid')[0];

  const rows = [
    { key: 'court', label: 'Next court date', value: nextCourt ? [nextCourt.type || nextCourt.title || 'Appearance', nextCourt.date, nextCourt.time, nextCourt.location].filter(Boolean).join(' · ') : 'No upcoming court date listed.' },
    { key: 'update', label: 'Latest update', value: matterNotice ? [matterNotice.title, matterNotice.createdAt ? matterNotice.createdAt.slice(0, 10) : ''].filter(Boolean).join(' · ') : 'No recent firm update listed.' },
    { key: 'doc', label: 'Latest document', value: latestDoc ? [(latestDoc.displayName || latestDoc.name || 'Document'), latestDoc.createdAt ? latestDoc.createdAt.slice(0, 10) : ''].filter(Boolean).join(' · ') : 'No recently shared document listed.' },
    { key: 'billing', label: 'Billing position', value: unpaidInv ? [unpaidInv.number || 'Invoice', unpaidInv.status, unpaidInv.amount ? kes(unpaidInv.amount) : ''].filter(Boolean).join(' · ') : 'No outstanding invoice listed.' },
  ];

  return (
    <section style={{ background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 14 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>This matter at a glance</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map(row => (
          <div key={row.key} style={{ display: 'flex', gap: 8, padding: '6px 8px', background: theme.wash, borderRadius: 6, fontSize: 13, lineHeight: 1.5 }}>
            <span style={{ fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0, minWidth: 90, color: '#374151' }}>{row.label}</span>
            <span style={{ color: row.value.startsWith('No ') ? '#9CA3AF' : '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ActivityTimeline({ data, onNavigate }) {
  const today = new Date().toISOString().slice(0, 10);
  const items = [];

  data.notices.forEach(n => {
    items.push({
      type: 'Notice',
      tone: n.audience === 'direct' ? 'amber' : 'blue',
      label: n.title,
      sortKey: n.createdAt || '',
      date: n.createdAt ? n.createdAt.slice(0, 10) : null,
      cue: n.audience === 'direct' ? 'Sent to you' : 'Firm update',
      onAction: () => onNavigate('Notices'),
      actionLabel: 'View',
    });
  });

  data.documents.forEach(d => {
    items.push({
      type: 'Document',
      tone: 'green',
      label: d.displayName || d.name,
      sortKey: d.createdAt || '',
      date: d.createdAt ? d.createdAt.slice(0, 10) : null,
      cue: d.source === 'client' ? 'Shared by you' : 'From firm',
      onAction: () => onNavigate('Documents'),
      actionLabel: 'View',
    });
  });

  data.appearances.forEach(a => {
    items.push({
      type: 'Court date',
      tone: 'amber',
      label: a.title || a.type || 'Appearance',
      sortKey: a.date || '',
      date: a.date || null,
      cue: a.date && a.date >= today ? 'Upcoming' : 'Past hearing',
      onAction: null,
    });
  });

  data.invoices.forEach(i => {
    items.push({
      type: 'Invoice',
      tone: i.status === 'Paid' ? 'green' : 'red',
      label: i.number || 'Invoice',
      sortKey: '',
      date: null,
      cue: i.status || 'Pending',
      onAction: null,
    });
  });

  items.sort((a, b) => {
    if (!a.sortKey && !b.sortKey) return 0;
    if (!a.sortKey) return 1;
    if (!b.sortKey) return -1;
    return b.sortKey.localeCompare(a.sortKey);
  });

  const recent = items.slice(0, 5);

  return (
    <section style={{ background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Recent activity</h3>
      {recent.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>Recent matter activity will appear here when available.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {recent.map((item, idx) => (
            <li key={idx} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', background: theme.wash, borderRadius: 6, fontSize: 13, flexWrap: 'wrap' }}>
              <Badge tone={item.tone}>{item.type}</Badge>
              <div style={{ flex: 1, minWidth: 120, overflow: 'hidden' }}>
                <span style={{ fontWeight: 500, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                <span style={{ color: '#6B7280', fontSize: 12 }}>{item.cue}{item.date ? ` · ${item.date}` : ''}</span>
              </div>
              {item.onAction && (
                <button type="button" style={{ ...styles.tinyButton, flexShrink: 0 }} onClick={item.onAction}>{item.actionLabel}</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ClientMatterDetail({ matters, selected, setSelectedId, docs, invoices, events, notices, proofs, invoicePayments, uploadDoc, uploading, payment, setPayment, submitPayment, notify, onNavigate }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sortOrder, setSortOrder] = useState('newest');

  const statusOptions = useMemo(() => {
    const s = new Set();
    matters.forEach(m => { if (m.stage) s.add(m.stage); if (m.status) s.add(m.status); });
    return [...s].sort();
  }, [matters]);

  const filteredMatters = useMemo(() => {
    let r = [...matters];
    if (statusFilter) r = r.filter(m => (m.stage || m.status) === statusFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter(m => (m.title || '').toLowerCase().includes(q) || (m.reference || '').toLowerCase().includes(q) || (m.stage || '').toLowerCase().includes(q) || (m.status || '').toLowerCase().includes(q) || (m.practiceArea || m.category || m.type || '').toLowerCase().includes(q));
    }
    r.sort((a, b) => {
      const aDate = a.createdAt || a.openedAt || a.updatedAt || a.date || '';
      const bDate = b.createdAt || b.openedAt || b.updatedAt || b.date || '';
      const cmp = aDate.localeCompare(bDate);
      return sortOrder === 'newest' ? -cmp : cmp;
    });
    return r;
  }, [matters, search, statusFilter, sortOrder]);

  if (!selected) return <Empty title="No matter selected" text="Your matter details will appear here once the firm shares a file." />;
  const paymentRows = invoicePayments.map(payment => {
    const invoice = invoices.find(item => item.id === payment.invoiceId);
    const receiptCell = payment.receiptNumber && payment.invoiceId
      ? <DownloadButton key={`${payment.id}-receipt`} label={payment.receiptNumber} path={`/api/invoices/${payment.invoiceId}/payments/${payment.id}/receipt.pdf`} filename={`${payment.receiptNumber}.pdf`} notify={notify} />
      : (payment.receiptNumber || '-');
    return [invoice?.number || payment.invoiceId || '-', payment.date || '-', receiptCell, payment.method || '-', payment.reference || '-', kes(payment.amount)];
  });
  return (
    <div className="lf-matter-grid lf-client-matter-grid" style={styles.matterGrid}>
      <Card title="My matters" hint={`${matters.length} file(s)`}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <input type="search" placeholder="Find a matter…" value={search} onChange={e => setSearch(e.target.value)} style={{ flex: 1, minWidth: 140, padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }} />
          {statusOptions.length > 0 && (
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}>
              <option value="">All matters</option>
              {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <select value={sortOrder} onChange={e => setSortOrder(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
        {matters.length > 0 && (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#6B7280' }}>
            {filteredMatters.length === 0 ? 'No matters match your search or filters.' : `Showing ${filteredMatters.length} of ${matters.length} matter${matters.length === 1 ? '' : 's'}`}
          </p>
        )}
        {filteredMatters.map(m => <button key={m.id} type="button" onClick={() => setSelectedId(m.id)} style={{ ...styles.matterButton, ...(selected.id === m.id ? styles.matterActive : {}) }}><strong>{m.title}</strong><span>{m.reference || m.id}</span><small>{m.stage || 'Intake'}</small></button>)}
      </Card>
      <div style={styles.pageStack}>
        <Card title={selected.title} hint={selected.reference || 'Matter overview'}>
          <div style={styles.clientStatusGrid}><Badge tone="blue">{selected.stage || 'Intake'}</Badge><span>{selected.practiceArea || 'General'}</span><span>{selected.assignedTo || 'Firm team'}</span></div>
          <p style={styles.clientDescription}>{selected.description || 'No public description has been added yet.'}</p>
        </Card>
        <MatterSnapshot selected={selected} events={events} docs={docs} invoices={invoices} notices={notices} />
        <Card title="Court appearances" hint="Virtual court links appear on hearing days">
          <div className="lf-client-events-cards"><Table columns={['Event', 'Date', 'Time', 'Location', 'Virtual Court']} rows={events.map(a => [a.title || a.type || 'Appearance', a.date || '-', a.time || '-', a.location || '-', <MeetingLink key={a.id} event={a} />])} empty="No court dates shared yet." /></div>
        </Card>
        <MatterDocuments matterId={selected.id} clientMode notify={notify} />
        <Card title="Invoices and payment proof" hint="Upload M-PESA or bank transfer confirmation">
          <div className="lf-client-invoices-cards"><Table columns={['Invoice', 'Amount', 'Paid', 'Balance', 'Status', 'PDF']} rows={invoices.map(i => [i.number || i.id, kes(i.amount), kes(i.amountPaid), kes(i.balance), <div key={`${i.id}-status`} style={{ display: 'grid', gap: 3 }}><Badge tone={statusTone(invoiceDisplayStatus(i))}>{invoiceDisplayStatus(i)}</Badge>{invoiceDueDistanceText(i) ? <span style={{ fontSize: 11, color: isInvoiceOverdue(i) ? '#DC2626' : '#6B7280' }}>{invoiceDueDistanceText(i)}</span> : null}</div>, <DownloadButton key={`${i.id}-pdf`} label="PDF" path={`/api/invoices/${i.id}/pdf`} filename={`${i.number || i.id}.pdf`} notify={notify} />])} empty="No invoices shared yet." /></div>
          <div className="lf-client-invoice-payments-cards"><Table columns={['Invoice', 'Date', 'Receipt', 'Method', 'Reference', 'Amount']} rows={paymentRows} empty="No payments recorded yet." /></div>
          <form onSubmit={submitPayment} style={{ ...styles.formGrid, marginTop: 14 }}>
            <Field label="Invoice"><select style={styles.input} value={payment.invoiceId} onChange={e => setPayment({ ...payment, invoiceId: e.target.value })}><option value="">General payment</option>{invoices.map(i => <option key={i.id} value={i.id}>{i.number || i.id}</option>)}</select></Field>
            <Field label="Method"><select style={styles.input} value={payment.method} onChange={e => setPayment({ ...payment, method: e.target.value })}><option>M-PESA</option><option>Bank Transfer</option><option>Cash Deposit</option></select></Field>
            <Field label="Reference"><input required style={styles.input} value={payment.reference} onChange={e => setPayment({ ...payment, reference: e.target.value })} placeholder="M-PESA code or bank ref" /></Field>
            <Field label="Amount"><input type="number" style={styles.input} value={payment.amount} onChange={e => setPayment({ ...payment, amount: e.target.value })} /></Field>
            <Field label="Screenshot"><input type="file" accept="image/*,.pdf" style={styles.input} onChange={e => setPayment({ ...payment, file: e.target.files?.[0] || null })} /></Field>
            <Field label="Note"><input style={styles.input} value={payment.note} onChange={e => setPayment({ ...payment, note: e.target.value })} placeholder="Optional note" /></Field>
            <button style={styles.primaryButton}>Upload proof</button>
          </form>
          <div className="lf-client-proofs-cards"><Table columns={['Reference', 'Method', 'Amount', 'Uploaded', 'Status', 'Review']} rows={proofs.map(p => {
            const prompt = getProofPrompt(p);
            return [
              p.reference,
              p.method,
              kes(p.amount),
              p.createdAt ? new Date(p.createdAt).toLocaleString() : '-',
              <div key={`${p.id}-st`} style={{ display: 'grid', gap: 3 }}><Badge tone={p.paymentId ? 'green' : p.status === 'Accepted' ? 'blue' : p.status === 'Rejected' ? 'red' : 'amber'}>{p.status || 'Pending'}</Badge>{p.reviewedAt ? <span style={{ fontSize: 11, color: '#6B7280' }}>{new Date(p.reviewedAt).toLocaleDateString()}</span> : null}</div>,
              <div key={`${p.id}-rv`} style={{ display: 'grid', gap: 3 }}><span style={{ fontSize: 12, color: proofPromptColor[prompt.tone] || '#6B7280', fontWeight: 500 }}>{prompt.body}</span>{p.status === 'Rejected' && p.reviewNote ? <span style={{ fontSize: 12, color: '#374151' }}>{p.reviewNote}</span> : null}</div>,
            ];
          })} empty="No payment proofs uploaded yet. Use the form above after making payment." /></div>
        </Card>
      </div>
    </div>
  );
}

function Notices({ notices, matters, notify }) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [matterFilter, setMatterFilter] = useState('');
  const [sortOrder, setSortOrder] = useState('newest');

  const typeOptions = useMemo(() => {
    const s = new Set();
    notices.forEach(n => { if (n.audience) s.add(n.audience); });
    return [...s].sort();
  }, [notices]);

  const hasAnyMatterId = useMemo(() => notices.some(n => n.matterId), [notices]);

  const filtered = useMemo(() => {
    let result = [...notices];

    if (typeFilter) {
      result = result.filter(n => n.audience === typeFilter);
    }

    if (matterFilter) {
      result = result.filter(n => n.matterId === matterFilter);
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(n => {
        const title = (n.title || '').toLowerCase();
        const content = (n.content || '').toLowerCase();
        const audience = (n.audience || '').toLowerCase();
        const date = (n.createdAt || '').toLowerCase();
        return title.includes(q) || content.includes(q) || audience.includes(q) || date.includes(q);
      });
    }

    result.sort((a, b) => {
      const aDate = a.createdAt || a.date || a.publishedAt || a.updatedAt || '';
      const bDate = b.createdAt || b.date || b.publishedAt || b.updatedAt || '';
      const cmp = aDate.localeCompare(bDate);
      return sortOrder === 'newest' ? -cmp : cmp;
    });

    return result;
  }, [notices, search, typeFilter, matterFilter, sortOrder]);

  const audienceLabel = val => val === 'direct' ? 'For you' : val === 'broadcast' ? 'Broadcast' : val;

  return (
    <Card title="Firm Notices" hint="Updates and bulletins from the firm">
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Find an update…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 160, padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
        />
        {typeOptions.length > 1 && (
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
          >
            <option value="">All updates</option>
            {typeOptions.map(t => <option key={t} value={t}>{audienceLabel(t)}</option>)}
          </select>
        )}
        {hasAnyMatterId && (
          <select
            value={matterFilter}
            onChange={e => setMatterFilter(e.target.value)}
            style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
          >
            <option value="">All matters</option>
            {matters.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        )}
        <select
          value={sortOrder}
          onChange={e => setSortOrder(e.target.value)}
          style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      {notices.length > 0 && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#6B7280' }}>
          {filtered.length === 0
            ? 'No updates match your search or filters.'
            : `Showing ${filtered.length} of ${notices.length} update${notices.length === 1 ? '' : 's'}`}
        </p>
      )}
      {filtered.length ? <div style={styles.noticeList}>{filtered.map(notice => <NoticeItem key={notice.id} notice={notice} notify={notify} />)}</div> : notices.length === 0 ? <Empty title="No notices" text="The firm has not posted any notices yet." /> : null}
    </Card>
  );
}

function NoticeItem({ notice, notify }) {
  const direct = notice.audience === 'direct';
  return (
    <article style={styles.noticeItem}>
      <div style={styles.noticeItemHeader}>
        <Badge tone={direct ? 'amber' : 'blue'}>{direct ? 'For you' : 'Broadcast'}</Badge>
        <span style={styles.mutedText}>{notice.createdAt ? new Date(notice.createdAt).toLocaleString() : ''}</span>
      </div>
      <h3 style={styles.noticeTitle}>{notice.title}</h3>
      <p style={styles.noticeBody}>{notice.content}</p>
      {!!notice.attachments?.length && (
        <div className="lf-notice-attachment-grid" style={styles.noticeFileGrid}>
          {notice.attachments.map(file => (
            <button key={file.id} type="button" style={{ ...styles.noticeFileLink, width: '100%', cursor: 'pointer', textAlign: 'left' }} title={`Download ${noticeFileName(file)}`} onClick={() => downloadWithNotify(`/api/documents/${file.id}/download`, noticeFileName(file), notify)}>
              <span style={styles.noticeFileIcon}>{noticeFileType(file)}</span>
              <span>{noticeFileName(file)}</span>
              <small style={styles.mutedText}>{file.size || 'Download'}</small>
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

function Documents({ documents, matters, notify }) {
  const [search, setSearch] = useState('');
  const [matterFilter, setMatterFilter] = useState('');
  const [sortOrder, setSortOrder] = useState('newest');

  const filtered = useMemo(() => {
    let result = [...documents];

    if (matterFilter) {
      result = result.filter(d => d.matterId === matterFilter);
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(d => {
        const name = (d.displayName || d.name || '').toLowerCase();
        const matter = matters.find(m => m.id === d.matterId);
        const matterTitle = (matter?.title || '').toLowerCase();
        const dType = (d.type || '').toLowerCase();
        return name.includes(q) || matterTitle.includes(q) || dType.includes(q);
      });
    }

    result.sort((a, b) => {
      const aDate = a.createdAt || a.date || '';
      const bDate = b.createdAt || b.date || '';
      const cmp = aDate.localeCompare(bDate);
      return sortOrder === 'newest' ? -cmp : cmp;
    });

    return result;
  }, [documents, matters, search, matterFilter, sortOrder]);

  const hasFilter = search.trim() || matterFilter;
  const emptyText = documents.length === 0 ? 'No documents shared yet.' : 'No shared documents match your search.';

  return (
    <Card title="All Documents" hint="Files shared across your matters">
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Find a document…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 160, padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
        />
        <select
          value={matterFilter}
          onChange={e => setMatterFilter(e.target.value)}
          style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
        >
          <option value="">All matters</option>
          {matters.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
        <select
          value={sortOrder}
          onChange={e => setSortOrder(e.target.value)}
          style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      {documents.length > 0 && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#6B7280' }}>
          {filtered.length === 0
            ? 'No shared documents match your search.'
            : `Showing ${filtered.length} of ${documents.length} shared document${documents.length === 1 ? '' : 's'}`}
        </p>
      )}
      <div className="lf-client-all-docs-cards">
        <Table
          columns={['Name', 'Matter', 'Source', 'Type', 'Download']}
          rows={filtered.map(d => [
            d.displayName || d.name,
            matters.find(m => m.id === d.matterId)?.title || d.matterId,
            <Badge key={`${d.id}-source`} tone={d.source === 'client' ? 'green' : 'blue'}>{d.source === 'client' ? 'Shared by you' : 'Firm'}</Badge>,
            d.type,
            <DownloadButton key={d.id} label="Download" path={`/api/documents/${d.id}/download`} filename={d.displayName || d.name || 'document'} notify={notify} />
          ])}
          empty={emptyText}
        />
      </div>
    </Card>
  );
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

function Account({ user, client, firm, matters, avatarUrl, hasAvatar, onAvatarUpload, onAvatarRemove, onNavigate }) {
  const activeMatters = matters ? matters.filter(m => !['Closed', 'Archived'].includes(m.stage)) : [];
  const linkedMatters = matters ? matters.slice(0, 3) : [];
  return (
    <div style={styles.pageStack}>
      <Card title="Account details" hint="Your portal identity">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <AvatarCircle src={avatarUrl} name={user?.fullName || 'Client'} size={56} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <label style={{ cursor: 'pointer' }}>
              <span style={{ ...styles.tinyButton, display: 'inline-block' }}>{hasAvatar ? 'Change photo' : 'Upload photo'}</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} onChange={event => { onAvatarUpload(event.target.files?.[0]); event.target.value = ''; }} />
            </label>
            {hasAvatar && <button type="button" style={styles.tinyButton} onClick={onAvatarRemove}>Remove photo</button>}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <Row label="Name" value={user?.fullName} />
          <Row label="Email" value={user?.email} />
          <Row label="Phone" value={client?.phone} />
        </div>
      </Card>
      <Card title="Linked matters" hint={`${matters ? matters.length : 0} file(s)`}>
        {activeMatters.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <p style={{ margin: '0 0 4px', color: '#6B7280' }}>{activeMatters.length} active matter{activeMatters.length === 1 ? '' : 's'} of {matters.length}</p>
            {linkedMatters.map(m => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', background: theme.wash, borderRadius: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 500, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</span>
                  <span style={{ color: '#6B7280', fontSize: 12 }}>{m.stage || 'Intake'}</span>
                </div>
              </div>
            ))}
            {matters.length > 3 && <p style={{ margin: '4px 0 0', color: '#9CA3AF', fontSize: 12 }}>And {matters.length - 3} more matter{matters.length - 3 === 1 ? '' : 's'}</p>}
            <button type="button" onClick={() => onNavigate('My Matters')} style={{ ...styles.tinyButton, alignSelf: 'flex-start' }}>View all matters</button>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>Your matters will appear here when shared by the firm.</p>
        )}
      </Card>
      <Card title="Firm contact" hint={firm?.name || 'LexFlow Kenya'}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <p style={{ margin: '0 0 4px', color: '#6B7280', lineHeight: 1.5 }}>For corrections to your account details or urgent matter updates, contact the firm directly.</p>
          <Row label="Email" value={firm?.email} />
          <Row label="Phone" value={firm?.phone} />
          <Row label="Address" value={firm?.address} />
          {firm?.websiteURL && (
            <div style={{ display: 'flex', gap: 8, padding: '6px 8px', background: theme.wash, borderRadius: 6 }}>
              <span style={{ fontWeight: 500, minWidth: 90, color: '#374151' }}>Website</span>
              <a style={styles.link} href={firm.websiteURL} target="_blank" rel="noopener noreferrer">Open website</a>
            </div>
          )}
        </div>
      </Card>
      <p style={{ margin: 0, fontSize: 12, color: '#9CA3AF', lineHeight: 1.5 }}>For your security, sign out after using LexFlow on a shared device.</p>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '6px 8px', background: theme.wash, borderRadius: 6 }}>
      <span style={{ fontWeight: 500, minWidth: 90, color: '#374151' }}>{label}</span>
      <span style={{ color: value ? '#6B7280' : '#9CA3AF' }}>{value || '-'}</span>
    </div>
  );
}

function CourtDates({ appearances, matters }) {
  const [search, setSearch] = useState('');
  const [timeFilter, setTimeFilter] = useState('upcoming');
  const [matterFilter, setMatterFilter] = useState('');
  const [sortOrder, setSortOrder] = useState('soonest');

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const matterMap = useMemo(() => { const m = {}; matters.forEach(x => { m[x.id] = x; }); return m; }, [matters]);

  const todayCount = useMemo(() => appearances.filter(a => a.date === today).length, [appearances, today]);
  const upcomingCount = useMemo(() => appearances.filter(a => a.date >= today).length, [appearances, today]);
  const pastCount = useMemo(() => appearances.filter(a => a.date < today).length, [appearances, today]);
  const nextCourt = useMemo(() => {
    const upcoming = appearances.filter(a => a.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    return upcoming[0] || null;
  }, [appearances, today]);

  const filtered = useMemo(() => {
    let r = [...appearances];

    if (timeFilter === 'upcoming') r = r.filter(a => (a.date || '') >= today);
    else if (timeFilter === 'past') r = r.filter(a => (a.date || '') < today);
    else if (timeFilter === 'today') r = r.filter(a => a.date === today);

    if (matterFilter) r = r.filter(a => a.matterId === matterFilter);

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter(a => {
        const type = (a.title || a.type || '').toLowerCase();
        const matter = matterMap[a.matterId];
        const matterTitle = (matter?.title || matter?.reference || '').toLowerCase();
        const court = (a.court || '').toLowerCase();
        const location = (a.location || a.venue || '').toLowerCase();
        const status = (a.status || '').toLowerCase();
        const date = (a.date || '').toLowerCase();
        const time = (a.time || '').toLowerCase();
        return type.includes(q) || matterTitle.includes(q) || court.includes(q) || location.includes(q) || status.includes(q) || date.includes(q) || time.includes(q);
      });
    }

    r.sort((a, b) => {
      const aDT = (a.date || '') + 'T' + (a.time || '');
      const bDT = (b.date || '') + 'T' + (b.time || '');
      const cmp = aDT.localeCompare(bDT);
      return sortOrder === 'soonest' ? cmp : -cmp;
    });

    return r;
  }, [appearances, search, timeFilter, matterFilter, sortOrder, today, matterMap]);

  const timeOptions = useMemo(() => {
    const opts = [
      { value: 'upcoming', label: 'Upcoming' },
      { value: 'all', label: 'All dates' },
      { value: 'past', label: 'Past dates' },
    ];
    if (todayCount > 0) opts.push({ value: 'today', label: 'Today' });
    return opts;
  }, [todayCount]);

  return (
    <Card title="Court Dates / Appearances" hint="All court dates across your matters">
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Find a court date…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 160, padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
        />
        <select
          value={timeFilter}
          onChange={e => setTimeFilter(e.target.value)}
          style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
        >
          {timeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {matters.length > 0 && (
          <select
            value={matterFilter}
            onChange={e => setMatterFilter(e.target.value)}
            style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
          >
            <option value="">All matters</option>
            {matters.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        )}
        <select
          value={sortOrder}
          onChange={e => setSortOrder(e.target.value)}
          style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
        >
          <option value="soonest">Soonest first</option>
          <option value="latest">Latest first</option>
        </select>
      </div>
      {appearances.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', fontSize: 13 }}>
          <div style={{ background: theme.wash, borderRadius: 6, padding: '6px 12px', flex: '1 1 auto', minWidth: 80 }}>
            <span style={{ color: '#6B7280', display: 'block', fontSize: 11 }}>Upcoming</span>
            <strong>{upcomingCount}</strong>
          </div>
          {nextCourt && (
            <div style={{ background: theme.wash, borderRadius: 6, padding: '6px 12px', flex: '1 1 auto', minWidth: 120 }}>
              <span style={{ color: '#6B7280', display: 'block', fontSize: 11 }}>Next court date</span>
              <strong style={{ fontSize: 12 }}>{nextCourt.date}{nextCourt.title || nextCourt.type ? ` \u00b7 ${nextCourt.title || nextCourt.type}` : ''}</strong>
            </div>
          )}
          <div style={{ background: theme.wash, borderRadius: 6, padding: '6px 12px', flex: '1 1 auto', minWidth: 80 }}>
            <span style={{ color: '#6B7280', display: 'block', fontSize: 11 }}>Past</span>
            <strong>{pastCount}</strong>
          </div>
        </div>
      )}
      {appearances.length > 0 && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#6B7280' }}>
          {filtered.length === 0
            ? 'No court dates match your search or filters.'
            : `Showing ${filtered.length} of ${appearances.length} court date${appearances.length === 1 ? '' : 's'}`}
        </p>
      )}
      <div className="lf-client-all-events-cards">
        <Table
          columns={['Event', 'Matter', 'Date', 'Time', 'Location', 'Virtual Court']}
          rows={filtered.map(a => [
            a.title || a.type || 'Appearance',
            matterMap[a.matterId]?.title || a.matterId || '-',
            a.date || '-',
            a.time || '-',
            a.location || '-',
            <MeetingLink key={a.id} event={a} />
          ])}
          empty={appearances.length === 0 ? 'No court dates shared yet.' : 'No court dates match your search or filters.'}
        />
      </div>
    </Card>
  );
}

function BillingInvoices({ data, matters, firm, notify, selectMatter, onNavigate }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [matterFilter, setMatterFilter] = useState('');
  const [sortOrder, setSortOrder] = useState('newest');

  const invoices = data.invoices || [];
  const proofs = data.paymentProofs || [];

  const filtered = useMemo(() => {
    let result = [...invoices];

    if (statusFilter) {
      const s = statusFilter;
      result = result.filter(i => {
        const st = (i.status || '').toLowerCase();
        if (s === 'needs-payment') return st !== 'paid' && st !== 'cancelled' && st !== '';
        if (s === 'paid') return st === 'paid';
        // PRODUCT-15F: derived-overdue (unpaid + past due) counts as Overdue here too.
        if (s === 'overdue') return st === 'overdue' || isInvoiceOverdue(i);
        return true;
      });
    }

    if (matterFilter) {
      result = result.filter(i => i.matterId && i.matterId === matterFilter);
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(i => {
        const number = (i.number || i.id || '').toLowerCase();
        const matter = matters.find(m => m.id === i.matterId);
        const matterTitle = (matter?.title || matter?.name || '').toLowerCase();
        const status = (i.status || '').toLowerCase();
        const amount = String(i.amount != null ? i.amount : '');
        return number.includes(q) || matterTitle.includes(q) || status.includes(q) || amount.includes(q);
      });
    }

    result.sort((a, b) => {
      if (sortOrder === 'newest') {
        const aDate = a.createdAt || a.date || '';
        const bDate = b.createdAt || b.date || '';
        return bDate.localeCompare(aDate);
      }
      if (sortOrder === 'oldest') {
        const aDate = a.createdAt || a.date || '';
        const bDate = b.createdAt || b.date || '';
        return aDate.localeCompare(bDate);
      }
      if (sortOrder === 'amount-desc') return (b.amount || 0) - (a.amount || 0);
      if (sortOrder === 'amount-asc') return (a.amount || 0) - (b.amount || 0);
      return 0;
    });

    return result;
  }, [invoices, matters, search, statusFilter, matterFilter, sortOrder]);

  const summary = useMemo(() => {
    const paid = invoices.filter(i => i.status === 'Paid');
    const unpaid = invoices.filter(i => i.status !== 'Paid');
    // PRODUCT-15F: count stored Overdue plus derived-overdue (unpaid + past due).
    const overdue = invoices.filter(i => i.status === 'Overdue' || isInvoiceOverdue(i));
    const totalOutstanding = unpaid.reduce((sum, i) => sum + (Number(i.balance) || Number(i.amount) || 0), 0);
    return { total: invoices.length, paidCount: paid.length, unpaidCount: unpaid.length, overdueCount: overdue.length, totalOutstanding };
  }, [invoices]);

  // PRODUCT-15M display-only guidance. Counts read existing proof status only.
  const proofCounts = useMemo(() => ({
    pending: proofs.filter(p => (p.status || 'Pending') === 'Pending').length,
    rejected: proofs.filter(p => p.status === 'Rejected').length,
    recorded: proofs.filter(p => p.paymentId).length,
  }), [proofs]);
  const paymentInstructions = (firm?.paymentInstructions || '').trim();
  const showGuidance = summary.unpaidCount > 0 || summary.overdueCount > 0 || proofCounts.rejected > 0 || proofCounts.pending > 0 || !!paymentInstructions;

  function goToProofUpload() {
    const target = invoices.find(i => i.matterId && i.status !== 'Paid') || invoices.find(i => i.matterId);
    if (target && target.matterId && selectMatter) selectMatter(target.matterId);
    else onNavigate?.('My Matters');
  }

  const emptyText = invoices.length === 0 ? 'No invoices shared yet.' : 'No invoices match your search or filters.';

  return (
    <Card title="Invoices" hint="Billing across your matters">
      {showGuidance && (
        <section style={{ border: `1px solid ${theme.line}`, borderLeft: `3px solid ${theme.gold}`, borderRadius: 8, padding: 12, marginBottom: 12, background: theme.wash }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>Payment guidance</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 16px', fontSize: 13, lineHeight: 1.7, marginBottom: paymentInstructions ? 8 : 6 }}>
            {summary.unpaidCount > 0 && <span>{summary.unpaidCount} unpaid invoice{summary.unpaidCount === 1 ? '' : 's'}</span>}
            {summary.overdueCount > 0 && <span style={{ color: '#DC2626' }}>{summary.overdueCount} overdue</span>}
            {summary.totalOutstanding > 0 && <span>Balance due: {kes(summary.totalOutstanding)}</span>}
            {proofCounts.pending > 0 && <span>{proofCounts.pending} proof{proofCounts.pending === 1 ? '' : 's'} awaiting review</span>}
            {proofCounts.rejected > 0 && <span style={{ color: '#DC2626' }}>{proofCounts.rejected} proof{proofCounts.rejected === 1 ? ' needs' : 's need'} attention</span>}
          </div>
          {paymentInstructions && (
            <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5, whiteSpace: 'pre-wrap', background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 6, padding: '8px 10px', marginBottom: 8 }}>
              <span style={{ display: 'block', fontWeight: 600, color: '#111827', marginBottom: 2 }}>How to pay</span>
              {paymentInstructions}
            </div>
          )}
          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#6B7280', lineHeight: 1.5 }}>Uploading payment proof does not settle an invoice on its own — the firm reviews and records each payment before it is marked paid.</p>
          <button type="button" onClick={goToProofUpload} style={styles.tinyButton}>Go to payment proof upload</button>
        </section>
      )}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', fontSize: 13 }}>
        <div style={{ background: theme.wash, borderRadius: 6, padding: '6px 12px', flex: '1 1 auto', minWidth: 120 }}>
          <span style={{ color: '#6B7280', display: 'block', fontSize: 11 }}>Outstanding</span>
          <strong>{summary.totalOutstanding > 0 ? kes(summary.totalOutstanding) : 'Kes 0'}</strong>
        </div>
        <div style={{ background: theme.wash, borderRadius: 6, padding: '6px 12px', flex: '1 1 auto', minWidth: 80 }}>
          <span style={{ color: '#6B7280', display: 'block', fontSize: 11 }}>Unpaid</span>
          <strong>{summary.unpaidCount}</strong>
        </div>
        <div style={{ background: theme.wash, borderRadius: 6, padding: '6px 12px', flex: '1 1 auto', minWidth: 80 }}>
          <span style={{ color: '#6B7280', display: 'block', fontSize: 11 }}>Paid</span>
          <strong>{summary.paidCount}</strong>
        </div>
        {summary.overdueCount > 0 && (
          <div style={{ background: '#FEF2F2', borderRadius: 6, padding: '6px 12px', flex: '1 1 auto', minWidth: 80 }}>
            <span style={{ color: '#DC2626', display: 'block', fontSize: 11 }}>Overdue</span>
            <strong style={{ color: '#DC2626' }}>{summary.overdueCount}</strong>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Find an invoice…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 160, padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
        />
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
        >
          <option value="">All invoices</option>
          <option value="needs-payment">Needs payment</option>
          <option value="paid">Paid</option>
          <option value="overdue">Overdue</option>
        </select>
        <select
          value={matterFilter}
          onChange={e => setMatterFilter(e.target.value)}
          style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
        >
          <option value="">All matters</option>
          {matters.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
        <select
          value={sortOrder}
          onChange={e => setSortOrder(e.target.value)}
          style={{ padding: '6px 10px', fontSize: 13, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', outline: 'none' }}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="amount-desc">Amount high to low</option>
          <option value="amount-asc">Amount low to high</option>
        </select>
      </div>
      {invoices.length > 0 && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#6B7280' }}>
          {filtered.length === 0
            ? 'No invoices match your search or filters.'
            : `Showing ${filtered.length} of ${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`}
        </p>
      )}
      <div className="lf-client-all-invoices-cards">
        <Table
          columns={['Invoice', 'Matter', 'Amount', 'Paid', 'Balance', 'Status', 'PDF']}
          rows={filtered.map(i => [
            i.number || i.id,
            matters.find(m => m.id === i.matterId)?.title || i.matterId || '-',
            kes(i.amount),
            kes(i.amountPaid),
            kes(i.balance),
            <div key={`${i.id}-status`} style={{ display: 'grid', gap: 3 }}><Badge tone={statusTone(invoiceDisplayStatus(i))}>{invoiceDisplayStatus(i)}</Badge>{invoiceDueDistanceText(i) ? <span style={{ fontSize: 11, color: isInvoiceOverdue(i) ? '#DC2626' : '#6B7280' }}>{invoiceDueDistanceText(i)}</span> : null}</div>,
            <DownloadButton key={`${i.id}-pdf`} label="PDF" path={`/api/invoices/${i.id}/pdf`} filename={`${i.number || i.id}.pdf`} notify={notify} />
          ])}
          empty={emptyText}
        />
      </div>
    </Card>
  );
}
