import { useEffect, useState } from 'react';
import { getAuditEvents } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Badge, Card, Empty, Field, Skeleton, Table } from '../components/ui.jsx';

const PAGE_SIZE = 50;
const SENSITIVE_KEYS = ['token', 'authorization', 'bearer', 'password', 'secret', 'key', 'credential', 'rawbody'];

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
  if (!action) return 'blue';
  if (action.includes('delete') || action.includes('archive') || action.includes('forbidden')) return 'red';
  if (action.includes('create') || action.includes('generate') || action.includes('upload') || action.includes('success')) return 'green';
  if (action.includes('update') || action.includes('status') || action.includes('failure') || action.includes('fail')) return 'amber';
  return 'blue';
}

function isSensitive(key) {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some(s => lower.includes(s));
}

function redactMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const redacted = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isSensitive(key)) {
      redacted[key] = '[redacted]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactMetadata(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function MetadataCell({ metadata }) {
  const [open, setOpen] = useState(false);
  const safe = redactMetadata(metadata);
  if (!safe || typeof safe !== 'object' || Object.keys(safe).length === 0) {
    return <span style={styles.mutedText}>-</span>;
  }
  const entries = Object.entries(safe);
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} style={{ ...styles.tinyButton, marginBottom: open ? 4 : 0 }}>
        {open ? 'Hide' : `Show (${entries.length})`}
      </button>
      {open && (
        <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', background: theme.bg, padding: 6, borderRadius: 6, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {entries.map(([k, v]) => {
            const val = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
            const display = val.length > 200 ? val.slice(0, 200) + '...' : val;
            return `${k}: ${display}\n`;
          })}
        </pre>
      )}
    </div>
  );
}

export default function StructuredAuditLog({ notify }) {
  const [filters, setFilters] = useState({ action: '', entity_type: '', search: '', matter_id: '', client_id: '' });
  const [page, setPage] = useState(0);
  const [payload, setPayload] = useState({ rows: [], total: 0, limit: PAGE_SIZE, offset: 0 });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const result = await getAuditEvents({
          action: filters.action || undefined,
          entity_type: filters.entity_type || undefined,
          matter_id: filters.matter_id || undefined,
          client_id: filters.client_id || undefined,
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
    return () => { cancelled = true; };
  }, [filters.action, filters.entity_type, filters.matter_id, filters.client_id, notify, page]);

  const rows = (payload.rows || []).filter(row => {
    const needle = filters.search.trim().toLowerCase();
    if (!needle) return true;
    return (
      row.actor_email?.toLowerCase().includes(needle) ||
      row.actor_user_id?.toLowerCase().includes(needle) ||
      row.entity_id?.toLowerCase().includes(needle)
    );
  });

  function updateFilter(key, value) {
    setFilters(current => ({ ...current, [key]: value }));
    if (key !== 'search') setPage(0);
  }

  const tableRows = rows.map(row => [
    formatDate(row.timestamp),
    row.actor_email || '-',
    <Badge tone={row.actor_role === 'admin' ? 'green' : row.actor_role === 'client' ? 'amber' : 'blue'}>{row.actor_role || '-'}</Badge>,
    <Badge tone={actionTone(row.action)}>{pretty(row.action)}</Badge>,
    pretty(row.entity_type),
    row.entity_id || '-',
    row.matter_id || '-',
    row.client_id || '-',
    <MetadataCell metadata={row.metadata} />,
  ]);

  const total = Number(payload.total || 0);
  const start = total ? page * PAGE_SIZE + 1 : 0;
  const end = Math.min((page + 1) * PAGE_SIZE, total);
  const hasNext = (page + 1) * PAGE_SIZE < total;

  return (
    <div style={styles.pageStack}>
      <Card title="Structured Audit" hint="A detailed accountability trail for security and operational events across the firm.">
        <div style={styles.formGrid}>
          <Field label="Search">
            <input
              value={filters.search}
              onChange={event => updateFilter('search', event.target.value)}
              placeholder="Actor email, ID, or entity ID"
              style={styles.input}
            />
          </Field>
          <Field label="Action">
            <select value={filters.action} onChange={event => updateFilter('action', event.target.value)} style={styles.input}>
              <option value="">All</option>
              <option value="client_login_success">Client Login Success</option>
              <option value="client_login_failure">Client Login Failure</option>
              <option value="login_success">Login Success</option>
              <option value="login_failure">Login Failure</option>
              <option value="user_created">User Created</option>
              <option value="matter_created">Matter Created</option>
              <option value="matter_updated">Matter Updated</option>
              <option value="matter_archived">Matter Archived</option>
              <option value="client_created">Client Created</option>
              <option value="client_updated">Client Updated</option>
              <option value="invoice_generated">Invoice Generated</option>
              <option value="invoice_status_updated">Invoice Status Updated</option>
              <option value="payment_proof_uploaded">Payment Proof Uploaded</option>
              <option value="firm_settings_updated">Firm Settings Updated</option>
              <option value="export_downloaded">Export Downloaded</option>
              <option value="document_downloaded">Document Downloaded</option>
              <option value="document_accessed">Document Accessed</option>
            </select>
          </Field>
          <Field label="Entity Type">
            <select value={filters.entity_type} onChange={event => updateFilter('entity_type', event.target.value)} style={styles.input}>
              <option value="">All</option>
              <option value="user">User</option>
              <option value="client">Client</option>
              <option value="matter">Matter</option>
              <option value="invoice">Invoice</option>
              <option value="document">Document</option>
              <option value="firm_settings">Firm Settings</option>
              <option value="export">Export</option>
            </select>
          </Field>
          <Field label="Matter ID">
            <input
              value={filters.matter_id}
              onChange={event => updateFilter('matter_id', event.target.value)}
              placeholder="Filter by matter"
              style={styles.input}
            />
          </Field>
          <Field label="Client ID">
            <input
              value={filters.client_id}
              onChange={event => updateFilter('client_id', event.target.value)}
              placeholder="Filter by client"
              style={styles.input}
            />
          </Field>
          <div style={{ ...styles.formHelper, alignSelf: 'end' }}>
            Showing {start}-{end} of {total} server records. Text search filters the loaded page.
          </div>
        </div>
      </Card>

      <Card
        title="Audit Events"
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
            columns={['Timestamp', 'Actor', 'Role', 'Action', 'Entity Type', 'Entity ID', 'Matter ID', 'Client ID', 'Metadata']}
            rows={tableRows}
            empty="No audit events"
          />
        ) : (
          <Empty title="No audit events found" text="Try changing the filters or perform an action that generates audit events." />
        )}
        <div style={{ marginTop: 12, color: theme.muted, fontSize: 12 }}>
          Page {page + 1}
        </div>
      </Card>
    </div>
  );
}
