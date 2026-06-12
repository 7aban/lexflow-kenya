import { Component } from 'react';
import { styles, theme } from '../theme.jsx';

export default class ViewErrorBoundary extends Component {
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

    const title = this.props.title || 'Something went wrong in this view';
    const message = this.props.message || 'The rest of LexFlow is still available. Return to Dashboard or reload the app.';
    const resetLabel = this.props.resetLabel || 'Return to Dashboard';
    const reloadLabel = this.props.reloadLabel || 'Reload app';

    return (
      <section role="alert" style={{ background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, boxShadow: theme.shadow, padding: 24, display: 'grid', gap: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 6px', fontSize: 18, color: theme.ink }}>{title}</h2>
          <p style={{ margin: 0, color: theme.muted }}>{message}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {this.props.onReset && (
            <button type="button" style={styles.primaryButton} onClick={() => { this.setState({ error: null }); this.props.onReset?.(); }}>{resetLabel}</button>
          )}
          <button type="button" style={this.props.onReset ? styles.ghostButton : styles.primaryButton} onClick={() => window.location.reload()}>{reloadLabel}</button>
        </div>
      </section>
    );
  }
}
