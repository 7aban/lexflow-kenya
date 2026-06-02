import { styles, theme } from '../../theme.jsx';
import { Alert } from '../../components/ui.jsx';

// Presentational: renders the Active Templates preview panel. State and the
// previewDocumentTemplate API call stay in DocumentStudio; this component only
// receives props and emits intent via setters/handlers.
export default function TemplatePreviewPanel({
  previewTemplate,
  matters,
  mattersLoading,
  mattersError,
  selectedMatterId,
  setSelectedMatterId,
  previewResult,
  setPreviewResult,
  previewError,
  setPreviewError,
  previewLoading,
  runPreview,
  onClose,
  panelRef,
}) {
  if (!previewTemplate) return null;

  const unresolvedTokens = Array.isArray(previewResult?.unresolvedTokens) ? previewResult.unresolvedTokens : [];

  return (
    <div
      ref={panelRef}
      style={{ marginTop: 20, border: `1px solid ${theme.line}`, borderRadius: 10, background: '#FAFAF9', overflow: 'hidden' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${theme.line}`, background: '#F5F3EF', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: theme.ink, wordBreak: 'break-word' }}>Preview: {previewTemplate.name}</span>
          <span style={{ marginLeft: 10, fontSize: 12, color: theme.muted }}>Read-only — no document will be created</span>
        </div>
        <button type="button" style={{ ...styles.ghostButton, fontSize: 12, padding: '4px 10px' }} onClick={onClose}>
          Close
        </button>
      </div>

      <div style={{ padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <label style={{ ...styles.field, flex: '1 1 220px', minWidth: 0 }}>
            <span style={{ fontSize: 12, color: theme.muted, marginBottom: 4, display: 'block' }}>Select matter to preview against</span>
            <select
              style={{ ...styles.input, width: '100%' }}
              value={selectedMatterId}
              onChange={e => { setSelectedMatterId(e.target.value); setPreviewResult(null); setPreviewError(null); }}
              disabled={mattersLoading || previewLoading}
            >
              <option value="">
                {mattersLoading ? 'Loading matters…' : matters.length === 0 ? 'No matters available' : '— Select a matter —'}
              </option>
              {matters.map(m => (
                <option key={m.id} value={m.id}>
                  {m.title || m.reference || m.caseNumber || `Matter ${m.id}`}
                  {m.reference && m.title ? ` (${m.reference})` : ''}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            style={{ ...styles.primaryButton, fontSize: 13, padding: '8px 18px', flexShrink: 0 }}
            onClick={runPreview}
            disabled={!selectedMatterId || previewLoading || mattersLoading}
          >
            {previewLoading ? 'Loading…' : 'Run Preview'}
          </button>
        </div>

        {mattersError && <Alert tone="danger" style={{ marginBottom: 12 }}>{mattersError}</Alert>}
        {previewError && <Alert tone="danger" style={{ marginBottom: 12 }}>{previewError}</Alert>}

        {previewResult && (
          <div style={{ display: 'grid', gap: 14 }}>
            {unresolvedTokens.length > 0 ? (
              <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderLeft: `3px solid ${theme.amber}`, borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: '#92400E', marginBottom: 6 }}>
                  Unresolved tokens ({unresolvedTokens.length})
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {unresolvedTokens.map((tok, i) => (
                    <span key={i} style={{ background: '#FEF3C7', color: '#92400E', borderRadius: 4, padding: '2px 8px', fontSize: 12, fontFamily: 'monospace' }}>
                      {tok}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', borderLeft: `3px solid ${theme.green}`, borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#047857', fontWeight: 500 }}>
                No unresolved tokens — all fields resolved.
              </div>
            )}

            <div>
              <div style={{ fontSize: 12, color: theme.muted, marginBottom: 6, fontWeight: 500 }}>Merged preview</div>
              <pre style={{
                margin: 0,
                padding: '14px 16px',
                background: '#fff',
                border: `1px solid ${theme.line}`,
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 420,
                overflowY: 'auto',
                color: theme.ink,
                fontFamily: 'inherit',
              }}>
                {previewResult.preview || '(empty preview)'}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
