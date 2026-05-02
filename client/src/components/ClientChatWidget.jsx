import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Badge, Empty, Field } from './ui.jsx';

const faqItems = [
  ['How do I view my court date?', 'Open My Matters, choose the relevant matter, then check Court appearances. If a virtual link exists, it appears beside the event.'],
  ['How do I upload a document?', 'Open the chat button or My Matters, choose your matter, then use the Documents section. Client uploads are placed in Client Uploads automatically.'],
  ['How do I pay an invoice?', 'Open My Matters, go to Invoices and payment proof, then upload your M-PESA or bank transfer reference after paying.'],
  ['Can I see case notes?', 'Private advocate notes are not shown in the client portal. Your portal shows shared matter status, documents, invoices and court dates.'],
  ['How do I contact the firm?', 'Use Message Firm in this help panel. Your message is saved against the selected matter and the legal team is notified.'],
  ['Where do I download documents?', 'Use the Documents page for all shared files, or open a specific matter and use its document browser.'],
];

export default function ClientChatWidget({ firm, matters = [], selectedMatterId = '', user, notify }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('FAQ');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(faqItems[0][0]);
  const [matterId, setMatterId] = useState(selectedMatterId || matters[0]?.id || '');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const unread = 0;

  useEffect(() => {
    if (selectedMatterId) setMatterId(selectedMatterId);
  }, [selectedMatterId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return faqItems;
    return faqItems.filter(([question, answer]) => `${question} ${answer}`.toLowerCase().includes(needle));
  }, [query]);

  async function sendMessage(event) {
    event.preventDefault();
    const targetMatter = matterId || selectedMatterId || matters[0]?.id;
    if (!targetMatter || !message.trim()) return notify?.({ type: 'warning', message: 'Choose a matter and write a message first.' });
    setSending(true);
    try {
      await api(`/matters/${targetMatter}/notes`, { method: 'POST', body: { content: message } });
      setMessage('');
      notify?.({ type: 'success', message: 'Message sent to the firm.' });
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Open help and chat"
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed',
          right: 22,
          bottom: 22,
          zIndex: 2500,
          width: 54,
          height: 54,
          borderRadius: 999,
          border: 0,
          background: firm?.accentColor || theme.gold,
          color: '#fff',
          fontSize: 22,
          boxShadow: theme.shadowLift,
          cursor: 'pointer',
        }}
      >
        💬
        <span style={{ position: 'absolute', top: -3, right: -3, minWidth: 18, height: 18, borderRadius: 999, display: 'grid', placeItems: 'center', background: theme.green, color: '#fff', fontSize: 10, fontWeight: 900, border: '2px solid #fff' }}>{unread}</span>
      </button>
      <div
        aria-hidden={!open}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: open ? 2600 : -1,
          pointerEvents: open ? 'auto' : 'none',
          background: open ? 'rgba(15,27,51,.18)' : 'rgba(15,27,51,0)',
          transition: 'background .18s ease',
        }}
        onClick={() => setOpen(false)}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Help and chat"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          zIndex: 2700,
          width: 360,
          maxWidth: 'calc(100vw - 24px)',
          background: '#fff',
          borderLeft: `1px solid ${theme.line}`,
          boxShadow: theme.shadowLift,
          transform: open ? 'translateX(0)' : 'translateX(105%)',
          transition: 'transform .22s ease',
          display: 'grid',
          gridTemplateRows: 'auto auto 1fr',
        }}
      >
        <div style={{ padding: 18, borderBottom: `1px solid ${theme.line}`, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <div>
            <div style={styles.eyebrow}>{firm?.name || 'LexFlow Kenya'}</div>
            <h2 style={{ margin: '2px 0 0', fontSize: 18 }}>Help & Chat</h2>
          </div>
          <button type="button" aria-label="Close help and chat" onClick={() => setOpen(false)} style={styles.toastClose}>x</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 12, borderBottom: `1px solid ${theme.line}` }}>
          {['FAQ', 'Message Firm'].map(item => (
            <button key={item} type="button" onClick={() => setTab(item)} style={{ ...styles.loginModeButton, ...(tab === item ? styles.loginModeActive : {}) }}>{item}</button>
          ))}
        </div>
        <div style={{ padding: 16, overflowY: 'auto' }}>
          {tab === 'FAQ' ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <Field label="Search FAQ">
                <input style={styles.input} value={query} onChange={event => setQuery(event.target.value)} placeholder="Court dates, invoices, documents..." />
              </Field>
              {filtered.length ? filtered.map(([question, answer]) => (
                <button
                  key={question}
                  type="button"
                  onClick={() => setExpanded(expanded === question ? '' : question)}
                  style={{ textAlign: 'left', border: `1px solid ${theme.line}`, borderRadius: 10, background: '#fff', padding: 12, cursor: 'pointer' }}
                >
                  <strong>{question}</strong>
                  <div style={{ color: theme.muted, fontSize: 12, marginTop: expanded === question ? 8 : 0, maxHeight: expanded === question ? 120 : 0, overflow: 'hidden', transition: 'max-height .18s ease, margin .18s ease' }}>{answer}</div>
                </button>
              )) : (
                <div style={{ display: 'grid', gap: 10 }}>
                  <Empty title="No FAQ match" text="Send the firm a short message and they will respond through your matter file." />
                  <button type="button" style={styles.primaryButton} onClick={() => setTab('Message Firm')}>Message Firm</button>
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={sendMessage} style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                <strong>Send a private message</strong>
                <Badge tone="blue">Secure</Badge>
              </div>
              <Field label="Matter">
                <select style={styles.input} value={matterId || selectedMatterId || matters[0]?.id || ''} onChange={event => setMatterId(event.target.value)}>
                  {matters.map(matter => <option key={matter.id} value={matter.id}>{matter.title}</option>)}
                </select>
              </Field>
              <Field label="Message">
                <textarea
                  required
                  rows={7}
                  style={{ ...styles.input, resize: 'vertical', minHeight: 132 }}
                  value={message}
                  onChange={event => setMessage(event.target.value)}
                  placeholder={`Hello ${firm?.name || 'the firm'}, I need help with...`}
                />
              </Field>
              <button type="submit" disabled={sending || !matters.length} style={styles.primaryButton}>{sending ? 'Sending...' : 'Send message'}</button>
              <p>Messages are saved to your matter file and notify the legal team.</p>
            </form>
          )}
        </div>
      </aside>
    </>
  );
}
