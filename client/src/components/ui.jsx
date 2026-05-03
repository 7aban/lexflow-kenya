import { useEffect, useRef, useState } from 'react';
import { theme, styles } from '../theme.jsx';

export function MeetingLink({ event, dashboard = false }) {
  const href = (event?.meetingLink || '').trim();
  if (!href) return <span style={styles.mutedText}>-</span>;
  const urgent = dashboard ? isTodayOrTomorrow(event.date) : isToday(event.date);
  if (urgent) {
    return <a style={styles.joinButton} href={href} target="_blank" rel="noopener noreferrer">{dashboard ? 'Join' : 'Join Court'}</a>;
  }
  return <a style={styles.meetingLink} href={href} target="_blank" rel="noopener noreferrer"><span style={styles.videoBadge}>VC</span> Meeting Link</a>;
}

export function Logo({ firm }) {
  if (firm?.logo) return <div style={styles.logo}><img src={firm.logo} alt={`${firm.name || 'Firm'} logo`} style={styles.logoImage} /></div>;
  return <div style={styles.logo}>LF</div>;
}

export function ProfileTooltip({ tooltip }) {
  if (!tooltip) return null;
  return <div className="profile-tooltip" style={{ ...styles.profileTooltip, left: tooltip.x + 14, top: tooltip.y + 14 }}><div style={styles.tooltipAvatar}>{tooltip.initial}</div><div><strong>{tooltip.title}</strong>{tooltip.lines.map(line => <span key={line}>{line}</span>)}</div></div>;
}

export function ActionGroup({ actions }) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const ref = useRef(null);
  const visibleActions = actions.filter(Boolean);

  useEffect(() => {
    if (!open) return undefined;
    function closeOnOutside(event) {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', closeOnOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('mousedown', closeOnOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  if (!visibleActions.length) return null;
  return (
    <div ref={ref} style={styles.actionMenuWrap}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => {
          if (!open) {
            const rect = ref.current?.getBoundingClientRect();
            if (rect) setMenuPosition({ top: rect.bottom + 6, left: Math.max(8, rect.right - 154) });
          }
          setOpen(current => !current);
        }}
        style={styles.actionMenuButton}
      >
        ...
      </button>
      {open && (
        <div role="menu" style={{ ...styles.actionMenu, top: menuPosition.top, left: menuPosition.left }}>
          {visibleActions.map(([label, onClick], index) => {
            const danger = String(label).toLowerCase().includes('delete');
            return (
              <button
                key={`${label}-${index}`}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onClick?.();
                }}
                style={{ ...styles.actionMenuItem, ...(danger ? styles.actionMenuItemDanger : {}) }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ConfirmModal({ confirm, onClose }) {
  useEffect(() => {
    if (!confirm) return undefined;
    function onKey(event) { if (event.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm, onClose]);
  if (!confirm) return null;
  async function proceed() {
    await confirm.onConfirm();
    onClose();
  }
  return (
    <div style={styles.modalBackdrop} role="dialog" aria-modal="true">
      <div style={styles.modalCard}>
        <div style={styles.modalHead}>
          <h2>{confirm.title || 'Confirm action'}</h2>
          <button type="button" aria-label="Close" onClick={onClose} style={styles.toastClose}>x</button>
        </div>
        <p>{confirm.message}</p>
        <div style={styles.modalActions}>
          <button type="button" style={styles.ghostButton} onClick={onClose}>Cancel</button>
          <button type="button" style={styles.dangerButton} onClick={proceed}>Confirm</button>
        </div>
      </div>
    </div>
  );
}

export function Card({ title, hint, action, children }) { return <section style={styles.card}><div style={styles.cardHead}><div><h2>{title}</h2>{hint && <p>{hint}</p>}</div>{action}</div>{children}</section>; }
export function Sub({ title, children }) { return <div style={styles.sub}><h3>{title}</h3>{children}</div>; }
export function Field({ label, children }) { return <label style={styles.field}><span>{label}</span>{children}</label>; }
export function Stat({ label, value, tone }) { const colors = { navy: theme.navy600, gold: theme.gold, green: theme.green, red: theme.red }; const color = colors[tone] || theme.navy600; return <div style={{ ...styles.stat, borderLeftColor: color }}><i style={{ background: `${color}16`, color }}>{label.slice(0, 2).toUpperCase()}</i><span>{label}</span><strong>{value}</strong></div>; }
export function Badge({ tone = 'blue', children }) { const map = { green: [theme.greenBg, theme.green], amber: [theme.amberBg, theme.amber], red: [theme.redBg, theme.red], blue: [theme.blueBg, theme.blue] }; const [bg, color] = map[tone] || map.blue; return <span style={{ ...styles.badge, background: bg, color }}>{children}</span>; }
export function Alert({ tone, children }) { return <div style={{ ...styles.alert, ...(tone === 'danger' ? styles.alertDanger : {}) }}>{children}</div>; }
export function Toast({ toast, onClose }) { if (!toast) return null; const tone = toast.type === 'danger' ? 'red' : toast.type === 'success' ? 'green' : toast.type === 'warning' ? 'amber' : 'blue'; const map = { green: [theme.greenBg, theme.green, '#A7F3D0'], red: [theme.redBg, theme.red, '#FECACA'], amber: [theme.amberBg, theme.amber, '#FDE68A'], blue: [theme.blueBg, theme.blue, '#BFDBFE'] }; const [bg, color, borderColor] = map[tone]; return <div style={{ ...styles.toast, background: bg, color, borderColor }} role="status" aria-live="polite"><strong>{toast.message}</strong><button type="button" aria-label="Dismiss notification" onClick={onClose} style={styles.toastClose}>x</button></div>; }
export function Empty({ title, text }) { return <div style={styles.empty}><div style={styles.emptyIcon}>LF</div><strong>{title}</strong><span>{text}</span></div>; }
export function Skeleton({ rows = 4 }) { return <div style={styles.skeletonGrid}>{Array.from({ length: rows }).map((_, index) => <div key={index} style={styles.skeleton}><span style={styles.skeletonLineLarge} /><span style={styles.skeletonLine} /><span style={styles.skeletonLineShort} /></div>)}</div>; }
export function Table({ columns, rows, empty }) { if (!rows.length) return <Empty title={empty} text="Once records exist, they will appear here." />; return <div style={styles.tableWrap}><table style={styles.table}><thead><tr>{columns.map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>; }
export function statusTone(status) { return status === 'Paid' ? 'green' : status === 'Overdue' ? 'red' : 'amber'; }
export function kes(value) { return `KSh ${Number(value || 0).toLocaleString('en-KE')}`; }
export function todayIso() { return new Date().toISOString().slice(0, 10); }
export function isToday(date) { return Boolean(date) && date === todayIso(); }
export function isTodayOrTomorrow(date) {
  if (!date) return false;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return date === todayIso() || date === tomorrow;
}
export function nextCourtDate(matter) { return matter?.nextCourtDate || '-'; }


