import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Login from './components/Login.jsx';

function LoginFallback({ error }) {
  const handleLogin = (session) => {
    localStorage.setItem('lexflowSession', JSON.stringify(session));
    localStorage.setItem('lexflowToken', session.token);
    window.location.reload();
  };

  return (
    <>
      <Login onLogin={handleLogin} />
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
    if (this.state.error) return <LoginFallback error={this.state.error} />;
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  document.body.innerHTML = '<div style="padding:24px;font-family:system-ui,sans-serif;color:#991B1B">LexFlow could not start because #root is missing from index.html.</div>';
} else {
  createRoot(rootElement).render(
    <React.StrictMode>
      <StartupBoundary>
        <App />
      </StartupBoundary>
    </React.StrictMode>
  );
}
