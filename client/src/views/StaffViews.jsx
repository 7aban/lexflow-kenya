import { useEffect, useMemo, useRef, useState } from 'react';
import { IconBriefcase, IconAlertTriangle, IconBuilding, IconAlertCircle, IconClockHour4, IconCash, IconX, IconClock, IconListCheck, IconCalendarEvent, IconUpload, IconNote, IconMail, IconPaperclip, IconExternalLink } from '@tabler/icons-react';
import { api, applyChecklistTemplate, approveHrLeaveRequest, cancelHrLeaveRequestAdmin, confirmWorkCalendarMatter, confirmWorkEmailMatter, createChecklistTemplate, cancelOffboardingCase, completeOffboardingCase, createHrContract, createHrLeaveBalanceAdjustment, createHrStaffProfile, createMatterChecklistItem, createOffboardingCase, deleteChecklistTemplate, deleteClientAvatar, deleteHrDocument, deleteUserAvatar, deleteMatterChecklistItem, disconnectConnectedAccount, downloadHrDocumentContent, downloadWithAuth, fetchAvatarObjectUrl, fetchClientAvatarObjectUrl, fileToDataUrl, getHrContracts, getHrDashboard, getHrDocuments, getHrLeaveBalances, getHrLeaveRequests, getHrStaff, getHrStaffProfile, getOffboardingAssignedMatters, getOffboardingCase, getOffboardingCases, getInvoiceDetails, getMatterTimeline, getMatterWorkMetadataLinks, getWorkEmailMessages, getWorkCalendarEvents, listChecklistTemplates, listConnectedAccounts, listInvoicePayments, listMatterChecklistItems, readSession, recordInvoicePayment, rejectHrLeaveRequest, setHrLeaveEntitlement, startConnectedAccountOAuth, syncConnectedAccountEmailMetadata, syncConnectedAccountCalendarMetadata, unlinkWorkCalendarMatter, unlinkWorkEmailMatter, updateChecklistTemplate, updateHrContract, updateHrDocument, updateHrStaffProfile, updateMatterChecklistItem, updateOffboardingCase, updateOffboardingChecklistItem, uploadClientAvatar, uploadHrDocument, uploadUserAvatar } from '../lib/apiClient.js';
import { defaultFirmSettings, styles, theme, applyFirmTheme, clearFirmTheme } from '../theme.jsx';
import { getFirmTheme, previewFirmTheme, updateFirmTheme, resetFirmTheme, getThemePresets, getUsers, reassignMatter } from '../api.js';
import { ActionGroup, Badge, Card, ConfirmModal, Empty, Field, kes, MeetingLink, nextCourtDate, ProfileTooltip, safeHttpUrl, Skeleton, statusTone, Sub, Table, isInvoiceOverdue, invoiceDisplayStatus, invoiceDueDistanceText, invoiceDueDistanceDays } from '../components/ui.jsx';
import MatterDocuments from '../components/MatterDocuments.jsx';
import TaskTimer, { taskTimerActive } from '../components/TaskTimer.jsx';

const BILLABLE_TIME_GUIDANCE = 'Billable time may be included in hourly invoices. Non-billable time is tracked for workload and productivity but excluded from hourly invoice generation.';
const AVATAR_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const AVATAR_MAX_BYTES = 512 * 1024;

function listFromResponse(response, key) {
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response[key])) return response[key];
  return [];
}

// PRODUCT-17B: frontend-only CSV export of already-loaded, already-filtered list rows.
// No API calls and no new data — callers pass exactly the rows the user already sees.
// Cells are CSV-escaped and guarded against spreadsheet formula injection.
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Formula-injection guard: if the cell (ignoring leading spaces) starts with a
  // character a spreadsheet would treat as a formula, prefix it with an apostrophe.
  if (/^[=+\-@\t\r]/.test(text.replace(/^ +/, ''))) text = `'${text}`;
  // Quote cells containing comma, quote, or line breaks; double any internal quotes.
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function downloadCsv(filename, columns, rows) {
  if (!rows.length) return;
  const csv = [columns, ...rows].map(cells => cells.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// PRODUCT-15I: staff payment-proof queue endpoint (optional status filter; 'All' omits it).
const paymentProofsPath = status => `/payment-proofs${status && status !== 'All' ? `?status=${encodeURIComponent(status)}` : ''}`;

const billingMobilePolishCss = `
  .ux2-mobile-stack { display: none; }
  @media (max-width: 767px) {
    .ux2-desktop-table { display: none !important; }
    .ux2-mobile-stack { display: grid; gap: 10px; }
    .ux2-mobile-card {
      border: 1px solid #E5E7EB;
      border-radius: 8px;
      background: #fff;
      padding: 10px;
      display: grid;
      gap: 9px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    }
    .ux2-mobile-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .ux2-mobile-title {
      color: #111827;
      font-size: 14px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .ux2-mobile-subtitle {
      color: #697386;
      font-size: 12px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .ux2-mobile-kv {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .ux2-mobile-field {
      min-width: 0;
      border: 1px solid #F3F4F6;
      border-radius: 6px;
      padding: 7px 8px;
      background: #F9FAFB;
    }
    .ux2-mobile-field-wide { grid-column: 1 / -1; }
    .ux2-mobile-label {
      display: block;
      color: #697386;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .ux2-mobile-value {
      color: #111827;
      font-size: 13px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .ux2-mobile-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .ux2-mobile-empty {
      border: 1px dashed #D1D5DB;
      border-radius: 8px;
      padding: 10px;
      color: #697386;
      font-size: 13px;
      background: #F9FAFB;
    }
    .ux2-mobile-card select,
    .ux2-mobile-card input,
    .ux2-mobile-card textarea {
      max-width: 100%;
    }
  }
`;

function MobileField({ label, children, wide = false }) {
  return (
    <div className={`ux2-mobile-field${wide ? ' ux2-mobile-field-wide' : ''}`}>
      <span className="ux2-mobile-label">{label}</span>
      <div className="ux2-mobile-value">{children}</div>
    </div>
  );
}

function MobileEmpty({ children }) {
  return <div className="ux2-mobile-empty">{children}</div>;
}

function connectedProviderLabel(provider) {
  if (provider === 'google') return 'Google';
  if (provider === 'microsoft') return 'Microsoft';
  return provider || 'Provider';
}

function connectedAccountDate(value) {
  const parsed = parseDateValue(value);
  return parsed ? parsed.toLocaleDateString() : '-';
}

function connectedAccountDateTime(value) {
  const parsed = parseDateValue(value);
  return parsed ? parsed.toLocaleString() : '-';
}

export function ConnectedAccounts({ notify }) {
  const [accounts, setAccounts] = useState([]);
  const [messages, setMessages] = useState([]);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [matters, setMatters] = useState([]);
  const [emailMatterSelections, setEmailMatterSelections] = useState({});
  const [calendarMatterSelections, setCalendarMatterSelections] = useState({});
  const [loading, setLoading] = useState(false);
  const [busyProvider, setBusyProvider] = useState('');
  const [busyId, setBusyId] = useState('');
  const [syncingId, setSyncingId] = useState('');
  const [calendarSyncingId, setCalendarSyncingId] = useState('');
  const [metadataBusyId, setMetadataBusyId] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [accountResponse, messageResponse, calendarResponse, matterResponse] = await Promise.all([
        listConnectedAccounts(),
        getWorkEmailMessages({ limit: 20 }),
        getWorkCalendarEvents({ limit: 20 }),
        api('/matters'),
      ]);
      setAccounts(listFromResponse(accountResponse, 'accounts'));
      setMessages(listFromResponse(messageResponse, 'messages'));
      setCalendarEvents(listFromResponse(calendarResponse, 'events'));
      setMatters(listFromResponse(matterResponse, 'matters'));
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function connect(provider) {
    setBusyProvider(provider);
    try {
      const data = await startConnectedAccountOAuth(provider);
      if (!data?.authorizationUrl) throw new Error('Provider authorization URL was not returned.');
      window.location.href = data.authorizationUrl;
    } catch (err) {
      notify({ type: 'danger', message: err.message });
      setBusyProvider('');
    }
  }

  async function disconnect(account) {
    if (!window.confirm(`Disconnect ${connectedProviderLabel(account.provider)} for ${account.email || 'this account'}?`)) return;
    setBusyId(account.id);
    try {
      await disconnectConnectedAccount(account.id);
      notify({ type: 'success', message: 'Connected account disconnected.' });
      await load();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setBusyId('');
    }
  }

  async function syncEmail(account) {
    setSyncingId(account.id);
    try {
      const result = await syncConnectedAccountEmailMetadata(account.id);
      notify({ type: 'success', message: `Email metadata synced. ${Number(result.importedCount || 0)} imported, ${Number(result.updatedCount || 0)} updated.` });
      await load();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setSyncingId('');
    }
  }

  async function syncCalendar(account) {
    setCalendarSyncingId(account.id);
    try {
      const result = await syncConnectedAccountCalendarMetadata(account.id);
      notify({ type: 'success', message: `Calendar metadata synced. ${Number(result.importedCount || 0)} imported, ${Number(result.updatedCount || 0)} updated.` });
      await load();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setCalendarSyncingId('');
    }
  }

  function matterOptionLabel(matter) {
    return `${matter.reference || matter.id} - ${matter.title || 'Untitled matter'}${matter.clientName ? ` (${matter.clientName})` : ''}`;
  }

  function selectedMatterValue(item, selections) {
    return selections[item.id] ?? item.confirmedMatterId ?? item.matchedMatterId ?? '';
  }

  async function confirmEmailMatter(message) {
    const matterId = selectedMatterValue(message, emailMatterSelections);
    if (!matterId) return notify({ type: 'warning', message: 'Select a matter before confirming.' });
    setMetadataBusyId(`email:${message.id}`);
    try {
      await confirmWorkEmailMatter(message.id, matterId);
      notify({ type: 'success', message: 'Email metadata matter link confirmed.' });
      await load();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setMetadataBusyId('');
    }
  }

  async function unlinkEmailMatter(message) {
    setMetadataBusyId(`email:${message.id}`);
    try {
      await unlinkWorkEmailMatter(message.id);
      setEmailMatterSelections(current => ({ ...current, [message.id]: message.matchedMatterId || '' }));
      notify({ type: 'success', message: 'Email metadata matter link removed.' });
      await load();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setMetadataBusyId('');
    }
  }

  async function confirmCalendarMatter(event) {
    const matterId = selectedMatterValue(event, calendarMatterSelections);
    if (!matterId) return notify({ type: 'warning', message: 'Select a matter before confirming.' });
    setMetadataBusyId(`calendar:${event.id}`);
    try {
      await confirmWorkCalendarMatter(event.id, matterId);
      notify({ type: 'success', message: 'Calendar metadata matter link confirmed.' });
      await load();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setMetadataBusyId('');
    }
  }

  async function unlinkCalendarMatter(event) {
    setMetadataBusyId(`calendar:${event.id}`);
    try {
      await unlinkWorkCalendarMatter(event.id);
      setCalendarMatterSelections(current => ({ ...current, [event.id]: event.matchedMatterId || '' }));
      notify({ type: 'success', message: 'Calendar metadata matter link removed.' });
      await load();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setMetadataBusyId('');
    }
  }

  function renderMatterConfirmation(item, type) {
    const isEmail = type === 'email';
    const selections = isEmail ? emailMatterSelections : calendarMatterSelections;
    const setSelections = isEmail ? setEmailMatterSelections : setCalendarMatterSelections;
    const busyKey = `${type}:${item.id}`;
    const busy = metadataBusyId === busyKey;
    const selectedValue = selectedMatterValue(item, selections);
    return (
      <div style={{ display: 'grid', gap: 8, minWidth: 220 }}>
        <div style={{ display: 'grid', gap: 2 }}>
          <span style={{ fontSize: 12, color: theme.muted, fontWeight: 700 }}>Suggested</span>
          {item.matchedMatterId ? (
            <>
              <strong>{item.matchedMatterTitle || item.matchedMatterId}</strong>
              <small style={styles.mutedText}>{item.matchReason || 'Suggested match'}</small>
            </>
          ) : <span style={styles.mutedText}>No suggestion</span>}
        </div>
        <div style={{ display: 'grid', gap: 2 }}>
          <span style={{ fontSize: 12, color: theme.muted, fontWeight: 700 }}>Confirmed</span>
          {item.confirmedMatterId ? (
            <>
              <strong>{item.confirmedMatterTitle || item.confirmedMatterId}</strong>
              <small style={styles.mutedText}>{item.confirmationSource === 'manual_override' ? 'Manual override' : 'Confirmed suggestion'}{item.confirmedAt ? ` / ${connectedAccountDateTime(item.confirmedAt)}` : ''}</small>
            </>
          ) : <span style={styles.mutedText}>Not confirmed</span>}
        </div>
        <select
          aria-label={`Select matter for ${isEmail ? 'email message' : 'calendar event'} confirmation`}
          style={styles.input}
          value={selectedValue}
          onChange={event => setSelections(current => ({ ...current, [item.id]: event.target.value }))}
        >
          <option value="">Select matter</option>
          {matters.map(matter => <option key={matter.id} value={matter.id}>{matterOptionLabel(matter)}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            style={styles.tinyButton}
            disabled={busy || !selectedValue}
            onClick={() => isEmail ? confirmEmailMatter(item) : confirmCalendarMatter(item)}
          >
            {busy ? 'Saving...' : item.confirmedMatterId ? 'Change matter' : 'Confirm matter'}
          </button>
          {item.confirmedMatterId && (
            <button
              type="button"
              style={styles.dangerTinyButton}
              disabled={busy}
              onClick={() => isEmail ? unlinkEmailMatter(item) : unlinkCalendarMatter(item)}
            >
              Unlink
            </button>
          )}
        </div>
      </div>
    );
  }

  const rows = accounts.map(account => [
    connectedProviderLabel(account.provider),
    account.email || <span style={styles.mutedText}>No email</span>,
    account.status === 'connected' ? <Badge tone="green">Connected</Badge> : <Badge tone="amber">Disconnected</Badge>,
    <div style={{ display: 'grid', gap: 2 }}>
      <span>{account.lastSyncAt ? connectedAccountDateTime(account.lastSyncAt) : '-'}</span>
      {account.lastError ? <small style={{ color: theme.red }}>{account.lastError}</small> : null}
    </div>,
    account.status === 'connected' ? (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" style={styles.ghostButton} disabled={syncingId === account.id} onClick={() => syncEmail(account)}>
          {syncingId === account.id ? 'Syncing...' : 'Sync email metadata'}
        </button>
        <button type="button" style={styles.ghostButton} disabled={calendarSyncingId === account.id} onClick={() => syncCalendar(account)}>
          {calendarSyncingId === account.id ? 'Syncing...' : 'Sync calendar metadata'}
        </button>
        <button type="button" style={styles.dangerButton} disabled={busyId === account.id} onClick={() => disconnect(account)}>{busyId === account.id ? 'Disconnecting...' : 'Disconnect'}</button>
      </div>
    ) : <span style={styles.mutedText}>Disconnected</span>,
  ]);

  const messageRows = messages.map(message => [
    <div style={{ display: 'grid', gap: 2 }}>
      <strong>{connectedProviderLabel(message.accountProvider || message.provider)}</strong>
      <small style={styles.mutedText}>{message.accountEmail || '-'}</small>
    </div>,
    message.sender || <span style={styles.mutedText}>Unknown sender</span>,
    <div style={{ display: 'grid', gap: 2 }}>
      <strong>{message.subject || '(No subject)'}</strong>
      {message.snippet ? <small style={styles.mutedText}>{message.snippet}</small> : null}
    </div>,
    connectedAccountDateTime(message.receivedAt),
    message.hasAttachments ? 'Yes' : 'No',
    renderMatterConfirmation(message, 'email'),
  ]);

  const calendarEventRows = calendarEvents.map(event => [
    <div style={{ display: 'grid', gap: 2 }}>
      <strong>{connectedProviderLabel(event.accountProvider || event.provider)}</strong>
      <small style={styles.mutedText}>{event.accountEmail || '-'}</small>
    </div>,
    event.subject || <span style={styles.mutedText}>(No subject)</span>,
    <div style={{ display: 'grid', gap: 2 }}>
      <span>{event.startTime ? new Date(event.startTime).toLocaleString() : '-'}</span>
      {event.meetingLink ? <small><a href={event.meetingLink} target="_blank" rel="noopener noreferrer" style={{ color: theme.link }}>Meeting link</a></small> : null}
    </div>,
    renderMatterConfirmation(event, 'calendar'),
  ]);

  return (
    <div style={styles.pageStack}>
      <Card title="Connected Accounts" hint="Authorize external provider access for future integrations">
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ ...styles.alert, padding: 10, borderRadius: 6 }}>
            Demo metadata only; no provider tokens are stored for demo accounts. Email bodies and attachments are not imported.
          </div>
          <div style={{ ...styles.alert, padding: 10, borderRadius: 6 }}>
            Metadata only. Email bodies and attachments are not imported. Calendar events are not created, edited, or deleted.
          </div>
          <div style={{ ...styles.alert, padding: 10, borderRadius: 6 }}>
            Confirming a match links metadata to a matter. It does not import email bodies, attachments, or create calendar/court events.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" style={styles.primaryButton} onClick={() => connect('google')} disabled={Boolean(busyProvider)}>
              {busyProvider === 'google' ? 'Opening Google...' : 'Connect Google'}
            </button>
            <button type="button" style={styles.ghostButton} onClick={() => connect('microsoft')} disabled={Boolean(busyProvider)}>
              {busyProvider === 'microsoft' ? 'Opening Microsoft...' : 'Connect Microsoft'}
            </button>
          </div>
        </div>
      </Card>
      <Card title="Authorized Providers" hint={`${accounts.length} connected account${accounts.length === 1 ? '' : 's'}`}>
        {loading
          ? <div style={styles.mutedText}>Loading connected accounts...</div>
          : accounts.length
            ? <Table columns={['Provider', 'Email', 'Status', 'Last sync', 'Actions']} rows={rows} />
            : <Empty title="No connected accounts." text="Connect Google or Microsoft when provider authorization is ready." />}
      </Card>
      <Card title="Work Email Metadata" hint={`${messages.length} recent metadata message${messages.length === 1 ? '' : 's'}`}>
        {loading
          ? <div style={styles.mutedText}>Loading email metadata...</div>
          : messages.length
            ? <Table columns={['Account', 'Sender', 'Subject', 'Received', 'Attachments', 'Matter confirmation']} rows={messageRows} />
            : <Empty title="No email metadata synced." text="Use Sync email metadata now on a connected account." />}
      </Card>
      <Card title="Calendar Metadata" hint={`${calendarEvents.length} recent event${calendarEvents.length === 1 ? '' : 's'}`}>
        {loading
          ? <div style={styles.mutedText}>Loading calendar metadata...</div>
          : calendarEvents.length
            ? <Table columns={['Account', 'Subject', 'Time', 'Matter confirmation']} rows={calendarEventRows} />
            : <Empty title="No calendar metadata synced." text="Use Sync calendar metadata now on a connected account." />}
      </Card>
    </div>
  );
}

function isBillableValue(value) {
  if (value === undefined || value === null) return true;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function BillableBadge({ value }) {
  const billable = isBillableValue(value);
  return <span style={{ ...styles.badge, background: billable ? theme.blueBg : '#F3F4F6', color: billable ? theme.blue : theme.muted }}>{billable ? 'Billable' : 'Non-billable'}</span>;
}

function blankChecklistTemplateItem(position = 0) {
  return { title: '', notes: '', position };
}

function emptyChecklistTemplateForm() {
  return { name: '', description: '', practiceArea: '', items: [blankChecklistTemplateItem(0)] };
}

function formatFileSize(bytes = 0) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function noticeFileName(file) {
  return file?.friendlyName || file?.displayName || file?.name || 'Attachment';
}

function parseDateValue(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const dayOnly = new Date(`${value}T00:00:00`);
  return Number.isNaN(dayOnly.getTime()) ? null : dayOnly;
}

function isoDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(days) {
  return new Date(Date.now() + Number(days || 0) * 86400000).toISOString().slice(0, 10);
}

function formatTimelineDate(value) {
  const parsed = parseDateValue(value);
  if (!parsed) return 'Date not recorded';
  return parsed.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
}

function daysFromToday(value) {
  const parsed = parseDateValue(value);
  const today = parseDateValue(isoDateOnly());
  if (!parsed || !today) return null;
  const targetDay = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const currentDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((targetDay.getTime() - currentDay.getTime()) / 86400000);
}

function formatDayDistance(days) {
  if (days === null || days === undefined) return null;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 0) return `in ${days} days`;
  const overdueDays = Math.abs(days);
  return `${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue`;
}

function invoiceDueDaysSetting(settings) {
  const days = Number(settings?.defaultInvoiceDueDays);
  return [7, 14, 30, 45].includes(days) ? days : 30;
}

function buildMatterNextActionHints(detail) {
  if (!detail) return [];

  const tasks = Array.isArray(detail.tasks) ? detail.tasks : [];
  const appearances = Array.isArray(detail.appearances) ? detail.appearances : [];
  const documents = Array.isArray(detail.documents) ? detail.documents : [];
  const notes = Array.isArray(detail.notes) ? detail.notes : [];
  const timeEntries = Array.isArray(detail.timeEntries) ? detail.timeEntries : [];
  const invoices = Array.isArray(detail.invoices) ? detail.invoices : [];
  const checklistItems = Array.isArray(detail.checklistItems) ? detail.checklistItems : [];
  const hints = [];
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const categoryRank = { urgent: 0, upcoming: 1, risk: 2, 'missing-information': 3, billing: 4, workflow: 5, informational: 6 };

  const addHint = (hint) => {
    const evidence = (Array.isArray(hint.evidence) ? hint.evidence : [])
      .filter(Boolean)
      .map(String)
      .slice(0, 3);
    hints.push({
      title: hint.title,
      category: hint.category,
      severity: hint.severity,
      why: hint.why,
      evidence: evidence.length ? evidence : ['Available matter data'],
      rank: hint.rank ?? 50,
    });
  };

  const openTasks = tasks.filter(task => !task.completed);
  const overdueTasks = openTasks
    .map(task => ({ ...task, daysAway: daysFromToday(task.dueDate) }))
    .filter(task => Number.isFinite(task.daysAway) && task.daysAway < 0)
    .sort((a, b) => a.daysAway - b.daysAway);

  if (overdueTasks.length) {
    const oldest = overdueTasks[0];
    const oldestAge = Math.abs(oldest.daysAway);
    addHint({
      title: `${overdueTasks.length} overdue open task${overdueTasks.length === 1 ? '' : 's'}`,
      category: 'urgent',
      severity: overdueTasks.length >= 3 || oldestAge >= 7 ? 'critical' : 'high',
      why: 'Open tasks are past their due dates and need staff follow-up.',
      evidence: [
        oldest.title || oldest.description || 'Open task',
        `Due ${formatTimelineDate(oldest.dueDate)}`,
        formatDayDistance(oldest.daysAway),
      ],
      rank: 1,
    });
  }

  const upcomingAppearances = appearances
    .map(appearance => ({ ...appearance, daysAway: daysFromToday(appearance.date) }))
    .filter(appearance => Number.isFinite(appearance.daysAway) && appearance.daysAway >= 0)
    .sort((a, b) => a.daysAway - b.daysAway);

  const nextAppearance = upcomingAppearances[0];
  if (nextAppearance && nextAppearance.daysAway <= 7) {
    addHint({
      title: nextAppearance.daysAway === 0 ? 'Court appearance today' : `Court appearance ${formatDayDistance(nextAppearance.daysAway)}`,
      category: 'upcoming',
      severity: 'high',
      why: 'A court date is approaching; confirm attendance, materials, and responsible staff.',
      evidence: [
        formatTimelineDate(nextAppearance.date),
        nextAppearance.court || nextAppearance.location || 'Court appearance',
        nextAppearance.type || nextAppearance.purpose || null,
      ],
      rank: 3,
    });
  }

  if (nextAppearance && !nextAppearance.prepNote) {
    addHint({
      title: 'Court preparation note not recorded',
      category: 'missing-information',
      severity: 'medium',
      why: 'The next court appearance has no prep note in the current matter detail.',
      evidence: [
        formatTimelineDate(nextAppearance.date),
        nextAppearance.court || nextAppearance.location || 'Court appearance',
        'No prep note',
      ],
      rank: 8,
    });
  }

  const solDays = daysFromToday(detail.solDate);
  if (Number.isFinite(solDays)) {
    if (solDays < 0) {
      addHint({
        title: 'Recorded limitation date has passed',
        category: 'risk',
        severity: 'high',
        why: 'Confirm limitation date and underlying facts.',
        evidence: [
          `SOL ${formatTimelineDate(detail.solDate)}`,
          formatDayDistance(solDays),
          detail.stage ? `Stage: ${detail.stage}` : null,
        ],
        rank: 2,
      });
    } else if (solDays <= 30) {
      addHint({
        title: 'Limitation date within 30 days',
        category: 'risk',
        severity: 'high',
        why: 'Confirm limitation date and underlying facts.',
        evidence: [
          `SOL ${formatTimelineDate(detail.solDate)}`,
          formatDayDistance(solDays),
          detail.stage ? `Stage: ${detail.stage}` : null,
        ],
        rank: 4,
      });
    } else {
      addHint({
        title: 'Limitation date recorded',
        category: 'risk',
        severity: 'low',
        why: 'Confirm limitation date and underlying facts remain current.',
        evidence: [
          `SOL ${formatTimelineDate(detail.solDate)}`,
          formatDayDistance(solDays),
          detail.stage ? `Stage: ${detail.stage}` : null,
        ],
        rank: 18,
      });
    }
  }

  if (!documents.length) {
    addHint({
      title: 'No documents recorded',
      category: 'missing-information',
      severity: 'medium',
      why: 'The current matter detail has no document records to support the file.',
      evidence: [
        '0 documents',
        detail.stage ? `Stage: ${detail.stage}` : null,
        detail.assignedTo ? `Assigned: ${detail.assignedTo}` : null,
      ],
      rank: 9,
    });
  }

  if (!notes.length) {
    addHint({
      title: 'No matter notes recorded',
      category: 'workflow',
      severity: 'low',
      why: 'No staff notes are available in the current matter detail.',
      evidence: [
        '0 notes',
        detail.assignedTo ? `Assigned: ${detail.assignedTo}` : null,
        detail.paralegal ? `Paralegal: ${detail.paralegal}` : null,
      ],
      rank: 20,
    });
  }

  const overdueInvoices = invoices
    .map(invoice => ({ ...invoice, daysAway: daysFromToday(invoice.dueDate), statusText: String(invoice.status || '').toLowerCase() }))
    .filter(invoice => invoice.statusText.includes('overdue') || (Number.isFinite(invoice.daysAway) && invoice.daysAway < 0 && !invoice.statusText.includes('paid')))
    .sort((a, b) => (a.daysAway ?? 0) - (b.daysAway ?? 0));

  if (overdueInvoices.length) {
    const oldestInvoice = overdueInvoices[0];
    addHint({
      title: `${overdueInvoices.length} overdue invoice${overdueInvoices.length === 1 ? '' : 's'}`,
      category: 'billing',
      severity: 'medium',
      why: 'An invoice is overdue or marked outstanding in the current matter detail; review status without relying on hidden amounts.',
      evidence: [
        oldestInvoice.invoiceNumber || oldestInvoice.id || 'Invoice',
        oldestInvoice.dueDate ? `Due ${formatTimelineDate(oldestInvoice.dueDate)}` : 'Due date not recorded',
        oldestInvoice.status || 'Status not recorded',
      ],
      rank: 10,
    });
  }

  const unbilledTime = timeEntries.filter(entry => !entry.billed && isBillableValue(entry.billable));
  if (unbilledTime.length) {
    const visibleHours = unbilledTime.reduce((sum, entry) => sum + (Number(entry.hours) || 0), 0);
    const latestEntry = [...unbilledTime]
      .sort((a, b) => (parseDateValue(b.date)?.getTime() || 0) - (parseDateValue(a.date)?.getTime() || 0))[0];
    addHint({
      title: `${unbilledTime.length} unbilled time entr${unbilledTime.length === 1 ? 'y' : 'ies'}`,
      category: 'billing',
      severity: visibleHours >= 5 || unbilledTime.length >= 3 ? 'medium' : 'low',
      why: 'Unbilled time is visible in this matter; review billing status without exposing rates or amounts.',
      evidence: [
        `${visibleHours.toFixed(1)}h logged`,
        latestEntry?.date ? `Latest ${formatTimelineDate(latestEntry.date)}` : null,
        `${unbilledTime.length} entries`,
      ],
      rank: 14,
    });
  }

  if (checklistItems.length) {
    const isItemComplete = (item) => Number(item?.completed || 0) === 1;
    const openChecklistItems = checklistItems
      .filter(item => !isItemComplete(item))
      .map((item, index) => ({ ...item, _fallbackOrder: index }))
      .sort((a, b) => {
        const posDelta = Number(a.position ?? 0) - Number(b.position ?? 0);
        if (posDelta) return posDelta;
        const createdDelta = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
        if (createdDelta) return createdDelta;
        return a._fallbackOrder - b._fallbackOrder;
      });
    const completedCount = checklistItems.length - openChecklistItems.length;

    if (openChecklistItems.length) {
      const firstOpen = openChecklistItems[0];
      addHint({
        title: `${openChecklistItems.length} open checklist item${openChecklistItems.length === 1 ? '' : 's'}`,
        category: 'workflow',
        severity: 'medium',
        why: 'Open checklist items remain on this matter; review them in the Checklist section.',
        evidence: [
          firstOpen.title || 'Open checklist item',
          `${openChecklistItems.length} open of ${checklistItems.length}`,
          completedCount ? `${completedCount} complete` : null,
        ],
        rank: 16,
      });
    } else {
      addHint({
        title: 'Checklist complete',
        category: 'informational',
        severity: 'low',
        why: 'All checklist items on this matter are marked complete in the current matter detail.',
        evidence: [
          `${checklistItems.length} of ${checklistItems.length} complete`,
          detail.stage ? `Stage: ${detail.stage}` : null,
          detail.assignedTo ? `Assigned: ${detail.assignedTo}` : null,
        ],
        rank: 25,
      });
    }
  }

  if (!hints.length) {
    addHint({
      title: 'Matter appears current from available signals',
      category: 'informational',
      severity: 'low',
      why: 'No overdue open tasks, near court dates, limitation-date risk, missing file basics, overdue invoices, or visible unbilled time were found.',
      evidence: [
        detail.stage ? `Stage: ${detail.stage}` : 'Stage not recorded',
        detail.priority ? `Priority: ${detail.priority}` : null,
        detail.assignedTo ? `Assigned: ${detail.assignedTo}` : null,
      ],
      rank: 30,
    });
  }

  return hints
    .sort((a, b) => {
      const severityDelta = (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
      if (severityDelta) return severityDelta;
      const rankDelta = a.rank - b.rank;
      if (rankDelta) return rankDelta;
      return (categoryRank[a.category] ?? 9) - (categoryRank[b.category] ?? 9);
    })
    .map(({ rank, ...hint }) => hint);
}

function scrollToSection(sectionId) {
  const el = document.getElementById(sectionId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const prev = el.style.background;
    el.style.background = 'rgba(212, 163, 74, 0.15)';
    setTimeout(() => { el.style.background = prev; }, 1200);
  }
}

function computeNextStep(detail) {
  if (!detail) return null;
  const today = isoDateOnly();
  const tasks = Array.isArray(detail.tasks) ? detail.tasks : [];
  const appearances = Array.isArray(detail.appearances) ? detail.appearances : [];
  const documents = Array.isArray(detail.documents) ? detail.documents : [];
  const timeEntries = Array.isArray(detail.timeEntries) ? detail.timeEntries : [];
  const checklistItems = Array.isArray(detail.checklistItems) ? detail.checklistItems : [];

  const overdueTasks = tasks.filter(t => !t.completed && t.dueDate && t.dueDate < today);
  if (overdueTasks.length) {
    return { title: 'Clear overdue work', reason: `${overdueTasks.length} overdue task${overdueTasks.length === 1 ? '' : 's'} need attention`, sectionId: 'matter-section-tasks', actionLabel: 'View tasks' };
  }

  const overdueChecklist = checklistItems.filter(item => Number(item.completed || 0) !== 1 && item.dueDate && item.dueDate < today);
  if (overdueChecklist.length) {
    return { title: 'Complete overdue checklist items', reason: `${overdueChecklist.length} overdue checklist item${overdueChecklist.length === 1 ? '' : 's'}`, sectionId: 'matter-section-tasks', actionLabel: 'View checklist' };
  }

  const upcomingAppearances = appearances.filter(a => a.date && a.date >= today).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (upcomingAppearances.length) {
    const next = upcomingAppearances[0];
    return { title: 'Prepare for court', reason: `${next.type || 'Appearance'} on ${next.date}${next.location ? ` at ${next.location}` : ''}`, sectionId: 'matter-section-court', actionLabel: 'View court date' };
  }

  if (!documents.length) {
    return { title: 'Upload documents', reason: 'No documents recorded for this matter', sectionId: 'matter-section-documents', actionLabel: 'Upload document' };
  }

  const unbilledTime = timeEntries.filter(e => !e.billed);
  if (unbilledTime.length) {
    const totalHours = unbilledTime.reduce((s, e) => s + Number(e.hours || 0), 0);
    return { title: 'Review unbilled time', reason: `${unbilledTime.length} unbilled entr${unbilledTime.length === 1 ? 'y' : 'ies'} (${totalHours.toFixed(1)}h)`, sectionId: 'matter-section-time', actionLabel: 'Review time' };
  }

  return { title: 'Review matter workspace', reason: 'Matter appears current — review open items and upcoming work', sectionId: 'matter-section-tasks', actionLabel: 'Browse workspace' };
}

function DashboardStatCard({ accent, iconBg, iconColor, icon: Icon, label, value, note, valueSm = false, onClick, ariaLabel }) {
  const content = (
    <>
      <span className="lf-dash-stat-top" style={{ ...styles.dashStatTopBar, background: accent }} aria-hidden="true" />
      <div style={styles.dashStatHead}>
        <span style={styles.dashStatLabel}>{label}</span>
        <span style={{ ...styles.dashStatIcon, background: iconBg, color: iconColor }} aria-hidden="true">
          {Icon ? <Icon size={16} stroke={1.75} /> : null}
        </span>
      </div>
      <div className="lf-dash-stat-value" style={{ ...styles.dashStatValue, ...(valueSm ? styles.dashStatValueSm : null) }}>{value}</div>
      {note ? <div style={styles.dashStatNote}>{note}</div> : null}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="lf-dash-stat-card" onClick={onClick} aria-label={ariaLabel || label} style={{ ...styles.dashStatCard, cursor: 'pointer' }}>
        {content}
      </button>
    );
  }
  return <div className="lf-dash-stat-card" style={styles.dashStatCard}>{content}</div>;
}

function DashboardPanel({ title, subtitle, linkLabel, onLink, children, fullWidth = false }) {
  return (
    <section className={`lf-dash-panel${fullWidth ? ' lf-dash-panel-fw' : ''}`}>
      <div className="lf-dash-panel-head">
        <div style={{ minWidth: 0 }}>
          <h2 style={styles.dashPanelHeadTitle}>{title}</h2>
          {subtitle ? <p style={styles.dashPanelHeadSub}>{subtitle}</p> : null}
        </div>
        {linkLabel && onLink ? (
          <button type="button" className="lf-dash-panel-link" onClick={onLink}>{linkLabel} →</button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function Dashboard({ data, user, onNavigate }) {
  const isAdvocate = user?.role === 'advocate';
  const isAdmin = user?.role === 'admin';
  const outstanding = data.invoices.filter(i => i.status === 'Outstanding').reduce((sum, i) => sum + Number(i.amount || 0), 0);
  const paid = data.invoices.filter(i => i.status === 'Paid').reduce((sum, i) => sum + Number(i.amount || 0), 0);
  const overdueTasks = data.tasks.filter(t => !t.completed && t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10)).length;
  const stages = data.matters.reduce((acc, matter) => ({ ...acc, [matter.stage || 'Intake']: (acc[matter.stage || 'Intake'] || 0) + 1 }), {});
  const maxStage = Math.max(1, ...Object.values(stages));
  const upcomingEvents = data.dashboard.upcomingEvents || [];
  const todayIsoStr = new Date().toISOString().slice(0, 10);

  const overdueCount = isAdvocate ? (data.dashboard.overdueTaskCount || 0) : overdueTasks;
  const activeMattersValue = data.dashboard.activeMattersCount ?? data.matters.length;
  const inProgressTasks = data.tasks.filter(t => !t.completed).length;
  const totalBilled = paid + outstanding;

  // PRODUCT-18B: read-only Practice assistant. Derives workflow prompts entirely from data already
  // loaded into the Dashboard (matters/tasks/invoices/upcomingEvents) — no fetch, no mutation. Money
  // figures use server-provided invoice balance only and exclude billing-masked (balance === null)
  // rows. Wording is workflow-oriented (Review/Confirm/Follow up), never legal advice. Actions are
  // navigation-only via onNavigate.
  const practiceAssistant = useMemo(() => {
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const invoices = Array.isArray(data.invoices) ? data.invoices : [];
    const events = Array.isArray(data.dashboard?.upcomingEvents) ? data.dashboard.upcomingEvents : [];
    const items = [];
    const sevRank = { high: 0, medium: 1, low: 2 };
    const openTasks = tasks.filter(t => !t.completed).map(t => ({ ...t, daysAway: daysFromToday(t.dueDate) }));

    // A. Overdue open tasks.
    const overdueTasks = openTasks
      .filter(t => Number.isFinite(t.daysAway) && t.daysAway < 0)
      .sort((a, b) => a.daysAway - b.daysAway);
    if (overdueTasks.length) {
      const oldest = overdueTasks[0];
      items.push({
        key: 'overdue-tasks', severity: 'high', rank: 1,
        label: `Review ${overdueTasks.length} overdue task${overdueTasks.length === 1 ? '' : 's'}`,
        detail: [oldest.title || oldest.description || 'Open task', formatDayDistance(oldest.daysAway)].filter(Boolean).join(' · '),
        nav: 'Tasks', btn: 'View tasks',
      });
    }

    // B. Open tasks due within 3 days (not overdue).
    const dueSoonTasks = openTasks
      .filter(t => Number.isFinite(t.daysAway) && t.daysAway >= 0 && t.daysAway <= 3)
      .sort((a, b) => a.daysAway - b.daysAway);
    if (dueSoonTasks.length) {
      const nearest = dueSoonTasks[0];
      items.push({
        key: 'due-soon-tasks', severity: 'medium', rank: 5,
        label: `Confirm ${dueSoonTasks.length} task${dueSoonTasks.length === 1 ? '' : 's'} due within 3 days`,
        detail: [nearest.title || nearest.description || 'Open task', formatDayDistance(nearest.daysAway)].filter(Boolean).join(' · '),
        nav: 'Tasks', btn: 'View tasks',
      });
    }

    // C. Court appearances within 7 days (upcomingEvents is already the next appearances, date>=today).
    const soonEvents = events
      .map(e => ({ ...e, daysAway: daysFromToday(e.date) }))
      .filter(e => Number.isFinite(e.daysAway) && e.daysAway >= 0 && e.daysAway <= 7)
      .sort((a, b) => a.daysAway - b.daysAway);
    if (soonEvents.length) {
      const nearest = soonEvents[0];
      const urgent = nearest.daysAway <= 2;
      items.push({
        key: 'court-soon', severity: urgent ? 'high' : 'medium', rank: urgent ? 2 : 6,
        label: `Review ${soonEvents.length} court appearance${soonEvents.length === 1 ? '' : 's'} within 7 days`,
        detail: [nearest.title || nearest.type || 'Court appearance', formatDayDistance(nearest.daysAway), nearest.matterTitle || nearest.reference || null].filter(Boolean).join(' · '),
        nav: 'Deadlines', btn: 'Court diary',
      });
    }

    // D. Overdue invoices (derived overdue). Exclude billing-masked balances from money figures.
    const overdueInvoices = invoices.filter(i => i.status !== 'Paid' && (i.status === 'Overdue' || isInvoiceOverdue(i)));
    if (overdueInvoices.length) {
      const maskedCount = overdueInvoices.filter(i => i.balance == null).length;
      const visibleBalance = overdueInvoices.reduce((sum, i) => i.balance == null ? sum : sum + Number(i.balance || 0), 0);
      const moneyText = overdueInvoices.length - maskedCount > 0 ? `${kes(visibleBalance)} outstanding` : null;
      const maskedText = maskedCount > 0 ? `${maskedCount} hidden by billing visibility` : null;
      items.push({
        key: 'overdue-invoices', severity: 'medium', rank: 7,
        label: `Follow up ${overdueInvoices.length} overdue invoice${overdueInvoices.length === 1 ? '' : 's'}`,
        detail: [moneyText, maskedText].filter(Boolean).join(' · ') || 'Review status in the invoice register',
        nav: 'Invoices', btn: 'View invoices',
      });
    }

    items.sort((a, b) => (sevRank[a.severity] - sevRank[b.severity]) || (a.rank - b.rank));
    return items.slice(0, 6);
  }, [data.matters, data.tasks, data.invoices, data.dashboard]);

  const [alertDismissed, setAlertDismissed] = useState(false);
  const showAlert = overdueCount > 0 && !alertDismissed;

  const bannerLabelDate = new Date().toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
  const bannerLabel = `${isAdvocate ? 'Your position' : 'Firm position'} — ${bannerLabelDate}`;

  return (
    <div className="lf-dashboard" style={styles.pageStack}>
      <section className="lf-dash-banner" style={styles.dashBanner}>
        <div className="lf-dash-banner-icon" style={styles.dashBannerIcon}>
          <IconBuilding size={20} stroke={1.75} aria-hidden="true" />
        </div>
        <div style={styles.dashBannerText}>
          <div style={styles.dashBannerLabel}>{bannerLabel}</div>
          <div style={styles.dashBannerSum}>
            <span style={styles.dashBannerSumStrong}>{activeMattersValue} matter{activeMattersValue === 1 ? '' : 's'}</span> active
            <span aria-hidden="true"> · </span>
            <span style={styles.dashBannerSumStrong}>{inProgressTasks} task{inProgressTasks === 1 ? '' : 's'}</span> in progress
            <span aria-hidden="true"> · </span>
            <span style={styles.dashBannerSumStrong}>{overdueCount} overdue</span> requiring attention
          </div>
        </div>
        <div className="lf-dash-banner-amount" style={styles.dashBannerAmount}>{kes(totalBilled)}</div>
      </section>

      {showAlert && (
        <div className="lf-dash-alert" style={styles.dashAlert} role="status">
          <span style={styles.dashAlertIcon} aria-hidden="true"><IconAlertTriangle size={16} stroke={1.75} /></span>
          <div style={styles.dashAlertText}>
            <strong>{overdueCount} overdue task{overdueCount === 1 ? '' : 's'}</strong> — review {isAdvocate ? 'your' : 'the'} task board and clear critical deadlines before the close of day.
          </div>
          <button type="button" aria-label="Dismiss alert" title="Dismiss" onClick={() => setAlertDismissed(true)} style={styles.dashAlertClose}>
            <IconX size={14} stroke={1.75} />
          </button>
        </div>
      )}

      <div className="lf-dashboard-stats" style={styles.dashStatsGrid}>
        <DashboardStatCard
          accent="#1A3628"
          iconBg="rgba(26,54,40,0.08)"
          iconColor="#1A3628"
          icon={IconBriefcase}
          label="Active matters"
          value={activeMattersValue}
          note={data.dashboard.newMattersThisMonth ? `${data.dashboard.newMattersThisMonth} opened this month` : 'Across active files'}
          onClick={() => onNavigate?.('Matters')}
          ariaLabel="View active matters"
        />
        <DashboardStatCard
          accent="#2C5F8A"
          iconBg="#EAF2FA"
          iconColor="#2C5F8A"
          icon={IconClockHour4}
          label="Hours this month"
          value={Number(data.dashboard.monthHours || 0).toFixed(1)}
          note="Billable time logged"
          onClick={() => onNavigate?.('Tasks')}
          ariaLabel="View billable hours this month"
        />
        <DashboardStatCard
          accent="#1A5C36"
          iconBg="#EBF5EE"
          iconColor="#1A5C36"
          icon={IconCash}
          label={isAdvocate ? 'My billed revenue' : 'Revenue this month'}
          value={kes(data.dashboard.monthRevenue)}
          valueSm
          note="Invoices settled"
          onClick={isAdmin ? () => onNavigate?.('Invoices') : undefined}
          ariaLabel={isAdvocate ? 'View billed revenue' : 'View revenue this month'}
        />
        <DashboardStatCard
          accent="#8B2020"
          iconBg="#FCEAEA"
          iconColor="#8B2020"
          icon={IconAlertCircle}
          label="Overdue tasks"
          value={overdueCount}
          note={overdueCount > 0 ? 'Needs immediate review' : 'Nothing overdue'}
          onClick={() => onNavigate?.('Tasks')}
          ariaLabel="View overdue tasks"
        />
      </div>

      <div className="lf-dashboard-grid" style={styles.dashboardGrid}>
        <DashboardPanel
          title={isAdvocate ? 'My matters' : 'Matter pipeline'}
          subtitle={isAdvocate ? 'Assigned files by stage' : 'Stage distribution across all files'}
          linkLabel="View all"
          onLink={() => onNavigate?.('Matters')}
        >
          {Object.keys(stages).length ? (
            <div style={styles.dashPanelBody}>
              {Object.entries(stages).map(([stage, count]) => (
                <button
                  key={stage}
                  type="button"
                  className="lf-dash-pipeline-row"
                  onClick={() => onNavigate?.('Matters')}
                  aria-label={`View ${stage} matters`}
                >
                  <span style={styles.dashPipelineLabel}>{stage}</span>
                  <span style={styles.dashPipelineTrack} aria-hidden="true">
                    <span style={{ ...styles.dashPipelineFill, width: `${(count / maxStage) * 100}%` }} />
                  </span>
                  <span style={styles.dashPipelineCount}>{count}</span>
                </button>
              ))}
            </div>
          ) : (
            <div style={styles.dashPanelEmpty}>
              {isAdvocate ? 'No assigned matters yet. Your assigned files will appear here.' : 'No matters yet. Create a client and matter to populate the board.'}
            </div>
          )}
        </DashboardPanel>

        <DashboardPanel
          title="Receivables"
          subtitle="Latest invoice status"
          linkLabel={isAdmin ? 'View all' : null}
          onLink={isAdmin ? () => onNavigate?.('Invoices') : null}
        >
          <div className="lf-receivables-cards">
            {data.invoices.length ? (
              <table className="lf-dash-table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Client</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.invoices.slice(0, 6).map(i => (
                    <tr key={i.id}>
                      <td>{i.number || i.id}</td>
                      <td>{i.clientName || '-'}</td>
                      <td>{kes(i.amount)}</td>
                      <td><Badge tone={statusTone(i.status)}>{i.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={styles.dashPanelEmpty}>No invoices yet.</div>
            )}
          </div>
        </DashboardPanel>
      </div>

      <DashboardPanel
        title="Upcoming court dates"
        subtitle="Appearances and virtual court links"
        linkLabel="Court diary"
        onLink={() => onNavigate?.('Deadlines')}
        fullWidth
      >
        <div className="lf-court-dates-cards">
          {upcomingEvents.length ? (
            <table className="lf-dash-table">
              <thead>
                <tr>
                  <th>Appearance</th>
                  <th>Matter</th>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Location</th>
                  <th>Virtual Court</th>
                </tr>
              </thead>
              <tbody>
                {upcomingEvents.map(event => {
                  const isTodayRow = Boolean(event.date) && event.date === todayIsoStr;
                  return (
                    <tr key={event.id || `${event.date}-${event.title}`} className={isTodayRow ? 'lf-dash-today-row' : ''}>
                      <td>{event.title || event.type || 'Court appearance'}</td>
                      <td>{event.matterTitle || event.reference || '-'}</td>
                      <td>{isTodayRow ? <><strong>Today</strong> · {event.date}</> : (event.date || '-')}</td>
                      <td>{event.time || '-'}</td>
                      <td>{event.location || '-'}</td>
                      <td><MeetingLink event={event} dashboard /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div style={styles.dashPanelEmpty}>No upcoming court dates.</div>
          )}
        </div>
      </DashboardPanel>

      <DashboardPanel
        title="Practice assistant"
        subtitle="Workflow prompts from today's matters, tasks and invoices"
        fullWidth
      >
        {practiceAssistant.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {practiceAssistant.map(item => (
              <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, flexWrap: 'wrap' }}>
                <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, flexShrink: 0, background: item.severity === 'high' ? '#991B1B' : item.severity === 'medium' ? '#92400E' : '#697386' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{item.label}</div>
                  {item.detail ? <div style={{ fontSize: 12, color: '#697386', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.detail}</div> : null}
                </div>
                {item.nav ? (
                  <button type="button" style={{ ...styles.ghostButton, fontSize: 12, padding: '4px 10px', whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => onNavigate?.(item.nav)}>{item.btn}</button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div style={styles.dashPanelEmpty}>No urgent practice items today.</div>
        )}
      </DashboardPanel>
    </div>
  );
}

function ClientAvatar({ clientId, hasAvatar, fullName, size = 28 }) {
  const [src, setSrc] = useState(null);
  const srcRef = useRef(null);
  useEffect(() => {
    function revoke() { if (srcRef.current) { URL.revokeObjectURL(srcRef.current); srcRef.current = null; } }
    if (!clientId || !hasAvatar) { revoke(); setSrc(null); return undefined; }
    let alive = true;
    fetchClientAvatarObjectUrl(clientId).then(url => {
      if (!alive) { if (url) URL.revokeObjectURL(url); return; }
      revoke();
      srcRef.current = url;
      setSrc(url);
    });
    return () => { alive = false; revoke(); };
  }, [clientId, hasAvatar]);
  const initial = (fullName || 'C').slice(0, 1).toUpperCase();
  return (
    <div style={{ width: size, height: size, borderRadius: 999, background: 'var(--lf-accent, #D4A34A)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: Math.round(size * 0.43), overflow: 'hidden', flexShrink: 0 }}>
      {src
        ? <img src={src} alt={fullName || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={() => setSrc(null)} />
        : initial}
    </div>
  );
}

export function Clients({ clients, matters, canManage, isAdmin = false, reload, notify, focus }) {
  const emptyClientForm = { name: '', type: 'Individual', contact: '', email: '', phone: '', remindersEnabled: true, preferredChannel: 'firm_default' };
  const [form, setForm] = useState(emptyClientForm);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [users, setUsers] = useState([]);
  // PRODUCT-16L: client-side Client directory filters (UI convenience only; no fetch/API/semantics change).
  const [clientSearch, setClientSearch] = useState('');
  const [clientType, setClientType] = useState('all');
  useEffect(() => { if (isAdmin) loadUsers(); }, [isAdmin]);
  useEffect(() => {
    if (!focus?.clientId) return;
    const el = document.getElementById(`client-${focus.clientId}`);
    if (el) {
      const prev = el.style.background;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.background = 'rgba(212, 163, 74, 0.15)';
      setTimeout(() => { el.style.background = prev; }, 1200);
    }
  }, [focus?.clientId, focus?.ts]);
  async function loadUsers() { try { setUsers(await api('/auth/users')); } catch { setUsers([]); } }
  async function submit(event) {
    event.preventDefault();
    try {
      if (editing) await api(`/clients/${editing.id}`, { method: 'PATCH', body: form });
      else await api('/clients', { method: 'POST', body: form });
      setForm(emptyClientForm);
      setEditing(null);
      notify({ type: 'success', message: editing ? 'Client updated.' : 'Client created.' });
      await reload();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  function startEdit(client) {
    setEditing(client);
    setForm({ ...emptyClientForm, name: client.name || '', type: client.type || 'Individual', contact: client.contact || '', email: client.email || '', phone: client.phone || '', remindersEnabled: client.remindersEnabled === undefined ? true : Boolean(Number(client.remindersEnabled)), preferredChannel: client.preferredChannel || 'firm_default' });
  }
  async function deleteClient(client) {
    try {
      await api(`/clients/${client.id}`, { method: 'DELETE' });
      notify({ type: 'success', message: 'Client deleted.' });
      await reload();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function inviteClient(client) {
    if (!client.email) return notify({ type: 'warning', message: 'Add the client email before generating an invitation.' });
    try {
      const invite = await api('/invitations', { method: 'POST', body: { email: client.email, clientId: client.id } });
      await navigator.clipboard?.writeText(invite.url).catch(() => {});
      notify({ type: 'success', message: 'Invitation generated. Link copied if clipboard access is available.' });
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  function portalCell(client) {
    if (!isAdmin) return '-';
    const account = users.find(user => user.role === 'client' && user.clientId === client.id);
    if (account) return <Badge tone="green">Active</Badge>;
    return <button type="button" style={styles.tinyButton} onClick={() => inviteClient(client)}>Send Invitation</button>;
  }
  function reminderCell(client) {
    if (client.remindersEnabled === 0) return <Badge tone="red">Off</Badge>;
    const channel = client.preferredChannel || 'firm_default';
    return <Badge tone={channel === 'none' ? 'red' : channel === 'firm_default' ? 'blue' : 'green'}>{channel === 'firm_default' ? 'Firm default' : channel}</Badge>;
  }
  async function handleClientAvatarUpload(client, file) {
    if (!file) return;
    if (!AVATAR_ALLOWED_MIME.includes(file.type)) { notify({ type: 'danger', message: 'Only JPEG, PNG, and WebP images are supported.' }); return; }
    if (file.size > AVATAR_MAX_BYTES) { notify({ type: 'danger', message: 'Image must be 512 KB or smaller.' }); return; }
    try {
      await uploadClientAvatar(client.id, file);
      notify({ type: 'success', message: 'Client photo uploaded.' });
      await reload();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function handleClientAvatarRemove(client) {
    try {
      await deleteClientAvatar(client.id);
      notify({ type: 'success', message: 'Client photo removed.' });
      await reload();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  // PRODUCT-16L: filter the already-loaded clients array only. Type values match the create form
  // (Individual/Company); search spans name, email, phone, and contact. clients is never mutated.
  const clientQuery = clientSearch.trim().toLowerCase();
  const filteredClients = clients.filter(c => {
    if (clientType !== 'all' && (c.type || 'Individual') !== clientType) return false;
    if (clientQuery) {
      const haystack = `${c.name || ''} ${c.email || ''} ${c.phone || ''} ${c.contact || ''}`.toLowerCase();
      if (!haystack.includes(clientQuery)) return false;
    }
    return true;
  });
  const clientEmptyText = clients.length === 0 ? 'No clients yet.' : 'No clients match these filters.';
  // PRODUCT-17B: export exactly the filtered client rows the user is viewing (no fetch, no hidden data).
  function exportClients() {
    if (!filteredClients.length) return;
    downloadCsv('lexflow-clients.csv', ['Name', 'Type', 'Contact', 'Email', 'Phone', 'Status'], filteredClients.map(c => [c.name || '', c.type || '', c.contact || '', c.email || '', c.phone || '', c.status || 'Active']));
  }
  return <div className="lf-split-grid" style={styles.splitGrid}><Card title={editing ? 'Edit client' : 'New client'} hint={editing ? 'Save client changes and communication preference' : 'Intake record'}><form onSubmit={submit} style={styles.formGrid}><Field label="Name"><input required style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="Type"><select style={styles.input} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}><option>Individual</option><option>Company</option></select></Field><Field label="Contact"><input style={styles.input} value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} /></Field><Field label="Email"><input style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field><Field label="Phone"><input style={styles.input} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field><Field label="Reminders"><select style={styles.input} value={form.remindersEnabled ? 'on' : 'off'} onChange={e => setForm({ ...form, remindersEnabled: e.target.value === 'on' })}><option value="on">On</option><option value="off">Off for this client</option></select></Field><Field label="Preferred Channel"><select style={styles.input} value={form.preferredChannel} onChange={e => setForm({ ...form, preferredChannel: e.target.value })}><option value="firm_default">Firm default</option><option value="both">WhatsApp and Email</option><option value="whatsapp">WhatsApp only</option><option value="email">Email only</option><option value="none">None</option></select></Field><button style={styles.primaryButton}>{editing ? 'Save changes' : 'Create client'}</button>{editing && <button type="button" style={styles.ghostButton} onClick={() => { setEditing(null); setForm(emptyClientForm); }}>Cancel</button>}</form></Card><Card title="Client directory" hint={`Showing ${filteredClients.length} of ${clients.length} clients`}><div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}><input type="search" aria-label="Search clients by name, email, or phone" placeholder="Search clients…" value={clientSearch} onChange={e => setClientSearch(e.target.value)} style={{ flex: 1, minWidth: 150, border: `1px solid ${theme.line}`, borderRadius: 6, padding: '7px 11px', background: '#fff', fontSize: 13, outline: 'none' }} /><select aria-label="Filter clients by type" value={clientType} onChange={e => setClientType(e.target.value)} style={{ ...styles.input, width: 'auto', minWidth: 128 }}><option value="all">All types</option><option value="Individual">Individual</option><option value="Company">Company</option></select><button type="button" style={{ ...styles.ghostButton, fontSize: 12, padding: '6px 12px' }} onClick={exportClients} disabled={!filteredClients.length} title="Download the filtered clients as a CSV file">Export CSV</button></div><div className="lf-client-cards"><Table columns={['Photo', 'Name', 'Type', 'Email', 'Phone', 'Status', 'Reminders', 'Portal', 'Actions']} rows={filteredClients.map(c => [<ClientAvatar key={`client-avatar-${c.id}`} clientId={c.id} hasAvatar={c.hasAvatar} fullName={c.name} size={28} />, <div key={`client-name-${c.id}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY, title: c.name, lines: [`${c.type || 'Client'} / ${c.status || 'Active'}`, `${matters.filter(m => m.clientId === c.id).length} matter(s)`, `Joined ${c.joinDate || '-'}`], initial: (c.name || 'C').slice(0, 1) })} onMouseLeave={() => setTooltip(null)} style={styles.hoverName}>{c.name}</span>{isAdmin && c.clientUserId && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}><label style={{ cursor: 'pointer' }}><span style={{ ...styles.tinyButton, display: 'inline-block' }}>{c.hasAvatar ? 'Change photo' : 'Upload photo'}</span><input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} onChange={e => { handleClientAvatarUpload(c, e.target.files?.[0]); e.target.value = ''; }} /></label>{c.hasAvatar && <button type="button" style={styles.tinyButton} onClick={() => handleClientAvatarRemove(c)}>Remove photo</button>}</div>}</div>, c.type, c.email || '-', c.phone || '-', <Badge key={`${c.id}-status`} tone="green">{c.status || 'Active'}</Badge>, reminderCell(c), portalCell(c), canManage ? <ActionGroup key={`${c.id}-actions`} actions={[[ 'Edit', () => startEdit(c)], ['Delete', () => setConfirm({ title: 'Delete client?', message: 'Are you sure you want to delete this client? This will also remove all related matters.', onConfirm: () => deleteClient(c) })]]} /> : '-'])} rowIds={filteredClients.map(c => `client-${c.id}`)} empty={clientEmptyText} /></div></Card><ProfileTooltip tooltip={tooltip} /><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></div>;
}export function Matters({ data, canManage, reload, notify, focus, onMatterOpened }) {
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [detailTab, setDetailTab] = useState('Workspace');
  const [editingMatter, setEditingMatter] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null);
  const [editingTime, setEditingTime] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [loading, setLoading] = useState(false);
  const [cockpitOpen, setCockpitOpen] = useState(false);
  const [workMetadataLinks, setWorkMetadataLinks] = useState([]);
  // PRODUCT-16M: client-side Matter list filters (UI convenience only; no fetch/API/selection/semantics change).
  const [matterSearch, setMatterSearch] = useState('');
  const [matterStage, setMatterStage] = useState('open');
  const emptyMatterForm = { clientId: '', title: '', practiceArea: '', stage: 'Intake', assignedTo: '', paralegal: '', description: '', court: '', judge: '', caseNo: '', opposingCounsel: '', priority: 'Medium', solDate: '', billingType: 'hourly', billingRate: 15000, fixedFee: 0, retainerBalance: 0, remindersEnabled: 'firm_default', courtRemindersEnabled: 'firm_default', invoiceRemindersEnabled: 'firm_default' };
  const [form, setForm] = useState(emptyMatterForm);
  const [time, setTime] = useState({ hours: 1, description: '', rate: 15000, billable: true });
  const emptyEventForm = { title: '', date: '', time: '9:00 AM', type: 'Hearing', location: '', meetingLink: '', attorney: '', prepNote: '' };
  const [eventForm, setEventForm] = useState(emptyEventForm);
  const [note, setNote] = useState('');
  const [invoiceDueDateOverride, setInvoiceDueDateOverride] = useState('');
  const [taskTimer, setTaskTimer] = useState(null);
  const [advocates, setAdvocates] = useState([]);
  const [reassignTo, setReassignTo] = useState('');
  const [reassigning, setReassigning] = useState(false);
  const emptyChecklistForm = { title: '', notes: '', position: '', dueDate: '', assignee: '' };
  const [checklistForm, setChecklistForm] = useState(emptyChecklistForm);
  const [editingChecklistItem, setEditingChecklistItem] = useState(null);
  const [checklistTemplates, setChecklistTemplates] = useState([]);
  const [templateForm, setTemplateForm] = useState(() => emptyChecklistTemplateForm());
  const [editingTemplateId, setEditingTemplateId] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateSaving, setTemplateSaving] = useState(false);
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  const session = readSession();
  const isAdmin = session?.user?.role === 'admin';
  const userRole = session?.user?.role || '';
  const canManageChecklist = userRole === 'admin' || userRole === 'advocate';
  const canToggleChecklist = ['admin', 'advocate', 'assistant'].includes(userRole);
  const canApplyChecklistTemplate = userRole === 'admin' || userRole === 'advocate';
  const activeChecklistTemplates = checklistTemplates.filter(template => Number(template.active || 0) === 1);
  const canViewBilling = isAdmin || session?.user?.role !== 'advocate' || Number(data.firmSettings?.advocateBillingVisibility ?? 1) !== 0;
  const defaultInvoiceDueDays = invoiceDueDaysSetting(data.firmSettings);
  const defaultInvoiceDueDate = addDaysIso(defaultInvoiceDueDays);
  const selected = data.matters.find(m => m.id === selectedId) || data.matters[0];
  const nextActionHints = useMemo(() => buildMatterNextActionHints(detail), [detail]);

  useEffect(() => { if (selected?.id) { setSelectedId(selected.id); loadDetail(selected.id); } else { setDetail(null); setSuggestions([]); } }, [selected?.id]);
  useEffect(() => { if (detail && isAdmin) getUsers(true).then(users => { setAdvocates((users || []).filter(u => u.role === 'advocate' && u.isActive)); setReassignTo(detail.assignedTo || ''); }).catch(() => {}); }, [detail?.id]);
  useEffect(() => { if (['admin', 'advocate', 'assistant'].includes(userRole)) loadChecklistTemplates(); }, [userRole]);
  useEffect(() => {
    if (!focus?.matterId) return;
    setSelectedId(focus.matterId);
    setDetailTab('Workspace');
  }, [focus?.matterId, focus?.ts]);

  async function loadDetail(id) {
    setLoading(true);
    try {
      const [matter, smartTips, links] = await Promise.all([
        api(`/matters/${id}`),
        api(`/matters/${id}/suggestions`),
        getMatterWorkMetadataLinks(id).catch(() => []),
      ]);
      setDetail(matter);
      setSuggestions(Array.isArray(smartTips) ? smartTips : []);
      setWorkMetadataLinks(Array.isArray(links) ? links : []);
      onMatterOpened?.(id);
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setLoading(false);
    }
  }
  async function loadChecklistTemplates() {
    try {
      const templates = await listChecklistTemplates();
      setChecklistTemplates(Array.isArray(templates) ? templates : []);
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    }
  }
  function resetTemplateEditor() {
    setEditingTemplateId('');
    setTemplateForm(emptyChecklistTemplateForm());
  }
  function startTemplateEdit(template) {
    setEditingTemplateId(template.id);
    setTemplateForm({
      name: template.name || '',
      description: template.description || '',
      practiceArea: template.practiceArea || '',
      items: template.items?.length ? template.items.map((item, index) => ({ title: item.title || '', notes: item.notes || '', position: item.position ?? index })) : [blankChecklistTemplateItem(0)],
    });
  }
  function addTemplateFormItem() {
    setTemplateForm(current => ({ ...current, items: [...current.items, blankChecklistTemplateItem(current.items.length)] }));
  }
  function updateTemplateFormItem(index, field, value) {
    setTemplateForm(current => ({ ...current, items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item) }));
  }
  function removeTemplateFormItem(index) {
    setTemplateForm(current => {
      const nextItems = current.items.filter((_, itemIndex) => itemIndex !== index);
      return { ...current, items: nextItems.length ? nextItems : [blankChecklistTemplateItem(0)] };
    });
  }
  async function saveChecklistTemplate(event) {
    event.preventDefault();
    if (!isAdmin || !templateForm.name.trim()) return;
    const items = templateForm.items.map((item, index) => ({
      title: item.title || '',
      notes: item.notes || '',
      position: Number.isFinite(Number(item.position)) ? Number(item.position) : index,
    }));
    if (!items.length || items.some(item => !item.title.trim())) {
      notify({ type: 'danger', message: 'Template items need titles.' });
      return;
    }
    setTemplateSaving(true);
    try {
      const payload = { ...templateForm, items };
      if (editingTemplateId) {
        await updateChecklistTemplate(editingTemplateId, payload);
        notify({ type: 'success', message: 'Checklist template updated.' });
      } else {
        await createChecklistTemplate(payload);
        notify({ type: 'success', message: 'Checklist template created.' });
      }
      resetTemplateEditor();
      await loadChecklistTemplates();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setTemplateSaving(false);
    }
  }
  async function deactivateChecklistTemplate(template) {
    try {
      await deleteChecklistTemplate(template.id);
      notify({ type: 'success', message: 'Checklist template deactivated.' });
      if (selectedTemplateId === template.id) setSelectedTemplateId('');
      if (editingTemplateId === template.id) resetTemplateEditor();
      await loadChecklistTemplates();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    }
  }
  async function createMatter(event) { event.preventDefault(); try { if (editingMatter && detail) { await api(`/matters/${detail.id}`, { method: 'PATCH', body: form }); setEditingMatter(false); notify({ type: 'success', message: 'Matter updated.' }); await loadDetail(detail.id); } else { await api('/matters', { method: 'POST', body: form }); notify({ type: 'success', message: 'Matter created.' }); } setForm(emptyMatterForm); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function logTime(event) { event.preventDefault(); if (!detail) return; try { const body = { ...time, billable: Boolean(time.billable), matterId: detail.id }; if (!canViewBilling) delete body.rate; await api('/time-entries', { method: 'POST', body }); setTime({ hours: 1, description: '', rate: canViewBilling ? detail.billingRate || 15000 : 0, billable: true }); notify({ type: 'success', message: 'Time logged.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function addNote(event) { event.preventDefault(); if (!detail || !note.trim()) return; try { await api(`/matters/${detail.id}/notes`, { method: 'POST', body: { content: note } }); setNote(''); notify({ type: 'success', message: 'Case note saved.' }); await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function createEvent(event) { event.preventDefault(); if (!detail) return; try { await api('/appearances', { method: 'POST', body: { ...eventForm, matterId: detail.id } }); setEventForm(emptyEventForm); notify({ type: 'success', message: 'Court appearance scheduled.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function uploadDoc(event) { const file = event.target.files?.[0]; if (!file || !detail) return; try { await api(`/matters/${detail.id}/documents`, { method: 'POST', body: { name: file.name, mimeType: file.type || 'application/octet-stream', data: await fileToDataUrl(file) } }); notify({ type: 'success', message: 'Document uploaded.' }); event.target.value = ''; await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function generateInvoice() { if (!detail) return; try { const body = { matterId: detail.id }; if (invoiceDueDateOverride) body.dueDate = invoiceDueDateOverride; await api('/invoices/generate', { method: 'POST', body }); setInvoiceDueDateOverride(''); notify({ type: 'success', message: 'Invoice generated.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  function startMatterEdit() { if (!detail) return; setEditingMatter(true); setForm({ ...emptyMatterForm, ...detail }); }
  async function archiveMatter() { if (!detail) return; try { await api(`/matters/${detail.id}/status`, { method: 'PATCH', body: { stage: 'Closed' } }); notify({ type: 'success', message: 'Matter archived.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteMatterRecord() { if (!detail) return; try { const id = detail.id; await api(`/matters/${id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Matter deleted.' }); setDetail(null); setSelectedId(''); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function refreshChecklist(matterId) { const checklistItems = await listMatterChecklistItems(matterId); setDetail(current => current?.id === matterId ? { ...current, checklistItems } : current); }
  async function addChecklistItem(event) {
    event.preventDefault();
    if (!detail || !checklistForm.title.trim()) return;
    const payload = { title: checklistForm.title, notes: checklistForm.notes, dueDate: checklistForm.dueDate, assignee: checklistForm.assignee };
    if (checklistForm.position !== '') payload.position = Number(checklistForm.position);
    try {
      await createMatterChecklistItem(detail.id, payload);
      setChecklistForm(emptyChecklistForm);
      notify({ type: 'success', message: 'Checklist item added.' });
      await refreshChecklist(detail.id);
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function toggleChecklistItem(item) { if (!detail) return; try { await updateMatterChecklistItem(detail.id, item.id, { completed: !item.completed }); await refreshChecklist(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function saveChecklistItem(item, values) {
    if (!detail) return;
    try {
      await updateMatterChecklistItem(detail.id, item.id, { title: values.title || '', notes: values.notes || '', position: Number(values.position || 0), dueDate: values.dueDate || '', assignee: values.assignee || '' });
      setEditingChecklistItem(null);
      notify({ type: 'success', message: 'Checklist item updated.' });
      await refreshChecklist(detail.id);
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function deleteChecklistItemRecord(item) { if (!detail) return; try { await deleteMatterChecklistItem(detail.id, item.id); notify({ type: 'success', message: 'Checklist item deleted.' }); await refreshChecklist(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function applySelectedChecklistTemplate(event) {
    event.preventDefault();
    if (!detail || !selectedTemplateId || !canApplyChecklistTemplate) return;
    setApplyingTemplate(true);
    try {
      const createdItems = await applyChecklistTemplate(detail.id, selectedTemplateId);
      notify({ type: 'success', message: `${Array.isArray(createdItems) ? createdItems.length : 0} checklist item(s) applied.` });
      setSelectedTemplateId('');
      await refreshChecklist(detail.id);
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    } finally {
      setApplyingTemplate(false);
    }
  }
  async function saveTask(task, values) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: values }); setEditingTask(null); notify({ type: 'success', message: 'Task updated.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteTaskRecord(task) { try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Task deleted.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteDocumentRecord(doc) { try { await api(`/documents/${doc.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Document deleted.' }); await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteInvoiceRecord(invoice) { try { await api(`/invoices/${invoice.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Invoice deleted.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function handleReassign() { if (!detail || !reassignTo || reassignTo === detail.assignedTo) return; setReassigning(true); try { await reassignMatter(detail.id, reassignTo); notify({ type: 'success', message: `Matter reassigned to ${reassignTo}.` }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } finally { setReassigning(false); } }
  async function saveEvent(event, values) { try { await api(`/appearances/${event.id}`, { method: 'PATCH', body: values }); setEditingEvent(null); notify({ type: 'success', message: 'Appearance updated.' }); await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteEventRecord(event) { try { await api(`/appearances/${event.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Appearance deleted.' }); await loadDetail(detail.id); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function saveTimeEntry(entry, values) { try { const body = { ...values }; if (!canViewBilling) delete body.rate; await api(`/time-entries/${entry.id}`, { method: 'PATCH', body }); setEditingTime(null); notify({ type: 'success', message: 'Time entry updated.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteTimeEntryRecord(entry) { try { await api(`/time-entries/${entry.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Time entry deleted.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }

  // PRODUCT-16M: filter the already-loaded matters for the list only. Stage 'open' hides Closed files,
  // 'all' shows every stage, otherwise match the chosen stage. Search spans title/reference/id/client/
  // advocate/practice. data.matters is never mutated and `selected`/selectedId/loadDetail are untouched,
  // so filtering the list never closes the currently open matter.
  const matterQuery = matterSearch.trim().toLowerCase();
  const filteredMatters = data.matters.filter(m => {
    const stage = m.stage || 'Intake';
    if (matterStage === 'open') { if (stage === 'Closed') return false; }
    else if (matterStage !== 'all' && stage !== matterStage) return false;
    if (matterQuery) {
      const haystack = `${m.title || ''} ${m.reference || ''} ${m.id || ''} ${m.clientName || ''} ${m.assignedTo || ''} ${m.practiceArea || ''}`.toLowerCase();
      if (!haystack.includes(matterQuery)) return false;
    }
    return true;
  });
  const matterEmptyText = data.matters.length === 0 ? 'No matters yet.' : 'No matters match these filters.';
  // PRODUCT-17B: export exactly the filtered matter rows the user is viewing (no fetch, no hidden data).
  function exportMatters() {
    if (!filteredMatters.length) return;
    downloadCsv('lexflow-matters.csv', ['Title', 'Reference', 'Client', 'Stage', 'Practice Area', 'Assigned To', 'Priority', 'Next Court Date'], filteredMatters.map(m => [m.title || '', m.reference || m.id || '', m.clientName || '', m.stage || 'Intake', m.practiceArea || '', m.assignedTo || '', m.priority || 'Medium', nextCourtDate(m)]));
  }

  return (
    <div className="lf-matter-grid" style={styles.matterGrid}>
      <Card title="Matter list" hint={`Showing ${filteredMatters.length} of ${data.matters.length} matters`}>
        {data.matters.length ? (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input type="search" aria-label="Search matters by title, client, reference, or advocate" placeholder="Search matters…" value={matterSearch} onChange={e => setMatterSearch(e.target.value)} style={{ flex: 1, minWidth: 140, border: `1px solid ${theme.line}`, borderRadius: 6, padding: '7px 11px', background: '#fff', fontSize: 13, outline: 'none' }} />
              <select aria-label="Filter matters by stage" value={matterStage} onChange={e => setMatterStage(e.target.value)} style={{ ...styles.input, width: 'auto', minWidth: 132 }}>
                <option value="open">Active (hide Closed)</option>
                <option value="all">All stages</option>
                <option value="Intake">Intake</option>
                <option value="Conflict Check">Conflict Check</option>
                <option value="Engagement">Engagement</option>
                <option value="Active">Active</option>
                <option value="Discovery">Discovery</option>
                <option value="Trial Prep">Trial Prep</option>
                <option value="On Hold">On Hold</option>
                <option value="Closed">Closed</option>
              </select>
              <button type="button" style={{ ...styles.ghostButton, fontSize: 12, padding: '6px 12px' }} onClick={exportMatters} disabled={!filteredMatters.length} title="Download the filtered matters as a CSV file">Export CSV</button>
            </div>
            <div style={{ fontSize: 12, color: '#697386', marginBottom: 10 }}>Filtering the list does not close the currently open matter.</div>
            {filteredMatters.length ? filteredMatters.map(m => (
              <button key={m.id} onClick={() => setSelectedId(m.id)} onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY, title: m.title, lines: [m.reference || m.id, `Stage: ${m.stage || 'Intake'}`, `Priority: ${m.priority || 'Medium'}`, `Advocate: ${m.assignedTo || '-'}`, `Next court: ${nextCourtDate(m)}`], initial: (m.title || 'M').slice(0, 1) })} onMouseLeave={() => setTooltip(null)} style={{ ...styles.matterButton, ...(selected?.id === m.id ? styles.matterActive : {}) }}>
                <strong>{m.title}</strong>
                <span>{m.reference || m.id}</span>
                <small>{m.clientName || 'No client'} / {m.stage || 'Intake'}</small>
              </button>
            )) : <Empty title="No matches" text={matterEmptyText} />}
          </>
        ) : <Empty title="No matters" text={matterEmptyText} />}
      </Card>
      <div style={styles.pageStack}>
        {canManage && (
          <Card title={editingMatter ? 'Edit matter' : 'Open a new matter'} hint={editingMatter ? 'Update matter profile' : 'Matter setup'}>
            <form onSubmit={createMatter} style={styles.formGrid}>
              <Field label="Client"><select required style={styles.input} value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })}><option value="">Select client</option>{data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Title"><input required style={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field>
              <Field label="Practice"><input style={styles.input} value={form.practiceArea} onChange={e => setForm({ ...form, practiceArea: e.target.value })} /></Field>
              <Field label="Stage"><select style={styles.input} value={form.stage} onChange={e => setForm({ ...form, stage: e.target.value })}><option>Intake</option><option>Conflict Check</option><option>Engagement</option><option>Active</option><option>Discovery</option><option>Trial Prep</option><option>On Hold</option><option>Closed</option></select></Field>
              <Field label="Advocate"><input style={styles.input} value={form.assignedTo || ''} onChange={e => setForm({ ...form, assignedTo: e.target.value })} /></Field>
              <Field label="Court"><input style={styles.input} value={form.court || ''} onChange={e => setForm({ ...form, court: e.target.value })} /></Field>
              <Field label="Judge"><input style={styles.input} value={form.judge || ''} onChange={e => setForm({ ...form, judge: e.target.value })} /></Field>
              <Field label="SOL Date"><input type="date" style={styles.input} value={form.solDate || ''} onChange={e => setForm({ ...form, solDate: e.target.value })} /></Field>
              <Field label="Opposing Counsel"><input style={styles.input} value={form.opposingCounsel || ''} onChange={e => setForm({ ...form, opposingCounsel: e.target.value })} /></Field>
              <Field label="Billing"><select style={styles.input} value={form.billingType} onChange={e => setForm({ ...form, billingType: e.target.value })}><option value="hourly">Hourly</option><option value="fixed">Fixed fee</option></select></Field>
              <Field label="Rate/Fee"><input type="number" style={styles.input} value={form.billingType === 'fixed' ? form.fixedFee : form.billingRate} onChange={e => setForm({ ...form, [form.billingType === 'fixed' ? 'fixedFee' : 'billingRate']: Number(e.target.value) })} /></Field>
              <Field label="Matter Reminders"><select style={styles.input} value={form.remindersEnabled || 'firm_default'} onChange={e => setForm({ ...form, remindersEnabled: e.target.value })}><option value="firm_default">Use client/firm default</option><option value="on">On for this matter</option><option value="off">Off for this matter</option></select></Field><Field label="Court Reminders"><select style={styles.input} value={form.courtRemindersEnabled || 'firm_default'} onChange={e => setForm({ ...form, courtRemindersEnabled: e.target.value })}><option value="firm_default">Use matter default</option><option value="on">On</option><option value="off">Off</option></select></Field><Field label="Invoice Reminders"><select style={styles.input} value={form.invoiceRemindersEnabled || 'firm_default'} onChange={e => setForm({ ...form, invoiceRemindersEnabled: e.target.value })}><option value="firm_default">Use matter default</option><option value="on">On</option><option value="off">Off</option></select></Field><Field label="Description"><input style={styles.input} value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} /></Field>
              <button style={styles.primaryButton}>{editingMatter ? 'Save changes' : 'Create matter'}</button>
              {editingMatter && <button type="button" style={styles.ghostButton} onClick={() => { setEditingMatter(false); setForm(emptyMatterForm); }}>Cancel</button>}
            </form>
          </Card>
        )}
        {isAdmin && (
          <ChecklistTemplateLibrary
            templates={activeChecklistTemplates}
            form={templateForm}
            setForm={setTemplateForm}
            editingTemplateId={editingTemplateId}
            saving={templateSaving}
            onSubmit={saveChecklistTemplate}
            onEdit={startTemplateEdit}
            onCancel={resetTemplateEditor}
            onAddItem={addTemplateFormItem}
            onUpdateItem={updateTemplateFormItem}
            onRemoveItem={removeTemplateFormItem}
            confirmDelete={template => setConfirm({ title: 'Deactivate checklist template?', message: 'Deactivate this template? Already-applied matter checklist items will remain unchanged.', onConfirm: () => deactivateChecklistTemplate(template) })}
          />
        )}
        <Card title={detail?.title || 'Matter detail'} hint={detail?.reference || 'Select a file'} action={detail && canManage ? <ActionGroup actions={[['Edit', startMatterEdit], ['Archive', () => setConfirm({ title: 'Archive matter?', message: 'Archive this matter by setting the stage to Closed?', onConfirm: archiveMatter })], ['Delete', () => setConfirm({ title: 'Delete matter?', message: 'Delete this matter and all associated data?', onConfirm: deleteMatterRecord })]]} /> : null}>
          {loading && <Skeleton rows={2} />}
          {!loading && detail && (
            <div className="lf-matter-detail-workspace" style={{ ...styles.detailStack, minWidth: 0 }}>
              <div style={styles.chips}>
                <Badge tone="blue">{detail.stage || 'Intake'}</Badge>
                <span>{detail.clientName || 'No client'}</span>
                <span>{detail.practiceArea || 'General'}</span>
                {isAdmin && (
                  <span className="lf-admin-reassign-control" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
                    <Badge tone="navy">Advocate: {detail.assignedTo || 'Unassigned'}</Badge>
                    <select style={{ ...styles.input, width: 160, fontSize: 12, padding: '2px 6px' }} value={reassignTo} onChange={e => setReassignTo(e.target.value)}>
                      <option value="">Select advocate</option>
                      {advocates.map(a => <option key={a.id} value={a.fullName}>{a.fullName}</option>)}
                    </select>
                    <button style={{ ...styles.ghostButton, fontSize: 12, padding: '2px 10px' }} disabled={reassigning || !reassignTo || reassignTo === detail.assignedTo} onClick={handleReassign}>{reassigning ? '...' : 'Reassign'}</button>
                  </span>
                )}
              </div>
              <div style={styles.tabList}>
                {['Workspace', 'Assistant', 'Court'].map(tab => (
                  <button key={tab} type="button" onClick={() => setDetailTab(tab)} style={{ ...styles.tabButton, ...(detailTab === tab ? styles.tabActive : {}) }}>{tab}</button>
                ))}
              </div>
              {detailTab === 'Assistant' ? (
                <AssistantSuggestions suggestions={suggestions} hints={nextActionHints} />
              ) : detailTab === 'Court' ? (
                <MatterCourtMode detail={detail} nextActionHints={nextActionHints} />
              ) : (
                <>
                  <div className="lf-matter-quick-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
                    <button type="button" onClick={() => scrollToSection('matter-section-time')} style={{ ...styles.ghostButton, fontSize: 12, padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }} aria-label="Log time for this matter">
                      <IconClock size={14} stroke={1.75} /> Log time
                    </button>
                    <button type="button" onClick={() => scrollToSection('matter-section-tasks')} style={{ ...styles.ghostButton, fontSize: 12, padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }} aria-label="View and add matter tasks">
                      <IconListCheck size={14} stroke={1.75} /> Task
                    </button>
                    <button type="button" onClick={() => scrollToSection('matter-section-court')} style={{ ...styles.ghostButton, fontSize: 12, padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }} aria-label="Add court appearance or date">
                      <IconCalendarEvent size={14} stroke={1.75} /> Court
                    </button>
                    <button type="button" onClick={() => scrollToSection('matter-section-documents')} style={{ ...styles.ghostButton, fontSize: 12, padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }} aria-label="Upload or view documents">
                      <IconUpload size={14} stroke={1.75} /> Document
                    </button>
                    <button type="button" onClick={() => scrollToSection('matter-section-notes')} style={{ ...styles.ghostButton, fontSize: 12, padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }} aria-label="Add case note">
                      <IconNote size={14} stroke={1.75} /> Note
                    </button>
                  </div>
                  {workMetadataLinks.length > 0 && (
                    <section aria-label="Linked metadata" style={{ border: `1px solid ${theme.line}`, background: '#fff', borderRadius: 10, padding: 14, display: 'grid', gap: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                        <div style={{ display: 'grid', gap: 2 }}>
                          <strong style={{ fontSize: 13 }}>Linked metadata <span style={{ color: theme.muted, fontSize: 12, fontWeight: 400 }}>({workMetadataLinks.length})</span></strong>
                          <span style={{ color: theme.muted, fontSize: 12 }}>Confirmed email and calendar metadata linked to this matter.</span>
                        </div>
                        <a href="/connected-accounts" style={{ ...styles.ghostButton, fontSize: 12, padding: '4px 10px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconExternalLink size={14} stroke={1.75} /> View all</a>
                      </div>
                      <div style={{ display: 'grid', gap: 8 }}>
                        {workMetadataLinks.map(link => (
                          <div key={link.linkId} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', border: `1px solid ${theme.line}`, borderRadius: 8, background: '#F9FAFB' }}>
                            <div style={{ flexShrink: 0, marginTop: 2 }}>
                              {link.sourceType === 'email' ? <IconMail size={16} stroke={1.75} style={{ color: '#697386' }} /> : <IconCalendarEvent size={16} stroke={1.75} style={{ color: '#697386' }} />}
                            </div>
                            <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 3 }}>
                              <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{link.subject || '(No subject)'}</div>
                              <div style={{ fontSize: 12, color: theme.muted, display: 'flex', flexWrap: 'wrap', gap: '2px 12px' }}>
                                {link.sourceType === 'email' && link.sender && <span>From: {link.sender}</span>}
                                {link.sourceType === 'calendar' && link.organizer && <span>Organizer: {link.organizer}</span>}
                                {link.sourceType === 'email' && link.receivedAt && <span>{new Date(link.receivedAt).toLocaleString()}</span>}
                                {link.sourceType === 'calendar' && link.startTime && <span>{new Date(link.startTime).toLocaleString()}</span>}
                                {link.sourceType === 'email' && Number(link.hasAttachments) > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><IconPaperclip size={12} stroke={1.75} /> Attachments</span>}
                                {link.sourceType === 'calendar' && link.meetingLink && <MeetingLink href={safeHttpUrl(link.meetingLink)} />}
                                <span style={{ color: '#9CA3AF' }}>{link.accountProvider} &middot; {link.accountEmail}</span>
                              </div>
                              <div style={{ fontSize: 11, color: '#9CA3AF' }}>Confirmed by {link.confirmedBy || 'System'} &middot; {link.confirmedAt ? new Date(link.confirmedAt).toLocaleString() : ''}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                  <section aria-label="Matter cockpit" style={{ border: `1px solid ${theme.line}`, background: '#fff', borderRadius: 10, padding: 14, display: 'grid', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ display: 'grid', gap: 2 }}>
                        <strong style={{ fontSize: 13 }}>Matter cockpit</strong>
                        <span style={{ color: theme.muted, fontSize: 12 }}>Next step, court prep, key documents, and billing snapshot.</span>
                      </div>
                      <button type="button" aria-expanded={cockpitOpen} onClick={() => setCockpitOpen(open => !open)} style={{ ...styles.ghostButton, fontSize: 12, padding: '4px 10px' }}>{cockpitOpen ? 'Hide cockpit' : 'Show cockpit'}</button>
                    </div>
                    {cockpitOpen && (
                      <div className="lf-matter-cockpit" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
                        <MatterNextStepPanel detail={detail} />
                        <MatterCourtPrepCard detail={detail} />
                        <MatterKeyDocumentsPanel detail={detail} />
                        <MatterBillingSnapshot detail={detail} />
                      </div>
                    )}
                  </section>
                  <MatterCommandSummary detail={detail} nextActionHints={nextActionHints} />
                  <MatterNextActionHints hints={nextActionHints} />
                  <MatterActivityTimeline detail={detail} />
                  <form id="matter-section-time" onSubmit={logTime} style={styles.formGrid}>
                    <Field label="Hours"><input type="number" min="0" step="0.1" style={styles.input} value={time.hours} onChange={e => setTime({ ...time, hours: Number(e.target.value) })} /></Field>
                    <Field label="Description"><input style={styles.input} value={time.description} onChange={e => setTime({ ...time, description: e.target.value })} /></Field>
                    {canViewBilling && <Field label="Rate"><input type="number" style={styles.input} value={time.rate} onChange={e => setTime({ ...time, rate: Number(e.target.value) })} /></Field>}
                    <Field label="Billing class"><select style={styles.input} value={time.billable ? 'billable' : 'non_billable'} onChange={e => setTime({ ...time, billable: e.target.value === 'billable' })}><option value="billable">Billable</option><option value="non_billable">Non-billable</option></select></Field>
                    <div style={{ ...styles.formHelper, gridColumn: '1 / -1' }}>{BILLABLE_TIME_GUIDANCE}</div>
                    <button style={styles.primaryButton}>Log time</button>
                  </form>
                  <div style={{ minWidth: 0, maxWidth: '100%' }}><Sub title="Time entries"><TimeEntryEditorList entries={detail.timeEntries || []} canManage={canManage} canViewBilling={canViewBilling} editingTime={editingTime} setEditingTime={setEditingTime} saveTimeEntry={saveTimeEntry} confirmDelete={entry => setConfirm({ title: 'Delete time entry?', message: 'Delete this time entry?', onConfirm: () => deleteTimeEntryRecord(entry) })} /></Sub></div>
                  <Sub title="Checklist"><MatterChecklistPanel items={detail.checklistItems || []} templates={activeChecklistTemplates} canManage={canManageChecklist} canToggle={canToggleChecklist} canApplyTemplate={canApplyChecklistTemplate} selectedTemplateId={selectedTemplateId} setSelectedTemplateId={setSelectedTemplateId} onApplyTemplate={applySelectedChecklistTemplate} applyingTemplate={applyingTemplate} form={checklistForm} setForm={setChecklistForm} onAdd={addChecklistItem} editingItem={editingChecklistItem} setEditingItem={setEditingChecklistItem} onToggle={toggleChecklistItem} onSave={saveChecklistItem} confirmDelete={item => setConfirm({ title: 'Delete checklist item?', message: 'Delete this checklist item?', onConfirm: () => deleteChecklistItemRecord(item) })} /></Sub>
                  <div id="matter-section-tasks" style={{ minWidth: 0, maxWidth: '100%' }}><Sub title="Tasks"><TaskEditorList tasks={detail.tasks || []} entries={detail.timeEntries || []} matter={detail} canManage={canManage} canViewBilling={canViewBilling} editingTask={editingTask} setEditingTask={setEditingTask} saveTask={saveTask} taskTimer={taskTimer} setTaskTimer={setTaskTimer} notify={notify} onTimerSaved={async () => { await loadDetail(detail.id); await reload(); }} confirmDelete={task => setConfirm({ title: 'Delete task?', message: 'Delete this task?', onConfirm: () => deleteTaskRecord(task) })} /></Sub></div>
                  <div id="matter-section-court" style={{ minWidth: 0, maxWidth: '100%' }}><Sub title="Court appearances">{canManage && <form onSubmit={createEvent} style={{ ...styles.formGrid, marginBottom: 12 }}><Field label="Title"><input required style={styles.input} value={eventForm.title} onChange={e => setEventForm({ ...eventForm, title: e.target.value })} /></Field><Field label="Date"><input required type="date" style={styles.input} value={eventForm.date} onChange={e => setEventForm({ ...eventForm, date: e.target.value })} /></Field><Field label="Time"><input style={styles.input} value={eventForm.time} onChange={e => setEventForm({ ...eventForm, time: e.target.value })} /></Field><Field label="Type"><input style={styles.input} value={eventForm.type} onChange={e => setEventForm({ ...eventForm, type: e.target.value })} /></Field><Field label="Location"><input style={styles.input} value={eventForm.location} onChange={e => setEventForm({ ...eventForm, location: e.target.value })} /></Field><Field label="Meeting Link"><input type="url" placeholder="https://..." style={styles.input} value={eventForm.meetingLink} onChange={e => setEventForm({ ...eventForm, meetingLink: e.target.value })} /></Field><button style={styles.ghostButton}>Schedule event</button></form>}<AppearanceEditorList events={detail.appearances || []} canManage={canManage} editingEvent={editingEvent} setEditingEvent={setEditingEvent} saveEvent={saveEvent} confirmDelete={event => setConfirm({ title: 'Delete appearance?', message: 'Delete this court appearance?', onConfirm: () => deleteEventRecord(event) })} /></Sub></div>
                  <div id="matter-section-documents" style={{ minWidth: 0, maxWidth: '100%' }}><Sub title="Documents"><MatterDocuments matterId={detail.id} canManage={canManage} notify={notify} /></Sub></div>
                  <div id="matter-section-document-requests" style={{ minWidth: 0, maxWidth: '100%' }}><Sub title="Document requests"><DocumentRequestsPanel matterId={detail.id} canManage={canManage} notify={notify} downloadWithAuth={downloadWithAuth} /></Sub></div>
                  <div id="matter-section-notes" style={{ minWidth: 0, maxWidth: '100%' }}><Sub title="Case notes"><form onSubmit={addNote} style={styles.noteForm}><input style={styles.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note" /><button style={styles.ghostButton}>Save note</button></form><div className="lf-matter-notes-cards"><Table columns={['Note', 'Author', 'Created']} rows={(detail.notes || []).map(n => [n.content, n.author || '-', n.createdAt ? new Date(n.createdAt).toLocaleString() : '-'])} empty="No notes yet." /></div></Sub></div>
                  <div id="matter-section-invoices" style={{ minWidth: 0, maxWidth: '100%' }}>
                    <Sub title="Invoices">
                      {canManage && (
                        <div style={{ ...styles.formGrid, marginBottom: 12, alignItems: 'end' }}>
                          <Field label="Default due">
                            <div style={{ ...styles.input, background: '#F9FAFB', color: theme.muted }}>{defaultInvoiceDueDays} days ({formatTimelineDate(defaultInvoiceDueDate)})</div>
                          </Field>
                          <Field label="Due-date override">
                            <input type="date" style={styles.input} value={invoiceDueDateOverride} onChange={e => setInvoiceDueDateOverride(e.target.value)} />
                            <div style={styles.formHelper}>Leave blank to use the firm default.</div>
                          </Field>
                          <button type="button" style={styles.primaryButton} onClick={generateInvoice}>Generate invoice</button>
                        </div>
                      )}
                      <div className="lf-invoice-cards"><Table columns={['Invoice', 'Amount', 'Paid', 'Balance', 'Status', 'PDF', 'Actions']} rows={(detail.invoices || []).map(i => [i.number || i.id, kes(i.amount), kes(i.amountPaid), kes(i.balance), <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <DownloadButton key={`${i.id}-pdf`} label="PDF" path={`/api/invoices/${i.id}/pdf`} filename={`${i.number || i.id}.pdf`} notify={notify} />, canManage && i.status !== 'Paid' ? <ActionGroup key={`${i.id}-actions`} actions={[['Delete', () => setConfirm({ title: 'Delete invoice?', message: 'Delete this invoice?', onConfirm: () => deleteInvoiceRecord(i) })]]} /> : '-'])} empty="No invoices yet." /></div>
                    </Sub>
                  </div>
                </>
              )}
            </div>
          )}
          {!loading && !detail && <Empty title="Select a matter" text="Matter detail will appear here." />}
        </Card>
      </div>
      <ProfileTooltip tooltip={tooltip} />
      <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

export function Tasks({ data, canManage, reload, notify, focus }) {
  const [form, setForm] = useState({ matterId: '', title: '', dueDate: '' });
  const [editingTask, setEditingTask] = useState(null);
  const [confirm, setConfirm] = useState(null);
  // PRODUCT-16H: client-side status filter so completed tasks stop crowding daily work.
  // Display-only over already-loaded data.tasks; defaults to Open. No API/payload/timer change.
  const [taskFilter, setTaskFilter] = useState('open');

  useEffect(() => {
    if (!focus?.taskId) return;
    const el = document.getElementById(`task-${focus.taskId}`);
    if (el) {
      const prev = el.style.background;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.background = 'rgba(212, 163, 74, 0.15)';
      setTimeout(() => { el.style.background = prev; }, 1200);
    }
  }, [focus?.taskId, focus?.ts]);
  // PRODUCT-16H: derived (display-only) overdue follows the existing StaffViews pattern
  // (!completed && dueDate && dueDate < today). data.tasks is never mutated.
  const allTasks = data.tasks || [];
  const filteredTasks = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (taskFilter === 'open') return allTasks.filter(t => !t.completed);
    if (taskFilter === 'overdue') return allTasks.filter(t => !t.completed && t.dueDate && t.dueDate < today);
    if (taskFilter === 'done') return allTasks.filter(t => t.completed);
    return allTasks;
  }, [allTasks, taskFilter]);
  const taskEmpty = {
    all: ['No tasks yet.', 'Once records exist, they will appear here.'],
    open: ['No open tasks', 'All tasks are completed or none are open.'],
    overdue: ['No overdue tasks', 'No incomplete tasks are past their due date.'],
    done: ['No completed tasks', 'Completed tasks will appear here.'],
  }[taskFilter] || ['No tasks yet.', 'Once records exist, they will appear here.'];
  // PRODUCT-17D: frontend-only CSV export of already-loaded, already-filtered task rows.
  function exportTasks() {
    if (!filteredTasks.length) return;
    downloadCsv('lexflow-tasks.csv', ['Task', 'Assignee', 'Due Date', 'Status'], filteredTasks.map(t => [t.title || '', t.assignee || '', t.dueDate || '', t.completed ? 'Done' : 'Open']));
  }
  async function submit(event) { event.preventDefault(); try { await api('/tasks', { method: 'POST', body: form }); setForm({ matterId: '', title: '', dueDate: '' }); notify({ type: 'success', message: 'Task created.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function toggle(task) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: { completed: !task.completed } }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function saveTask(task, values) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: values }); setEditingTask(null); notify({ type: 'success', message: 'Task updated.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteTaskRecord(task) { try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Task deleted.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <div className="lf-split-grid lf-task-split-grid" style={styles.splitGrid}><Card title="New task" hint="Deadline control"><form onSubmit={submit} style={styles.formGrid}><Field label="Matter"><select required style={styles.input} value={form.matterId} onChange={e => setForm({ ...form, matterId: e.target.value })}><option value="">Select matter</option>{data.matters.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></Field><Field label="Task"><input required style={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field><Field label="Due"><input type="date" style={styles.input} value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></Field><button style={styles.primaryButton}>Create task</button></form></Card><Card title="Task board" hint={`${filteredTasks.length} of ${allTasks.length} tasks`}><div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}><select aria-label="Filter tasks by status" value={taskFilter} onChange={e => setTaskFilter(e.target.value)} style={{ ...styles.input, width: 'auto', minWidth: 128 }}><option value="open">Open</option><option value="overdue">Overdue</option><option value="done">Done</option><option value="all">All</option></select><span style={{ fontSize: 12, color: '#697386' }}>Showing {filteredTasks.length} of {allTasks.length} tasks</span><button type="button" style={{ ...styles.ghostButton, fontSize: 12, padding: '6px 12px' }} onClick={exportTasks} disabled={!filteredTasks.length} title="Download the filtered tasks as a CSV file">Export CSV</button></div><TaskEditorList tasks={filteredTasks} canManage={canManage} editingTask={editingTask} setEditingTask={setEditingTask} saveTask={saveTask} toggle={toggle} confirmDelete={task => setConfirm({ title: 'Delete task?', message: 'Delete this task?', onConfirm: () => deleteTaskRecord(task) })} emptyTitle={taskEmpty[0]} emptyText={taskEmpty[1]} /></Card><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></div>;
}

export function Invoices({ invoices, isAdmin, canManage, reload, notify, firmSettings: providedFirmSettings }) {
  const [confirm, setConfirm] = useState(null);
  const [registerFilter, setRegisterFilter] = useState('all');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [invoiceDetails, setInvoiceDetails] = useState(null);
  const [payments, setPayments] = useState([]);
  const [paymentForm, setPaymentForm] = useState({ amount: '', method: 'Bank Transfer', reference: '', date: new Date().toISOString().slice(0, 10), note: '', proofId: '' });
  const [voidDraft, setVoidDraft] = useState(null);
  const [firmSettings, setFirmSettings] = useState({ ...defaultFirmSettings, ...(providedFirmSettings || {}) });
  const [proofs, setProofs] = useState([]);
  const [proofFilter, setProofFilter] = useState('Pending');
  const [pendingProofCount, setPendingProofCount] = useState(0);
  const [proofNotes, setProofNotes] = useState({});
  // PRODUCT-15K: collections action queue needs pending AND rejected proofs at once, independent
  // of the proof-queue's own filter. Loaded once from the SAME existing /payment-proofs route
  // (status=All) — no new route, no API/backend/schema change; the route never returns BLOB content.
  const [collectionsProofs, setCollectionsProofs] = useState([]);
  // PRODUCT-16G: collapse the high-level billing overview by default so the invoice
  // register is the primary work surface sooner. Display-only; no billing logic change.
  const [billingOverviewOpen, setBillingOverviewOpen] = useState(false);
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const session = readSession();
  const canRecordPayment = ['admin', 'assistant'].includes(session?.user?.role);
  const canReviewProof = ['admin', 'assistant'].includes(session?.user?.role);
  const selectedInvoice = invoices.find(invoice => invoice.id === selectedInvoiceId);

  useEffect(() => {
    if (providedFirmSettings) {
      setFirmSettings({ ...defaultFirmSettings, ...providedFirmSettings });
      return;
    }
    let active = true;
    api('/firm-settings')
      .then(settings => { if (active) setFirmSettings({ ...defaultFirmSettings, ...(settings || {}) }); })
      .catch(() => {});
    return () => { active = false; };
  }, [providedFirmSettings]);

  useEffect(() => {
    if (!selectedInvoiceId) {
      setInvoiceDetails(null);
      return;
    }
    async function loadDetails() {
      try {
        const details = await getInvoiceDetails(selectedInvoiceId);
        setInvoiceDetails(details || null);
      } catch (err) {
        setInvoiceDetails(null);
      }
    }
    loadDetails();
  }, [selectedInvoiceId]);
  async function loadProofs() {
    try {
      const data = await api(paymentProofsPath(proofFilter));
      setProofs(Array.isArray(data?.proofs) ? data.proofs : []);
      if (typeof data?.pendingCount === 'number') setPendingProofCount(data.pendingCount);
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    }
  }
  useEffect(() => {
    let active = true;
    api(paymentProofsPath(proofFilter))
      .then(data => { if (!active) return; setProofs(Array.isArray(data?.proofs) ? data.proofs : []); if (typeof data?.pendingCount === 'number') setPendingProofCount(data.pendingCount); })
      .catch(() => {});
    return () => { active = false; };
  }, [proofFilter]);
  // PRODUCT-15K: separate, filter-independent load for the collections queue (pending + rejected).
  async function loadCollectionsProofs() {
    try {
      const data = await api(paymentProofsPath('All'));
      setCollectionsProofs(Array.isArray(data?.proofs) ? data.proofs : []);
    } catch (err) {
      // Non-fatal: queue degrades to invoice-only items if proofs cannot be loaded.
    }
  }
  useEffect(() => {
    let active = true;
    api(paymentProofsPath('All'))
      .then(data => { if (active) setCollectionsProofs(Array.isArray(data?.proofs) ? data.proofs : []); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  // PRODUCT-15K: counts use DERIVED overdue (stored 'Overdue' OR isInvoiceOverdue) so the summary
  // matches the register and Command Summary after PRODUCT-15F. Unpaid is counted directly as
  // non-Paid to avoid double counting; outstanding = unpaid minus overdue. Stored status untouched.
  const invoiceSummary = useMemo(() => {
    const total = invoices.length;
    const paid = invoices.filter(i => i.status === 'Paid').length;
    const unpaid = invoices.filter(i => i.status !== 'Paid').length;
    const overdue = invoices.filter(i => i.status === 'Overdue' || isInvoiceOverdue(i)).length;
    const outstanding = unpaid - overdue;
    return { total, paid, outstanding, overdue, unpaid };
  }, [invoices]);
  // PRODUCT-15K: rank by DERIVED display status so derived-overdue invoices lead, consistent with
  // the register. Stable secondary order by original index. Stored status is never mutated.
  const followUpItems = useMemo(() => {
    const rank = { Overdue: 0, Outstanding: 1 };
    return invoices
      .filter(i => i.status !== 'Paid')
      .map((invoice, index) => ({ invoice, index }))
      .sort((a, b) => {
        const ra = rank[invoiceDisplayStatus(a.invoice)] ?? 2;
        const rb = rank[invoiceDisplayStatus(b.invoice)] ?? 2;
        return ra === rb ? a.index - b.index : ra - rb;
      })
      .map(entry => entry.invoice)
      .slice(0, 5);
  }, [invoices]);
  // PRODUCT-15F: filter the register by display status (derived overdue included),
  // then surface overdue-first for quicker follow-up. Stored status is untouched.
  const registerInvoices = useMemo(() => {
    const matchesFilter = invoice => registerFilter === 'all' || invoiceDisplayStatus(invoice) === registerFilter;
    const rank = { Overdue: 0, Outstanding: 1, Paid: 2 };
    return invoices
      .filter(matchesFilter)
      .map((invoice, index) => ({ invoice, index }))
      .sort((a, b) => {
        const ra = rank[invoiceDisplayStatus(a.invoice)] ?? 3;
        const rb = rank[invoiceDisplayStatus(b.invoice)] ?? 3;
        return ra === rb ? a.index - b.index : ra - rb;
      })
      .map(entry => entry.invoice);
  }, [invoices, registerFilter]);
  // PRODUCT-15K: read-only collections aggregation from data already in the view. Displays only
  // server-provided amount/balance/amountPaid — never recomputes money/VAT and never mutates
  // invoice/proof/payment state. Each unpaid invoice is classified once (overdue wins over partial)
  // so a single invoice never produces two rows.
  const collections = useMemo(() => {
    const items = [];
    invoices.forEach(inv => {
      if (inv.status === 'Paid') return;
      const overdue = inv.status === 'Overdue' || isInvoiceOverdue(inv);
      const amountPaid = Number(inv.amountPaid || 0);
      const balance = Number(inv.balance || 0);
      const partial = amountPaid > 0 && balance > 0;
      if (overdue) items.push({ key: `ov-${inv.id}`, kind: 'overdue', priority: 0, invoice: inv });
      else if (partial) items.push({ key: `pt-${inv.id}`, kind: 'partial', priority: 1, invoice: inv });
    });
    collectionsProofs.forEach(proof => {
      if (proof.status === 'Pending') items.push({ key: `pp-${proof.id}`, kind: 'pending-proof', priority: 2, proof });
      else if (proof.status === 'Rejected') items.push({ key: `rp-${proof.id}`, kind: 'rejected-proof', priority: 3, proof });
    });
    items.sort((a, b) => a.priority - b.priority);
    const counts = {
      overdue: items.filter(i => i.kind === 'overdue').length,
      partial: items.filter(i => i.kind === 'partial').length,
      pendingProof: items.filter(i => i.kind === 'pending-proof').length,
      rejectedProof: items.filter(i => i.kind === 'rejected-proof').length,
    };
    return { items, counts, total: items.length };
  }, [invoices, collectionsProofs]);
  // PRODUCT-17F: read-only receivables aging. Buckets unpaid invoices by days overdue using the
  // existing invoiceDueDistanceDays helper and sums server-provided balance only — never recomputes
  // amount/VAT/payments. Billing-masked rows (balance === null for advocates without billing
  // visibility) are excluded from money totals and counted separately as `hidden`.
  const receivablesAging = useMemo(() => {
    const order = ['Current', '1-30', '31-60', '61-90', '90+'];
    const buckets = Object.fromEntries(order.map(label => [label, { label, count: 0, total: 0 }]));
    let grandTotal = 0;
    let hidden = 0;
    invoices.forEach(inv => {
      if (inv.status === 'Paid') return;
      if (inv.balance == null) { hidden += 1; return; }
      const days = invoiceDueDistanceDays(inv);
      let key;
      if (days === null || days >= 0) key = 'Current';
      else if (days >= -30) key = '1-30';
      else if (days >= -60) key = '31-60';
      else if (days >= -90) key = '61-90';
      else key = '90+';
      const balance = Number(inv.balance || 0);
      buckets[key].count += 1;
      buckets[key].total += balance;
      grandTotal += balance;
    });
    const rows = order.map(label => buckets[label]);
    const visibleCount = rows.reduce((sum, b) => sum + b.count, 0);
    return { rows, grandTotal, hidden, visibleCount };
  }, [invoices]);
  // PRODUCT-15K: navigation/assist only — preselect a local filter and scroll to the existing
  // surface. No data is created or mutated here.
  function goToInvoiceRegister(filterValue) {
    if (filterValue) setRegisterFilter(filterValue);
    scrollToSection('invoice-register');
  }
  function goToProofQueue(filterValue) {
    if (filterValue) setProofFilter(filterValue);
    scrollToSection('payment-proof-queue');
  }
  async function setStatus(id, status) { try { await api(`/invoices/${id}/status`, { method: 'PATCH', body: { status } }); notify({ type: 'success', message: 'Invoice updated.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  function confirmStatusChange(invoice, nextStatus) {
    if (!nextStatus || nextStatus === invoice.status) return;
    const paidNote = nextStatus === 'Paid' ? ' This does not record a payment or change the payment-derived balance.' : '';
    setConfirm({
      title: 'Change invoice status?',
      message: `Change invoice ${invoiceLabel(invoice)} status from ${invoice.status} to ${nextStatus}? This status is visible in the client portal.${paidNote}`,
      onConfirm: () => setStatus(invoice.id, nextStatus),
    });
  }
  async function deleteInvoiceRecord(invoice) { try { await api(`/invoices/${invoice.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Invoice deleted.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function openPayments(invoice) {
    try {
      setSelectedInvoiceId(invoice.id);
      const data = await listInvoicePayments(invoice.id);
      setPayments(data.payments || []);
      setPaymentForm(form => ({ ...form, amount: invoice.balance ? String(invoice.balance) : '', date: new Date().toISOString().slice(0, 10), proofId: '' }));
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    }
  }
  async function submitPayment(event) {
    event.preventDefault();
    if (!selectedInvoice) return;
    try {
      const data = await recordInvoicePayment(selectedInvoice.id, paymentForm);
      notify({ type: 'success', message: 'Payment recorded.' });
      setPayments(current => [data.payment, ...current]);
      const settledProof = paymentForm.proofId;
      setPaymentForm({ amount: '', method: 'Bank Transfer', reference: '', date: new Date().toISOString().slice(0, 10), note: '', proofId: '' });
      await reload();
      // Refresh the proof queue so a proof that was just settled shows its linked payment.
      if (settledProof) await loadProofs();
      // PRODUCT-15K: keep the collections queue counts/items in step after a payment.
      await loadCollectionsProofs();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    }
  }
  async function submitVoidPayment(event) {
    event.preventDefault();
    if (!selectedInvoice || !voidDraft?.payment) return;
    const reason = String(voidDraft.reason || '').trim();
    if (!reason) { notify({ type: 'danger', message: 'Void reason is required.' }); return; }
    try {
      setVoidDraft(current => current ? { ...current, busy: true } : current);
      await api(`/invoices/${selectedInvoice.id}/payments/${voidDraft.payment.id}/void`, { method: 'POST', body: { reason } });
      const data = await listInvoicePayments(selectedInvoice.id);
      setPayments(data.payments || []);
      if (data.invoice) setInvoiceDetails(data.invoice);
      setVoidDraft(null);
      notify({ type: 'success', message: 'Payment voided.' });
      await reload();
      await loadProofs();
      await loadCollectionsProofs();
    } catch (err) {
      setVoidDraft(current => current ? { ...current, busy: false } : current);
      notify({ type: 'danger', message: err.message });
    }
  }
  // PRODUCT-15I: review-only decision; never creates a payment or mutates the invoice.
  async function reviewProof(proof, status) {
    try {
      await api(`/payment-proofs/${proof.id}/review`, { method: 'PATCH', body: { status, reviewNote: proofNotes[proof.id] || '' } });
      notify({ type: 'success', message: `Payment proof ${status.toLowerCase()}.` });
      setProofNotes(current => { const next = { ...current }; delete next[proof.id]; return next; });
      await loadProofs();
      await loadCollectionsProofs();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    }
  }
  async function downloadProof(proof) {
    try {
      await downloadWithAuth(`/api/payment-proofs/${proof.id}/attachment`, proof.fileName || `payment-proof-${proof.id}`);
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    }
  }
  // PRODUCT-15I: pre-fill the EXISTING manual record-payment flow from an accepted proof.
  // Staff still confirm amount/date/method/reference; backend enforces amount <= balance.
  function recordPaymentFromProof(proof) {
    if (!proof.invoiceId) { notify({ type: 'danger', message: 'This proof is not linked to an invoice. Open the invoice and record payment manually.' }); return; }
    const invoice = invoices.find(i => i.id === proof.invoiceId);
    if (!invoice) { notify({ type: 'danger', message: 'Invoice not found for this proof.' }); return; }
    setSelectedInvoiceId(invoice.id);
    listInvoicePayments(invoice.id)
      .then(data => setPayments(data.payments || []))
      .catch(err => notify({ type: 'danger', message: err.message }));
    const balance = Number(invoice.balance || 0);
    const proofAmount = Number(proof.amount || 0);
    const suggested = proofAmount > 0 && proofAmount <= balance ? String(proofAmount) : (balance ? String(balance) : '');
    setPaymentForm({ amount: suggested, method: proof.method || 'Bank Transfer', reference: proof.reference || '', date: new Date().toISOString().slice(0, 10), note: '', proofId: proof.id });
    notify({ type: 'info', message: 'Review the pre-filled payment details below, then confirm to record.' });
    scrollToSection('invoice-register');
  }

  function invoiceLabel(invoice) {
    return invoice.number || invoice.id;
  }

  function renderInvoiceStatus(invoice) {
    const distance = invoiceDueDistanceText(invoice);
    const overdue = isInvoiceOverdue(invoice);
    if (isAdmin) {
      return (
        <div style={{ display: 'grid', gap: 3 }}>
          <select
            aria-label={`Stored status for invoice ${invoiceLabel(invoice)}`}
            style={styles.tableSelect}
            value={invoice.status}
            onChange={e => confirmStatusChange(invoice, e.target.value)}
          >
            <option>Outstanding</option>
            <option>Paid</option>
            <option>Overdue</option>
          </select>
          {overdue && invoice.status !== 'Overdue' ? <Badge tone="red">Overdue</Badge> : null}
          {distance ? <span style={{ fontSize: 11, color: overdue ? '#991B1B' : '#697386' }}>{distance}</span> : null}
        </div>
      );
    }
    return (
      <div style={{ display: 'grid', gap: 3 }}>
        <Badge tone={statusTone(invoiceDisplayStatus(invoice))}>{invoiceDisplayStatus(invoice)}</Badge>
        {distance ? <span style={{ fontSize: 11, color: overdue ? '#991B1B' : '#697386' }}>{distance}</span> : null}
      </div>
    );
  }

  function invoiceActions(invoice) {
    return [
      ['Payments', () => openPayments(invoice)],
      ...(canManage && invoice.status !== 'Paid' ? [['Delete', () => setConfirm({ title: 'Delete invoice?', message: 'Delete this invoice?', onConfirm: () => deleteInvoiceRecord(invoice) })]] : []),
    ];
  }

  function renderPaymentStatus(payment) {
    return payment.voided
      ? <div style={{ display: 'grid', gap: 3 }}><Badge tone="red">Voided</Badge>{payment.voidReason ? <span style={{ fontSize: 11, color: '#697386' }}>{payment.voidReason}</span> : null}</div>
      : <Badge tone="green">Active</Badge>;
  }

  function renderPaymentReceipt(payment) {
    if (payment.voided) {
      return (
        <div style={{ display: 'grid', gap: 3 }}>
          <Badge tone="red">Voided</Badge>
          <span style={{ fontSize: 11, color: '#697386' }}>Receipt not downloadable as a valid receipt.</span>
        </div>
      );
    }
    return payment.receiptNumber
      ? <DownloadButton label="Download" ariaLabel={`Download receipt ${payment.receiptNumber}`} path={`/api/invoices/${selectedInvoice.id}/payments/${payment.id}/receipt.pdf`} filename={`${payment.receiptNumber}.pdf`} notify={notify} />
      : '-';
  }

  function renderPaymentActions(payment) {
    return isAdmin && !payment.voided
      ? <ActionGroup actions={[['Void payment', () => setVoidDraft({ payment, reason: '', busy: false })]]} />
      : '-';
  }

  function InvoicePreviewCard() {
    if (!selectedInvoice) return null;
    const detail = invoiceDetails || selectedInvoice;
    const subtotal = Number(detail.amount || 0);
    const vatRate = 0.16;
    const vat = subtotal * vatRate;
    const total = subtotal + vat;
    const items = Array.isArray(detail.items) ? detail.items : [];
    const dueDistance = detail.dueDate ? daysFromToday(detail.dueDate) : null;
    const paymentTerms = detail.dueDate ? `Payment due by ${new Date(detail.dueDate).toLocaleDateString('en-KE')}${dueDistance !== null ? ` (${formatDayDistance(dueDistance)})` : ''}.` : 'Payment due date not recorded.';
    const billingFields = [
      firmSettings.kraPin ? ['KRA PIN', firmSettings.kraPin] : null,
      firmSettings.vatNumber ? ['VAT registration number', firmSettings.vatNumber] : null,
      firmSettings.paymentInstructions ? ['Payment instructions', firmSettings.paymentInstructions] : null,
      firmSettings.invoiceFooterNote ? ['Invoice footer note / payment terms', firmSettings.invoiceFooterNote] : null,
    ].filter(Boolean);
    return (
      <div style={{ marginBottom: 16, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: '#111827', margin: 0 }}>Invoice Preview</h3>
            <span style={{ fontSize: 11, color: '#697386', fontStyle: 'italic' }}>Read-only preview before PDF download</span>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#697386', fontWeight: 500, marginBottom: 2 }}>Invoice Number</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{detail.number || detail.id}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#697386', fontWeight: 500, marginBottom: 2 }}>Client</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{detail.clientName || '-'}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#697386', fontWeight: 500, marginBottom: 2 }}>Matter</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{detail.matterTitle || '-'}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#697386', fontWeight: 500, marginBottom: 2 }}>Invoice Date</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{detail.date ? new Date(detail.date).toLocaleDateString('en-KE') : '-'}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#697386', fontWeight: 500, marginBottom: 2 }}>Due Date</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{detail.dueDate ? new Date(detail.dueDate).toLocaleDateString('en-KE') : '-'}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#697386', fontWeight: 500, marginBottom: 2 }}>Payment Terms</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: dueDistance !== null && dueDistance < 0 && detail.status !== 'Paid' ? '#991B1B' : '#111827' }}>{paymentTerms}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#697386', fontWeight: 500, marginBottom: 2 }}>Status</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}><Badge tone={statusTone(detail.status)}>{detail.status}</Badge></div>
          </div>
        </div>
        {detail.source && (
          <div style={{ fontSize: 12, color: '#697386', marginBottom: 12 }}>
            <span style={{ fontWeight: 500 }}>Source:</span> {detail.source}
          </div>
        )}
        {items.length > 0 ? (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#111827', marginBottom: 8 }}>Line Items</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #E5E7EB' }}>
                  <th style={{ textAlign: 'left', padding: '8px 0', color: '#697386', fontWeight: 500, fontSize: 11 }}>Date</th>
                  <th style={{ textAlign: 'left', padding: '8px 0', color: '#697386', fontWeight: 500, fontSize: 11 }}>Description</th>
                  <th style={{ textAlign: 'right', padding: '8px 0', color: '#697386', fontWeight: 500, fontSize: 11 }}>Hours</th>
                  <th style={{ textAlign: 'right', padding: '8px 0', color: '#697386', fontWeight: 500, fontSize: 11 }}>Rate</th>
                  <th style={{ textAlign: 'right', padding: '8px 0', color: '#697386', fontWeight: 500, fontSize: 11 }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid #F3F4F6' }}>
                    <td style={{ padding: '8px 0', color: '#111827' }}>{item.date ? new Date(item.date).toLocaleDateString('en-KE') : '-'}</td>
                    <td style={{ padding: '8px 0', color: '#111827' }}>{item.description || '-'}</td>
                    <td style={{ textAlign: 'right', padding: '8px 0', color: '#111827' }}>{item.hours ? Number(item.hours).toFixed(1) : '-'}</td>
                    <td style={{ textAlign: 'right', padding: '8px 0', color: '#111827' }}>{item.rate ? kes(item.rate) : '-'}</td>
                    <td style={{ textAlign: 'right', padding: '8px 0', color: '#111827', fontWeight: 500 }}>{item.amount ? kes(item.amount) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#697386', fontStyle: 'italic', marginBottom: 12, padding: 8, background: '#F9FAFB', borderRadius: 4 }}>
            Line items are not available in this preview yet. The PDF download remains the source for the current invoice layout.
          </div>
        )}
        {billingFields.length > 0 && (
          <div style={{ marginBottom: 12, padding: 12, border: '1px solid #E5E7EB', borderRadius: 8, background: '#F9FAFB' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#111827', marginBottom: 8 }}>Firm billing & footer details</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {billingFields.map(([label, value]) => (
                <div key={label} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) 1fr', gap: 10, fontSize: 12 }}>
                  <div style={{ color: '#697386', fontWeight: 500 }}>{label}</div>
                  <div style={{ color: '#111827', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{value}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ borderTop: '1px solid #E5E7EB', paddingTop: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 8 }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: '#697386' }}>Subtotal</div>
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111827', minWidth: 100, textAlign: 'right' }}>{kes(subtotal)}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 8 }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: '#697386' }}>VAT (16%)</div>
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111827', minWidth: 100, textAlign: 'right' }}>{kes(vat)}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, paddingTop: 8, borderTop: '1px solid #E5E7EB', marginBottom: 12 }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Total</div>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', minWidth: 100, textAlign: 'right' }}>{kes(total)}</div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: '#697386', fontStyle: 'italic', padding: 8, background: '#F0FDF4', borderLeft: '3px solid #16A34A', marginBottom: 12 }}>
          Preview only — does not change the saved invoice.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <DownloadButton label="Download PDF" path={`/api/invoices/${selectedInvoice.id}/pdf`} filename={`${selectedInvoice.number || selectedInvoice.id}.pdf`} notify={notify} />
        </div>
      </div>
    );
  }

  // PRODUCT-17C: export exactly the filtered invoice register rows the user is viewing
  function exportInvoices() {
    if (!registerInvoices.length) return;
    downloadCsv('lexflow-invoices.csv', ['Invoice', 'Client', 'Matter', 'Invoice Date', 'Due Date', 'Amount', 'Amount Paid', 'Balance', 'Status'], registerInvoices.map(i => [invoiceLabel(i), i.clientName || '', i.matterTitle || '', i.date || '', i.dueDate || '', i.amount ?? '', i.amountPaid ?? '', i.balance ?? '', invoiceDisplayStatus(i)]));
  }
  return <>
    <style>{billingMobilePolishCss}</style>
    <section aria-label="Billing overview" style={{ marginBottom: 16, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconCash size={16} stroke={1.75} style={{ color: '#697386' }} />
          <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>Billing overview</span>
        </div>
        <button type="button" aria-expanded={billingOverviewOpen} onClick={() => setBillingOverviewOpen(open => !open)} style={{ ...styles.ghostButton, fontSize: 12, padding: '4px 10px' }}>{billingOverviewOpen ? 'Hide' : 'Show'}</button>
      </div>
      <p style={{ fontSize: 12, color: '#697386', margin: '6px 0 0' }}>Summary, unpaid follow-up and quick billing totals.</p>
      {billingOverviewOpen && (<>
    <div style={{ marginBottom: 16, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconCash size={16} stroke={1.75} style={{ color: '#697386' }} />
        <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>Billing workflow</span>
      </div>
      {invoiceSummary.total === 0 ? (
        <p style={{ fontSize: 12, color: '#697386', margin: '8px 0 0', fontStyle: 'italic' }}>Invoice activity will appear here when available.</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
            <div style={{ flex: '1 1 80px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#111827' }}>{invoiceSummary.total}</div>
              <div style={{ fontSize: 11, color: '#697386', marginTop: 1 }}>Total invoices</div>
            </div>
            <div style={{ flex: '1 1 80px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: invoiceSummary.unpaid > 0 ? '#991B1B' : '#111827' }}>{invoiceSummary.unpaid}</div>
              <div style={{ fontSize: 11, color: '#697386', marginTop: 1 }}>Unpaid</div>
            </div>
            <div style={{ flex: '1 1 80px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#111827' }}>{invoiceSummary.paid}</div>
              <div style={{ fontSize: 11, color: '#697386', marginTop: 1 }}>Paid</div>
            </div>
          </div>
          <p style={{ fontSize: 12, color: '#697386', margin: '8px 0 0' }}>
            {invoiceSummary.unpaid > 0 ? 'Review unpaid invoices first.' : 'All visible invoices are settled.'}
          </p>
          <button type="button" style={{ ...styles.ghostButton, marginTop: 10 }} onClick={() => scrollToSection('invoice-register')}>
            View invoice register
          </button>
        </>
      )}
        </div>
    <div style={{ marginBottom: 16, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconAlertCircle size={16} stroke={1.75} style={{ color: '#697386' }} />
        <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>Billing follow-up</span>
      </div>
      {followUpItems.length === 0 ? (
        <p style={{ fontSize: 12, color: '#697386', margin: '8px 0 0', fontStyle: 'italic' }}>No invoices currently need follow-up.</p>
      ) : (
        <>
          <div style={{ marginTop: 10 }}>
            {followUpItems.map((invoice, idx) => {
              const days = invoice.dueDate ? daysFromToday(invoice.dueDate) : null;
              return (
                <div key={invoice.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 0', borderBottom: idx < followUpItems.length - 1 ? '1px solid #F3F4F6' : 'none', fontSize: 13 }}>
                  <span style={{ fontWeight: 500, color: '#111827', whiteSpace: 'nowrap' }}>{invoice.number || invoice.id}</span>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#697386', flex: '1 1 80px' }}>{invoice.matterTitle || invoice.clientName || ''}</span>
                  <Badge tone={statusTone(invoiceDisplayStatus(invoice))}>{invoiceDisplayStatus(invoice)}</Badge>
                  {days !== null && (
                    <span style={{ fontSize: 11, color: days < 0 ? '#991B1B' : '#697386', whiteSpace: 'nowrap' }}>{formatDayDistance(days)}</span>
                  )}
                  <span style={{ fontWeight: 500, color: '#111827', whiteSpace: 'nowrap' }}>{kes(invoice.amount)}</span>
                </div>
              );
            })}
          </div>
          <p style={{ fontSize: 12, color: '#697386', margin: '8px 0 0' }}>
            {followUpItems.some(i => i.status === 'Overdue' || isInvoiceOverdue(i)) ? 'Start with overdue invoices.' : `${followUpItems.length} unpaid invoice${followUpItems.length === 1 ? '' : 's'} need follow-up.`}
          </p>
          <button type="button" style={{ ...styles.ghostButton, marginTop: 10 }} onClick={() => scrollToSection('invoice-register')}>
            View invoice register
          </button>
        </>
      )}
    </div>
      </>)}
    </section>
    <div style={{ marginBottom: 16, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconAlertCircle size={16} stroke={1.75} style={{ color: '#697386' }} />
          <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>Collections action queue</span>
        </div>
        {collections.total > 0 && (
          <button type="button" aria-expanded={collectionsOpen} onClick={() => setCollectionsOpen(open => !open)} style={{ ...styles.ghostButton, fontSize: 12, padding: '4px 10px' }}>
            {collectionsOpen ? 'Hide' : `Show (${collections.total})`}
          </button>
        )}
      </div>
      {collections.total === 0 ? (
        <p style={{ fontSize: 12, color: '#697386', margin: '8px 0 0', fontStyle: 'italic' }}>No overdue invoices, partial payments, or proofs awaiting action.</p>
      ) : collectionsOpen ? (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {[['Overdue invoices', collections.counts.overdue, '#991B1B'], ['Partial payments', collections.counts.partial, '#92400E'], ['Pending proofs', collections.counts.pendingProof, '#92400E'], ['Rejected proofs', collections.counts.rejectedProof, '#991B1B']].map(([label, value, color]) => (
              <div key={label} style={{ flex: '1 1 90px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: value > 0 ? color : '#111827' }}>{value}</div>
                <div style={{ fontSize: 11, color: '#697386', marginTop: 1 }}>{label}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            {collections.items.slice(0, 8).map((item, idx, arr) => {
              const isInvoice = item.kind === 'overdue' || item.kind === 'partial';
              const inv = item.invoice;
              const proof = item.proof;
              const typeLabel = item.kind === 'overdue' ? 'Overdue invoice' : item.kind === 'partial' ? 'Partial payment' : item.kind === 'pending-proof' ? 'Pending proof' : 'Rejected proof';
              const number = isInvoice ? (inv.number || inv.id) : (proof.invoiceNumber || (proof.invoiceId ? proof.invoiceId : 'General payment'));
              const who = isInvoice ? (inv.matterTitle || inv.clientName || '') : (proof.clientName || proof.matterTitle || '');
              // Display server-provided figures only — no recomputation of money or VAT.
              const amountText = isInvoice ? `${kes(inv.balance)} due` : kes(proof.amount);
              const subText = item.kind === 'overdue' ? invoiceDueDistanceText(inv)
                : item.kind === 'partial' ? `Paid ${kes(inv.amountPaid)} of ${kes(inv.amount)}`
                : proof.createdAt ? `Uploaded ${new Date(proof.createdAt).toLocaleDateString('en-KE')}` : '';
              const badge = isInvoice
                ? <Badge tone={statusTone(invoiceDisplayStatus(inv))}>{invoiceDisplayStatus(inv)}</Badge>
                : <Badge tone={proofStatusTone(proof.status)}>{proof.status}</Badge>;
              const action = item.kind === 'overdue' ? ['Record payment / follow up', () => goToInvoiceRegister('Overdue')]
                : item.kind === 'partial' ? ['Follow up balance', () => goToInvoiceRegister('Outstanding')]
                : item.kind === 'pending-proof' ? ['Review proof', () => goToProofQueue('Pending')]
                : ['Await corrected proof / re-review', () => goToProofQueue('Rejected')];
              return (
                <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 0', borderBottom: idx < arr.length - 1 ? '1px solid #F3F4F6' : 'none', fontSize: 13 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#697386', flex: '0 0 auto', minWidth: 90 }}>{typeLabel}</span>
                  <span style={{ fontWeight: 500, color: '#111827', whiteSpace: 'nowrap' }}>{number}</span>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#697386', flex: '1 1 80px' }}>{who}</span>
                  {badge}
                  <span style={{ fontWeight: 500, color: '#111827', whiteSpace: 'nowrap' }}>{amountText}</span>
                  {subText ? <span style={{ fontSize: 11, color: item.kind === 'overdue' ? '#991B1B' : '#697386', whiteSpace: 'nowrap' }}>{subText}</span> : null}
                  <button type="button" style={{ ...styles.ghostButton, fontSize: 12, padding: '4px 10px', whiteSpace: 'nowrap' }} onClick={action[1]}>{action[0]}</button>
                </div>
              );
            })}
          </div>
          {collections.total > 8 && (
            <p style={{ fontSize: 11, color: '#697386', margin: '8px 0 0' }}>Showing 8 of {collections.total}. Use the invoice register and payment proof queue below for the full list.</p>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <button type="button" style={styles.ghostButton} onClick={() => goToInvoiceRegister('Overdue')}>View invoice register</button>
            <button type="button" style={styles.ghostButton} onClick={() => goToProofQueue('Pending')}>View payment proof queue</button>
          </div>
        </>
      ) : null}
    </div>
    <div style={{ marginBottom: 16, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconCash size={16} stroke={1.75} style={{ color: '#697386' }} />
        <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>Receivables aging</span>
      </div>
      {receivablesAging.visibleCount === 0 && receivablesAging.hidden === 0 ? (
        <p style={{ fontSize: 12, color: '#697386', margin: '8px 0 0', fontStyle: 'italic' }}>No unpaid receivables to age.</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {receivablesAging.rows.map(bucket => (
              <div key={bucket.label} style={{ flex: '1 1 90px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#697386' }}>{bucket.label}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: bucket.count > 0 && bucket.label !== 'Current' ? '#991B1B' : '#111827', marginTop: 1 }}>{kes(bucket.total)}</div>
                <div style={{ fontSize: 11, color: '#697386', marginTop: 1 }}>{bucket.count} invoice{bucket.count === 1 ? '' : 's'}</div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: '#697386', margin: '10px 0 0' }}>
            Total outstanding (visible): <span style={{ fontWeight: 600, color: '#111827' }}>{kes(receivablesAging.grandTotal)}</span>
          </p>
          {receivablesAging.hidden > 0 && (
            <p style={{ fontSize: 11, color: '#697386', margin: '6px 0 0', fontStyle: 'italic' }}>Some amounts are hidden by billing visibility settings.</p>
          )}
        </>
      )}
    </div>
    <InvoicePreviewCard />
    <div id="invoice-register">
      <Card title="Invoice register" hint="Receivables">
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <label htmlFor="invoice-register-filter" style={{ fontSize: 12, color: '#697386' }}>Filter</label>
          <select id="invoice-register-filter" style={styles.tableSelect} value={registerFilter} onChange={e => setRegisterFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="Outstanding">Outstanding</option>
            <option value="Overdue">Overdue</option>
            <option value="Paid">Paid</option>
          </select>
          <span style={{ fontSize: 12, color: '#697386' }}>{registerInvoices.length} of {invoices.length}</span>
          <button type="button" style={{ ...styles.ghostButton, fontSize: 12, padding: '6px 12px' }} onClick={exportInvoices} disabled={!registerInvoices.length} title="Download the filtered invoices as a CSV file">Export CSV</button>
        </div>
        <div className="lf-invoice-cards">
          <Table
            columns={['Invoice', 'Client', 'Matter', 'Amount', 'Paid', 'Balance', 'Status', 'PDF', 'Actions']}
            rows={registerInvoices.map(i => [
              invoiceLabel(i),
              i.clientName || '-',
              i.matterTitle || '-',
              kes(i.amount),
              kes(i.amountPaid),
              kes(i.balance),
              renderInvoiceStatus(i),
              <DownloadButton key={`${i.id}-pdf`} label="Download" ariaLabel={`Download invoice ${invoiceLabel(i)} PDF`} path={`/api/invoices/${i.id}/pdf`} filename={`${invoiceLabel(i)}.pdf`} notify={notify} />,
              <ActionGroup key={`${i.id}-actions`} actions={invoiceActions(i)} />
            ])}
            empty={invoices.length === 0 ? 'No invoices yet.' : 'No invoices match this filter.'}
          />
        </div>
        {selectedInvoice && (
          <div style={{ ...styles.pageStack, marginTop: 16 }}>
            <Sub title={`Payments - ${selectedInvoice.number || selectedInvoice.id}`}>
              <div className="ux2-mobile-stack" aria-label={`Payments for invoice ${invoiceLabel(selectedInvoice)}`}>
                {payments.length ? payments.map(payment => (
                  <article key={`payment-mobile-${payment.id}`} className="ux2-mobile-card">
                    <div className="ux2-mobile-head">
                      <div>
                        <div className="ux2-mobile-title">{payment.receiptNumber || payment.id}</div>
                        <div className="ux2-mobile-subtitle">{payment.date || '-'}</div>
                      </div>
                      {renderPaymentStatus(payment)}
                    </div>
                    <div className="ux2-mobile-kv">
                      <MobileField label="Amount">{kes(payment.amount)}</MobileField>
                      <MobileField label="Method">{payment.method || '-'}</MobileField>
                      <MobileField label="Reference" wide>{payment.reference || '-'}</MobileField>
                      <MobileField label="Receipt PDF" wide>{renderPaymentReceipt(payment)}</MobileField>
                    </div>
                    {isAdmin && !payment.voided ? <div className="ux2-mobile-actions">{renderPaymentActions(payment)}</div> : null}
                  </article>
                )) : <MobileEmpty>No payments recorded yet.</MobileEmpty>}
              </div>
              <div className="lf-payment-cards ux2-desktop-table">
                <Table
                  columns={['Date', 'Receipt', 'Method', 'Reference', 'Amount', 'Status', 'Receipt PDF', 'Actions']}
                  rows={payments.map(payment => [
                    payment.date || '-',
                    payment.receiptNumber || '-',
                    payment.method || '-',
                    payment.reference || '-',
                    kes(payment.amount),
                    renderPaymentStatus(payment),
                    renderPaymentReceipt(payment),
                    renderPaymentActions(payment)
                  ])}
                  empty="No payments recorded yet."
                />
              </div>
              {canRecordPayment && Number(selectedInvoice.balance || 0) > 0 && (
                <>
                {paymentForm.proofId && (
                  <div style={{ marginTop: 12, padding: '8px 10px', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 6, fontSize: 12, color: '#1E3A8A', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span>Recording against payment proof — review the details below, then confirm.</span>
                    <button type="button" style={{ ...styles.link, border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }} onClick={() => setPaymentForm({ ...paymentForm, proofId: '' })}>Clear link</button>
                  </div>
                )}
                <form onSubmit={submitPayment} style={{ ...styles.formGrid, marginTop: 12 }}>
                  <Field label="Amount"><input required type="number" min="0.01" step="0.01" style={styles.input} value={paymentForm.amount} onChange={e => setPaymentForm({ ...paymentForm, amount: e.target.value })} /></Field>
                  <Field label="Method"><select style={styles.input} value={paymentForm.method} onChange={e => setPaymentForm({ ...paymentForm, method: e.target.value })}><option>Bank Transfer</option><option>M-PESA</option><option>Cash Deposit</option><option>Cheque</option></select></Field>
                  <Field label="Reference"><input style={styles.input} value={paymentForm.reference} onChange={e => setPaymentForm({ ...paymentForm, reference: e.target.value })} /></Field>
                  <Field label="Date"><input required type="date" style={styles.input} value={paymentForm.date} onChange={e => setPaymentForm({ ...paymentForm, date: e.target.value })} /></Field>
                  <Field label="Note"><input style={styles.input} value={paymentForm.note} onChange={e => setPaymentForm({ ...paymentForm, note: e.target.value })} /></Field>
                  <button style={styles.primaryButton}>Record payment</button>
                </form>
                </>
              )}
            </Sub>
          </div>
        )}
      </Card>
    </div>
    <PaymentProofQueue
      proofs={proofs}
      proofFilter={proofFilter}
      setProofFilter={setProofFilter}
      pendingProofCount={pendingProofCount}
      proofNotes={proofNotes}
      setProofNotes={setProofNotes}
      canReviewProof={canReviewProof}
      canRecordPayment={canRecordPayment}
      onDownload={downloadProof}
      onReview={reviewProof}
      onRecordPayment={recordPaymentFromProof}
      notify={notify}
    />
    {voidDraft && (
      <div style={styles.modalBackdrop} role="dialog" aria-modal="true" aria-labelledby="payment-void-title" aria-describedby="payment-void-helper">
        <div style={styles.modalCard}>
          <div style={styles.modalHead}>
            <h2 id="payment-void-title">Void payment?</h2>
            <button type="button" aria-label="Close" onClick={() => setVoidDraft(null)} style={styles.toastClose}>x</button>
          </div>
          <form onSubmit={submitVoidPayment} style={{ display: 'grid', gap: 12 }}>
            <p style={{ margin: 0, color: '#374151' }}>{voidDraft.payment.receiptNumber || voidDraft.payment.id} / {kes(voidDraft.payment.amount)}</p>
            <div id="payment-void-helper" style={{ border: '1px solid #FECACA', borderRadius: 8, background: '#FEF2F2', padding: '10px 12px', color: '#7F1D1D', fontSize: 12, lineHeight: 1.45 }}>
              <strong style={{ display: 'block', marginBottom: 4 }}>This payment stays in the audit trail, but it will no longer count as an active payment.</strong>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>Active totals will exclude it.</li>
                <li>The receipt will no longer download as a normal valid receipt.</li>
                <li>The invoice balance and displayed status will be recalculated.</li>
              </ul>
            </div>
            <Field label="Reason"><textarea required aria-label={`Void reason for payment ${voidDraft.payment.receiptNumber || voidDraft.payment.id}`} maxLength={500} style={{ ...styles.input, minHeight: 92, resize: 'vertical' }} value={voidDraft.reason} onChange={e => setVoidDraft(current => current ? { ...current, reason: e.target.value } : current)} /></Field>
            <div style={styles.modalActions}>
              <button type="button" style={styles.ghostButton} onClick={() => setVoidDraft(null)} disabled={voidDraft.busy}>Cancel</button>
              <button type="submit" style={styles.dangerButton} disabled={voidDraft.busy || !String(voidDraft.reason || '').trim()}>{voidDraft.busy ? 'Voiding...' : 'Void payment'}</button>
            </div>
          </form>
        </div>
      </div>
    )}
    <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
  </>;
}

function proofStatusTone(status) {
  if (status === 'Accepted') return 'green';
  if (status === 'Rejected') return 'red';
  return 'amber';
}

// PRODUCT-15I: staff/admin payment-proof review queue. Review is decision-only (no settlement);
// "Record payment" routes into the existing manual record-payment flow above.
function PaymentProofQueue({ proofs, proofFilter, setProofFilter, pendingProofCount, proofNotes, setProofNotes, canReviewProof, canRecordPayment, onDownload, onReview, onRecordPayment }) {
  function proofLabel(proof) {
    return [proof.invoiceNumber || (proof.invoiceId ? proof.invoiceId : 'General payment'), proof.reference].filter(Boolean).join(' / ');
  }

  function renderProofActions(proof) {
    const actions = [];
    const label = proofLabel(proof);
    if (proof.hasAttachment) {
      actions.push(
        <button key={`${proof.id}-dl`} type="button" aria-label={`Download attachment for payment proof ${label}`} style={{ ...styles.link, border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }} onClick={() => onDownload(proof)}>Download</button>
      );
    }
    if (canReviewProof && proof.status === 'Pending') {
      actions.push(
        <button key={`${proof.id}-acc`} type="button" aria-label={`Accept payment proof ${label}`} style={{ ...styles.ghostButton, padding: '4px 10px' }} onClick={() => onReview(proof, 'Accepted')}>Accept</button>,
        <button key={`${proof.id}-rej`} type="button" aria-label={`Reject payment proof ${label}`} style={{ ...styles.ghostButton, padding: '4px 10px', color: '#991B1B', borderColor: '#FCA5A5' }} onClick={() => onReview(proof, 'Rejected')}>Reject</button>
      );
    }
    if (canRecordPayment && proof.status === 'Accepted' && proof.invoiceId && Number(proof.invoiceBalance || 0) > 0 && !proof.paymentId) {
      actions.push(
        <button key={`${proof.id}-pay`} type="button" aria-label={`Record payment from proof ${label}`} style={{ ...styles.ghostButton, padding: '4px 10px' }} onClick={() => onRecordPayment(proof)}>Record payment</button>
      );
    }
    return actions;
  }

  function renderProofNote(proof) {
    return canReviewProof && proof.status === 'Pending'
      ? <input aria-label={`Review note for payment proof ${proofLabel(proof)}`} style={{ ...styles.input, minWidth: 140 }} placeholder="Optional review note" value={proofNotes[proof.id] || ''} onChange={e => setProofNotes(current => ({ ...current, [proof.id]: e.target.value }))} maxLength={500} />
      : (proof.reviewNote || (proof.reviewedAt ? '-' : ''));
  }

  function renderProofStatus(proof) {
    return (
      <div style={{ display: 'grid', gap: 3 }}>
        <Badge tone={proofStatusTone(proof.status)}>{proof.status}</Badge>
        {proof.paymentId ? <span style={{ fontSize: 11, color: '#16A34A' }}>Payment recorded</span> : null}
        {proof.reviewedAt ? <span style={{ fontSize: 11, color: '#697386' }}>{new Date(proof.reviewedAt).toLocaleDateString('en-KE')}{proof.reviewedByName ? ` · ${proof.reviewedByName}` : ''}</span> : null}
      </div>
    );
  }

  function renderProofFile(proof) {
    return proof.fileName
      ? <div style={{ display: 'grid', gap: 2 }}><span style={{ fontSize: 12 }}>{proof.fileName}</span><span style={{ fontSize: 11, color: '#697386' }}>{proof.size || ''}</span></div>
      : <span style={{ fontSize: 11, color: '#697386' }}>No file</span>;
  }

  const rows = proofs.map(proof => {
    const actions = renderProofActions(proof);
    return [
      proof.invoiceNumber || (proof.invoiceId ? proof.invoiceId : 'General payment'),
      <div key={`${proof.id}-cm`} style={{ display: 'grid', gap: 2 }}><span>{proof.clientName || '-'}</span><span style={{ fontSize: 11, color: '#697386' }}>{proof.matterTitle || proof.matterReference || '-'}</span></div>,
      <div key={`${proof.id}-mr`} style={{ display: 'grid', gap: 2 }}><span>{proof.method || '-'}</span><span style={{ fontSize: 11, color: '#697386' }}>{proof.reference || '-'}</span></div>,
      kes(proof.amount),
      proof.createdAt ? new Date(proof.createdAt).toLocaleString('en-KE') : '-',
      renderProofStatus(proof),
      renderProofFile(proof),
      renderProofNote(proof),
      <div key={`${proof.id}-act`} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions.length ? actions : <span style={{ fontSize: 11, color: '#697386' }}>—</span>}</div>,
    ];
  });
  return (
    <div id="payment-proof-queue" style={{ marginTop: 16 }}>
      <Card title="Payment proof review" hint={canReviewProof ? 'Review client-submitted proofs, then record payment manually' : 'Client-submitted payment proofs (view only)'}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <label htmlFor="proof-filter" style={{ fontSize: 12, color: '#697386' }}>Status</label>
          <select id="proof-filter" style={styles.tableSelect} value={proofFilter} onChange={e => setProofFilter(e.target.value)}>
            <option value="Pending">Pending</option>
            <option value="Accepted">Accepted</option>
            <option value="Rejected">Rejected</option>
            <option value="All">All</option>
          </select>
          <Badge tone={pendingProofCount > 0 ? 'amber' : 'green'}>{pendingProofCount} pending</Badge>
        </div>
        <div className="ux2-mobile-stack" aria-label="Payment proof review mobile list">
          {proofs.length ? proofs.map(proof => {
            const actions = renderProofActions(proof);
            return (
              <article key={`proof-mobile-${proof.id}`} className="ux2-mobile-card">
                <div className="ux2-mobile-head">
                  <div>
                    <div className="ux2-mobile-title">{proof.invoiceNumber || (proof.invoiceId ? proof.invoiceId : 'General payment')}</div>
                    <div className="ux2-mobile-subtitle">{proof.clientName || '-'}{proof.matterTitle || proof.matterReference ? ` / ${proof.matterTitle || proof.matterReference}` : ''}</div>
                  </div>
                  {renderProofStatus(proof)}
                </div>
                <div className="ux2-mobile-kv">
                  <MobileField label="Amount">{kes(proof.amount)}</MobileField>
                  <MobileField label="Uploaded">{proof.createdAt ? new Date(proof.createdAt).toLocaleString('en-KE') : '-'}</MobileField>
                  <MobileField label="Method">{proof.method || '-'}</MobileField>
                  <MobileField label="Reference">{proof.reference || '-'}</MobileField>
                  <MobileField label="File" wide>{renderProofFile(proof)}</MobileField>
                  <MobileField label="Review note" wide>{renderProofNote(proof)}</MobileField>
                </div>
                <div className="ux2-mobile-actions">{actions.length ? actions : <span style={{ fontSize: 11, color: '#697386' }}>No action available</span>}</div>
              </article>
            );
          }) : <MobileEmpty>No payment proofs in this view.</MobileEmpty>}
        </div>
        <div className="lf-payment-proof-cards ux2-desktop-table"><Table columns={['Invoice', 'Client / Matter', 'Method / Ref', 'Amount', 'Uploaded', 'Status', 'File', 'Review note', 'Actions']} rows={rows} empty="No payment proofs in this view." /></div>
      </Card>
    </div>
  );
}

async function downloadWithNotify(path, filename, notify) {
  try {
    await downloadWithAuth(path, filename);
  } catch (err) {
    notify?.({ type: 'danger', message: err.message });
  }
}

function DownloadButton({ label, path, filename, notify, ariaLabel }) {
  return (
    <button type="button" aria-label={ariaLabel} style={{ ...styles.link, border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }} onClick={() => downloadWithNotify(path, filename, notify)}>
      {label}
    </button>
  );
}

export function FirmSettings({ settings, clients = [], reload, notify }) {
  const emptyNoticeForm = { title: '', content: '', clientId: '', files: [] };
  const [form, setForm] = useState({ ...defaultFirmSettings, ...settings });
  const [notices, setNotices] = useState([]);
  const [noticeForm, setNoticeForm] = useState(emptyNoticeForm);
  const [publishingNotice, setPublishingNotice] = useState(false);
  const [firmTheme, setFirmTheme] = useState(null);
  const [presets, setPresets] = useState([]);
  const [themeLoading, setThemeLoading] = useState(false);
  const [themePreview, setThemePreview] = useState(null);
  const [themeError, setThemeError] = useState('');
  const [settingsSection, setSettingsSection] = useState('identity');

  useEffect(() => setForm({ ...defaultFirmSettings, ...settings }), [settings]);
  useEffect(() => { loadNotices(); }, []);

  async function loadNotices() {
    try { setNotices(listFromResponse(await api('/notices'), 'notices')); }
    catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  function setReminderSetting(key, value) {
    setForm(current => ({ ...current, reminderSettings: { ...(current.reminderSettings || {}), [key]: value } }));
  }

  async function chooseLogo(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setForm({ ...form, logo: await fileToDataUrl(file) });
  }

  function chooseNoticeFiles(event) {
    const selected = Array.from(event.target.files || []);
    if (!selected.length) return;
    setNoticeForm(current => {
      const files = [...current.files, ...selected].slice(0, 10);
      if (current.files.length + selected.length > 10) {
        notify({ type: 'warning', message: 'A notice can include up to 10 attachments.' });
      }
      return { ...current, files };
    });
    event.target.value = '';
  }

  function removeNoticeFile(index) {
    setNoticeForm(current => ({ ...current, files: current.files.filter((_, fileIndex) => fileIndex !== index) }));
  }

  useEffect(() => {
    loadTheme();
    loadPresets();
  }, []);

  async function loadTheme() {
    try {
      const data = await getFirmTheme();
      setFirmTheme(data?.theme || null);
      if (data?.theme) applyFirmTheme(data.theme);
    } catch (err) { setThemeError(err.message); }
  }

  async function loadPresets() {
    try { setPresets(listFromResponse(await getThemePresets(), 'presets')); }
    catch { setPresets([]); }
  }

  async function handlePreview(presetId) {
    const sourceTheme = presetId ? presets.find(p => p.id === presetId) : firmTheme;
    if (!sourceTheme) return;
    setThemeLoading(true);
    setThemeError('');
    try {
      const data = await previewFirmTheme({ ...sourceTheme, source: presetId ? 'preset' : sourceTheme.source });
      if (data?.theme) {
        setThemePreview(data.theme);
        applyFirmTheme(data.theme);
      }
      if (data?.warnings?.length) setThemeError(`Preview warnings: ${data.warnings.join(', ')}`);
    } catch (err) { setThemeError(err.message); }
    finally { setThemeLoading(false); }
  }

  async function handleSave() {
    if (!themePreview && !firmTheme) return;
    setThemeLoading(true);
    setThemeError('');
    try {
      const payload = themePreview || firmTheme;
      const data = await updateFirmTheme(payload);
      if (data?.theme) {
        setFirmTheme(data.theme);
        setThemePreview(null);
        applyFirmTheme(data.theme);
        notify({ type: 'success', message: 'Theme saved.' });
      }
    } catch (err) { setThemeError(err.message); }
    finally { setThemeLoading(false); }
  }

  async function handleReset() {
    if (!window.confirm('Reset firm theme to default? This clears custom colors.')) return;
    setThemeLoading(true);
    setThemeError('');
    try {
      const data = await resetFirmTheme();
      setFirmTheme(null);
      setThemePreview(null);
      clearFirmTheme();
      if (data?.theme) {
        setFirmTheme(data.theme);
        applyFirmTheme(data.theme);
      }
      notify({ type: 'success', message: data?.message || 'Theme reset to default.' });
    } catch (err) { setThemeError(err.message); }
    finally { setThemeLoading(false); }
  }

  async function submit(event) {
    event.preventDefault();
    try {
      await api('/firm-settings', { method: 'PUT', body: form });
      notify({ type: 'success', message: 'Firm settings saved.' });
      await reload();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  async function createNotice(event) {
    event.preventDefault();
    setPublishingNotice(true);
    try {
      const attachments = await Promise.all(noticeForm.files.map(async file => ({
        name: file.name,
        displayName: file.name,
        mimeType: file.type || 'application/octet-stream',
        data: await fileToDataUrl(file),
      })));
      await api('/notices', { method: 'POST', body: { title: noticeForm.title, content: noticeForm.content, clientId: noticeForm.clientId, attachments } });
      setNoticeForm(emptyNoticeForm);
      notify({ type: 'success', message: attachments.length ? 'Notice published with attachments.' : 'Notice published.' });
      await loadNotices();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
    finally { setPublishingNotice(false); }
  }

  async function deleteNotice(notice) {
    try {
      await api(`/notices/${notice.id}`, { method: 'DELETE' });
      notify({ type: 'success', message: 'Notice deleted.' });
      await loadNotices();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }

  function attachmentSummary(attachments = []) {
    if (!attachments.length) return <span style={styles.mutedText}>None</span>;
    return (
      <div style={styles.noticeAttachmentSummary}>
        {attachments.slice(0, 3).map(file => <span key={file.id}>{noticeFileName(file)}</span>)}
        {attachments.length > 3 && <span>+{attachments.length - 3} more</span>}
      </div>
    );
  }

  const reminder = form.reminderSettings || {};
  const clientOptions = Array.isArray(clients) ? clients : [];
  const effectiveTheme = themePreview || firmTheme || {};
  const settingsSections = [
    { id: 'identity', label: 'Firm Identity', hint: 'Contact details, website, and logo shown across firm and client-facing surfaces.' },
    { id: 'billing', label: 'Billing & Payment', hint: 'Invoice defaults, payment guidance, tax identifiers, and billing visibility.' },
    { id: 'branding', label: 'Branding & Theme', hint: 'Saved firm colors plus the live workspace theme preview controls.' },
    { id: 'reminders', label: 'Reminders & Automation', hint: 'Firm-wide reminder channels and provider credentials.' },
  ];
  const activeSettingsSection = settingsSections.find(section => section.id === settingsSection) || settingsSections[0];

  return (
    <div style={styles.pageStack}>
      <Card title="Firm Settings" hint="Guided sections for contact, billing, branding, and reminder settings">
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {settingsSections.map(section => {
              const active = settingsSection === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSettingsSection(section.id)}
                  style={active ? styles.primaryButton : styles.ghostButton}
                >
                  {section.label}
                </button>
              );
            })}
          </div>
          <div style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: theme.wash, padding: 12, display: 'grid', gap: 3 }}>
            <strong style={{ color: theme.ink, fontSize: 13 }}>{activeSettingsSection.label}</strong>
            <span style={{ color: theme.muted, fontSize: 12 }}>{activeSettingsSection.hint}</span>
          </div>
        </div>
      </Card>

      {settingsSection === 'identity' && (
        <Card title="Firm Identity" hint="Core firm details shown on invoices, receipts, documents, and the client portal">
          <form onSubmit={submit} style={styles.formGrid}>
            <Field label="Firm Name"><input required style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Website URL"><input type="url" style={styles.input} value={form.websiteURL || ''} onChange={e => setForm({ ...form, websiteURL: e.target.value })} /></Field>
            <Field label="Email"><input style={styles.input} value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Phone"><input style={styles.input} value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Address"><input style={styles.input} value={form.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} /></Field>
            <Field label="Logo"><input type="file" accept="image/*" style={styles.input} onChange={chooseLogo} /></Field>
            <div className="lf-logo-preview" style={styles.logoPreview}>
              {form.logo ? <img src={form.logo} alt="Firm logo preview" /> : <span>LF</span>}
              <button type="button" style={styles.tinyButton} onClick={() => setForm({ ...form, logo: '' })}>Clear logo</button>
            </div>
            <button style={styles.primaryButton}>Save settings</button>
          </form>
        </Card>
      )}

      {settingsSection === 'billing' && (
        <Card title="Billing & Payment" hint="Invoice defaults and client-facing payment guidance">
          <form onSubmit={submit} style={styles.formGrid}>
            <Field label="Default invoice due period">
              <select style={styles.input} value={String(invoiceDueDaysSetting(form))} onChange={e => setForm({ ...form, defaultInvoiceDueDays: Number(e.target.value) })}>
                <option value="7">7 days</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
                <option value="45">45 days</option>
              </select>
              <div style={styles.formHelper}>Used when invoice generation has no due-date override.</div>
            </Field>
            <Field label="Payment instructions">
              <textarea style={{ ...styles.input, minHeight: 84, resize: 'vertical' }} maxLength={800} value={form.paymentInstructions || ''} onChange={e => setForm({ ...form, paymentInstructions: e.target.value })} />
              <div style={styles.formHelper}>Shown on invoice and receipt PDFs when populated.</div>
            </Field>
            <Field label="KRA PIN"><input style={styles.input} maxLength={80} value={form.kraPin || ''} onChange={e => setForm({ ...form, kraPin: e.target.value })} /></Field>
            <Field label="VAT registration number"><input style={styles.input} maxLength={80} value={form.vatNumber || ''} onChange={e => setForm({ ...form, vatNumber: e.target.value })} /></Field>
            <Field label="Invoice footer note / payment terms">
              <textarea style={{ ...styles.input, minHeight: 68, resize: 'vertical' }} maxLength={500} value={form.invoiceFooterNote || ''} onChange={e => setForm({ ...form, invoiceFooterNote: e.target.value })} />
            </Field>
            <Field label="Allow advocates to see billing information">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={Number(form.advocateBillingVisibility ?? 1) !== 0} onChange={e => setForm({ ...form, advocateBillingVisibility: e.target.checked ? 1 : 0 })} />
                Advocates can view billing data
              </label>
              <div style={styles.formHelper}>When unchecked, advocates cannot see revenue, invoice amounts, invoice PDFs, billing rates, or time-entry rates.</div>
            </Field>
            <button style={styles.primaryButton}>Save settings</button>
          </form>
        </Card>
      )}

      {settingsSection === 'branding' && (
        <>
          <Card title="Firm Branding" hint="Saved firm colors used by firm identity and client-facing details">
            <form onSubmit={submit} style={styles.formGrid}>
              <Field label="Primary Color"><input type="color" style={styles.colorInput} value={form.primaryColor || '#0F1B33'} onChange={e => setForm({ ...form, primaryColor: e.target.value })} /></Field>
              <Field label="Accent Color"><input type="color" style={styles.colorInput} value={form.accentColor || '#D4A34A'} onChange={e => setForm({ ...form, accentColor: e.target.value })} /></Field>
              <button style={styles.primaryButton}>Save settings</button>
            </form>
          </Card>

          <Card title="Firm Identity Preview" hint="Current firm identity for documents, invoices, and client-facing information">
            {(() => {
              const previewInitials = (settings.name || 'LF').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'LF';
              return (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
                    <div style={{ width: 56, height: 56, borderRadius: 10, background: settings.primaryColor || '#0F1B33', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 900, fontSize: 18, overflow: 'hidden', flexShrink: 0 }}>
                      {settings.logo ? <img src={settings.logo} alt="Firm logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span>{previewInitials}</span>}
                    </div>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: theme.ink }}>{settings.name || <span style={styles.mutedText}>Not set</span>}</div>
                    </div>
                  </div>
                  <div style={styles.formGrid}>
                    <div style={styles.field}>
                      <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: theme.muted }}>Email</label>
                      <div>{settings.email || <span style={styles.mutedText}>Not set</span>}</div>
                    </div>
                    <div style={styles.field}>
                      <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: theme.muted }}>Phone</label>
                      <div>{settings.phone || <span style={styles.mutedText}>Not set</span>}</div>
                    </div>
                    <div style={styles.field}>
                      <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: theme.muted }}>Address</label>
                      <div>{settings.address || <span style={styles.mutedText}>Not set</span>}</div>
                    </div>
                    <div style={styles.field}>
                      <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: theme.muted }}>Website</label>
                      <div>{settings.websiteURL || <span style={styles.mutedText}>Not set</span>}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 16, marginTop: 12, marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 20, height: 20, borderRadius: 5, background: settings.primaryColor || '#0F1B33', flexShrink: 0, border: '1px solid rgba(0,0,0,.08)' }} />
                      <span style={{ fontSize: 12, color: theme.ink, fontWeight: 600 }}>Primary</span>
                      <span style={{ fontSize: 12, color: theme.muted }}>{settings.primaryColor || 'default'}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 20, height: 20, borderRadius: 5, background: settings.accentColor || '#D4A34A', flexShrink: 0, border: '1px solid rgba(0,0,0,.08)' }} />
                      <span style={{ fontSize: 12, color: theme.ink, fontWeight: 600 }}>Accent</span>
                      <span style={{ fontSize: 12, color: theme.muted }}>{settings.accentColor || 'default'}</span>
                    </div>
                  </div>
                  <div style={styles.formHelper}>This preview shows the identity currently available for LexFlow documents, invoices, receipts, and client-facing firm information. Later phases will apply branding more deeply to generated documents and letterheads.</div>
                </div>
              );
            })()}
          </Card>

          <Card title="Firm Branding / Theme" hint="Choose a preset or adjust colors, then save the workspace theme.">
            <div style={{ ...styles.formGrid, marginBottom: 16 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: theme.muted }}><span>Presets</span></label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                  {presets.map(p => (
                    <button key={p.id} type="button" onClick={() => handlePreview(p.id)} style={{ ...styles.ghostButton, borderColor: themePreview?.source === 'preset' && themePreview?.id === p.id ? theme.gold : undefined }} disabled={themeLoading}>
                      {p.id === 'lexflow-default' ? 'LexFlow Default' : p.id === 'emerald-gold' ? 'Emerald Gold' : p.id === 'midnight-slate' ? 'Midnight Slate' : p.id}
                    </button>
                  ))}
                  <button type="button" onClick={() => handlePreview(null)} style={styles.ghostButton} disabled={themeLoading}>Custom (current)</button>
                </div>
              </div>
              <Field label="Primary Color"><input type="color" style={styles.colorInput} value={effectiveTheme.primaryColor || '#0F1B33'} onChange={e => { setThemePreview(prev => ({ ...(prev || firmTheme || {}), primaryColor: e.target.value, source: 'manual' })); }} /></Field>
              <Field label="Accent Color"><input type="color" style={styles.colorInput} value={effectiveTheme.accentColor || '#D4A34A'} onChange={e => { setThemePreview(prev => ({ ...(prev || firmTheme || {}), accentColor: e.target.value, source: 'manual' })); }} /></Field>
              <Field label="Background"><input type="color" style={styles.colorInput} value={effectiveTheme.backgroundColor || '#0A0F1A'} onChange={e => { setThemePreview(prev => ({ ...(prev || firmTheme || {}), backgroundColor: e.target.value, source: 'manual' })); }} /></Field>
              <Field label="Surface"><input type="color" style={styles.colorInput} value={effectiveTheme.surfaceColor || '#111827'} onChange={e => { setThemePreview(prev => ({ ...(prev || firmTheme || {}), surfaceColor: e.target.value, source: 'manual' })); }} /></Field>
              <Field label="Text"><input type="color" style={styles.colorInput} value={effectiveTheme.textColor || '#E5E7EB'} onChange={e => { setThemePreview(prev => ({ ...(prev || firmTheme || {}), textColor: e.target.value, source: 'manual' })); }} /></Field>
              <Field label="Text Muted"><input type="color" style={styles.colorInput} value={effectiveTheme.textSecondaryColor || '#9CA3AF'} onChange={e => { setThemePreview(prev => ({ ...(prev || firmTheme || {}), textSecondaryColor: e.target.value, source: 'manual' })); }} /></Field>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <button style={styles.primaryButton} onClick={handleSave} disabled={themeLoading}>{themeLoading ? 'Saving...' : 'Save Theme'}</button>
              <button style={styles.ghostButton} onClick={() => { applyFirmTheme(themePreview || firmTheme || {}); setThemePreview(null); setThemeError(''); }} disabled={!themePreview || themeLoading}>Apply Preview</button>
              <button style={styles.dangerButton} onClick={handleReset} disabled={themeLoading}>{themeLoading ? 'Resetting...' : 'Reset to Default'}</button>
            </div>
            {themeError && <div style={{ ...styles.alert, ...(themeError.startsWith('Preview warnings') ? {} : styles.alertDanger), padding: 10, borderRadius: 6 }}>{themeError}</div>}
            <div style={{ marginTop: 12, padding: 14, borderRadius: 8, background: 'var(--lf-surface, #111827)', border: `1px solid var(--lf-border, ${theme.line})`, color: 'var(--lf-text, #E5E7EB)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8, color: 'var(--lf-text-muted, #9CA3AF)' }}>Theme sample</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <span style={{ border: 0, borderRadius: 6, padding: '6px 14px', background: 'var(--lf-button, #D4A34A)', color: 'var(--lf-button-text, #fff)', fontWeight: 700 }}>Primary action sample</span>
                <span style={{ border: `1px solid var(--lf-border, ${theme.line})`, borderRadius: 6, padding: '6px 14px', background: '#fff', color: 'var(--lf-primary, #0F1B33)', fontWeight: 700 }}>Secondary action sample</span>
              </div>
              <div style={{ padding: 10, borderRadius: 6, background: 'var(--lf-background, #0A0F1A)', border: `1px solid var(--lf-border, ${theme.line})`, fontSize: 12, color: 'var(--lf-text-muted, #9CA3AF)' }}>Card sample with <a href="#" style={{ color: 'var(--lf-link, #D4A34A)', textDecoration: 'none' }}>link</a>, <span style={{ color: 'var(--lf-success, #047857)' }}>success</span>, <span style={{ color: 'var(--lf-warning, #B45309)' }}>warning</span>, and <span style={{ color: 'var(--lf-danger, #B91C1C)' }}>danger</span> text.</div>
            </div>
          </Card>
        </>
      )}

      {settingsSection === 'reminders' && (
        <Card title="Client Reminder Automation" hint="Quiet reminders for court dates and invoice follow-ups. Templates use firm defaults and run silently in the background.">
          <form onSubmit={submit} style={styles.formGrid}>
            <Field label="Automatic Reminders"><select style={styles.input} value={reminder.remindersEnabled ? 'yes' : 'no'} onChange={e => setReminderSetting('remindersEnabled', e.target.value === 'yes')}><option value="yes">Enabled</option><option value="no">Disabled</option></select></Field>
            <Field label="WhatsApp"><select style={styles.input} value={reminder.whatsappEnabled ? 'yes' : 'no'} onChange={e => setReminderSetting('whatsappEnabled', e.target.value === 'yes')}><option value="no">Off</option><option value="yes">On</option></select></Field>
            <Field label="Email"><select style={styles.input} value={reminder.emailEnabled ? 'yes' : 'no'} onChange={e => setReminderSetting('emailEnabled', e.target.value === 'yes')}><option value="no">Off</option><option value="yes">On</option></select></Field>
            {reminder.whatsappEnabled && <>
              <Field label="Twilio SID"><input style={styles.input} value={reminder.twilioSid || ''} onChange={e => setReminderSetting('twilioSid', e.target.value)} /></Field>
              <Field label="Twilio Token"><input type="password" style={styles.input} value={reminder.twilioToken || ''} onChange={e => setReminderSetting('twilioToken', e.target.value)} /></Field>
              <Field label="WhatsApp From"><input style={styles.input} value={reminder.twilioFromNumber || ''} onChange={e => setReminderSetting('twilioFromNumber', e.target.value)} placeholder="whatsapp:+14155238886" /></Field>
            </>}
            {reminder.emailEnabled && <>
              <Field label="SMTP Host"><input style={styles.input} value={reminder.smtpHost || ''} onChange={e => setReminderSetting('smtpHost', e.target.value)} /></Field>
              <Field label="SMTP Port"><input style={styles.input} value={reminder.smtpPort || ''} onChange={e => setReminderSetting('smtpPort', e.target.value)} /></Field>
              <Field label="SMTP User"><input style={styles.input} value={reminder.smtpUser || ''} onChange={e => setReminderSetting('smtpUser', e.target.value)} /></Field>
              <Field label="SMTP Password"><input type="password" style={styles.input} value={reminder.smtpPass || ''} onChange={e => setReminderSetting('smtpPass', e.target.value)} /></Field>
            </>}
            <div style={styles.formHelper}>When credentials are blank, LexFlow uses console stubs for testing. Real messages send automatically once provider credentials are saved.</div>
            <button style={styles.primaryButton}>Save automation</button>
          </form>
        </Card>
      )}

      <Card title="Client Portal Notices" hint="Publish broadcast or client-specific updates with secure attachments">
        <form onSubmit={createNotice} style={styles.formGrid}>
          <Field label="Audience">
            <select style={styles.input} value={noticeForm.clientId} onChange={e => setNoticeForm({ ...noticeForm, clientId: e.target.value })}>
              <option value="">All clients</option>
              {clientOptions.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
            </select>
          </Field>
          <Field label="Title"><input required style={styles.input} value={noticeForm.title} onChange={e => setNoticeForm({ ...noticeForm, title: e.target.value })} /></Field>
          <Field label="Attachments"><input type="file" multiple accept=".pdf,.doc,.docx,.txt,image/*" style={styles.input} onChange={chooseNoticeFiles} /></Field>
          <Field label="Content">
            <textarea required rows={4} style={{ ...styles.input, minHeight: 104, resize: 'vertical' }} value={noticeForm.content} onChange={e => setNoticeForm({ ...noticeForm, content: e.target.value })} />
          </Field>
          <div style={styles.formHelper}>Attachments are stored in LexFlow and exposed only through authenticated client downloads.</div>
          {!!noticeForm.files.length && (
            <div style={styles.noticeAttachmentPreview}>
              {noticeForm.files.map((file, index) => (
                <div key={`${file.name}-${file.lastModified}-${index}`} style={styles.noticeAttachmentPreviewItem}>
                  <div>
                    <strong>{file.name}</strong>
                    <span>{file.type || 'File'} | {formatFileSize(file.size)}</span>
                  </div>
                  <button type="button" style={styles.dangerTinyButton} onClick={() => removeNoticeFile(index)}>Remove</button>
                </div>
              ))}
            </div>
          )}
          <button disabled={publishingNotice} style={styles.primaryButton}>{publishingNotice ? 'Publishing...' : 'Publish notice'}</button>
        </form>
        <Table
          columns={['Title', 'Audience', 'Attachments', 'Created', 'Actions']}
          rows={notices.map(n => [
            n.title,
            n.clientName ? <Badge key={`${n.id}-audience`} tone="amber">{n.clientName}</Badge> : <Badge key={`${n.id}-audience`} tone="blue">All clients</Badge>,
            attachmentSummary(n.attachments),
            n.createdAt ? new Date(n.createdAt).toLocaleString() : '-',
            <button key={n.id} type="button" style={styles.dangerTinyButton} onClick={() => deleteNotice(n)}>Delete</button>,
          ])}
          empty="No notices yet."
        />
      </Card>
    </div>
  );
}
function UserAvatar({ userId, hasAvatar, fullName, size = 28 }) {
  const [src, setSrc] = useState(null);
  const srcRef = useRef(null);
  useEffect(() => {
    function revoke() { if (srcRef.current) { URL.revokeObjectURL(srcRef.current); srcRef.current = null; } }
    if (!hasAvatar) { revoke(); setSrc(null); return; }
    let alive = true;
    fetchAvatarObjectUrl(userId).then(url => {
      if (!alive) { if (url) URL.revokeObjectURL(url); return; }
      revoke();
      srcRef.current = url;
      setSrc(url);
    });
    return () => { alive = false; revoke(); };
  }, [userId, hasAvatar]);
  const initial = (fullName || '?').slice(0, 1).toUpperCase();
  return (
    <div style={{ width: size, height: size, borderRadius: 999, background: 'var(--lf-accent, #D4A34A)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: Math.round(size * 0.43), overflow: 'hidden', flexShrink: 0 }}>
      {src
        ? <img src={src} alt={fullName || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={() => setSrc(null)} />
        : initial}
    </div>
  );
}

const emptyHrProfileForm = {
  jobTitle: '',
  department: '',
  practiceTeam: '',
  employmentType: '',
  startDate: '',
  contractEndDate: '',
  supervisorUserId: '',
  workEmail: '',
  workPhone: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  hrStatus: 'active',
  adminNotes: '',
};

// HR-29E: contract record form (no salary/allowance fields)
const emptyHrContractForm = {
  userId: '',
  contractType: 'permanent',
  startDate: '',
  endDate: '',
  probationEndDate: '',
  renewalDate: '',
  status: 'active',
  documentId: '',
  notes: '',
};

const hrEmploymentTypes = [
  ['advocate', 'Advocate'],
  ['associate', 'Associate'],
  ['pupil', 'Pupil'],
  ['clerk', 'Clerk'],
  ['assistant', 'Assistant'],
  ['admin', 'Admin'],
  ['consultant', 'Consultant'],
  ['intern', 'Intern'],
  ['other', 'Other'],
];

const hrStatuses = [
  ['active', 'Active'],
  ['on_leave', 'On leave'],
  ['suspended', 'Suspended'],
  ['exited', 'Exited'],
];

function hrStatusLabel(status) {
  return hrStatuses.find(([value]) => value === status)?.[1] || 'No profile';
}

function hrStatusTone(status) {
  if (status === 'active') return 'green';
  if (status === 'on_leave') return 'amber';
  if (status === 'suspended' || status === 'exited') return 'red';
  return 'blue';
}

function hrProfileFormFrom(profile, staffUser) {
  const values = { ...emptyHrProfileForm };
  Object.keys(emptyHrProfileForm).forEach(field => {
    values[field] = profile?.[field] || emptyHrProfileForm[field];
  });
  if (!values.workEmail) values.workEmail = staffUser?.email || '';
  if (!values.hrStatus) values.hrStatus = 'active';
  return values;
}

function hrStaffName(staffUser) {
  return staffUser?.fullName || staffUser?.email || 'Staff member';
}

const LEAVE_TYPE_LABELS = {
  annual: 'Annual',
  sick: 'Sick',
  compassionate: 'Compassionate',
  maternity: 'Maternity',
  paternity: 'Paternity',
  study_exam: 'Study/Exam',
  unpaid: 'Unpaid',
  other: 'Other',
};

const LEAVE_STATUS_ACTIONS = {
  pending: ['amber', ['approve', 'reject', 'cancel']],
  approved: ['green', []],
  rejected: ['red', []],
  cancelled: ['grey', []],
};

function leaveStatusTone(status) {
  const tones = { pending: 'amber', approved: 'green', rejected: 'red', cancelled: 'grey' };
  return tones[status] || 'blue';
}

const BALANCE_LEAVE_TYPES = [
  { value: 'annual', label: 'Annual' },
  { value: 'sick', label: 'Sick' },
  { value: 'compassionate', label: 'Compassionate' },
  { value: 'maternity', label: 'Maternity' },
  { value: 'paternity', label: 'Paternity' },
  { value: 'study_exam', label: 'Study/Exam' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'other', label: 'Other' },
];

// HR-29E: contract and HR document type labels (admin-only)
const HR_DOCUMENT_TYPE_OPTIONS = [
  { value: 'contract', label: 'Contract' },
  { value: 'id', label: 'ID' },
  { value: 'kra_pin', label: 'KRA PIN' },
  { value: 'practising_certificate', label: 'Practising Certificate' },
  { value: 'academic_certificate', label: 'Academic Certificate' },
  { value: 'leave_support', label: 'Leave Support' },
  { value: 'other', label: 'Other' },
];
const HR_DOCUMENT_TYPE_LABELS = Object.fromEntries(HR_DOCUMENT_TYPE_OPTIONS.map(o => [o.value, o.label]));
const HR_CONTRACT_TYPE_OPTIONS = [
  { value: 'permanent', label: 'Permanent' },
  { value: 'fixed_term', label: 'Fixed Term' },
  { value: 'consultancy', label: 'Consultancy' },
  { value: 'internship', label: 'Internship' },
  { value: 'pupilage', label: 'Pupilage' },
  { value: 'secondment', label: 'Secondment' },
  { value: 'other', label: 'Other' },
];
const HR_CONTRACT_TYPE_LABELS = Object.fromEntries(HR_CONTRACT_TYPE_OPTIONS.map(o => [o.value, o.label]));
const HR_CONTRACT_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'terminated', label: 'Terminated' },
  { value: 'superseded', label: 'Superseded' },
];
const HR_CONTRACT_STATUS_LABELS = Object.fromEntries(HR_CONTRACT_STATUS_OPTIONS.map(o => [o.value, o.label]));
// HR document MIME types accepted by the backend (PDF, PNG, JPEG, DOC, DOCX).
const HR_DOCUMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.doc,.docx,application/pdf,image/png,image/jpeg,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const HR_DOCUMENT_ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

function hrContractStatusTone(status) {
  if (status === 'active') return 'green';
  if (status === 'expired') return 'amber';
  if (status === 'terminated' || status === 'superseded') return 'grey';
  return 'blue';
}

// HR-29F: offboarding labels/options (admin-only)
const HR_OFFBOARDING_REASON_OPTIONS = [
  { value: 'resignation', label: 'Resignation' },
  { value: 'termination', label: 'Termination' },
  { value: 'end_of_contract', label: 'End of contract' },
  { value: 'retirement', label: 'Retirement' },
  { value: 'redundancy', label: 'Redundancy' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'other', label: 'Other' },
];
const HR_OFFBOARDING_REASON_LABELS = Object.fromEntries(HR_OFFBOARDING_REASON_OPTIONS.map(o => [o.value, o.label]));
const HR_OFFBOARDING_STATUS_LABELS = { open: 'Open', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const HR_OFFBOARDING_CHECKLIST_STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'na', label: 'N/A' },
];
const emptyOffboardingForm = { userId: '', exitType: '', exitDate: '', reasonCategory: '', notes: '' };

function offboardingStatusTone(status) {
  if (status === 'completed') return 'green';
  if (status === 'cancelled') return 'grey';
  if (status === 'in_progress') return 'amber';
  return 'blue';
}

export function HR({ notify }) {
  const [staff, setStaff] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [form, setForm] = useState(emptyHrProfileForm);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [hrTab, setHrTab] = useState('dashboard');
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [leaveLoading, setLeaveLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [actioningId, setActioningId] = useState('');
  const [decisionNotes, setDecisionNotes] = useState({});
  const [dashboard, setDashboard] = useState(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashYear, setDashYear] = useState(String(new Date().getFullYear()));
  const [balances, setBalances] = useState([]);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balYear, setBalYear] = useState(String(new Date().getFullYear()));
  const [balFilterUser, setBalFilterUser] = useState('');
  const [balFilterType, setBalFilterType] = useState('');
  const [editEntitlement, setEditEntitlement] = useState({ userId: '', leaveType: 'annual', year: String(new Date().getFullYear()), days: '' });
  const [adjustment, setAdjustment] = useState({ userId: '', leaveType: 'annual', year: String(new Date().getFullYear()), days: '', reason: '' });
  const [entitlementSaving, setEntitlementSaving] = useState(false);
  const [adjustmentSaving, setAdjustmentSaving] = useState(false);
  // HR-29E: HR document records (admin-only, separate from matter documents)
  const [documents, setDocuments] = useState([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [docFilterUser, setDocFilterUser] = useState('');
  const [docFilterType, setDocFilterType] = useState('');
  const [docIncludeInactive, setDocIncludeInactive] = useState(false);
  const [docUpload, setDocUpload] = useState({ userId: '', documentType: 'contract', title: '', file: null, fileName: '', mimeType: '' });
  const [docUploading, setDocUploading] = useState(false);
  const [docActioningId, setDocActioningId] = useState('');
  // HR-29E: contract records (admin-only)
  const [contracts, setContracts] = useState([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [contractFilterUser, setContractFilterUser] = useState('');
  const [contractFilterStatus, setContractFilterStatus] = useState('');
  const [contractForm, setContractForm] = useState(emptyHrContractForm);
  const [contractEditingId, setContractEditingId] = useState('');
  const [contractSaving, setContractSaving] = useState(false);
  const [contractUserDocs, setContractUserDocs] = useState([]);
  // HR-29F: staff offboarding (admin-only)
  const [offboardingCases, setOffboardingCases] = useState([]);
  const [offboardingLoading, setOffboardingLoading] = useState(false);
  const [offboardingStatusFilter, setOffboardingStatusFilter] = useState('');
  const [offboardingForm, setOffboardingForm] = useState(emptyOffboardingForm);
  const [offboardingCreating, setOffboardingCreating] = useState(false);
  const [selectedCaseId, setSelectedCaseId] = useState('');
  const [selectedCase, setSelectedCase] = useState(null);
  const [caseLoading, setCaseLoading] = useState(false);
  const [assignedMatters, setAssignedMatters] = useState(null);
  const [offboardingActioning, setOffboardingActioning] = useState('');
  const [reassignChoices, setReassignChoices] = useState({});

  useEffect(() => { loadStaff(); }, []);
  useEffect(() => {
    if (hrTab === 'dashboard') loadDashboard();
    if (hrTab === 'balances') loadBalances();
    if (hrTab === 'documents') loadDocuments();
    if (hrTab === 'contracts') loadContracts();
    if (hrTab === 'offboarding') loadOffboardingCases();
  }, [hrTab]);
  useEffect(() => {
    if (selectedUserId) loadSelectedProfile(selectedUserId);
    else {
      setSelectedRecord(null);
      setForm(emptyHrProfileForm);
    }
  }, [selectedUserId]);

  useEffect(() => {
    if (hrTab === 'leaves') loadLeaveRequests();
  }, [hrTab, statusFilter]);

  useEffect(() => {
    if (hrTab === 'documents') loadDocuments();
  }, [docFilterUser, docFilterType, docIncludeInactive]);

  useEffect(() => {
    if (hrTab === 'contracts') loadContracts();
  }, [contractFilterUser, contractFilterStatus]);

  useEffect(() => {
    if (hrTab === 'offboarding') loadOffboardingCases();
  }, [offboardingStatusFilter]);

  // HR-29F: load the selected case detail + its assigned-matter review.
  useEffect(() => {
    let cancelled = false;
    async function loadCaseDetail() {
      if (!selectedCaseId) { setSelectedCase(null); setAssignedMatters(null); return; }
      setCaseLoading(true);
      try {
        const [caseData, matters] = await Promise.all([
          getOffboardingCase(selectedCaseId),
          getOffboardingAssignedMatters(selectedCaseId).catch(() => null),
        ]);
        if (cancelled) return;
        setSelectedCase(caseData);
        setAssignedMatters(matters);
      } catch (err) {
        if (!cancelled) { setSelectedCase(null); setAssignedMatters(null); notify?.({ type: 'danger', message: err.message }); }
      } finally {
        if (!cancelled) setCaseLoading(false);
      }
    }
    loadCaseDetail();
    return () => { cancelled = true; };
  }, [selectedCaseId]);

  // HR-29E: when the contract form targets a staff user, load that user's active
  // contract/other HR documents so they can be linked. Empty if no user selected.
  useEffect(() => {
    let cancelled = false;
    async function loadLinkableDocs() {
      if (!contractForm.userId) { setContractUserDocs([]); return; }
      try {
        const rows = await getHrDocuments({ userId: contractForm.userId });
        if (cancelled) return;
        const linkable = (Array.isArray(rows) ? rows : []).filter(d => d.isActive && (d.documentType === 'contract' || d.documentType === 'other'));
        setContractUserDocs(linkable);
      } catch {
        if (!cancelled) setContractUserDocs([]);
      }
    }
    loadLinkableDocs();
    return () => { cancelled = true; };
  }, [contractForm.userId]);

  async function loadDashboard() {
    setDashboardLoading(true);
    try {
      const data = await getHrDashboard(dashYear);
      setDashboard(data);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setDashboardLoading(false);
    }
  }

  async function loadBalances() {
    setBalancesLoading(true);
    try {
      const params = { year: balYear };
      if (balFilterUser) params.userId = balFilterUser;
      if (balFilterType) params.leaveType = balFilterType;
      const data = await getHrLeaveBalances(params);
      setBalances(Array.isArray(data) ? data : []);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setBalancesLoading(false);
    }
  }

  // HR-29E: HR document records ------------------------------------------------
  async function loadDocuments() {
    setDocumentsLoading(true);
    try {
      const params = {};
      if (docFilterUser) params.userId = docFilterUser;
      if (docFilterType) params.documentType = docFilterType;
      if (docIncludeInactive) params.includeInactive = 'true';
      const data = await getHrDocuments(params);
      setDocuments(Array.isArray(data) ? data : []);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setDocumentsLoading(false);
    }
  }

  function handleDocFile(file) {
    if (!file) { setDocUpload(current => ({ ...current, file: null, fileName: '', mimeType: '' })); return; }
    if (!HR_DOCUMENT_ALLOWED_MIME.has(file.type)) {
      notify?.({ type: 'danger', message: 'Only PDF, PNG, JPEG, DOC, or DOCX files are accepted.' });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      notify?.({ type: 'danger', message: 'File must be 10 MB or smaller.' });
      return;
    }
    setDocUpload(current => ({ ...current, file, fileName: file.name, mimeType: file.type, title: current.title || file.name }));
  }

  async function handleUploadDocument(event) {
    event.preventDefault();
    if (!docUpload.userId) { notify?.({ type: 'warning', message: 'Select a staff member.' }); return; }
    if (!docUpload.file) { notify?.({ type: 'warning', message: 'Choose a file to upload.' }); return; }
    if (!docUpload.title.trim()) { notify?.({ type: 'warning', message: 'Enter a document title.' }); return; }
    setDocUploading(true);
    try {
      const contentBase64 = await fileToDataUrl(docUpload.file);
      await uploadHrDocument({
        userId: docUpload.userId,
        documentType: docUpload.documentType,
        title: docUpload.title.trim(),
        fileName: docUpload.fileName,
        mimeType: docUpload.mimeType,
        contentBase64,
      });
      notify?.({ type: 'success', message: 'HR document uploaded.' });
      setDocUpload({ userId: docUpload.userId, documentType: 'contract', title: '', file: null, fileName: '', mimeType: '' });
      await loadDocuments();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setDocUploading(false);
    }
  }

  async function handleDownloadDocument(doc) {
    setDocActioningId(`download:${doc.id}`);
    try {
      await downloadHrDocumentContent(doc.id, doc.fileName || doc.title);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setDocActioningId('');
    }
  }

  async function handleDeleteDocument(doc) {
    setDocActioningId(`delete:${doc.id}`);
    try {
      await deleteHrDocument(doc.id);
      notify?.({ type: 'success', message: 'HR document deactivated.' });
      await loadDocuments();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setDocActioningId('');
    }
  }

  async function handleReactivateDocument(doc) {
    setDocActioningId(`reactivate:${doc.id}`);
    try {
      await updateHrDocument(doc.id, { isActive: true });
      notify?.({ type: 'success', message: 'HR document reactivated.' });
      await loadDocuments();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setDocActioningId('');
    }
  }

  // HR-29E: contract records ---------------------------------------------------
  async function loadContracts() {
    setContractsLoading(true);
    try {
      const params = {};
      if (contractFilterUser) params.userId = contractFilterUser;
      if (contractFilterStatus) params.status = contractFilterStatus;
      const data = await getHrContracts(params);
      setContracts(Array.isArray(data) ? data : []);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setContractsLoading(false);
    }
  }

  function resetContractForm() {
    setContractEditingId('');
    setContractForm(emptyHrContractForm);
  }

  function startEditContract(contract) {
    setContractEditingId(contract.id);
    setContractForm({
      userId: contract.userId || '',
      contractType: contract.contractType || 'permanent',
      startDate: contract.startDate || '',
      endDate: contract.endDate || '',
      probationEndDate: contract.probationEndDate || '',
      renewalDate: contract.renewalDate || '',
      status: contract.status || 'active',
      documentId: contract.documentId || '',
      notes: contract.notes || '',
    });
  }

  async function handleSaveContract(event) {
    event.preventDefault();
    if (!contractForm.userId) { notify?.({ type: 'warning', message: 'Select a staff member.' }); return; }
    setContractSaving(true);
    try {
      const payload = {
        contractType: contractForm.contractType,
        startDate: contractForm.startDate || '',
        endDate: contractForm.endDate || '',
        probationEndDate: contractForm.probationEndDate || '',
        renewalDate: contractForm.renewalDate || '',
        status: contractForm.status,
        documentId: contractForm.documentId || '',
        notes: contractForm.notes || '',
      };
      if (contractEditingId) {
        await updateHrContract(contractEditingId, payload);
        notify?.({ type: 'success', message: 'Contract record updated.' });
      } else {
        await createHrContract({ userId: contractForm.userId, ...payload });
        notify?.({ type: 'success', message: 'Contract record created.' });
      }
      resetContractForm();
      await loadContracts();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setContractSaving(false);
    }
  }

  // HR-29F: offboarding -------------------------------------------------------
  async function loadOffboardingCases() {
    setOffboardingLoading(true);
    try {
      const params = {};
      if (offboardingStatusFilter) params.status = offboardingStatusFilter;
      const data = await getOffboardingCases(params);
      setOffboardingCases(Array.isArray(data) ? data : []);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setOffboardingLoading(false);
    }
  }

  async function refreshSelectedCase() {
    if (!selectedCaseId) return;
    try {
      const [caseData, matters] = await Promise.all([
        getOffboardingCase(selectedCaseId),
        getOffboardingAssignedMatters(selectedCaseId).catch(() => null),
      ]);
      setSelectedCase(caseData);
      setAssignedMatters(matters);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    }
  }

  async function handleCreateOffboarding(event) {
    event.preventDefault();
    if (!offboardingForm.userId) { notify?.({ type: 'warning', message: 'Select a staff member.' }); return; }
    setOffboardingCreating(true);
    try {
      const payload = {
        userId: offboardingForm.userId,
        exitType: offboardingForm.exitType || undefined,
        exitDate: offboardingForm.exitDate || undefined,
        reasonCategory: offboardingForm.reasonCategory || undefined,
        notes: offboardingForm.notes || undefined,
      };
      const created = await createOffboardingCase(payload);
      notify?.({ type: 'success', message: 'Offboarding case created.' });
      setOffboardingForm(emptyOffboardingForm);
      await loadOffboardingCases();
      if (created?.id) setSelectedCaseId(created.id);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setOffboardingCreating(false);
    }
  }

  async function handleUpdateOffboardingField(patch) {
    if (!selectedCaseId) return;
    try {
      await updateOffboardingCase(selectedCaseId, patch);
      notify?.({ type: 'success', message: 'Offboarding case updated.' });
      await refreshSelectedCase();
      await loadOffboardingCases();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    }
  }

  async function handleChecklistChange(itemId, status, notes) {
    if (!selectedCaseId) return;
    setOffboardingActioning(`checklist:${itemId}`);
    try {
      const payload = { status };
      if (notes !== undefined) payload.notes = notes;
      await updateOffboardingChecklistItem(selectedCaseId, itemId, payload);
      await refreshSelectedCase();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setOffboardingActioning('');
    }
  }

  async function handleReassignMatter(matterId) {
    const target = reassignChoices[matterId];
    if (!target) { notify?.({ type: 'warning', message: 'Choose an advocate to reassign to.' }); return; }
    setOffboardingActioning(`reassign:${matterId}`);
    try {
      await reassignMatter(matterId, target);
      notify?.({ type: 'success', message: `Matter reassigned to ${target}.` });
      setReassignChoices(current => { const next = { ...current }; delete next[matterId]; return next; });
      await refreshSelectedCase();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setOffboardingActioning('');
    }
  }

  async function handleCompleteOffboarding() {
    if (!selectedCaseId) return;
    setOffboardingActioning('complete');
    try {
      await completeOffboardingCase(selectedCaseId);
      notify?.({ type: 'success', message: 'Offboarding completed.' });
      await refreshSelectedCase();
      await loadOffboardingCases();
      await loadStaff(selectedUserId);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setOffboardingActioning('');
    }
  }

  async function handleCancelOffboarding() {
    if (!selectedCaseId) return;
    setOffboardingActioning('cancel');
    try {
      await cancelOffboardingCase(selectedCaseId);
      notify?.({ type: 'success', message: 'Offboarding cancelled.' });
      await refreshSelectedCase();
      await loadOffboardingCases();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setOffboardingActioning('');
    }
  }

  async function loadStaff(preferredUserId = selectedUserId) {
    setLoading(true);
    try {
      const rows = await getHrStaff();
      const list = Array.isArray(rows) ? rows : [];
      setStaff(list);
      setLoadError(Array.isArray(rows) ? '' : 'The HR staff endpoint returned an unexpected response.');
      const nextUserId = list.some(member => member.userId === preferredUserId) ? preferredUserId : (list[0]?.userId || '');
      setSelectedUserId(nextUserId);
    } catch (err) {
      setStaff([]);
      setLoadError(err.message);
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setLoading(false);
    }
  }

  async function loadSelectedProfile(userId) {
    setProfileLoading(true);
    try {
      const record = await getHrStaffProfile(userId);
      setSelectedRecord(record);
      setForm(hrProfileFormFrom(record?.profile, record?.staff));
      setLoadError('');
    } catch (err) {
      setSelectedRecord(null);
      setForm(emptyHrProfileForm);
      setLoadError(err.message);
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setProfileLoading(false);
    }
  }

  async function loadLeaveRequests() {
    setLeaveLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      const data = await getHrLeaveRequests(params);
      setLeaveRequests(Array.isArray(data) ? data : []);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setLeaveLoading(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (!selectedUserId) return;
    setSaving(true);
    try {
      const payload = { ...form };
      const hasProfile = Boolean(selectedRecord?.profile?.id);
      const saved = hasProfile
        ? await updateHrStaffProfile(selectedUserId, payload)
        : await createHrStaffProfile(selectedUserId, payload);
      setSelectedRecord(saved);
      setForm(hrProfileFormFrom(saved?.profile, saved?.staff));
      notify?.({ type: 'success', message: hasProfile ? 'HR profile updated.' : 'HR profile created.' });
      await loadStaff(selectedUserId);
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleLeaveAction(id, action) {
    setActioningId(`${action}:${id}`);
    try {
      const note = decisionNotes[id] || '';
      if (action === 'approve') await approveHrLeaveRequest(id, { decisionNote: note });
      else if (action === 'reject') await rejectHrLeaveRequest(id, { decisionNote: note });
      else if (action === 'cancel') await cancelHrLeaveRequestAdmin(id);
      notify?.({ type: 'success', message: `Leave request ${action}d.` });
      setDecisionNotes(current => { const next = { ...current }; delete next[id]; return next; });
      await loadLeaveRequests();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setActioningId('');
    }
  }

  async function handleSetEntitlement() {
    if (!editEntitlement.userId || !editEntitlement.leaveType || !editEntitlement.year) {
      notify?.({ type: 'warning', message: 'Select a staff user, leave type, and year.' });
      return;
    }
    const days = Number(editEntitlement.days);
    if (isNaN(days) || days < 0 || days > 365) {
      notify?.({ type: 'warning', message: 'Entitlement days must be between 0 and 365.' });
      return;
    }
    setEntitlementSaving(true);
    try {
      await setHrLeaveEntitlement(editEntitlement.userId, editEntitlement.leaveType, editEntitlement.year, { entitlementDays: days });
      notify?.({ type: 'success', message: 'Entitlement saved.' });
      setEditEntitlement({ ...editEntitlement, days: '' });
      await loadBalances();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setEntitlementSaving(false);
    }
  }

  async function handleCreateAdjustment() {
    if (!adjustment.userId || !adjustment.leaveType || !adjustment.year) {
      notify?.({ type: 'warning', message: 'Select a staff user, leave type, and year.' });
      return;
    }
    const days = Number(adjustment.days);
    if (isNaN(days) || days === 0 || days < -365 || days > 365) {
      notify?.({ type: 'warning', message: 'Adjustment days must be a non-zero number between -365 and 365.' });
      return;
    }
    setAdjustmentSaving(true);
    try {
      await createHrLeaveBalanceAdjustment({ userId: adjustment.userId, leaveType: adjustment.leaveType, year: Number(adjustment.year), days, reason: adjustment.reason || undefined });
      notify?.({ type: 'success', message: 'Adjustment created.' });
      setAdjustment({ ...adjustment, days: '', reason: '' });
      await loadBalances();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setAdjustmentSaving(false);
    }
  }

  const selectedStaff = selectedRecord?.staff || staff.find(member => member.userId === selectedUserId);
  const selectedProfile = selectedRecord?.profile || null;
  const profileCount = staff.filter(member => member.profile).length;
  const staffEmptyText = loading ? 'Loading staff...' : 'No staff users found.';

  return (
    <div style={styles.pageStack}>
      <div style={styles.tabList}>
        <button type="button" onClick={() => setHrTab('dashboard')} style={{ ...styles.tabButton, ...(hrTab === 'dashboard' ? styles.tabActive : {}) }}>Dashboard</button>
        <button type="button" onClick={() => setHrTab('balances')} style={{ ...styles.tabButton, ...(hrTab === 'balances' ? styles.tabActive : {}) }}>Leave Balances</button>
        <button type="button" onClick={() => setHrTab('profiles')} style={{ ...styles.tabButton, ...(hrTab === 'profiles' ? styles.tabActive : {}) }}>Staff Profiles</button>
        <button type="button" onClick={() => setHrTab('leaves')} style={{ ...styles.tabButton, ...(hrTab === 'leaves' ? styles.tabActive : {}) }}>Leave Requests</button>
        <button type="button" onClick={() => setHrTab('documents')} style={{ ...styles.tabButton, ...(hrTab === 'documents' ? styles.tabActive : {}) }}>Documents</button>
        <button type="button" onClick={() => setHrTab('contracts')} style={{ ...styles.tabButton, ...(hrTab === 'contracts' ? styles.tabActive : {}) }}>Contracts</button>
        <button type="button" onClick={() => setHrTab('offboarding')} style={{ ...styles.tabButton, ...(hrTab === 'offboarding' ? styles.tabActive : {}) }}>Offboarding</button>
      </div>

      {hrTab === 'dashboard' && (
        <Card title="HR Dashboard" hint={`Year ${dashYear}`}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.ink }}>Year:</span>
            <input type="number" style={{ ...styles.input, width: 100 }} value={dashYear} onChange={e => setDashYear(e.target.value)} min={2000} max={2100} />
            <button type="button" style={styles.primaryButton} onClick={() => loadDashboard()}>Refresh</button>
          </div>
          {dashboardLoading ? (
            <div style={{ color: theme.muted, padding: 12 }}>Loading...</div>
          ) : dashboard ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ background: '#EFF6FF', borderRadius: 8, padding: '12px 16px', flex: '1 1 140px' }}>
                  <div style={{ fontSize: 11, color: '#1E40AF', fontWeight: 600 }}>Staff</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: '#1E3A5F' }}>{dashboard.staffCount}</div>
                  <div style={{ fontSize: 11, color: '#6B7280' }}>{dashboard.activeStaffCount} active</div>
                </div>
                <div style={{ background: '#FEF2F2', borderRadius: 8, padding: '12px 16px', flex: '1 1 140px' }}>
                  <div style={{ fontSize: 11, color: '#991B1B', fontWeight: 600 }}>No Profile</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: '#1E3A5F' }}>{dashboard.staffWithoutProfiles}</div>
                </div>
                <div style={{ background: '#FFFBEB', borderRadius: 8, padding: '12px 16px', flex: '1 1 140px' }}>
                  <div style={{ fontSize: 11, color: '#92400E', fontWeight: 600 }}>Pending Leave</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: '#1E3A5F' }}>{dashboard.pendingLeaveCount}</div>
                </div>
                <div style={{ background: '#F0FDF4', borderRadius: 8, padding: '12px 16px', flex: '1 1 140px' }}>
                  <div style={{ fontSize: 11, color: '#065F46', fontWeight: 600 }}>On Leave Today</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: '#1E3A5F' }}>{dashboard.staffCurrentlyOnLeave}</div>
                </div>
                <div style={{ background: '#F5F3FF', borderRadius: 8, padding: '12px 16px', flex: '1 1 140px' }}>
                  <div style={{ fontSize: 11, color: '#5B21B6', fontWeight: 600 }}>Upcoming</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: '#1E3A5F' }}>{dashboard.upcomingApprovedLeaveCount}</div>
                </div>
                <div style={{ background: '#FFF1F2', borderRadius: 8, padding: '12px 16px', flex: '1 1 140px' }}>
                  <div style={{ fontSize: 11, color: '#9F1239', fontWeight: 600 }}>Low Annual Balance</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: '#1E3A5F' }}>{dashboard.lowAnnualBalanceCount}</div>
                </div>
              </div>
              {dashboard.hrStatusCounts && Object.keys(dashboard.hrStatusCounts).length > 0 && (
                <div style={{ fontSize: 13, color: theme.muted }}>
                  <strong>HR Status counts:</strong> {Object.entries(dashboard.hrStatusCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}
                </div>
              )}
              {dashboard.recentPendingLeaveRequests && dashboard.recentPendingLeaveRequests.length > 0 && (
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: theme.ink }}>Recent Pending Requests</div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {dashboard.recentPendingLeaveRequests.slice(0, 10).map(r => (
                      <div key={r.id} style={{ fontSize: 12, color: theme.ink, background: '#F9FAFB', borderRadius: 6, padding: '6px 10px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 }}>
                        <span><strong>{r.fullName}</strong> — {BALANCE_LEAVE_TYPES.find(lt => lt.value === r.leaveType)?.label || r.leaveType} ({r.days} day{Number(r.days) === 1 ? '' : 's'})</span>
                        <span style={{ color: theme.muted }}>{r.startDate} → {r.endDate}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: theme.muted, padding: 12 }}>No dashboard data.</div>
          )}
        </Card>
      )}

      {hrTab === 'balances' && (
        <div style={{ display: 'grid', gap: 12 }}>
          <Card title="Leave Balances" hint="Computed from entitlements, adjustments, and approved leave">
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: theme.ink }}>Year:</span>
              <input type="number" style={{ ...styles.input, width: 100 }} value={balYear} onChange={e => setBalYear(e.target.value)} min={2000} max={2100} />
              <span style={{ fontSize: 13, fontWeight: 600, color: theme.ink }}>User:</span>
              <select style={{ ...styles.input, width: 200 }} value={balFilterUser} onChange={e => setBalFilterUser(e.target.value)}>
                <option value="">All staff</option>
                {staff.map(m => <option key={m.userId} value={m.userId}>{m.fullName}</option>)}
              </select>
              <span style={{ fontSize: 13, fontWeight: 600, color: theme.ink }}>Type:</span>
              <select style={{ ...styles.input, width: 140 }} value={balFilterType} onChange={e => setBalFilterType(e.target.value)}>
                <option value="">All types</option>
                {BALANCE_LEAVE_TYPES.map(lt => <option key={lt.value} value={lt.value}>{lt.label}</option>)}
              </select>
              <button type="button" style={styles.primaryButton} onClick={() => loadBalances()}>Refresh</button>
            </div>
            {balancesLoading ? (
              <div style={{ color: theme.muted, padding: 12 }}>Loading...</div>
            ) : balances.length === 0 ? (
              <Empty title="No balances." text="Set entitlements to see computed balances." />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#F9FAFB', borderBottom: `2px solid ${theme.line}` }}>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: theme.muted }}>Staff</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: theme.muted }}>Leave Type</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: theme.muted }}>Entitlement</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: theme.muted }}>Adjustments</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: theme.muted }}>Approved Used</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: theme.muted }}>Pending</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: theme.muted }}>Remaining</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: theme.muted }}>Projected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {balances.map((b, i) => (
                      <tr key={`${b.userId}-${b.leaveType}`} style={{ borderBottom: `1px solid ${theme.line}`, background: i % 2 === 0 ? '#fff' : '#F9FAFB' }}>
                        <td style={{ padding: '8px 10px' }}><strong>{b.fullName}</strong><br /><span style={{ fontSize: 11, color: theme.muted }}>{b.email}</span></td>
                        <td style={{ padding: '8px 10px' }}>{BALANCE_LEAVE_TYPES.find(lt => lt.value === b.leaveType)?.label || b.leaveType}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{b.entitlementDays}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: b.adjustmentDays < 0 ? '#DC2626' : '#059669' }}>{b.adjustmentDays > 0 ? '+' : ''}{b.adjustmentDays}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{b.approvedUsedDays}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: '#D97706' }}>{b.pendingRequestedDays > 0 ? b.pendingRequestedDays : '-'}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: b.remainingDays < 0 ? '#DC2626' : b.remainingDays <= 5 ? '#D97706' : '#059669' }}>{b.remainingDays}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: b.projectedRemainingDays < 0 ? '#DC2626' : b.projectedRemainingDays <= 5 ? '#D97706' : '#059669' }}>{b.projectedRemainingDays}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
            <Card title="Set Entitlement" hint="Set leave entitlement for a staff user">
              <div style={{ display: 'grid', gap: 8 }}>
                <select style={styles.input} value={editEntitlement.userId} onChange={e => setEditEntitlement({ ...editEntitlement, userId: e.target.value })}>
                  <option value="">Select staff...</option>
                  {staff.map(m => <option key={m.userId} value={m.userId}>{m.fullName}</option>)}
                </select>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select style={{ ...styles.input, flex: 1 }} value={editEntitlement.leaveType} onChange={e => setEditEntitlement({ ...editEntitlement, leaveType: e.target.value })}>
                    {BALANCE_LEAVE_TYPES.map(lt => <option key={lt.value} value={lt.value}>{lt.label}</option>)}
                  </select>
                  <input type="number" style={{ ...styles.input, width: 100 }} placeholder="Year" value={editEntitlement.year} onChange={e => setEditEntitlement({ ...editEntitlement, year: e.target.value })} min={2000} max={2100} />
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="number" style={{ ...styles.input, flex: 1 }} placeholder="Entitlement days (0-365)" value={editEntitlement.days} onChange={e => setEditEntitlement({ ...editEntitlement, days: e.target.value })} min={0} max={365} />
                  <button type="button" style={styles.primaryButton} disabled={entitlementSaving} onClick={handleSetEntitlement}>{entitlementSaving ? 'Saving...' : 'Set'}</button>
                </div>
              </div>
            </Card>

            <Card title="Create Adjustment" hint="Positive or negative balance adjustment">
              <div style={{ display: 'grid', gap: 8 }}>
                <select style={styles.input} value={adjustment.userId} onChange={e => setAdjustment({ ...adjustment, userId: e.target.value })}>
                  <option value="">Select staff...</option>
                  {staff.map(m => <option key={m.userId} value={m.userId}>{m.fullName}</option>)}
                </select>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select style={{ ...styles.input, flex: 1 }} value={adjustment.leaveType} onChange={e => setAdjustment({ ...adjustment, leaveType: e.target.value })}>
                    {BALANCE_LEAVE_TYPES.map(lt => <option key={lt.value} value={lt.value}>{lt.label}</option>)}
                  </select>
                  <input type="number" style={{ ...styles.input, width: 100 }} placeholder="Year" value={adjustment.year} onChange={e => setAdjustment({ ...adjustment, year: e.target.value })} min={2000} max={2100} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="number" style={{ ...styles.input, flex: 1 }} placeholder="Days (-365 to 365)" value={adjustment.days} onChange={e => setAdjustment({ ...adjustment, days: e.target.value })} min={-365} max={365} />
                  <button type="button" style={styles.primaryButton} disabled={adjustmentSaving} onClick={handleCreateAdjustment}>{adjustmentSaving ? 'Saving...' : 'Add'}</button>
                </div>
                <input style={styles.input} placeholder="Optional reason (max 1000 chars)" value={adjustment.reason} onChange={e => setAdjustment({ ...adjustment, reason: e.target.value })} />
              </div>
            </Card>
          </div>
        </div>
      )}

      {hrTab === 'profiles' && (
        <div className="lf-split-grid" style={styles.splitGrid}>
          <Card title="Staff HR profiles" hint={`${profileCount} of ${staff.length} staff profiled`}>
            {loadError && <div style={{ ...styles.alert, ...styles.alertDanger, marginBottom: 12 }}>{loadError}</div>}
            {loading ? (
              <Skeleton rows={2} />
            ) : (
              <Table
                columns={['Name', 'Email', 'Role', 'HR Status', 'Job Title', 'Action']}
                rows={staff.map(member => [
                  <div key={`${member.userId}-name`} style={{ display: 'grid', gap: 2 }}>
                    <strong>{hrStaffName(member)}</strong>
                    <span style={{ color: theme.muted, fontSize: 12 }}>{member.isActive ? 'Active user' : 'Inactive user'}</span>
                  </div>,
                  member.email || '-',
                  member.role || '-',
                  <Badge key={`${member.userId}-status`} tone={hrStatusTone(member.profile?.hrStatus)}>{member.profile ? hrStatusLabel(member.profile.hrStatus) : 'No profile'}</Badge>,
                  member.profile?.jobTitle || '-',
                  <button key={`${member.userId}-select`} type="button" style={selectedUserId === member.userId ? styles.primaryButton : styles.ghostButton} onClick={() => setSelectedUserId(member.userId)}>Select</button>,
                ])}
                empty={staffEmptyText}
              />
            )}
          </Card>

          <Card title={selectedStaff ? `${selectedProfile ? 'Edit' : 'Create'} HR profile` : 'HR profile'} hint={selectedStaff ? hrStaffName(selectedStaff) : 'Select a staff member'}>
            {profileLoading ? (
              <Skeleton rows={1} />
            ) : selectedStaff ? (
              <>
                {!selectedProfile && <Empty title="No HR profile yet." text="Complete the form to create one for this staff member." />}
                <form onSubmit={submit} style={{ ...styles.formGrid, marginTop: selectedProfile ? 0 : 12 }}>
                  <Field label="Staff member">
                    <select style={styles.input} value={selectedUserId} onChange={e => setSelectedUserId(e.target.value)}>
                      {staff.map(member => <option key={member.userId} value={member.userId}>{hrStaffName(member)}</option>)}
                    </select>
                  </Field>
                  <Field label="Job title"><input style={styles.input} value={form.jobTitle} onChange={e => setForm({ ...form, jobTitle: e.target.value })} /></Field>
                  <Field label="Department"><input style={styles.input} value={form.department} onChange={e => setForm({ ...form, department: e.target.value })} /></Field>
                  <Field label="Practice team"><input style={styles.input} value={form.practiceTeam} onChange={e => setForm({ ...form, practiceTeam: e.target.value })} /></Field>
                  <Field label="Employment type">
                    <select style={styles.input} value={form.employmentType} onChange={e => setForm({ ...form, employmentType: e.target.value })}>
                      <option value="">Not set</option>
                      {hrEmploymentTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </Field>
                  <Field label="Start date"><input type="date" style={styles.input} value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></Field>
                  <Field label="Contract end date"><input type="date" style={styles.input} value={form.contractEndDate} onChange={e => setForm({ ...form, contractEndDate: e.target.value })} /></Field>
                  <Field label="Supervisor">
                    <select style={styles.input} value={form.supervisorUserId} onChange={e => setForm({ ...form, supervisorUserId: e.target.value })}>
                      <option value="">Not set</option>
                      {staff.map(member => <option key={member.userId} value={member.userId}>{hrStaffName(member)}</option>)}
                    </select>
                  </Field>
                  <Field label="Work email"><input type="email" style={styles.input} value={form.workEmail} onChange={e => setForm({ ...form, workEmail: e.target.value })} /></Field>
                  <Field label="Work phone"><input type="tel" style={styles.input} value={form.workPhone} onChange={e => setForm({ ...form, workPhone: e.target.value })} /></Field>
                  <Field label="Emergency contact name"><input style={styles.input} value={form.emergencyContactName} onChange={e => setForm({ ...form, emergencyContactName: e.target.value })} /></Field>
                  <Field label="Emergency contact phone"><input type="tel" style={styles.input} value={form.emergencyContactPhone} onChange={e => setForm({ ...form, emergencyContactPhone: e.target.value })} /></Field>
                  <Field label="HR status">
                    <select style={styles.input} value={form.hrStatus} onChange={e => setForm({ ...form, hrStatus: e.target.value })}>
                      {hrStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </Field>
                  <Field label="Admin notes">
                    <textarea rows={4} style={{ ...styles.input, minHeight: 104, resize: 'vertical' }} value={form.adminNotes} onChange={e => setForm({ ...form, adminNotes: e.target.value })} />
                  </Field>
                  <button style={styles.primaryButton} disabled={saving}>{saving ? 'Saving...' : selectedProfile ? 'Save HR profile' : 'Create HR profile'}</button>
                </form>
              </>
            ) : (
              <Empty title="No staff selected." text="Select a staff user to create or edit an HR profile." />
            )}
          </Card>
        </div>
      )}

      {hrTab === 'leaves' && (
        <Card title="Leave Requests" hint={`${leaveRequests.length} request${leaveRequests.length === 1 ? '' : ''}`}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.ink }}>Filter:</span>
            {['', 'pending', 'approved', 'rejected', 'cancelled'].map(s => (
              <button key={s} type="button" style={statusFilter === s ? styles.primaryButton : styles.ghostButton} onClick={() => setStatusFilter(s)}>
                {s ? s.charAt(0).toUpperCase() + s.slice(1) : 'All'}
              </button>
            ))}
          </div>
          {leaveLoading ? (
            <Skeleton rows={2} />
          ) : leaveRequests.length === 0 ? (
            <Empty title="No leave requests." text="Staff leave requests will appear here once submitted." />
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {leaveRequests.map(req => (
                <div key={req.id} style={{ border: `1px solid ${theme.line}`, borderRadius: 8, padding: 12, background: '#fff', display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ display: 'grid', gap: 2 }}>
                      <strong style={{ fontSize: 14 }}>{req.fullName} — {LEAVE_TYPE_LABELS[req.leaveType] || req.leaveType}</strong>
                      <span style={{ fontSize: 12, color: theme.muted }}>{req.startDate} → {req.endDate} · {req.days} day{Number(req.days) === 1 ? '' : 's'}</span>
                      <span style={{ fontSize: 11, color: '#9CA3AF' }}>{req.email} · {req.role}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Badge tone={leaveStatusTone(req.status)}>{req.status.charAt(0).toUpperCase() + req.status.slice(1)}</Badge>
                    </div>
                  </div>
                  {req.reason ? <div style={{ fontSize: 12, color: theme.ink, background: '#F9FAFB', borderRadius: 6, padding: '6px 10px' }}>{req.reason}</div> : null}
                  {req.decisionNote ? <div style={{ fontSize: 12, color: theme.muted, fontStyle: 'italic', background: '#F9FAFB', borderRadius: 6, padding: '6px 10px' }}>Note: {req.decisionNote}</div> : null}
                  {req.status === 'pending' && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input style={{ ...styles.input, width: 200, fontSize: 12, padding: '4px 8px' }} placeholder="Optional decision note" value={decisionNotes[req.id] || ''} onChange={e => setDecisionNotes(current => ({ ...current, [req.id]: e.target.value }))} />
                      <button type="button" style={{ ...styles.tinyButton, background: '#D1FAE5', color: '#065F46', border: '1px solid #A7F3D0' }} disabled={actioningId === `approve:${req.id}`} onClick={() => handleLeaveAction(req.id, 'approve')}>{actioningId === `approve:${req.id}` ? '...' : 'Approve'}</button>
                      <button type="button" style={{ ...styles.tinyButton, background: '#FEE2E2', color: '#991B1B', border: '1px solid #FECACA' }} disabled={actioningId === `reject:${req.id}`} onClick={() => handleLeaveAction(req.id, 'reject')}>{actioningId === `reject:${req.id}` ? '...' : 'Reject'}</button>
                      <button type="button" style={{ ...styles.dangerTinyButton }} disabled={actioningId === `cancel:${req.id}`} onClick={() => handleLeaveAction(req.id, 'cancel')}>{actioningId === `cancel:${req.id}` ? '...' : 'Cancel'}</button>
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: '#9CA3AF' }}>Requested: {new Date(req.requestedAt).toLocaleString()}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {hrTab === 'documents' && (
        <div className="lf-split-grid" style={styles.splitGrid}>
          <Card title="Upload HR document" hint="Stored privately; admin-only. Not linked to matters or the client portal.">
            <form onSubmit={handleUploadDocument} style={styles.formGrid}>
              <Field label="Staff member">
                <select style={styles.input} value={docUpload.userId} onChange={e => setDocUpload({ ...docUpload, userId: e.target.value })}>
                  <option value="">Select staff member</option>
                  {staff.map(member => <option key={member.userId} value={member.userId}>{hrStaffName(member)}</option>)}
                </select>
              </Field>
              <Field label="Document type">
                <select style={styles.input} value={docUpload.documentType} onChange={e => setDocUpload({ ...docUpload, documentType: e.target.value })}>
                  {HR_DOCUMENT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
              <Field label="Title"><input style={styles.input} maxLength={160} value={docUpload.title} onChange={e => setDocUpload({ ...docUpload, title: e.target.value })} placeholder="e.g. Employment contract 2026" /></Field>
              <Field label="File">
                <input type="file" accept={HR_DOCUMENT_ACCEPT} style={styles.input} onChange={e => handleDocFile(e.target.files?.[0] || null)} />
              </Field>
              {docUpload.fileName ? <div style={styles.formHelper}>Selected: {docUpload.fileName} ({docUpload.mimeType || 'unknown type'})</div> : null}
              <div style={styles.formHelper}>Accepted: PDF, PNG, JPEG, DOC, DOCX. Maximum 10 MB.</div>
              <button style={styles.primaryButton} disabled={docUploading}>{docUploading ? 'Uploading...' : 'Upload document'}</button>
            </form>
          </Card>

          <Card title="HR documents" hint={`${documents.length} document${documents.length === 1 ? '' : 's'}`}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <select aria-label="Filter documents by staff member" style={{ ...styles.input, width: 'auto', minWidth: 150 }} value={docFilterUser} onChange={e => setDocFilterUser(e.target.value)}>
                <option value="">All staff</option>
                {staff.map(member => <option key={member.userId} value={member.userId}>{hrStaffName(member)}</option>)}
              </select>
              <select aria-label="Filter documents by type" style={{ ...styles.input, width: 'auto', minWidth: 140 }} value={docFilterType} onChange={e => setDocFilterType(e.target.value)}>
                <option value="">All types</option>
                {HR_DOCUMENT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={docIncludeInactive} onChange={e => setDocIncludeInactive(e.target.checked)} />
                Include inactive
              </label>
            </div>
            {documentsLoading ? (
              <Skeleton rows={2} />
            ) : documents.length === 0 ? (
              <Empty title="No HR documents." text="Upload a document to get started." />
            ) : (
              <Table
                columns={['Staff', 'Type', 'Title', 'File', 'Size', 'Uploaded', 'Status', 'Actions']}
                rows={documents.map(doc => [
                  doc.staffName || doc.userId,
                  HR_DOCUMENT_TYPE_LABELS[doc.documentType] || doc.documentType,
                  doc.title,
                  <span key={`${doc.id}-file`} style={{ fontSize: 12, color: theme.muted }}>{doc.fileName}<br />{doc.mimeType}</span>,
                  doc.size || '-',
                  doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString() : '-',
                  <Badge key={`${doc.id}-status`} tone={doc.isActive ? 'green' : 'grey'}>{doc.isActive ? 'Active' : 'Inactive'}</Badge>,
                  <div key={`${doc.id}-actions`} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button type="button" style={styles.tinyButton} disabled={docActioningId === `download:${doc.id}` || !doc.isActive} onClick={() => handleDownloadDocument(doc)}>{docActioningId === `download:${doc.id}` ? '...' : 'Download'}</button>
                    {doc.isActive
                      ? <button type="button" style={styles.dangerTinyButton} disabled={docActioningId === `delete:${doc.id}`} onClick={() => handleDeleteDocument(doc)}>{docActioningId === `delete:${doc.id}` ? '...' : 'Deactivate'}</button>
                      : <button type="button" style={styles.tinyButton} disabled={docActioningId === `reactivate:${doc.id}`} onClick={() => handleReactivateDocument(doc)}>{docActioningId === `reactivate:${doc.id}` ? '...' : 'Reactivate'}</button>}
                  </div>,
                ])}
                empty="No HR documents."
              />
            )}
          </Card>
        </div>
      )}

      {hrTab === 'contracts' && (
        <div className="lf-split-grid" style={styles.splitGrid}>
          <Card title={contractEditingId ? 'Edit contract record' : 'Record contract'} hint="Admin-only. No salary or allowance details are stored.">
            <form onSubmit={handleSaveContract} style={styles.formGrid}>
              <Field label="Staff member">
                <select style={styles.input} value={contractForm.userId} disabled={Boolean(contractEditingId)} onChange={e => setContractForm({ ...contractForm, userId: e.target.value, documentId: '' })}>
                  <option value="">Select staff member</option>
                  {staff.map(member => <option key={member.userId} value={member.userId}>{hrStaffName(member)}</option>)}
                </select>
              </Field>
              <Field label="Contract type">
                <select style={styles.input} value={contractForm.contractType} onChange={e => setContractForm({ ...contractForm, contractType: e.target.value })}>
                  {HR_CONTRACT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
              <Field label="Start date"><input type="date" style={styles.input} value={contractForm.startDate} onChange={e => setContractForm({ ...contractForm, startDate: e.target.value })} /></Field>
              <Field label="End date"><input type="date" style={styles.input} value={contractForm.endDate} onChange={e => setContractForm({ ...contractForm, endDate: e.target.value })} /></Field>
              <Field label="Probation end date"><input type="date" style={styles.input} value={contractForm.probationEndDate} onChange={e => setContractForm({ ...contractForm, probationEndDate: e.target.value })} /></Field>
              <Field label="Renewal date"><input type="date" style={styles.input} value={contractForm.renewalDate} onChange={e => setContractForm({ ...contractForm, renewalDate: e.target.value })} /></Field>
              <Field label="Status">
                <select style={styles.input} value={contractForm.status} onChange={e => setContractForm({ ...contractForm, status: e.target.value })}>
                  {HR_CONTRACT_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
              <Field label="Linked HR document">
                <select style={styles.input} value={contractForm.documentId} onChange={e => setContractForm({ ...contractForm, documentId: e.target.value })} disabled={!contractForm.userId}>
                  <option value="">None</option>
                  {contractUserDocs.map(d => <option key={d.id} value={d.id}>{HR_DOCUMENT_TYPE_LABELS[d.documentType] || d.documentType}: {d.title}</option>)}
                </select>
              </Field>
              {contractForm.userId && contractUserDocs.length === 0 ? <div style={styles.formHelper}>No active contract/other documents for this staff member to link.</div> : null}
              <Field label="Notes">
                <textarea rows={4} maxLength={2000} style={{ ...styles.input, minHeight: 96, resize: 'vertical' }} value={contractForm.notes} onChange={e => setContractForm({ ...contractForm, notes: e.target.value })} />
              </Field>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button style={styles.primaryButton} disabled={contractSaving}>{contractSaving ? 'Saving...' : contractEditingId ? 'Save contract' : 'Record contract'}</button>
                {contractEditingId ? <button type="button" style={styles.ghostButton} onClick={resetContractForm}>Cancel edit</button> : null}
              </div>
            </form>
          </Card>

          <Card title="Contract records" hint={`${contracts.length} record${contracts.length === 1 ? '' : 's'}`}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <select aria-label="Filter contracts by staff member" style={{ ...styles.input, width: 'auto', minWidth: 150 }} value={contractFilterUser} onChange={e => setContractFilterUser(e.target.value)}>
                <option value="">All staff</option>
                {staff.map(member => <option key={member.userId} value={member.userId}>{hrStaffName(member)}</option>)}
              </select>
              <select aria-label="Filter contracts by status" style={{ ...styles.input, width: 'auto', minWidth: 140 }} value={contractFilterStatus} onChange={e => setContractFilterStatus(e.target.value)}>
                <option value="">All statuses</option>
                {HR_CONTRACT_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {contractsLoading ? (
              <Skeleton rows={2} />
            ) : contracts.length === 0 ? (
              <Empty title="No contract records." text="Record a contract to get started." />
            ) : (
              <Table
                columns={['Staff', 'Type', 'Dates', 'Status', 'Linked document', 'Action']}
                rows={contracts.map(contract => [
                  contract.staff?.fullName || contract.userId,
                  HR_CONTRACT_TYPE_LABELS[contract.contractType] || contract.contractType,
                  <span key={`${contract.id}-dates`} style={{ fontSize: 12, color: theme.muted }}>
                    {contract.startDate || '—'} → {contract.endDate || '—'}
                    {contract.probationEndDate ? <><br />Probation ends {contract.probationEndDate}</> : null}
                    {contract.renewalDate ? <><br />Renews {contract.renewalDate}</> : null}
                  </span>,
                  <Badge key={`${contract.id}-status`} tone={hrContractStatusTone(contract.status)}>{HR_CONTRACT_STATUS_LABELS[contract.status] || contract.status}</Badge>,
                  contract.document ? `${HR_DOCUMENT_TYPE_LABELS[contract.document.documentType] || contract.document.documentType}: ${contract.document.title}` : '—',
                  <button key={`${contract.id}-edit`} type="button" style={contractEditingId === contract.id ? styles.primaryButton : styles.ghostButton} onClick={() => startEditContract(contract)}>Edit</button>,
                ])}
                empty="No contract records."
              />
            )}
          </Card>
        </div>
      )}

      {hrTab === 'offboarding' && (
        <div className="lf-split-grid" style={styles.splitGrid}>
          <div style={{ display: 'grid', gap: 16 }}>
            <Card title="Start offboarding" hint="Admin-only. No user is deleted; records are preserved.">
              <form onSubmit={handleCreateOffboarding} style={styles.formGrid}>
                <Field label="Staff member">
                  <select style={styles.input} value={offboardingForm.userId} onChange={e => setOffboardingForm({ ...offboardingForm, userId: e.target.value })}>
                    <option value="">Select staff member</option>
                    {staff.map(member => <option key={member.userId} value={member.userId}>{hrStaffName(member)}{member.isActive ? '' : ' (inactive)'}</option>)}
                  </select>
                </Field>
                <Field label="Exit type"><input style={styles.input} maxLength={60} value={offboardingForm.exitType} onChange={e => setOffboardingForm({ ...offboardingForm, exitType: e.target.value })} placeholder="e.g. Voluntary" /></Field>
                <Field label="Reason category">
                  <select style={styles.input} value={offboardingForm.reasonCategory} onChange={e => setOffboardingForm({ ...offboardingForm, reasonCategory: e.target.value })}>
                    <option value="">Not set</option>
                    {HR_OFFBOARDING_REASON_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Exit date"><input type="date" style={styles.input} value={offboardingForm.exitDate} onChange={e => setOffboardingForm({ ...offboardingForm, exitDate: e.target.value })} /></Field>
                <Field label="Notes"><textarea rows={3} maxLength={2000} style={{ ...styles.input, minHeight: 72, resize: 'vertical' }} value={offboardingForm.notes} onChange={e => setOffboardingForm({ ...offboardingForm, notes: e.target.value })} /></Field>
                <button style={styles.primaryButton} disabled={offboardingCreating}>{offboardingCreating ? 'Creating...' : 'Start offboarding'}</button>
              </form>
            </Card>

            <Card title="Offboarding cases" hint={`${offboardingCases.length} case${offboardingCases.length === 1 ? '' : 's'}`}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                {['', 'open', 'in_progress', 'completed', 'cancelled'].map(s => (
                  <button key={s} type="button" style={offboardingStatusFilter === s ? styles.primaryButton : styles.ghostButton} onClick={() => setOffboardingStatusFilter(s)}>
                    {s ? HR_OFFBOARDING_STATUS_LABELS[s] : 'All'}
                  </button>
                ))}
              </div>
              {offboardingLoading ? (
                <Skeleton rows={2} />
              ) : offboardingCases.length === 0 ? (
                <Empty title="No offboarding cases." text="Start one from the form above." />
              ) : (
                <Table
                  columns={['Staff', 'Status', 'Type / reason', 'Exit date', 'Started', 'Action']}
                  rows={offboardingCases.map(c => [
                    c.staff?.fullName || c.userId,
                    <Badge key={`${c.id}-st`} tone={offboardingStatusTone(c.status)}>{HR_OFFBOARDING_STATUS_LABELS[c.status] || c.status}</Badge>,
                    <span key={`${c.id}-tr`} style={{ fontSize: 12, color: theme.muted }}>{c.exitType || '—'}{c.reasonCategory ? ` · ${HR_OFFBOARDING_REASON_LABELS[c.reasonCategory] || c.reasonCategory}` : ''}</span>,
                    c.exitDate || '—',
                    c.startedAt ? new Date(c.startedAt).toLocaleDateString() : '—',
                    <button key={`${c.id}-sel`} type="button" style={selectedCaseId === c.id ? styles.primaryButton : styles.ghostButton} onClick={() => setSelectedCaseId(c.id)}>Open</button>,
                  ])}
                  empty="No offboarding cases."
                />
              )}
            </Card>
          </div>

          <Card title={selectedCase ? `Offboarding — ${selectedCase.staff?.fullName || ''}` : 'Offboarding case'} hint={selectedCase ? (HR_OFFBOARDING_STATUS_LABELS[selectedCase.status] || selectedCase.status) : 'Select a case'}>
            {caseLoading ? (
              <Skeleton rows={3} />
            ) : !selectedCase ? (
              <Empty title="No case selected." text="Select a case to review and complete offboarding." />
            ) : (() => {
              const finalised = selectedCase.status === 'completed' || selectedCase.status === 'cancelled';
              const activeCount = assignedMatters ? assignedMatters.activeAssignedCount : null;
              const advocateOptions = staff.filter(m => m.role === 'advocate' && m.isActive && m.userId !== selectedCase.userId);
              return (
                <div style={{ display: 'grid', gap: 16 }}>
                  <div style={{ fontSize: 12, color: theme.muted, background: '#F9FAFB', borderRadius: 6, padding: '8px 10px' }}>
                    Closed and on-hold matters remain historical. Paralegal references are shown for review but not automatically changed in this phase.
                  </div>

                  <div style={{ display: 'grid', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Badge tone={offboardingStatusTone(selectedCase.status)}>{HR_OFFBOARDING_STATUS_LABELS[selectedCase.status] || selectedCase.status}</Badge>
                      <span style={{ fontSize: 12, color: theme.muted }}>{selectedCase.staff?.email} · {selectedCase.staff?.role} · {selectedCase.staff?.isActive ? 'Active' : 'Inactive'}</span>
                    </div>
                    {!finalised && (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <select aria-label="Case status" style={{ ...styles.input, width: 'auto', minWidth: 130 }} value={selectedCase.status} onChange={e => handleUpdateOffboardingField({ status: e.target.value })}>
                          <option value="open">Open</option>
                          <option value="in_progress">In progress</option>
                        </select>
                        <select aria-label="Reason category" style={{ ...styles.input, width: 'auto', minWidth: 150 }} value={selectedCase.reasonCategory || ''} onChange={e => handleUpdateOffboardingField({ reasonCategory: e.target.value })}>
                          <option value="">Reason: not set</option>
                          {HR_OFFBOARDING_REASON_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                    )}
                  </div>

                  <div>
                    <h4 style={{ margin: '0 0 8px', fontSize: 13, color: theme.ink }}>Checklist</h4>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {(selectedCase.checklist || []).map(item => (
                        <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', border: `1px solid ${theme.line}`, borderRadius: 6, padding: '6px 10px' }}>
                          <span style={{ fontSize: 13 }}>{item.label}</span>
                          <select aria-label={`${item.label} status`} disabled={finalised || offboardingActioning === `checklist:${item.id}`} style={{ ...styles.input, width: 'auto', minWidth: 120, fontSize: 12, padding: '4px 8px' }} value={item.status} onChange={e => handleChecklistChange(item.id, e.target.value)}>
                            {HR_OFFBOARDING_CHECKLIST_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h4 style={{ margin: '0 0 8px', fontSize: 13, color: theme.ink }}>Assigned matters review</h4>
                    {!assignedMatters ? (
                      <div style={{ color: theme.muted, fontSize: 12 }}>Loading matter review…</div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8, fontSize: 12 }}>
                          <span><strong>{assignedMatters.activeAssignedCount}</strong> active assigned</span>
                          <span><strong>{assignedMatters.closedOrOnHoldAssignedCount}</strong> closed / on-hold</span>
                          <span><strong>{assignedMatters.paralegalReferenceCount}</strong> paralegal references</span>
                        </div>
                        {assignedMatters.activeAssignedMatters && assignedMatters.activeAssignedMatters.length > 0 ? (
                          <div style={{ display: 'grid', gap: 6 }}>
                            {assignedMatters.activeAssignedMatters.map(m => (
                              <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', border: `1px solid ${theme.line}`, borderRadius: 6, padding: '6px 10px' }}>
                                <span style={{ fontSize: 12 }}><strong>{m.reference || m.id}</strong> — {m.title} <span style={{ color: theme.muted }}>({m.stage}{m.clientName ? ` · ${m.clientName}` : ''})</span></span>
                                {!finalised && (
                                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                    <select aria-label={`Reassign ${m.reference || m.id}`} style={{ ...styles.input, width: 'auto', minWidth: 140, fontSize: 12, padding: '4px 8px' }} value={reassignChoices[m.id] || ''} onChange={e => setReassignChoices(cur => ({ ...cur, [m.id]: e.target.value }))}>
                                      <option value="">Reassign to…</option>
                                      {advocateOptions.map(a => <option key={a.userId} value={a.fullName}>{a.fullName}</option>)}
                                    </select>
                                    <button type="button" style={{ ...styles.tinyButton }} disabled={offboardingActioning === `reassign:${m.id}` || !reassignChoices[m.id]} onClick={() => handleReassignMatter(m.id)}>{offboardingActioning === `reassign:${m.id}` ? '...' : 'Reassign'}</button>
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div style={{ color: theme.muted, fontSize: 12 }}>No active assigned matters.</div>
                        )}
                      </>
                    )}
                  </div>

                  {!finalised && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button type="button" style={styles.primaryButton} disabled={offboardingActioning === 'complete' || (activeCount !== null && activeCount > 0)} onClick={handleCompleteOffboarding}>
                        {offboardingActioning === 'complete' ? 'Completing...' : 'Complete offboarding'}
                      </button>
                      <button type="button" style={styles.dangerTinyButton} disabled={offboardingActioning === 'cancel'} onClick={handleCancelOffboarding}>
                        {offboardingActioning === 'cancel' ? '...' : 'Cancel case'}
                      </button>
                      {activeCount !== null && activeCount > 0 ? <span style={{ fontSize: 12, color: theme.muted }}>Reassign all active matters before completing.</span> : null}
                      <span style={{ fontSize: 12, color: theme.muted }}>Completion sets HR status to “exited”; the account is deactivated only when “Deactivate account” is marked done.</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </Card>
        </div>
      )}
    </div>
  );
}

export function Users({ clients = [], notify }) {
  const [users, setUsers] = useState([]);
  const [userLoadError, setUserLoadError] = useState('');
  const [form, setForm] = useState({ email: '', password: '', fullName: '', role: 'assistant', clientId: '' });
  const [includeInactive, setIncludeInactive] = useState(false);
  // PRODUCT-16B: client-side User Management filters (UI convenience only; no fetch/API/semantics change).
  const [userSearch, setUserSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  useEffect(() => { load(); }, [includeInactive]);
  async function load() {
    try {
      const response = await api(`/auth/users${includeInactive ? '?include_inactive=true' : ''}`);
      const normalizedUsers = listFromResponse(response, 'users');
      setUsers(normalizedUsers);
      setUserLoadError(Array.isArray(response) || Array.isArray(response?.users) ? '' : 'The users endpoint returned an unexpected response. Showing an empty team list.');
    } catch (err) {
      setUsers([]);
      setUserLoadError(err.message);
      notify({ type: 'danger', message: err.message });
    }
  }
  async function submit(event) { event.preventDefault(); try { await api('/auth/register', { method: 'POST', body: form }); setForm({ email: '', password: '', fullName: '', role: 'assistant', clientId: '' }); notify({ type: 'success', message: 'User created.' }); await load(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function updateRole(userId, newRole, fullName) {
    try {
      await api(`/auth/users/${userId}/role`, { method: 'PATCH', body: { role: newRole } });
      notify({ type: 'success', message: `Role updated for ${fullName}.` });
      await load();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function toggleActive(userId, isActive, fullName) {
    try {
      await api(`/auth/users/${userId}/toggle-active`, { method: 'PATCH', body: { isActive } });
      notify({ type: 'success', message: `${isActive ? 'Activated' : 'Deactivated'} ${fullName}.` });
      await load();
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function handleAvatarUpload(userId, file) {
    if (!file) return;
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) { notify({ type: 'danger', message: 'Only JPEG, PNG, and WebP images are supported.' }); return; }
    if (file.size > 512 * 1024) { notify({ type: 'danger', message: 'Image must be 512 KB or smaller.' }); return; }
    try {
      const dataUrl = await fileToDataUrl(file);
      await uploadUserAvatar(userId, dataUrl, file.type);
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, hasAvatar: true } : u));
      notify({ type: 'success', message: 'Photo uploaded.' });
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  async function handleAvatarRemove(userId, fullName) {
    try {
      await deleteUserAvatar(userId);
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, hasAvatar: false } : u));
      notify({ type: 'success', message: `Photo removed for ${fullName}.` });
    } catch (err) { notify({ type: 'danger', message: err.message }); }
  }
  const clientOptions = Array.isArray(clients) ? clients : [];
  const visibleUsers = Array.isArray(users) ? users : [];
  // PRODUCT-16B: filter the already-loaded users array only. Role values match stored values
  // (admin/advocate/assistant/client); status mirrors the existing isActive badge logic.
  const userQuery = userSearch.trim().toLowerCase();
  const filteredUsers = visibleUsers.filter(u => {
    if (roleFilter !== 'all' && u.role !== roleFilter) return false;
    if (statusFilter === 'active' && !u.isActive) return false;
    if (statusFilter === 'inactive' && u.isActive) return false;
    if (userQuery) {
      const haystack = `${u.fullName || ''} ${u.email || ''}`.toLowerCase();
      if (!haystack.includes(userQuery)) return false;
    }
    return true;
  });
  const userEmptyText = visibleUsers.length === 0 ? 'No users found.' : 'No users match these filters.';
  // PRODUCT-16I: choosing the Inactive status filter auto-loads inactive users via the existing
  // include_inactive fetch path. Active/All never force the broader scope back off once enabled.
  function handleStatusFilterChange(nextStatus) {
    setStatusFilter(nextStatus);
    if (nextStatus === 'inactive') setIncludeInactive(true);
  }
  return <div className="lf-split-grid" style={styles.splitGrid}>
    <Card title="Create user" hint="Role-based access"><form onSubmit={submit} style={styles.formGrid}>
      <Field label="Full name"><input required style={styles.input} value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} /></Field>
      <Field label="Email"><input required style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
      <Field label="Password"><input required type="password" style={styles.input} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>
      <Field label="Role"><select style={styles.input} value={form.role} onChange={e => setForm({ ...form, role: e.target.value, clientId: e.target.value === 'client' ? form.clientId : '' })}><option value="assistant">Assistant</option><option value="advocate">Advocate</option><option value="admin">Admin</option><option value="client">Client</option></select></Field>
      {form.role === 'client' && <><Field label="Linked Client"><select required style={styles.input} value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })}><option value="">Select client</option>{clientOptions.map(c => <option key={c.id}>{c.name}</option>)}</select></Field><div style={styles.formHelper}>Client users can view only the linked client's matters, documents, invoices, and messages. Share credentials manually after creating the account.</div></>}
      <button style={styles.primaryButton}>Create user</button>
    </form></Card>
    <Card title="Team" hint={`${visibleUsers.length} users`}>
      {userLoadError && <div style={{ ...styles.alert, ...styles.alertDanger, marginBottom: 12 }}>{userLoadError}</div>}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13 }}>
        <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} />
        Show inactive users
      </label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="search"
          aria-label="Search users by name or email"
          placeholder="Search users…"
          value={userSearch}
          onChange={e => setUserSearch(e.target.value)}
          style={{ flex: 1, minWidth: 150, border: `1px solid ${theme.line}`, borderRadius: 6, padding: '7px 11px', background: '#fff', fontSize: 13, outline: 'none' }}
        />
        <select aria-label="Filter users by role" value={roleFilter} onChange={e => setRoleFilter(e.target.value)} style={{ ...styles.input, width: 'auto', minWidth: 128 }}>
          <option value="all">All roles</option>
          <option value="admin">Admin</option>
          <option value="advocate">Advocate</option>
          <option value="assistant">Assistant</option>
          <option value="client">Client</option>
        </select>
        <select aria-label="Filter users by status" value={statusFilter} onChange={e => handleStatusFilterChange(e.target.value)} style={{ ...styles.input, width: 'auto', minWidth: 128 }}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <span style={{ fontSize: 12, color: '#697386' }}>Showing {filteredUsers.length} of {visibleUsers.length} users</span>
      </div>
      <div style={{ fontSize: 12, color: '#697386', marginBottom: 12 }}>Inactive users are loaded automatically when you choose the Inactive filter.</div>
      <div className="lf-user-cards">
        <Table columns={['Photo', 'Name', 'Email', 'Role', 'Status', 'Client', 'Actions']} rows={filteredUsers.map(u => [
          <UserAvatar key={`av-${u.id}`} userId={u.id} hasAvatar={u.hasAvatar} fullName={u.fullName} size={28} />,
          <div key={`name-${u.id}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>{u.fullName}</span>
            {u.role !== 'client' && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                <label style={{ cursor: 'pointer' }}>
                  <span style={{ ...styles.tinyButton, display: 'inline-block' }}>
                    {u.hasAvatar ? 'Change photo' : 'Upload photo'}
                  </span>
                  <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} onChange={e => { handleAvatarUpload(u.id, e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                {u.hasAvatar && <button style={styles.tinyButton} onClick={() => handleAvatarRemove(u.id, u.fullName)}>Remove photo</button>}
              </div>
            )}
          </div>,
          u.email,
          <select key={`role-${u.id}`} style={{ ...styles.input, width: 140 }} value={u.role} disabled={u.role === 'client'} onChange={e => updateRole(u.id, e.target.value, u.fullName)}>
            <option value="assistant">Assistant</option>
            <option value="advocate">Advocate</option>
            <option value="admin">Admin</option>
          </select>,
          <Badge key={`status-${u.id}`} tone={u.isActive ? 'green' : 'red'}>{u.isActive ? 'Active' : 'Inactive'}</Badge>,
          u.clientId ? clientOptions.find(c => c.id === u.clientId)?.name || u.clientId : '-',
          <div key={`actions-${u.id}`} style={{ display: 'flex', gap: 6 }}>
            <button style={styles.tinyButton} onClick={() => toggleActive(u.id, !u.isActive, u.fullName)}>{u.isActive ? 'Deactivate' : 'Activate'}</button>
          </div>,
        ])} empty={userEmptyText} />
      </div>
    </Card>
  </div>;
}

function ChecklistTemplateLibrary({ templates = [], form, setForm, editingTemplateId, saving, onSubmit, onEdit, onCancel, onAddItem, onUpdateItem, onRemoveItem, confirmDelete }) {
  return (
    <Card title="Checklist Template Library" hint="Reusable matter workflow presets">
      <form onSubmit={onSubmit} style={{ ...styles.formGrid, alignItems: 'end', marginBottom: 14 }}>
        <Field label="Template Name"><input required style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Practice"><input style={styles.input} value={form.practiceArea} onChange={e => setForm({ ...form, practiceArea: e.target.value })} /></Field>
        <Field label="Description"><input style={styles.input} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></Field>
        <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 8 }}>
          {form.items.map((item, index) => (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, alignItems: 'end' }}>
              <Field label={`Item ${index + 1}`}><input required style={styles.input} value={item.title} onChange={e => onUpdateItem(index, 'title', e.target.value)} /></Field>
              <Field label="Notes"><input style={styles.input} value={item.notes} onChange={e => onUpdateItem(index, 'notes', e.target.value)} /></Field>
              <Field label="Position"><input type="number" min="0" style={styles.input} value={item.position} onChange={e => onUpdateItem(index, 'position', e.target.value)} /></Field>
              <button type="button" style={styles.dangerTinyButton} onClick={() => onRemoveItem(index)}>Remove</button>
            </div>
          ))}
          <button type="button" style={styles.ghostButton} onClick={onAddItem}>Add template item</button>
        </div>
        <button style={styles.primaryButton} disabled={saving || !form.name.trim()}>{saving ? 'Saving...' : editingTemplateId ? 'Save template' : 'Create template'}</button>
        {editingTemplateId && <button type="button" style={styles.ghostButton} onClick={onCancel}>Cancel</button>}
      </form>
      {templates.length ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {templates.map(template => (
            <div key={template.id} style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 10, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
                  <strong>{template.name}</strong>
                  <span style={{ color: theme.muted, fontSize: 12 }}>{template.practiceArea || 'General'} / {(template.items || []).length} item(s)</span>
                  {template.description ? <span style={{ color: theme.muted, fontSize: 12 }}>{template.description}</span> : null}
                </div>
                <ActionGroup actions={[['Edit', () => onEdit(template)], ['Deactivate', () => confirmDelete(template)]]} />
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(template.items || []).map(item => <span key={item.id} style={{ border: `1px solid ${theme.line}`, borderRadius: 999, padding: '3px 8px', fontSize: 11 }}>{item.position ?? 0}. {item.title}</span>)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty title="No checklist templates." text="Create a reusable template before applying one to a matter." />
      )}
    </Card>
  );
}

function MatterChecklistPanel({ items = [], templates = [], canManage, canToggle, canApplyTemplate, selectedTemplateId, setSelectedTemplateId, onApplyTemplate, applyingTemplate, form, setForm, onAdd, editingItem, setEditingItem, onToggle, onSave, confirmDelete }) {
  const [completedOpen, setCompletedOpen] = useState(false);
  const completedCount = items.filter(item => Number(item.completed || 0) === 1).length;
  const completionPercent = items.length ? Math.round((completedCount / items.length) * 100) : 0;
  const openItems = items.filter(item => Number(item.completed || 0) !== 1);
  const completedItems = items.filter(item => Number(item.completed || 0) === 1);
  const completedItemsId = 'matter-completed-checklist-items';
  const checklistItem = (item) => {
    const completed = Number(item.completed || 0) === 1;
    const editing = editingItem?.id === item.id;
    const hasChecklistMeta = Boolean(item.dueDate || item.assignee);
    const completedMeta = completed
      ? [
          item.completedBy ? `Completed by ${item.completedBy}` : null,
          item.completedAt ? formatTimelineDate(item.completedAt) : null,
        ].filter(Boolean).join(' - ')
      : '';
    return (
      <div key={item.id} style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: completed ? '#F8FAFC' : '#fff', padding: 10, display: 'grid', gap: 8, minWidth: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 10, alignItems: 'start', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 }}>
            <input type="checkbox" aria-label={completed ? 'Reopen checklist item' : 'Complete checklist item'} checked={completed} disabled={!canToggle} onChange={() => onToggle(item)} style={{ marginTop: 2, flex: '0 0 auto' }} />
            <span style={{ display: 'grid', gap: 5, minWidth: 0 }}>
              {editing ? (
                <>
                  <input required style={styles.input} value={editingItem.title || ''} onChange={e => setEditingItem({ ...editingItem, title: e.target.value })} />
                  <textarea rows={2} style={{ ...styles.input, resize: 'vertical' }} value={editingItem.notes || ''} onChange={e => setEditingItem({ ...editingItem, notes: e.target.value })} />
                  <span style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, minWidth: 0 }}>
                    <span style={{ display: 'grid', gap: 4, minWidth: 0 }}>
                      <span style={{ color: theme.muted, fontSize: 11, fontWeight: 700 }}>Checklist due</span>
                      <input type="date" aria-label="Checklist due" style={styles.input} value={editingItem.dueDate || ''} onChange={e => setEditingItem({ ...editingItem, dueDate: e.target.value })} />
                    </span>
                    <span style={{ display: 'grid', gap: 4, minWidth: 0 }}>
                      <span style={{ color: theme.muted, fontSize: 11, fontWeight: 700 }}>Assignee</span>
                      <input aria-label="Assignee" style={styles.input} value={editingItem.assignee || ''} onChange={e => setEditingItem({ ...editingItem, assignee: e.target.value })} />
                    </span>
                  </span>
                  <input type="number" min="0" style={{ ...styles.input, maxWidth: 140 }} value={editingItem.position ?? 0} onChange={e => setEditingItem({ ...editingItem, position: e.target.value })} />
                </>
              ) : (
                <>
                  <strong style={{ color: completed ? theme.muted : theme.ink, textDecoration: completed ? 'line-through' : 'none', overflowWrap: 'anywhere' }}>{item.title}</strong>
                  {item.notes ? <span style={{ color: theme.muted, fontSize: 12, overflowWrap: 'anywhere' }}>{item.notes}</span> : null}
                  {hasChecklistMeta ? (
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minWidth: 0, color: theme.muted, fontSize: 12 }}>
                      {item.dueDate ? <span style={{ overflowWrap: 'anywhere' }}><strong>Checklist due:</strong> {formatTimelineDate(item.dueDate)}</span> : null}
                      {item.assignee ? <span style={{ overflowWrap: 'anywhere' }}><strong>Assignee:</strong> {item.assignee}</span> : null}
                    </span>
                  ) : null}
                  <span style={{ color: theme.muted, fontSize: 12, overflowWrap: 'anywhere' }}>Position {item.position ?? 0}</span>
                  {completedMeta ? <span style={{ color: theme.muted, fontSize: 12, overflowWrap: 'anywhere' }}>{completedMeta}</span> : null}
                </>
              )}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', minWidth: 0 }}>
            <Badge tone={completed ? 'green' : 'amber'}>{completed ? 'Done' : 'Open'}</Badge>
            {canManage && (editing ? (
              <ActionGroup actions={[['Save', () => onSave(item, editingItem)], ['Cancel', () => setEditingItem(null)]]} />
            ) : (
              <ActionGroup actions={[['Edit', () => setEditingItem({ ...item, position: item.position ?? 0, dueDate: String(item.dueDate || '').slice(0, 10), assignee: item.assignee || '' })], ['Delete', () => confirmDelete(item)]]} />
            ))}
          </div>
        </div>
      </div>
    );
  };
  const checklistSection = (title, sectionItems) => sectionItems.length ? (
    <section aria-label={title} style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: theme.muted, fontSize: 11, fontWeight: 700, letterSpacing: 0, textTransform: 'uppercase' }}>
        <span>{title}</span>
        <span style={{ height: 1, flex: '1 1 auto', background: theme.line }} />
      </div>
      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        {sectionItems.map(checklistItem)}
      </div>
    </section>
  ) : null;
  const completedChecklistSection = completedItems.length ? (
    <section aria-label="Completed items" style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: theme.muted, fontSize: 11, fontWeight: 700, letterSpacing: 0, textTransform: 'uppercase', flexWrap: 'wrap' }}>
        <span>Completed items</span>
        <span style={{ height: 1, flex: '1 1 auto', background: theme.line, minWidth: 40 }} />
        <span>{completedItems.length} done</span>
        <button
          type="button"
          aria-expanded={completedOpen}
          aria-controls={completedItemsId}
          onClick={() => setCompletedOpen(open => !open)}
          style={{ ...styles.ghostButton, fontSize: 12, padding: '4px 10px' }}
        >
          {completedOpen ? 'Hide completed' : 'Show completed'}
        </button>
      </div>
      <div id={completedItemsId} style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        {completedOpen ? (
          completedItems.map(checklistItem)
        ) : (
          <div style={{ border: `1px dashed ${theme.line}`, borderRadius: 8, padding: 12, color: theme.muted, fontSize: 13 }}>
            {completedItems.length} completed checklist item{completedItems.length === 1 ? '' : 's'} hidden to keep active work in view.
          </div>
        )}
      </div>
    </section>
  ) : null;
  return (
    <section aria-label="Matter checklist" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: theme.muted, fontSize: 12 }}>{completedCount} of {items.length} complete</span>
        {items.length > 0 && <Badge tone={completedCount === items.length ? 'green' : 'amber'}>{completedCount === items.length ? 'Done' : 'Open'}</Badge>}
      </div>
      {items.length > 0 && (
        <div role="progressbar" aria-label="Checklist progress" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={completedCount} style={{ height: 6, borderRadius: 999, background: '#E5E7EB', overflow: 'hidden', minWidth: 0 }}>
          <div style={{ width: `${completionPercent}%`, height: '100%', borderRadius: 999, background: completedCount === items.length ? theme.green : theme.blue }} />
        </div>
      )}
      {canApplyTemplate && (
        <form onSubmit={onApplyTemplate} style={{ ...styles.formGrid, alignItems: 'end' }}>
          <Field label="Apply Template">
            <select style={styles.input} value={selectedTemplateId} onChange={e => setSelectedTemplateId(e.target.value)}>
              <option value="">Select active template</option>
              {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
            </select>
          </Field>
          <button type="submit" style={styles.ghostButton} disabled={!selectedTemplateId || applyingTemplate}>{applyingTemplate ? 'Applying...' : 'Apply template'}</button>
        </form>
      )}
      {canManage && (
        <form onSubmit={onAdd} style={{ ...styles.formGrid, alignItems: 'end' }}>
          <Field label="Item"><input required style={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Notes"><input style={styles.input} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></Field>
          <Field label="Checklist due"><input type="date" style={styles.input} value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></Field>
          <Field label="Assignee"><input style={styles.input} value={form.assignee} onChange={e => setForm({ ...form, assignee: e.target.value })} /></Field>
          <Field label="Position"><input type="number" min="0" style={styles.input} value={form.position} onChange={e => setForm({ ...form, position: e.target.value })} /></Field>
          <button type="submit" style={styles.ghostButton} disabled={!form.title.trim()}>Add item</button>
        </form>
      )}
      {!items.length ? (
        <Empty title="No checklist items." text="Once records exist, they will appear here." />
      ) : (
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          {checklistSection('Open items', openItems)}
          {completedChecklistSection}
        </div>
      )}
    </section>
  );
}

function TaskEditorList({ tasks, entries = [], matter, canManage, canViewBilling = true, editingTask, setEditingTask, saveTask, toggle, confirmDelete, taskTimer, setTaskTimer, notify, onTimerSaved, emptyTitle = 'No tasks yet.', emptyText = 'Once records exist, they will appear here.' }) {
  if (!tasks.length) return <Empty title={emptyTitle} text={emptyText} />;
  const warmBorder = '1px solid #DDD8CE';
  const warmHeadBg = '#F5F2EB';
  const warmCellPad = '11px 14px';
  return (
    <div className="lf-task-cards" style={{ ...styles.tableWrap, background: '#fff', border: warmBorder, minWidth: 0, maxWidth: '100%' }}>
      <table style={styles.table}>
        <thead><tr>{['Task', 'Assignee', 'Due', 'Status', 'Timer', 'Actions'].map(h => <th key={h} style={{ background: warmHeadBg, borderBottom: warmBorder, padding: '10px 14px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, color: '#6B7280' }}>{h}</th>)}</tr></thead>
        <tbody>{tasks.map(task => {
          const editing = editingTask?.id === task.id;
          const taskEntries = entries.filter(entry => entry.taskId === task.id);
          const isTiming = taskTimerActive(taskTimer, task.id);
          return (
            <tr key={task.id} id={`task-${task.id}`} style={{ borderLeft: `4px solid ${isTiming ? theme.green : 'transparent'}`, transition: 'border-color .18s ease, background .18s ease' }}>
              <td style={{ padding: warmCellPad, verticalAlign: 'middle' }}>{editing ? <input style={styles.input} value={editingTask.title || ''} onChange={e => setEditingTask({ ...editingTask, title: e.target.value })} /> : <div style={{ display: 'grid', gap: 4 }}><strong style={{ fontSize: 13.5 }}>{task.title}</strong>{taskEntries.length > 0 && <small style={{ color: theme.muted, fontSize: 12 }}>{taskEntries.reduce((sum, entry) => sum + Number(entry.hours || 0), 0).toFixed(2)} hours logged from {taskEntries.length} entr{taskEntries.length === 1 ? 'y' : 'ies'}</small>}</div>}</td>
              <td style={{ padding: warmCellPad, verticalAlign: 'middle' }}>{editing ? <input style={styles.input} value={editingTask.assignee || ''} onChange={e => setEditingTask({ ...editingTask, assignee: e.target.value })} /> : <span style={{ fontWeight: 500 }}>{task.assignee || '-'}</span>}</td>
              <td style={{ padding: warmCellPad, verticalAlign: 'middle' }}>{editing ? <input type="date" style={styles.input} value={editingTask.dueDate || ''} onChange={e => setEditingTask({ ...editingTask, dueDate: e.target.value })} /> : <span>{task.dueDate || '-'}</span>}</td>
              <td style={{ padding: warmCellPad, verticalAlign: 'middle' }}><Badge tone={task.completed ? 'green' : 'amber'}>{task.completed ? 'Done' : 'Open'}</Badge></td>
              <td style={{ padding: warmCellPad, verticalAlign: 'middle' }}>{canManage && matter ? <TaskTimer task={{ ...task, timeEntries: taskEntries }} matterId={matter.id} matterRate={canViewBilling ? matter.billingRate || 15000 : 0} showRate={canViewBilling} timer={taskTimer} setTimer={setTaskTimer} notify={notify} onSaved={onTimerSaved} /> : '-'}</td>
              <td style={{ padding: warmCellPad, verticalAlign: 'middle' }}>{canManage ? editing ? <ActionGroup actions={[['Save', () => saveTask(task, editingTask)], ['Cancel', () => setEditingTask(null)]]} /> : <ActionGroup actions={[[task.completed ? 'Reopen' : 'Complete', () => toggle ? toggle(task) : saveTask(task, { completed: !task.completed })], ['Edit', () => setEditingTask({ ...task })], ['Delete', () => confirmDelete(task)]]} /> : '-'}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function AppearanceEditorList({ events, canManage, editingEvent, setEditingEvent, saveEvent, confirmDelete }) {
  if (!events.length) return <Empty title="No court appearances." text="Scheduled appearances will appear here." />;
  return (
    <div style={{ ...styles.tableWrap, minWidth: 0, maxWidth: '100%' }} className="lf-appearance-cards">
      <table style={styles.table}>
        <thead><tr>{['Title', 'Date', 'Time', 'Type', 'Location', 'Virtual Court', 'Actions'].map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{events.map(event => {
          const editing = editingEvent?.id === event.id;
          return (
            <tr key={event.id}>
              <td>{editing ? <input style={styles.input} value={editingEvent.title || ''} onChange={e => setEditingEvent({ ...editingEvent, title: e.target.value })} /> : event.title || '-'}</td>
              <td>{editing ? <input type="date" style={styles.input} value={editingEvent.date || ''} onChange={e => setEditingEvent({ ...editingEvent, date: e.target.value })} /> : event.date || '-'}</td>
              <td>{editing ? <input style={styles.input} value={editingEvent.time || ''} onChange={e => setEditingEvent({ ...editingEvent, time: e.target.value })} /> : event.time || '-'}</td>
              <td>{editing ? <input style={styles.input} value={editingEvent.type || ''} onChange={e => setEditingEvent({ ...editingEvent, type: e.target.value })} /> : event.type || '-'}</td>
              <td>{editing ? <input style={styles.input} value={editingEvent.location || ''} onChange={e => setEditingEvent({ ...editingEvent, location: e.target.value })} /> : event.location || '-'}</td>
              <td>{editing ? <input type="url" placeholder="https://..." style={styles.input} value={editingEvent.meetingLink || ''} onChange={e => setEditingEvent({ ...editingEvent, meetingLink: e.target.value })} /> : <MeetingLink event={event} />}</td>
              <td>{canManage ? editing ? <ActionGroup actions={[['Save', () => saveEvent(event, editingEvent)], ['Cancel', () => setEditingEvent(null)]]} /> : <ActionGroup actions={[['Edit', () => setEditingEvent({ ...event })], ['Delete', () => confirmDelete(event)]]} /> : '-'}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function TimeEntryEditorList({ entries, canManage, canViewBilling = true, editingTime, setEditingTime, saveTimeEntry, confirmDelete }) {
  if (!entries.length) return <Empty title="No time entries." text="Logged time will appear here." />;
  const columns = ['Date', 'Description', 'Hours', ...(canViewBilling ? ['Rate'] : []), 'Billing class', 'Invoice status', 'Actions'];
  const warmBorder = '1px solid #DDD8CE';
  const warmHeadBg = '#F5F2EB';
  const warmCellPad = '11px 14px';
  return (
    <div className={`lf-time-entry-cards${canViewBilling ? '' : ' lf-time-entry-cards-no-rate'}`} style={{ ...styles.tableWrap, background: '#fff', border: warmBorder, minWidth: 0, maxWidth: '100%' }}>
      <table style={styles.table}>
        <thead><tr>{columns.map(h => <th key={h} style={{ background: warmHeadBg, borderBottom: warmBorder, padding: '10px 14px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, color: '#6B7280' }}>{h}</th>)}</tr></thead>
        <tbody>{entries.map(entry => {
          const editing = editingTime?.id === entry.id;
          return (
            <tr key={entry.id}>
              <td style={{ padding: warmCellPad, verticalAlign: 'middle' }}>{editing ? <input type="date" style={styles.input} value={editingTime.date || ''} onChange={e => setEditingTime({ ...editingTime, date: e.target.value })} /> : <span style={{ fontWeight: 500 }}>{entry.date || '-'}</span>}</td>
              <td style={{ padding: warmCellPad, verticalAlign: 'middle' }}>{editing ? <input style={styles.input} value={editingTime.description || ''} onChange={e => setEditingTime({ ...editingTime, description: e.target.value })} /> : <span>{entry.description || entry.activity || '-'}{entry.taskId ? <small style={{ display: 'block', color: theme.muted, fontSize: 12 }}>Task: {entry.taskId}</small> : null}</span>}</td>
              <td style={{ padding: warmCellPad, verticalAlign: 'middle', fontWeight: 600 }}>{editing ? <input type="number" step="0.1" style={styles.input} value={editingTime.hours || 0} onChange={e => setEditingTime({ ...editingTime, hours: Number(e.target.value) })} /> : Number(entry.hours || 0).toFixed(1)}</td>
              {canViewBilling && <td style={{ padding: warmCellPad, verticalAlign: 'middle' }}>{editing ? <input type="number" style={styles.input} value={editingTime.rate || 0} onChange={e => setEditingTime({ ...editingTime, rate: Number(e.target.value) })} /> : <span style={{ fontWeight: 600 }}>{kes(entry.rate)}</span>}</td>}
              <td style={{ padding: warmCellPad, verticalAlign: 'middle' }}>{editing ? <select style={styles.tableSelect} value={isBillableValue(editingTime.billable) ? 'billable' : 'non_billable'} onChange={e => setEditingTime({ ...editingTime, billable: e.target.value === 'billable' })}><option value="billable">Billable</option><option value="non_billable">Non-billable</option></select> : <BillableBadge value={entry.billable} />}</td>
              <td style={{ padding: warmCellPad, verticalAlign: 'middle' }}><Badge tone={entry.billed ? 'green' : 'amber'}>{entry.billed ? 'Billed' : 'Unbilled'}</Badge></td>
              <td style={{ padding: warmCellPad, verticalAlign: 'middle' }}>{canManage ? editing ? <ActionGroup actions={[['Save', () => saveTimeEntry(entry, editingTime)], ['Cancel', () => setEditingTime(null)]]} /> : <ActionGroup actions={[[entry.billed ? 'Unbill' : 'Bill', () => saveTimeEntry(entry, { billed: !entry.billed })], ['Edit', () => setEditingTime({ ...entry })], ['Delete', () => confirmDelete(entry)]]} /> : '-'}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

// PRODUCT-18C: the Assistant tab now leads with the richer structured client hints
// (severity/category/why/evidence) grouped by severity tier, and keeps the server suggestion
// strings verbatim below as secondary context. Presentation only — no rule logic, money, or
// legal-advice wording is added; any SOL/limitation hedge in a hint or suggestion renders as-is.
function AssistantSuggestions({ suggestions, hints = [] }) {
  const tiers = [
    { key: 'priority', label: 'Priority', match: s => s === 'critical' || s === 'high' },
    { key: 'recommended', label: 'Recommended', match: s => s === 'medium' },
    { key: 'awareness', label: 'For awareness', match: s => s !== 'critical' && s !== 'high' && s !== 'medium' },
  ];
  const groups = tiers
    .map(tier => ({ ...tier, items: (Array.isArray(hints) ? hints : []).filter(h => tier.match(h.severity)) }))
    .filter(group => group.items.length);
  // The server emits the "up to date / no urgent" string only as its empty-state sentinel
  // (never alongside real suggestions). Treat it as the empty marker, not a dropped suggestion;
  // every genuine server suggestion is kept verbatim below.
  const serverItems = (Array.isArray(suggestions) ? suggestions : []).filter(text => {
    const lower = String(text).toLowerCase();
    return !(lower.includes('up to date') || lower.includes('no urgent'));
  });
  const hasContent = groups.length > 0 || serverItems.length > 0;
  const groupHeading = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: theme.muted };
  return (
    <div style={styles.assistantPanel}>
      <div style={styles.assistantIntro}>
        <strong>Matter Assistant</strong>
        <span>Rule-based prompts drawn from tasks, billing, documents, notes, and upcoming court dates.</span>
      </div>
      {!hasContent ? (
        <div style={styles.suggestionList}>
          <div style={{ ...styles.suggestionItem, ...styles.suggestionGood }}>
            <span style={styles.suggestionIcon}>OK</span>
            <span>This matter looks up to date. No urgent action is needed right now.</span>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {groups.map(group => (
            <div key={group.key} style={{ display: 'grid', gap: 8 }}>
              <span style={groupHeading}>{group.label}</span>
              {group.items.map((hint, index) => {
                const tone = hintTone(hint.severity);
                return (
                  <div key={`${hint.title}-${index}`} style={{ border: `1px solid ${theme.line}`, borderLeft: `4px solid ${timelineToneColor(tone)}`, borderRadius: 8, background: '#F8FAFC', padding: 10, display: 'grid', gap: 7 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <Badge tone={tone}>{hintLabel(hint.severity)}</Badge>
                      <Badge tone="blue">{hintLabel(hint.category)}</Badge>
                    </div>
                    <strong style={{ fontSize: 13 }}>{hint.title}</strong>
                    <span style={{ color: theme.muted, fontSize: 12 }}>{hint.why}</span>
                    {(hint.evidence || []).length ? (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {(hint.evidence || []).map((item, itemIndex) => (
                          <span key={`${item}-${itemIndex}`} style={{ border: `1px solid ${theme.line}`, background: '#fff', borderRadius: 999, color: theme.ink, fontSize: 11, fontWeight: 700, padding: '3px 8px' }}>{item}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
          {serverItems.length ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <span style={groupHeading}>Additional context-based suggestions</span>
              <div style={styles.suggestionList}>
                {serverItems.map((text, index) => {
                  const lower = String(text).toLowerCase();
                  const isGood = lower.includes('up to date') || lower.includes('no urgent');
                  const isWarning = lower.includes('overdue') || lower.includes('court') || lower.includes('hearing') || lower.includes('retainer') || lower.includes('outstanding');
                  return (
                    <div key={`${text}-${index}`} style={{ ...styles.suggestionItem, ...(isWarning ? styles.suggestionWarning : isGood ? styles.suggestionGood : {}) }}>
                      <span style={styles.suggestionIcon}>{isGood ? 'OK' : isWarning ? '!' : 'TIP'}</span>
                      <span>{text}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function hintTone(severity) {
  if (severity === 'critical' || severity === 'high') return 'red';
  if (severity === 'medium') return 'amber';
  return 'blue';
}

function hintLabel(value) {
  return String(value || '').replace(/-/g, ' ');
}

function MatterNextStepPanel({ detail }) {
  const step = useMemo(() => computeNextStep(detail), [detail]);
  if (!step) return null;
  return (
    <section aria-label="Next step" style={{ border: `1px solid ${theme.line}`, borderLeft: `4px solid ${theme.gold || '#D4A34A'}`, borderRadius: 10, padding: 14, background: '#fff', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 2 }}>
          <strong style={{ fontSize: 13 }}>Next step</strong>
          <span style={{ color: theme.muted, fontSize: 12 }}>{step.reason}</span>
        </div>
        <button type="button" onClick={() => scrollToSection(step.sectionId)} style={{ ...styles.primaryButton, fontSize: 12, padding: '6px 14px', whiteSpace: 'nowrap' }} aria-label={step.title}>
          {step.actionLabel}
        </button>
      </div>
      <span style={{ fontSize: 14, color: theme.ink }}>{step.title}</span>
    </section>
  );
}

function MatterCourtPrepCard({ detail }) {
  const appearances = Array.isArray(detail?.appearances) ? detail.appearances : [];
  const tasks = Array.isArray(detail?.tasks) ? detail.tasks : [];
  const documents = Array.isArray(detail?.documents) ? detail.documents : [];
  const notes = Array.isArray(detail?.notes) ? detail.notes : [];
  const today = isoDateOnly();
  const upcoming = appearances.filter(a => a.date && a.date >= today).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const nextAppearance = upcoming[0];
  const openTasks = tasks.filter(t => !t.completed);
  const chips = [];
  if (openTasks.length) chips.push({ label: `${openTasks.length} task${openTasks.length === 1 ? '' : 's'} open` });
  if (documents.length) chips.push({ label: 'Documents available' });
  if (notes.length) chips.push({ label: 'Notes available' });
  const cardStyle = { border: `1px solid ${theme.line}`, borderLeft: `4px solid ${theme.gold}`, borderRadius: 10, padding: 14, background: '#fff', display: 'grid', gap: 8 };
  const chipStyle = { border: `1px solid ${theme.line}`, background: '#fff', borderRadius: 999, color: theme.ink, fontSize: 11, fontWeight: 700, padding: '3px 8px' };
  if (!nextAppearance) {
    return (
      <section aria-label="Court prep" style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 2 }}>
            <strong style={{ fontSize: 13 }}>Court prep</strong>
            <span style={{ color: theme.muted, fontSize: 12 }}>No upcoming court date recorded for this matter.</span>
          </div>
          <button type="button" onClick={() => scrollToSection('matter-section-court')} style={{ ...styles.primaryButton, fontSize: 12, padding: '6px 14px', whiteSpace: 'nowrap' }} aria-label="Add or check court dates">Add/check court dates</button>
        </div>
        {chips.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{chips.map((c, i) => <span key={i} style={chipStyle}>{c.label}</span>)}</div>}
      </section>
    );
  }
  return (
    <section aria-label="Court prep" style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 2 }}>
          <strong style={{ fontSize: 13 }}>Next court prep</strong>
          <span style={{ color: theme.muted, fontSize: 12 }}>{nextAppearance.type || 'Appearance'} on {nextAppearance.date}{nextAppearance.time ? ` at ${nextAppearance.time}` : ''}{nextAppearance.location ? ` — ${nextAppearance.location}` : ''}</span>
        </div>
        <button type="button" onClick={() => scrollToSection('matter-section-court')} style={{ ...styles.primaryButton, fontSize: 12, padding: '6px 14px', whiteSpace: 'nowrap' }} aria-label="Go to court section">Go to court section</button>
      </div>
      <span style={{ fontSize: 14, color: theme.ink }}>{nextAppearance.title || `${nextAppearance.type || 'Court'} preparation`}</span>
      {safeHttpUrl(nextAppearance.meetingLink) && <a href={safeHttpUrl(nextAppearance.meetingLink)} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: theme.blue, textDecoration: 'underline' }}>Virtual court link</a>}
      {chips.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{chips.map((c, i) => <span key={i} style={chipStyle}>{c.label}</span>)}</div>}
    </section>
  );
}

function MatterKeyDocumentsPanel({ detail }) {
  const documents = Array.isArray(detail?.documents) ? detail.documents : [];
  const sorted = [...documents].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const shown = sorted.slice(0, 5);
  const cardStyle = { border: `1px solid ${theme.line}`, borderLeft: `4px solid ${theme.gold}`, borderRadius: 10, padding: 14, background: '#fff', display: 'grid', gap: 8 };
  if (!shown.length) {
    return (
      <section aria-label="Key documents" style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 2 }}>
            <strong style={{ fontSize: 13 }}>Key documents</strong>
            <span style={{ color: theme.muted, fontSize: 12 }}>No documents recorded for this matter yet.</span>
          </div>
          <button type="button" onClick={() => scrollToSection('matter-section-documents')} style={{ ...styles.primaryButton, fontSize: 12, padding: '6px 14px', whiteSpace: 'nowrap' }} aria-label="Go to documents section">Go to documents</button>
        </div>
      </section>
    );
  }
  return (
    <section aria-label="Key documents" style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>Key documents</strong>
        <button type="button" onClick={() => scrollToSection('matter-section-documents')} style={{ ...styles.primaryButton, fontSize: 12, padding: '6px 14px', whiteSpace: 'nowrap' }} aria-label="Go to documents section">Go to documents</button>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {shown.map(doc => (
          <div key={doc.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', borderBottom: `1px solid ${theme.line}`, paddingBottom: 6, flexWrap: 'wrap' }}>
            <div style={{ display: 'grid', gap: 1, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: theme.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.displayName || doc.friendlyName || doc.name || 'Document'}</span>
              <span style={{ fontSize: 11, color: theme.muted }}>{doc.date || ''}{doc.source ? ` · ${doc.source}` : ''}</span>
            </div>
            <span style={{ fontSize: 11, color: theme.muted, whiteSpace: 'nowrap', flexShrink: 0 }}>{doc.clientVisible ? 'Shared' : doc.source === 'client' ? 'Client upload' : 'Internal'}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MatterBillingSnapshot({ detail }) {
  const timeEntries = Array.isArray(detail?.timeEntries) ? detail.timeEntries : [];
  const invoices = Array.isArray(detail?.invoices) ? detail.invoices : [];
  const totalHours = timeEntries.reduce((s, e) => s + Number(e.hours || 0), 0);
  const unbilledCount = timeEntries.filter(e => !e.billed).length;
  const invoiceCount = invoices.length;
  const outstandingCount = invoices.filter(i => i.status === 'Outstanding' || i.status === 'Overdue').length;
  const paidCount = invoices.filter(i => i.status === 'Paid').length;
  const hasBilling = totalHours > 0 || invoiceCount > 0;
  const cardStyle = { border: `1px solid ${theme.line}`, borderLeft: `4px solid ${theme.blue}`, borderRadius: 10, padding: 14, background: '#fff', display: 'grid', gap: 8 };
  if (!hasBilling) {
    return (
      <section aria-label="Billing snapshot" style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 2 }}>
            <strong style={{ fontSize: 13 }}>Billing snapshot</strong>
            <span style={{ color: theme.muted, fontSize: 12 }}>No billing activity recorded for this matter yet.</span>
          </div>
          <button type="button" onClick={() => scrollToSection(invoiceCount ? 'matter-section-invoices' : 'matter-section-time')} style={{ ...styles.primaryButton, fontSize: 12, padding: '6px 14px', whiteSpace: 'nowrap' }} aria-label={invoiceCount ? 'Go to invoices' : 'Go to time entries'}>{invoiceCount ? 'Go to invoices' : 'Go to time entries'}</button>
        </div>
      </section>
    );
  }
  return (
    <section aria-label="Billing snapshot" style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>Billing snapshot</strong>
        <button type="button" onClick={() => scrollToSection(invoiceCount ? 'matter-section-invoices' : 'matter-section-time')} style={{ ...styles.primaryButton, fontSize: 12, padding: '6px 14px', whiteSpace: 'nowrap' }} aria-label={invoiceCount ? 'Go to invoices' : 'Go to time entries'}>{invoiceCount ? 'Go to invoices' : 'Go to time entries'}</button>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {totalHours > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', borderBottom: `1px solid ${theme.line}`, paddingBottom: 6 }}>
            <span style={{ fontSize: 12, color: theme.muted }}>Logged hours</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.ink }}>{totalHours.toFixed(1)}h</span>
          </div>
        )}
        {unbilledCount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', borderBottom: `1px solid ${theme.line}`, paddingBottom: 6 }}>
            <span style={{ fontSize: 12, color: theme.muted }}>Unbilled entries</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.ink }}>{unbilledCount}</span>
          </div>
        )}
        {invoiceCount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', paddingBottom: 0 }}>
            <span style={{ fontSize: 12, color: theme.muted }}>Invoices</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.ink }}>{invoiceCount} ({paidCount} paid{outstandingCount ? `, ${outstandingCount} outstanding` : ''})</span>
          </div>
        )}
      </div>
    </section>
  );
}

function MatterNextActionHints({ hints = [] }) {
  const [hintsOpen, setHintsOpen] = useState(false);
  const visibleHints = hints.slice(0, 5);
  const hintsBodyId = 'matter-next-action-hints-list';

  return (
    <section aria-label="Matter Next-Action Hints" style={{ border: `1px solid ${theme.line}`, background: '#fff', borderRadius: 10, padding: 14, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 2 }}>
          <strong style={{ fontSize: 13 }}>Next-Action Hints</strong>
          <span style={{ color: theme.muted, fontSize: 12 }}>Rule-based from current matter detail only.</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Badge tone="blue">{visibleHints.length} shown</Badge>
          <button
            type="button"
            aria-expanded={hintsOpen}
            aria-controls={hintsBodyId}
            onClick={() => setHintsOpen(open => !open)}
            style={{ ...styles.ghostButton, fontSize: 12, padding: '4px 10px' }}
          >
            {hintsOpen ? 'Hide hints' : 'Show hints'}
          </button>
        </div>
      </div>
      <div id={hintsBodyId}>
        {!hintsOpen ? (
          <div style={{ border: `1px dashed ${theme.line}`, borderRadius: 8, padding: 12, color: theme.muted, fontSize: 13 }}>
            {visibleHints.length ? 'Review next-action hints when you need rule-based prompts from current matter signals.' : 'Matter appears current from available signals.'}
          </div>
        ) : visibleHints.length ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {visibleHints.map((hint, index) => {
              const tone = hintTone(hint.severity);
              return (
                <div key={`${hint.title}-${index}`} style={{ border: `1px solid ${theme.line}`, borderLeft: `4px solid ${timelineToneColor(tone)}`, borderRadius: 8, background: '#F8FAFC', padding: 10, display: 'grid', gap: 7 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Badge tone={tone}>{hintLabel(hint.severity)}</Badge>
                    <Badge tone="blue">{hintLabel(hint.category)}</Badge>
                  </div>
                  <strong style={{ fontSize: 13 }}>{hint.title}</strong>
                  <span style={{ color: theme.muted, fontSize: 12 }}>{hint.why}</span>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(hint.evidence || []).map((item, itemIndex) => (
                      <span key={`${item}-${itemIndex}`} style={{ border: `1px solid ${theme.line}`, background: '#fff', borderRadius: 999, color: theme.ink, fontSize: 11, fontWeight: 700, padding: '3px 8px' }}>{item}</span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <span style={{ color: theme.muted, fontSize: 12 }}>Matter appears current from available signals.</span>
        )}
      </div>
    </section>
  );
}

function MatterCommandSummary({ detail, nextActionHints = [] }) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summary = useMemo(() => {
    const today = isoDateOnly();
    const notes = detail?.notes || [];
    const entries = detail?.timeEntries || [];
    const appearances = detail?.appearances || [];
    const documents = detail?.documents || [];
    const invoices = detail?.invoices || [];
    const tasks = detail?.tasks || [];

    const latestCandidates = [
      ...notes.map(note => ({ label: `Case note by ${note.author || 'staff'}`, at: note.createdAt })),
      ...entries.map(entry => ({ label: `Time entry (${Number(entry.hours || 0).toFixed(1)}h)`, at: entry.date })),
      ...documents.map(doc => ({ label: `Document: ${doc.displayName || doc.name || 'File'}`, at: doc.date })),
      ...invoices.map(invoice => ({ label: `Invoice ${invoice.number || invoice.id}`, at: invoice.date })),
      ...appearances.map(event => ({ label: `Court event: ${event.title || event.type || 'Appearance'}`, at: event.date })),
    ].map(item => ({ ...item, parsed: parseDateValue(item.at) })).filter(item => item.parsed);

    latestCandidates.sort((a, b) => b.parsed.getTime() - a.parsed.getTime());
    const lastActivity = latestCandidates[0];

    const upcomingAppearance = appearances
      .filter(event => event.date && event.date >= today)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null;

    const nextTask = tasks
      .filter(task => !task.completed && task.dueDate && task.dueDate >= today)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0] || null;

    const nextInvoice = invoices
      .filter(invoice => invoice.status !== 'Paid' && invoice.dueDate && invoice.dueDate >= today)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0] || null;

    const solDate = detail?.solDate || '';
    const upcomingSol = solDate && solDate >= today ? solDate : '';

    const nextCandidates = [
      upcomingAppearance ? { label: `${upcomingAppearance.type || 'Court'} on ${upcomingAppearance.date}`, date: upcomingAppearance.date } : null,
      nextTask ? { label: `Task due ${nextTask.dueDate}: ${nextTask.title}`, date: nextTask.dueDate } : null,
      upcomingSol ? { label: `SOL advisory date ${upcomingSol}`, date: upcomingSol } : null,
      nextInvoice ? { label: `Invoice due ${nextInvoice.dueDate}: ${nextInvoice.number || nextInvoice.id}`, date: nextInvoice.dueDate } : null,
    ].filter(Boolean).sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const overdueTasks = tasks.filter(task => !task.completed && task.dueDate && task.dueDate < today).length;
    const overdueInvoices = invoices.filter(invoice => (invoice.status === 'Overdue') || (invoice.status !== 'Paid' && invoice.dueDate && invoice.dueDate < today)).length;

    return {
      owner: detail?.assignedTo || 'Unassigned',
      paralegal: detail?.paralegal || '',
      stage: detail?.stage || 'Intake',
      lastActivity: lastActivity ? `${lastActivity.label} (${lastActivity.parsed.toLocaleString()})` : 'No recent activity recorded',
      nextStep: nextCandidates[0]?.label || 'No upcoming item recorded',
      court: upcomingAppearance
        ? `${upcomingAppearance.date} - ${upcomingAppearance.type || 'Appearance'}${upcomingAppearance.location ? ` (${upcomingAppearance.location})` : ''}`
        : 'No upcoming court appearance recorded',
      overdue: overdueTasks + overdueInvoices,
      overdueLabel: overdueTasks + overdueInvoices
        ? `${overdueTasks} overdue task${overdueTasks === 1 ? '' : 's'}${overdueInvoices ? `, ${overdueInvoices} overdue invoice${overdueInvoices === 1 ? '' : 's'}` : ''}`
        : 'No overdue work found',
      sol: solDate ? `${solDate} (advisory; confirm statute and facts)` : 'No SOL date recorded',
      topSuggestion: nextActionHints[0]?.title || 'No recommendation available from current matter signals.',
    };
  }, [detail, nextActionHints]);

  return (
    <section aria-label="Matter Command Summary" style={{ border: `1px solid ${theme.line}`, background: '#fff', borderRadius: 10, padding: 14, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 2 }}>
          <strong style={{ fontSize: 13 }}>Matter Command Summary</strong>
          <span style={{ color: theme.muted, fontSize: 12 }}>Read-only snapshot from current matter data.</span>
        </div>
        <button
          type="button"
          aria-expanded={summaryOpen}
          aria-controls="matter-command-summary-grid"
          onClick={() => setSummaryOpen(open => !open)}
          style={{ ...styles.ghostButton, fontSize: 12, padding: '4px 10px' }}
        >
          {summaryOpen ? 'Hide summary' : 'Show summary'}
        </button>
      </div>
      <div id="matter-command-summary-grid">
        {!summaryOpen ? (
          <div style={{ border: `1px dashed ${theme.line}`, borderRadius: 8, padding: 12, color: theme.muted, fontSize: 13 }}>
            Review matter command summary data when you need a quick overview of stage, ownership, deadlines, and next steps.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
            <SummaryCell label="Stage" value={summary.stage} />
            <SummaryCell label="Owner" value={summary.paralegal ? `${summary.owner} / ${summary.paralegal}` : summary.owner} />
            <SummaryCell label="Last activity" value={summary.lastActivity} />
            <SummaryCell label="Next step" value={summary.nextStep} />
            <SummaryCell label="Court" value={summary.court} />
            <SummaryCell label="Overdue" value={summary.overdueLabel} tone={summary.overdue ? 'red' : ''} />
            <SummaryCell label="SOL / Limitation" value={summary.sol} tone={detail?.solDate ? 'amber' : ''} />
            <SummaryCell label="Top suggestion" value={summary.topSuggestion} />
          </div>
        )}
      </div>
    </section>
  );
}

function timelineToneColor(tone) {
  if (tone === 'green') return theme.green;
  if (tone === 'amber') return theme.amber;
  if (tone === 'red') return theme.red;
  return theme.blue;
}

// TIMELINE-30C: map a backend timeline event (from GET /api/matters/:id/timeline)
// to the existing card render shape. Backend already strips sensitive data and
// sorts descending; we never render raw metadata.
const TIMELINE_TYPE_DISPLAY = {
  matter_opened: { source: 'Matter', tone: 'blue' },
  note: { source: 'Note', tone: 'blue' },
  task: { source: 'Task', tone: 'amber' },
  appearance: { source: 'Court', tone: 'red' },
  document: { source: 'Document', tone: 'blue' },
  time_entry: { source: 'Time', tone: 'green' },
  invoice: { source: 'Invoice', tone: 'amber' },
  deadline: { source: 'Deadline', tone: 'amber' },
  payment: { source: 'Payment', tone: 'green' },
  checklist: { source: 'Checklist', tone: 'blue' },
};

function mapTimelineApiEvent(event) {
  const display = TIMELINE_TYPE_DISPLAY[event.type] || { source: 'Activity', tone: 'blue' };
  let tone = display.tone;
  if ((event.type === 'task' || event.type === 'checklist') && event.metadata?.status === 'completed') tone = 'green';
  const secondary = [event.summary, event.actor ? `· ${event.actor}` : ''].filter(Boolean).join(' ').trim();
  return {
    date: event.date,
    parsed: parseDateValue(event.date),
    source: display.source,
    tone,
    title: event.title,
    secondary,
  };
}

function MatterActivityTimeline({ detail }) {
  const [activityOpen, setActivityOpen] = useState(false);
  // TIMELINE-30C: events now come from the backend route; the local aggregation
  // below is kept as a fallback when the API errors or returns nothing.
  const [apiEvents, setApiEvents] = useState(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState('');
  const loadedMatterRef = useRef('');

  const localEvents = useMemo(() => {
    const timeline = [];
    const addEvent = ({ date, source, tone = 'blue', title, detail: secondary }) => {
      timeline.push({
        date,
        parsed: parseDateValue(date),
        source,
        tone,
        title,
        secondary
      });
    };

    if (detail?.openDate) {
      addEvent({
        date: detail.openDate,
        source: 'Matter',
        title: 'Matter opened',
        detail: detail.reference || detail.title || detail.clientName || 'Matter file'
      });
    }

    (Array.isArray(detail?.notes) ? detail.notes : []).forEach(note => {
      addEvent({
        date: note.createdAt,
        source: 'Note',
        title: 'Case note recorded',
        detail: note.author ? `By ${note.author}` : 'Internal note'
      });
    });

    (Array.isArray(detail?.tasks) ? detail.tasks : []).forEach(task => {
      const status = task.completed ? 'Completed' : 'Open';
      addEvent({
        date: task.dueDate,
        source: 'Task',
        tone: task.completed ? 'green' : 'amber',
        title: 'Task due',
        detail: [status, task.title || 'Task', task.assignee && `Responsible: ${task.assignee}`].filter(Boolean).join(' - ')
      });
    });

    (Array.isArray(detail?.appearances) ? detail.appearances : []).forEach(appearance => {
      addEvent({
        date: appearance.date,
        source: 'Court',
        tone: 'red',
        title: 'Court appearance',
        detail: [appearance.title || appearance.type || 'Appearance', appearance.time, appearance.location].filter(Boolean).join(' - ')
      });
    });

    (Array.isArray(detail?.documents) ? detail.documents : []).forEach(document => {
      addEvent({
        date: document.date || document.createdAt,
        source: 'Document',
        title: 'Document added',
        detail: [
          document.displayName || document.name || 'Document',
          document.source === 'client' ? 'Client upload' : document.source === 'firm' ? 'Firm document' : null,
          document.clientVisible ? 'Client-visible' : 'Staff-only'
        ].filter(Boolean).join(' - ')
      });
    });

    (Array.isArray(detail?.timeEntries) ? detail.timeEntries : []).forEach(entry => {
      const hours = Number(entry.hours);
      addEvent({
        date: entry.date,
        source: 'Time',
        tone: 'green',
        title: 'Time logged',
        detail: [Number.isFinite(hours) ? `${hours.toFixed(1)}h` : null, entry.activity || entry.description || 'Matter work'].filter(Boolean).join(' - ')
      });
    });

    (Array.isArray(detail?.invoices) ? detail.invoices : []).forEach(invoice => {
      const label = [invoice.number || invoice.id || 'Invoice', invoice.status || 'Status not set'].filter(Boolean).join(' - ');
      addEvent({
        date: invoice.date,
        source: 'Invoice',
        tone: 'amber',
        title: 'Invoice issued',
        detail: label
      });
      if (invoice.dueDate) {
        addEvent({
          date: invoice.dueDate,
          source: 'Invoice',
          tone: 'amber',
          title: 'Invoice due',
          detail: label
        });
      }
    });

    return timeline.sort((a, b) => {
      const aTime = a.parsed ? a.parsed.getTime() : -Infinity;
      const bTime = b.parsed ? b.parsed.getTime() : -Infinity;
      if (bTime !== aTime) return bTime - aTime;
      return `${a.source}${a.title}`.localeCompare(`${b.source}${b.title}`);
    });
  }, [detail]);

  // Reset cached API events when the matter changes.
  useEffect(() => {
    setApiEvents(null);
    setTimelineError('');
    loadedMatterRef.current = '';
  }, [detail?.id]);

  // Lazily load the authoritative timeline from the backend when the section is
  // first expanded for a given matter (one fetch per matter).
  useEffect(() => {
    if (!activityOpen || !detail?.id || loadedMatterRef.current === detail.id) return;
    let cancelled = false;
    loadedMatterRef.current = detail.id;
    setTimelineLoading(true);
    setTimelineError('');
    getMatterTimeline(detail.id)
      .then(res => {
        if (cancelled) return;
        const list = Array.isArray(res?.events) ? res.events : [];
        setApiEvents(list.map(mapTimelineApiEvent));
      })
      .catch(err => {
        if (cancelled) return;
        setTimelineError(err?.message || 'Unable to load the matter timeline.');
        setApiEvents(null); // fall back to the local aggregation
        loadedMatterRef.current = ''; // allow a retry on next expand
      })
      .finally(() => { if (!cancelled) setTimelineLoading(false); });
    return () => { cancelled = true; };
  }, [activityOpen, detail?.id]);

  // Prefer the backend timeline (includes deadlines/payments and respects backend
  // order); fall back to the local aggregation when the API errors or is empty.
  const usingApiEvents = Array.isArray(apiEvents) && apiEvents.length > 0;
  const events = usingApiEvents ? apiEvents : localEvents;

  return (
    <section aria-label="Matter Activity Timeline" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 14, background: '#fff', display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 2 }}>
          <strong style={{ fontSize: 13 }}>Matter Activity Timeline</strong>
          <span style={{ color: theme.muted, fontSize: 12 }}>Read-only sequence from current matter records.</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Badge tone="blue">{events.length} events</Badge>
          <button
            type="button"
            aria-expanded={activityOpen}
            aria-controls="matter-activity-timeline-events"
            onClick={() => setActivityOpen(open => !open)}
            style={{ ...styles.ghostButton, fontSize: 12, padding: '4px 10px' }}
          >
            {activityOpen ? 'Hide activity' : 'Show activity'}
          </button>
        </div>
      </div>
      <div id="matter-activity-timeline-events">
        {!activityOpen ? (
          <div style={{ border: `1px dashed ${theme.line}`, borderRadius: 8, padding: 12, color: theme.muted, fontSize: 13 }}>
            Review recent matter activity when you need file history or audit context.
          </div>
        ) : timelineLoading && !usingApiEvents ? (
          <div style={{ border: `1px dashed ${theme.line}`, borderRadius: 8, padding: 12, color: theme.muted, fontSize: 13 }}>
            Loading matter timeline…
          </div>
        ) : events.length === 0 ? (
          <div style={{ border: `1px dashed ${theme.line}`, borderRadius: 8, padding: 12, color: theme.muted, fontSize: 13 }}>
            No activity recorded for this matter yet.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {timelineError ? (
              <div style={{ border: `1px solid ${theme.amber}`, borderRadius: 8, padding: '8px 10px', background: '#FFFBEB', color: theme.ink, fontSize: 12 }}>
                Showing activity from current matter records — the full timeline could not be loaded.
              </div>
            ) : null}
            {events.map((event, index) => (
              <div
                key={`${event.source}-${event.title}-${event.date || 'undated'}-${index}`}
                style={{ border: `1px solid ${theme.line}`, borderLeft: `4px solid ${timelineToneColor(event.tone)}`, borderRadius: 8, padding: 10, background: '#F8FAFC', display: 'grid', gap: 6 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: theme.ink }}>{formatTimelineDate(event.date)}</span>
                  <Badge tone={event.tone}>{event.source}</Badge>
                </div>
                <strong style={{ fontSize: 13 }}>{event.title}</strong>
                {event.secondary ? <span style={{ color: theme.muted, fontSize: 12 }}>{event.secondary}</span> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SummaryCell({ label, value, tone = '' }) {
  const color = tone === 'red' ? theme.red : tone === 'amber' ? theme.amber : theme.ink;
  return (
    <div style={{ border: `1px solid ${theme.line}`, borderRadius: 8, padding: 10, background: '#fff', display: 'grid', gap: 5 }}>
      <span style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 700, color: theme.muted }}>{label}</span>
      <span style={{ fontSize: 13, color }}>{value}</span>
    </div>
  );
}

function getNextAppearance(detail) {
  const appearances = Array.isArray(detail?.appearances) ? detail.appearances : [];
  const today = isoDateOnly();
  return appearances
    .filter(a => a.date && a.date >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null;
}

function getRecentDocuments(detail) {
  const documents = Array.isArray(detail?.documents) ? detail.documents : [];
  return [...documents]
    .sort((a, b) => {
      const aDate = parseDateValue(a.date || a.createdAt);
      const bDate = parseDateValue(b.date || b.createdAt);
      return (bDate?.getTime() || 0) - (aDate?.getTime() || 0);
    })
    .slice(0, 5);
}

function CourtModeField({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <span style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 700, color: theme.muted }}>{label}</span>
      <div style={{ fontSize: 13, color: theme.ink }}>{value}</div>
    </div>
  );
}

function DocumentRequestsPanel({ matterId, canManage, notify, downloadWithAuth }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function loadRequests() {
    if (!matterId) return;
    setLoading(true);
    try {
      const data = await api(`/document-requests?matterId=${matterId}`);
      setRequests(Array.isArray(data) ? data : []);
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
    finally { setLoading(false); }
  }

  useEffect(() => { loadRequests(); }, [matterId]);

  async function createRequest(event) {
    event.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await api('/document-requests', { method: 'POST', body: { matterId, title: title.trim(), description: description.trim() } });
      setTitle('');
      setDescription('');
      setShowForm(false);
      notify?.({ type: 'success', message: 'Document request sent.' });
      await loadRequests();
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
    finally { setSubmitting(false); }
  }

  async function cancelRequest(requestId) {
    try {
      await api(`/document-requests/${requestId}`, { method: 'PATCH', body: { status: 'cancelled' } });
      notify?.({ type: 'success', message: 'Request cancelled.' });
      await loadRequests();
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
  }

  const statusBadge = (status) => {
    if (status === 'pending') return <Badge tone="gold">Pending</Badge>;
    if (status === 'fulfilled') return <Badge tone="green">Fulfilled</Badge>;
    return <Badge tone="muted">Cancelled</Badge>;
  };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {canManage && !showForm && (
        <button type="button" onClick={() => setShowForm(true)} style={{ ...styles.ghostButton, alignSelf: 'start' }}>Request document</button>
      )}
      {canManage && showForm && (
        <form onSubmit={createRequest} style={{ ...styles.formGrid, marginBottom: 8 }}>
          <input required placeholder="Document title (e.g. Signed Affidavit)" style={styles.input} value={title} onChange={e => setTitle(e.target.value)} />
          <textarea placeholder="Optional description…" style={{ ...styles.input, minHeight: 60, resize: 'vertical' }} value={description} onChange={e => setDescription(e.target.value)} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={submitting || !title.trim()} style={styles.primaryButton}>{submitting ? 'Sending…' : 'Send request'}</button>
            <button type="button" onClick={() => setShowForm(false)} style={styles.ghostButton}>Cancel</button>
          </div>
        </form>
      )}
      {loading ? (
        <span style={{ color: theme.muted, fontSize: 12 }}>Loading requests…</span>
      ) : requests.length === 0 ? (
        <span style={{ color: theme.muted, fontSize: 12 }}>No document requests yet.</span>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {requests.map(r => (
            <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: 8, border: `1px solid ${theme.line}`, borderRadius: 6 }}>
              <div style={{ flex: 1, display: 'grid', gap: 3, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13 }}>{r.title}</strong>
                  {statusBadge(r.status)}
                </div>
                {r.description && <span style={{ fontSize: 12, color: theme.muted }}>{r.description}</span>}
                {r.status === 'fulfilled' && r.responseDocumentId && (
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    <button type="button" onClick={() => downloadWithAuth(`/api/documents/${r.responseDocumentId}/download`, r.responseDocumentDisplayName || r.responseDocumentName || 'document', notify)} style={{ ...styles.link, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 12 }}>
                      {r.responseDocumentDisplayName || r.responseDocumentName || 'Download response'}
                    </button>
                  </div>
                )}
                {r.responseDocumentName && <span style={{ fontSize: 11, color: theme.muted }}>{r.responseDocumentName} ({r.responseDocumentSize || '?'})</span>}
              </div>
              {canManage && r.status === 'pending' && (
                <button type="button" onClick={() => cancelRequest(r.id)} style={{ ...styles.dangerTinyButton, whiteSpace: 'nowrap', flexShrink: 0 }} title="Cancel request">Cancel</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MatterCourtMode({ detail, nextActionHints }) {
  const nextAppearance = useMemo(() => getNextAppearance(detail), [detail]);
  const recentDocs = useMemo(() => getRecentDocuments(detail), [detail]);
  const recentTimeline = useMemo(() => {
    const timeline = [];
    const addEvent = ({ date, title, detail: secondary }) => {
      const parsed = parseDateValue(date);
      if (!parsed) return;
      timeline.push({ date: parsed, title, secondary });
    };
    (Array.isArray(detail?.notes) ? detail.notes : []).forEach(note => {
      addEvent({ date: note.createdAt, title: 'Case note recorded', detail: note.author ? `By ${note.author}` : 'Internal note' });
    });
    (Array.isArray(detail?.appearances) ? detail.appearances : []).forEach(appearance => {
      addEvent({ date: appearance.date, title: 'Court appearance', detail: [appearance.title || appearance.type || 'Appearance', appearance.time, appearance.location].filter(Boolean).join(' - ') });
    });
    (Array.isArray(detail?.documents) ? detail.documents : []).forEach(doc => {
      addEvent({ date: doc.date || doc.createdAt, title: 'Document added', detail: doc.displayName || doc.name || 'Document' });
    });
    return timeline.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 5);
  }, [detail]);

  return (
    <div className="lf-court-mode-stack" style={{ display: 'grid', gap: 12 }}>
      <div className="lf-court-mode-card" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 10 }}>
        <strong style={{ fontSize: 13 }}>Matter Summary</strong>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          <CourtModeField label="Title" value={detail?.title} />
          <CourtModeField label="Reference" value={detail?.reference} />
          <CourtModeField label="Stage" value={detail?.stage} />
          <CourtModeField label="Advocate" value={detail?.assignedTo} />
          {detail?.paralegal && <CourtModeField label="Paralegal" value={detail.paralegal} />}
          {detail?.court && <CourtModeField label="Court" value={detail.court} />}
          {detail?.judge && <CourtModeField label="Judge" value={detail.judge} />}
          {detail?.caseNo && <CourtModeField label="Case No." value={detail.caseNo} />}
          {detail?.opposingCounsel && <CourtModeField label="Opposing Counsel" value={detail.opposingCounsel} />}
        </div>
      </div>

      {nextAppearance && (
        <div className="lf-court-mode-card" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 10 }}>
          <strong style={{ fontSize: 13 }}>Next Appearance</strong>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <CourtModeField label="Date" value={formatTimelineDate(nextAppearance.date)} />
            {nextAppearance.time && <CourtModeField label="Time" value={nextAppearance.time} />}
            {nextAppearance.type && <CourtModeField label="Type" value={nextAppearance.type} />}
            {nextAppearance.location && <CourtModeField label="Location" value={nextAppearance.location} />}
            {nextAppearance.attorney && <CourtModeField label="Attorney" value={nextAppearance.attorney} />}
            {nextAppearance.prepNote && <CourtModeField label="Prep Note" value={nextAppearance.prepNote} />}
            {safeHttpUrl(nextAppearance.meetingLink) && <CourtModeField label="Virtual Court" value={<a href={safeHttpUrl(nextAppearance.meetingLink)} target="_blank" rel="noopener noreferrer" style={styles.link}>{nextAppearance.meetingLink}</a>} />}
          </div>
        </div>
      )}

      {detail?.clientName && (
        <div className="lf-court-mode-card" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 10 }}>
          <strong style={{ fontSize: 13 }}>Client Contact</strong>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <CourtModeField label="Name" value={detail.clientName} />
            {detail.clientEmail && <CourtModeField label="Email" value={<a href={`mailto:${detail.clientEmail}`} style={styles.link}>{detail.clientEmail}</a>} />}
            {detail.clientPhone && <CourtModeField label="Phone" value={<a href={`tel:${detail.clientPhone}`} style={styles.link}>{detail.clientPhone}</a>} />}
          </div>
        </div>
      )}

      {detail?.solDate && (
        <div style={{ border: `1px solid #FDE68A`, borderRadius: 10, padding: 14, background: theme.amberBg, color: theme.amber, display: 'grid', gap: 4 }}>
          <strong style={{ fontSize: 13 }}>Limitation / SOL Date</strong>
          <span>{formatTimelineDate(detail.solDate)}{daysFromToday(detail.solDate) < 0 ? ' (passed)' : daysFromToday(detail.solDate) <= 30 ? ' (within 30 days)' : ''}</span>
        </div>
      )}

      {nextActionHints?.length > 0 && (
        <div className="lf-court-mode-card" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 10 }}>
          <strong style={{ fontSize: 13 }}>Action Items</strong>
          <div style={{ display: 'grid', gap: 8 }}>
            {nextActionHints.slice(0, 5).map((hint, i) => (
              <div key={`${hint.title}-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <Badge tone={hintTone(hint.severity)}>{hint.severity}</Badge>
                <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: theme.ink }}>{hint.title}</span>
                  <span style={{ fontSize: 12, color: theme.muted }}>{hint.why}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="lf-court-mode-card" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 10 }}>
        <strong style={{ fontSize: 13 }}>Recent Activity</strong>
        {recentTimeline.length > 0 ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {recentTimeline.map((event, i) => (
              <div key={`tl-${i}`} style={{ display: 'grid', gap: 3, borderLeft: `3px solid ${theme.blue}`, paddingLeft: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: theme.ink }}>{event.date.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                <span style={{ fontSize: 13, color: theme.ink }}>{event.title}</span>
                {event.secondary && <span style={{ fontSize: 12, color: theme.muted }}>{event.secondary}</span>}
              </div>
            ))}
          </div>
        ) : (
          <span style={{ color: theme.muted, fontSize: 12 }}>No recent activity recorded.</span>
        )}
      </div>

      <div className="lf-court-mode-card" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 16, background: '#fff', boxShadow: theme.shadow, display: 'grid', gap: 10 }}>
        <strong style={{ fontSize: 13 }}>Recent Documents</strong>
        {recentDocs.length > 0 ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {recentDocs.map((doc, i) => (
              <div key={`doc-${doc.id || i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: theme.ink, fontWeight: 600 }}>{noticeFileName(doc)}</span>
                <span style={{ fontSize: 12, color: theme.muted, whiteSpace: 'nowrap' }}>{formatFileSize(doc.size)}</span>
              </div>
            ))}
          </div>
        ) : (
          <span style={{ color: theme.muted, fontSize: 12 }}>No documents recorded.</span>
        )}
      </div>
    </div>
  );
}
