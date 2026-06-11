import { useEffect, useMemo, useRef, useState } from 'react';
import { createConversation, downloadWithAuth, fileToDataUrl, getClientActivity, getConversationMessages, getConversations, getMessageAvatar, markConversationRead, sendConversationMessage, updateConversationStatus } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Badge, Card, Field, Table } from '../components/ui.jsx';

function titleFor(conversation) {
  return conversation.subject || conversation.matterTitle || conversation.clientName || 'Client conversation';
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function previewTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const now = new Date();
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (dayDiff === 0) {
    return `Today ${date.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  }
  if (dayDiff === 1) return 'Yesterday';
  const dayMonth = `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? dayMonth : `${dayMonth} ${date.getFullYear()}`;
}

function messageCountLabel(count) {
  const n = Number(count) || 0;
  if (n === 0) return 'No messages';
  if (n === 1) return '1 message';
  return `${n} messages`;
}

function lastFromLabel(item) {
  const role = item?.lastMessageSenderRole;
  if (!role || role === 'no messages') return '';
  if (role === 'client') return item?.clientName || 'Client';
  return 'Firm';
}

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

function attachmentList(files = [], notify) {
  if (!files.length) return null;
  const downloadAttachment = async (file) => {
    try {
      await downloadWithAuth(`/api/documents/${file.id}/download`, file.displayName || file.name || 'attachment');
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    }
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {files.map(file => (
        <button key={file.id} type="button" style={commStyles.tinyButton} onClick={() => downloadAttachment(file)}>
          {file.displayName || file.name || 'Attachment'}
        </button>
      ))}
    </div>
  );
}

function statusTone(status) {
  if (status === 'resolved') return 'green';
  if (status === 'pending') return 'amber';
  return 'blue';
}

const commPalette = {
  forestDark: '#112219',
  forest: '#1A3628',
  gold: '#C5973C',
  cream: '#F5F2EB',
  warm: '#FAF8F4',
  warmStrong: '#FEF5E4',
  border: '#E8E2D6',
  borderStrong: '#DDD8CE',
  muted: '#5B5346',
};

const commStyles = {
  heroCard: {
    borderRadius: 10,
    background: `linear-gradient(135deg, ${commPalette.forestDark}, ${commPalette.forest})`,
    color: '#fff',
    padding: 24,
    display: 'flex',
    justifyContent: 'space-between',
    gap: 20,
    alignItems: 'end',
    boxShadow: '0 1px 3px rgba(17,34,25,.08), 0 18px 40px rgba(17,34,25,.10)',
  },
  heroKicker: {
    color: commPalette.gold,
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  heroFigure: {
    fontSize: 24,
    fontWeight: 700,
    color: commPalette.gold,
  },
  primaryButton: {
    border: 0,
    borderRadius: 8,
    padding: '8px 16px',
    background: commPalette.forestDark,
    color: '#fff',
    fontWeight: 700,
    cursor: 'pointer',
    fontSize: 13,
    boxShadow: '0 8px 18px rgba(17,34,25,.14)',
  },
  tinyButton: {
    border: `1px solid ${commPalette.border}`,
    borderRadius: 6,
    padding: '4px 10px',
    background: '#fff',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    color: commPalette.forest,
  },
  statusActive: {
    background: commPalette.forest,
    color: '#fff',
    border: `1px solid ${commPalette.forest}`,
    boxShadow: '0 6px 14px rgba(17,34,25,.14)',
  },
  threadButton: {
    borderBottom: `1px solid ${commPalette.border}`,
    color: theme.ink,
  },
  threadUnread: {
    borderLeftColor: commPalette.gold,
    background: commPalette.warmStrong,
  },
  threadActive: {
    borderLeftColor: commPalette.gold,
    background: commPalette.warm,
    boxShadow: `inset 0 0 0 1px ${commPalette.border}`,
  },
  empty: {
    minHeight: 136,
    display: 'grid',
    placeItems: 'center',
    textAlign: 'center',
    color: commPalette.muted,
    gap: 6,
    padding: 18,
  },
  emptyIcon: {
    width: 42,
    height: 42,
    borderRadius: 10,
    display: 'grid',
    placeItems: 'center',
    background: commPalette.warmStrong,
    color: commPalette.forest,
    border: `1px solid ${commPalette.border}`,
    fontWeight: 800,
  },
  skeleton: {
    height: 120,
    borderRadius: 10,
    background: '#fff',
    border: `1px solid ${commPalette.border}`,
    boxShadow: theme.shadow,
    padding: 16,
    display: 'grid',
    gap: 10,
    alignContent: 'start',
  },
  skeletonLineLarge: {
    height: 18,
    width: '55%',
    borderRadius: 6,
    background: commPalette.borderStrong,
    animation: 'lfPulse 1.4s ease-in-out infinite',
  },
  skeletonLine: {
    height: 12,
    width: '80%',
    borderRadius: 6,
    background: commPalette.cream,
    animation: 'lfPulse 1.4s ease-in-out infinite',
  },
  skeletonLineShort: {
    height: 12,
    width: '42%',
    borderRadius: 6,
    background: commPalette.cream,
    animation: 'lfPulse 1.4s ease-in-out infinite',
  },
};

function CommunicationsEmpty({ title, text }) {
  return <div style={commStyles.empty}><div style={commStyles.emptyIcon}>LF</div><strong>{title}</strong><span>{text}</span></div>;
}

function CommunicationsSkeleton({ rows = 4 }) {
  return (
    <div style={styles.skeletonGrid}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} style={commStyles.skeleton}>
          <span style={commStyles.skeletonLineLarge} />
          <span style={commStyles.skeletonLine} />
          <span style={commStyles.skeletonLineShort} />
        </div>
      ))}
    </div>
  );
}

export default function Communications({ clients = [], matters = [], focus, notify }) {
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [reply, setReply] = useState({ body: '', file: null });
  const [newThread, setNewThread] = useState({ clientId: '', matterId: '', subject: '' });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const selected = conversations.find(item => item.id === selectedId);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return conversations.filter(item => {
      const matchesStatus = statusFilter === 'all' || (item.status || 'open') === statusFilter;
      const matchesSearch = !needle || `${item.subject || ''} ${item.clientName || ''} ${item.matterTitle || ''} ${item.reference || ''}`.toLowerCase().includes(needle);
      return matchesStatus && matchesSearch;
    });
  }, [conversations, search, statusFilter]);

  const matterOptions = useMemo(() => {
    if (!newThread.clientId) return matters;
    return matters.filter(matter => matter.clientId === newThread.clientId);
  }, [matters, newThread.clientId]);

  useEffect(() => { loadConversations(); }, []);

  useEffect(() => {
    if (!focus?.matterId && !focus?.clientId) return;
    const match = conversations.find(item => (focus.matterId && item.matterId === focus.matterId) || (focus.clientId && item.clientId === focus.clientId));
    if (match) setSelectedId(match.id);
    else {
      const matter = matters.find(item => item.id === focus.matterId);
      setNewThread(current => ({
        ...current,
        clientId: focus.clientId || matter?.clientId || current.clientId,
        matterId: focus.matterId || current.matterId,
        subject: current.subject || (matter ? `Follow up: ${matter.title}` : 'Client follow-up'),
      }));
    }
  }, [focus?.matterId, focus?.clientId, focus?.ts, conversations]);

  useEffect(() => {
    if (selected?.id) loadThread(selected);
    else {
      setMessages([]);
      setActivity([]);
    }
  }, [selected?.id]);

  async function loadConversations() {
    setLoading(true);
    try {
      const rows = await getConversations();
      setConversations(rows);
      setSelectedId(current => current || rows[0]?.id || '');
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setLoading(false);
    }
  }

  async function loadThread(conversation) {
    setThreadLoading(true);
    try {
      const [nextMessages, nextActivity] = await Promise.all([
        getConversationMessages(conversation.id),
        conversation.clientId ? getClientActivity(conversation.clientId, 50).catch(() => []) : Promise.resolve([]),
      ]);
      setMessages(nextMessages);
      setActivity(nextActivity);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setThreadLoading(false);
    }
  }

  function updateConversationRow(next) {
    setConversations(current => current.map(item => item.id === next.id ? { ...item, ...next } : item));
  }

  async function markSelectedRead() {
    if (!selected) return;
    try {
      const next = await markConversationRead(selected.id);
      updateConversationRow(next);
      notify?.({ type: 'success', message: 'Conversation marked read.' });
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    }
  }

  async function changeSelectedStatus(status) {
    if (!selected) return;
    try {
      const next = await updateConversationStatus(selected.id, status);
      updateConversationRow(next);
      notify?.({ type: 'success', message: `Conversation marked ${status}.` });
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    }
  }

  async function startThread(event) {
    event.preventDefault();
    if (!newThread.clientId && !newThread.matterId) return notify?.({ type: 'warning', message: 'Choose a client or matter first.' });
    try {
      const created = await createConversation(newThread);
      setNewThread({ clientId: '', matterId: '', subject: '' });
      setConversations(current => [created, ...current]);
      setSelectedId(created.id);
      notify?.({ type: 'success', message: 'Conversation opened.' });
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    }
  }

  async function sendReply(event) {
    event.preventDefault();
    if (!selected || (!reply.body.trim() && !reply.file)) return;
    try {
      const attachments = reply.file ? [{
        name: reply.file.name,
        mimeType: reply.file.type || 'application/octet-stream',
        data: await fileToDataUrl(reply.file),
      }] : [];
      const saved = await sendConversationMessage(selected.id, { body: reply.body, attachments });
      setMessages(current => [...current, saved]);
      setReply({ body: '', file: null });
      await loadConversations();
      notify?.({ type: 'success', message: 'Reply sent.' });
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    }
  }

  if (loading) return <CommunicationsSkeleton rows={3} />;

  return (
    <div style={styles.pageStack}>
      <section style={commStyles.heroCard}>
        <div>
          <div style={commStyles.heroKicker}>Client communications</div>
          <h2>One calm inbox for client conversations.</h2>
          <p>Threaded messages, matter context, file attachments, and client activity in one workspace.</p>
        </div>
        <div style={commStyles.heroFigure}>{conversations.length}</div>
      </section>

      <div className="lf-split-grid" style={styles.splitGrid}>
        <div style={styles.pageStack}>
          <Card title="Start conversation" hint="Open a general or matter-specific thread">
            <form onSubmit={startThread} style={styles.formGrid}>
              <Field label="Client">
                <select style={styles.input} value={newThread.clientId} onChange={event => setNewThread({ ...newThread, clientId: event.target.value, matterId: '' })}>
                  <option value="">Select client</option>
                  {clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
                </select>
              </Field>
              <Field label="Matter">
                <select style={styles.input} value={newThread.matterId} onChange={event => {
                  const matter = matters.find(item => item.id === event.target.value);
                  setNewThread({ ...newThread, matterId: event.target.value, clientId: matter?.clientId || newThread.clientId });
                }}>
                  <option value="">General thread</option>
                  {matterOptions.map(matter => <option key={matter.id} value={matter.id}>{matter.reference || matter.id} - {matter.title}</option>)}
                </select>
              </Field>
              <Field label="Subject">
                <input style={styles.input} value={newThread.subject} onChange={event => setNewThread({ ...newThread, subject: event.target.value })} placeholder="Document review, hearing update..." />
              </Field>
              <button style={commStyles.primaryButton}>Open thread</button>
            </form>
          </Card>

          <Card title="Inbox" hint={`${filtered.length} conversation(s)`}>
            <Field label="Search">
              <input style={styles.input} value={search} onChange={event => setSearch(event.target.value)} placeholder="Client, matter, reference..." />
            </Field>
            <Field label="Status">
              <select style={styles.input} value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
                <option value="all">All statuses</option>
                <option value="open">Open</option>
                <option value="pending">Pending</option>
                <option value="resolved">Resolved</option>
              </select>
            </Field>
            <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
              {filtered.length ? filtered.map(item => (
                <button key={item.id} type="button" onClick={() => setSelectedId(item.id)} style={{ ...styles.matterButton, ...commStyles.threadButton, ...(item.isUnread ? commStyles.threadUnread : {}), ...(selectedId === item.id ? commStyles.threadActive : {}) }}>
                  <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <strong>{titleFor(item)}</strong>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {item.isUnread && <Badge tone="red">{item.unreadCount || 1} unread</Badge>}
                      <Badge tone={statusTone(item.status || 'open')}>{item.status || 'open'}</Badge>
                    </span>
                  </span>
                  <span>{item.clientName || 'Client'}{item.matterTitle ? ` / ${item.matterTitle}` : ''}</span>
                  <small>{[messageCountLabel(item.messageCount), lastFromLabel(item) ? `Last from ${lastFromLabel(item)}` : '', previewTime(item.lastMessageAt || item.createdAt)].filter(Boolean).join(' · ')}</small>
                </button>
              )) : <CommunicationsEmpty title="No conversations" text="Start a conversation or wait for a client message." />}
            </div>
          </Card>
        </div>

        <div style={styles.pageStack}>
          <Card title={selected ? titleFor(selected) : 'Conversation'} hint={selected ? `${selected.clientName || 'Client'} ${selected.reference ? `/ ${selected.reference}` : ''}` : 'Select a thread'}>
            {!selected ? <CommunicationsEmpty title="No thread selected" text="Choose a conversation from the inbox." /> : threadLoading ? <CommunicationsSkeleton rows={1} /> : (
              <div style={{ display: 'grid', gap: 12 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Badge tone={statusTone(selected.status || 'open')}>{selected.status || 'open'}</Badge>
                    {selected.isUnread && <Badge tone="red">{selected.unreadCount || 1} unread</Badge>}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <button type="button" style={commStyles.tinyButton} onClick={markSelectedRead}>Mark read</button>
                    {['open', 'pending', 'resolved'].map(status => (
                      <button key={status} type="button" style={{ ...commStyles.tinyButton, ...(selected.status === status ? commStyles.statusActive : {}) }} onClick={() => changeSelectedStatus(status)}>
                        {status}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 10, maxHeight: 430, overflowY: 'auto', paddingRight: 4 }}>
                  {messages.length ? messages.map(message => {
                    const firmSide = message.senderRole !== 'client';
                    const senderDisplayName = firmSide ? message.senderName || 'Firm team' : message.senderName || selected.clientName || 'Client';
                    return (
                      <div key={message.id} style={{ display: 'grid', justifyItems: firmSide ? 'end' : 'start' }}>
                        <div style={{ maxWidth: '78%', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 12, background: firmSide ? '#FDF8EE' : '#fff' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                              <MessageAvatar conversationId={selected.id} messageId={message.id} hasAvatar={message.senderHasAvatar} name={senderDisplayName} />
                              <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{senderDisplayName}</strong>
                            </div>
                            <Badge tone={firmSide ? 'green' : 'amber'}>{message.senderRole}</Badge>
                          </div>
                          {message.body && <p style={{ marginTop: 7, color: theme.ink }}>{message.body}</p>}
                          {attachmentList(message.attachments, notify)}
                          <small style={{ color: theme.muted }}>{previewTime(message.createdAt)}</small>
                        </div>
                      </div>
                    );
                  }) : <CommunicationsEmpty title="No messages yet" text="Send the first note in this thread." />}
                </div>

                <form onSubmit={sendReply} style={{ display: 'grid', gap: 10, borderTop: `1px solid ${theme.line}`, paddingTop: 12 }}>
                  <Field label="Message">
                    <textarea style={{ ...styles.input, minHeight: 96, resize: 'vertical' }} value={reply.body} onChange={event => setReply({ ...reply, body: event.target.value })} placeholder="Write a clear client-friendly message..." />
                  </Field>
                  <Field label="Attachment">
                    <input type="file" style={styles.input} onChange={event => setReply({ ...reply, file: event.target.files?.[0] || null })} />
                  </Field>
                  <button style={commStyles.primaryButton}>Send message</button>
                </form>
              </div>
            )}
          </Card>

          <Card title="Client activity" hint="Recent portal activity for this client">
            <div className="lf-communications-cards">
              {activity.length ? (
                <Table
                  columns={['When', 'Action', 'Matter', 'Summary']}
                  rows={activity.map(item => [
                    previewTime(item.createdAt),
                    item.action || '-',
                    item.matterTitle || item.reference || '-',
                    item.summary || '-',
                  ])}
                  empty="No activity yet."
                />
              ) : <CommunicationsEmpty title="No activity yet." text="Once records exist, they will appear here." />}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
