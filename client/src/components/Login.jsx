import { useState } from "react";
import { login } from "../api";

const C = {
  bg: "#F3F4F6",
  card: "#FFFFFF",
  border: "#E5E7EB",
  primary: "#1B3A5C",
  accent: "#D4A34A",
  danger: "#B91C1C",
  dangerLight: "#FEE2E2",
  text: "#111827",
  textMuted: "#6B7280",
};

export default function Login({ onLogin }) {
  const [email, setEmail] = useState("admin@lexflow.co.ke");
  const [password, setPassword] = useState("admin123");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await login({ email, password });
      onLogin(session);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: '"DM Sans","Segoe UI",system-ui,sans-serif', padding: 24 }}>
      <form onSubmit={submit} style={{ width: 390, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
          <div style={{ width: 38, height: 38, borderRadius: 7, background: C.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800 }}>LF</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, color: C.text }}>LexFlow Kenya</h1>
            <div style={{ fontSize: 12, color: C.textMuted }}>Sign in to continue</div>
          </div>
        </div>
        {error && <div style={{ padding: "8px 12px", borderRadius: 7, background: C.dangerLight, color: C.danger, fontSize: 13, marginBottom: 14 }}>{error}</div>}
        <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", marginBottom: 6 }}>Email</label>
        <input value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" style={{ width: "100%", padding: "9px 11px", border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 14, font: "inherit" }} />
        <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", marginBottom: 6 }}>Password</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" style={{ width: "100%", padding: "9px 11px", border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 18, font: "inherit" }} />
        <button type="submit" disabled={busy || !email || !password} style={{ width: "100%", border: "none", borderRadius: 6, padding: "10px 14px", background: C.primary, color: "#fff", fontWeight: 700, cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Signing in..." : "Sign In"}
        </button>
        <div style={{ marginTop: 14, fontSize: 11, color: C.textMuted, lineHeight: 1.6 }}>
          Default admin: admin@lexflow.co.ke / admin123
        </div>
      </form>
    </div>
  );
}
