import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api, readSession } from './apiClient.js';

export const WORK_ACTIVITIES = ['Legal Research', 'Drafting', 'Court Attendance', 'Client Communication', 'Document Review', 'Filing', 'Preparation', 'Other'];
export const CONFIRM_INTERVAL_MS = 30000;
const WorkSessions = createContext(null);
export const useWorkSessions = () => useContext(WorkSessions);
export function workClock(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(n => String(n).padStart(2, '0')).join(':');
}

// No timing/session state is stored in browser storage. Every mutation first
// reads the server; local ticking is an estimate, never saved duration.
export function WorkSessionProvider({ user, token, onRecorded, children }) {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [composer, setComposer] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [sampledAt, setSampledAt] = useState(Date.now());
  const alive = useRef(true), locked = useRef(false), channel = useRef(null), refreshLater = useRef(false);
  const controllers = useRef(new Set());
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;
  function recorded(matterId) {
    onRecordedRef.current?.();
    window.dispatchEvent(new CustomEvent('lexflow:work-recorded', { detail: { matterId } }));
  }
  function authorized() {
    const current = readSession();
    return alive.current && user?.id && ['admin', 'advocate', 'assistant'].includes(user.role)
      && (!current?.user?.id || current.user.id === user.id) && current?.token === token;
  }
  function clear() {
    if (!alive.current) return;
    setSessions([]); setSelectedId(''); setComposer(null); setReady(false);
  }
  async function request(path, options = {}) {
    if (!authorized()) { clear(); throw new Error('Account changed. Reload LexFlow.'); }
    const controller = new AbortController();
    controllers.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const result = await api(path, { ...options, signal: controller.signal });
      if (!authorized()) { clear(); throw new Error('Account changed. Reload LexFlow.'); }
      return result;
    } finally { clearTimeout(timeout); controllers.current.delete(controller); }
  }
  async function load() {
    const rows = await request('/work-sessions');
    const own = rows.filter(row => row.userId === user.id);
    setSessions(own); setSampledAt(Date.now()); setReady(true);
    setSelectedId(current => own.some(row => row.id === current && row.status !== 'recorded') ? current
      : own.find(row => row.status === 'running')?.id || own.find(row => row.status === 'paused')?.id || '');
    return own;
  }
  async function refresh() {
    if (locked.current) { refreshLater.current = true; return; }
    locked.current = true; setBusy(true);
    try { await load(); setError(''); }
    catch (failure) { if (alive.current) { clear(); setError(failure.isAuthExpired ? failure.message : 'Connection or account changed. Reconnect to reload saved sessions.'); } }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  async function perform(action, id, values = {}) {
    if (locked.current || !authorized()) return false;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const rows = await load(); // fresh access/version check before every write
      let row = rows.find(item => item.id === id);
      const running = rows.find(item => item.status === 'running');
      const switchFields = {};
      if (action === 'start' || action === 'resume') {
        if ((running?.id || '') !== (values.expectedRunningId || '')) throw new Error('Running session changed. Review the refreshed sessions before switching.');
        if (running && running.id !== id) Object.assign(switchFields, { runningSessionId: running.id, runningVersion: running.version });
      }
      if (action !== 'start' && !row) throw new Error('Session is no longer accessible. Saved sessions have been refreshed.');
      if (action === 'record' && row.status === 'recorded') {
        setNotice('Time was already recorded. No duplicate entry was created.'); setComposer(null); recorded(row.matterId); return true;
      }
      if (action === 'record' && row.version !== values.version) throw new Error('Session changed. Review its confirmed duration again before recording.');
      let result;
      if (action === 'start') {
        const { expectedRunningId, ...body } = values;
        result = await request('/work-sessions', { method: 'POST', body: { ...body, ...switchFields } });
      } else if (action === 'record') {
        if (!values.description?.trim()) throw new Error('Enter a work description before recording.');
        if (row.description !== values.description) row = await request(`/work-sessions/${id}`, { method: 'PATCH', body: { version: row.version, description: values.description } });
        result = await request(`/work-sessions/${id}/record`, { method: 'POST', body: { version: row.version, billable: values.billable, ...(values.rate !== undefined ? { rate: values.rate } : {}) } });
      } else {
        result = await request(`/work-sessions/${id}/${action}`, { method: 'POST', body: { version: row.version, ...switchFields, ...(action === 'review' ? { discardUnconfirmed: true } : {}) } });
      }
      const updated = await load();
      if (action === 'start' || action === 'resume') setSelectedId(result.id);
      if (action === 'record') {
        setNotice('Time recorded once.'); recorded(row.matterId);
      }
      if (action !== 'confirm') setComposer(null);
      channel.current?.postMessage('changed');
      return updated;
    } catch (failure) {
      if (!alive.current) return false;
      setComposer(null); setReady(false);
      if (failure.status === 403 || failure.status === 404 || failure.isAuthExpired) clear();
      let updated;
      try { updated = await load(); } catch { clear(); }
      if (action === 'record' && updated?.find(row => row.id === id)?.status === 'recorded') {
        setNotice('Time was recorded. The response was interrupted; no duplicate entry was created.');
        recorded(updated.find(row => row.id === id).matterId); channel.current?.postMessage('changed'); return true;
      }
      if (alive.current) setError(failure.status === 409 ? 'Session changed in another tab or needs review. Saved sessions reloaded.'
        : failure.name === 'AbortError' || failure instanceof TypeError ? 'Connection interrupted. Reconnect to reload saved sessions before continuing.' : failure.message);
      return false;
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(false);
        if (refreshLater.current) { refreshLater.current = false; void refresh(); }
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    const initialRefresh = window.setTimeout(() => { void refresh(); }, 0);
    const reconnect = () => { if (document.visibilityState === 'visible') void refresh(); };
    const storage = () => {
      if (!authorized()) { controllers.current.forEach(controller => controller.abort()); clear(); setError('Account changed. Reload LexFlow.'); }
      else void refresh();
    };
    window.addEventListener('online', reconnect); window.addEventListener('focus', reconnect);
    document.addEventListener('visibilitychange', reconnect); window.addEventListener('storage', storage);
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('lexflow-work-session-changes');
      channel.current.onmessage = () => { if (authorized()) void refresh(); else storage(); };
    }
    // Suspended/background tabs make no guarantee of confirmations. After a
    // missed interval, the server's bounded recovery rule remains authoritative.
    const heartbeat = window.setInterval(async () => {
      if (document.visibilityState !== 'visible' || locked.current || !authorized()) return;
      locked.current = true; setBusy(true);
      let rows;
      try { rows = await load(); } catch { clear(); setError('Connection interrupted. Reconnect to reload saved sessions.'); }
      finally { locked.current = false; if (alive.current) setBusy(false); }
      const running = rows?.find(row => row.status === 'running');
      if (running) void perform('confirm', running.id);
    }, CONFIRM_INTERVAL_MS);
    return () => {
      alive.current = false; clearTimeout(initialRefresh); clearInterval(heartbeat); controllers.current.forEach(controller => controller.abort()); channel.current?.close();
      window.removeEventListener('online', reconnect); window.removeEventListener('focus', reconnect);
      document.removeEventListener('visibilitychange', reconnect); window.removeEventListener('storage', storage);
    };
  }, [user?.id, token]);
  const running = sessions.find(row => row.status === 'running');
  const selected = sessions.find(row => row.id === selectedId && row.status !== 'recorded');
  return <WorkSessions.Provider value={{ sessions, running, selected, selectedId, setSelectedId, busy, error, notice, ready, sampledAt,
    refresh, perform, composer, setComposer, expanded, setExpanded,
    openStart: (values = {}) => { setComposer({ type: 'start', ...values }); setExpanded(true); } }}>{children}</WorkSessions.Provider>;
}
