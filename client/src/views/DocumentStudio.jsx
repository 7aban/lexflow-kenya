import { useEffect, useRef, useState } from 'react';
import { api, listDocumentTemplates, previewDocumentTemplate } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Alert, Badge, Card, Empty, Skeleton } from '../components/ui.jsx';

export default function DocumentStudio({ notify }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [previewTemplate, setPreviewTemplate] = useState(null);
  const [matters, setMatters] = useState([]);
  const [mattersLoading, setMattersLoading] = useState(false);
  const [mattersError, setMattersError] = useState(null);
  const [selectedMatterId, setSelectedMatterId] = useState('');
  const [previewResult, setPreviewResult] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  const panelRef = useRef(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await listDocumentTemplates();
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Could not load document templates.');
      notify?.({ type: 'danger', message: err.message || 'Could not load document templates.' });
    } finally {
      setLoading(false);
    }
  }

  async function loadMatters() {
    setMattersLoading(true);
    setMattersError(null);
    try {
      const data = await api('/matters');
      setMatters(Array.isArray(data) ? data : []);
    } catch (err) {
      setMattersError(err.message || 'Could not load matters.');
    } finally {
      setMattersLoading(false);
    }
  }

  function openPreview(template) {
    setPreviewTemplate(template);
    setPreviewResult(null);
    setPreviewError(null);
    setSelectedMatterId('');
    if (!matters.length) loadMatters();
    setTimeout(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
  }

  function closePreview() {
    setPreviewTemplate(null);
    setPreviewResult(null);
    setPreviewError(null);
    setSelectedMatterId('');
  }

  async function runPreview() {
    if (!previewTemplate || !selectedMatterId || previewLoading) return;
    setPreviewLoading(true);
    setPreviewResult(null);
    setPreviewError(null);
    try {
      const result = await previewDocumentTemplate(selectedMatterId, previewTemplate.id);
      setPreviewResult(result);
    } catch (err) {
      setPreviewError(err.message || 'Preview failed.');
    } finally {
      setPreviewLoading(false);
    }
  }

  if (loading) return <Skeleton />;

  if (error) return <Alert tone="danger">{error}</Alert>;

  const hint = templates.length === 1 ? '1 template configured' : `${templates.length} templates configured`;
  const unresolvedTokens = Array.isArray(previewResult?.unresolvedTokens) ? previewResult.unresolvedTokens : [];

  return (
    <Card title="Active Templates" hint={hint}>
      {templates.length === 0 ? (
        <Empty title="No templates configured" text="Contact your administrator." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, padding: '8px 0' }}>
          {templates.map(t => (
            <div key={t.id} style={{ border: `1px solid ${previewTemplate?.id === t.id ? theme.blue || '#2563EB' : theme.line}`, borderRadius: 10, padding: '16px 18px', background: '#fff', display: 'grid', gap: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: theme.ink, wordBreak: 'break-word' }}>{t.name}</div>
              {t.description && (
                <div style={{ fontSize: 13, color: theme.muted, lineHeight: 1.5 }}>{t.description}</div>
              )}
              {(t.practiceArea || t.category) && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                  {t.practiceArea && <Badge tone="blue">{t.practiceArea}</Badge>}
                  {t.category && <Badge tone="blue">{t.category}</Badge>}
                </div>
              )}
              <div style={{ marginTop: 4 }}>
                <button
                  type="button"
                  style={{ ...styles.ghostButton, fontSize: 12, padding: '5px 12px' }}
                  onClick={() => previewTemplate?.id === t.id ? closePreview() : openPreview(t)}
                >
                  {previewTemplate?.id === t.id ? 'Close Preview' : 'Preview'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {previewTemplate && (
        <div
          ref={panelRef}
          style={{ marginTop: 20, border: `1px solid ${theme.line}`, borderRadius: 10, background: '#FAFAF9', overflow: 'hidden' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${theme.line}`, background: '#F5F3EF' }}>
            <div>
              <span style={{ fontWeight: 600, fontSize: 14, color: theme.ink }}>Preview: {previewTemplate.name}</span>
              <span style={{ marginLeft: 10, fontSize: 12, color: theme.muted }}>Read-only — no document will be created</span>
            </div>
            <button type="button" style={{ ...styles.ghostButton, fontSize: 12, padding: '4px 10px' }} onClick={closePreview}>
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
      )}
    </Card>
  );
}
