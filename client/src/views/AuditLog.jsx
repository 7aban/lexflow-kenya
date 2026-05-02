import { useEffect, useMemo, useState } from 'react';
import { getAuditLogs } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Badge, Card, Empty, Field, Skeleton, Table } from '../components/ui.jsx';

const PAGE_SIZE = 50;
const ACTIONS = ['', 'create', 'update', 'delete', 'archive', 'complete', 'bill_toggle', 'generate', 'status', 'upload'];
const ENTITIES = ['', 'client', 'matter', 'task', 'deadline', 'time_entry', 'invoice', 'appearance', 'document', 'folder', 'firm_settings', 'user', 'invitation'];
const ENTITY_VIEW = {
  client: 'Clients',
  matter: 'Matters',
  task: 'Tasks',
  deadline: 'Deadlines',
  invoice: 'Invoices',
  firm_settings: 'Firm Settings',
  user: 'Users',
};

function pretty(value) {
  if (!value) return 'All';
  return value.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-KE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function actionTone(action) {
  if (['delete', 'archive'].includes(action)) return 'red';
  if (['create', 'generate', 'upload'].includes(action)) return 'green';
  if (['status', 'bill_toggle', 'complete'].includes(action)) return 'amber';
  return 'blue';
}

export default function AuditLog({ notify, navigate }) {
  const [filters, setFilters] = useState({ action: '', entityType: '', search: '' });
  const [page, setPage] = useState(0);
  const [payload, setPayload] = useState({ rows: [], total: 0, limit: PAGE_SIZE, offset: 0 });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const result = await getAuditLogs({
          action: filters.action,
          entityType: filters.entityType,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        });
        if (!cancelled) setPayload(result);
      } catch (err) {
        if (!cancelled) notify?.({ type: 'danger', message: err.message });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [filters.action, filters.entityType, notify, page]);

  const rows = useMemo(() => {
    const needle = filters.search.trim().toLowerCase();
    if (!needle) return payload.rows || [];
    return (payload.rows || []).filter(row => (
      row.userName?.toLowerCase().includes(needle)
      || row.summary?.toLowerCase().includes(needle)
      || row.entityId?.toLowerCase().includes(needle)
    ));
  }, [filters.search, payload.rows]);

  function updateFilter(key, value) {
    setFilters(current => ({ ...current, [key]: value }));
    if (key !== 'search') setPage(0);
  }

  function entityCell(row) {
    const view = ENTITY_VIEW[row.entityType];
    if (!row.entityId) return '-';
    if (!view) return <span style={styles.mutedText}>{row.entityId}</span>;
    return (
      <button type="button" style={styles.tinyButton} onClick={() => navigate?.(view)} title={`Open ${view}`}>
        {row.entityId}
      </button>
    );
  }

  const tableRows = rows.map(row => [
    formatDate(row.createdAt),
    row.userName || 'System',
    <Badge tone={row.role === 'admin' ? 'green' : 'blue'}>{row.role || '-'}</Badge>,
    <Badge tone={actionTone(row.action)}>{pretty(row.action)}</Badge>,
    pretty(row.entityType),
    entityCell(row),
    row.summary || '-',
  ]);

  const total = Number(payload.total || 0);
  const start = total ? page * PAGE_SIZE + 1 : 0;
  const end = Math.min((page + 1) * PAGE_SIZE, total);
  const hasNext = (page + 1) * PAGE_SIZE < total;

  return (
    <div style={styles.pageStack}>
      <Card title="Audit Log" hint="A searchable accountability trail for important changes across the firm.">
        <div style={styles.formGrid}>
          <Field label="Search">
            <input
              value={filters.search}
              onChange={event => updateFilter('search', event.target.value)}
              placeholder="User, summary, or record ID"
              style={styles.input}
            />
          </Field>
          <Field label="Action">
            <select value={filters.action} onChange={event => updateFilter('action', event.target.value)} style={styles.input}>
              {ACTIONS.map(action => <option key={action || 'all'} value={action}>{pretty(action)}</option>)}
            </select>
          </Field>
          <Field label="Entity Type">
            <select value={filters.entityType} onChange={event => updateFilter('entityType', event.target.value)} style={styles.input}>
              {ENTITIES.map(entity => <option key={entity || 'all'} value={entity}>{pretty(entity)}</option>)}
            </select>
          </Field>
          <div style={{ ...styles.formHelper, alignSelf: 'end' }}>
            Showing {start}-{end} of {total} server records. Text search filters the loaded page.
          </div>
        </div>
      </Card>

      <Card
        title="Recent Activity"
        action={(
          <div style={styles.actionGroup}>
            <button type="button" style={styles.ghostButton} disabled={page === 0 || loading} onClick={() => setPage(current => Math.max(0, current - 1))}>Previous</button>
            <button type="button" style={styles.ghostButton} disabled={!hasNext || loading} onClick={() => setPage(current => current + 1)}>Next</button>
          </div>
        )}
      >
        {loading ? (
          <Skeleton rows={3} />
        ) : tableRows.length ? (
          <Table
            columns={['Date/Time', 'User', 'Role', 'Action', 'Entity Type', 'Entity ID', 'Summary']}
            rows={tableRows}
            empty="No audit entries"
          />
        ) : (
          <Empty title="No audit entries found" text="Try changing the filters or create a new record to generate activity." />
        )}
        <div style={{ marginTop: 12, color: theme.muted, fontSize: 12 }}>
          Page {page + 1}
        </div>
      </Card>
    </div>
  );
}
