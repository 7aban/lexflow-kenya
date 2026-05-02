import { useEffect, useState } from 'react';
import { api, createInvitation, getInvitations } from '../lib/apiClient.js';
import { styles } from '../theme.jsx';
import { Badge, Card, Empty, Field, Skeleton, Table } from '../components/ui.jsx';

function fmt(value) {
  return value ? new Date(value).toLocaleString() : '-';
}

function tone(status) {
  return status === 'used' ? 'green' : status === 'expired' ? 'red' : 'amber';
}

export default function Invitations({ clients = [], notify }) {
  const [invitations, setInvitations] = useState([]);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ email: '', clientId: '' });
  const [lastLink, setLastLink] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [invites, team] = await Promise.all([getInvitations(), api('/auth/users')]);
      setInvitations(invites);
      setUsers(team);
    } catch (err) { notify({ type: 'danger', message: err.message }); }
    finally { setLoading(false); }
  }

  async function submit(event) {
    event.preventDefault();
    try {
      const invite = await createInvitation(form);
      setLastLink(invite.url);
      setForm({ email: '', clientId: '' });
      notify({ type: 'success', message: 'Invitation generated.' });
      await load();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  async function copy(link) {
    try {
      await navigator.clipboard.writeText(link);
      notify({ type: 'success', message: 'Invitation link copied.' });
    } catch {
      notify({ type: 'warning', message: 'Copy failed. Select the link and copy it manually.' });
    }
  }

  const linkedClientIds = new Set(users.filter(user => user.role === 'client' && user.clientId).map(user => user.clientId));
  const availableClients = clients.filter(client => !linkedClientIds.has(client.id));

  return (
    <div style={styles.pageStack}>
      <Card title="Generate Client Invitation" hint="Create a secure one-time link so clients can set their own password.">
        <form onSubmit={submit} style={styles.formGrid}>
          <Field label="Client Email">
            <input required type="email" style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="client@example.com" />
          </Field>
          <Field label="Linked Client">
            <select style={styles.input} value={form.clientId} onChange={e => {
              const client = clients.find(c => c.id === e.target.value);
              setForm({ ...form, clientId: e.target.value, email: form.email || client?.email || '' });
            }}>
              <option value="">No linked client yet</option>
              {availableClients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
            </select>
          </Field>
          <button style={styles.primaryButton}>Generate Invitation</button>
        </form>
        {lastLink && (
          <div style={{ ...styles.alert, marginTop: 14 }}>
            <strong>Invitation ready</strong>
            <div style={{ marginTop: 8, overflowWrap: 'anywhere' }}>{lastLink}</div>
            <button type="button" style={{ ...styles.ghostButton, marginTop: 10 }} onClick={() => copy(lastLink)}>Copy Link</button>
          </div>
        )}
      </Card>

      <Card title="Invitation Register" hint={`${invitations.length} invitation(s)`}>
        {loading ? <Skeleton rows={3} /> : invitations.length ? (
          <Table
            columns={['Email', 'Client', 'Status', 'Created', 'Expires', 'Link']}
            rows={invitations.map(invite => [
              invite.email,
              invite.clientName || invite.clientId || '-',
              <Badge key={`${invite.id}-status`} tone={tone(invite.status)}>{invite.status}</Badge>,
              fmt(invite.createdAt),
              fmt(invite.expiresAt),
              invite.status === 'pending' ? <button key={invite.id} type="button" style={styles.tinyButton} onClick={() => copy(invite.url)}>Copy Link</button> : <span style={styles.mutedText}>-</span>,
            ])}
            empty="No invitations yet."
          />
        ) : <Empty title="No invitations yet" text="Generate a link to invite a client into the portal." />}
      </Card>
    </div>
  );
}
