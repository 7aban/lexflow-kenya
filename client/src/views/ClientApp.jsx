import { useEffect, useState } from 'react';
import { API_BASE, api, readSession } from '../lib/apiClient.js';
import { styles, StyleTag, theme } from '../theme.jsx';
import { Badge, Card, Empty, kes, Logo, MeetingLink, Skeleton, statusTone, Table, Toast } from '../components/ui.jsx';

export default function ClientApp({ user, firm, logout, notify, toast, setToast }) {
  const [dashboard, setDashboard] = useState({ matters: [], documents: [], invoices: [], notes: [], appearances: [] });
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const selected = dashboard.matters.find(m => m.id === selectedId) || dashboard.matters[0];
  const matterDocs = dashboard.documents.filter(d => d.matterId === selected?.id);
  const matterInvoices = dashboard.invoices.filter(i => i.matterId === selected?.id);
  const matterNotes = dashboard.notes.filter(n => n.matterId === selected?.id);
  const matterEvents = dashboard.appearances.filter(a => a.matterId === selected?.id);

  useEffect(() => { load(); }, []);
  useEffect(() => { if (selected?.id) setSelectedId(selected.id); }, [selected?.id]);
  async function load() {
    setLoading(true);
    try { setDashboard(await api('/client/dashboard')); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
    finally { setLoading(false); }
  }
  async function sendMessage(event) {
    event.preventDefault();
    if (!selected || !message.trim()) return;
    try {
      await api(`/matters/${selected.id}/notes`, { method: 'POST', body: { content: message } });
      setMessage('');
      notify({ type: 'success', message: 'Message sent to the firm.' });
      await load();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  return <div style={{ ...styles.clientShell, '--lf-primary': firm?.primaryColor || theme.navy800, '--lf-accent': firm?.accentColor || theme.gold }}><StyleTag /><header style={styles.clientHeader}><div style={styles.clientBrand}><Logo firm={firm} /><div><strong>{firm.name || 'LexFlow Kenya'}</strong><span>Client portal</span></div></div><div style={styles.clientActions}>{firm.websiteURL && <a style={styles.ghostButton} href={firm.websiteURL} target="_blank" rel="noopener noreferrer">Visit our website</a>}<button type="button" style={styles.ghostButton} onClick={logout}>Sign out</button></div></header>{loading ? <Skeleton /> : <main style={styles.clientMain}><section style={styles.clientMatterList}><Card title="Your matters" hint={`${dashboard.matters.length} active file(s)`}>{dashboard.matters.length ? dashboard.matters.map(m => <button key={m.id} type="button" onClick={() => setSelectedId(m.id)} style={{ ...styles.matterButton, ...(selected?.id === m.id ? styles.matterActive : {}) }}><strong>{m.title}</strong><span>{m.reference || m.id}</span><small>{m.stage || 'Intake'}</small></button>) : <Empty title="No matters yet" text="Your matter list will appear here when the firm opens a file." />}</Card></section><section style={styles.pageStack}>{selected ? <><Card title={selected.title} hint={selected.reference || 'Matter overview'}><div style={styles.clientStatusGrid}><Badge tone="blue">{selected.stage || 'Intake'}</Badge><span>{selected.practiceArea || 'General'}</span><span>{selected.assignedTo || 'Firm team'}</span></div><p style={styles.clientDescription}>{selected.description || 'No description has been added yet.'}</p></Card><Card title="Timeline" hint="Upcoming appearances"><Table columns={['Event', 'Date', 'Time', 'Location', 'Virtual Court']} rows={matterEvents.map(a => [a.title || a.type || 'Appearance', a.date || '-', a.time || '-', a.location || '-', <MeetingLink key={a.id} event={a} />])} empty="No court dates shared yet." /></Card><Card title="Documents" hint="Download only"><Table columns={['Name', 'Type', 'Size', 'Download']} rows={matterDocs.map(d => [d.name, d.type, d.size, <a key={d.id} style={styles.link} href={`${API_BASE}/documents/${d.id}/download?token=${encodeURIComponent(readSession()?.token || '')}`}>Download</a>])} empty="No documents shared yet." /></Card><Card title="Invoices" hint="Billing history"><Table columns={['Invoice', 'Amount', 'Status', 'PDF']} rows={matterInvoices.map(i => [i.number || i.id, kes(i.amount), <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <a key={`${i.id}-pdf`} style={styles.link} href={`${API_BASE}/invoices/${i.id}/pdf?token=${encodeURIComponent(readSession()?.token || '')}`}>PDF</a>])} empty="No invoices shared yet." /></Card><Card title="Contact the firm" hint="Message is saved to the matter notes"><form onSubmit={sendMessage} style={styles.noteForm}><input style={styles.input} value={message} onChange={e => setMessage(e.target.value)} placeholder="Write a message about this matter" /><button style={styles.primaryButton}>Send</button></form><Table columns={['Recent note', 'Author', 'Created']} rows={matterNotes.slice(0, 6).map(n => [n.content, n.author || '-', n.createdAt ? new Date(n.createdAt).toLocaleString() : '-'])} empty="No messages yet." /></Card></> : <Empty title="Select a matter" text="Your matter details will appear here." />}</section></main>}<Toast toast={toast} onClose={() => setToast(null)} /></div>;
}

