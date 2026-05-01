import { useState } from 'react';
import { login } from '../api';

const C = {
  bg: '#F4F6F8',
  sidebar: '#0F1B33',
  panel: '#FFFFFF',
  border: '#E5E7EB',
  navy: '#1B3A5C',
  gold: '#D4A34A',
  text: '#111827',
  muted: '#6B7280',
  danger: '#B91C1C',
  dangerBg: '#FEF2F2',
};

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('admin@lexflow.co.ke');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await login({ email, password });
      onLogin(session);
    } catch (err) {
      setError(err.message || 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.aura} />
      <form onSubmit={submit} style={styles.card}>
        <div style={styles.brandRow}>
          <div style={styles.logo}>LF</div>
          <div>
            <h1 style={styles.title}>LexFlow Kenya</h1>
            <p style={styles.subtitle}>Secure law practice management</p>
          </div>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <label style={styles.label}>Email</label>
        <input value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" style={styles.input} />

        <label style={styles.label}>Password</label>
        <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" style={styles.input} />

        <button type="submit" disabled={busy || !email || !password} style={{ ...styles.button, opacity: busy ? 0.65 : 1 }}>
          {busy ? 'Signing in...' : 'Sign In'}
        </button>

        <div style={styles.hint}>Default admin: admin@lexflow.co.ke / admin123</div>
      </form>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: `linear-gradient(135deg, ${C.sidebar} 0%, #182C4B 45%, ${C.bg} 45%)`, fontFamily: 'Inter, Segoe UI, system-ui, sans-serif', position: 'relative', overflow: 'hidden' },
  aura: { position: 'absolute', width: 420, height: 420, borderRadius: 999, background: 'rgba(212,163,74,.16)', top: -120, right: -80 },
  card: { width: 410, maxWidth: '100%', boxSizing: 'border-box', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 28, boxShadow: '0 26px 70px rgba(15,27,51,.22)', zIndex: 1 },
  brandRow: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 },
  logo: { width: 52, height: 52, borderRadius: 14, background: C.gold, color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 900, boxShadow: '0 12px 30px rgba(212,163,74,.28)' },
  title: { margin: 0, color: C.text, fontSize: 22, letterSpacing: 0 },
  subtitle: { margin: '4px 0 0', color: C.muted, fontSize: 13 },
  label: { display: 'block', margin: '14px 0 6px', color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' },
  input: { width: '100%', boxSizing: 'border-box', border: `1px solid ${C.border}`, borderRadius: 6, padding: '10px 11px', font: '13px inherit', outlineColor: C.gold },
  button: { width: '100%', marginTop: 18, border: 0, borderRadius: 8, padding: '11px 13px', background: C.navy, color: '#fff', fontWeight: 800, cursor: 'pointer' },
  error: { padding: '10px 12px', borderRadius: 8, background: C.dangerBg, color: C.danger, border: '1px solid #FECACA', fontSize: 13, fontWeight: 700, marginBottom: 12 },
  hint: { marginTop: 14, color: C.muted, fontSize: 12 },
};
