import { useEffect, useMemo, useState } from 'react';
import { api, getReminderLogs, getReminderTemplates, updateReminderTemplate } from '../lib/apiClient.js';
import { defaultFirmSettings, styles } from '../theme.jsx';
import { Badge, Card, Empty, Field, Table } from '../components/ui.jsx';

const placeholders = ['clientName', 'matterTitle', 'courtDate', 'courtTime', 'invoiceAmount', 'invoiceDueDate', 'firmName', 'firmPhone'];
const sample = {
  clientName: 'Amina Mwangi',
  matterTitle: 'Estate of Mwangi Succession Cause',
  courtDate: '2026-05-04',
  courtTime: '9:00 AM',
  invoiceAmount: 'KSh 75,000',
  invoiceDueDate: '2026-05-10',
  firmName: 'LexFlow Kenya',
  firmPhone: '+254 700 123456',
};

function pretty(value) {
  return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function render(text = '') {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => sample[key] ?? '');
}

export default function CommunicationSettings({ firm = defaultFirmSettings, reload, notify }) {
  const [settings, setSettings] = useState({ ...(firm.reminderSettings || {}) });
  const [templates, setTemplates] = useState([]);
  const [editing, setEditing] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => setSettings({ ...(firm.reminderSettings || {}) }), [firm.reminderSettings]);
  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [nextTemplates, nextLogs] = await Promise.all([getReminderTemplates(), getReminderLogs(25)]);
      setTemplates(nextTemplates);
      setLogs(nextLogs);
    } catch (err) { notify({ type: 'danger', message: err.message }); }
    finally { setLoading(false); }
  }

  async function saveSettings(event) {
    event.preventDefault();
    try {
      await api('/firm-settings', { method: 'PUT', body: { ...firm, reminderSettings: settings } });
      notify({ type: 'success', message: 'Reminder settings saved.' });
      await reload();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  async function saveTemplate(event) {
    event.preventDefault();
    try {
      const updated = await updateReminderTemplate(editing.id, { subject: editing.subject, body: editing.body });
      setTemplates(current => current.map(template => template.id === updated.id ? updated : template));
      setEditing(null);
      notify({ type: 'success', message: 'Template saved.' });
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  async function restoreTemplate(template) {
    try {
      const updated = await updateReminderTemplate(template.id, { subject: template.defaultSubject, body: template.defaultBody });
      setTemplates(current => current.map(item => item.id === updated.id ? updated : item));
      notify({ type: 'success', message: 'Template restored.' });
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  const grouped = useMemo(() => templates.reduce((acc, template) => {
    acc[template.eventType] = [...(acc[template.eventType] || []), template];
    return acc;
  }, {}), [templates]);

  return (
    <div style={styles.pageStack}>
      <Card title="Reminder Channels & Settings" hint="Automatic reminders only send through enabled channels. Stubs print to the server console until real credentials are added.">
        <form onSubmit={saveSettings} style={styles.formGrid}>
          <Field label="Automatic Reminders">
            <select style={styles.input} value={settings.remindersEnabled ? 'yes' : 'no'} onChange={e => setSettings({ ...settings, remindersEnabled: e.target.value === 'yes' })}>
              <option value="yes">Enabled</option>
              <option value="no">Disabled</option>
            </select>
          </Field>
          <Field label="WhatsApp">
            <select style={styles.input} value={settings.whatsappEnabled ? 'yes' : 'no'} onChange={e => setSettings({ ...settings, whatsappEnabled: e.target.value === 'yes' })}>
              <option value="no">Disabled</option>
              <option value="yes">Enabled</option>
            </select>
          </Field>
          <Field label="Email">
            <select style={styles.input} value={settings.emailEnabled ? 'yes' : 'no'} onChange={e => setSettings({ ...settings, emailEnabled: e.target.value === 'yes' })}>
              <option value="no">Disabled</option>
              <option value="yes">Enabled</option>
            </select>
          </Field>
          {settings.whatsappEnabled && (
            <>
              <Field label="Twilio SID"><input style={styles.input} value={settings.twilioSid || ''} onChange={e => setSettings({ ...settings, twilioSid: e.target.value })} /></Field>
              <Field label="Twilio Token"><input type="password" style={styles.input} value={settings.twilioToken || ''} onChange={e => setSettings({ ...settings, twilioToken: e.target.value })} /></Field>
              <Field label="WhatsApp From"><input style={styles.input} value={settings.twilioFromNumber || ''} onChange={e => setSettings({ ...settings, twilioFromNumber: e.target.value })} placeholder="whatsapp:+14155238886" /></Field>
            </>
          )}
          {settings.emailEnabled && (
            <>
              <Field label="SMTP Host"><input style={styles.input} value={settings.smtpHost || ''} onChange={e => setSettings({ ...settings, smtpHost: e.target.value })} /></Field>
              <Field label="SMTP Port"><input style={styles.input} value={settings.smtpPort || ''} onChange={e => setSettings({ ...settings, smtpPort: e.target.value })} /></Field>
              <Field label="SMTP User"><input style={styles.input} value={settings.smtpUser || ''} onChange={e => setSettings({ ...settings, smtpUser: e.target.value })} /></Field>
              <Field label="SMTP Password"><input type="password" style={styles.input} value={settings.smtpPass || ''} onChange={e => setSettings({ ...settings, smtpPass: e.target.value })} /></Field>
            </>
          )}
          <button style={styles.primaryButton}>Save Settings</button>
        </form>
      </Card>

      <Card title="Reminder Templates" hint="Use placeholders to personalize WhatsApp and email reminders.">
        <div style={{ ...styles.alert, marginBottom: 12 }}>
          Placeholders: {placeholders.map(name => <code key={name} style={{ marginRight: 8 }}>{`{{${name}}}`}</code>)}
        </div>
        {loading ? <div style={styles.alert}>Loading templates...</div> : Object.entries(grouped).map(([eventType, items]) => (
          <div key={eventType} style={{ marginBottom: 16 }}>
            <h3>{pretty(eventType)}</h3>
            <Table
              columns={['Channel', 'Subject', 'Body', 'Actions']}
              rows={items.map(template => [
                <Badge key={`${template.id}-channel`} tone={template.channel === 'whatsapp' ? 'green' : 'blue'}>{template.channel}</Badge>,
                template.subject || '-',
                <span key={`${template.id}-body`}>{template.body.slice(0, 120)}{template.body.length > 120 ? '...' : ''}</span>,
                <div key={`${template.id}-actions`} style={styles.actionGroup}>
                  <button type="button" style={styles.tinyButton} onClick={() => setEditing({ ...template })}>Edit</button>
                  <button type="button" style={styles.tinyButton} onClick={() => restoreTemplate(template)}>Restore Defaults</button>
                </div>,
              ])}
              empty="No templates."
            />
          </div>
        ))}
      </Card>

      {editing && (
        <Card title={`Edit ${pretty(editing.eventType)} (${editing.channel})`} hint="Preview updates live with sample matter and client data.">
          <form onSubmit={saveTemplate} style={styles.pageStack}>
            {editing.channel === 'email' && <Field label="Subject"><input style={styles.input} value={editing.subject || ''} onChange={e => setEditing({ ...editing, subject: e.target.value })} /></Field>}
            <Field label="Body">
              <textarea style={{ ...styles.input, minHeight: 140, resize: 'vertical' }} value={editing.body || ''} onChange={e => setEditing({ ...editing, body: e.target.value })} />
            </Field>
            <div style={styles.dashboardGrid}>
              <Card title="Subject Preview">{editing.channel === 'email' ? render(editing.subject || '') : 'WhatsApp message'}</Card>
              <Card title="Body Preview"><pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>{render(editing.body || '')}</pre></Card>
            </div>
            <div style={styles.actionGroup}>
              <button style={styles.primaryButton}>Save Template</button>
              <button type="button" style={styles.ghostButton} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </Card>
      )}

      <Card title="Recent Reminder Logs" hint="Latest send attempts across WhatsApp and email.">
        {logs.length ? (
          <Table columns={['Sent At', 'Channel', 'Recipient', 'Status', 'Error']} rows={logs.map(log => [log.sentAt ? new Date(log.sentAt).toLocaleString() : '-', log.channel, log.recipient || '-', <Badge key={log.id} tone={log.status === 'sent' ? 'green' : 'red'}>{log.status}</Badge>, log.errorMessage || '-'])} empty="No reminder logs." />
        ) : <Empty title="No reminder logs yet" text="Scheduled reminders will create logs once channels are enabled." />}
      </Card>
    </div>
  );
}
