import { useEffect, useRef, useState } from 'react';
import { api, readSession } from '../lib/apiClient.js';
import { workClock } from '../lib/workSessions.jsx';
import { styles } from '../theme.jsx';

export function nairobiCalendarDate(at = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}
const rowStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, minWidth: 0 };
const card = { border: '1px solid var(--lf-card-border, #DDD8CE)', borderRadius: 8, padding: 14, minWidth: 0, background: 'var(--lf-card, #fff)', overflowWrap: 'anywhere' };
const muted = { color: 'var(--lf-card-muted, #6B6B66)', fontSize: 12 };
const hours = value => `${value} h`;

export default function DailyWorkReview({ open, onClose, user, token, dataVersion, matters, work, tick, onOpenMatter }) {
  const [date, setDate] = useState('');
  const [result, setResult] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0), [blocked, setBlocked] = useState(false);
  const [matterId, setMatterId] = useState('');
  const requestId = useRef(0), controller = useRef(null), dialog = useRef(null), previousFocus = useRef(null);
  const authorized = () => {
    const current = readSession();
    return current?.token === token && (!current.user?.id || current.user.id === user?.id);
  };
  const canManage = ['admin', 'advocate'].includes(user?.role);
  useEffect(() => { if (open && !date) setDate(nairobiCalendarDate()); }, [open, date]);
  useEffect(() => {
    const invalidate = () => {
      controller.current?.abort(); requestId.current++; setResult(null);
      if (!authorized()) { setBlocked(true); setLoading(false); }
      else setRevision(value => value + 1);
    };
    const reconnect = () => { if (document.visibilityState === 'visible') invalidate(); };
    window.addEventListener('storage', invalidate); window.addEventListener('online', invalidate);
    window.addEventListener('offline', invalidate); window.addEventListener('focus', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('lexflow-work-session-changes');
    if (channel) channel.onmessage = event => { if (event.data?.action === 'record' || event.data === 'changed') invalidate(); };
    return () => {
      controller.current?.abort(); requestId.current++; channel?.close();
      window.removeEventListener('storage', invalidate); window.removeEventListener('online', invalidate);
      window.removeEventListener('offline', invalidate); window.removeEventListener('focus', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
    };
  }, [user?.id, token]);
  useEffect(() => {
    controller.current?.abort();
    const id = ++requestId.current;
    setResult(null); setError('');
    if (!open || !date || blocked || !authorized()) { setLoading(false); return; }
    if (!navigator.onLine) { setLoading(false); setError('Offline. Reconnect and refresh to load saved work.'); return; }
    const abort = new AbortController(); controller.current = abort; setLoading(true);
    const timeout = setTimeout(() => abort.abort(), 8000);
    api(`/daily-work-review?date=${encodeURIComponent(date)}`, { signal: abort.signal }).then(data => {
      if (id === requestId.current && authorized() && !abort.signal.aborted && data.date === date) setResult(data);
    }).catch(failure => {
      if (id === requestId.current && authorized()) setError(failure.isAuthExpired ? failure.message
        : failure.name === 'AbortError' ? 'Connection interrupted. Refresh to retry.' : failure.message);
    }).finally(() => { clearTimeout(timeout); if (id === requestId.current) setLoading(false); });
    return () => { clearTimeout(timeout); abort.abort(); };
  }, [open, date, revision, dataVersion, blocked, user?.id, token]);
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement;
    dialog.current?.querySelector('button')?.focus();
    const before = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = before; previousFocus.current?.focus?.(); };
  }, [open]);
  if (!open || !['admin', 'advocate', 'assistant'].includes(user?.role)) return null;
  const safe = !blocked && authorized();
  const saved = safe && result?.date === date ? result : null;
  const sessions = safe ? work.sessions.filter(row => row.userId === user.id && row.status !== 'recorded') : [];
  const groups = new Map();
  for (const entry of saved?.entries || []) {
    if (!groups.has(entry.matterId)) groups.set(entry.matterId, { title: [entry.matterReference, entry.matterTitle].filter(Boolean).join(' · '), entries: [] });
    groups.get(entry.matterId).entries.push(entry);
  }
  function openMatter(id, mode, entryId = '') { onOpenMatter({ matterId: id, section: 'tasks', mode, timeEntryId: entryId }); }
  function keyboard(event) {
    if (work.composer) return;
    if (event.key === 'Escape') onClose();
    if (event.key === 'Tab') {
      const items = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  }
  function entryCard(entry, unverified = false) {
    const missing = !entry.description?.trim();
    return <article key={entry.id} aria-label={`Time entry ${entry.id}`} style={card}>
      {unverified && <strong>{[entry.matterReference, entry.matterTitle].filter(Boolean).join(' · ')}</strong>}
      <div style={{ ...rowStyle, justifyContent: 'space-between' }}><strong>{entry.activity || 'Recorded work'}</strong><strong style={{ fontVariantNumeric: 'tabular-nums' }}>{hours(entry.hours)}</strong></div>
      <p style={{ margin: '6px 0' }}>{missing ? <span style={{ color: 'var(--lf-warning, #8A6100)' }}>Description needs attention</span> : entry.description}</p>
      <div style={muted}>{entry.date} · {entry.billable ? 'Billable' : 'Non-billable'} · {entry.source === 'persistent_session' ? 'Linked work session' : 'Source not established'}</div>
      {unverified && <p style={{ ...muted, margin: '6px 0 0' }}>{entry.attribution === 'conflicting_attribution' ? 'Conflicting identity evidence' : 'Personal attribution unverified'} · excluded from confirmed totals</p>}
      {!unverified && missing && canManage && <button style={{ ...styles.tinyButton, marginTop: 8 }} onClick={() => openMatter(entry.matterId, 'edit-time', entry.id)}>Open time entry editor</button>}
    </article>;
  }
  return <div style={{ ...styles.modalBackdrop, zIndex: 3000, padding: 12 }} onKeyDown={keyboard}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="daily-review-title" style={{ ...styles.modalCard, width: 'min(960px, calc(100vw - 24px))', maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100dvh - 24px)', overflowY: 'auto', boxSizing: 'border-box', padding: 16, background: 'var(--lf-background, #F5F2EB)' }}>
      <header style={{ ...rowStyle, justifyContent: 'space-between', borderBottom: '2px solid var(--lf-accent, #C5973C)', paddingBottom: 12 }}><div><div style={muted}>TIMEKEEPER / DAILY REVIEW</div><h2 id="daily-review-title" style={{ margin: '4px 0', fontSize: 24 }}>Daily Work Review</h2></div><button style={styles.ghostButton} onClick={onClose}>Close review</button></header>
      {!safe ? <p role="alert">Account changed. Reload LexFlow to review work.</p> : <>
        <div style={{ ...rowStyle, margin: '14px 0' }}><label style={{ display: 'grid', gap: 4 }}>Work date<input aria-label="Work date" type="date" value={date} max={nairobiCalendarDate()} style={{ ...styles.input, width: 180, maxWidth: '100%', boxSizing: 'border-box' }} onChange={event => { if (event.target.value) { requestId.current++; controller.current?.abort(); setResult(null); setDate(event.target.value); } }} /></label><button style={styles.ghostButton} onClick={() => { setRevision(value => value + 1); void work.refresh(); }}>Refresh review</button><span style={muted}>{saved?.timeZone || 'Africa/Nairobi'} · saved work dates</span></div>
        {loading && <p role="status">Loading saved work…</p>}{error && <p role="alert">{error}</p>}
        {saved && <>
          <section aria-label="Confirmed recorded hours" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>{[['Total recorded', saved.totals.totalHours], ['Billable recorded', saved.totals.billableHours], ['Non-billable recorded', saved.totals.nonBillableHours]].map(([label, value]) => <div key={label} style={card}><div style={muted}>{label}</div><strong style={{ display: 'block', fontSize: 24, marginTop: 4 }} data-testid={`daily-${label.split(' ')[0].toLowerCase()}`}>{hours(value)}</strong></div>)}</section>
          <section aria-label="Confirmed personal work"><h3 style={{ marginBottom: 8 }}>Recorded work · {saved.date}</h3>{!groups.size && <p>No confirmed personal time recorded for this day.</p>}{[...groups].map(([id, group]) => <section key={id} aria-label={group.title} style={{ marginBottom: 16 }}><h4 style={{ margin: '12px 0 8px' }}>{group.title}</h4><div style={{ display: 'grid', gap: 8 }}>{group.entries.map(entry => entryCard(entry))}</div></section>)}</section>
          {saved.unverifiedEntries.length > 0 && <section aria-label="Older entries requiring attribution verification" style={{ ...card, margin: '16px 0', borderLeft: '3px solid var(--lf-accent, #C5973C)' }}><h3 style={{ marginTop: 0 }}>Older entries requiring attribution verification</h3><p style={{ fontSize: 13 }}>These entries may be relevant, but the available historical data cannot reliably attribute them to you. They are excluded from confirmed personal totals.</p><div style={{ display: 'grid', gap: 8 }}>{saved.unverifiedEntries.map(entry => entryCard(entry, true))}</div></section>}
        </>}
        <section aria-label="Outstanding work" style={{ margin: '18px 0' }}><h3 style={{ marginBottom: 6 }}>Unfinished work · all dates</h3><p style={muted}>Outstanding sessions are separate from the selected day’s saved hours. Pending estimates and uncertain time are excluded.</p>{work.error && <p role="alert">{work.error}</p>}{!sessions.length && <p>{work.ready ? 'No unfinished sessions.' : 'Reload saved sessions to review unfinished work.'}</p>}<div style={{ display: 'grid', gap: 8 }}>{sessions.map(row => {
          const pending = row.status === 'running' ? Math.min(120, (row.pendingSeconds || 0) + Math.max(0, Math.floor((tick - work.sampledAt) / 1000))) : 0;
          return <article key={row.id} aria-label={`Outstanding session ${row.id}`} style={card}><div style={{ ...rowStyle, justifyContent: 'space-between' }}><strong>{matters.find(m => m.id === row.matterId)?.title || row.matterId}</strong><span>{row.recoveryRequired ? 'Interruption review required' : row.status === 'running' ? 'Running' : 'Paused'}</span></div><p style={{ margin: '6px 0' }}>{row.activity}{row.description ? ` · ${row.description}` : ''}</p><div>Confirmed {workClock(row.accumulatedSeconds)}</div><div style={muted}>Pending estimate +{workClock(pending)} · unsaved{row.recoveryRequired ? ` · uncertain ${workClock(row.uncertainSeconds)} excluded` : ''}</div><div style={{ ...rowStyle, marginTop: 8 }}>
            {row.status === 'running' ? <button style={styles.ghostButton} disabled={work.busy || !work.ready} onClick={() => work.perform('pause', row.id)}>Pause work</button> : row.recoveryRequired ? <button style={styles.ghostButton} disabled={work.busy || !work.ready} onClick={() => work.setComposer({ type: 'review', session: row })}>Review uncertain time</button> : <><button style={styles.ghostButton} disabled={work.busy || !work.ready} onClick={() => work.perform('resume', row.id, { expectedRunningId: work.running?.id || '' })}>{work.running ? 'Pause current & resume' : 'Resume work'}</button><button style={styles.primaryButton} disabled={work.busy || !work.ready} onClick={() => work.setComposer({ type: 'record', session: row })}>Record Time</button></>}
          </div></article>;
        })}</div></section>
        <section aria-label="Manual time additions" style={{ ...card, marginTop: 16 }}><h3 style={{ marginTop: 0 }}>Add omitted work</h3>{canManage ? <><div style={rowStyle}><label style={{ flex: '1 1 240px', minWidth: 0 }}>Matter for manual time<select aria-label="Matter for manual time" value={matterId} onChange={event => setMatterId(event.target.value)} style={{ ...styles.input, width: '100%', minWidth: 0 }}><option value="">Choose an accessible matter</option>{matters.map(m => <option key={m.id} value={m.id}>{m.reference || m.id} · {m.title}</option>)}</select></label><button disabled={!matters.some(m => m.id === matterId)} style={styles.primaryButton} onClick={() => openMatter(matterId, 'manual-time')}>Add Manual Time</button></div><p style={{ ...muted, marginBottom: 0 }}>Opens the existing matter time form. New manual work uses today’s Nairobi date.</p></> : <p style={muted}>Manual time entry is available to advocates and administrators through the matter workspace.</p>}</section>
      </>}
    </section>
  </div>;
}
