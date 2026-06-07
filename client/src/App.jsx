import { Component, useEffect, useRef, useState } from 'react';
import { IconLayoutDashboard, IconChartLine, IconReportAnalytics, IconUsers, IconUserPlus, IconBriefcase, IconCheckbox, IconCalendarDue, IconFileInvoice, IconMessages, IconUsersGroup, IconSettings, IconListSearch, IconExternalLink, IconChevronDown, IconShield, IconSearch, IconBell, IconRefresh, IconTemplate, IconLink } from '@tabler/icons-react';
import { api, API_BASE, AUTH_FAILURE_MESSAGE, clearSession, clearAllLexFlowStorage, fetchAvatarObjectUrl, getNotifications, markNotificationsRead, readSession, saveSession } from './lib/apiClient.js';
import { globalSearch } from './api.js';
import { defaultFirmSettings, styles, StyleTag, theme, loadAndApplyFirmTheme } from './theme.jsx';
import { Logo, Skeleton, Toast, Alert } from './components/ui.jsx';
import LoginPage from './components/LoginPage.jsx';
import OAuthCallback from './views/OAuthCallback.jsx';
import AcceptInvitation from './views/AcceptInvitation.jsx';
import AdvocatePerformance from './views/AdvocatePerformance.jsx';
import AuditLog from './views/AuditLog.jsx';
import StructuredAuditLog from './views/StructuredAuditLog.jsx';
import ClientApp from './views/ClientApp.jsx';
import Communications from './views/Communications.jsx';
import DeadlineCenter from './views/DeadlineCenter.jsx';
import Invitations from './views/Invitations.jsx';
import { Clients, ConnectedAccounts, Dashboard, FirmSettings, HR, Invoices, Matters, Tasks, Users } from './views/StaffViews.jsx';
import DocumentStudio from './views/DocumentStudio.jsx';
import MyLeave from './views/MyLeave.jsx';
import Reports from './views/Reports.jsx';

const navIcons = {
  Dashboard: IconLayoutDashboard,
  Performance: IconChartLine,
  Reports: IconReportAnalytics,
  Clients: IconUsers,
  Invitations: IconUserPlus,
  Matters: IconBriefcase,
  Tasks: IconCheckbox,
  Deadlines: IconCalendarDue,
  Invoices: IconFileInvoice,
  Communications: IconMessages,
  Users: IconUsersGroup,
  HR: IconUsersGroup,
  'Firm Settings': IconSettings,
  'Audit Log': IconListSearch,
  'Structured Audit': IconShield,
  'Document Studio': IconTemplate,
  'Connected Accounts': IconLink,
  'eFiling CTS': IconExternalLink,
  eCitizen: IconExternalLink,
  'Ardhi Sasa': IconExternalLink,
};

const navDisplayLabels = {
  'Audit Log': 'Audit Log (Legacy)',
  'Structured Audit': 'Audit Events',
};

const initialData = { dashboard: {}, clients: [], matters: [], tasks: [], invoices: [], firmSettings: defaultFirmSettings };
const navGroups = [
  { title: 'Overview', items: [['Dashboard', ['admin', 'advocate', 'assistant']], ['Performance', ['admin']], ['Reports', ['admin']]] },
  { title: 'Relationships', items: [['Clients', ['admin', 'advocate', 'assistant']], ['Invitations', ['admin']]] },
  { title: 'Matters', items: [['Matters', ['admin', 'advocate', 'assistant']]] },
  { title: 'Work', items: [['Tasks', ['admin', 'advocate', 'assistant']], ['Deadlines', ['admin', 'advocate', 'assistant']], ['My Leave', ['advocate', 'assistant']]] },
  { title: 'Document Studio', items: [['Document Studio', ['admin', 'advocate']]] },
  { title: 'Finance', items: [['Invoices', ['admin']]] },
  { title: 'Communications', items: [['Communications', ['admin', 'advocate', 'assistant']]] },
  { title: 'Administration', items: [['Users', ['admin']], ['HR', ['admin']], ['Firm Settings', ['admin']], ['Audit Log', ['admin']], ['Structured Audit', ['admin']]] },
  { title: 'Account', items: [['Connected Accounts', ['admin', 'advocate', 'assistant']]] },
  { title: 'Resources', items: [
    ['eFiling CTS', ['admin', 'advocate', 'assistant'], 'https://efiling.court.go.ke/auth'],
    ['eCitizen', ['admin', 'advocate', 'assistant'], 'https://www.ecitizen.go.ke'],
    ['Ardhi Sasa', ['admin', 'advocate', 'assistant'], 'https://ardhisasa.lands.go.ke/home'],
  ] },
];

function allowedNavGroups(role) {
  return navGroups
    .map(group => ({ ...group, items: group.items.filter(([, roles]) => !roles || roles.includes(role)) }))
    .filter(group => group.items.length);
}

function defaultNavGroup(role) {
  return allowedNavGroups(role)[0]?.title || 'Overview';
}

const OPEN_NAV_GROUPS_STORAGE_KEY = 'lexflow:v1:staff:openNavGroups';
const LEGACY_OPEN_NAV_GROUPS_STORAGE_KEY = 'lexflowOpenNavGroups';

function parseStoredNavGroups(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return { status: 'missing' };
    const saved = JSON.parse(raw);
    if (Array.isArray(saved)) return { status: 'valid', value: saved };
    localStorage.removeItem(key);
    return { status: 'invalid' };
  } catch {
    try { localStorage.removeItem(key); } catch {}
    return { status: 'invalid' };
  }
}

function readOpenNavGroups(role) {
  try {
    const saved = parseStoredNavGroups(OPEN_NAV_GROUPS_STORAGE_KEY);
    if (saved.status === 'valid') return new Set(saved.value);
    if (saved.status === 'invalid') return null;

    const legacy = parseStoredNavGroups(LEGACY_OPEN_NAV_GROUPS_STORAGE_KEY);
    if (legacy.status === 'valid') {
      localStorage.setItem(OPEN_NAV_GROUPS_STORAGE_KEY, JSON.stringify(legacy.value));
      localStorage.removeItem(LEGACY_OPEN_NAV_GROUPS_STORAGE_KEY);
      return new Set(legacy.value);
    }
    return null;
  } catch {
    return null;
  }
}

function StaffNavigation({ visibleGroups, openNavGroups, setOpenNavGroups, view, setView, onNavigate }) {
  return (
    <nav style={styles.navList}>
      {visibleGroups.map(group => {
        const isFlattened = (group.title === 'Matters' || group.title === 'Communications') && group.items.length === 1;
        return (
          <div key={group.title} style={styles.navGroup}>
            {!isFlattened && (
              <button
                type="button"
                className="lf-nav-group"
                onClick={() => {
                  setOpenNavGroups(prev => {
                    const next = new Set(prev);
                    if (next.has(group.title)) { next.delete(group.title); }
                    else { next.add(group.title); }
                    try { localStorage.setItem(OPEN_NAV_GROUPS_STORAGE_KEY, JSON.stringify([...next])); } catch {}
                    return next;
                  });
                }}
                style={styles.navGroupButton}
                aria-expanded={openNavGroups.has(group.title)}
              >
                <span>{group.title}</span>
                <span style={styles.navGroupChevron}>{openNavGroups.has(group.title) ? 'v' : '>'}</span>
              </button>
            )}
            {(isFlattened || openNavGroups.has(group.title)) && (
              <div style={styles.navGroupItems}>
                {group.items.map(([label, , url]) => {
                  const NavIcon = navIcons[label];
                  if (url) {
                    return (
                      <a key={label} className="lf-nav lf-resource-link" style={{ ...styles.navItem, textDecoration: 'none' }} href={url} target="_blank" rel="noopener noreferrer" onClick={onNavigate}>
                        <span style={styles.navNumber}>{NavIcon ? <NavIcon size={16} /> : null}</span>
                        <span>{label}</span>
                      </a>
                    );
                  }
                  return (
                    <button key={label} type="button" className={`lf-nav${view === label ? ' is-active' : ''}`} onClick={() => { setView(label); onNavigate?.(); }} style={{ ...styles.navItem, ...(view === label ? styles.navActive : {}) }}>
                      <span style={styles.navNumber}>{NavIcon ? <NavIcon size={16} /> : null}</span>
                      <span>{navDisplayLabels[label] || label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

class ViewErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('LexFlow view render error', error, info);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <section role="alert" style={{ background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, boxShadow: theme.shadow, padding: 24, display: 'grid', gap: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 6px', fontSize: 18, color: theme.ink }}>Something went wrong in this view</h2>
          <p style={{ margin: 0, color: theme.muted }}>The rest of LexFlow is still available. Return to Dashboard or reload the app.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={styles.primaryButton} onClick={() => { this.setState({ error: null }); this.props.onDashboard?.(); }}>Return to Dashboard</button>
          <button type="button" style={styles.ghostButton} onClick={() => window.location.reload()}>Reload app</button>
        </div>
      </section>
    );
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
  const accountMenuRef = useRef(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [openNavGroups, setOpenNavGroups] = useState(() => {
    const currentRole = session?.user?.role || 'assistant';
    const saved = readOpenNavGroups(currentRole);
    return saved || new Set([defaultNavGroup(currentRole)]);
  });
  const [notifications, setNotifications] = useState([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [matterFocus, setMatterFocus] = useState(null);
  const [communicationFocus, setCommunicationFocus] = useState(null);
  const [taskFocus, setTaskFocus] = useState(null);
  const [clientFocus, setClientFocus] = useState(null);
  const [appearanceFocus, setAppearanceFocus] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [toast, setToast] = useState(null);
  const [data, setData] = useState(initialData);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [installDismissed, setInstallDismissed] = useState(false);
  const [myAvatarUrl, setMyAvatarUrl] = useState(null);
  const myAvatarUrlRef = useRef(null);

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
    function handleBeforeInstall(e) {
      e.preventDefault();
      setDeferredPrompt(e);
    }
    function handleAppInstalled() {
      setDeferredPrompt(null);
      setIsInstalled(true);
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)');
    const isStandalone = mq.matches || window.navigator.standalone === true;
    setIsInstalled(isStandalone);
    function handleChange(e) {
      setIsInstalled(e.matches || window.navigator.standalone === true);
    }
    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, []);

  function handleInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(result => {
      if (result.outcome === 'accepted') setIsInstalled(true);
      setDeferredPrompt(null);
    });
  }

  useEffect(() => {
    if (authenticated) refresh();
  }, [authenticated]);

  useEffect(() => {
    if (authenticated) loadAndApplyFirmTheme();
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || user?.role === 'client') return undefined;
    loadNotifications();
    const timer = window.setInterval(loadNotifications, 60000);
    return () => window.clearInterval(timer);
  }, [authenticated, user?.role]);

  useEffect(() => {
    function revokeExisting() {
      if (myAvatarUrlRef.current) { URL.revokeObjectURL(myAvatarUrlRef.current); myAvatarUrlRef.current = null; }
    }
    if (!user?.id || !user?.hasAvatar || user?.role === 'client') {
      revokeExisting();
      setMyAvatarUrl(null);
      return;
    }
    let alive = true;
    fetchAvatarObjectUrl(user.id).then(url => {
      if (!alive) { if (url) URL.revokeObjectURL(url); return; }
      revokeExisting();
      myAvatarUrlRef.current = url;
      setMyAvatarUrl(url);
    });
    return () => { alive = false; revokeExisting(); };
  }, [user?.id, user?.hasAvatar]);

  useEffect(() => {
    document.title = firm?.name || 'LexFlow Kenya';
  }, [firm?.name]);

  useEffect(() => {
    if (!user || user.role === 'client') return;
    if (!visibleViews.includes(view)) setView('Dashboard');
    const activeGroup = visibleGroups.find(group => group.items.some(([label]) => label === view));
    if (activeGroup) {
      setOpenNavGroups(prev => {
        if (prev.has(activeGroup.title)) return prev;
        const next = new Set(prev);
        next.add(activeGroup.title);
        try { localStorage.setItem(OPEN_NAV_GROUPS_STORAGE_KEY, JSON.stringify([...next])); } catch {}
        return next;
      });
    }
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

  useEffect(() => {
    if (!accountMenuOpen) return;
    function handleClickOutside(e) {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target)) {
        setAccountMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    function handleEscape(event) {
      if (event.key === 'Escape') setMobileMenuOpen(false);
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [mobileMenuOpen]);

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
      setBootstrapped(true);
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
    clearAllLexFlowStorage();
  }

  if (window.location.pathname.startsWith('/invite/')) {
    return (
      <>
        <AcceptInvitation firm={firm} onAccepted={acceptInvitationLogin} />
        <Toast toast={toast} onClose={() => setToast(null)} />
      </>
    );
  }

  if (window.location.pathname === '/oauth/callback') {
    return <OAuthCallback firm={firm} onLogin={login} />;
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
        <LoginPage firm={firm} onLogin={login} deferredPrompt={deferredPrompt} isInstalled={isInstalled} installDismissed={installDismissed} setInstallDismissed={setInstallDismissed} onInstall={handleInstall} />
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
    HR: 'Admin-only staff HR profile records.',
    'Connected Accounts': 'Authorize future Google Workspace and Microsoft 365 integrations.',
    Invitations: 'Secure client portal onboarding links and invitation status.',
    'Audit Log': 'A secure activity trail for important changes and accountability.',
    'Structured Audit': 'Structured event trail for security, access, and operational auditing.',
    'Document Studio': 'Review active document templates and future document tools.',
  };

  return (
    <div className="lf-app-shell" style={{ ...styles.shell, '--lf-primary': firm.primaryColor || theme.navy800, '--lf-accent': firm.accentColor || theme.gold }}>
      <StyleTag />
      <aside className="lf-desktop-sidebar" style={styles.sidebar}>
        <div style={styles.brandPanel}>
          <Logo firm={firm} />
          <div style={{ minWidth: 0 }}>
            <div style={styles.brand}>{firm.name || 'LexFlow Kenya'}</div>
            <div style={styles.brandSub}>Practice suite</div>
          </div>
        </div>

        <StaffNavigation visibleGroups={visibleGroups} openNavGroups={openNavGroups} setOpenNavGroups={setOpenNavGroups} view={view} setView={setView} />

        <div style={styles.userCard}>
          <div style={styles.avatar}>
            {myAvatarUrl
              ? <img src={myAvatarUrl} alt={user?.fullName || ''} style={styles.avatarImg} onError={() => setMyAvatarUrl(null)} />
              : (user?.fullName || user?.name || 'U').slice(0, 1).toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={styles.userName}>{user?.fullName || user?.name || 'Signed in'}</div>
            <div style={styles.userRole}>{user?.role || 'user'}</div>
          </div>
          <div ref={accountMenuRef} style={{ position: 'relative' }}>
            <button type="button" aria-label="Account menu" aria-haspopup="menu" aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen(o => !o)} style={{ ...styles.logout, display: 'flex', alignItems: 'center', gap: 2 }}>
              <IconChevronDown size={14} aria-hidden="true" />
            </button>
            {accountMenuOpen && (
              <div style={{ ...styles.actionMenu, position: 'absolute', bottom: '100%', right: 0, marginBottom: 4 }}>
                <button type="button" style={styles.actionMenuItem} onClick={() => {
                  setAccountMenuOpen(false);
                  if (isAdmin) { setView('Firm Settings'); }
                  else { setToast({ type: 'info', message: 'Account settings coming soon' }); }
                }}>
                  Account
                </button>
                <button type="button" style={{ ...styles.actionMenuItem, color: theme.red, background: theme.redBg }} onClick={() => { setAccountMenuOpen(false); logout(); }}>
                  Exit
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      {mobileMenuOpen && (
        <div className="lf-mobile-drawer-layer" style={styles.mobileDrawerLayer}>
          <button type="button" aria-label="Close navigation menu" title="Close navigation menu" style={styles.mobileBackdrop} onClick={() => setMobileMenuOpen(false)} />
          <aside aria-label="Mobile navigation" style={styles.mobileDrawer}>
            <div style={styles.mobileDrawerHead}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <Logo firm={firm} />
                <div style={{ minWidth: 0 }}>
                  <div style={styles.brand}>{firm.name || 'LexFlow Kenya'}</div>
                  <div style={styles.brandSub}>Practice suite</div>
                </div>
              </div>
              <button type="button" aria-label="Close navigation menu" title="Close navigation menu" onClick={() => setMobileMenuOpen(false)} style={styles.mobileCloseButton}>x</button>
            </div>
            <StaffNavigation visibleGroups={visibleGroups} openNavGroups={openNavGroups} setOpenNavGroups={setOpenNavGroups} view={view} setView={setView} onNavigate={() => setMobileMenuOpen(false)} />
            <div style={styles.userCard}>
              <div style={styles.avatar}>
                {myAvatarUrl
                  ? <img src={myAvatarUrl} alt={user?.fullName || ''} style={styles.avatarImg} onError={() => setMyAvatarUrl(null)} />
                  : (user?.fullName || user?.name || 'U').slice(0, 1).toUpperCase()}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={styles.userName}>{user?.fullName || user?.name || 'Signed in'}</div>
                <div style={styles.userRole}>{user?.role || 'user'}</div>
              </div>
              <button type="button" onClick={() => { setMobileMenuOpen(false); logout(); }} style={styles.logout}>Exit</button>
            </div>
          </aside>
        </div>
      )}

      <main style={styles.main}>
        <header className="lf-topbar" style={styles.topbar}>
          <button type="button" className="lf-mobile-only" aria-label="Open navigation menu" title="Open navigation menu" onClick={() => setMobileMenuOpen(true)} style={styles.mobileMenuButton}>Menu</button>
          <div ref={searchRef} className="lf-topbar-search lf-mobile-search" style={styles.topbarSearch}>
            <IconSearch size={15} stroke={1.75} style={styles.topbarSearchIcon} aria-hidden="true" />
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search matters, clients, documents..." aria-label="Search workspace" style={styles.topbarSearchInput} />
            <span className="lf-topbar-search-kbd" style={styles.topbarKbd} aria-hidden="true">Ctrl K</span>
            {searchOpen && (
              <div style={{ position: 'absolute', right: 0, left: 0, top: 'calc(100% + 6px)', maxWidth: '100%', zIndex: 2200, background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, boxShadow: theme.shadowLift, padding: 0, maxHeight: 400, overflowY: 'auto', animation: 'lfDropIn .16s ease-out' }}>
                {searchLoading ? (
                  <div style={{ padding: 14, color: theme.muted, textAlign: 'center' }}>Searching...</div>
                ) : searchResults.length ? (
                  searchResults.map(item => (
                    <button key={item.id} type="button" onClick={() => {
                      if (item.type === 'Matter') { setView('Matters'); setMatterFocus({ matterId: item.matterId, ts: Date.now() }); }
                      if (item.type === 'Client') { setView('Clients'); setClientFocus({ clientId: item.id, ts: Date.now() }); }
                      if (item.type === 'Task') { setView('Tasks'); setTaskFocus({ taskId: item.id, ts: Date.now() }); }
                      if (item.type === 'Invoice') { if (isAdmin) setView('Invoices'); else if (item.matterId) { setView('Matters'); setMatterFocus({ matterId: item.matterId, ts: Date.now() }); } }
                      if (item.type === 'Appearance') { setView('Deadlines'); setAppearanceFocus({ appearanceId: item.id, ts: Date.now() }); }
                      if (item.type === 'Document' && item.matterId) { setView('Matters'); setMatterFocus({ matterId: item.matterId, ts: Date.now() }); }
                      if (item.type === 'Conversation') { setView('Communications'); setCommunicationFocus({ matterId: item.matterId, clientId: '', ts: Date.now() }); }
                      setSearch(item.title || '');
                      setSearchOpen(false);
                    }} style={{ width: '100%', textAlign: 'left', border: 0, borderTop: `1px solid ${theme.line}`, background: '#fff', padding: '10px 12px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <strong style={{ fontSize: 13 }}>{item.type}: {item.title || '-'}</strong>
                      <span style={{ color: theme.muted, fontSize: 11 }}>{item.subtitle || ''}</span>
                    </button>
                  ))
                ) : (
                  <div style={{ padding: 14, color: theme.muted, textAlign: 'center' }}>No results found.</div>
                )}
              </div>
            )}
          </div>
          <div className="lf-top-actions" style={styles.topActions}>
            <NotificationBell notifications={notifications} open={notificationsOpen} setOpen={setNotificationsOpen} onOpen={openNotification} />
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
              <button type="button" className="lf-topbar-icon-btn" aria-label={loading ? 'Refreshing data' : 'Refresh data'} title="Refresh data" onClick={refresh} disabled={loading} style={styles.iconButton}>
                <IconRefresh size={18} stroke={1.75} style={{ animation: loading ? 'lfPulse 1.1s ease-in-out infinite' : 'none' }} />
              </button>
              {loading && bootstrapped && (
                <span style={{ fontSize: 10, color: '#697386', lineHeight: 1, letterSpacing: 0, whiteSpace: 'nowrap' }}>Refreshing…</span>
              )}
            </div>
          </div>
        </header>

        <div className="lf-page-inner" style={styles.pageInner}>
          <div className="lf-page-header" style={styles.pageHeader}>
            <div className="lf-page-crumb" style={styles.pageCrumb}>{firm.name || 'LexFlow Kenya'}</div>
            <h1 className="lf-page-title" style={styles.pageTitle}>{view}</h1>
            <p className="lf-page-sub" style={styles.pageSub}>{subtitles[view]}</p>
          </div>

          <ViewErrorBoundary resetKey={view} onDashboard={() => setView('Dashboard')}>
            {loading && !bootstrapped && <Skeleton />}
            {(!loading || bootstrapped) && view === 'Dashboard' && <Dashboard data={data} user={user} onNavigate={setView} />}
            {(!loading || bootstrapped) && view === 'Clients' && <Clients clients={data.clients} matters={data.matters} canManage={canManage} isAdmin={isAdmin} reload={refresh} notify={setToast} focus={clientFocus} />}
            {(!loading || bootstrapped) && view === 'Matters' && <Matters data={data} canManage={canManage} reload={refresh} notify={setToast} focus={matterFocus} onMatterOpened={async matterId => { setNotifications(current => current.filter(item => item.matterId !== matterId)); try { await markNotificationsRead({ matterId }); } catch {} }} />}
            {(!loading || bootstrapped) && view === 'Tasks' && <Tasks data={data} canManage={canManage} reload={refresh} notify={setToast} focus={taskFocus} />}
            {(!loading || bootstrapped) && view === 'Deadlines' && <DeadlineCenter data={data} canManage={canManage} notify={setToast} focus={appearanceFocus} />}
            {(!loading || bootstrapped) && view === 'Communications' && <Communications clients={data.clients} matters={data.matters} focus={communicationFocus} notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Invoices' && <Invoices invoices={data.invoices} isAdmin={isAdmin} canManage={canManage} reload={refresh} notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Performance' && isAdmin && <AdvocatePerformance notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Reports' && isAdmin && <Reports data={data} notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Firm Settings' && isAdmin && <FirmSettings settings={firm} clients={data.clients} reload={refresh} notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Connected Accounts' && <ConnectedAccounts notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Users' && isAdmin && <Users clients={data.clients} notify={setToast} />}
            {(!loading || bootstrapped) && view === 'My Leave' && <MyLeave notify={setToast} />}
            {(!loading || bootstrapped) && view === 'HR' && isAdmin && <HR notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Invitations' && isAdmin && <Invitations clients={data.clients} notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Audit Log' && isAdmin && <AuditLog notify={setToast} navigate={setView} />}
            {(!loading || bootstrapped) && view === 'Structured Audit' && isAdmin && <StructuredAuditLog notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Document Studio' && canManage && <DocumentStudio notify={setToast} />}
          </ViewErrorBoundary>
        </div>
      </main>
      <button
        type="button"
        className="lf-timer-bubble"
        onClick={() => setView('Matters')}
        style={styles.timerBubble}
        aria-label="Open Matters to log billable time"
        title="Open Matters to log billable time"
      >
        <span style={styles.liveDot} />
        <div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Timekeeper</div>
          <div style={{ color: 'rgba(255,255,255,.5)', fontSize: 10.5, marginTop: 2 }}>Log billable time</div>
        </div>
      </button>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

function NotificationBell({ notifications, open, setOpen, onOpen }) {
  const count = notifications.length;
  const label = count > 0 ? `Client notifications, ${count} unread` : 'Client notifications';
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="lf-topbar-icon-btn" aria-label={label} title={label} onClick={() => setOpen(!open)} style={styles.iconButton}>
        <IconBell size={18} stroke={1.75} aria-hidden="true" />
        {count > 0 && <span style={styles.iconBadgeDot} aria-hidden="true" />}
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

