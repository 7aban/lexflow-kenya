import { useEffect, useMemo, useRef, useState } from 'react';
import { createConversation, downloadWithAuth, fileToDataUrl, getConversationMessages, getConversations, getMessageAvatar, markConversationRead, sendConversationMessage } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Badge, Empty, Field } from './ui.jsx';

function MessageAvatar({ conversationId, messageId, hasAvatar, name, size = 28 }) {
  const [src, setSrc] = useState(null);
  const srcRef = useRef(null);
  useEffect(() => {
    function revoke() { if (srcRef.current) { URL.revokeObjectURL(srcRef.current); srcRef.current = null; } }
    if (!hasAvatar || !conversationId || !messageId) { revoke(); setSrc(null); return undefined; }
    let alive = true;
    getMessageAvatar(conversationId, messageId).then(url => {
      if (!alive) { if (url) URL.revokeObjectURL(url); return; }
      revoke();
      srcRef.current = url;
      setSrc(url);
    });
    return () => { alive = false; revoke(); };
  }, [conversationId, messageId, hasAvatar]);
  const initial = (name || '?').slice(0, 1).toUpperCase();
  return (
    <div style={{ width: size, height: size, borderRadius: 999, background: 'var(--lf-accent, #D4A34A)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: Math.round(size * 0.43), overflow: 'hidden', flexShrink: 0 }}>
      {src
        ? <img src={src} alt={name || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={() => setSrc(null)} />
        : initial}
    </div>
  );
}

const faqItems = [
  ['How do I view my court date?', 'Open My Matters, choose the relevant matter, then check Court appearances. If a virtual link exists, it appears beside the event.'],
  ['How do I upload a document?', 'Open the chat button or My Matters, choose your matter, then use the Documents section. Client uploads are placed in Client Uploads automatically.'],
  ['How do I pay an invoice?', 'Open My Matters, go to Invoices and payment proof, then upload your M-PESA or bank transfer reference after paying.'],
  ['Can I see case notes?', 'Private advocate notes are not shown in the client portal. Your portal shows shared matter status, documents, invoices and court dates.'],
  ['How do I contact the firm?', 'Use Message Firm in this help panel. Your message is saved against the selected matter and the legal team is notified.'],
  ['Where do I download documents?', 'Use the Documents page for all shared files, or open a specific matter and use its document browser.'],
];

export default function ClientChatWidget({ firm, matters = [], selectedMatterId = '', user, notify, open: openProp, onOpen, onClose }) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = openProp !== undefined ? openProp : internalOpen;
  function toggleOpen(v) {
    if (openProp === undefined) setInternalOpen(v);
    if (v) onOpen?.();
    if (!v) onClose?.();
  }
  const [tab, setTab] = useState('FAQ');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(faqItems[0][0]);
  const [matterId, setMatterId] = useState(selectedMatterId || matters[0]?.id || '');
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState('');
  const [attachment, setAttachment] = useState(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const unread = conversations.reduce((total, item) => total + Number(item.clientUnreadCount ?? item.unreadCount ?? 0), 0);

  useEffect(() => {
    if (selectedMatterId) setMatterId(selectedMatterId);
  }, [selectedMatterId]);

  useEffect(() => { loadConversations(); }, []);

  useEffect(() => {
    if (isOpen && tab === 'Message Firm') loadConversations();
  }, [isOpen, tab]);

  useEffect(() => {
    if (!matterId || !conversations.length) {
      setActiveConversation(null);
      setMessages([]);
      return;
    }
    const existing = conversations.find(item => item.matterId === matterId);
    setActiveConversation(existing || null);
  }, [matterId, conversations]);

  useEffect(() => {
    if (activeConversation?.id) loadMessages(activeConversation.id);
    else setMessages([]);
  }, [activeConversation?.id]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return faqItems;
    return faqItems.filter(([question, answer]) => `${question} ${answer}`.toLowerCase().includes(needle));
  }, [query]);

  async function loadConversations() {
    try {
      const rows = await getConversations();
      setConversations(rows);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    }
  }

  async function loadMessages(conversationId) {
    setLoadingThread(true);
    try {
      setMessages(await getConversationMessages(conversationId));
      const conversation = conversations.find(item => item.id === conversationId);
      if (conversation && Number(conversation.clientUnreadCount ?? conversation.unreadCount ?? 0) > 0) {
        const next = await markConversationRead(conversationId);
        setConversations(current => current.map(item => item.id === conversationId ? { ...item, ...next } : item));
      }
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setLoadingThread(false);
    }
  }

  async function ensureConversation(targetMatter) {
    const existing = conversations.find(item => item.matterId === targetMatter);
    if (existing) return existing;
    const matter = matters.find(item => item.id === targetMatter);
    const created = await createConversation({
      matterId: targetMatter,
      subject: matter ? `Message about ${matter.title}` : 'Client message',
    });
    setConversations(current => [created, ...current]);
    return created;
  }

  async function sendMessage(event) {
    event.preventDefault();
    const targetMatter = matterId || selectedMatterId || matters[0]?.id;
    if (!targetMatter || (!message.trim() && !attachment)) return notify?.({ type: 'warning', message: 'Choose a matter and write a message first.' });
    setSending(true);
    try {
      const conversation = await ensureConversation(targetMatter);
      const attachments = attachment ? [{
        name: attachment.name,
        mimeType: attachment.type || 'application/octet-stream',
        data: await fileToDataUrl(attachment),
      }] : [];
      const saved = await sendConversationMessage(conversation.id, { body: message, attachments });
      setActiveConversation(conversation);
      setMessages(current => [...current, saved]);
      setMessage('');
      setAttachment(null);
      await loadConversations();
      notify?.({ type: 'success', message: 'Message sent to the firm.' });
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setSending(false);
    }
  }

  async function downloadAttachment(file) {
    try {
      await downloadWithAuth(`/api/documents/${file.id}/download`, file.displayName || file.name || 'attachment');
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Open help and chat"
        onClick={() => toggleOpen(true)}
        style={{
          position: 'fixed',
          right: 22,
          bottom: 22,
          zIndex: 2500,
          height: 54,
          borderRadius: 999,
          border: 0,
          background: firm?.accentColor || theme.gold,
          color: '#fff',
          fontSize: 14,
          fontWeight: 700,
          boxShadow: theme.shadowLift,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 20px 0 18px',
        }}
      >
        <span style={{ fontSize: 20, lineHeight: 1 }}>💬</span>
        <span>Chat</span>
        {unread > 0 && <span style={{ minWidth: 20, height: 20, borderRadius: 999, display: 'grid', placeItems: 'center', background: theme.green, color: '#fff', fontSize: 10, fontWeight: 900, border: '2px solid #fff', lineHeight: 1 }}>{unread}</span>}
      </button>
      <div
        aria-hidden={!isOpen}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: isOpen ? 2600 : -1,
          pointerEvents: isOpen ? 'auto' : 'none',
          background: isOpen ? 'rgba(15,27,51,.18)' : 'rgba(15,27,51,0)',
          transition: 'background .18s ease',
        }}
        onClick={() => toggleOpen(false)}
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
          transform: isOpen ? 'translateX(0)' : 'translateX(105%)',
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
          <button type="button" aria-label="Close help and chat" onClick={() => toggleOpen(false)} style={styles.toastClose}>x</button>
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
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {unread > 0 && <Badge tone="green">{unread} new</Badge>}
                  <Badge tone="blue">Secure</Badge>
                </div>
              </div>
              {matters.length === 0 ? (
                <div style={{ padding: 10, background: theme.wash, borderRadius: 8, fontSize: 13, color: '#6B7280', lineHeight: 1.5 }}>
                  No matters available yet. Once the firm adds you to a matter, you can send messages from here.
                </div>
              ) : <Field label="Matter">
                <select style={styles.input} value={matterId || selectedMatterId || matters[0]?.id || ''} onChange={event => setMatterId(event.target.value)}>
                  {matters.map(matter => <option key={matter.id} value={matter.id}>{matter.title}</option>)}
                </select>
              </Field>}
              <div style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 10, background: '#F8FAFC', display: 'grid', gap: 8, maxHeight: 230, overflowY: 'auto' }}>
                {loadingThread ? <span style={styles.mutedText}>Loading conversation...</span> : messages.length ? messages.map(item => (
                  <div key={item.id} style={{ display: 'grid', justifyItems: item.senderRole === 'client' ? 'end' : 'start' }}>
                    <div style={{ maxWidth: '86%', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 10, background: item.senderRole === 'client' ? theme.blueBg : '#fff' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <MessageAvatar conversationId={activeConversation?.id} messageId={item.id} hasAvatar={item.senderHasAvatar} name={item.senderName || (item.senderRole === 'client' ? 'You' : 'Firm team')} />
                        <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.senderRole === 'client' ? 'You' : item.senderName || 'Firm team'}</strong>
                      </div>
                      {item.body && <p style={{ margin: '5px 0 0', color: theme.ink }}>{item.body}</p>}
                      {!!item.attachments?.length && <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>{item.attachments.map(file => <button key={file.id} type="button" style={{ ...styles.link, border: 0, background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left' }} onClick={() => downloadAttachment(file)}>{file.displayName || file.name || 'Attachment'}</button>)}</div>}
                      <small style={{ color: theme.muted }}>{item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}</small>
                    </div>
                  </div>
                )) : <Empty title="No messages yet" text="Start the conversation and the firm will be notified." />}
              </div>
              <Field label="Message">
                <textarea
                  rows={7}
                  style={{ ...styles.input, resize: 'vertical', minHeight: 132 }}
                  value={message}
                  onChange={event => setMessage(event.target.value)}
                  placeholder={`Hello ${firm?.name || 'the firm'}, I need help with...`}
                />
              </Field>
              <Field label="Attachment">
                <input type="file" style={styles.input} onChange={event => setAttachment(event.target.files?.[0] || null)} />
              </Field>
              <button type="submit" disabled={sending || !matters.length} style={styles.primaryButton}>{sending ? 'Sending...' : !matters.length ? 'No matters to message about' : 'Send message'}</button>
              <p>Messages are saved in a secure conversation thread and notify the legal team.</p>
            </form>
          )}
        </div>
      </aside>
    </>
  );
}
