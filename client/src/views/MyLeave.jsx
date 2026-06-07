import { useEffect, useState } from 'react';
import { getMyLeaveRequests, createMyLeaveRequest, cancelMyLeaveRequest } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Card, Empty } from '../components/ui.jsx';

const LEAVE_TYPES = [
  { value: 'annual', label: 'Annual' },
  { value: 'sick', label: 'Sick' },
  { value: 'compassionate', label: 'Compassionate' },
  { value: 'maternity', label: 'Maternity' },
  { value: 'paternity', label: 'Paternity' },
  { value: 'study_exam', label: 'Study/Exam' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'other', label: 'Other' },
];

const STATUS_COLORS = {
  pending: { bg: '#FEF3C7', color: '#92400E' },
  approved: { bg: '#D1FAE5', color: '#065F46' },
  rejected: { bg: '#FEE2E2', color: '#991B1B' },
  cancelled: { bg: '#F3F4F6', color: '#6B7280' },
};

function StatusBadge({ status }) {
  const colors = STATUS_COLORS[status] || { bg: '#F3F4F6', color: '#6B7280' };
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: colors.bg, color: colors.color }}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function isoDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

export default function MyLeave({ notify }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ leaveType: 'annual', startDate: '', endDate: '', reason: '' });
  const [submitting, setSubmitting] = useState(false);
  const [tab, setTab] = useState('list');

  useEffect(() => { loadRequests(); }, []);

  async function loadRequests() {
    setLoading(true);
    try {
      const data = await getMyLeaveRequests();
      setRequests(Array.isArray(data) ? data : []);
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setLoading(false);
    }
  }

  async function submitRequest(event) {
    event.preventDefault();
    if (!form.startDate || !form.endDate) {
      notify({ type: 'warning', message: 'Start and end dates are required.' });
      return;
    }
    setSubmitting(true);
    try {
      await createMyLeaveRequest(form);
      notify({ type: 'success', message: 'Leave request submitted.' });
      setForm({ leaveType: 'annual', startDate: '', endDate: '', reason: '' });
      setTab('list');
      await loadRequests();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel(id) {
    try {
      await cancelMyLeaveRequest(id);
      notify({ type: 'success', message: 'Leave request cancelled.' });
      await loadRequests();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    }
  }

  return (
    <div style={styles.pageStack}>
      <div style={styles.tabList}>
        <button type="button" onClick={() => setTab('list')} style={{ ...styles.tabButton, ...(tab === 'list' ? styles.tabActive : {}) }}>My Leave Requests</button>
        <button type="button" onClick={() => setTab('new')} style={{ ...styles.tabButton, ...(tab === 'new' ? styles.tabActive : {}) }}>New Request</button>
      </div>

      {tab === 'new' && (
        <Card title="New Leave Request" hint="Submit a leave request for admin approval">
          <form onSubmit={submitRequest} style={styles.formGrid}>
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Leave type</label>
              <select style={styles.input} value={form.leaveType} onChange={e => setForm({ ...form, leaveType: e.target.value })}>
                {LEAVE_TYPES.map(lt => <option key={lt.value} value={lt.value}>{lt.label}</option>)}
              </select>
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Start date</label>
              <input type="date" style={styles.input} value={form.startDate} min={isoDateOnly()} onChange={e => setForm({ ...form, startDate: e.target.value })} />
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>End date</label>
              <input type="date" style={styles.input} value={form.endDate} min={form.startDate || isoDateOnly()} onChange={e => setForm({ ...form, endDate: e.target.value })} />
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Reason</label>
              <textarea rows={3} style={{ ...styles.input, minHeight: 80, resize: 'vertical' }} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="Optional reason for your leave request" />
              <span style={{ fontSize: 11, color: '#9CA3AF' }}>Do not include medical diagnosis or sensitive medical details.</span>
            </div>
            <button type="submit" style={styles.primaryButton} disabled={submitting}>
              {submitting ? 'Submitting...' : 'Submit Leave Request'}
            </button>
          </form>
        </Card>
      )}

      {tab === 'list' && (
        <Card title="My Leave Requests" hint={`${requests.length} request${requests.length === 1 ? '' : 's'}`}>
          {loading ? (
            <div style={{ color: theme.muted, padding: 12 }}>Loading...</div>
          ) : requests.length === 0 ? (
            <Empty title="No leave requests yet." text="Use New Request to submit a leave request for admin approval." />
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {requests.map(req => (
                <div key={req.id} style={{ border: `1px solid ${theme.line}`, borderRadius: 8, padding: 12, background: '#fff', display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ display: 'grid', gap: 2 }}>
                      <strong style={{ fontSize: 14 }}>{LEAVE_TYPES.find(lt => lt.value === req.leaveType)?.label || req.leaveType}</strong>
                      <span style={{ fontSize: 12, color: theme.muted }}>{req.startDate} → {req.endDate} · {req.days} day{Number(req.days) === 1 ? '' : 's'}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <StatusBadge status={req.status} />
                      {req.status === 'pending' && (
                        <button type="button" style={{ ...styles.dangerTinyButton, fontSize: 12, padding: '3px 10px' }} onClick={() => handleCancel(req.id)}>Cancel</button>
                      )}
                    </div>
                  </div>
                  {req.reason ? <div style={{ fontSize: 12, color: theme.ink }}>{req.reason}</div> : null}
                  <div style={{ fontSize: 11, color: '#9CA3AF' }}>Requested: {new Date(req.requestedAt).toLocaleString()}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
