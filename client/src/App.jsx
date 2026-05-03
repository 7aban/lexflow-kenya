import { useEffect, useRef, useState } from 'react';
import { api, API_BASE, AUTH_FAILURE_MESSAGE, clearSession, getNotifications, markNotificationsRead, readSession, saveSession } from './lib/apiClient.js';
import { globalSearch } from './api.js';
import { defaultFirmSettings, styles, StyleTag, theme } from './theme.jsx';
import { Logo, Skeleton, Toast } from './components/ui.jsx';
import LoginPage from './components/LoginPage.jsx';
import AcceptInvitation from './views/AcceptInvitation.jsx';
import AdvocatePerformance from './views/AdvocatePerformance.jsx';
import AuditLog from './views/AuditLog.jsx';
import ClientApp from './views/ClientApp.jsx';
import Communications from './views/Communications.jsx';
import DeadlineCenter from './views/DeadlineCenter.jsx';
import Invitations from './views/Invitations.jsx';
import { Clients, Dashboard, FirmSettings, Invoices, Matters, Tasks, Users } from './views/StaffViews.jsx';

const initialData = { dashboard: {}, clients: [], matters: [], tasks: [], invoices: [], firmSettings: defaultFirmSettings };
const navGroups = [
  { title: 'Dashboard', items: [['Dashboard', 'OV', ['admin', 'advocate', 'assistant']], ['Performance', 'PF', ['admin']]] },
  { title: 'Clients', items: [['Clients', 'CL', ['admin', 'advocate', 'assistant']], ['Invitations', 'IV', ['admin']]] },
  { title: 'Matters', items: [['Matters', 'MT', ['admin', 'advocate', 'assistant']]] },
  { title: 'Work', items: [['Tasks', 'TK', ['admin', 'advocate', 'assistant']], ['Deadlines', 'DL', ['admin', 'advocate', 'assistant']]] },
  { title: 'Finance', items: [['Invoices', 'IN', ['admin']]] },
  { title: 'Communications', items: [['Communications', 'CM', ['admin', 'advocate', 'assistant']]] },
  { title: 'Administration', items: [['Users', 'US', ['admin']], ['Firm Settings', 'FS', ['admin']], ['Audit Log', 'AL', ['admin']]] },
];
const legalResources = [
  ['eFiling CTS Judiciary', 'https://efiling.court.go.ke/auth', 'CT'],
  ['eCitizen', 'https://www.ecitizen.go.ke', 'EC'],
  ['Ardhi Sasa', 'https://ardhisasa.lands.go.ke/home', 'AS'],
];

function allowedNavGroups(role) {
  return navGroups
    .map(group => ({ ...group, items: group.items.filter(([, , roles]) => !roles || roles.includes(role)) }))
    .filter(group => group.items.length);
}

function defaultNavGroup(role) {
  return allowedNavGroups(role)[0]?.title || 'Dashboard';
}

function readOpenNavGroup(role) {
  try {
    return localStorage.getItem('lexflowOpenNavGroup') || defaultNavGroup(role);
  } catch {
    return defaultNavGroup(role);
  }
}

export default function App() {
  const [session, setSession] = useState(readSession);
  const [user, setUser] = useState(session?.user || null);
  const [view, setView] = useState('Dashboard');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);
  const [quickLinksOpen, setQuickLinksOpen] = useState(true);
  const [openNavGroup, setOpenNavGroup] = useState(() => readOpenNavGroup(session?.user?.role || 'assistant'));
  const [notifications, setNotifications] = useState([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [matterFocus, setMatterFocus] = useState(null);
  const [communicationFocus, setCommunicationFocus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [data, setData] = useState(initialData);

  const authenticated = Boolean(session?.token);
  const isAdmin = user?.role === 'admin';
  const canManage = ['admin', 'advocate'].includes(user?.role);
  const firm = data.firmSettings || defaultFirmSettings;
  const role = user?.role || 'assistant';
  const visibleGroups = allowedNavGroups(role);
  const visibleViews = visibleGroups.flatMap(group => group.items.map(([label]) => label));

  useEffect(() => {
    async function loadPublicFirmSettings() {
      try {
        const response = await fetch(`${API_BASE}/firm-settings`);
        if (!response.ok) return;
        const firmSettings = await response.json();
        setData(current => ({ ...current, firmSettings }));
      } catch {
        // Keep the default LexFlow branding if public settings are unavailable.
      }
    }
    loadPublicFirmSettings();
  }, []);

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

  useEffect(() => {
    if (!authenticated || user?.role === 'client') return undefined;
    loadNotifications();
    const timer = window.setInterval(loadNotifications, 60000);
    return () => window.clearInterval(timer);
  }, [authenticated, user?.role]);

  useEffect(() => {
    document.title = firm?.name || 'LexFlow Kenya';
  }, [firm?.name]);

  useEffect(() => {
    if (!user || user.role === 'client') return;
    if (!visibleViews.includes(view)) setView('Dashboard');
    const activeGroup = visibleGroups.find(group => group.items.some(([label]) => label === view));
    if (activeGroup) setOpenNavGroup(activeGroup.title);
  }, [user?.role, view]);

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchOpen(false);
      return;
    }
    setSearchLoading(true);
    setSearchOpen(true);
    const timer = setTimeout(async () => {
      try {
        const results = await globalSearch(trimmed);
        setSearchResults(results || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!searchOpen) return;
    function handleClickOutside(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        setSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [searchOpen]);

  async function refresh() {
    setLoading(true);
    try {
      const [currentUser, firmSettings] = await Promise.all([api('/auth/me'), api('/firm-settings')]);
      setUser(currentUser);
      if (currentUser.role === 'client') {
        setData(current => ({ ...current, firmSettings }));
        return;
      }
      const [dashboard, clients, matters, tasks, invoices] = await Promise.all([
        api('/dashboard'),
        api('/clients'),
        api('/matters'),
        api('/tasks'),
        api('/invoices'),
      ]);
      setData({ dashboard, clients, matters, tasks, invoices, firmSettings });
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

  async function loadNotifications() {
    try { setNotifications(await getNotifications()); }
    catch { /* Notifications should never block the workspace. */ }
  }

  function acceptInvitationLogin(sessionData) {
    saveSession(sessionData);
    setSession(sessionData);
    setUser(sessionData.user || null);
    setToast({ type: 'success', message: 'Your client portal is ready.' });
  }

  function logout() {
    clearSession();
    setSession(null);
    setUser(null);
    setData(initialData);
  }

  if (window.location.pathname.startsWith('/invite/')) {
    return (
      <>
        <AcceptInvitation firm={firm} onAccepted={acceptInvitationLogin} />
        <Toast toast={toast} onClose={() => setToast(null)} />
      </>
    );
  }

  async function openNotification(notification) {
    setNotificationsOpen(false);
    if (notification.matterId) {
      setMatterFocus({ matterId: notification.matterId, tab: 'Case notes', ts: Date.now() });
      setCommunicationFocus({ matterId: notification.matterId, clientId: notification.clientId || '', ts: Date.now() });
      setView('Communications');
      setNotifications(current => current.filter(item => item.matterId !== notification.matterId));
      try { await markNotificationsRead({ matterId: notification.matterId }); }
      catch { /* Keep navigation responsive even if read marking fails. */ }
    } else if (notification.clientId) {
      setCommunicationFocus({ matterId: '', clientId: notification.clientId, ts: Date.now() });
      setView('Communications');
      setNotifications(current => current.filter(item => item.id !== notification.id));
      try { await markNotificationsRead({ id: notification.id }); }
      catch { /* Keep navigation responsive even if read marking fails. */ }
    }
  }

  if (!authenticated) {
    return (
      <>
        <LoginPage firm={firm} onLogin={login} />
        <Toast toast={toast} onClose={() => setToast(null)} />
      </>
    );
  }

  if (user?.role === 'client') {
    return <ClientApp user={user} firm={firm} logout={logout} notify={setToast} toast={toast} setToast={setToast} />;
  }

  const subtitles = {
    Dashboard: 'Command center for active work, hearings, billing and firm movement.',
    Clients: 'A polished directory for intake, contacts and relationship context.',
    Matters: 'Matter pipeline, billing, documents, notes and invoice actions.',
    Tasks: 'Daily execution board for deadlines and delegated legal work.',
    Deadlines: 'Court, client, internal and statutory obligations in one timeline.',
    Communications: 'Client messages, secure attachments and portal activity in one inbox.',
    Invoices: 'Receivables, invoice status and PDF export for client billing.',
    Performance: 'Managing partner view of advocate output, workload and court attendance.',
    'Firm Settings': 'Client-ready branding, invoice identity and contact details.',
    Users: 'Role-based access for advocates, assistants and administrators.',
    Invitations: 'Secure client portal onboarding links and invitation status.',
    'Audit Log': 'A secure activity trail for important changes and accountability.',
  };

  return (
    <div className="lf-app-shell" style={{ ...styles.shell, '--lf-primary': firm.primaryColor || theme.navy800, '--lf-accent': firm.accentColor || theme.gold }}>
      <StyleTag />
      <aside style={styles.sidebar}>
        <div style={styles.brandPanel}>
          <Logo firm={firm} />
          <div>
            <div style={styles.brand}>{firm.name || 'LexFlow Kenya'}</div>
            <div style={styles.brandSub}>Practice suite</div>
          </div>
        </div>

        <div style={styles.sideSectionLabel}>Workspace</div>
        <nav style={styles.navList}>
          {visibleGroups.map(group => (
            <div key={group.title} style={styles.navGroup}>
              <button
                type="button"
                className="lf-nav-group"
                onClick={() => {
                  const next = openNavGroup === group.title ? '' : group.title;
                  setOpenNavGroup(next);
                  try { localStorage.setItem('lexflowOpenNavGroup', next); } catch {}
                }}
                style={styles.navGroupButton}
                aria-expanded={openNavGroup === group.title}
              >
                <span>{group.title}</span>
                <span style={styles.navGroupChevron}>{openNavGroup === group.title ? 'v' : '>'}</span>
              </button>
              {openNavGroup === group.title && (
                <div style={styles.navGroupItems}>
                  {group.items.map(([label, number]) => (
                    <button key={label} type="button" className="lf-nav" onClick={() => setView(label)} style={{ ...styles.navItem, ...(view === label ? styles.navActive : {}) }}>
                      <span style={styles.navNumber}>{number}</span>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>

        <div style={styles.quickLinksPanel}>
          <button type="button" className="lf-quick-toggle" onClick={() => setQuickLinksOpen(open => !open)} style={styles.quickLinksHeader} aria-expanded={quickLinksOpen}>
            <span>Legal Resources</span>
            <span style={styles.quickLinksChevron}>{quickLinksOpen ? 'v' : '>'}</span>
          </button>
          {quickLinksOpen && (
            <div style={styles.quickLinksList}>
              {legalResources.map(([name, href, icon]) => (
                <a key={name} className="lf-resource-link" style={styles.quickLink} href={href} target="_blank" rel="noopener noreferrer">
                  <span style={styles.quickLinkIcon}>{icon || 'EX'}</span>
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
            <div style={styles.eyebrow}>{firm.name || 'LexFlow Kenya'}</div>
            <h1 style={styles.title}>{view}</h1>
            <p style={styles.subtitle}>{subtitles[view]}</p>
          </div>
          <div style={styles.topActions}>
            <div ref={searchRef} style={{ position: 'relative' }}>
              <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search workspace" style={styles.search} />
              {searchOpen && (
                <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', width: 320, maxWidth: 'calc(100vw - 32px)', zIndex: 2200, background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, boxShadow: theme.shadowLift, padding: 0, maxHeight: 400, overflowY: 'auto', animation: 'lfDropIn .16s ease-out' }}>
                  {searchLoading ? (
                    <div style={{ padding: 14, color: theme.muted, textAlign: 'center' }}>Searching...</div>
                  ) : searchResults.length ? (
                    searchResults.map(item => (
                      <button key={item.id} type="button" onClick={() => {
                        if (item.type === 'Matter') { setView('Matters'); setMatterFocus({ matterId: item.matterId, ts: Date.now() }); }
                        if (item.type === 'Client') setView('Clients');
                        setSearch(item.title || '');
                        setSearchOpen(false);
                      }} style={{ width: '100%', textAlign: 'left', border: 0, borderTop: `1px solid ${theme.line}`, background: '#fff', padding: '10px 12px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <strong style={{ fontSize: 13 }}>{item.type === 'Matter' ? 'Matter' : 'Client'}: {item.title || '-'}</strong>
                        <span style={{ color: theme.muted, fontSize: 11 }}>{item.subtitle || ''}</span>
                      </button>
                    ))
                  ) : (
                    <div style={{ padding: 14, color: theme.muted, textAlign: 'center' }}>No results found.</div>
                  )}
                </div>
              )}
            </div>
            <NotificationBell notifications={notifications} open={notificationsOpen} setOpen={setNotificationsOpen} onOpen={openNotification} />
            <button type="button" onClick={refresh} disabled={loading} style={styles.ghostButton}>{loading ? 'Refreshing...' : 'Refresh'}</button>
          </div>
        </header>

        {loading && <Skeleton />}
        {!loading && view === 'Dashboard' && <Dashboard data={data} user={user} />}
        {!loading && view === 'Clients' && <Clients clients={data.clients} matters={data.matters} canManage={canManage} isAdmin={isAdmin} reload={refresh} notify={setToast} />}
        {!loading && view === 'Matters' && <Matters data={data} canManage={canManage} reload={refresh} notify={setToast} focus={matterFocus} onMatterOpened={async matterId => { setNotifications(current => current.filter(item => item.matterId !== matterId)); try { await markNotificationsRead({ matterId }); } catch {} }} />}
        {!loading && view === 'Tasks' && <Tasks data={data} canManage={canManage} reload={refresh} notify={setToast} />}
        {!loading && view === 'Deadlines' && <DeadlineCenter data={data} canManage={canManage} notify={setToast} />}
        {!loading && view === 'Communications' && <Communications clients={data.clients} matters={data.matters} focus={communicationFocus} notify={setToast} />}
        {!loading && view === 'Invoices' && <Invoices invoices={data.invoices} isAdmin={isAdmin} canManage={canManage} reload={refresh} notify={setToast} />}
        {!loading && view === 'Performance' && isAdmin && <AdvocatePerformance notify={setToast} />}
        {!loading && view === 'Firm Settings' && isAdmin && <FirmSettings settings={firm} clients={data.clients} reload={refresh} notify={setToast} />}
        {!loading && view === 'Users' && isAdmin && <Users clients={data.clients} notify={setToast} />}
        {!loading && view === 'Invitations' && isAdmin && <Invitations clients={data.clients} notify={setToast} />}
        {!loading && view === 'Audit Log' && isAdmin && <AuditLog notify={setToast} navigate={setView} />}
      </main>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

function NotificationBell({ notifications, open, setOpen, onOpen }) {
  const count = notifications.length;
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" aria-label="Client notifications" onClick={() => setOpen(!open)} style={{ ...styles.ghostButton, position: 'relative', padding: '7px 12px' }}>
        <span aria-hidden="true">🔔</span>
        {count > 0 && <span style={{ position: 'absolute', top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 999, display: 'grid', placeItems: 'center', background: theme.red, color: '#fff', fontSize: 10, fontWeight: 900 }}>{count}</span>}
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 360, maxWidth: 'calc(100vw - 32px)', zIndex: 2200, background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, boxShadow: theme.shadowLift, padding: 10, animation: 'lfDropIn .16s ease-out' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', padding: '4px 4px 10px' }}>
            <strong>Client activity</strong>
            <span style={styles.mutedText}>{count} unread</span>
          </div>
          {count ? notifications.map(item => (
            <button key={item.id} type="button" onClick={() => onOpen(item)} style={{ width: '100%', textAlign: 'left', border: 0, borderTop: `1px solid ${theme.line}`, background: '#fff', padding: '10px 4px', cursor: 'pointer' }}>
              <strong>{item.title || 'Client activity'}</strong>
              <div style={{ color: theme.muted, fontSize: 12, marginTop: 3 }}>{item.clientName || 'Client'} / {item.matterTitle || item.reference || 'Matter'}</div>
              <div style={{ color: theme.ink, fontSize: 12, marginTop: 5 }}>{item.body || '-'}</div>
              <div style={{ color: theme.muted, fontSize: 11, marginTop: 5 }}>{item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}</div>
            </button>
          )) : (
            <div style={{ padding: 14, color: theme.muted, textAlign: 'center' }}>No unread client messages or uploads.</div>
          )}
        </div>
      )}
    </div>
  );
}

