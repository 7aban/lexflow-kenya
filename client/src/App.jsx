import { useEffect, useMemo, useRef, useState } from 'react';
import { IconLayoutDashboard, IconChartLine, IconReportAnalytics, IconUsers, IconUserPlus, IconBriefcase, IconCheckbox, IconCalendarDue, IconFileInvoice, IconMessages, IconUsersGroup, IconSettings, IconListSearch, IconExternalLink, IconChevronDown, IconShield, IconSearch, IconBell, IconRefresh, IconTemplate, IconLink, IconX } from '@tabler/icons-react';
import { api, API_BASE, AUTH_FAILURE_MESSAGE, clearSession, clearAllLexFlowStorage, fetchAvatarObjectUrl, getNotifications, markNotificationsRead, readSession, saveSession } from './lib/apiClient.js';
import { globalSearch } from './api.js';
import { defaultFirmSettings, styles, StyleTag, theme, loadAndApplyFirmTheme, resolveReadableTheme } from './theme.jsx';
import { Logo, Skeleton, Toast, Alert } from './components/ui.jsx';
import LoginPage from './components/LoginPage.jsx';
import ViewErrorBoundary from './components/ViewErrorBoundary.jsx';
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
  Dashboard: 'Workspace',
  'Deadlines': 'Court Diary & Deadlines',
  'Document Studio': 'Documents',
  Invoices: 'Billing',
  'Audit Log': 'Audit Log (Legacy)',
  'Structured Audit': 'Audit Events',
};

const initialData = { dashboard: {}, clients: [], matters: [], tasks: [], invoices: [], firmSettings: defaultFirmSettings };
const navGroups = [
  { title: 'Primary', collapsible: false, showTitle: false, items: [['Dashboard', ['admin', 'advocate', 'assistant']], ['Matters', ['admin', 'advocate', 'assistant']], ['Tasks', ['admin', 'advocate', 'assistant']], ['Deadlines', ['admin', 'advocate', 'assistant']], ['Document Studio', ['admin', 'advocate']], ['Invoices', ['admin']], ['Clients', ['admin', 'advocate', 'assistant']], ['Reports', ['admin']], ['Communications', ['admin', 'advocate', 'assistant']]] },
  { title: 'Tools', collapsible: true, items: [
    ['Connected Accounts', ['admin', 'advocate', 'assistant']],
    ['My Leave', ['advocate', 'assistant']],
    ['eFiling CTS', ['admin', 'advocate', 'assistant'], 'https://efiling.court.go.ke/auth'],
    ['eCitizen', ['admin', 'advocate', 'assistant'], 'https://www.ecitizen.go.ke'],
    ['Ardhi Sasa', ['admin', 'advocate', 'assistant'], 'https://ardhisasa.lands.go.ke/home'],
  ] },
  { title: 'Admin', collapsible: true, items: [['Users', ['admin']], ['HR', ['admin']], ['Firm Settings', ['admin']], ['Audit Log', ['admin']], ['Structured Audit', ['admin']], ['Performance', ['admin']], ['Invitations', ['admin']]] },
];

const staffViewSlugs = {
  Dashboard: 'dashboard',
  Clients: 'clients',
  Matters: 'matters',
  Tasks: 'tasks',
  Deadlines: 'court-diary-deadlines',
  Communications: 'communications',
  Invoices: 'invoices',
  Reports: 'reports',
  'Document Studio': 'document-studio',
  Users: 'users',
  HR: 'hr',
  'Firm Settings': 'firm-settings',
  'Audit Log': 'audit',
  Performance: 'performance',
  Invitations: 'invitations',
  'Connected Accounts': 'connected-accounts',
  'My Leave': 'my-leave',
  'Structured Audit': 'structured-audit',
};

const staffSlugViews = Object.entries(staffViewSlugs).reduce((acc, [view, slug]) => ({ ...acc, [slug]: view }), {});
const validMatterSections = new Set(['overview', 'tasks', 'court-diary', 'documents', 'billing', 'timeline', 'client-portal', 'notes']);

function readHashParts(hash = window.location.hash) {
  return String(hash || '')
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(part => {
      try { return decodeURIComponent(part); }
      catch { return part; }
    });
}

function replaceHash(hash) {
  if (typeof window === 'undefined') return;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
}

function setAppHash(hash, { replace = false } = {}) {
  if (typeof window === 'undefined' || window.location.hash === hash) return;
  if (replace) {
    replaceHash(hash);
    return;
  }
  window.history.pushState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
}

function staffHashFor(view, options = {}) {
  const slug = staffViewSlugs[view] || staffViewSlugs.Dashboard;
  if (view !== 'Matters') return `#/staff/${slug}`;
  const clientId = options.clientId ? encodeURIComponent(options.clientId) : '';
  if (clientId) return `#/staff/matters/client/${clientId}${options.mode === 'create' ? '/create' : ''}`;
  const matterId = options.matterId ? encodeURIComponent(options.matterId) : '';
  const section = options.section && validMatterSections.has(options.section) ? encodeURIComponent(options.section) : '';
  if (matterId && section) return `#/staff/matters/${matterId}/${section}`;
  if (matterId) return `#/staff/matters/${matterId}`;
  return '#/staff/matters';
}

function parseStaffRoute(hash = window.location.hash) {
  const [area, slug, matterId, section, action] = readHashParts(hash);
  if (area !== 'staff') return null;
  if (slug === 'matters') {
    if (matterId === 'client' && section) {
      return {
        view: 'Matters',
        clientId: section,
        mode: action === 'create' ? 'create' : 'view',
      };
    }
    return {
      view: 'Matters',
      matterId: matterId || '',
      section: validMatterSections.has(section) ? section : '',
    };
  }
  const view = staffSlugViews[slug || 'dashboard'];
  return view ? { view } : { view: 'Dashboard', replace: true };
}

function allowedNavGroups(role) {
  return navGroups
    .map(group => ({ ...group, items: group.items.filter(([, roles]) => !roles || roles.includes(role)) }))
    .filter(group => group.items.length);
}

const OPEN_NAV_GROUPS_STORAGE_KEY = 'lexflow:v2:staff:openNavGroups';
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
  function toggleGroup(group) {
    setOpenNavGroups(prev => {
      const isActiveGroup = group.items.some(([label]) => label === view);
      const next = new Set(prev);
      if (next.has(group.title)) {
        if (isActiveGroup) return prev;
        next.delete(group.title);
      } else {
        next.add(group.title);
      }
      try { localStorage.setItem(OPEN_NAV_GROUPS_STORAGE_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  return (
    <nav style={styles.navList}>
      {visibleGroups.map(group => {
        const isCollapsible = group.collapsible !== false;
        const isOpen = !isCollapsible || openNavGroups.has(group.title);
        const isActiveGroup = group.items.some(([label]) => label === view);
        return (
          <div key={group.title} style={styles.navGroup}>
            {group.showTitle !== false && (
              <button
                type="button"
                className="lf-nav-group lf-nav-group-button"
                aria-expanded={isOpen}
                onClick={() => isCollapsible && toggleGroup(group)}
                style={{
                  ...styles.navGroupButton,
                  color: isActiveGroup ? 'var(--lf-on-sidebar, #fff)' : styles.navGroupButton.color,
                  cursor: isCollapsible ? 'pointer' : 'default',
                }}
              >
                <span>{group.title}</span>
                {isCollapsible && (
                  <IconChevronDown
                    size={13}
                    stroke={1.8}
                    aria-hidden="true"
                    style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)', opacity: isActiveGroup ? 0.9 : 0.58 }}
                  />
                )}
              </button>
            )}
            {isOpen && <div style={styles.navGroupItems}>
              {group.items.map(([label, , url]) => {
                const NavIcon = navIcons[label];
                if (url) {
                  return (
                    <a key={label} className="lf-nav lf-resource-link" style={{ ...styles.navItem, paddingLeft: group.showTitle === false ? 16 : 24, textDecoration: 'none' }} href={url} target="_blank" rel="noopener noreferrer" onClick={onNavigate}>
                      <span style={styles.navNumber}>{NavIcon ? <NavIcon size={16} /> : null}</span>
                      <span>{label}</span>
                    </a>
                  );
                }
                return (
                  <button key={label} type="button" className={`lf-nav${view === label ? ' is-active' : ''}`} onClick={() => { setView(label); onNavigate?.(); }} style={{ ...styles.navItem, paddingLeft: group.showTitle === false ? 16 : 24, ...(view === label ? styles.navActive : {}) }}>
                    <span style={styles.navNumber}>{NavIcon ? <NavIcon size={16} /> : null}</span>
                    <span>{navDisplayLabels[label] || label}</span>
                  </button>
                );
              })}
            </div>}
          </div>
        );
      })}
    </nav>
  );
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
  const searchInputRef = useRef(null);
  const accountMenuRef = useRef(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [openNavGroups, setOpenNavGroups] = useState(() => {
    const currentRole = session?.user?.role || 'assistant';
    const saved = readOpenNavGroups(currentRole);
    return saved || new Set();
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
  const [loginResetNonce, setLoginResetNonce] = useState(0);
  const [myAvatarUrl, setMyAvatarUrl] = useState(null);
  const [themeOverride, setThemeOverride] = useState(null);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1280 : window.innerWidth);
  const myAvatarUrlRef = useRef(null);

  const authenticated = Boolean(session?.token);
  const isAdmin = user?.role === 'admin';
  const canManage = ['admin', 'advocate'].includes(user?.role);
  const firm = data.firmSettings || defaultFirmSettings;
  const savedFirmTheme = firm?.theme && typeof firm.theme === 'object' ? firm.theme : null;
  const resolvedFirmTheme = resolveReadableTheme(themeOverride || savedFirmTheme || {
    primaryColor: firm.primaryColor || defaultFirmSettings.primaryColor,
    accentColor: firm.accentColor || defaultFirmSettings.accentColor,
    sidebarColor: theme.forestDark,
    sidebarTextColor: '#FFFFFF',
    buttonColor: firm.primaryColor || defaultFirmSettings.primaryColor,
    buttonTextColor: '#FFFFFF',
    backgroundColor: '#F5F2EB',
    surfaceColor: '#FFFFFF',
    cardColor: '#FFFFFF',
    headerColor: firm.primaryColor || defaultFirmSettings.primaryColor,
    headerTextColor: '#FFFFFF',
    borderColor: theme.line,
  });
  const themedFirm = {
    ...firm,
    theme: resolvedFirmTheme,
    primaryColor: resolvedFirmTheme.primaryColor || firm.primaryColor || defaultFirmSettings.primaryColor,
    accentColor: resolvedFirmTheme.accentColor || firm.accentColor || theme.gold,
  };
  const shellThemeVars = {
    '--lf-primary': themedFirm.primaryColor,
    '--lf-accent': themedFirm.accentColor,
    '--lf-sidebar': resolvedFirmTheme.sidebarColor || themedFirm.primaryColor,
    '--lf-sidebar-text': resolvedFirmTheme.sidebarTextColor || resolvedFirmTheme.onSidebarColor || '#fff',
    '--lf-on-sidebar': resolvedFirmTheme.onSidebarColor || resolvedFirmTheme.sidebarTextColor || '#fff',
    '--lf-header-bg': resolvedFirmTheme.headerColor || '#fff',
    '--lf-header-text': resolvedFirmTheme.headerTextColor || resolvedFirmTheme.onHeaderColor || theme.ink,
    '--lf-on-header': resolvedFirmTheme.onHeaderColor || resolvedFirmTheme.headerTextColor || theme.ink,
    '--lf-button': resolvedFirmTheme.buttonColor || themedFirm.accentColor,
    '--lf-button-text': resolvedFirmTheme.buttonTextColor || resolvedFirmTheme.onButtonColor || '#fff',
    '--lf-on-button': resolvedFirmTheme.onButtonColor || resolvedFirmTheme.buttonTextColor || '#fff',
    '--lf-on-primary': resolvedFirmTheme.onPrimaryColor || '#fff',
    '--lf-on-accent': resolvedFirmTheme.onAccentColor || theme.ink,
    '--lf-background': resolvedFirmTheme.backgroundColor || '#F5F2EB',
    '--lf-surface': resolvedFirmTheme.surfaceColor || '#fff',
    '--lf-text': resolvedFirmTheme.textColor || theme.ink,
    '--lf-text-muted': resolvedFirmTheme.textSecondaryColor || theme.muted,
    '--lf-border': resolvedFirmTheme.borderColor || theme.line,
    '--lf-link': resolvedFirmTheme.linkColor || themedFirm.accentColor,
    '--lf-card': resolvedFirmTheme.cardColor || '#fff',
    '--lf-card-border': resolvedFirmTheme.cardBorderColor || theme.line,
    '--lf-card-text': resolvedFirmTheme.cardTextColor || resolvedFirmTheme.textColor || theme.ink,
    '--lf-card-muted': resolvedFirmTheme.cardMutedColor || resolvedFirmTheme.textSecondaryColor || theme.muted,
    '--lf-success': resolvedFirmTheme.successColor || theme.green,
    '--lf-warning': resolvedFirmTheme.warningColor || theme.amber,
    '--lf-danger': resolvedFirmTheme.errorColor || theme.red,
    '--lf-info': resolvedFirmTheme.infoColor || theme.blue,
  };
  const role = user?.role || 'assistant';
  const visibleGroups = allowedNavGroups(role);
  const visibleViews = visibleGroups.flatMap(group => group.items.map(([label]) => label));
  const visibleViewKey = useMemo(() => visibleViews.join('|'), [visibleViews]);
  const visibleViewSet = useMemo(() => new Set(visibleViews), [visibleViewKey]);
  const timerTopbarStyle = useMemo(() => ({
    ...styles.timerBubble,
    position: 'static',
    zIndex: 'auto',
    gap: viewportWidth <= 640 ? 7 : 9,
    padding: viewportWidth <= 640 ? '8px 10px' : '8px 12px',
    borderRadius: 10,
    boxShadow: '0 2px 10px rgba(0,0,0,.16)',
    minHeight: 36,
    flexShrink: 0,
    whiteSpace: 'nowrap',
  }), [viewportWidth]);

  function navigateToView(nextView, options = {}) {
    const safeView = visibleViewSet.has(nextView) ? nextView : 'Dashboard';
    setView(safeView);
    if (safeView === 'Matters' && (options.matterId || options.section || options.clientId)) {
      setMatterFocus({ matterId: options.matterId || '', section: options.section || '', clientId: options.clientId || '', mode: options.mode || '', ts: Date.now() });
    }
    if (safeView === 'Clients' && options.clientId) setClientFocus({ clientId: options.clientId, ts: Date.now() });
    if (safeView === 'Tasks' && options.taskId) setTaskFocus({ taskId: options.taskId, ts: Date.now() });
    if (safeView === 'Deadlines' && options.appearanceId) setAppearanceFocus({ appearanceId: options.appearanceId, ts: Date.now() });
    if (safeView === 'Communications') setCommunicationFocus({ matterId: options.matterId || '', clientId: options.clientId || '', ts: Date.now() });
    if (options.hash !== false) setAppHash(staffHashFor(safeView, options), { replace: Boolean(options.replace) });
  }

  function applyStaffHash({ replace = false } = {}) {
    const route = parseStaffRoute();
    if (!route) {
      navigateToView('Dashboard', { replace: true });
      return;
    }
    const safeView = visibleViewSet.has(route.view) ? route.view : 'Dashboard';
    setView(safeView);
    if (safeView === 'Matters') {
      setMatterFocus({ matterId: route.matterId || '', section: route.section || '', clientId: route.clientId || '', mode: route.mode || '', ts: Date.now() });
    }
    if (replace || route.replace || safeView !== route.view) {
      setAppHash(staffHashFor(safeView, safeView === 'Matters' ? route : {}), { replace: true });
    }
  }

  useEffect(() => {
    async function loadPublicFirmSettings() {
      try {
        const response = await fetch(`${API_BASE}/public/branding`);
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

  // LOCAL-PILOT-FIX-14: toasts must never linger permanently. Success/info clear
  // after 4s; danger/warning stay longer (7.5s) so errors remain readable. Manual
  // close still works, and each new toast restarts the timer.
  useEffect(() => {
    if (!toast) return undefined;
    const delay = toast.type === 'danger' || toast.type === 'warning' ? 7500 : 4000;
    const timer = setTimeout(() => setToast(null), delay);
    return () => clearTimeout(timer);
  }, [toast]);

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
    function handleThemePreview(event) {
      setThemeOverride(event.detail?.theme || null);
    }
    window.addEventListener('lexflow:theme-preview', handleThemePreview);
    return () => window.removeEventListener('lexflow:theme-preview', handleThemePreview);
  }, []);

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
    if (!visibleViews.includes(view)) navigateToView('Dashboard', { replace: true });
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
    if (!authenticated || user?.role === 'client') return;
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [authenticated, user?.role, view]);

  useEffect(() => {
    if (!authenticated || !user || user.role === 'client') return undefined;
    function handleHashChange() {
      applyStaffHash();
    }
    window.addEventListener('hashchange', handleHashChange);
    window.addEventListener('popstate', handleHashChange);
    applyStaffHash({ replace: true });
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      window.removeEventListener('popstate', handleHashChange);
    };
  }, [authenticated, user?.role, visibleViewKey]);

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
    if (!authenticated || user?.role === 'client') return undefined;
    function handleSearchShortcut(event) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      setSearchOpen(Boolean(search.trim()));
    }
    window.addEventListener('keydown', handleSearchShortcut);
    return () => window.removeEventListener('keydown', handleSearchShortcut);
  }, [authenticated, user?.role, search]);

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

  useEffect(() => {
    function handleResize() {
      setViewportWidth(window.innerWidth);
    }
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

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
    setThemeOverride(null);
    clearAllLexFlowStorage();
    setLoginResetNonce(current => current + 1);
  }

  function openMatterDocumentsFromStudio() {
    navigateToView('Matters', { section: 'documents' });
  }

  if (window.location.pathname.startsWith('/invite/')) {
    return (
      <>
        <AcceptInvitation firm={themedFirm} onAccepted={acceptInvitationLogin} />
        <Toast toast={toast} onClose={() => setToast(null)} />
      </>
    );
  }

  if (window.location.pathname === '/oauth/callback') {
    return <OAuthCallback firm={themedFirm} onLogin={login} />;
  }

  async function openNotification(notification) {
    setNotificationsOpen(false);
    if (notification.matterId) {
      navigateToView('Communications', { matterId: notification.matterId, clientId: notification.clientId || '' });
      setNotifications(current => current.filter(item => item.matterId !== notification.matterId));
      try { await markNotificationsRead({ matterId: notification.matterId }); }
      catch { /* Keep navigation responsive even if read marking fails. */ }
    } else if (notification.clientId) {
      navigateToView('Communications', { clientId: notification.clientId });
      setNotifications(current => current.filter(item => item.id !== notification.id));
      try { await markNotificationsRead({ id: notification.id }); }
      catch { /* Keep navigation responsive even if read marking fails. */ }
    }
  }

  if (!authenticated) {
    return (
      <>
        <LoginPage key={`login-${loginResetNonce}`} loginResetNonce={loginResetNonce} firm={themedFirm} onLogin={login} deferredPrompt={deferredPrompt} isInstalled={isInstalled} installDismissed={installDismissed} setInstallDismissed={setInstallDismissed} onInstall={handleInstall} />
        <Toast toast={toast} onClose={() => setToast(null)} />
      </>
    );
  }

  if (user?.role === 'client') {
    return (
      <ViewErrorBoundary
        resetKey={user?.id}
        title="Something went wrong"
        message="We could not load your portal just now. Please refresh the page and try again."
        reloadLabel="Refresh portal"
      >
        <ClientApp user={user} firm={themedFirm} logout={logout} notify={setToast} toast={toast} setToast={setToast} />
      </ViewErrorBoundary>
    );
  }

  const subtitles = {
    Dashboard: 'Command center for active work, hearings, billing and firm movement.',
    Clients: 'Client records, matters, and portal access.',
    Matters: 'Matter pipeline, billing, documents, notes and invoice actions.',
    Tasks: 'Track pending and completed work across matters — add tasks, mark them done, and log time as you go.',
    Deadlines: 'Track court appearances, limitation dates, filing dates, and urgent action items.',
    Communications: 'Client messages, secure attachments and portal activity in one inbox.',
    Invoices: 'Receivables, invoice status and PDF export for client billing.',
    Reports: 'Review billing, collections, matter activity, and workload trends.',
    Performance: 'Managing partner view of advocate output, workload and court attendance.',
    'Firm Settings': 'Client-ready branding, invoice identity and contact details.',
    Users: 'Role-based access for advocates, assistants and administrators.',
    HR: 'Admin-only staff HR profile records.',
    'Connected Accounts': 'Review provider connections and imported account metadata.',
    Invitations: 'Secure client portal onboarding links and invitation status.',
    'Audit Log': 'A secure activity trail for important changes and accountability.',
    'Structured Audit': 'Structured event trail for security, access, and operational auditing.',
    'Document Studio': 'Prepare, organise, stamp, sign, and bundle matter documents.',
  };

  return (
    <div className="lf-app-shell" style={{ ...styles.shell, ...shellThemeVars }}>
      <StyleTag />
      <aside className="lf-desktop-sidebar" style={styles.sidebar}>
        <div style={styles.brandPanel}>
          <Logo firm={themedFirm} />
          <div style={{ minWidth: 0 }}>
            <div style={styles.brand}>{themedFirm.name || 'LexFlow Kenya'}</div>
            <div style={styles.brandSub}>Practice suite</div>
          </div>
        </div>

        <StaffNavigation visibleGroups={visibleGroups} openNavGroups={openNavGroups} setOpenNavGroups={setOpenNavGroups} view={view} setView={navigateToView} />

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
                  if (isAdmin) { navigateToView('Firm Settings'); }
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
                <Logo firm={themedFirm} />
                <div style={{ minWidth: 0 }}>
                  <div style={styles.brand}>{themedFirm.name || 'LexFlow Kenya'}</div>
                  <div style={styles.brandSub}>Practice suite</div>
                </div>
              </div>
              <button type="button" aria-label="Close navigation menu" title="Close navigation menu" onClick={() => setMobileMenuOpen(false)} style={styles.mobileCloseButton}><IconX size={18} stroke={1.8} aria-hidden="true" /></button>
            </div>
            <StaffNavigation visibleGroups={visibleGroups} openNavGroups={openNavGroups} setOpenNavGroups={setOpenNavGroups} view={view} setView={navigateToView} onNavigate={() => setMobileMenuOpen(false)} />
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
            <input ref={searchInputRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search matters, clients, documents..." aria-label="Search workspace" style={styles.topbarSearchInput} />
            <span className="lf-topbar-search-kbd" style={styles.topbarKbd} aria-hidden="true">Ctrl K</span>
            {searchOpen && (
              <div style={{ position: 'absolute', right: 0, left: 0, top: 'calc(100% + 6px)', maxWidth: '100%', zIndex: 2200, background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #101827)', border: '1px solid var(--lf-card-border, var(--lf-border, #E5E7EB))', borderRadius: 10, boxShadow: theme.shadowLift, padding: 0, maxHeight: 400, overflowY: 'auto', animation: 'lfDropIn .16s ease-out' }}>
                {searchLoading ? (
                  <div style={{ padding: 14, color: 'var(--lf-card-muted, var(--lf-text-muted, #697386))', textAlign: 'center' }}>Searching...</div>
                ) : searchResults.length ? (
                  searchResults.map(item => (
                    <button key={item.id} type="button" onClick={() => {
                      if (item.type === 'Matter') navigateToView('Matters', { matterId: item.matterId });
                      if (item.type === 'Client') navigateToView('Clients', { clientId: item.id });
                      if (item.type === 'Task') navigateToView('Tasks', { taskId: item.id });
                      if (item.type === 'Invoice') { if (isAdmin) navigateToView('Invoices'); else if (item.matterId) navigateToView('Matters', { matterId: item.matterId }); }
                      if (item.type === 'Appearance') navigateToView('Deadlines', { appearanceId: item.id });
                      if (item.type === 'Document' && item.matterId) navigateToView('Matters', { matterId: item.matterId });
                      if (item.type === 'Conversation') navigateToView('Communications', { matterId: item.matterId, clientId: '' });
                      setSearch(item.title || '');
                      setSearchOpen(false);
                    }} style={{ width: '100%', textAlign: 'left', border: 0, borderTop: '1px solid var(--lf-card-border, var(--lf-border, #E5E7EB))', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #101827)', padding: '10px 12px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <strong style={{ fontSize: 13 }}>{item.type}: {item.title || '-'}</strong>
                      <span style={{ color: 'var(--lf-card-muted, var(--lf-text-muted, #697386))', fontSize: 11 }}>{item.subtitle || ''}</span>
                    </button>
                  ))
                ) : (
                  <div style={{ padding: 14, color: 'var(--lf-card-muted, var(--lf-text-muted, #697386))', textAlign: 'center' }}>No results found.</div>
                )}
              </div>
            )}
          </div>
          <div className="lf-top-actions" style={styles.topActions}>
            <button
              type="button"
              className="lf-topbar-timer"
              onClick={() => navigateToView('Matters', { section: 'tasks' })}
              style={timerTopbarStyle}
              aria-label="Open time logging - log hours or start a task timer"
              title="Open time logging - log hours or start a task timer"
            >
              <span style={styles.liveDot} />
              <div>
                <div style={{ fontWeight: 700, fontSize: viewportWidth <= 640 ? 12 : 13 }}>Timekeeper</div>
                {viewportWidth > 640 && <div style={{ color: 'rgba(255,255,255,.5)', fontSize: 10.5, marginTop: 2 }}>Log billable time</div>}
              </div>
            </button>
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
            <div className="lf-page-crumb" style={styles.pageCrumb}>{themedFirm.name || 'LexFlow Kenya'}</div>
            <h1 className="lf-page-title" style={styles.pageTitle}>{navDisplayLabels[view] || view}</h1>
            <p className="lf-page-sub" style={styles.pageSub}>{subtitles[view]}</p>
          </div>

          <ViewErrorBoundary resetKey={view} onReset={() => navigateToView('Dashboard', { replace: true })}>
            {loading && !bootstrapped && <Skeleton />}
            {(!loading || bootstrapped) && view === 'Dashboard' && <Dashboard data={data} user={user} onNavigate={navigateToView} />}
            {(!loading || bootstrapped) && view === 'Clients' && <Clients clients={data.clients} matters={data.matters} canManage={canManage} isAdmin={isAdmin} reload={refresh} notify={setToast} focus={clientFocus} />}
            {(!loading || bootstrapped) && view === 'Matters' && <Matters data={data} canManage={canManage} reload={refresh} notify={setToast} focus={matterFocus} onNavigate={navigateToView} onMatterSelected={matterId => navigateToView('Matters', { matterId })} onMatterSectionChange={(matterId, section) => navigateToView('Matters', { matterId, section })} onMatterOpened={async matterId => { setNotifications(current => current.filter(item => item.matterId !== matterId)); try { await markNotificationsRead({ matterId }); } catch {} }} />}
            {(!loading || bootstrapped) && view === 'Tasks' && <Tasks data={data} canManage={canManage} reload={refresh} notify={setToast} focus={taskFocus} />}
            {(!loading || bootstrapped) && view === 'Deadlines' && <DeadlineCenter data={data} canManage={canManage} notify={setToast} focus={appearanceFocus} />}
            {(!loading || bootstrapped) && view === 'Communications' && <Communications clients={data.clients} matters={data.matters} focus={communicationFocus} notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Invoices' && <Invoices invoices={data.invoices} isAdmin={isAdmin} canManage={canManage} reload={refresh} notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Performance' && isAdmin && <AdvocatePerformance notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Reports' && isAdmin && <Reports data={data} notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Firm Settings' && isAdmin && <FirmSettings settings={themedFirm} clients={data.clients} reload={refresh} notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Connected Accounts' && <ConnectedAccounts notify={setToast} onPasswordChanged={logout} />}
            {(!loading || bootstrapped) && view === 'Users' && isAdmin && <Users clients={data.clients} notify={setToast} />}
            {(!loading || bootstrapped) && view === 'My Leave' && <MyLeave notify={setToast} />}
            {(!loading || bootstrapped) && view === 'HR' && isAdmin && <HR notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Invitations' && isAdmin && <Invitations clients={data.clients} notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Audit Log' && isAdmin && <AuditLog notify={setToast} navigate={navigateToView} />}
            {(!loading || bootstrapped) && view === 'Structured Audit' && isAdmin && <StructuredAuditLog notify={setToast} />}
            {(!loading || bootstrapped) && view === 'Document Studio' && canManage && <DocumentStudio notify={setToast} onNavigate={navigateToView} onOpenMatterDocuments={openMatterDocumentsFromStudio} />}
          </ViewErrorBoundary>
        </div>
      </main>
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
        <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 360, maxWidth: 'calc(100vw - 32px)', zIndex: 2200, background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #101827)', border: '1px solid var(--lf-card-border, var(--lf-border, #E5E7EB))', borderRadius: 10, boxShadow: theme.shadowLift, padding: 10, animation: 'lfDropIn .16s ease-out' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', padding: '4px 4px 10px' }}>
            <strong>Client activity</strong>
            <span style={styles.mutedText}>{count} unread</span>
          </div>
          {count ? notifications.map(item => (
            <button key={item.id} type="button" onClick={() => onOpen(item)} style={{ width: '100%', textAlign: 'left', border: 0, borderTop: '1px solid var(--lf-card-border, var(--lf-border, #E5E7EB))', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #101827)', padding: '10px 4px', cursor: 'pointer' }}>
              <strong>{item.title || 'Client activity'}</strong>
              <div style={{ color: 'var(--lf-card-muted, var(--lf-text-muted, #697386))', fontSize: 12, marginTop: 3 }}>{item.clientName || 'Client'} / {item.matterTitle || item.reference || 'Matter'}</div>
              <div style={{ color: 'var(--lf-card-text, #101827)', fontSize: 12, marginTop: 5 }}>{item.body || '-'}</div>
              <div style={{ color: 'var(--lf-card-muted, var(--lf-text-muted, #697386))', fontSize: 11, marginTop: 5 }}>{item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}</div>
            </button>
          )) : (
            <div style={{ padding: 14, color: 'var(--lf-card-muted, var(--lf-text-muted, #697386))', textAlign: 'center' }}>No unread client messages or uploads.</div>
          )}
        </div>
      )}
    </div>
  );
}

