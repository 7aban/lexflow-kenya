import { useEffect, useState } from 'react';
import { API_BASE } from '../lib/apiClient.js';
import { styles, StyleTag, theme } from '../theme.jsx';
import { Alert, Field } from './ui.jsx';

export default function LoginPage({ firm, onLogin }) {
  const [mode, setMode] = useState('staff');
  const [email, setEmail] = useState('admin@lexflow.co.ke');
  const [password, setPassword] = useState('admin123');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firmName = firm?.name || 'LexFlow Kenya';

  useEffect(() => {
    if (mode === 'staff') {
      setEmail(current => current || 'admin@lexflow.co.ke');
      setPassword(current => current || 'admin123');
    } else {
      setEmail('');
      setPassword('');
    }
    setError('');
  }, [mode]);

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

  return (
    <div style={{ ...styles.loginShell, '--lf-primary': firm?.primaryColor || theme.navy800, '--lf-accent': firm?.accentColor || theme.gold }}>
      <StyleTag />
      <div style={styles.loginEditorial}>
        <div style={styles.loginBadge}>Kenyan law practice OS</div>
        <h1>Move matters from intake to invoice with calm control.</h1>
        <p>{firmName} brings clients, matters, deadlines, billing and documents into one focused workspace for modern chambers.</p>
        <div style={styles.loginMetricRow}>
          <div><strong>LSK</strong><span>ready reports</span></div>
          <div><strong>16%</strong><span>VAT invoices</span></div>
          <div><strong>JWT</strong><span>secure access</span></div>
        </div>
      </div>
      <form onSubmit={submit} style={styles.loginCard}>
        <div style={styles.loginLogo}>{firm?.logo ? <img src={firm.logo} alt={`${firmName} logo`} style={styles.logoImage} /> : '⚖'}</div>
        <h2>{mode === 'client' ? 'Client Portal' : 'Welcome back'}</h2>
        <p>{mode === 'client' ? `Access your ${firmName} matter portal.` : `Sign in to your ${firmName} workspace.`}</p>
        <div style={styles.loginModeSwitch} role="tablist" aria-label="Login type">
          <button type="button" onClick={() => setMode('staff')} style={{ ...styles.loginModeButton, ...(mode === 'staff' ? styles.loginModeActive : {}) }}>Staff Login</button>
          <button type="button" onClick={() => setMode('client')} style={{ ...styles.loginModeButton, ...(mode === 'client' ? styles.loginModeActive : {}) }}>Client Portal</button>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Email"><input style={styles.input} value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" /></Field>
        <Field label="Password"><input style={styles.input} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></Field>
        <button disabled={busy} style={{ ...styles.primaryButton, width: '100%', marginTop: 16 }}>{busy ? 'Signing in...' : mode === 'client' ? 'Enter client portal' : 'Sign in securely'}</button>
        {mode === 'staff' && <div style={styles.loginHint}>admin@lexflow.co.ke / admin123</div>}
      </form>
    </div>
  );
}

