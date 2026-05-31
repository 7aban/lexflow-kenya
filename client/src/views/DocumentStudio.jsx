import { useEffect, useRef, useState } from 'react';
import { api, listDocumentTemplates, previewDocumentTemplate } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Alert, Badge, Card, Empty, Skeleton } from '../components/ui.jsx';

const documentToolCards = [
  {
    title: 'Merge PDFs',
    description: 'Combine pleadings, exhibits, and annexures into one staged court bundle.',
  },
  {
    title: 'Split / reorder pages',
    description: 'Prepare page ranges and reorder scanned bundles before final export.',
  },
  {
    title: 'Delete pages',
    description: 'Remove duplicate, blank, or incorrectly scanned pages during review.',
  },
  {
    title: 'Rotate pages',
    description: 'Correct sideways pages in affidavits, exhibits, and annexures.',
  },
  {
    title: 'Add page numbers / paginate bundle',
    description: 'Apply court-ready pagination before filing or service.',
  },
  {
    title: 'Court bundle prep',
    description: 'Stage indexes, sections, and ordered bundle outputs for court workflows.',
  },
  {
    title: 'Images to PDF',
    description: 'Convert evidence images and scanned pages into PDF output.',
  },
  {
    title: 'Tenth-lining / appellate formatting',
    description: 'Prepare legal-document formatting helpers for appellate practice.',
  },
];

const workflowPrinciples = [
  'First outputs will use temporary preview/download before any matter record is created.',
  'Saving to matter documents will be an explicit later action with audit history.',
  'Client access will be considered later only where the workflow is appropriate.',
  'Current matter, document, and client visibility controls remain unchanged.',
];

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
    <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <Card title="Active Templates" hint={hint}>
        {templates.length === 0 ? (
          <Empty title="No templates configured" text="Contact your administrator." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: 16, padding: '8px 0', minWidth: 0 }}>
            {templates.map(t => (
              <div key={t.id} style={{ border: `1px solid ${previewTemplate?.id === t.id ? theme.blue : theme.line}`, borderRadius: 10, padding: '16px 18px', background: '#fff', display: 'grid', gap: 8, minWidth: 0 }}>
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${theme.line}`, background: '#F5F3EF', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: theme.ink, wordBreak: 'break-word' }}>Preview: {previewTemplate.name}</span>
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

      <Card title="Document Tools" hint="Prepare, combine, paginate, and format court-ready documents">
        <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
          <div style={{ border: `1px solid ${theme.line}`, borderLeft: `3px solid ${theme.blue}`, borderRadius: 8, background: '#FAFAF9', padding: '12px 14px', display: 'grid', gap: 4 }}>
            <strong style={{ fontSize: 14, color: theme.ink }}>Legal PDF utilities</strong>
            <span style={{ fontSize: 13, color: theme.muted, lineHeight: 1.55 }}>
              Tools are being staged for staff document workflows. This phase is a preview shell only; no files are processed yet.
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(230px, 100%), 1fr))', gap: 12, minWidth: 0 }}>
            {documentToolCards.map(tool => (
              <div key={tool.title} style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: '14px 16px', display: 'grid', gap: 10, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 14, color: theme.ink, lineHeight: 1.35, wordBreak: 'break-word' }}>{tool.title}</strong>
                  <Badge tone="amber">Coming soon</Badge>
                </div>
                <span style={{ fontSize: 13, color: theme.muted, lineHeight: 1.5 }}>{tool.description}</span>
                <button
                  type="button"
                  disabled
                  style={{
                    ...styles.ghostButton,
                    justifySelf: 'start',
                    fontSize: 12,
                    padding: '5px 12px',
                    color: theme.muted,
                    borderColor: theme.line,
                    cursor: 'not-allowed',
                    opacity: 0.75,
                  }}
                >
                  Not available yet
                </button>
              </div>
            ))}
          </div>

          <div style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#F8FAFC', padding: '14px 16px', display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 14, color: theme.ink }}>Planned workflow</strong>
              <Badge tone="blue">Design principle</Badge>
            </div>
            <div style={{ display: 'grid', gap: 7 }}>
              {workflowPrinciples.map(item => (
                <div key={item} style={{ display: 'grid', gridTemplateColumns: '8px minmax(0, 1fr)', gap: 8, alignItems: 'start', fontSize: 13, color: theme.muted, lineHeight: 1.5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: theme.blue, marginTop: 6 }} />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
