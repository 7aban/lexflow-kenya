export default function Toast({ toast, onClose }) {
  if (!toast) return null;
  const colors = {
    success: { bg: "#ECFDF5", border: "#6EE7B7", text: "#047857" },
    danger: { bg: "#FEE2E2", border: "#FCA5A5", text: "#B91C1C" },
    info: { bg: "#DBEAFE", border: "#93C5FD", text: "#1D4ED8" },
  };
  const c = colors[toast.type] || colors.info;
  return (
    <div style={{ position: "fixed", top: 18, right: 18, zIndex: 2000, width: 340, maxWidth: "calc(100vw - 36px)", background: c.bg, color: c.text, border: `1px solid ${c.border}`, borderRadius: 8, boxShadow: "0 14px 35px rgba(15,27,51,0.18)", padding: "12px 14px", display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ flex: 1, fontSize: 13, lineHeight: 1.5, fontWeight: 600 }}>{toast.message}</div>
      <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", color: c.text, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>x</button>
    </div>
  );
}
