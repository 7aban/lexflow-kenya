import { useEffect, useState } from 'react';
import { IconScale, IconLock, IconShieldCheck, IconServer, IconEye, IconEyeOff } from '@tabler/icons-react';
import { API_BASE } from '../lib/apiClient.js';
import { defaultFirmSettings, resolveReadableTheme, styles, StyleTag, theme } from '../theme.jsx';
import { Alert } from './ui.jsx';

function GoogleLogo() {
  return (
    <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true" style={styles.loginOauthIcon}>
      <path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.583-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.346l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
    </svg>
  );
}

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" style={styles.loginOauthIcon}>
      <rect x="0" y="0" width="7.2" height="7.2" fill="#F25022"/>
      <rect x="8.8" y="0" width="7.2" height="7.2" fill="#7FBA00"/>
      <rect x="0" y="8.8" width="7.2" height="7.2" fill="#00A4EF"/>
      <rect x="8.8" y="8.8" width="7.2" height="7.2" fill="#FFB900"/>
    </svg>
  );
}

function OAuthDivider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0 10px' }}>
      <div style={{ flex: 1, height: 1, background: theme.line }} />
      <span style={{ fontSize: 11, color: theme.muted, textTransform: 'uppercase', letterSpacing: 1 }}>or continue with</span>
      <div style={{ flex: 1, height: 1, background: theme.line }} />
    </div>
  );
}

function OAuthButton({ provider, onClick, disabled }) {
  return (
    <button type="button" onClick={onClick} className="lf-login-oauth" style={{ ...styles.loginOauthButton, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }} disabled={disabled}>
      {provider === 'google' ? <GoogleLogo /> : <MicrosoftLogo />}
      <span>{provider === 'google' ? 'Continue with Google' : 'Continue with Microsoft'}</span>
    </button>
  );
}

function LoginField({ label, children }) {
  return (
    <label style={styles.loginField}>
      <span style={styles.loginLabel}>{label}</span>
      {children}
    </label>
  );
}

export default function LoginPage({ firm, onLogin, deferredPrompt, isInstalled, installDismissed, setInstallDismissed, onInstall }) {
  const [mode, setMode] = useState('staff');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => { setPassword(''); }, []);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthEnabled, setOauthEnabled] = useState(false);
  const firmName = firm?.displayName || firm?.firmName || firm?.appName || firm?.name || defaultFirmSettings.name;
  const isDev = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV;

  useEffect(() => {
    async function checkOAuth() {
      try {
        const res = await fetch(`${API_BASE}/auth/oauth/availability`);
        if (res.ok) {
          const data = await res.json();
          setOauthEnabled(data.google || data.microsoft);
        } else {
          setOauthEnabled(false);
        }
      } catch {
        setOauthEnabled(false);
      }
    }
    if (mode === 'staff') checkOAuth();
  }, [mode]);

  function handleModeChange(nextMode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setEmail('');
    setPassword('');
    setError('');
    setShowPassword(false);
  }

  async function handleOAuth(provider) {
    setOauthBusy(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/auth/oauth/${provider}/start`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'OAuth not available');
      window.location.href = data.authorizationUrl;
    } catch (err) {
      setError(err.message || 'OAuth login failed');
    } finally {
      setOauthBusy(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/auth/${mode === 'client' ? 'client-login' : 'login'}`, {
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

  const modeCopy = mode === 'client'
    ? { title: 'Client Portal', hint: 'Access your case files, notices, invoices and shared documents.', placeholder: 'client@example.com', button: 'Enter client portal' }
    : { title: 'Welcome back', hint: 'Enter your advocate credentials to manage the firm workspace.', placeholder: 'advocate@yourfirm.co.ke', button: 'Sign in securely' };

  const resolvedLoginTheme = resolveReadableTheme(firm?.theme || {
    primaryColor: firm?.primaryColor || defaultFirmSettings.primaryColor,
    accentColor: firm?.accentColor || defaultFirmSettings.accentColor,
    sidebarColor: theme.forestDark,
    sidebarTextColor: '#FFFFFF',
    buttonColor: firm?.primaryColor || defaultFirmSettings.primaryColor,
    buttonTextColor: '#FFFFFF',
    backgroundColor: theme.cream,
    surfaceColor: '#FFFFFF',
    cardColor: '#FFFFFF',
    headerColor: firm?.primaryColor || defaultFirmSettings.primaryColor,
    headerTextColor: '#FFFFFF',
    borderColor: theme.line,
    linkColor: firm?.accentColor || defaultFirmSettings.accentColor,
  });
  const primaryColor = resolvedLoginTheme.primaryColor || defaultFirmSettings.primaryColor;
  const accentColor = resolvedLoginTheme.accentColor || defaultFirmSettings.accentColor;
  const loginThemeVars = {
    '--lf-primary': primaryColor,
    '--lf-accent': accentColor,
    '--lf-background': resolvedLoginTheme.backgroundColor || theme.cream,
    '--lf-surface': resolvedLoginTheme.surfaceColor || '#FFFFFF',
    '--lf-card': resolvedLoginTheme.cardColor || '#FFFFFF',
    '--lf-card-border': resolvedLoginTheme.cardBorderColor || resolvedLoginTheme.borderColor || theme.line,
    '--lf-card-text': resolvedLoginTheme.cardTextColor || resolvedLoginTheme.textColor || theme.ink,
    '--lf-card-muted': resolvedLoginTheme.cardMutedColor || resolvedLoginTheme.textSecondaryColor || theme.muted,
    '--lf-border': resolvedLoginTheme.borderColor || theme.line,
    '--lf-link': resolvedLoginTheme.linkColor || accentColor,
    '--lf-on-primary': resolvedLoginTheme.onPrimaryColor || '#FFFFFF',
    '--lf-on-accent': resolvedLoginTheme.onAccentColor || theme.ink,
    '--lf-button': resolvedLoginTheme.buttonColor || primaryColor,
    '--lf-button-text': resolvedLoginTheme.buttonTextColor || resolvedLoginTheme.onButtonColor || '#FFFFFF',
  };
  const staffAuxHidden = mode !== 'staff';

  return (
    <div className="lf-login-root" style={loginThemeVars}>
      <StyleTag />
      <div className="lf-login-split" style={styles.loginSplit}>
        <div className="lf-login-brand" style={styles.loginBrand}>
          <div style={{ maxWidth: 460, display: 'grid', gap: 28, justifyItems: 'center', textAlign: 'center' }}>
            <div style={styles.loginBrandLogo}>
              {firm?.logo ? <img src={firm.logo} alt={`${firmName} logo`} style={styles.logoImage} /> : <IconScale size={28} stroke={1.8} color="#fff" />}
            </div>
            <div>
              <h1 style={styles.loginBrandName}>{firmName}</h1>
              <div style={styles.loginBrandType}>Powered by LexFlow</div>
              <div style={styles.loginBrandRule} />
              <p style={styles.loginBrandTagline}>
                A secure workspace for managing client matters, court appearances, billing and the complete legal lifecycle of every file at the firm.
              </p>
            </div>
            <div className="lf-login-brand-trust lf-login-trust-row" style={styles.loginTrustRow}>
              <div style={styles.loginTrustItem}>
                <span style={styles.loginTrustIcon}><IconLock size={15} stroke={1.8} /></span>
                <span>End-to-end encrypted</span>
              </div>
              <div style={styles.loginTrustItem}>
                <span style={styles.loginTrustIcon}><IconShieldCheck size={15} stroke={1.8} /></span>
                <span>Role-based access</span>
              </div>
              <div style={styles.loginTrustItem}>
                <span style={styles.loginTrustIcon}><IconServer size={15} stroke={1.8} /></span>
                <span>Resilient deployment</span>
              </div>
            </div>
          </div>
        </div>
        <div className="lf-login-card-wrap" style={styles.loginCardWrap}>
          <form onSubmit={submit} className="lf-login-card-form" style={styles.loginCardForm}>
            <div style={{ display: 'grid', gap: 14, marginBottom: 22 }}>
              <div style={styles.portalTabs} role="tablist" aria-label="Login type">
                <button type="button" role="tab" aria-selected={mode === 'staff'} onClick={() => handleModeChange('staff')} className="lf-login-portal-tab" style={{ ...styles.portalTab, ...(mode === 'staff' ? styles.portalTabActive : {}) }}>Staff Login</button>
                <button type="button" role="tab" aria-selected={mode === 'client'} onClick={() => handleModeChange('client')} className="lf-login-portal-tab" style={{ ...styles.portalTab, ...(mode === 'client' ? styles.portalTabActive : {}) }}>Client Portal</button>
              </div>
              <h2 style={styles.loginCardTitle}>{modeCopy.title}</h2>
              <p style={{ margin: 0, color: 'var(--lf-card-muted, #6B6B66)', fontSize: 13, lineHeight: 1.5 }}>{modeCopy.hint}</p>
            </div>
            {error && <Alert tone="danger">{error}</Alert>}
            {oauthBusy && <Alert tone="info">Redirecting to provider...</Alert>}
            {!isInstalled && !installDismissed && (
              <div style={{ ...styles.loginInstallNote, marginBottom: 14 }}>
                <span style={{ flex: 1 }}>
                  {deferredPrompt
                    ? 'Install LexFlow for offline access and quick launch.'
                    : (typeof window !== 'undefined' && window.navigator && /iPad|iPhone|iPod/.test(navigator.userAgent)
                      ? 'Install LexFlow from the Share menu for the best experience.'
                      : 'Install LexFlow for quick access.')}
                </span>
                {deferredPrompt && (
                  <button type="button" onClick={onInstall} style={styles.loginInstallActionButton}>Install</button>
                )}
                <button type="button" onClick={() => setInstallDismissed(true)} style={styles.loginInstallDismiss} title="Dismiss" aria-label="Dismiss install prompt">&times;</button>
              </div>
            )}
            <div style={{ display: 'grid', gap: 14 }}>
              <LoginField label="Email">
                <input className="lf-login-input" style={styles.loginInput} value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" placeholder={modeCopy.placeholder} />
              </LoginField>
              <LoginField label="Password">
                <div style={{ position: 'relative' }}>
                  <input className="lf-login-input" style={{ ...styles.loginInput, paddingRight: 40 }} type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder={mode === 'client' ? 'Portal password' : 'Workspace password'} />
                  <button type="button" tabIndex={-1} aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(s => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', border: 0, background: 'none', cursor: 'pointer', padding: 4, color: 'var(--lf-card-muted, #6B6B66)', display: 'flex', alignItems: 'center' }}>
                    {showPassword ? <IconEyeOff size={18} /> : <IconEye size={18} />}
                  </button>
                </div>
              </LoginField>
            </div>
            <button disabled={busy} className="lf-login-submit" style={{ ...styles.loginPrimaryButton, width: '100%', marginTop: 18 }}>{busy ? 'Signing in...' : modeCopy.button}</button>
            <div
              aria-hidden={staffAuxHidden ? 'true' : 'false'}
              style={{
                visibility: staffAuxHidden ? 'hidden' : 'visible',
                pointerEvents: staffAuxHidden ? 'none' : 'auto',
                userSelect: staffAuxHidden ? 'none' : 'auto',
              }}
            >
              <OAuthDivider />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <OAuthButton provider="google" onClick={() => oauthEnabled && handleOAuth('google')} disabled={!oauthEnabled || oauthBusy} />
                <OAuthButton provider="microsoft" onClick={() => oauthEnabled && handleOAuth('microsoft')} disabled={!oauthEnabled || oauthBusy} />
              </div>
              {oauthEnabled ? (
                <div style={{ fontSize: 11, color: 'var(--lf-card-muted, #6B6B66)', textAlign: 'center', marginTop: 8 }}>For authorised firm users only.</div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--lf-card-muted, #6B6B66)', textAlign: 'center', marginTop: 8, lineHeight: 1.5 }}>OAuth is not configured for this local pilot. Use email and password.</div>
              )}
              {isDev && <div style={styles.loginDemoHint}>Use the seeded demo credentials from the project README / seed output.</div>}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
