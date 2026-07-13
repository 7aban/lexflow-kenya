import { useEffect, useMemo, useRef, useState } from 'react';
import { archiveDocument, downloadWithAuth, fetchDocumentArrayBuffer, getGlobalDocuments, restoreDocument, updateDocument } from '../lib/apiClient.js';
import { Alert, Badge, Empty, Skeleton, Table } from '../components/ui.jsx';
import { styles } from '../theme.jsx';

const PAGE_LIMIT = 25;
const MAX_BULK_EXECUTION = 50;

const SORT_OPTIONS = [
  ['date_desc', 'Newest first'],
  ['date_asc', 'Oldest first'],
  ['name_asc', 'Name A–Z'],
  ['name_desc', 'Name Z–A'],
  ['matter_asc', 'Matter A–Z'],
  ['client_asc', 'Client A–Z'],
];

const initialFilters = {
  type: '',
  origin: '',
  visibility: '',
  matterId: '',
  clientId: '',
  sort: 'date_desc',
  includeArchived: false,
};

const emptyFilterOptions = () => ({
  clients: [],
  matters: [],
  types: [],
  sources: [],
  origins: [],
  visibilities: [],
});

function documentLabel(document) {
  return String(document?.displayName || document?.name || 'Document');
}

function formatDate(value) {
  if (!value) return 'Date unavailable';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(date);
}

function previewKind(document) {
  const mimeType = String(document?.mimeType || document?.type || '').toLowerCase();
  const name = documentLabel(document).toLowerCase();
  if (mimeType.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (mimeType.startsWith('image/') || /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(name)) return 'image';
  return '';
}

function previewMimeType(document, kind) {
  if (kind === 'pdf') return 'application/pdf';
  const mimeType = String(document?.mimeType || document?.type || '').toLowerCase();
  if (mimeType.startsWith('image/')) return mimeType;
  const extension = documentLabel(document).match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  return {
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  }[extension] || 'application/octet-stream';
}

function typeLabel(document) {
  const type = String(document?.type || '').trim();
  if (type) return type;
  const extension = documentLabel(document).match(/\.([^.]+)$/)?.[1];
  return extension ? extension.toUpperCase() : 'File';
}

function originLabel(origin) {
  return {
    firm: 'Firm upload',
    client: 'Client upload',
    generated: 'Generated',
    message: 'Message',
    notice: 'Notice',
  }[String(origin || '').toLowerCase()] || 'Firm upload';
}

function originTone(origin) {
  return origin === 'client' ? 'green' : origin === 'generated' ? 'amber' : 'blue';
}

function matterLabel(matter) {
  const reference = String(matter?.reference || '').trim();
  const title = String(matter?.title || '').trim();
  return reference || title || 'Matter';
}

function clientLabel(client) {
  return String(client?.name || '').trim() || 'Client unavailable';
}

const CLIENT_VISIBILITY_REASON_LABELS = Object.freeze({
  archived: 'Restore before changing client visibility.',
  message_context: 'Client access is managed by the linked conversation.',
  notice_context: 'Client access is managed by the linked notice.',
  client_upload: 'Client uploads remain client visible.',
  outside_matter_context: 'Client access is managed outside matter documents.',
});

function clientVisibilityCapability(document) {
  if (!document || document.archived) return { mutable: false, ineligibilityReason: 'archived' };
  const serverCapability = document?.capabilities?.clientVisibility;
  if (typeof serverCapability?.mutable === 'boolean') {
    return {
      mutable: serverCapability.mutable,
      ineligibilityReason: serverCapability.mutable ? null : String(serverCapability.ineligibilityReason || 'context_managed'),
    };
  }

  // Compatibility for disposable UI fixtures and older cached responses. The
  // server remains authoritative and revalidates every PATCH request.
  const origin = String(document.origin || '').toLowerCase();
  if (origin === 'message') return { mutable: false, ineligibilityReason: 'message_context' };
  if (origin === 'notice') return { mutable: false, ineligibilityReason: 'notice_context' };
  if (String(document.source || '').toLowerCase() === 'client' || origin === 'client') {
    return { mutable: false, ineligibilityReason: 'client_upload' };
  }
  return { mutable: true, ineligibilityReason: null };
}

function canChangeClientVisibility(document) {
  return clientVisibilityCapability(document).mutable;
}

function clientVisibilityReasonLabel(document) {
  const reason = clientVisibilityCapability(document).ineligibilityReason;
  return reason ? CLIENT_VISIBILITY_REASON_LABELS[reason] || 'Client access is managed by another document context.' : '';
}

function safeDocumentActionError(error) {
  const message = String(error?.message || '');
  if (/document name|180 characters|client visibility/i.test(message)) return message;
  if (/not found|access denied|no longer active|archived/i.test(message)) {
    return 'This document is no longer available for that action. The Explorer has been refreshed.';
  }
  return 'Unable to complete the document action. The Explorer has been refreshed.';
}

function isBulkEligible(document, action) {
  if (!document?.id) return false;
  if (action === 'archive') return !document.archived;
  if (action === 'restore') return Boolean(document.archived);
  const capability = clientVisibilityCapability(document);
  if (!capability.mutable) return false;
  if (action === 'make_client_visible') return document.visibility !== 'client';
  if (action === 'make_internal') return document.visibility === 'client';
  return false;
}

function bulkIneligibilityReason(document, action) {
  if (isBulkEligible(document, action)) return '';
  if (action === 'archive') return 'already archived';
  if (action === 'restore') return 'already active';
  const capability = clientVisibilityCapability(document);
  if (!capability.mutable) return clientVisibilityReasonLabel(document);
  return action === 'make_client_visible' ? 'Already client visible.' : 'Already internal.';
}

function bulkActionPresentation(action, eligibleCount) {
  const suffix = eligibleCount === 1 ? '' : 's';
  if (action === 'archive') return {
    title: 'Bulk archive loaded documents?',
    actionLabel: 'archive',
    eligibleText: `${eligibleCount} eligible active document${suffix}`,
    ineligibleText: count => `${count} ineligible archived document${count === 1 ? '' : 's'}`,
    confirmText: `Archive ${eligibleCount} document${suffix}`,
    runningText: 'Archiving…',
    endpointLabel: 'archive',
    destructive: true,
  };
  if (action === 'restore') return {
    title: 'Bulk restore loaded documents?',
    actionLabel: 'restore',
    eligibleText: `${eligibleCount} eligible archived document${suffix}`,
    ineligibleText: count => `${count} ineligible active document${count === 1 ? '' : 's'}`,
    confirmText: `Restore ${eligibleCount} document${suffix}`,
    runningText: 'Restoring…',
    endpointLabel: 'restore',
    destructive: false,
  };
  if (action === 'make_client_visible') return {
    title: 'Bulk make client visible?',
    actionLabel: 'make client visible',
    eligibleText: `${eligibleCount} eligible internal document${suffix}`,
    ineligibleText: count => `${count} ineligible or already client-visible document${count === 1 ? '' : 's'}`,
    confirmText: `Make ${eligibleCount} client visible`,
    runningText: 'Making client visible…',
    endpointLabel: 'visibility',
    destructive: false,
  };
  return {
    title: 'Bulk make internal?',
    actionLabel: 'make internal',
    eligibleText: `${eligibleCount} eligible client-visible document${suffix}`,
    ineligibleText: count => `${count} ineligible or already internal document${count === 1 ? '' : 's'}`,
    confirmText: `Make ${eligibleCount} internal`,
    runningText: 'Making internal…',
    endpointLabel: 'visibility',
    destructive: false,
  };
}

function isSessionExpiry(error) {
  return Boolean(error?.isAuthExpired || error?.name === 'AuthExpiredError');
}

async function fetchDocumentWindow(query, targetCount = PAGE_LIMIT) {
  let response = await getGlobalDocuments(query);
  const filterOptions = { ...emptyFilterOptions(), ...(response?.filterOptions || {}) };
  const items = [];
  const seenIds = new Set();
  for (const item of Array.isArray(response?.items) ? response.items : []) {
    const id = String(item.id);
    if (!seenIds.has(id)) {
      seenIds.add(id);
      items.push(item);
    }
  }
  let hasMore = Boolean(response?.hasMore);
  let nextCursor = response?.nextCursor || null;
  const seenCursors = new Set();
  let pageCount = 1;

  while (hasMore && nextCursor && items.length < targetCount && pageCount < 50 && !seenCursors.has(nextCursor)) {
    seenCursors.add(nextCursor);
    response = await getGlobalDocuments({ ...query, cursor: nextCursor });
    for (const item of Array.isArray(response?.items) ? response.items : []) {
      const id = String(item.id);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        items.push(item);
      }
    }
    hasMore = Boolean(response?.hasMore);
    nextCursor = response?.nextCursor || null;
    pageCount += 1;
  }

  return { items, hasMore, nextCursor, filterOptions };
}

function PreviewDialog({ preview, onClose, onDownload }) {
  useEffect(() => {
    if (!preview) return undefined;
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [preview, onClose]);

  if (!preview) return null;
  const label = documentLabel(preview.document);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="global-document-preview-title"
      className="lf-global-document-preview-backdrop"
      style={{ position: 'fixed', inset: 0, zIndex: 3100, background: 'rgba(17, 34, 25, 0.64)', padding: 16, display: 'grid', placeItems: 'center' }}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="lf-global-document-preview" style={{ width: 'min(100%, 1080px)', height: 'min(90vh, 820px)', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A1A18)', borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,.28)', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', overflow: 'hidden' }}>
        <header style={{ borderBottom: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <strong id="global-document-preview-title" style={{ display: 'block', overflowWrap: 'anywhere' }}>{label}</strong>
            <small style={styles.mutedText}>{typeLabel(preview.document)}</small>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" style={styles.ghostButton} onClick={() => onDownload(preview.document)}>Download</button>
            <button type="button" style={styles.primaryButton} onClick={onClose}>Close</button>
          </div>
        </header>
        <div style={{ minHeight: 0, padding: 16, background: 'color-mix(in srgb, var(--lf-card, #fff) 84%, var(--lf-background, #F5F2EB))', display: 'grid', placeItems: 'center', overflow: 'auto' }}>
          {preview.status === 'loading' && <div role="status">Loading preview…</div>}
          {preview.status === 'unsupported' && (
            <div style={{ ...styles.empty, background: 'var(--lf-card, #fff)', maxWidth: 480 }}>
              <strong>Preview not available for this file type.</strong>
              <span>You can download the document to open it instead.</span>
              <button type="button" style={styles.primaryButton} onClick={() => onDownload(preview.document)}>Download</button>
            </div>
          )}
          {preview.status === 'error' && (
            <div style={{ ...styles.empty, background: 'var(--lf-card, #fff)', maxWidth: 480 }}>
              <strong>Unable to preview this document.</strong>
              <span>{preview.error || 'Use download instead.'}</span>
              <button type="button" style={styles.primaryButton} onClick={() => onDownload(preview.document)}>Use download instead</button>
            </div>
          )}
          {preview.status === 'ready' && preview.kind === 'pdf' && (
            <iframe title={`Preview of ${label}`} src={preview.url} style={{ width: '100%', height: '100%', minHeight: 420, border: 0, background: '#fff' }} />
          )}
          {preview.status === 'ready' && preview.kind === 'image' && (
            <img src={preview.url} alt={`Preview of ${label}`} style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          )}
        </div>
      </section>
    </div>
  );
}

function RenameDocumentDialog({ document, value, error, pending, onChange, onCancel, onSubmit }) {
  useEffect(() => {
    if (!document) return undefined;
    function closeOnEscape(event) {
      if (event.key === 'Escape' && !pending) onCancel();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [document, onCancel, pending]);

  if (!document) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="global-document-rename-title"
      className="lf-global-document-action-dialog-backdrop"
      style={{ position: 'fixed', inset: 0, zIndex: 3200, background: 'rgba(17, 34, 25, 0.64)', padding: 16, display: 'grid', placeItems: 'center' }}
      onMouseDown={event => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <form className="lf-global-document-action-dialog" onSubmit={onSubmit} style={{ width: 'min(100%, 430px)', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A1A18)', borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,.28)', padding: 16, display: 'grid', gap: 12 }}>
        <div>
          <h2 id="global-document-rename-title" style={{ margin: 0, fontSize: 18 }}>Rename document</h2>
          <small style={styles.mutedText}>This changes the display name only.</small>
        </div>
        <label style={styles.field}>
          <span>Document name</span>
          <input
            autoFocus
            aria-label="Document name"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'global-document-rename-error' : 'global-document-rename-help'}
            style={{ ...styles.input, minWidth: 0 }}
            value={value}
            maxLength={181}
            disabled={pending}
            onChange={event => onChange(event.target.value)}
          />
        </label>
        {error
          ? <span id="global-document-rename-error" role="alert" style={{ color: 'var(--lf-danger, #A61B1B)', fontSize: 12 }}>{error}</span>
          : <span id="global-document-rename-help" style={styles.mutedText}>Maximum 180 characters.</span>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={styles.ghostButton} disabled={pending} onClick={onCancel}>Cancel</button>
          <button type="submit" style={styles.primaryButton} disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

function ArchiveDocumentDialog({ document, pending, onCancel, onConfirm }) {
  useEffect(() => {
    if (!document) return undefined;
    function closeOnEscape(event) {
      if (event.key === 'Escape' && !pending) onCancel();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [document, onCancel, pending]);

  if (!document) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="global-document-archive-title"
      className="lf-global-document-action-dialog-backdrop"
      style={{ position: 'fixed', inset: 0, zIndex: 3200, background: 'rgba(17, 34, 25, 0.64)', padding: 16, display: 'grid', placeItems: 'center' }}
      onMouseDown={event => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <section className="lf-global-document-action-dialog" style={{ width: 'min(100%, 430px)', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A1A18)', borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,.28)', padding: 16, display: 'grid', gap: 12 }}>
        <h2 id="global-document-archive-title" style={{ margin: 0, fontSize: 18 }}>Archive document?</h2>
        <p style={{ margin: 0, lineHeight: 1.5 }}>Archive “{documentLabel(document)}”? It will leave active documents and remain read-only until restored.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={styles.ghostButton} disabled={pending} onClick={onCancel}>Cancel</button>
          <button type="button" style={styles.dangerButton} disabled={pending} onClick={onConfirm}>{pending ? 'Archiving…' : 'Archive'}</button>
        </div>
      </section>
    </div>
  );
}

function BulkActionDialog({ intent, progress, onCancel, onConfirm }) {
  const running = Boolean(progress?.running);
  useEffect(() => {
    if (!intent) return undefined;
    function closeOnEscape(event) {
      if (event.key === 'Escape' && !running) onCancel();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [intent, onCancel, running]);

  if (!intent) return null;
  const action = intent.action;
  const eligibleCount = intent.documents.filter(document => isBulkEligible(document, action)).length;
  const ineligibleCount = intent.documents.length - eligibleCount;
  const presentation = bulkActionPresentation(action, eligibleCount);
  const visibilityAction = ['make_client_visible', 'make_internal'].includes(action);
  const reasonCounts = visibilityAction ? intent.documents.reduce((counts, document) => {
    const reason = bulkIneligibilityReason(document, action);
    if (reason) counts.set(reason, (counts.get(reason) || 0) + 1);
    return counts;
  }, new Map()) : new Map();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="global-document-bulk-title"
      className="lf-global-document-action-dialog-backdrop lf-global-document-bulk-dialog-backdrop"
      style={{ position: 'fixed', inset: 0, zIndex: 3200, background: 'rgba(17, 34, 25, 0.64)', padding: 16, display: 'grid', placeItems: 'center' }}
      onMouseDown={event => {
        if (event.target === event.currentTarget && !running) onCancel();
      }}
    >
      <section className="lf-global-document-action-dialog lf-global-document-bulk-dialog" style={{ width: 'min(100%, 520px)', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A1A18)', borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,.28)', padding: 16, display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <h2 id="global-document-bulk-title" style={{ margin: 0, fontSize: 18 }}>{presentation.title}</h2>
          <small style={styles.mutedText}>{intent.documents.length} selected from the current loaded result window.</small>
        </div>
        <p style={{ margin: 0, lineHeight: 1.5 }}>
          <strong>{presentation.eligibleText}</strong> will be processed.{' '}
          <strong>{presentation.ineligibleText(ineligibleCount)}</strong> will be skipped.
        </p>
        {visibilityAction && reasonCounts.size > 0 && (
          <div style={{ display: 'grid', gap: 4, padding: 10, borderRadius: 8, border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))' }}>
            <strong style={{ fontSize: 12 }}>Skipped selection details</strong>
            {[...reasonCounts.entries()].map(([reason, count]) => (
              <span key={reason} style={styles.mutedText}>{count} · {reason}</span>
            ))}
          </div>
        )}
        {action === 'make_client_visible' && (
          <p style={{ margin: 0, lineHeight: 1.5, padding: 10, borderRadius: 8, background: 'color-mix(in srgb, var(--lf-accent, #C5973C) 14%, var(--lf-card, #fff))' }}>
            <strong>Client access disclosure:</strong> These documents will become available through LexFlow’s client-facing matter document access rules.
          </p>
        )}
        <p style={{ margin: 0, lineHeight: 1.5 }}>
          Requests run sequentially through the existing per-document {presentation.endpointLabel} action. This operation is not transactional; successful requests are not rolled back if a later request fails.
        </p>
        {running && (
          <div role="status" aria-live="polite" className="lf-global-document-bulk-progress" style={{ display: 'grid', gap: 4, padding: 10, borderRadius: 8, background: 'color-mix(in srgb, var(--lf-card, #fff) 84%, var(--lf-background, #F5F2EB))' }}>
            <strong>Processing {progress.processed} of {progress.eligible} eligible request{progress.eligible === 1 ? '' : 's'}…</strong>
            <span>{progress.succeeded} succeeded · {progress.failed} failed · {progress.skipped} skipped</span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={styles.ghostButton} disabled={running} onClick={onCancel}>Cancel</button>
          <button
            autoFocus
            type="button"
            style={presentation.destructive ? styles.dangerButton : styles.primaryButton}
            disabled={running || eligibleCount === 0}
            onClick={onConfirm}
          >
            {running ? presentation.runningText : presentation.confirmText}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function DocumentsExplorer({ notify, onOpenMatter, allowArchived = false, canManage = false }) {
  const [searchDraft, setSearchDraft] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [filters, setFilters] = useState(initialFilters);
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const [preview, setPreview] = useState(null);
  const [filterOptions, setFilterOptions] = useState(emptyFilterOptions);
  const [pendingAction, setPendingAction] = useState(null);
  const [actionFeedback, setActionFeedback] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState('');
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkIntent, setBulkIntent] = useState(null);
  const [bulkProgress, setBulkProgress] = useState(null);
  const [bulkResult, setBulkResult] = useState(null);
  const listRequestRef = useRef(0);
  const previewRequestRef = useRef(0);
  const previewUrlRef = useRef('');
  const bulkRunRef = useRef(false);

  const clientOptions = useMemo(() => [...filterOptions.clients]
    .filter(client => client?.id)
    .sort((a, b) => clientLabel(a).localeCompare(clientLabel(b))), [filterOptions.clients]);
  const matterOptions = useMemo(() => [...filterOptions.matters]
    .filter(matter => matter?.id)
    .filter(matter => !filters.clientId || String(matter.clientId || '') === String(filters.clientId))
    .sort((a, b) => matterLabel(a).localeCompare(matterLabel(b))), [filterOptions.matters, filters.clientId]);
  const queryKey = useMemo(() => JSON.stringify({
    q: appliedSearch,
    type: filters.type,
    origin: filters.origin,
    visibility: filters.visibility,
    matterId: filters.matterId,
    clientId: filters.clientId,
    sort: filters.sort,
    status: allowArchived && filters.includeArchived ? 'all' : 'active',
    limit: PAGE_LIMIT,
  }), [allowArchived, appliedSearch, filters]);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedDocuments = useMemo(() => items.filter(document => selectedIdSet.has(String(document.id))), [items, selectedIdSet]);
  const selectionLimitExceeded = selectedDocuments.length > MAX_BULK_EXECUTION;
  const bulkRunning = Boolean(bulkProgress?.running);
  const actionPending = Boolean(pendingAction) || bulkRunning;

  useEffect(() => {
    const requestId = listRequestRef.current + 1;
    listRequestRef.current = requestId;
    let active = true;
    resetSelectionContext();
    setLoading(true);
    setLoadingMore(false);
    setError('');
    getGlobalDocuments(JSON.parse(queryKey))
      .then(response => {
        if (!active || listRequestRef.current !== requestId) return;
        setItems(Array.isArray(response?.items) ? response.items : []);
        setNextCursor(response?.nextCursor || null);
        setHasMore(Boolean(response?.hasMore));
        setFilterOptions({ ...emptyFilterOptions(), ...(response?.filterOptions || {}) });
      })
      .catch(caught => {
        if (!active || listRequestRef.current !== requestId) return;
        setItems([]);
        setNextCursor(null);
        setHasMore(false);
        setFilterOptions(emptyFilterOptions());
        setError(caught.message || 'Unable to load documents.');
      })
      .finally(() => {
        if (active && listRequestRef.current === requestId) setLoading(false);
      });
    return () => { active = false; };
  }, [queryKey, reloadNonce]);

  useEffect(() => {
    resetSelectionContext();
  }, [allowArchived, canManage]);

  useEffect(() => () => {
    previewRequestRef.current += 1;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  function resetSelectionContext() {
    setSelectedIds([]);
    setBulkIntent(null);
    setBulkResult(null);
  }

  function toggleDocumentSelection(documentId) {
    if (!canManage || actionPending) return;
    const id = String(documentId);
    setActionFeedback(null);
    setBulkResult(null);
    setSelectedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  }

  function selectLoadedDocuments() {
    if (!canManage || actionPending || !items.length) return;
    const ids = items.map(document => String(document.id));
    setSelectedIds(ids);
    setBulkResult(null);
    setActionFeedback(null);
  }

  function clearLoadedSelection() {
    if (actionPending) return;
    resetSelectionContext();
    setActionFeedback(null);
  }

  function changeSearchDraft(value) {
    if (value !== searchDraft) resetSelectionContext();
    setActionFeedback(null);
    setSearchDraft(value);
  }

  function updateFilter(name, value) {
    resetSelectionContext();
    setActionFeedback(null);
    setFilters(current => ({ ...current, [name]: value }));
  }

  function updateClientFilter(clientId) {
    resetSelectionContext();
    setActionFeedback(null);
    setFilters(current => {
      const selectedMatter = filterOptions.matters.find(matter => String(matter.id) === String(current.matterId));
      const keepMatter = !current.matterId
        || !clientId
        || String(selectedMatter?.clientId || '') === String(clientId);
      return { ...current, clientId, matterId: keepMatter ? current.matterId : '' };
    });
  }

  function clearFilters() {
    resetSelectionContext();
    setActionFeedback(null);
    setSearchDraft('');
    setAppliedSearch('');
    setFilters(initialFilters);
  }

  async function loadMore() {
    if (!hasMore || !nextCursor || loadingMore || actionPending || selectedIds.length) return;
    const requestId = listRequestRef.current;
    resetSelectionContext();
    setLoadingMore(true);
    setError('');
    try {
      const response = await getGlobalDocuments({ ...JSON.parse(queryKey), cursor: nextCursor });
      if (listRequestRef.current !== requestId) return;
      const page = Array.isArray(response?.items) ? response.items : [];
      setItems(current => {
        const seen = new Set(current.map(item => String(item.id)));
        const additions = [];
        for (const item of page) {
          const id = String(item.id);
          if (!seen.has(id)) {
            seen.add(id);
            additions.push(item);
          }
        }
        return [...current, ...additions];
      });
      setNextCursor(response?.nextCursor || null);
      setHasMore(Boolean(response?.hasMore));
    } catch (caught) {
      if (listRequestRef.current === requestId) setError(caught.message || 'Unable to load more documents.');
    } finally {
      if (listRequestRef.current === requestId) setLoadingMore(false);
    }
  }

  async function downloadDocument(document) {
    if (document?.archived) {
      notify?.({ type: 'warning', message: 'Archived documents cannot be downloaded until restored from the matter Explorer.' });
      return;
    }
    try {
      await downloadWithAuth(`/api/documents/${encodeURIComponent(document.id)}/download`, documentLabel(document));
    } catch (caught) {
      notify?.({ type: 'danger', message: caught.message || 'Unable to download this document.' });
    }
  }

  function revokePreviewUrl() {
    if (!previewUrlRef.current) return;
    URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = '';
  }

  function closePreview() {
    previewRequestRef.current += 1;
    revokePreviewUrl();
    setPreview(null);
  }

  async function openPreview(document) {
    if (document?.archived) {
      notify?.({ type: 'warning', message: 'Archived documents cannot be previewed until restored from the matter Explorer.' });
      return;
    }
    const kind = previewKind(document);
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    revokePreviewUrl();
    setPreview({ document, kind, status: kind ? 'loading' : 'unsupported', url: '', error: '' });
    if (!kind) return;
    try {
      const bytes = await fetchDocumentArrayBuffer(document.id);
      if (previewRequestRef.current !== requestId) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: previewMimeType(document, kind) }));
      if (previewRequestRef.current !== requestId) {
        URL.revokeObjectURL(url);
        return;
      }
      previewUrlRef.current = url;
      setPreview(current => current?.document.id === document.id ? { ...current, status: 'ready', url } : current);
    } catch (caught) {
      if (previewRequestRef.current !== requestId) return;
      setPreview(current => current?.document.id === document.id
        ? { ...current, status: 'error', error: caught.message || 'Unable to preview this document.' }
        : current);
    }
  }

  async function refreshExplorerWindow(targetCount = PAGE_LIMIT, { clearSelection = true } = {}) {
    const requestId = listRequestRef.current + 1;
    listRequestRef.current = requestId;
    if (clearSelection) resetSelectionContext();
    setLoadingMore(false);
    setError('');
    const response = await fetchDocumentWindow(JSON.parse(queryKey), targetCount);
    if (listRequestRef.current !== requestId) return false;
    setItems(response.items);
    setNextCursor(response.nextCursor);
    setHasMore(response.hasMore);
    setFilterOptions(response.filterOptions);
    return response;
  }

  async function runDocumentAction({ document, action, pendingMessage, successMessage, request }) {
    if (!canManage || actionPending || !document?.id) return { ok: false, error: 'Document action unavailable.' };
    const targetCount = Math.max(PAGE_LIMIT, items.length);
    setPendingAction({ documentId: String(document.id), action });
    setActionFeedback({ type: 'pending', message: pendingMessage });
    try {
      await request();
    } catch (caught) {
      const message = safeDocumentActionError(caught);
      try { await refreshExplorerWindow(targetCount); } catch {}
      setActionFeedback({ type: 'error', message });
      notify?.({ type: 'danger', message });
      setPendingAction(null);
      return { ok: false, error: message };
    }

    try {
      await refreshExplorerWindow(targetCount);
      setActionFeedback({ type: 'success', message: successMessage });
      notify?.({ type: 'success', message: successMessage });
    } catch {
      const message = `${successMessage} The Explorer could not refresh automatically; use Refresh to reload it.`;
      setActionFeedback({ type: 'warning', message });
      notify?.({ type: 'warning', message });
    } finally {
      setPendingAction(null);
    }
    return { ok: true };
  }

  function beginRename(document) {
    if (!canManage || document?.archived || actionPending) return;
    setActionFeedback(null);
    setRenameTarget(document);
    setRenameName(documentLabel(document));
    setRenameError('');
  }

  function closeRename() {
    if (pendingAction?.action === 'rename') return;
    setRenameTarget(null);
    setRenameName('');
    setRenameError('');
  }

  async function saveRename(event) {
    event.preventDefault();
    if (!renameTarget || actionPending) return;
    const displayName = renameName.trim();
    if (!displayName) {
      setRenameError('Document name is required.');
      return;
    }
    if (displayName.length > 180) {
      setRenameError('Document name must be 180 characters or fewer.');
      return;
    }
    if (displayName === documentLabel(renameTarget).trim()) {
      closeRename();
      return;
    }
    setRenameError('');
    const result = await runDocumentAction({
      document: renameTarget,
      action: 'rename',
      pendingMessage: 'Renaming document…',
      successMessage: 'Document renamed.',
      request: () => updateDocument(renameTarget.id, { displayName }),
    });
    if (result.ok) closeRename();
    else setRenameError(result.error);
  }

  async function changeVisibility(document) {
    if (!canChangeClientVisibility(document)) return;
    const makeVisible = document.visibility !== 'client';
    await runDocumentAction({
      document,
      action: 'visibility',
      pendingMessage: 'Updating client visibility…',
      successMessage: makeVisible ? 'Document is now visible to the client.' : 'Document is now internal.',
      request: () => updateDocument(document.id, { clientVisible: makeVisible }),
    });
  }

  async function confirmArchive() {
    if (!archiveTarget || actionPending) return;
    const target = archiveTarget;
    const result = await runDocumentAction({
      document: target,
      action: 'archive',
      pendingMessage: 'Archiving document…',
      successMessage: 'Document archived.',
      request: () => archiveDocument(target.id),
    });
    setArchiveTarget(null);
    return result;
  }

  async function restoreArchivedDocument(document) {
    if (!document?.archived) return;
    await runDocumentAction({
      document,
      action: 'restore',
      pendingMessage: 'Restoring document…',
      successMessage: 'Document restored.',
      request: () => restoreDocument(document.id),
    });
  }

  function beginBulkAction(action, selection = selectedIds) {
    if (!canManage || actionPending || !['archive', 'restore', 'make_client_visible', 'make_internal'].includes(action)) return;
    const selectionSet = new Set(selection.map(String));
    const documents = items.filter(document => selectionSet.has(String(document.id)));
    if (!documents.length) return;
    if (documents.length > MAX_BULK_EXECUTION) {
      setActionFeedback({
        type: 'error',
        message: `${documents.length} documents are selected. Bulk actions are limited to ${MAX_BULK_EXECUTION} documents; clear selection and select no more than ${MAX_BULK_EXECUTION}.`,
      });
      return;
    }
    setActionFeedback(null);
    setBulkResult(null);
    setSelectedIds(documents.map(document => String(document.id)));
    setBulkProgress(null);
    setBulkIntent({ action, documents });
  }

  function retryFailedBulkAction() {
    if (!bulkResult?.retryIds?.length || actionPending) return;
    beginBulkAction(bulkResult.action, bulkResult.retryIds);
  }

  async function confirmBulkAction() {
    if (!canManage || !bulkIntent || bulkRunRef.current || pendingAction) return;
    const { action, documents } = bulkIntent;
    if (documents.length > MAX_BULK_EXECUTION) {
      setActionFeedback({ type: 'error', message: `Bulk actions are limited to ${MAX_BULK_EXECUTION} documents.` });
      setBulkIntent(null);
      return;
    }
    const eligibleDocuments = documents.filter(document => isBulkEligible(document, action));
    if (!eligibleDocuments.length) return;

    bulkRunRef.current = true;
    const targetCount = Math.max(PAGE_LIMIT, items.length);
    const initialSkipped = documents.length - eligibleDocuments.length;
    let succeeded = 0;
    let failed = 0;
    let skipped = initialSkipped;
    let aborted = false;
    let refreshFailed = false;
    const failedIds = [];
    setBulkResult(null);
    setBulkProgress({
      running: true,
      action,
      eligible: eligibleDocuments.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: initialSkipped,
      currentId: '',
    });

    try {
      for (let index = 0; index < eligibleDocuments.length; index += 1) {
        const document = eligibleDocuments[index];
        setBulkProgress(current => ({ ...current, currentId: String(document.id) }));
        try {
          if (action === 'archive') await archiveDocument(document.id);
          else if (action === 'restore') await restoreDocument(document.id);
          else await updateDocument(document.id, { clientVisible: action === 'make_client_visible' });
          succeeded += 1;
        } catch (caught) {
          failed += 1;
          failedIds.push(String(document.id));
          if (isSessionExpiry(caught)) {
            aborted = true;
            skipped += eligibleDocuments.length - index - 1;
          }
        }
        setBulkProgress(current => ({
          ...current,
          processed: index + 1,
          succeeded,
          failed,
          skipped,
        }));
        if (aborted) break;
      }

      let rebuiltItems = items;
      if (!aborted) {
        try {
          const response = await refreshExplorerWindow(targetCount, { clearSelection: false });
          rebuiltItems = response.items;
        } catch {
          refreshFailed = true;
        }
      }

      const failedIdSet = new Set(failedIds);
      const retryIds = rebuiltItems
        .filter(document => failedIdSet.has(String(document.id)) && isBulkEligible(document, action))
        .map(document => String(document.id));
      setSelectedIds(retryIds);

      const actionLabel = bulkActionPresentation(action, eligibleDocuments.length).actionLabel;
      const message = `Bulk ${actionLabel} finished: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped.`
        + (aborted ? ' Session expired, so the remaining requests were not sent.' : '')
        + (refreshFailed ? ' The Explorer could not rebuild the loaded window automatically; use Refresh to reload it.' : '')
        + (failed > 0 && retryIds.length === 0 ? ' No failed documents remain loaded and eligible for retry.' : '');
      const result = {
        action,
        total: documents.length,
        succeeded,
        failed,
        skipped,
        aborted,
        refreshFailed,
        retryIds,
        message,
      };
      setActionFeedback(null);
      setBulkResult(result);
      notify?.({ type: aborted ? 'danger' : failed || refreshFailed ? 'warning' : 'success', message });
    } finally {
      bulkRunRef.current = false;
      setBulkProgress(null);
      setBulkIntent(null);
    }
  }

  const hasActiveFilters = Boolean(appliedSearch
    || filters.type
    || filters.origin
    || filters.visibility
    || filters.matterId
    || filters.clientId
    || filters.sort !== initialFilters.sort
    || filters.includeArchived);
  const rows = items.map(document => {
    const label = documentLabel(document);
    const documentId = String(document.id);
    const folderArchived = Boolean(document?.location?.folderArchived);
    const folderLabel = String(document?.folderPathLabel || 'Uncategorised');
    const rowPending = pendingAction?.documentId === documentId || bulkProgress?.currentId === documentId;
    const selected = selectedIdSet.has(documentId);
    const visibilityCapability = clientVisibilityCapability(document);
    const visibilityMutable = canManage && visibilityCapability.mutable;
    const cells = [
      <div key={`${document.id}-document`} style={{ display: 'grid', gap: 3, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
          <strong style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{label}</strong>
          {document.archived && <Badge tone="amber">Archived</Badge>}
        </div>
        <small style={styles.mutedText}>{typeLabel(document)}{document.size ? ` · ${document.size}` : ''}{document.uploaderDisplay ? ` · ${document.uploaderDisplay}` : ''}</small>
      </div>,
      <div key={`${document.id}-matter`} style={{ display: 'grid', gap: 3, minWidth: 0 }}>
        <strong style={{ fontWeight: 650, overflowWrap: 'anywhere' }}>{matterLabel(document.matter)}</strong>
        {document.matter?.title && document.matter.title !== document.matter.reference && <small style={styles.mutedText}>{document.matter.title}</small>}
      </div>,
      <span key={`${document.id}-client`} style={{ overflowWrap: 'anywhere' }}>{document.client ? clientLabel(document.client) : 'No client'}</span>,
      <div key={`${document.id}-folder`} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5, minWidth: 0 }}>
        <span style={{ overflowWrap: 'anywhere' }}>{folderLabel}</span>
        {folderArchived && <Badge tone="amber">Archived location</Badge>}
      </div>,
      <span key={`${document.id}-date`} style={{ whiteSpace: 'nowrap' }}>{formatDate(document.date)}</span>,
      <Badge key={`${document.id}-origin`} tone={originTone(document.origin)}>{originLabel(document.origin)}</Badge>,
      <div key={`${document.id}-visibility`} style={{ display: 'grid', gap: 3, minWidth: 0 }}>
        <Badge tone={document.visibility === 'client' ? 'green' : 'blue'}>{document.visibility === 'client' ? 'Client visible' : 'Internal'}</Badge>
        {canManage && !visibilityCapability.mutable && <small style={styles.mutedText}>{clientVisibilityReasonLabel(document)}</small>}
      </div>,
      <div key={`${document.id}-actions`} className="lf-global-document-actions" aria-busy={rowPending || undefined} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={styles.tinyButton} onClick={() => openPreview(document)} disabled={Boolean(document.archived) || rowPending || bulkRunning} title={document.archived ? 'Restore this document before previewing.' : undefined}>Preview</button>
        <button type="button" style={styles.tinyButton} onClick={() => downloadDocument(document)} disabled={Boolean(document.archived) || rowPending || bulkRunning} title={document.archived ? 'Restore this document before downloading.' : undefined}>Download</button>
        <button
          type="button"
          style={styles.tinyButton}
          onClick={() => onOpenMatter?.(document.matter?.id, {
            folderId: document.folder?.id || (document.location?.status === 'uncategorised' ? 'uncategorised' : ''),
            documentId: document.id,
          })}
          disabled={!document.matter?.id || rowPending || bulkRunning}
        >Open matter</button>
        {canManage && !document.archived && (
          <button type="button" style={styles.tinyButton} onClick={() => beginRename(document)} disabled={actionPending}>{rowPending && pendingAction?.action === 'rename' ? 'Renaming…' : 'Rename'}</button>
        )}
        {visibilityMutable && (
          <button type="button" style={styles.tinyButton} onClick={() => changeVisibility(document)} disabled={actionPending}>
            {rowPending && pendingAction?.action === 'visibility' ? 'Updating…' : document.visibility === 'client' ? 'Make internal' : 'Make client visible'}
          </button>
        )}
        {canManage && !document.archived && (
          <button type="button" style={styles.dangerTinyButton || styles.tinyButton} onClick={() => { setActionFeedback(null); setArchiveTarget(document); }} disabled={actionPending}>{rowPending && pendingAction?.action === 'archive' ? 'Archiving…' : 'Archive'}</button>
        )}
        {canManage && document.archived && (
          <button type="button" style={styles.primaryButton} onClick={() => restoreArchivedDocument(document)} disabled={actionPending}>{rowPending && pendingAction?.action === 'restore' ? 'Restoring…' : 'Restore'}</button>
        )}
      </div>,
    ];
    if (canManage) {
      cells.unshift(
        <label key={`${document.id}-selection`} className="lf-global-document-selection-control" title={`Select ${label}`} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, minHeight: 36, cursor: actionPending ? 'not-allowed' : 'pointer' }}>
          <input
            type="checkbox"
            className="lf-global-document-select-checkbox"
            aria-label={`Select ${label}`}
            checked={selected}
            disabled={actionPending}
            onChange={() => toggleDocumentSelection(documentId)}
          />
        </label>
      );
    }
    return cells;
  });

  return (
    <>
      <section className="lf-global-documents-explorer" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
        <div style={{ ...styles.card, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Document register</h2>
              <p style={{ margin: 0, color: 'var(--lf-card-muted, var(--lf-text-muted, #6B6B66))', lineHeight: 1.5 }}>{canManage ? 'Manage documents linked to accessible matters. Bulk lifecycle and client-visibility actions apply only to the current loaded result window; movement and uploads remain in the matter Explorer.' : 'Read-only workspace for documents linked to accessible matters.'} Archived records remain unavailable for preview, download, or visibility changes.</p>
            </div>
            <Badge tone={canManage ? 'green' : 'blue'}>{canManage ? 'Controlled actions' : 'Read only'}</Badge>
          </div>

          <form
            role="search"
            aria-label="Search documents"
            className="lf-global-documents-search"
            style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 8, minWidth: 0 }}
            onSubmit={event => {
              event.preventDefault();
              if (actionPending) return;
              resetSelectionContext();
              setActionFeedback(null);
              setAppliedSearch(searchDraft.trim());
            }}
          >
            <input
              type="search"
              aria-label="Search document metadata"
              placeholder="Search name, matter, client, or folder"
              value={searchDraft}
              maxLength={160}
              disabled={actionPending}
              onChange={event => changeSearchDraft(event.target.value)}
              style={{ ...styles.input, minWidth: 0 }}
            />
            <button type="submit" style={styles.primaryButton} disabled={actionPending}>Search</button>
            <button type="button" style={styles.ghostButton} onClick={clearFilters} disabled={actionPending || (!hasActiveFilters && !searchDraft)}>Clear</button>
          </form>

          <div className="lf-global-documents-filter-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(140px, 1fr))', gap: 10 }}>
            <label style={styles.field}>
              <span>File type</span>
              <select aria-label="Filter by file type" style={styles.input} value={filters.type} disabled={actionPending} onChange={event => updateFilter('type', event.target.value)}>
                <option value="">All available file types</option>
                {filterOptions.types.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span>Source / origin</span>
              <select aria-label="Filter by origin" style={styles.input} value={filters.origin} disabled={actionPending} onChange={event => updateFilter('origin', event.target.value)}>
                <option value="">All available origins</option>
                {filterOptions.origins.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span>Visibility</span>
              <select aria-label="Filter by visibility" style={styles.input} value={filters.visibility} disabled={actionPending} onChange={event => updateFilter('visibility', event.target.value)}>
                <option value="">All available visibility</option>
                {filterOptions.visibilities.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span>Matter</span>
              <select aria-label="Filter by matter" style={styles.input} value={filters.matterId} disabled={actionPending} onChange={event => updateFilter('matterId', event.target.value)}>
                <option value="">All accessible matters</option>
                {matterOptions.map(matter => <option key={matter.id} value={matter.id}>{matterLabel(matter)}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span>Client</span>
              <select aria-label="Filter by client" style={styles.input} value={filters.clientId} disabled={actionPending} onChange={event => updateClientFilter(event.target.value)}>
                <option value="">All accessible clients</option>
                {clientOptions.map(client => <option key={client.id} value={client.id}>{clientLabel(client)}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span>Sort</span>
              <select aria-label="Sort documents" style={styles.input} value={filters.sort} disabled={actionPending} onChange={event => updateFilter('sort', event.target.value)}>
                {SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {allowArchived && (
              <label style={{ ...styles.field, alignContent: 'end' }}>
                <span>Document status</span>
                <span style={{ ...styles.input, display: 'flex', alignItems: 'center', gap: 8, minHeight: 42, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    aria-label="Include archived documents"
                    checked={filters.includeArchived}
                    disabled={actionPending}
                    onChange={event => updateFilter('includeArchived', event.target.checked)}
                  />
                  Include archived documents
                </span>
              </label>
            )}
          </div>
        </div>

        {bulkResult && (
          <Alert tone={bulkResult.aborted ? 'danger' : undefined}>
            <div className="lf-global-document-bulk-result" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span role={bulkResult.aborted ? 'alert' : 'status'} aria-live="polite">{bulkResult.message}</span>
              {bulkResult.retryIds.length > 0 && (
                <button type="button" style={styles.ghostButton} disabled={actionPending} onClick={retryFailedBulkAction}>Retry failed</button>
              )}
            </div>
          </Alert>
        )}

        {actionFeedback && (
          <Alert tone={actionFeedback.type === 'error' ? 'danger' : undefined}>
            <span role={actionFeedback.type === 'error' ? 'alert' : 'status'} aria-live="polite">{actionFeedback.message}</span>
          </Alert>
        )}

        {error && (
          <Alert tone="danger">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{error}</span>
              <button type="button" style={styles.ghostButton} disabled={actionPending} onClick={() => { resetSelectionContext(); setActionFeedback(null); setReloadNonce(value => value + 1); }}>Try again</button>
            </div>
          </Alert>
        )}

        {loading ? <Skeleton rows={3} /> : (
          <div style={{ ...styles.card, display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div role="status" aria-live="polite" style={styles.mutedText}>{items.length} loaded document{items.length === 1 ? '' : 's'}{hasMore ? ' · more available' : ''}</div>
              <button type="button" style={styles.ghostButton} disabled={actionPending} onClick={() => { resetSelectionContext(); setActionFeedback(null); setReloadNonce(value => value + 1); }}>Refresh</button>
            </div>
            {canManage && items.length > 0 && (
              <div className="lf-global-documents-bulk-toolbar" aria-label="Loaded document selection" style={{ display: 'grid', gap: 8, padding: 12, border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', borderRadius: 9, background: 'color-mix(in srgb, var(--lf-card, #fff) 88%, var(--lf-background, #F5F2EB))' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div className="lf-global-documents-selection-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" style={styles.ghostButton} disabled={actionPending || selectedDocuments.length === items.length} onClick={selectLoadedDocuments}>Select loaded</button>
                    <button type="button" style={styles.ghostButton} disabled={actionPending || selectedDocuments.length === 0} onClick={clearLoadedSelection}>Clear selection</button>
                    <strong className="lf-global-documents-selection-summary" aria-live="polite">{selectedDocuments.length} selected from {items.length} loaded</strong>
                  </div>
                  <div className="lf-global-documents-bulk-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" style={styles.primaryButton} disabled={actionPending || selectedDocuments.length === 0 || selectionLimitExceeded} onClick={() => beginBulkAction('make_client_visible')}>Bulk make client visible</button>
                    <button type="button" style={styles.ghostButton} disabled={actionPending || selectedDocuments.length === 0 || selectionLimitExceeded} onClick={() => beginBulkAction('make_internal')}>Bulk make internal</button>
                    <button type="button" style={styles.dangerButton} disabled={actionPending || selectedDocuments.length === 0 || selectionLimitExceeded} onClick={() => beginBulkAction('archive')}>Bulk archive</button>
                    <button type="button" style={styles.primaryButton} disabled={actionPending || selectedDocuments.length === 0 || selectionLimitExceeded} onClick={() => beginBulkAction('restore')}>Bulk restore</button>
                  </div>
                </div>
                {selectedDocuments.length > 0 && !selectionLimitExceeded && <small style={styles.mutedText}>Load more is disabled while documents are selected. Clear selection to change the loaded result window.</small>}
                {selectionLimitExceeded && (
                  <span role="alert" style={{ color: 'var(--lf-danger, #A61B1B)', fontWeight: 700 }}>
                    {selectedDocuments.length} documents are selected. Bulk actions are limited to {MAX_BULK_EXECUTION} documents; clear selection and select no more than {MAX_BULK_EXECUTION}.
                  </span>
                )}
              </div>
            )}
            {items.length ? (
              <div className={`lf-global-documents-cards${canManage ? ' lf-global-documents-selectable' : ''}`}>
                <Table
                  columns={canManage ? ['Select', 'Document', 'Matter', 'Client', 'Folder', 'Date', 'Origin', 'Visibility', 'Actions'] : ['Document', 'Matter', 'Client', 'Folder', 'Date', 'Origin', 'Visibility', 'Actions']}
                  rows={rows}
                  rowProps={items.map(document => ({
                    'data-document-id': String(document.id),
                    'data-document-selected': canManage && selectedIdSet.has(String(document.id)) ? 'true' : undefined,
                    'aria-selected': canManage ? selectedIdSet.has(String(document.id)) : undefined,
                    'data-document-action-pending': pendingAction?.documentId === String(document.id)
                      ? pendingAction.action
                      : bulkProgress?.currentId === String(document.id) ? `bulk-${bulkProgress.action}` : undefined,
                  }))}
                />
              </div>
            ) : (
              <Empty title="No documents found" text={hasActiveFilters ? 'Try changing the search or filters.' : 'No active matter documents are available to your account.'} />
            )}
            {hasMore && (
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <button type="button" style={styles.primaryButton} onClick={loadMore} disabled={loadingMore || actionPending || selectedDocuments.length > 0} title={selectedDocuments.length > 0 ? 'Clear selection before loading more documents.' : undefined}>{loadingMore ? 'Loading…' : 'Load more'}</button>
              </div>
            )}
          </div>
        )}
      </section>
      <PreviewDialog preview={preview} onClose={closePreview} onDownload={downloadDocument} />
      <RenameDocumentDialog
        document={renameTarget}
        value={renameName}
        error={renameError}
        pending={pendingAction?.action === 'rename'}
        onChange={value => { setRenameName(value); if (renameError) setRenameError(''); }}
        onCancel={closeRename}
        onSubmit={saveRename}
      />
      <ArchiveDocumentDialog
        document={archiveTarget}
        pending={pendingAction?.action === 'archive'}
        onCancel={() => { if (!pendingAction) setArchiveTarget(null); }}
        onConfirm={confirmArchive}
      />
      <BulkActionDialog
        intent={bulkIntent}
        progress={bulkProgress}
        onCancel={() => { if (!bulkRunning) setBulkIntent(null); }}
        onConfirm={confirmBulkAction}
      />
    </>
  );
}
