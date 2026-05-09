import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Badge, Field } from './ui.jsx';

const ACTIVITY_CODES = ['Legal Research', 'Drafting', 'Court Attendance', 'Client Communication', 'Document Review', 'Filing', 'Preparation', 'Other'];
const BILLABLE_TIME_GUIDANCE = 'Billable time may be included in hourly invoices. Non-billable time is tracked for workload and productivity but excluded from hourly invoice generation.';

function secondsNow(timer, taskId) {
  if (!timer || timer.taskId !== taskId) return 0;
  const runningDelta = timer.running && timer.startedAt ? Math.floor((Date.now() - timer.startedAt) / 1000) : 0;
  return Math.max(0, Number(timer.elapsedSeconds || 0) + runningDelta);
}

function formatClock(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  const hh = String(Math.floor(value / 3600)).padStart(2, '0');
  const mm = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
  const ss = String(value % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function hoursFromSeconds(seconds) {
  return Math.max(0.01, Math.round((seconds / 3600) * 100) / 100);
}

export default function TaskTimer({ task, matterId, matterRate = 15000, showRate = true, timer, setTimer, notify, onSaved }) {
  const [tick, setTick] = useState(Date.now());
  const [showSave, setShowSave] = useState(false);
  const [form, setForm] = useState({ activity: ACTIVITY_CODES[0], description: '', rate: showRate ? matterRate || 15000 : 0, billable: true });
  const [saving, setSaving] = useState(false);
  const active = timer?.taskId === task.id;
  const running = active && timer?.running;
  const elapsed = secondsNow(timer, task.id);

  useEffect(() => {
    if (!running) return undefined;
    const interval = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [running]);

  useEffect(() => {
    setForm(current => ({ ...current, rate: showRate ? matterRate || current.rate || 15000 : 0 }));
  }, [matterRate, showRate]);

  const canSave = active && elapsed > 0 && !running;
  const logged = useMemo(() => (task.timeEntries || []).reduce((sum, entry) => sum + Number(entry.hours || 0), 0), [task.timeEntries]);

  function start() {
    if (timer?.taskId && timer.taskId !== task.id && timer.running) {
      notify?.({ type: 'warning', message: `A timer is already running on ${timer.taskTitle || 'another task'}. Stop it first.` });
      return;
    }
    setShowSave(false);
    setTimer(current => ({
      taskId: task.id,
      taskTitle: task.title,
      elapsedSeconds: current?.taskId === task.id ? secondsNow(current, task.id) : 0,
      running: true,
      startedAt: Date.now(),
    }));
  }

  function pause() {
    if (!active) return;
    setTimer(current => ({ ...current, elapsedSeconds: secondsNow(current, task.id), running: false, startedAt: null }));
  }

  function reset() {
    if (!active && !elapsed) return;
    setTimer(current => current?.taskId === task.id ? null : current);
    setShowSave(false);
  }

  async function save(event) {
    event.preventDefault();
    const seconds = elapsed;
    if (!seconds) return;
    setSaving(true);
    try {
      const body = {
        matterId,
        taskId: task.id,
        hours: hoursFromSeconds(seconds),
        activity: form.activity,
        description: form.description || `${form.activity}: ${task.title}`,
        billable: Boolean(form.billable),
      };
      if (showRate) body.rate = Number(form.rate || 0);
      await api('/time-entries', {
        method: 'POST',
        body,
      });
      setTimer(current => current?.taskId === task.id ? null : current);
      setShowSave(false);
      setForm({ activity: ACTIVITY_CODES[0], description: '', rate: showRate ? matterRate || 15000 : 0, billable: true });
      notify?.({ type: 'success', message: `Saved ${formatClock(seconds)} against ${task.title}.` });
      await onSaved?.();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 7, minWidth: 250 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <button type="button" title={running ? 'Pause timer' : 'Start timer'} onClick={running ? pause : start} style={roundButton(running ? theme.green : theme.navy600)}>{running ? '⏸' : '▶'}</button>
        <button type="button" title="Reset timer" onClick={reset} style={roundButton(theme.muted)}>↺</button>
        <span style={clockStyle}>
          {running && <span style={pulseStyle} />}
          {formatClock(elapsed)}
        </span>
        {canSave && <button type="button" title="Save time entry" onClick={() => setShowSave(open => !open)} style={styles.tinyButton}>💾 Save</button>}
        {logged > 0 && <Badge tone="green">{logged.toFixed(2)}h logged</Badge>}
      </div>
      <div style={{ maxHeight: showSave ? 420 : 0, overflow: 'hidden', transition: 'max-height .18s ease' }}>
        {showSave && (
          <form onSubmit={save} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8, padding: 10, border: `1px solid ${theme.line}`, borderRadius: 8, background: '#FAFAFB' }}>
            <Field label="Activity">
              <select style={styles.input} value={form.activity} onChange={event => setForm({ ...form, activity: event.target.value })}>
                {ACTIVITY_CODES.map(code => <option key={code}>{code}</option>)}
              </select>
            </Field>
            {showRate && (
              <Field label="Rate">
                <input type="number" style={styles.input} value={form.rate} onChange={event => setForm({ ...form, rate: event.target.value })} />
              </Field>
            )}
            <Field label="Billing class">
              <select style={styles.input} value={form.billable ? 'billable' : 'non_billable'} onChange={event => setForm({ ...form, billable: event.target.value === 'billable' })}>
                <option value="billable">Billable</option>
                <option value="non_billable">Non-billable</option>
              </select>
            </Field>
            <Field label="Description">
              <input style={styles.input} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} placeholder={task.title} />
            </Field>
            <div style={{ ...styles.formHelper, gridColumn: '1 / -1' }}>{BILLABLE_TIME_GUIDANCE}</div>
            <button type="submit" disabled={saving} style={{ ...styles.primaryButton, alignSelf: 'end' }}>{saving ? 'Saving...' : 'Save entry'}</button>
          </form>
        )}
      </div>
    </div>
  );
}

export function taskTimerActive(timer, taskId) {
  return timer?.taskId === taskId;
}

const clockStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 92,
  borderRadius: 999,
  background: '#F3F4F6',
  color: theme.ink,
  padding: '5px 9px',
  font: "700 14px/1 'Courier New', monospace",
};

const pulseStyle = {
  width: 7,
  height: 7,
  borderRadius: 999,
  background: theme.green,
  boxShadow: '0 0 0 4px rgba(4,120,87,.12)',
  animation: 'lfPulse 1.2s ease-in-out infinite',
};

function roundButton(color) {
  return {
    width: 28,
    height: 28,
    borderRadius: 999,
    border: `1px solid ${theme.line}`,
    background: '#fff',
    color,
    cursor: 'pointer',
    display: 'inline-grid',
    placeItems: 'center',
    fontWeight: 900,
    fontSize: 12,
  };
}
