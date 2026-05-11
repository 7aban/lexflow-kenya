import { useEffect, useState } from 'react';
import { IconScale } from '@tabler/icons-react';
import { API_BASE } from '../lib/apiClient.js';
import { styles, StyleTag, theme } from '../theme.jsx';
import { Alert, Field } from './ui.jsx';

function OAuthDivider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '14px 0 8px' }}>
      <div style={{ flex: 1, height: 1, background: theme.line }} />
      <span style={{ fontSize: 12, color: theme.muted }}>or continue with</span>
      <div style={{ flex: 1, height: 1, background: theme.line }} />
    </div>
  );
}

function OAuthButton({ provider, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...styles.ghostButton,
        width: '100%',
        padding: '9px 14px',
        fontSize: 13,
        border: `1px solid ${theme.line}`,
        borderRadius: 8,
        cursor: 'pointer',
        background: '#fff',
        color: theme.ink,
        fontWeight: 500,
      }}
    >
      {provider === 'google' ? 'Continue with Google' : 'Continue with Microsoft'}
    </button>
  );
}

export default function LoginPage({ firm, onLogin, deferredPrompt, isInstalled, installDismissed, setInstallDismissed, onInstall }) {
  const [mode, setMode] = useState('staff');
  const [email, setEmail] = useState('admin@lexflow.co.ke');
  const [password, setPassword] = useState('password123');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthEnabled, setOauthEnabled] = useState(false);
  const firmName = firm?.name || 'LexFlow Kenya';

  useEffect(() => {
    async function checkOAuth() {
      try {
        const res = await fetch(`${API_BASE}/auth/oauth/google/start`);
        if (res.ok || res.status === 503) {
          setOauthEnabled(res.status !== 503);
        }
      } catch {
        setOauthEnabled(false);
      }
    }
    if (mode === 'staff') checkOAuth();
  }, [mode]);

  useEffect(() => {
    if (mode === 'staff') {
      setEmail(current => current || 'admin@lexflow.co.ke');
      setPassword(current => current || 'password123');
    } else {
      setEmail('');
      setPassword('');
    }
    setError('');
  }, [mode]);

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
    : { title: 'Welcome back', hint: 'Enter your advocate credentials to manage the firm workspace.', placeholder: 'admin@lexflow.co.ke', button: 'Sign in securely' };

  const primaryColor = firm?.primaryColor || theme.navy800;
  const accentColor = firm?.accentColor || theme.gold;

  return (
    <div className="lf-login-root" style={{ '--lf-primary': primaryColor, '--lf-accent': accentColor }}>
      <StyleTag />
      <div className="lf-login-split" style={styles.loginSplit}>
        <div className="lf-login-brand" style={styles.loginBrand}>
          <div style={{ maxWidth: 360, display: 'grid', gap: 28 }}>
            <div style={{ display: 'grid', gap: 20, textAlign: 'center' }}>
              <div style={styles.loginBrandLogo}>
                {firm?.logo ? <img src={firm.logo} alt={`${firmName} logo`} style={styles.logoImage} /> : <IconScale size={36} />}
              </div>
              <div>
                <h1 style={styles.loginBrandName}>{firmName}</h1>
                <p style={styles.loginBrandTagline}>Kenyan legal practice command centre</p>
              </div>
            </div>
            <div className="lf-login-brand-features" style={styles.loginBrandFeatures}>
              <div style={styles.loginFeatureItem}>Matter management</div>
              <div style={styles.loginFeatureItem}>Client portal</div>
              <div style={styles.loginFeatureItem}>Court deadlines</div>
              <div style={styles.loginFeatureItem}>Invoice & billing</div>
            </div>
            <div>
              <div style={styles.loginBrandDivider} />
              <p style={styles.loginBrandFooter}>Secure access for authorised firm users and clients</p>
            </div>
          </div>
        </div>
        <div className="lf-login-card-wrap" style={styles.loginCardWrap}>
          <form onSubmit={submit} style={styles.loginCardForm}>
            <div style={{ display: 'grid', gap: 16, marginBottom: 24 }}>
              <div style={styles.loginModeSwitch} role="tablist" aria-label="Login type">
                <button type="button" onClick={() => setMode('staff')} style={{ ...styles.loginModeButton, ...(mode === 'staff' ? styles.loginModeActive : {}) }}>Staff Login</button>
                <button type="button" onClick={() => setMode('client')} style={{ ...styles.loginModeButton, ...(mode === 'client' ? styles.loginModeActive : {}) }}>Client Portal</button>
              </div>
              <h2 style={styles.loginCardTitle}>{modeCopy.title}</h2>
              <p style={{ margin: 0, color: theme.muted, fontSize: 13 }}>{modeCopy.hint}</p>
            </div>
            {error && <Alert tone="danger">{error}</Alert>}
            {oauthBusy && <Alert tone="info">Redirecting to provider...</Alert>}
            {!isInstalled && !installDismissed && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, border: '1px solid #E5E7EB', background: '#F9FAFB', fontSize: 12, color: '#4B5563' }}>
                <span style={{ flex: 1 }}>
                  {deferredPrompt
                    ? 'Install LexFlow for offline access and quick launch.'
                    : (typeof window !== 'undefined' && window.navigator && /iPad|iPhone|iPod/.test(navigator.userAgent)
                      ? 'Install LexFlow from the Share menu for the best experience.'
                      : 'Install LexFlow for quick access.')}
                </span>
                {deferredPrompt && (
                  <button type="button" onClick={onInstall} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: '#0F1B33', color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>Install</button>
                )}
                <button type="button" onClick={() => setInstallDismissed(true)} style={{ padding: '4px 6px', borderRadius: 4, border: 'none', background: 'transparent', color: '#9CA3AF', fontSize: 14, cursor: 'pointer', lineHeight: 1 }} title="Dismiss">&times;</button>
              </div>
            )}
            <Field label="Email">
              <input style={styles.input} value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" placeholder={modeCopy.placeholder} />
            </Field>
            <Field label="Password">
              <input style={styles.input} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder={mode === 'client' ? 'Portal password' : 'Workspace password'} />
            </Field>
            <button disabled={busy} style={{ ...styles.primaryButton, width: '100%', marginTop: 16, padding: '10px 16px', fontSize: 14 }}>{busy ? 'Signing in...' : modeCopy.button}</button>
            {mode === 'staff' && oauthEnabled && (
              <>
                <OAuthDivider />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
                  <OAuthButton provider="google" onClick={() => handleOAuth('google')} />
                  <OAuthButton provider="microsoft" onClick={() => handleOAuth('microsoft')} />
                </div>
                <div style={{ fontSize: 11, color: theme.muted, textAlign: 'center', marginTop: 4 }}>For authorised firm users only.</div>
              </>
            )}
            {mode === 'staff' && <div style={styles.loginHint}>admin@lexflow.co.ke / password123</div>}
          </form>
        </div>
      </div>
    </div>
  );
}
