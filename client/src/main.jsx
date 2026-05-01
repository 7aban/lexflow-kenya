import React, { Suspense, lazy, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Login from './components/Login.jsx';

const App = lazy(() => import('./App.jsx'));

function readStoredSession() {
  try {
    const session = JSON.parse(localStorage.getItem('lexflowSession') || 'null');
    if (session?.token) return session;
    const token = localStorage.getItem('lexflowToken');
    return token ? { token } : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  localStorage.setItem('lexflowSession', JSON.stringify(session));
  localStorage.setItem('lexflowToken', session.token);
}

function StartupNotice({ children, tone = 'info' }) {
  const colors = tone === 'error'
    ? { bg: '#FEF2F2', text: '#991B1B', border: '#FECACA' }
    : { bg: '#EFF6FF', text: '#1D4ED8', border: '#BFDBFE' };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#F3F4F6', color: colors.text, font: '14px system-ui, sans-serif' }}>
      <div style={{ padding: 14, borderRadius: 8, background: colors.bg, border: `1px solid ${colors.border}` }}>{children}</div>
    </div>
  );
}

function LoginFallback({ error, onLogin }) {
  return (
    <>
      <Login onLogin={onLogin} />
      {error && (
        <div style={{ position: 'fixed', left: 16, right: 16, bottom: 16, padding: 12, borderRadius: 8, background: '#FEF2F2', color: '#991B1B', border: '1px solid #FECACA', font: '13px system-ui, sans-serif' }}>
          LexFlow recovered from a startup error. Sign in again to continue.
        </div>
      )}
    </>
  );
}

class StartupBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    try {
      localStorage.removeItem('lexflowSession');
      localStorage.removeItem('lexflowToken');
    } catch {
      // Ignore storage cleanup failures; the fallback still renders.
    }
    return { error };
  }

  componentDidCatch(error) {
    console.error('LexFlow startup error:', error);
  }

  render() {
    if (this.state.error) return <LoginFallback error={this.state.error} onLogin={this.props.onLogin} />;
    return this.props.children;
  }
}

function Root() {
  const [session, setSession] = useState(readStoredSession);

  const handleLogin = (nextSession) => {
    saveSession(nextSession);
    setSession(nextSession);
  };

  if (!session?.token) return <LoginFallback onLogin={handleLogin} />;

  return (
    <StartupBoundary onLogin={handleLogin}>
      <Suspense fallback={<StartupNotice>Loading LexFlow...</StartupNotice>}>
        <App />
      </Suspense>
    </StartupBoundary>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  document.body.innerHTML = '<div style="padding:24px;font-family:system-ui,sans-serif;color:#991B1B">LexFlow could not start because #root is missing from index.html.</div>';
} else {
  createRoot(rootElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
}
