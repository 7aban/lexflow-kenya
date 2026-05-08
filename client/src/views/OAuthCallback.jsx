import { useEffect, useState } from 'react';
import { IconScale } from '@tabler/icons-react';
import { saveSession } from '../lib/apiClient.js';
import { styles, StyleTag, theme } from '../theme.jsx';
import { Alert } from '../components/ui.jsx';

export default function OAuthCallback({ firm, onLogin }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errorParam = params.get('error');
    const tokenParam = params.get('token');
    const userParam = params.get('user');

    if (errorParam) {
      setError(decodeURIComponent(errorParam));
      setBusy(false);
      return;
    }

    if (!tokenParam || !userParam) {
      setError('OAuth login did not complete. Try again.');
      setBusy(false);
      return;
    }

    try {
      const token = decodeURIComponent(tokenParam);
      const user = JSON.parse(decodeURIComponent(userParam));
      const sessionData = { token, user };
      saveSession(sessionData);

      window.history.replaceState({}, '', '/');
      onLogin(sessionData);
    } catch {
      setError('OAuth login failed. Try again.');
      setBusy(false);
    }
  }, [onLogin]);

  const firmName = firm?.name || 'LexFlow Kenya';

  if (busy) {
    return (
      <div style={{ ...styles.loginShell, '--lf-primary': firm?.primaryColor || theme.navy800, '--lf-accent': firm?.accentColor || theme.gold }}>
        <StyleTag />
        <div style={{ ...styles.loginCard, textAlign: 'center' }}>
          <div style={{ ...styles.loginLogo, marginBottom: 16 }}>{firm?.logo ? <img src={firm.logo} alt={`${firmName} logo`} style={styles.logoImage} /> : <IconScale size={28} />}</div>
          <h1 style={{ margin: '0 0 8px', fontSize: 20, color: theme.ink }}>Completing sign in...</h1>
          <p style={{ margin: 0, color: theme.muted, fontSize: 14 }}>Please wait while we finish authenticating you.</p>
          <div style={{ marginTop: 20, width: 32, height: 32, border: `3px solid ${theme.line}`, borderTopColor: theme.navy800, borderRadius: '50%', margin: '20px auto 0', animation: 'lfSpin 0.8s linear infinite' }} />
          <style>{`@keyframes lfSpin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...styles.loginShell, '--lf-primary': firm?.primaryColor || theme.navy800, '--lf-accent': firm?.accentColor || theme.gold }}>
      <StyleTag />
      <div style={{ ...styles.loginCard, textAlign: 'center' }}>
        <div style={{ ...styles.loginLogo, marginBottom: 16 }}>{firm?.logo ? <img src={firm.logo} alt={`${firmName} logo`} style={styles.logoImage} /> : <IconScale size={28} />}</div>
        <h1 style={{ margin: '0 0 8px', fontSize: 20, color: theme.ink }}>Sign in failed</h1>
        <Alert tone="danger">{error}</Alert>
        <button
          type="button"
          onClick={() => { window.location.href = '/'; }}
          style={{ ...styles.primaryButton, marginTop: 16, width: '100%' }}
        >
          Return to login
        </button>
      </div>
    </div>
  );
}
