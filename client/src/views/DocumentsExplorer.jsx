import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadWithAuth, fetchDocumentArrayBuffer, getGlobalDocuments } from '../lib/apiClient.js';
import { Alert, Badge, Empty, Skeleton, Table } from '../components/ui.jsx';
import { styles } from '../theme.jsx';

const PAGE_LIMIT = 25;

const TYPE_OPTIONS = [
  ['', 'All file types'],
  ['pdf', 'PDF'],
  ['word', 'Word'],
  ['image', 'Image'],
  ['text', 'Text'],
  ['file', 'Other file'],
];

const ORIGIN_OPTIONS = [
  ['', 'All origins'],
  ['firm', 'Firm upload'],
  ['client', 'Client upload'],
  ['generated', 'Generated'],
  ['message', 'Message attachment'],
  ['notice', 'Notice attachment'],
];

const VISIBILITY_OPTIONS = [
  ['', 'All visibility'],
  ['internal', 'Internal'],
  ['client', 'Client visible'],
];

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
};

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

export default function DocumentsExplorer({ matters = [], clients = [], notify, onOpenMatter }) {
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
  const listRequestRef = useRef(0);
  const previewRequestRef = useRef(0);
  const previewUrlRef = useRef('');

  const clientOptions = useMemo(() => [...clients]
    .filter(client => client?.id)
    .sort((a, b) => clientLabel(a).localeCompare(clientLabel(b))), [clients]);
  const matterOptions = useMemo(() => [...matters]
    .filter(matter => matter?.id)
    .sort((a, b) => matterLabel(a).localeCompare(matterLabel(b))), [matters]);
  const queryKey = useMemo(() => JSON.stringify({
    q: appliedSearch,
    ...filters,
    limit: PAGE_LIMIT,
  }), [appliedSearch, filters]);

  useEffect(() => {
    const requestId = listRequestRef.current + 1;
    listRequestRef.current = requestId;
    let active = true;
    setLoading(true);
    setLoadingMore(false);
    setError('');
    getGlobalDocuments(JSON.parse(queryKey))
      .then(response => {
        if (!active || listRequestRef.current !== requestId) return;
        setItems(Array.isArray(response?.items) ? response.items : []);
        setNextCursor(response?.nextCursor || null);
        setHasMore(Boolean(response?.hasMore));
      })
      .catch(caught => {
        if (!active || listRequestRef.current !== requestId) return;
        setItems([]);
        setNextCursor(null);
        setHasMore(false);
        setError(caught.message || 'Unable to load documents.');
      })
      .finally(() => {
        if (active && listRequestRef.current === requestId) setLoading(false);
      });
    return () => { active = false; };
  }, [queryKey, reloadNonce]);

  useEffect(() => () => {
    previewRequestRef.current += 1;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  function updateFilter(name, value) {
    setFilters(current => ({ ...current, [name]: value }));
  }

  function clearFilters() {
    setSearchDraft('');
    setAppliedSearch('');
    setFilters(initialFilters);
  }

  async function loadMore() {
    if (!hasMore || !nextCursor || loadingMore) return;
    const requestId = listRequestRef.current;
    setLoadingMore(true);
    setError('');
    try {
      const response = await getGlobalDocuments({ ...JSON.parse(queryKey), cursor: nextCursor });
      if (listRequestRef.current !== requestId) return;
      const page = Array.isArray(response?.items) ? response.items : [];
      setItems(current => {
        const seen = new Set(current.map(item => String(item.id)));
        return [...current, ...page.filter(item => !seen.has(String(item.id)))];
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

  const hasActiveFilters = Boolean(appliedSearch
    || filters.type
    || filters.origin
    || filters.visibility
    || filters.matterId
    || filters.clientId
    || filters.sort !== initialFilters.sort);

  const rows = items.map(document => {
    const label = documentLabel(document);
    const folderArchived = Boolean(document?.location?.folderArchived);
    const folderLabel = String(document?.folderPathLabel || 'Uncategorised');
    return [
      <div key={`${document.id}-document`} style={{ display: 'grid', gap: 3, minWidth: 0 }}>
        <strong style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{label}</strong>
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
      <Badge key={`${document.id}-visibility`} tone={document.visibility === 'client' ? 'green' : 'blue'}>{document.visibility === 'client' ? 'Client visible' : 'Internal'}</Badge>,
      <div key={`${document.id}-actions`} className="lf-global-document-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={styles.tinyButton} onClick={() => openPreview(document)}>Preview</button>
        <button type="button" style={styles.tinyButton} onClick={() => downloadDocument(document)}>Download</button>
        <button type="button" style={styles.tinyButton} onClick={() => onOpenMatter?.(document.matter?.id)} disabled={!document.matter?.id}>Open matter</button>
      </div>,
    ];
  });

  return (
    <>
      <section className="lf-global-documents-explorer" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
        <div style={{ ...styles.card, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Document register</h2>
              <p style={{ margin: 0, color: 'var(--lf-card-muted, var(--lf-text-muted, #6B6B66))', lineHeight: 1.5 }}>Read-only workspace for active documents linked to accessible matters. File content is loaded only when you preview or download.</p>
            </div>
            <Badge tone="blue">Read only</Badge>
          </div>

          <form
            role="search"
            aria-label="Search documents"
            className="lf-global-documents-search"
            style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 8, minWidth: 0 }}
            onSubmit={event => {
              event.preventDefault();
              setAppliedSearch(searchDraft.trim());
            }}
          >
            <input
              type="search"
              aria-label="Search document metadata"
              placeholder="Search name, matter, client, or folder"
              value={searchDraft}
              maxLength={160}
              onChange={event => setSearchDraft(event.target.value)}
              style={{ ...styles.input, minWidth: 0 }}
            />
            <button type="submit" style={styles.primaryButton}>Search</button>
            <button type="button" style={styles.ghostButton} onClick={clearFilters} disabled={!hasActiveFilters && !searchDraft}>Clear</button>
          </form>

          <div className="lf-global-documents-filter-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(140px, 1fr))', gap: 10 }}>
            <label style={styles.field}>
              <span>File type</span>
              <select aria-label="Filter by file type" style={styles.input} value={filters.type} onChange={event => updateFilter('type', event.target.value)}>
                {TYPE_OPTIONS.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span>Origin</span>
              <select aria-label="Filter by origin" style={styles.input} value={filters.origin} onChange={event => updateFilter('origin', event.target.value)}>
                {ORIGIN_OPTIONS.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span>Visibility</span>
              <select aria-label="Filter by visibility" style={styles.input} value={filters.visibility} onChange={event => updateFilter('visibility', event.target.value)}>
                {VISIBILITY_OPTIONS.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span>Matter</span>
              <select aria-label="Filter by matter" style={styles.input} value={filters.matterId} onChange={event => updateFilter('matterId', event.target.value)}>
                <option value="">All accessible matters</option>
                {matterOptions.map(matter => <option key={matter.id} value={matter.id}>{matterLabel(matter)}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span>Client</span>
              <select aria-label="Filter by client" style={styles.input} value={filters.clientId} onChange={event => updateFilter('clientId', event.target.value)}>
                <option value="">All accessible clients</option>
                {clientOptions.map(client => <option key={client.id} value={client.id}>{clientLabel(client)}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span>Sort</span>
              <select aria-label="Sort documents" style={styles.input} value={filters.sort} onChange={event => updateFilter('sort', event.target.value)}>
                {SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>
        </div>

        {error && (
          <Alert tone="danger">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{error}</span>
              <button type="button" style={styles.ghostButton} onClick={() => setReloadNonce(value => value + 1)}>Try again</button>
            </div>
          </Alert>
        )}

        {loading ? <Skeleton rows={3} /> : (
          <div style={{ ...styles.card, display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div role="status" aria-live="polite" style={styles.mutedText}>{items.length} loaded document{items.length === 1 ? '' : 's'}{hasMore ? ' · more available' : ''}</div>
              <button type="button" style={styles.ghostButton} onClick={() => setReloadNonce(value => value + 1)}>Refresh</button>
            </div>
            {items.length ? (
              <div className="lf-global-documents-cards">
                <Table
                  columns={['Document', 'Matter', 'Client', 'Folder', 'Date', 'Origin', 'Visibility', 'Actions']}
                  rows={rows}
                  rowProps={items.map(document => ({ 'data-document-id': String(document.id) }))}
                />
              </div>
            ) : (
              <Empty title="No documents found" text={hasActiveFilters ? 'Try changing the search or filters.' : 'No active matter documents are available to your account.'} />
            )}
            {hasMore && (
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <button type="button" style={styles.primaryButton} onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>
              </div>
            )}
          </div>
        )}
      </section>
      <PreviewDialog preview={preview} onClose={closePreview} onDownload={downloadDocument} />
    </>
  );
}
