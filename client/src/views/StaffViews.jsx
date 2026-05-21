import { useEffect, useMemo, useState } from 'react';
import { IconBriefcase, IconAlertTriangle, IconBuilding, IconAlertCircle, IconClockHour4, IconCash, IconX } from '@tabler/icons-react';
import { api, applyChecklistTemplate, createChecklistTemplate, createMatterChecklistItem, deleteChecklistTemplate, deleteMatterChecklistItem, downloadWithAuth, fileToDataUrl, listChecklistTemplates, listInvoicePayments, listMatterChecklistItems, readSession, recordInvoicePayment, updateChecklistTemplate, updateMatterChecklistItem } from '../lib/apiClient.js';
import { defaultFirmSettings, styles, theme, applyFirmTheme, clearFirmTheme } from '../theme.jsx';
import { getFirmTheme, previewFirmTheme, updateFirmTheme, resetFirmTheme, getThemePresets, getUsers, reassignMatter } from '../api.js';
import { ActionGroup, Badge, Card, ConfirmModal, Empty, Field, kes, MeetingLink, nextCourtDate, ProfileTooltip, Skeleton, statusTone, Sub, Table } from '../components/ui.jsx';
import MatterDocuments from '../components/MatterDocuments.jsx';
import TaskTimer, { taskTimerActive } from '../components/TaskTimer.jsx';

const BILLABLE_TIME_GUIDANCE = 'Billable time may be included in hourly invoices. Non-billable time is tracked for workload and productivity but excluded from hourly invoice generation.';

function listFromResponse(response, key) {
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response[key])) return response[key];
  return [];
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
  return <div className="lf-split-grid" style={styles.splitGrid}><Card title={editing ? 'Edit client' : 'New client'} hint={editing ? 'Save client changes and communication preference' : 'Intake record'}><form onSubmit={submit} style={styles.formGrid}><Field label="Name"><input required style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="Type"><select style={styles.input} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}><option>Individual</option><option>Company</option></select></Field><Field label="Contact"><input style={styles.input} value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} /></Field><Field label="Email"><input style={styles.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field><Field label="Phone"><input style={styles.input} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field><Field label="Reminders"><select style={styles.input} value={form.remindersEnabled ? 'on' : 'off'} onChange={e => setForm({ ...form, remindersEnabled: e.target.value === 'on' })}><option value="on">On</option><option value="off">Off for this client</option></select></Field><Field label="Preferred Channel"><select style={styles.input} value={form.preferredChannel} onChange={e => setForm({ ...form, preferredChannel: e.target.value })}><option value="firm_default">Firm default</option><option value="both">WhatsApp and Email</option><option value="whatsapp">WhatsApp only</option><option value="email">Email only</option><option value="none">None</option></select></Field><button style={styles.primaryButton}>{editing ? 'Save changes' : 'Create client'}</button>{editing && <button type="button" style={styles.ghostButton} onClick={() => { setEditing(null); setForm(emptyClientForm); }}>Cancel</button>}</form></Card><Card title="Client directory" hint={`${clients.length} records`}><div className="lf-client-cards"><Table columns={['Name', 'Type', 'Email', 'Phone', 'Status', 'Reminders', 'Portal', 'Actions']} rows={clients.map(c => [<span key={c.id} onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY, title: c.name, lines: [`${c.type || 'Client'} / ${c.status || 'Active'}`, `${matters.filter(m => m.clientId === c.id).length} matter(s)`, `Joined ${c.joinDate || '-'}`], initial: (c.name || 'C').slice(0, 1) })} onMouseLeave={() => setTooltip(null)} style={styles.hoverName}>{c.name}</span>, c.type, c.email || '-', c.phone || '-', <Badge key={`${c.id}-status`} tone="green">{c.status || 'Active'}</Badge>, reminderCell(c), portalCell(c), canManage ? <ActionGroup key={`${c.id}-actions`} actions={[[ 'Edit', () => startEdit(c)], ['Delete', () => setConfirm({ title: 'Delete client?', message: 'Are you sure you want to delete this client? This will also remove all related matters.', onConfirm: () => deleteClient(c) })]]} /> : '-'])} rowIds={clients.map(c => `client-${c.id}`)} empty="No clients yet." /></div></Card><ProfileTooltip tooltip={tooltip} /><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></div>;
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
  const emptyMatterForm = { clientId: '', title: '', practiceArea: '', stage: 'Intake', assignedTo: '', paralegal: '', description: '', court: '', judge: '', caseNo: '', opposingCounsel: '', priority: 'Medium', solDate: '', billingType: 'hourly', billingRate: 15000, fixedFee: 0, retainerBalance: 0, remindersEnabled: 'firm_default', courtRemindersEnabled: 'firm_default', invoiceRemindersEnabled: 'firm_default' };
  const [form, setForm] = useState(emptyMatterForm);
  const [time, setTime] = useState({ hours: 1, description: '', rate: 15000, billable: true });
  const emptyEventForm = { title: '', date: '', time: '9:00 AM', type: 'Hearing', location: '', meetingLink: '', attorney: '', prepNote: '' };
  const [eventForm, setEventForm] = useState(emptyEventForm);
  const [note, setNote] = useState('');
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
      const [matter, smartTips] = await Promise.all([
        api(`/matters/${id}`),
        api(`/matters/${id}/suggestions`),
      ]);
      setDetail(matter);
      setSuggestions(Array.isArray(smartTips) ? smartTips : []);
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
  async function generateInvoice() { if (!detail) return; try { await api('/invoices/generate', { method: 'POST', body: { matterId: detail.id } }); notify({ type: 'success', message: 'Invoice generated.' }); await loadDetail(detail.id); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
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

  return (
    <div className="lf-matter-grid" style={styles.matterGrid}>
      <Card title="Matter list" hint={`${data.matters.length} active files`}>
        {data.matters.length ? data.matters.map(m => (
          <button key={m.id} onClick={() => setSelectedId(m.id)} onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY, title: m.title, lines: [m.reference || m.id, `Stage: ${m.stage || 'Intake'}`, `Priority: ${m.priority || 'Medium'}`, `Advocate: ${m.assignedTo || '-'}`, `Next court: ${nextCourtDate(m)}`], initial: (m.title || 'M').slice(0, 1) })} onMouseLeave={() => setTooltip(null)} style={{ ...styles.matterButton, ...(selected?.id === m.id ? styles.matterActive : {}) }}>
            <strong>{m.title}</strong>
            <span>{m.reference || m.id}</span>
            <small>{m.clientName || 'No client'} / {m.stage || 'Intake'}</small>
          </button>
        )) : <Empty title="No matters" text="Create one after adding a client." />}
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
        <Card title={detail?.title || 'Matter detail'} hint={detail?.reference || 'Select a file'} action={detail && canManage ? <ActionGroup actions={[['Edit', startMatterEdit], ['Archive', () => setConfirm({ title: 'Archive matter?', message: 'Archive this matter by setting the stage to Closed?', onConfirm: archiveMatter })], ['Delete', () => setConfirm({ title: 'Delete matter?', message: 'Delete this matter and all associated data?', onConfirm: deleteMatterRecord })], ['Invoice', generateInvoice]]} /> : null}>
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
                <AssistantSuggestions suggestions={suggestions} />
              ) : detailTab === 'Court' ? (
                <MatterCourtMode detail={detail} nextActionHints={nextActionHints} />
              ) : (
                <>
                  <MatterCommandSummary detail={detail} nextActionHints={nextActionHints} />
                  <MatterNextActionHints hints={nextActionHints} />
                  <MatterActivityTimeline detail={detail} />
                  <form onSubmit={logTime} style={styles.formGrid}>
                    <Field label="Hours"><input type="number" min="0" step="0.1" style={styles.input} value={time.hours} onChange={e => setTime({ ...time, hours: Number(e.target.value) })} /></Field>
                    <Field label="Description"><input style={styles.input} value={time.description} onChange={e => setTime({ ...time, description: e.target.value })} /></Field>
                    {canViewBilling && <Field label="Rate"><input type="number" style={styles.input} value={time.rate} onChange={e => setTime({ ...time, rate: Number(e.target.value) })} /></Field>}
                    <Field label="Billing class"><select style={styles.input} value={time.billable ? 'billable' : 'non_billable'} onChange={e => setTime({ ...time, billable: e.target.value === 'billable' })}><option value="billable">Billable</option><option value="non_billable">Non-billable</option></select></Field>
                    <div style={{ ...styles.formHelper, gridColumn: '1 / -1' }}>{BILLABLE_TIME_GUIDANCE}</div>
                    <button style={styles.primaryButton}>Log time</button>
                  </form>
                  <Sub title="Time entries"><TimeEntryEditorList entries={detail.timeEntries || []} canManage={canManage} canViewBilling={canViewBilling} editingTime={editingTime} setEditingTime={setEditingTime} saveTimeEntry={saveTimeEntry} confirmDelete={entry => setConfirm({ title: 'Delete time entry?', message: 'Delete this time entry?', onConfirm: () => deleteTimeEntryRecord(entry) })} /></Sub>
                  <Sub title="Checklist"><MatterChecklistPanel items={detail.checklistItems || []} templates={activeChecklistTemplates} canManage={canManageChecklist} canToggle={canToggleChecklist} canApplyTemplate={canApplyChecklistTemplate} selectedTemplateId={selectedTemplateId} setSelectedTemplateId={setSelectedTemplateId} onApplyTemplate={applySelectedChecklistTemplate} applyingTemplate={applyingTemplate} form={checklistForm} setForm={setChecklistForm} onAdd={addChecklistItem} editingItem={editingChecklistItem} setEditingItem={setEditingChecklistItem} onToggle={toggleChecklistItem} onSave={saveChecklistItem} confirmDelete={item => setConfirm({ title: 'Delete checklist item?', message: 'Delete this checklist item?', onConfirm: () => deleteChecklistItemRecord(item) })} /></Sub>
                  <Sub title="Tasks"><TaskEditorList tasks={detail.tasks || []} entries={detail.timeEntries || []} matter={detail} canManage={canManage} canViewBilling={canViewBilling} editingTask={editingTask} setEditingTask={setEditingTask} saveTask={saveTask} taskTimer={taskTimer} setTaskTimer={setTaskTimer} notify={notify} onTimerSaved={async () => { await loadDetail(detail.id); await reload(); }} confirmDelete={task => setConfirm({ title: 'Delete task?', message: 'Delete this task?', onConfirm: () => deleteTaskRecord(task) })} /></Sub>
                  <Sub title="Court appearances">{canManage && <form onSubmit={createEvent} style={{ ...styles.formGrid, marginBottom: 12 }}><Field label="Title"><input required style={styles.input} value={eventForm.title} onChange={e => setEventForm({ ...eventForm, title: e.target.value })} /></Field><Field label="Date"><input required type="date" style={styles.input} value={eventForm.date} onChange={e => setEventForm({ ...eventForm, date: e.target.value })} /></Field><Field label="Time"><input style={styles.input} value={eventForm.time} onChange={e => setEventForm({ ...eventForm, time: e.target.value })} /></Field><Field label="Type"><input style={styles.input} value={eventForm.type} onChange={e => setEventForm({ ...eventForm, type: e.target.value })} /></Field><Field label="Location"><input style={styles.input} value={eventForm.location} onChange={e => setEventForm({ ...eventForm, location: e.target.value })} /></Field><Field label="Meeting Link"><input type="url" placeholder="https://..." style={styles.input} value={eventForm.meetingLink} onChange={e => setEventForm({ ...eventForm, meetingLink: e.target.value })} /></Field><button style={styles.ghostButton}>Schedule event</button></form>}<AppearanceEditorList events={detail.appearances || []} canManage={canManage} editingEvent={editingEvent} setEditingEvent={setEditingEvent} saveEvent={saveEvent} confirmDelete={event => setConfirm({ title: 'Delete appearance?', message: 'Delete this court appearance?', onConfirm: () => deleteEventRecord(event) })} /></Sub>
                  <Sub title="Documents"><MatterDocuments matterId={detail.id} canManage={canManage} notify={notify} /></Sub>
                  <Sub title="Case notes"><form onSubmit={addNote} style={styles.noteForm}><input style={styles.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note" /><button style={styles.ghostButton}>Save note</button></form><div className="lf-matter-notes-cards"><Table columns={['Note', 'Author', 'Created']} rows={(detail.notes || []).map(n => [n.content, n.author || '-', n.createdAt ? new Date(n.createdAt).toLocaleString() : '-'])} empty="No notes yet." /></div></Sub>
                  <Sub title="Invoices"><div className="lf-invoice-cards"><Table columns={['Invoice', 'Amount', 'Paid', 'Balance', 'Status', 'PDF', 'Actions']} rows={(detail.invoices || []).map(i => [i.number || i.id, kes(i.amount), kes(i.amountPaid), kes(i.balance), <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <DownloadButton key={`${i.id}-pdf`} label="PDF" path={`/api/invoices/${i.id}/pdf`} filename={`${i.number || i.id}.pdf`} notify={notify} />, canManage && i.status !== 'Paid' ? <ActionGroup key={`${i.id}-actions`} actions={[['Delete', () => setConfirm({ title: 'Delete invoice?', message: 'Delete this invoice?', onConfirm: () => deleteInvoiceRecord(i) })]]} /> : '-'])} empty="No invoices yet." /></div></Sub>
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
  async function submit(event) { event.preventDefault(); try { await api('/tasks', { method: 'POST', body: form }); setForm({ matterId: '', title: '', dueDate: '' }); notify({ type: 'success', message: 'Task created.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function toggle(task) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: { completed: !task.completed } }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function saveTask(task, values) { try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: values }); setEditingTask(null); notify({ type: 'success', message: 'Task updated.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteTaskRecord(task) { try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Task deleted.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  return <div className="lf-split-grid lf-task-split-grid" style={styles.splitGrid}><Card title="New task" hint="Deadline control"><form onSubmit={submit} style={styles.formGrid}><Field label="Matter"><select required style={styles.input} value={form.matterId} onChange={e => setForm({ ...form, matterId: e.target.value })}><option value="">Select matter</option>{data.matters.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></Field><Field label="Task"><input required style={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field><Field label="Due"><input type="date" style={styles.input} value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></Field><button style={styles.primaryButton}>Create task</button></form></Card><Card title="Task board" hint={`${data.tasks.length} tasks`}><TaskEditorList tasks={data.tasks} canManage={canManage} editingTask={editingTask} setEditingTask={setEditingTask} saveTask={saveTask} toggle={toggle} confirmDelete={task => setConfirm({ title: 'Delete task?', message: 'Delete this task?', onConfirm: () => deleteTaskRecord(task) })} /></Card><ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} /></div>;
}

export function Invoices({ invoices, isAdmin, canManage, reload, notify }) {
  const [confirm, setConfirm] = useState(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [payments, setPayments] = useState([]);
  const [paymentForm, setPaymentForm] = useState({ amount: '', method: 'Bank Transfer', reference: '', date: new Date().toISOString().slice(0, 10), note: '' });
  const session = readSession();
  const canRecordPayment = ['admin', 'assistant'].includes(session?.user?.role);
  const selectedInvoice = invoices.find(invoice => invoice.id === selectedInvoiceId);
  async function setStatus(id, status) { try { await api(`/invoices/${id}/status`, { method: 'PATCH', body: { status } }); notify({ type: 'success', message: 'Invoice updated.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function deleteInvoiceRecord(invoice) { try { await api(`/invoices/${invoice.id}`, { method: 'DELETE' }); notify({ type: 'success', message: 'Invoice deleted.' }); await reload(); } catch (err) { notify({ type: 'danger', message: err.message }); } }
  async function openPayments(invoice) {
    try {
      setSelectedInvoiceId(invoice.id);
      const data = await listInvoicePayments(invoice.id);
      setPayments(data.payments || []);
      setPaymentForm(form => ({ ...form, amount: invoice.balance ? String(invoice.balance) : '', date: new Date().toISOString().slice(0, 10) }));
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
      setPaymentForm({ amount: '', method: 'Bank Transfer', reference: '', date: new Date().toISOString().slice(0, 10), note: '' });
      await reload();
    } catch (err) {
      notify({ type: 'danger', message: err.message });
    }
  }
  return <>
    <Card title="Invoice register" hint="Receivables">
      <div className="lf-invoice-cards"><Table columns={['Invoice', 'Client', 'Matter', 'Amount', 'Paid', 'Balance', 'Status', 'PDF', 'Actions']} rows={invoices.map(i => [i.number || i.id, i.clientName || '-', i.matterTitle || '-', kes(i.amount), kes(i.amountPaid), kes(i.balance), isAdmin ? <select key={i.id} style={styles.tableSelect} value={i.status} onChange={e => setStatus(i.id, e.target.value)}><option>Outstanding</option><option>Paid</option><option>Overdue</option></select> : <Badge key={i.id} tone={statusTone(i.status)}>{i.status}</Badge>, <DownloadButton key={`${i.id}-pdf`} label="Download" path={`/api/invoices/${i.id}/pdf`} filename={`${i.number || i.id}.pdf`} notify={notify} />, <ActionGroup key={`${i.id}-actions`} actions={[['Payments', () => openPayments(i)], ...(canManage && i.status !== 'Paid' ? [['Delete', () => setConfirm({ title: 'Delete invoice?', message: 'Delete this invoice?', onConfirm: () => deleteInvoiceRecord(i) })]] : [])]} />])} empty="No invoices yet." /></div>
      {selectedInvoice && (
        <div style={{ ...styles.pageStack, marginTop: 16 }}>
          <Sub title={`Payments - ${selectedInvoice.number || selectedInvoice.id}`}>
            <div className="lf-payment-cards"><Table columns={['Date', 'Receipt', 'Method', 'Reference', 'Amount', 'Receipt PDF']} rows={payments.map(payment => [payment.date || '-', payment.receiptNumber || '-', payment.method || '-', payment.reference || '-', kes(payment.amount), payment.receiptNumber ? <DownloadButton key={`${payment.id}-receipt`} label="Download" path={`/api/invoices/${selectedInvoice.id}/payments/${payment.id}/receipt.pdf`} filename={`${payment.receiptNumber}.pdf`} notify={notify} /> : '-'])} empty="No payments recorded yet." /></div>
            {canRecordPayment && Number(selectedInvoice.balance || 0) > 0 && (
              <form onSubmit={submitPayment} style={{ ...styles.formGrid, marginTop: 12 }}>
                <Field label="Amount"><input required type="number" min="0.01" step="0.01" style={styles.input} value={paymentForm.amount} onChange={e => setPaymentForm({ ...paymentForm, amount: e.target.value })} /></Field>
                <Field label="Method"><select style={styles.input} value={paymentForm.method} onChange={e => setPaymentForm({ ...paymentForm, method: e.target.value })}><option>Bank Transfer</option><option>M-PESA</option><option>Cash Deposit</option><option>Cheque</option></select></Field>
                <Field label="Reference"><input style={styles.input} value={paymentForm.reference} onChange={e => setPaymentForm({ ...paymentForm, reference: e.target.value })} /></Field>
                <Field label="Date"><input required type="date" style={styles.input} value={paymentForm.date} onChange={e => setPaymentForm({ ...paymentForm, date: e.target.value })} /></Field>
                <Field label="Note"><input style={styles.input} value={paymentForm.note} onChange={e => setPaymentForm({ ...paymentForm, note: e.target.value })} /></Field>
                <button style={styles.primaryButton}>Record payment</button>
              </form>
            )}
          </Sub>
        </div>
      )}
    </Card>
    <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
  </>;
}

async function downloadWithNotify(path, filename, notify) {
  try {
    await downloadWithAuth(path, filename);
  } catch (err) {
    notify?.({ type: 'danger', message: err.message });
  }
}

function DownloadButton({ label, path, filename, notify }) {
  return (
    <button type="button" style={{ ...styles.link, border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }} onClick={() => downloadWithNotify(path, filename, notify)}>
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

  return (
    <div style={styles.pageStack}>
      <Card title="Firm Settings" hint="Branding, invoice identity and client portal contact details">
        <form onSubmit={submit} style={styles.formGrid}>
          <Field label="Firm Name"><input required style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Website URL"><input type="url" style={styles.input} value={form.websiteURL || ''} onChange={e => setForm({ ...form, websiteURL: e.target.value })} /></Field>
          <Field label="Primary Color"><input type="color" style={styles.colorInput} value={form.primaryColor || '#0F1B33'} onChange={e => setForm({ ...form, primaryColor: e.target.value })} /></Field>
          <Field label="Accent Color"><input type="color" style={styles.colorInput} value={form.accentColor || '#D4A34A'} onChange={e => setForm({ ...form, accentColor: e.target.value })} /></Field>
          <Field label="Email"><input style={styles.input} value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Phone"><input style={styles.input} value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Address"><input style={styles.input} value={form.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} /></Field>
          <Field label="Logo"><input type="file" accept="image/*" style={styles.input} onChange={chooseLogo} /></Field>
          <div className="lf-logo-preview" style={styles.logoPreview}>
            {form.logo ? <img src={form.logo} alt="Firm logo preview" /> : <span>LF</span>}
            <button type="button" style={styles.tinyButton} onClick={() => setForm({ ...form, logo: '' })}>Clear logo</button>
          </div>
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
export function Users({ clients = [], notify }) {
  const [users, setUsers] = useState([]);
  const [userLoadError, setUserLoadError] = useState('');
  const [form, setForm] = useState({ email: '', password: '', fullName: '', role: 'assistant', clientId: '' });
  const [includeInactive, setIncludeInactive] = useState(false);
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
  const clientOptions = Array.isArray(clients) ? clients : [];
  const visibleUsers = Array.isArray(users) ? users : [];
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
      <div className="lf-user-cards">
        <Table columns={['Name', 'Email', 'Role', 'Status', 'Client', 'Actions']} rows={visibleUsers.map(u => [
          u.fullName,
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
        ])} empty="No users found." />
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
  const completedCount = items.filter(item => Number(item.completed || 0) === 1).length;
  const completionPercent = items.length ? Math.round((completedCount / items.length) * 100) : 0;
  const openItems = items.filter(item => Number(item.completed || 0) !== 1);
  const completedItems = items.filter(item => Number(item.completed || 0) === 1);
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
          {checklistSection('Completed items', completedItems)}
        </div>
      )}
    </section>
  );
}

function TaskEditorList({ tasks, entries = [], matter, canManage, canViewBilling = true, editingTask, setEditingTask, saveTask, toggle, confirmDelete, taskTimer, setTaskTimer, notify, onTimerSaved }) {
  if (!tasks.length) return <Empty title="No tasks yet." text="Once records exist, they will appear here." />;
  const warmBorder = '1px solid #DDD8CE';
  const warmHeadBg = '#F5F2EB';
  const warmCellPad = '11px 14px';
  return (
    <div className="lf-task-cards" style={{ ...styles.tableWrap, background: '#fff', border: warmBorder }}>
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
    <div style={styles.tableWrap} className="lf-appearance-cards">
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
    <div className={`lf-time-entry-cards${canViewBilling ? '' : ' lf-time-entry-cards-no-rate'}`} style={{ ...styles.tableWrap, background: '#fff', border: warmBorder }}>
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

function AssistantSuggestions({ suggestions }) {
  const items = suggestions.length ? suggestions : ['This matter looks up to date. No urgent action is needed right now.'];
  return (
    <div style={styles.assistantPanel}>
      <div style={styles.assistantIntro}>
        <strong>Matter Assistant</strong>
        <span>Rule-based prompts drawn from tasks, billing, documents, notes, and upcoming court dates.</span>
      </div>
      <div style={styles.suggestionList}>
        {items.map((text, index) => {
          const lower = text.toLowerCase();
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

function MatterNextActionHints({ hints = [] }) {
  const visibleHints = hints.slice(0, 5);

  return (
    <section aria-label="Matter Next-Action Hints" style={{ border: `1px solid ${theme.line}`, background: '#fff', borderRadius: 10, padding: 14, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 2 }}>
          <strong style={{ fontSize: 13 }}>Next-Action Hints</strong>
          <span style={{ color: theme.muted, fontSize: 12 }}>Rule-based from current matter detail only.</span>
        </div>
        <Badge tone="blue">{visibleHints.length} shown</Badge>
      </div>
      {visibleHints.length ? (
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
    </section>
  );
}

function MatterCommandSummary({ detail, nextActionHints = [] }) {
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
      <div style={{ display: 'grid', gap: 2 }}>
        <strong style={{ fontSize: 13 }}>Matter Command Summary</strong>
        <span style={{ color: theme.muted, fontSize: 12 }}>Read-only snapshot from current matter data.</span>
      </div>
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
    </section>
  );
}

function timelineToneColor(tone) {
  if (tone === 'green') return theme.green;
  if (tone === 'amber') return theme.amber;
  if (tone === 'red') return theme.red;
  return theme.blue;
}

function MatterActivityTimeline({ detail }) {
  const events = useMemo(() => {
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

  return (
    <section aria-label="Matter Activity Timeline" style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: 14, background: '#fff', display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 2 }}>
          <strong style={{ fontSize: 13 }}>Matter Activity Timeline</strong>
          <span style={{ color: theme.muted, fontSize: 12 }}>Read-only sequence from current matter records.</span>
        </div>
        <Badge tone="blue">{events.length} events</Badge>
      </div>
      {events.length === 0 ? (
        <div style={{ border: `1px dashed ${theme.line}`, borderRadius: 8, padding: 12, color: theme.muted, fontSize: 13 }}>
          No activity recorded for this matter yet.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
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
            {nextAppearance.meetingLink && <CourtModeField label="Virtual Court" value={<a href={nextAppearance.meetingLink} target="_blank" rel="noopener noreferrer" style={styles.link}>{nextAppearance.meetingLink}</a>} />}
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

