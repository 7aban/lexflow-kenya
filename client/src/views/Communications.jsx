import { useEffect, useMemo, useState } from 'react';
import { createConversation, downloadWithAuth, fileToDataUrl, getClientActivity, getConversationMessages, getConversations, markConversationRead, sendConversationMessage, updateConversationStatus } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Badge, Card, Empty, Field, Skeleton, Table } from '../components/ui.jsx';

function titleFor(conversation) {
  return conversation.subject || conversation.matterTitle || conversation.clientName || 'Client conversation';
}

function previewTime(value) {
  return value ? new Date(value).toLocaleString() : '-';
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
        <button key={file.id} type="button" style={styles.tinyButton} onClick={() => downloadAttachment(file)}>
          {file.displayName || file.name || 'Attachment'}
        </button>
      ))}
    </div>
  );
}

function statusTone(status) {
  if (status === 'resolved') return 'green';
  if (status === 'pending') return 'amber';
  return 'amber';
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

  if (loading) return <Skeleton rows={3} />;

  return (
    <div style={styles.pageStack}>
      <section style={styles.heroCard}>
        <div>
          <div style={styles.heroKicker}>Client communications</div>
          <h2>One calm inbox for client conversations.</h2>
          <p>Threaded messages, matter context, file attachments, and client activity in one workspace.</p>
        </div>
        <div style={styles.heroFigure}>{conversations.length}</div>
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
              <button style={styles.primaryButton}>Open thread</button>
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
                <button key={item.id} type="button" onClick={() => setSelectedId(item.id)} style={{ ...styles.matterButton, ...(selectedId === item.id ? styles.matterActive : {}), ...(item.isUnread ? { borderColor: theme.gold, background: theme.amberBg } : {}) }}>
                  <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <strong>{titleFor(item)}</strong>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {item.isUnread && <Badge tone="red">{item.unreadCount || 1} unread</Badge>}
                      <Badge tone={statusTone(item.status || 'open')}>{item.status || 'open'}</Badge>
                    </span>
                  </span>
                  <span>{item.clientName || 'Client'}{item.matterTitle ? ` / ${item.matterTitle}` : ''}</span>
                  <small>{item.messageCount || 0} message(s) / {item.lastMessageSenderRole || 'no messages'} / {previewTime(item.lastMessageAt || item.createdAt)}</small>
                </button>
              )) : <Empty title="No conversations" text="Start a conversation or wait for a client message." />}
            </div>
          </Card>
        </div>

        <div style={styles.pageStack}>
          <Card title={selected ? titleFor(selected) : 'Conversation'} hint={selected ? `${selected.clientName || 'Client'} ${selected.reference ? `/ ${selected.reference}` : ''}` : 'Select a thread'}>
            {!selected ? <Empty title="No thread selected" text="Choose a conversation from the inbox." /> : threadLoading ? <Skeleton rows={1} /> : (
              <div style={{ display: 'grid', gap: 12 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Badge tone={statusTone(selected.status || 'open')}>{selected.status || 'open'}</Badge>
                    {selected.isUnread && <Badge tone="red">{selected.unreadCount || 1} unread</Badge>}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <button type="button" style={styles.tinyButton} onClick={markSelectedRead}>Mark read</button>
                    {['open', 'pending', 'resolved'].map(status => (
                      <button key={status} type="button" style={{ ...styles.tinyButton, ...(selected.status === status ? { background: theme.navy800, color: '#fff', borderColor: theme.navy800 } : {}) }} onClick={() => changeSelectedStatus(status)}>
                        {status}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 10, maxHeight: 430, overflowY: 'auto', paddingRight: 4 }}>
                  {messages.length ? messages.map(message => {
                    const firmSide = message.senderRole !== 'client';
                    return (
                      <div key={message.id} style={{ display: 'grid', justifyItems: firmSide ? 'end' : 'start' }}>
                        <div style={{ maxWidth: '78%', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 12, background: firmSide ? '#FDF8EE' : '#fff' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                            <strong>{firmSide ? message.senderName || 'Firm team' : message.senderName || selected.clientName || 'Client'}</strong>
                            <Badge tone={firmSide ? 'green' : 'amber'}>{message.senderRole}</Badge>
                          </div>
                          {message.body && <p style={{ marginTop: 7, color: theme.ink }}>{message.body}</p>}
                          {attachmentList(message.attachments, notify)}
                          <small style={{ color: theme.muted }}>{previewTime(message.createdAt)}</small>
                        </div>
                      </div>
                    );
                  }) : <Empty title="No messages yet" text="Send the first note in this thread." />}
                </div>

                <form onSubmit={sendReply} style={{ display: 'grid', gap: 10, borderTop: `1px solid ${theme.line}`, paddingTop: 12 }}>
                  <Field label="Reply">
                    <textarea style={{ ...styles.input, minHeight: 96, resize: 'vertical' }} value={reply.body} onChange={event => setReply({ ...reply, body: event.target.value })} placeholder="Write a clear client-friendly reply..." />
                  </Field>
                  <Field label="Attachment">
                    <input type="file" style={styles.input} onChange={event => setReply({ ...reply, file: event.target.files?.[0] || null })} />
                  </Field>
                  <button style={styles.primaryButton}>Send reply</button>
                </form>
              </div>
            )}
          </Card>

          <Card title="Client activity" hint="Recent portal activity for this client">
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
          </Card>
        </div>
      </div>
    </div>
  );
}
