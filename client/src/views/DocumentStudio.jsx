import { useEffect, useRef, useState } from 'react';
import { api, getMatterDocuments, listDocumentTemplates, mergePdfDocuments, saveMergedPdf, previewDocumentTemplate, rotatePdfDocument, saveRotatedPdf } from '../lib/apiClient.js';
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

function matterLabel(matter = {}) {
  const base = matter.title || matter.reference || matter.caseNumber || `Matter ${matter.id}`;
  return matter.reference && matter.title ? `${matter.title} (${matter.reference})` : base;
}

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

  const [mergeMatterId, setMergeMatterId] = useState('');
  const [mergeDocuments, setMergeDocuments] = useState([]);
  const [mergeDocsLoading, setMergeDocsLoading] = useState(false);
  const [mergeDocsError, setMergeDocsError] = useState(null);
  const [selectedMergeDocumentIds, setSelectedMergeDocumentIds] = useState([]);
  const [mergeFilename, setMergeFilename] = useState('merged-document.pdf');
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeError, setMergeError] = useState(null);
  const [mergeSuccess, setMergeSuccess] = useState('');
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState('');

  const [rotateMatterId, setRotateMatterId] = useState('');
  const [rotateDocuments, setRotateDocuments] = useState([]);
  const [rotateDocsLoading, setRotateDocsLoading] = useState(false);
  const [rotateDocsError, setRotateDocsError] = useState(null);
  const [rotateDocumentId, setRotateDocumentId] = useState('');
  const [rotateDegrees, setRotateDegrees] = useState(90);
  const [rotateFilename, setRotateFilename] = useState('rotated-document.pdf');
  const [rotateLoading, setRotateLoading] = useState(false);
  const [rotateError, setRotateError] = useState(null);
  const [rotateSuccess, setRotateSuccess] = useState('');
  const [rotateSaveLoading, setRotateSaveLoading] = useState(false);
  const [rotateSaveError, setRotateSaveError] = useState(null);
  const [rotateSaveSuccess, setRotateSaveSuccess] = useState('');

  const panelRef = useRef(null);
  const mergePanelRef = useRef(null);
  const rotatePanelRef = useRef(null);

  useEffect(() => {
    load();
    loadMatters();
  }, []);

  useEffect(() => {
    if (mergeMatterId) {
      loadMergeDocuments(mergeMatterId);
    } else {
      setMergeDocuments([]);
      setSelectedMergeDocumentIds([]);
      setMergeDocsError(null);
      setMergeError(null);
      setMergeSuccess('');
      setSaveError(null);
      setSaveSuccess('');
    }
  }, [mergeMatterId]);

  useEffect(() => {
    if (rotateMatterId) {
      loadRotateDocuments(rotateMatterId);
    } else {
      setRotateDocuments([]);
      setRotateDocumentId('');
      setRotateDocsError(null);
      setRotateError(null);
      setRotateSuccess('');
      setRotateSaveError(null);
      setRotateSaveSuccess('');
    }
  }, [rotateMatterId]);

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

  async function loadRotateDocuments(matterId) {
    setRotateDocsLoading(true);
    setRotateDocsError(null);
    setRotateError(null);
    setRotateSuccess('');
    setRotateSaveError(null);
    setRotateSaveSuccess('');
    setRotateDocumentId('');
    try {
      const docs = await getMatterDocuments(matterId);
      setRotateDocuments((Array.isArray(docs) ? docs : []).filter(doc => doc.mimeType === 'application/pdf'));
    } catch (err) {
      setRotateDocuments([]);
      setRotateDocsError(err.message || 'Could not load matter documents.');
    } finally {
      setRotateDocsLoading(false);
    }
  }

  async function runRotatePdf() {
    setRotateError(null);
    setRotateSuccess('');
    setRotateSaveError(null);
    setRotateSaveSuccess('');
    if (!rotateDocumentId) {
      setRotateError('Select a PDF document.');
      return;
    }
    setRotateLoading(true);
    try {
      await rotatePdfDocument(rotateDocumentId, rotateDegrees, rotateFilename);
      setRotateSuccess('Rotated PDF downloaded.');
      notify?.({ type: 'success', message: 'Rotated PDF downloaded.' });
    } catch (err) {
      const message = err.message || 'Could not rotate PDF.';
      setRotateError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setRotateLoading(false);
    }
  }

  async function runRotateSave() {
    setRotateSaveError(null);
    setRotateSaveSuccess('');
    if (!rotateDocumentId) {
      setRotateSaveError('Select a PDF document.');
      return;
    }
    if (!rotateMatterId) {
      setRotateSaveError('Select a matter first.');
      return;
    }
    setRotateSaveLoading(true);
    try {
      await saveRotatedPdf(rotateDocumentId, rotateDegrees, rotateFilename, rotateMatterId);
      setRotateSaveSuccess('Saved to matter documents. Open the matter Documents tab to view it.');
      notify?.({ type: 'success', message: 'Saved to matter documents. Open the matter Documents tab to view it.' });
    } catch (err) {
      const message = err.message || 'Could not save rotated PDF.';
      setRotateSaveError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setRotateSaveLoading(false);
    }
  }

  async function loadMergeDocuments(matterId) {
    setMergeDocsLoading(true);
    setMergeDocsError(null);
    setMergeError(null);
    setMergeSuccess('');
    setSaveError(null);
    setSaveSuccess('');
    setSelectedMergeDocumentIds([]);
    try {
      const docs = await getMatterDocuments(matterId);
      setMergeDocuments((Array.isArray(docs) ? docs : []).filter(doc => doc.mimeType === 'application/pdf'));
    } catch (err) {
      setMergeDocuments([]);
      setMergeDocsError(err.message || 'Could not load matter documents.');
    } finally {
      setMergeDocsLoading(false);
    }
  }

  function toggleMergeDocument(documentId) {
    setMergeError(null);
    setMergeSuccess('');
    setSaveError(null);
    setSaveSuccess('');
    setSelectedMergeDocumentIds(current => {
      if (current.includes(documentId)) return current.filter(id => id !== documentId);
      if (current.length >= 10) {
        setMergeError('Select no more than 10 PDF documents.');
        return current;
      }
      return [...current, documentId];
    });
  }

  function moveMergeDocument(index, direction) {
    setSelectedMergeDocumentIds(current => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function runMergePdfs() {
    setMergeError(null);
    setMergeSuccess('');
    setSaveError(null);
    setSaveSuccess('');
    if (selectedMergeDocumentIds.length < 2) {
      setMergeError('Select at least 2 PDF documents.');
      return;
    }
    if (selectedMergeDocumentIds.length > 10) {
      setMergeError('Select no more than 10 PDF documents.');
      return;
    }
    setMergeLoading(true);
    try {
      await mergePdfDocuments(selectedMergeDocumentIds, mergeFilename);
      setMergeSuccess('Merged PDF downloaded.');
      notify?.({ type: 'success', message: 'Merged PDF downloaded.' });
    } catch (err) {
      const message = err.message || 'Could not merge PDFs.';
      setMergeError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setMergeLoading(false);
    }
  }

  async function runSaveMergedPdf() {
    setSaveError(null);
    setSaveSuccess('');
    if (selectedMergeDocumentIds.length < 2) {
      setSaveError('Select at least 2 PDF documents.');
      return;
    }
    if (selectedMergeDocumentIds.length > 10) {
      setSaveError('Select no more than 10 PDF documents.');
      return;
    }
    if (!mergeMatterId) {
      setSaveError('Select a matter first.');
      return;
    }
    setSaveLoading(true);
    try {
      await saveMergedPdf(selectedMergeDocumentIds, mergeFilename, mergeMatterId);
      setSaveSuccess('Saved to matter documents. Open the matter Documents tab to view it.');
      notify?.({ type: 'success', message: 'Saved to matter documents. Open the matter Documents tab to view it.' });
    } catch (err) {
      const message = err.message || 'Could not save merged PDF.';
      setSaveError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setSaveLoading(false);
    }
  }

  function scrollToMergeTool() {
    if (!matters.length && !mattersLoading) loadMatters();
    setTimeout(() => mergePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 40);
  }

  function scrollToRotateTool() {
    if (!matters.length && !mattersLoading) loadMatters();
    setTimeout(() => rotatePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 40);
  }

  if (loading) return <Skeleton />;

  if (error) return <Alert tone="danger">{error}</Alert>;

  const hint = templates.length === 1 ? '1 template configured' : `${templates.length} templates configured`;
  const unresolvedTokens = Array.isArray(previewResult?.unresolvedTokens) ? previewResult.unresolvedTokens : [];
  const selectedMergeDocuments = selectedMergeDocumentIds
    .map(id => mergeDocuments.find(doc => doc.id === id))
    .filter(Boolean);
  const canMerge = selectedMergeDocumentIds.length >= 2 && selectedMergeDocumentIds.length <= 10 && !mergeLoading && !mergeDocsLoading;
  const canSave = selectedMergeDocumentIds.length >= 2 && selectedMergeDocumentIds.length <= 10 && !saveLoading && !mergeDocsLoading && !!mergeMatterId;
  const rotateToolNames = new Set(['Merge PDFs', 'Rotate pages']);
  const canRotate = !!rotateDocumentId && !rotateLoading && !rotateDocsLoading;
  const canRotateSave = !!rotateDocumentId && !rotateSaveLoading && !rotateDocsLoading && !!rotateMatterId;

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
              Merge existing matter PDFs or rotate a PDF page orientation. Other document tools remain staged.
            </span>
          </div>

          <div
            ref={mergePanelRef}
            style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 16, display: 'grid', gap: 14, minWidth: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <strong style={{ fontSize: 14, color: theme.ink }}>Merge PDFs</strong>
                <span style={{ fontSize: 12, color: theme.muted }}>Temporary download only</span>
              </div>
              <Badge tone="green">Available</Badge>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12, alignItems: 'end', minWidth: 0 }}>
              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Matter</span>
                <select
                  style={styles.input}
                  value={mergeMatterId}
                  onChange={event => setMergeMatterId(event.target.value)}
                  disabled={mattersLoading || mergeLoading}
                >
                  <option value="">{mattersLoading ? 'Loading matters...' : 'Select a matter'}</option>
                  {matters.map(m => (
                    <option key={m.id} value={m.id}>{matterLabel(m)}</option>
                  ))}
                </select>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Output filename</span>
                <input
                  style={styles.input}
                  value={mergeFilename}
                  onChange={event => setMergeFilename(event.target.value)}
                  placeholder="merged-document.pdf"
                  disabled={mergeLoading}
                />
              </label>

              <button
                type="button"
                style={{ ...styles.primaryButton, minHeight: 36, opacity: canMerge ? 1 : 0.65, cursor: canMerge ? 'pointer' : 'not-allowed' }}
                onClick={runMergePdfs}
                disabled={!canMerge}
              >
                {mergeLoading ? 'Merging...' : 'Merge and Download'}
              </button>

              <button
                type="button"
                style={{ ...styles.ghostButton, minHeight: 36, opacity: canSave ? 1 : 0.65, cursor: canSave ? 'pointer' : 'not-allowed' }}
                onClick={runSaveMergedPdf}
                disabled={!canSave}
              >
                {saveLoading ? 'Saving...' : 'Save to matter documents'}
              </button>
            </div>

            {mattersError && <Alert tone="danger">{mattersError}</Alert>}
            {mergeDocsError && <Alert tone="danger">{mergeDocsError}</Alert>}
            {mergeError && <Alert tone="danger">{mergeError}</Alert>}
            {mergeSuccess && <Alert tone="success">{mergeSuccess}</Alert>}
            {saveError && <Alert tone="danger">{saveError}</Alert>}
            {saveSuccess && <Alert tone="success">{saveSuccess}</Alert>}

            {mergeMatterId && (
              <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 12, minWidth: 0 }}>
                  <div style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#FAFAF9', padding: 12, display: 'grid', gap: 10, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13, color: theme.ink }}>Available PDFs</strong>
                      <span style={{ fontSize: 12, color: theme.muted }}>{mergeDocuments.length} PDF{mergeDocuments.length === 1 ? '' : 's'}</span>
                    </div>
                    {mergeDocsLoading ? (
                      <span style={{ fontSize: 13, color: theme.muted }}>Loading documents...</span>
                    ) : mergeDocuments.length === 0 ? (
                      <Empty title="No PDFs found" text="This matter has no existing PDF documents." />
                    ) : (
                      <div style={{ display: 'grid', gap: 8, maxHeight: 320, overflowY: 'auto', minWidth: 0 }}>
                        {mergeDocuments.map(doc => {
                          const selected = selectedMergeDocumentIds.includes(doc.id);
                          const disabled = !selected && selectedMergeDocumentIds.length >= 10;
                          return (
                            <label key={doc.id} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 10, alignItems: 'start', border: `1px solid ${selected ? theme.blue : theme.line}`, borderRadius: 8, background: selected ? theme.blueBg : '#fff', padding: 10, minWidth: 0 }}>
                              <input
                                type="checkbox"
                                checked={selected}
                                disabled={disabled || mergeLoading}
                                onChange={() => toggleMergeDocument(doc.id)}
                                style={{ marginTop: 3 }}
                              />
                              <span style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                                <span style={{ fontSize: 13, fontWeight: 600, color: theme.ink, overflowWrap: 'anywhere' }}>{doc.displayName || doc.name || doc.id}</span>
                                <span style={{ fontSize: 12, color: theme.muted }}>{doc.date || 'No date'} | {doc.size || 'Unknown size'}</span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#FAFAF9', padding: 12, display: 'grid', gap: 10, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13, color: theme.ink }}>Merge Order</strong>
                      <span style={{ fontSize: 12, color: theme.muted }}>{selectedMergeDocuments.length}/10 selected</span>
                    </div>
                    {selectedMergeDocuments.length === 0 ? (
                      <Empty title="No PDFs selected" text="Select PDF documents from this matter." />
                    ) : (
                      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
                        {selectedMergeDocuments.map((doc, index) => (
                          <div key={doc.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center', border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 10, minWidth: 0 }}>
                            <span style={{ fontSize: 13, color: theme.ink, overflowWrap: 'anywhere' }}>{index + 1}. {doc.displayName || doc.name || doc.id}</span>
                            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                              <button type="button" style={{ ...styles.tinyButton, opacity: index === 0 ? 0.55 : 1 }} onClick={() => moveMergeDocument(index, -1)} disabled={index === 0 || mergeLoading}>Up</button>
                              <button type="button" style={{ ...styles.tinyButton, opacity: index === selectedMergeDocuments.length - 1 ? 0.55 : 1 }} onClick={() => moveMergeDocument(index, 1)} disabled={index === selectedMergeDocuments.length - 1 || mergeLoading}>Down</button>
                              <button type="button" style={styles.dangerTinyButton} onClick={() => toggleMergeDocument(doc.id)} disabled={mergeLoading}>Remove</button>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div
            ref={rotatePanelRef}
            style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 16, display: 'grid', gap: 14, minWidth: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <strong style={{ fontSize: 14, color: theme.ink }}>Rotate PDF</strong>
                <span style={{ fontSize: 12, color: theme.muted }}>Rotate all pages then download or save</span>
              </div>
              <Badge tone="green">Available</Badge>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12, alignItems: 'end', minWidth: 0 }}>
              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Matter</span>
                <select
                  style={styles.input}
                  value={rotateMatterId}
                  onChange={event => { setRotateMatterId(event.target.value); setRotateError(null); setRotateSuccess(''); setRotateSaveError(null); setRotateSaveSuccess(''); }}
                  disabled={mattersLoading || rotateLoading || rotateSaveLoading}
                >
                  <option value="">{mattersLoading ? 'Loading matters...' : 'Select a matter'}</option>
                  {matters.map(m => (
                    <option key={m.id} value={m.id}>{matterLabel(m)}</option>
                  ))}
                </select>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>PDF document</span>
                <select
                  style={styles.input}
                  value={rotateDocumentId}
                  onChange={event => { setRotateDocumentId(event.target.value); setRotateError(null); setRotateSuccess(''); setRotateSaveError(null); setRotateSaveSuccess(''); }}
                  disabled={!rotateMatterId || rotateDocsLoading || rotateLoading || rotateSaveLoading}
                >
                  <option value="">
                    {!rotateMatterId ? 'Select a matter first' : rotateDocsLoading ? 'Loading documents...' : rotateDocuments.length === 0 ? 'No PDFs found' : '— Select a PDF —'}
                  </option>
                  {rotateDocuments.map(doc => (
                    <option key={doc.id} value={doc.id}>
                      {doc.displayName || doc.name || doc.id}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Rotation</span>
                <select
                  style={styles.input}
                  value={rotateDegrees}
                  onChange={event => setRotateDegrees(Number(event.target.value))}
                  disabled={rotateLoading || rotateSaveLoading}
                >
                  <option value={90}>90° clockwise</option>
                  <option value={180}>180°</option>
                  <option value={270}>270° clockwise (90° counter-clockwise)</option>
                </select>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Output filename</span>
                <input
                  style={styles.input}
                  value={rotateFilename}
                  onChange={event => setRotateFilename(event.target.value)}
                  placeholder="rotated-document.pdf"
                  disabled={rotateLoading || rotateSaveLoading}
                />
              </label>

              <button
                type="button"
                style={{ ...styles.primaryButton, minHeight: 36, opacity: canRotate ? 1 : 0.65, cursor: canRotate ? 'pointer' : 'not-allowed' }}
                onClick={runRotatePdf}
                disabled={!canRotate}
              >
                {rotateLoading ? 'Rotating...' : 'Rotate and Download'}
              </button>

              {rotateMatterId && (
                <button
                  type="button"
                  style={{ ...styles.ghostButton, minHeight: 36, opacity: canRotateSave ? 1 : 0.65, cursor: canRotateSave ? 'pointer' : 'not-allowed' }}
                  onClick={runRotateSave}
                  disabled={!canRotateSave}
                >
                  {rotateSaveLoading ? 'Saving...' : 'Save to matter documents'}
                </button>
              )}
            </div>

            {rotateDocsError && <Alert tone="danger">{rotateDocsError}</Alert>}
            {rotateError && <Alert tone="danger">{rotateError}</Alert>}
            {rotateSuccess && <Alert tone="success">{rotateSuccess}</Alert>}
            {rotateSaveError && <Alert tone="danger">{rotateSaveError}</Alert>}
            {rotateSaveSuccess && <Alert tone="success">{rotateSaveSuccess}</Alert>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(230px, 100%), 1fr))', gap: 12, minWidth: 0 }}>
            {documentToolCards.map(tool => {
              const active = rotateToolNames.has(tool.title);
              const handler = tool.title === 'Merge PDFs' ? scrollToMergeTool : tool.title === 'Rotate pages' ? scrollToRotateTool : undefined;
              return (
                <div key={tool.title} style={{ border: `1px solid ${active ? theme.blue : theme.line}`, borderRadius: 8, background: '#fff', padding: '14px 16px', display: 'grid', gap: 10, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 14, color: theme.ink, lineHeight: 1.35, wordBreak: 'break-word' }}>{tool.title}</strong>
                    <Badge tone={active ? 'green' : 'amber'}>{active ? 'Available' : 'Coming soon'}</Badge>
                  </div>
                  <span style={{ fontSize: 13, color: theme.muted, lineHeight: 1.5 }}>{tool.description}</span>
                  <button
                    type="button"
                    disabled={!active}
                    onClick={handler}
                    style={{
                      ...styles.ghostButton,
                      justifySelf: 'start',
                      fontSize: 12,
                      padding: '5px 12px',
                      color: active ? 'var(--lf-primary, #1B3A5C)' : theme.muted,
                      borderColor: active ? theme.blue : theme.line,
                      cursor: active ? 'pointer' : 'not-allowed',
                      opacity: active ? 1 : 0.75,
                    }}
                  >
                    {active ? 'Open Tool' : 'Not available yet'}
                  </button>
                </div>
              );
            })}
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
