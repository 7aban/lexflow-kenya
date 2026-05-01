const tones = {
  success: { bg: '#ECFDF5', border: '#A7F3D0', text: '#047857' },
  danger: { bg: '#FEF2F2', border: '#FECACA', text: '#B91C1C' },
  warning: { bg: '#FFFBEB', border: '#FDE68A', text: '#B45309' },
  info: { bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8' },
};

export default function Toast({ toast, onClose }) {
  if (!toast) return null;
  const c = tones[toast.type] || tones.info;
  return (
    <div style={{ ...styles.toast, background: c.bg, borderColor: c.border, color: c.text }} role="status" aria-live="polite">
      <div style={styles.message}>{toast.message}</div>
      <button type="button" aria-label="Dismiss notification" onClick={onClose} style={{ ...styles.close, color: c.text }}>x</button>
    </div>
  );
}

const styles = {
  toast: { position: 'fixed', top: 22, right: 22, zIndex: 2000, width: 360, maxWidth: 'calc(100vw - 36px)', border: '1px solid', borderRadius: 10, boxShadow: '0 14px 35px rgba(15,27,51,0.18)', padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'flex-start', fontFamily: 'Inter, Segoe UI, system-ui, sans-serif' },
  message: { flex: 1, fontSize: 13, lineHeight: 1.5, fontWeight: 700 },
  close: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, lineHeight: 1, fontWeight: 900 },
};
