import { useEffect, useState } from 'react';
import { acceptInvitation, verifyInvitation } from '../lib/apiClient.js';
import { styles, StyleTag, theme } from '../theme.jsx';
import { Alert, Field } from '../components/ui.jsx';

function tokenFromPath() {
  return window.location.pathname.split('/invite/')[1]?.split('/')[0] || '';
}

export default function AcceptInvitation({ firm, onAccepted }) {
  const [token] = useState(tokenFromPath);
  const [email, setEmail] = useState('');
  const [form, setForm] = useState({ fullName: '', password: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firmName = firm?.name || 'LexFlow Kenya';

  useEffect(() => {
    async function verify() {
      try {
        const result = await verifyInvitation(token);
        setEmail(result.email || '');
      } catch (err) {
        setError(err.message || 'Invitation could not be verified');
      } finally {
        setLoading(false);
      }
    }
    verify();
  }, [token]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await acceptInvitation(token, form);
      onAccepted(session);
      window.history.replaceState({}, '', '/');
    } catch (err) {
      setError(err.message || 'Unable to accept invitation');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...styles.loginShell, '--lf-primary': firm?.primaryColor || theme.navy800, '--lf-accent': firm?.accentColor || theme.gold }}>
      <StyleTag />
      <form onSubmit={submit} style={styles.loginCard}>
        <div style={{ display: 'grid', placeItems: 'center', textAlign: 'center', gap: 8 }}>
          <div style={styles.loginLogo}>{firm?.logo ? <img src={firm.logo} alt={`${firmName} logo`} style={styles.logoImage} /> : 'LF'}</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, color: theme.ink }}>{firmName}</h1>
            <p style={{ margin: '5px 0 0', color: theme.muted }}>Set your password to activate your secure client portal.</p>
          </div>
        </div>
        {loading && <div style={{ ...styles.alert, marginTop: 16 }}>Checking invitation...</div>}
        {!loading && error && (
          <>
            <Alert tone="danger">{error}</Alert>
            <button type="button" style={{ ...styles.ghostButton, width: '100%', marginTop: 14 }} onClick={() => { window.history.replaceState({}, '', '/'); window.location.reload(); }}>Back to login</button>
          </>
        )}
        {!loading && !error && (
          <>
            <Field label="Email">
              <input readOnly style={styles.input} value={email} />
            </Field>
            <Field label="Full Name">
              <input required style={styles.input} value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} placeholder="Your full name" />
            </Field>
            <Field label="Password">
              <input required minLength={6} type="password" style={styles.input} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="At least 6 characters" />
            </Field>
            <button disabled={busy} style={{ ...styles.primaryButton, width: '100%', marginTop: 16 }}>{busy ? 'Activating...' : 'Set password and enter portal'}</button>
          </>
        )}
      </form>
    </div>
  );
}
