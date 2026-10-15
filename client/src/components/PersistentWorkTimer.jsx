import { useEffect, useRef, useState } from 'react';
import { styles } from '../theme.jsx';
import { Field } from './ui.jsx';
import { useWorkSessions, WORK_ACTIVITIES, workClock } from '../lib/workSessions.jsx';
import DailyWorkReview from './DailyWorkReview.jsx';

const rowStyle = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0 };
export function WorkTimerLauncher({ style }) {
  const work = useWorkSessions();
  return <button type="button" style={style} aria-label="Open persistent work timer" onClick={() => work.setExpanded(value => !value)}>
    {work.running ? 'Running' : 'Timekeeper'} · {workClock(work.running?.accumulatedSeconds ?? work.selected?.accumulatedSeconds ?? 0)}
  </button>;
}
export default function PersistentWorkTimer({ matters = [], tasks = [], showRate = true, user, token, dataVersion, onOpenMatter }) {
  const work = useWorkSessions();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [tick, setTick] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(timer); }, []);
  // Existing app refreshes follow manual creation/editing and session recording.
  // Other tabs invalidate their review; receiving this never triggers app refresh.
  useEffect(() => { if (dataVersion) work?.announceTimeEntriesChanged(); }, [dataVersion]);
  if (!work) return null;
  const { selected, running, busy, ready } = work;
  const active = work.sessions.filter(row => row.status !== 'recorded');
  const matterTitle = id => matters.find(matter => matter.id === id)?.title || id;
  const pending = selected?.status === 'running' ? Math.min(120, (selected.pendingSeconds || 0) + Math.max(0, Math.floor((tick - work.sampledAt) / 1000))) : 0;
  return <>
    <section aria-label="Persistent work timer" style={{ position: 'sticky', top: 54, zIndex: 90, padding: '10px 16px', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A3628)', borderBottom: '2px solid var(--lf-accent, #C5973C)', minWidth: 0 }}>
      <div style={rowStyle}>
        <div style={{ flex: '1 1 160px', minWidth: 0, overflowWrap: 'anywhere' }}><strong>{selected ? matterTitle(selected.matterId) : 'Work timer'}</strong><div style={{ fontSize: 12 }}>{selected ? `${selected.activity} · ${selected.recoveryRequired ? 'Review required' : selected.status === 'running' ? 'Running' : 'Paused'}` : ready ? 'Start from a matter. A task is optional.' : 'Reload saved sessions to continue.'}</div></div>
        <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}><div>Confirmed <strong data-testid="work-confirmed">{workClock(selected?.accumulatedSeconds)}</strong></div><div data-testid="work-pending" style={{ color: 'var(--lf-text-muted, #6B6B66)' }}>Pending estimate +{workClock(pending)} · unsaved</div></div>
        <div style={rowStyle}>
          {selected?.status === 'running' && <button style={styles.ghostButton} disabled={busy || !ready} onClick={() => work.perform('pause', selected.id)}>Pause work</button>}
          {selected?.status === 'paused' && !selected.recoveryRequired && <button style={styles.ghostButton} disabled={busy || !ready} onClick={() => work.perform('resume', selected.id, { expectedRunningId: running?.id || '' })}>{running ? 'Pause current & resume' : 'Resume work'}</button>}
          {selected?.status === 'paused' && !selected.recoveryRequired && <button style={styles.primaryButton} disabled={busy || !ready} onClick={() => work.setComposer({ type: 'record', session: selected })}>Record Time</button>}
          <button style={styles.ghostButton} onClick={() => work.setExpanded(value => !value)} aria-expanded={work.expanded}>Sessions ({active.length})</button>
          <button style={styles.ghostButton} disabled={busy || !ready} onClick={() => work.openStart()}>Start Work</button>
          <button style={styles.ghostButton} onClick={() => setReviewOpen(true)}>Daily Work Review</button>
        </div>
      </div>
      {running && selected?.id !== running.id && <div style={{ fontSize: 12, marginTop: 6 }}>Running: {matterTitle(running.matterId)} <button style={styles.tinyButton} onClick={() => work.setSelectedId(running.id)}>Show running session</button></div>}
      {work.expanded && <div style={{ ...rowStyle, marginTop: 8 }}><label style={{ flex: '1 1 240px', minWidth: 0 }}>Saved sessions<select aria-label="Saved sessions" style={{ ...styles.input, width: '100%', minWidth: 0 }} value={work.selectedId} onChange={event => work.setSelectedId(event.target.value)}>{!active.length && <option value="">No active sessions</option>}{active.map(row => <option key={row.id} value={row.id}>{matterTitle(row.matterId)} · {row.activity} · {row.recoveryRequired ? 'review' : row.status} · {workClock(row.accumulatedSeconds)}</option>)}</select></label><button style={styles.ghostButton} disabled={busy} onClick={() => work.refresh()}>Reconnect / reload</button></div>}
      {selected?.recoveryRequired === 1 && <div role="status" style={{ marginTop: 8, fontSize: 13 }}>Confirmation was interrupted. {workClock(selected.accumulatedSeconds)} is confirmed; {workClock(selected.uncertainSeconds)} is uncertain and excluded. Review before continuing. Use manual time entry for separately verified work. <button style={styles.ghostButton} disabled={busy} onClick={() => work.setComposer({ type: 'review', session: selected })}>Review uncertain time</button></div>}
      {work.error && <div role="alert" style={{ marginTop: 6, fontSize: 13 }}>{work.error} <button style={styles.tinyButton} disabled={busy} onClick={() => work.refresh()}>Reconnect / reload</button></div>}
      {work.notice && <div role="status" style={{ marginTop: 6, fontSize: 13 }}>{work.notice}</div>}
    </section>
    <DailyWorkReview open={reviewOpen} onClose={() => setReviewOpen(false)} user={user} token={token} dataVersion={dataVersion} matters={matters} work={work} tick={tick} onOpenMatter={options => { setReviewOpen(false); onOpenMatter?.(options); }} />
    {work.composer && <WorkDialog key={`${work.composer.type}-${work.composer.session?.id || work.composer.matterId || ''}-${work.composer.taskId || ''}`} work={work} matters={matters} tasks={tasks} showRate={showRate} />}
  </>;
}
function WorkDialog({ work, matters, tasks, showRate }) {
  const initial = work.composer, session = initial.session;
  const [matterId, setMatterId] = useState(initial.matterId || matters[0]?.id || '');
  const [taskId, setTaskId] = useState(initial.taskId || '');
  const [activity, setActivity] = useState('Legal Research');
  const [description, setDescription] = useState(session?.description || initial.description || '');
  const [billable, setBillable] = useState(''), [rate, setRate] = useState('0'), [reviewing, setReviewing] = useState(false);
  const dialog = useRef(null), previousFocus = useRef(document.activeElement);
  useEffect(() => { dialog.current?.querySelector('input,select,button')?.focus(); return () => previousFocus.current?.focus?.(); }, []);
  const title = initial.type === 'start' ? 'Start Work' : initial.type === 'review' ? 'Review uncertain time' : reviewing ? 'Confirm recording' : 'Record Time';
  const name = id => matters.find(row => row.id === id)?.title || id;
  async function submit(event) {
    event.preventDefault();
    if (work.busy) return;
    if (initial.type === 'start') await work.perform('start', null, { matterId, taskId: taskId || null, activity, description, expectedRunningId: work.running?.id || '' });
    else if (initial.type === 'review') await work.perform('review', session.id);
    else if (!reviewing) setReviewing(true);
    else await work.perform('record', session.id, { version: session.version, description: description.trim(), billable: billable === 'true', ...(showRate ? { rate: Number(rate) } : {}) });
  }
  function onKey(event) {
    if (event.key === 'Escape' && !work.busy) work.setComposer(null);
    if (event.key === 'Tab') {
      const items = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  }
  return <div style={{ ...styles.modalBackdrop, zIndex: 3100, padding: 16 }} onKeyDown={onKey}><form ref={dialog} role="dialog" aria-modal="true" aria-label={title} onSubmit={submit} style={{ ...styles.modalCard, width: 'min(500px, calc(100vw - 32px))', maxWidth: 'calc(100vw - 32px)', minWidth: 0, boxSizing: 'border-box', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto', display: 'grid', gap: 12 }}>
    <div style={styles.modalHead}><h2 style={{ margin: 0, fontSize: 20 }}>{title}</h2><button type="button" aria-label="Close work dialog" disabled={work.busy} style={styles.ghostButton} onClick={() => work.setComposer(null)}>Close</button></div>
    {initial.type === 'start' ? <>
      <Field label="Matter"><select aria-label="Matter" required style={styles.input} value={matterId} onChange={event => { setMatterId(event.target.value); setTaskId(''); }}><option value="">Choose matter</option>{matters.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></Field>
      <Field label="Activity"><select aria-label="Activity" style={styles.input} value={activity} onChange={event => setActivity(event.target.value)}>{WORK_ACTIVITIES.map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Task (optional)"><select aria-label="Task (optional)" style={styles.input} value={taskId} onChange={event => setTaskId(event.target.value)}><option value="">No task</option>{tasks.filter(row => row.matterId === matterId).map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></Field>
      <Field label="Work description (optional)"><input aria-label="Work description (optional)" style={styles.input} maxLength={10000} value={description} onChange={event => setDescription(event.target.value)} /></Field>
      {work.running && <p style={{ margin: 0 }}>Starting will pause {name(work.running.matterId)} and preserve its confirmed time.</p>}
    </> : initial.type === 'review' ? <p>Discard the uncertain {workClock(session.uncertainSeconds)}? Confirmed {workClock(session.accumulatedSeconds)} will be preserved. Uncertain time will not be credited. You can record separately verified work through manual time entry.</p> : <>
      <p style={{ margin: 0 }}>{name(session.matterId)} · {session.activity}<br />Confirmed duration: <strong>{workClock(session.accumulatedSeconds)}</strong></p>
      {reviewing ? <><p style={{ overflowWrap: 'anywhere' }}>{description}</p><p>{billable === 'true' ? 'Billable' : 'Non-billable'}{showRate ? ` · Rate KSh ${Number(rate)}` : ''}</p><p>Record this confirmed work once as a saved time entry?</p></> : <>
        <Field label="Work description"><input aria-label="Work description" required style={styles.input} maxLength={10000} value={description} onChange={event => setDescription(event.target.value)} /></Field>
        <Field label="Billing class"><select aria-label="Billing class" required style={styles.input} value={billable} onChange={event => setBillable(event.target.value)}><option value="">Choose billable or non-billable</option><option value="true">Billable</option><option value="false">Non-billable</option></select></Field>
        {showRate && <Field label="Hourly rate (KSh)"><input aria-label="Hourly rate (KSh)" required style={styles.input} type="number" min="0" step="any" value={rate} onChange={event => setRate(event.target.value)} /></Field>}
      </>}
    </>}
    <div style={{ ...styles.modalActions, flexWrap: 'wrap' }}><button type="button" style={styles.ghostButton} disabled={work.busy} onClick={() => work.setComposer(null)}>Cancel</button><button type="submit" style={styles.primaryButton} disabled={work.busy || !work.ready || (initial.type === 'record' && (!description.trim() || !billable))}>{work.busy ? 'Saving…' : initial.type === 'start' ? work.running ? 'Pause current & start' : 'Start session' : initial.type === 'review' ? 'Discard unconfirmed time' : reviewing ? 'Confirm record time' : 'Review recording'}</button></div>
  </form></div>;
}
