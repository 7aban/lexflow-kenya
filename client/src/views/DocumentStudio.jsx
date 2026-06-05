import { useEffect, useRef, useState } from 'react';
import { api, getMatterDocuments, listDocumentTemplates, mergePdfDocuments, saveMergedPdf, previewDocumentTemplate, rotatePdfDocument, saveRotatedPdf, extractPdfPages, saveExtractedPdf, deletePdfPages, saveDeletedPdf, numberPdfPages, saveNumberedPdf, createCourtBundle, saveCourtBundle } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Alert, Badge, Card, Empty, Skeleton } from '../components/ui.jsx';
import DocumentToolCards from './document-studio/DocumentToolCards.jsx';
import TemplatePreviewPanel from './document-studio/TemplatePreviewPanel.jsx';

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

  const [extractMatterId, setExtractMatterId] = useState('');
  const [extractDocuments, setExtractDocuments] = useState([]);
  const [extractDocsLoading, setExtractDocsLoading] = useState(false);
  const [extractDocsError, setExtractDocsError] = useState(null);
  const [extractDocumentId, setExtractDocumentId] = useState('');
  const [extractRanges, setExtractRanges] = useState('');
  const [extractFilename, setExtractFilename] = useState('extracted-pages.pdf');
  const [extractLoading, setExtractLoading] = useState(false);
  const [extractError, setExtractError] = useState(null);
  const [extractSuccess, setExtractSuccess] = useState('');
  const [extractSaveLoading, setExtractSaveLoading] = useState(false);
  const [extractSaveError, setExtractSaveError] = useState(null);
  const [extractSaveSuccess, setExtractSaveSuccess] = useState('');

  const [deleteMatterId, setDeleteMatterId] = useState('');
  const [deleteDocuments, setDeleteDocuments] = useState([]);
  const [deleteDocsLoading, setDeleteDocsLoading] = useState(false);
  const [deleteDocsError, setDeleteDocsError] = useState(null);
  const [deleteDocumentId, setDeleteDocumentId] = useState('');
  const [deletePages, setDeletePages] = useState('');
  const [deleteFilename, setDeleteFilename] = useState('pages-removed.pdf');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [deleteSuccess, setDeleteSuccess] = useState('');
  const [deleteSaveLoading, setDeleteSaveLoading] = useState(false);
  const [deleteSaveError, setDeleteSaveError] = useState(null);
  const [deleteSaveSuccess, setDeleteSaveSuccess] = useState('');

  const [paginateMatterId, setPaginateMatterId] = useState('');
  const [paginateDocuments, setPaginateDocuments] = useState([]);
  const [paginateDocsLoading, setPaginateDocsLoading] = useState(false);
  const [paginateDocsError, setPaginateDocsError] = useState(null);
  const [paginateDocumentId, setPaginateDocumentId] = useState('');
  const [paginateStartNumber, setPaginateStartNumber] = useState(1);
  const [paginatePosition, setPaginatePosition] = useState('bottom-center');
  const [paginateFilename, setPaginateFilename] = useState('paginated-document.pdf');
  const [paginateLoading, setPaginateLoading] = useState(false);
  const [paginateError, setPaginateError] = useState(null);
  const [paginateSuccess, setPaginateSuccess] = useState('');
  const [paginateSaveLoading, setPaginateSaveLoading] = useState(false);
  const [paginateSaveError, setPaginateSaveError] = useState(null);
  const [paginateSaveSuccess, setPaginateSaveSuccess] = useState('');

  const [bundleMatterId, setBundleMatterId] = useState('');
  const [bundleDocuments, setBundleDocuments] = useState([]);
  const [bundleDocsLoading, setBundleDocsLoading] = useState(false);
  const [bundleDocsError, setBundleDocsError] = useState(null);
  const [selectedBundleDocumentIds, setSelectedBundleDocumentIds] = useState([]);
  const [bundleFilename, setBundleFilename] = useState('court-bundle.pdf');
  const [bundlePaginate, setBundlePaginate] = useState(false);
  const [bundleStartNumber, setBundleStartNumber] = useState(1);
  const [bundlePosition, setBundlePosition] = useState('bottom-center');
  const [bundleIncludeIndex, setBundleIncludeIndex] = useState(false);
  const [bundleDocumentLabels, setBundleDocumentLabels] = useState({});
  const [bundleIncludeCover, setBundleIncludeCover] = useState(false);
  const [bundleCover, setBundleCover] = useState({ title: 'COURT BUNDLE', court: '', caseNumber: '', caseTitle: '', bundleTitle: '', preparedBy: '', date: '' });
  const [bundleIncludeDividers, setBundleIncludeDividers] = useState(false);
  const [bundleDividerLabels, setBundleDividerLabels] = useState({});
  const [bundleIncludeBookmarks, setBundleIncludeBookmarks] = useState(false);
  const [bundleIncludeCertificate, setBundleIncludeCertificate] = useState(false);
  const [firmName, setFirmName] = useState('');
  const [bundleLoading, setBundleLoading] = useState(false);
  const [bundleError, setBundleError] = useState(null);
  const [bundleSuccess, setBundleSuccess] = useState('');
  const [bundleSaveLoading, setBundleSaveLoading] = useState(false);
  const [bundleSaveError, setBundleSaveError] = useState(null);
  const [bundleSaveSuccess, setBundleSaveSuccess] = useState('');
  // UI-only: optional Court Bundle features start collapsed (progressive disclosure).
  const [bundleOptionsOpen, setBundleOptionsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [selectedTool, setSelectedTool] = useState(null);

  const panelRef = useRef(null);
  const mergePanelRef = useRef(null);
  const rotatePanelRef = useRef(null);
  const extractPanelRef = useRef(null);
  const deletePanelRef = useRef(null);
  const paginatePanelRef = useRef(null);
  const bundlePanelRef = useRef(null);

  useEffect(() => {
    load();
    loadMatters();
    // Best-effort firm name for prefilling the optional cover "prepared by" field.
    api('/firm-settings').then(settings => {
      if (settings && typeof settings.name === 'string') setFirmName(settings.name);
    }).catch(() => {});
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

  useEffect(() => {
    if (extractMatterId) {
      loadExtractDocuments(extractMatterId);
    } else {
      setExtractDocuments([]);
      setExtractDocumentId('');
      setExtractDocsError(null);
      setExtractError(null);
      setExtractSuccess('');
      setExtractSaveError(null);
      setExtractSaveSuccess('');
    }
  }, [extractMatterId]);

  useEffect(() => {
    if (deleteMatterId) {
      loadDeleteDocuments(deleteMatterId);
    } else {
      setDeleteDocuments([]);
      setDeleteDocumentId('');
      setDeleteDocsError(null);
      setDeleteError(null);
      setDeleteSuccess('');
      setDeleteSaveError(null);
      setDeleteSaveSuccess('');
    }
  }, [deleteMatterId]);

  useEffect(() => {
    if (paginateMatterId) {
      loadPaginateDocuments(paginateMatterId);
    } else {
      setPaginateDocuments([]);
      setPaginateDocumentId('');
      setPaginateDocsError(null);
      setPaginateError(null);
      setPaginateSuccess('');
      setPaginateSaveError(null);
      setPaginateSaveSuccess('');
    }
  }, [paginateMatterId]);

  useEffect(() => {
    if (bundleMatterId) {
      loadBundleDocuments(bundleMatterId);
    } else {
      setBundleDocuments([]);
      setSelectedBundleDocumentIds([]);
      setBundleDocsError(null);
      setBundleError(null);
      setBundleSuccess('');
      setBundleSaveError(null);
      setBundleSaveSuccess('');
    }
  }, [bundleMatterId]);

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

  async function loadExtractDocuments(matterId) {
    setExtractDocsLoading(true);
    setExtractDocsError(null);
    setExtractError(null);
    setExtractSuccess('');
    setExtractSaveError(null);
    setExtractSaveSuccess('');
    setExtractDocumentId('');
    try {
      const docs = await getMatterDocuments(matterId);
      setExtractDocuments((Array.isArray(docs) ? docs : []).filter(doc => doc.mimeType === 'application/pdf'));
    } catch (err) {
      setExtractDocuments([]);
      setExtractDocsError(err.message || 'Could not load matter documents.');
    } finally {
      setExtractDocsLoading(false);
    }
  }

  async function runExtractPdf() {
    setExtractError(null);
    setExtractSuccess('');
    setExtractSaveError(null);
    setExtractSaveSuccess('');
    if (!extractDocumentId) {
      setExtractError('Select a PDF document.');
      return;
    }
    if (!extractRanges.trim()) {
      setExtractError('Enter page ranges such as 1-3,5.');
      return;
    }
    setExtractLoading(true);
    try {
      await extractPdfPages(extractDocumentId, extractRanges.trim(), extractFilename);
      setExtractSuccess('Extracted pages downloaded.');
      notify?.({ type: 'success', message: 'Extracted pages downloaded.' });
    } catch (err) {
      const message = err.message || 'Could not extract pages.';
      setExtractError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setExtractLoading(false);
    }
  }

  async function runExtractSave() {
    setExtractSaveError(null);
    setExtractSaveSuccess('');
    if (!extractDocumentId) {
      setExtractSaveError('Select a PDF document.');
      return;
    }
    if (!extractMatterId) {
      setExtractSaveError('Select a matter first.');
      return;
    }
    if (!extractRanges.trim()) {
      setExtractSaveError('Enter page ranges such as 1-3,5.');
      return;
    }
    setExtractSaveLoading(true);
    try {
      await saveExtractedPdf(extractDocumentId, extractRanges.trim(), extractFilename, extractMatterId);
      setExtractSaveSuccess('Saved to matter documents. Open the matter Documents tab to view it.');
      notify?.({ type: 'success', message: 'Saved to matter documents. Open the matter Documents tab to view it.' });
    } catch (err) {
      const message = err.message || 'Could not save extracted PDF.';
      setExtractSaveError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setExtractSaveLoading(false);
    }
  }

  async function loadDeleteDocuments(matterId) {
    setDeleteDocsLoading(true);
    setDeleteDocsError(null);
    setDeleteError(null);
    setDeleteSuccess('');
    setDeleteSaveError(null);
    setDeleteSaveSuccess('');
    setDeleteDocumentId('');
    try {
      const docs = await getMatterDocuments(matterId);
      setDeleteDocuments((Array.isArray(docs) ? docs : []).filter(doc => doc.mimeType === 'application/pdf'));
    } catch (err) {
      setDeleteDocuments([]);
      setDeleteDocsError(err.message || 'Could not load matter documents.');
    } finally {
      setDeleteDocsLoading(false);
    }
  }

  async function runDeletePdf() {
    setDeleteError(null);
    setDeleteSuccess('');
    setDeleteSaveError(null);
    setDeleteSaveSuccess('');
    if (!deleteDocumentId) {
      setDeleteError('Select a PDF document.');
      return;
    }
    if (!deletePages.trim()) {
      setDeleteError('Enter pages to remove.');
      return;
    }
    setDeleteLoading(true);
    try {
      await deletePdfPages(deleteDocumentId, deletePages.trim(), deleteFilename);
      setDeleteSuccess('Deleted PDF downloaded.');
      notify?.({ type: 'success', message: 'Deleted PDF downloaded.' });
    } catch (err) {
      const message = err.message || 'Could not delete pages.';
      setDeleteError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setDeleteLoading(false);
    }
  }

  async function runDeleteSave() {
    setDeleteSaveError(null);
    setDeleteSaveSuccess('');
    if (!deleteDocumentId) {
      setDeleteSaveError('Select a PDF document.');
      return;
    }
    if (!deleteMatterId) {
      setDeleteSaveError('Select a matter first.');
      return;
    }
    if (!deletePages.trim()) {
      setDeleteSaveError('Enter pages to remove.');
      return;
    }
    setDeleteSaveLoading(true);
    try {
      await saveDeletedPdf(deleteDocumentId, deletePages.trim(), deleteFilename, deleteMatterId);
      setDeleteSaveSuccess('Saved to matter documents. Open the matter Documents tab to view it.');
      notify?.({ type: 'success', message: 'Saved to matter documents. Open the matter Documents tab to view it.' });
    } catch (err) {
      const message = err.message || 'Could not save deleted PDF.';
      setDeleteSaveError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setDeleteSaveLoading(false);
    }
  }

  async function loadPaginateDocuments(matterId) {
    setPaginateDocsLoading(true);
    setPaginateDocsError(null);
    setPaginateError(null);
    setPaginateSuccess('');
    setPaginateSaveError(null);
    setPaginateSaveSuccess('');
    setPaginateDocumentId('');
    try {
      const docs = await getMatterDocuments(matterId);
      setPaginateDocuments((Array.isArray(docs) ? docs : []).filter(doc => doc.mimeType === 'application/pdf'));
    } catch (err) {
      setPaginateDocuments([]);
      setPaginateDocsError(err.message || 'Could not load matter documents.');
    } finally {
      setPaginateDocsLoading(false);
    }
  }

  async function runPaginatePdf() {
    setPaginateError(null);
    setPaginateSuccess('');
    setPaginateSaveError(null);
    setPaginateSaveSuccess('');
    if (!paginateDocumentId) {
      setPaginateError('Select a PDF document.');
      return;
    }
    setPaginateLoading(true);
    try {
      await numberPdfPages(paginateDocumentId, paginateStartNumber, paginatePosition, paginateFilename);
      setPaginateSuccess('Paginated PDF downloaded.');
      notify?.({ type: 'success', message: 'Paginated PDF downloaded.' });
    } catch (err) {
      const message = err.message || 'Could not add page numbers.';
      setPaginateError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setPaginateLoading(false);
    }
  }

  async function runPaginateSave() {
    setPaginateSaveError(null);
    setPaginateSaveSuccess('');
    if (!paginateDocumentId) {
      setPaginateSaveError('Select a PDF document.');
      return;
    }
    if (!paginateMatterId) {
      setPaginateSaveError('Select a matter first.');
      return;
    }
    setPaginateSaveLoading(true);
    try {
      await saveNumberedPdf(paginateDocumentId, paginateStartNumber, paginatePosition, paginateFilename, paginateMatterId);
      setPaginateSaveSuccess('Saved to matter documents. Open the matter Documents tab to view it.');
      notify?.({ type: 'success', message: 'Saved to matter documents. Open the matter Documents tab to view it.' });
    } catch (err) {
      const message = err.message || 'Could not save paginated PDF.';
      setPaginateSaveError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setPaginateSaveLoading(false);
    }
  }

  async function loadBundleDocuments(matterId) {
    setBundleDocsLoading(true);
    setBundleDocsError(null);
    setBundleError(null);
    setBundleSuccess('');
    setBundleSaveError(null);
    setBundleSaveSuccess('');
    setSelectedBundleDocumentIds([]);
    try {
      const docs = await getMatterDocuments(matterId);
      setBundleDocuments((Array.isArray(docs) ? docs : []).filter(doc => doc.mimeType === 'application/pdf'));
    } catch (err) {
      setBundleDocuments([]);
      setBundleDocsError(err.message || 'Could not load matter documents.');
    } finally {
      setBundleDocsLoading(false);
    }
  }

  function toggleBundleDocument(documentId) {
    setBundleError(null);
    setBundleSuccess('');
    setSelectedBundleDocumentIds(current => {
      if (current.includes(documentId)) return current.filter(id => id !== documentId);
      if (current.length >= 10) {
        setBundleError('Select no more than 10 PDF documents.');
        return current;
      }
      return [...current, documentId];
    });
  }

  function moveBundleDocument(index, direction) {
    setSelectedBundleDocumentIds(current => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function setBundleLabel(documentId, value) {
    setBundleDocumentLabels(current => ({ ...current, [documentId]: value }));
  }

  function setBundleCoverField(field, value) {
    setBundleCover(current => ({ ...current, [field]: value }));
  }

  function setBundleDividerLabel(docId, value) {
    setBundleDividerLabels(current => ({ ...current, [docId]: value }));
  }

  function toggleBundleCover(checked) {
    setBundleIncludeCover(checked);
    if (!checked) return;
    // Prefill blank cover fields from the selected matter, firm name and today.
    const matter = matters.find(m => m.id === bundleMatterId);
    const now = new Date();
    const todayLabel = `${now.getDate()} ${now.toLocaleString('en-GB', { month: 'long' })} ${now.getFullYear()}`;
    setBundleCover(current => ({
      title: current.title || 'COURT BUNDLE',
      court: current.court || (matter?.court || ''),
      caseNumber: current.caseNumber || (matter?.caseNo || ''),
      caseTitle: current.caseTitle || (matter?.title || ''),
      bundleTitle: current.bundleTitle || '',
      preparedBy: current.preparedBy || (firmName || ''),
      date: current.date || todayLabel,
    }));
  }

  async function runBundleDownload() {
    setBundleError(null);
    setBundleSuccess('');
    setBundleSaveError(null);
    setBundleSaveSuccess('');
    if (selectedBundleDocumentIds.length < 2) {
      setBundleError('Select at least 2 PDF documents.');
      return;
    }
    if (selectedBundleDocumentIds.length > 10) {
      setBundleError('Select no more than 10 PDF documents.');
      return;
    }
    if (!bundleMatterId) {
      setBundleError('Select a matter first.');
      return;
    }
    setBundleLoading(true);
    try {
      await createCourtBundle(bundleMatterId, selectedBundleDocumentIds, bundleFilename, bundlePaginate, bundleStartNumber, bundlePosition, bundleIncludeIndex, bundleIncludeIndex ? bundleDocumentLabels : undefined, bundleIncludeCover, bundleIncludeCover ? bundleCover : undefined, bundleIncludeDividers, bundleIncludeDividers ? bundleDividerLabels : undefined, bundleIncludeBookmarks, bundleIncludeCertificate);
      setBundleSuccess('Court bundle downloaded.');
      notify?.({ type: 'success', message: 'Court bundle downloaded.' });
    } catch (err) {
      const message = err.message || 'Could not create court bundle.';
      setBundleError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setBundleLoading(false);
    }
  }

  async function runBundleSave() {
    setBundleSaveError(null);
    setBundleSaveSuccess('');
    if (selectedBundleDocumentIds.length < 2) {
      setBundleSaveError('Select at least 2 PDF documents.');
      return;
    }
    if (selectedBundleDocumentIds.length > 10) {
      setBundleSaveError('Select no more than 10 PDF documents.');
      return;
    }
    if (!bundleMatterId) {
      setBundleSaveError('Select a matter first.');
      return;
    }
    setBundleSaveLoading(true);
    try {
      await saveCourtBundle(bundleMatterId, selectedBundleDocumentIds, bundleFilename, bundlePaginate, bundleStartNumber, bundlePosition, bundleIncludeIndex, bundleIncludeIndex ? bundleDocumentLabels : undefined, bundleIncludeCover, bundleIncludeCover ? bundleCover : undefined, bundleIncludeDividers, bundleIncludeDividers ? bundleDividerLabels : undefined, bundleIncludeBookmarks, bundleIncludeCertificate);
      setBundleSaveSuccess('Saved to matter documents. Open the matter Documents tab to view it.');
      notify?.({ type: 'success', message: 'Saved to matter documents. Open the matter Documents tab to view it.' });
    } catch (err) {
      const message = err.message || 'Could not save court bundle.';
      setBundleSaveError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setBundleSaveLoading(false);
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

  function handleSelectTool(tool) {
    setSelectedTool(tool);
    if (!matters.length && !mattersLoading) loadMatters();
  }

  if (loading) return <Skeleton />;

  if (error) return <Alert tone="danger">{error}</Alert>;

  const hint = templates.length === 1 ? '1 template configured' : `${templates.length} templates configured`;
  const selectedMergeDocuments = selectedMergeDocumentIds
    .map(id => mergeDocuments.find(doc => doc.id === id))
    .filter(Boolean);
  const canMerge = selectedMergeDocumentIds.length >= 2 && selectedMergeDocumentIds.length <= 10 && !mergeLoading && !mergeDocsLoading;
  const canSave = selectedMergeDocumentIds.length >= 2 && selectedMergeDocumentIds.length <= 10 && !saveLoading && !mergeDocsLoading && !!mergeMatterId;
  const canRotate = !!rotateDocumentId && !rotateLoading && !rotateDocsLoading;
  const canRotateSave = !!rotateDocumentId && !rotateSaveLoading && !rotateDocsLoading && !!rotateMatterId;
  const canExtract = !!extractDocumentId && !!extractRanges.trim() && !extractLoading && !extractDocsLoading;
  const canExtractSave = !!extractDocumentId && !!extractRanges.trim() && !extractSaveLoading && !extractDocsLoading && !!extractMatterId;
  const canDelete = !!deleteDocumentId && !!deletePages.trim() && !deleteLoading && !deleteDocsLoading;
  const canDeleteSave = !!deleteDocumentId && !!deletePages.trim() && !deleteSaveLoading && !deleteDocsLoading && !!deleteMatterId;
  const canPaginate = !!paginateDocumentId && !paginateLoading && !paginateDocsLoading;
  const canPaginateSave = !!paginateDocumentId && !paginateSaveLoading && !paginateDocsLoading && !!paginateMatterId;
  const selectedBundleDocuments = selectedBundleDocumentIds
    .map(id => bundleDocuments.find(doc => doc.id === id))
    .filter(Boolean);
  const canBundle = selectedBundleDocumentIds.length >= 2 && selectedBundleDocumentIds.length <= 10 && !bundleLoading && !bundleDocsLoading && !!bundleMatterId;
  const canBundleSave = selectedBundleDocumentIds.length >= 2 && selectedBundleDocumentIds.length <= 10 && !bundleSaveLoading && !bundleDocsLoading && !!bundleMatterId;
  const activeBundleOptionCount = [bundlePaginate, bundleIncludeIndex, bundleIncludeCover, bundleIncludeDividers, bundleIncludeBookmarks, bundleIncludeCertificate].filter(Boolean).length;
  const bundleSectionLabelStyle = { fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.muted };
  const bundleHelperStyle = { border: `1px solid ${theme.line}`, borderRadius: 6, background: '#FAFAF9', padding: '8px 12px', fontSize: 12, color: theme.muted, lineHeight: 1.5 };

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

        <TemplatePreviewPanel
          previewTemplate={previewTemplate}
          matters={matters}
          mattersLoading={mattersLoading}
          mattersError={mattersError}
          selectedMatterId={selectedMatterId}
          setSelectedMatterId={setSelectedMatterId}
          previewResult={previewResult}
          setPreviewResult={setPreviewResult}
          previewError={previewError}
          setPreviewError={setPreviewError}
          previewLoading={previewLoading}
          runPreview={runPreview}
          onClose={closePreview}
          panelRef={panelRef}
        />
      </Card>

      <Card title="Document Tools" hint="Prepare, combine, paginate, and format court-ready documents">
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          <button
            type="button"
            onClick={() => setToolsOpen(open => !open)}
            aria-expanded={toolsOpen}
            aria-controls="document-tools-panel"
            style={{ ...styles.ghostButton, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', minHeight: 40 }}
          >
            <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: theme.ink }}>{toolsOpen ? 'Hide document tools ▲' : 'Show document tools ▼'}</span>
              <span style={{ fontSize: 12, color: theme.muted, lineHeight: 1.45 }}>PDF merge, rotate, extract, delete, paginate, and court bundle tools are inside.</span>
            </span>
          </button>

          {toolsOpen && (
          <div id="document-tools-panel" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
            <DocumentToolCards
              onOpenMerge={() => handleSelectTool('merge')}
              onOpenRotate={() => handleSelectTool('rotate')}
              onOpenExtract={() => handleSelectTool('extract')}
              onOpenDelete={() => handleSelectTool('delete')}
              onOpenPaginate={() => handleSelectTool('paginate')}
              onOpenBundle={() => handleSelectTool('bundle')}
              selectedTool={selectedTool}
            />

          {selectedTool === 'merge' && (
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
          )}

          {selectedTool === 'rotate' && (
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
          )}

          {selectedTool === 'extract' && (
          <div
            ref={extractPanelRef}
            style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 16, display: 'grid', gap: 14, minWidth: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <strong style={{ fontSize: 14, color: theme.ink }}>Extract pages</strong>
                <span style={{ fontSize: 12, color: theme.muted }}>Pull selected page ranges then download or save</span>
              </div>
              <Badge tone="green">Available</Badge>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12, alignItems: 'end', minWidth: 0 }}>
              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Matter</span>
                <select
                  style={styles.input}
                  value={extractMatterId}
                  onChange={event => { setExtractMatterId(event.target.value); setExtractError(null); setExtractSuccess(''); setExtractSaveError(null); setExtractSaveSuccess(''); }}
                  disabled={mattersLoading || extractLoading || extractSaveLoading}
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
                  value={extractDocumentId}
                  onChange={event => { setExtractDocumentId(event.target.value); setExtractError(null); setExtractSuccess(''); setExtractSaveError(null); setExtractSaveSuccess(''); }}
                  disabled={!extractMatterId || extractDocsLoading || extractLoading || extractSaveLoading}
                >
                  <option value="">
                    {!extractMatterId ? 'Select a matter first' : extractDocsLoading ? 'Loading documents...' : extractDocuments.length === 0 ? 'No PDFs found' : '— Select a PDF —'}
                  </option>
                  {extractDocuments.map(doc => (
                    <option key={doc.id} value={doc.id}>
                      {doc.displayName || doc.name || doc.id}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Page ranges</span>
                <input
                  style={styles.input}
                  value={extractRanges}
                  onChange={event => { setExtractRanges(event.target.value); setExtractError(null); setExtractSuccess(''); setExtractSaveError(null); setExtractSaveSuccess(''); }}
                  placeholder="1-3,5,7"
                  disabled={extractLoading || extractSaveLoading}
                />
                <span style={{ fontSize: 11, color: theme.muted, marginTop: 4 }}>Use page numbers as shown in the PDF, e.g. 1-3,5.</span>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Output filename</span>
                <input
                  style={styles.input}
                  value={extractFilename}
                  onChange={event => setExtractFilename(event.target.value)}
                  placeholder="extracted-pages.pdf"
                  disabled={extractLoading || extractSaveLoading}
                />
              </label>

              <button
                type="button"
                style={{ ...styles.primaryButton, minHeight: 36, opacity: canExtract ? 1 : 0.65, cursor: canExtract ? 'pointer' : 'not-allowed' }}
                onClick={runExtractPdf}
                disabled={!canExtract}
              >
                {extractLoading ? 'Extracting...' : 'Extract and Download'}
              </button>

              {extractMatterId && (
                <button
                  type="button"
                  style={{ ...styles.ghostButton, minHeight: 36, opacity: canExtractSave ? 1 : 0.65, cursor: canExtractSave ? 'pointer' : 'not-allowed' }}
                  onClick={runExtractSave}
                  disabled={!canExtractSave}
                >
                  {extractSaveLoading ? 'Saving...' : 'Save to matter documents'}
                </button>
              )}
            </div>

            {extractDocsError && <Alert tone="danger">{extractDocsError}</Alert>}
            {extractError && <Alert tone="danger">{extractError}</Alert>}
            {extractSuccess && <Alert tone="success">{extractSuccess}</Alert>}
            {extractSaveError && <Alert tone="danger">{extractSaveError}</Alert>}
            {extractSaveSuccess && <Alert tone="success">{extractSaveSuccess}</Alert>}
          </div>
          )}

          {selectedTool === 'delete' && (
          <div
            ref={deletePanelRef}
            style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 16, display: 'grid', gap: 14, minWidth: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <strong style={{ fontSize: 14, color: theme.ink }}>Delete pages</strong>
                <span style={{ fontSize: 12, color: theme.muted }}>Remove unwanted pages then download or save</span>
              </div>
              <Badge tone="green">Available</Badge>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12, alignItems: 'end', minWidth: 0 }}>
              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Matter</span>
                <select
                  style={styles.input}
                  value={deleteMatterId}
                  onChange={event => { setDeleteMatterId(event.target.value); setDeleteError(null); setDeleteSuccess(''); setDeleteSaveError(null); setDeleteSaveSuccess(''); }}
                  disabled={mattersLoading || deleteLoading || deleteSaveLoading}
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
                  value={deleteDocumentId}
                  onChange={event => { setDeleteDocumentId(event.target.value); setDeleteError(null); setDeleteSuccess(''); setDeleteSaveError(null); setDeleteSaveSuccess(''); }}
                  disabled={!deleteMatterId || deleteDocsLoading || deleteLoading || deleteSaveLoading}
                >
                  <option value="">
                    {!deleteMatterId ? 'Select a matter first' : deleteDocsLoading ? 'Loading documents...' : deleteDocuments.length === 0 ? 'No PDFs found' : '— Select a PDF —'}
                  </option>
                  {deleteDocuments.map(doc => (
                    <option key={doc.id} value={doc.id}>
                      {doc.displayName || doc.name || doc.id}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Pages to remove</span>
                <input
                  style={styles.input}
                  value={deletePages}
                  onChange={event => { setDeletePages(event.target.value); setDeleteError(null); setDeleteSuccess(''); setDeleteSaveError(null); setDeleteSaveSuccess(''); }}
                  placeholder="2,4-5"
                  disabled={deleteLoading || deleteSaveLoading}
                />
                <span style={{ fontSize: 11, color: theme.muted, marginTop: 4 }}>Enter the pages to remove. At least one page must remain.</span>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Output filename</span>
                <input
                  style={styles.input}
                  value={deleteFilename}
                  onChange={event => setDeleteFilename(event.target.value)}
                  placeholder="pages-removed.pdf"
                  disabled={deleteLoading || deleteSaveLoading}
                />
              </label>

              <button
                type="button"
                style={{ ...styles.primaryButton, minHeight: 36, opacity: canDelete ? 1 : 0.65, cursor: canDelete ? 'pointer' : 'not-allowed' }}
                onClick={runDeletePdf}
                disabled={!canDelete}
              >
                {deleteLoading ? 'Deleting...' : 'Delete and Download'}
              </button>

              {deleteMatterId && (
                <button
                  type="button"
                  style={{ ...styles.ghostButton, minHeight: 36, opacity: canDeleteSave ? 1 : 0.65, cursor: canDeleteSave ? 'pointer' : 'not-allowed' }}
                  onClick={runDeleteSave}
                  disabled={!canDeleteSave}
                >
                  {deleteSaveLoading ? 'Saving...' : 'Save to matter documents'}
                </button>
              )}
            </div>

            {deleteDocsError && <Alert tone="danger">{deleteDocsError}</Alert>}
            {deleteError && <Alert tone="danger">{deleteError}</Alert>}
            {deleteSuccess && <Alert tone="success">{deleteSuccess}</Alert>}
            {deleteSaveError && <Alert tone="danger">{deleteSaveError}</Alert>}
            {deleteSaveSuccess && <Alert tone="success">{deleteSaveSuccess}</Alert>}

            <div style={{ border: `1px solid ${theme.amber}`, borderLeft: `3px solid ${theme.amber}`, borderRadius: 6, background: '#FFFBEB', padding: '8px 12px', fontSize: 12, color: '#92400E', lineHeight: 1.5 }}>
              This operation cannot be undone once saved.
            </div>
          </div>
          )}

          {selectedTool === 'paginate' && (
          <div
            ref={paginatePanelRef}
            style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 16, display: 'grid', gap: 14, minWidth: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <strong style={{ fontSize: 14, color: theme.ink }}>Add page numbers / paginate bundle</strong>
                <span style={{ fontSize: 12, color: theme.muted }}>Number every page then download or save</span>
              </div>
              <Badge tone="green">Available</Badge>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12, alignItems: 'end', minWidth: 0 }}>
              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Matter</span>
                <select
                  style={styles.input}
                  value={paginateMatterId}
                  onChange={event => { setPaginateMatterId(event.target.value); setPaginateError(null); setPaginateSuccess(''); setPaginateSaveError(null); setPaginateSaveSuccess(''); }}
                  disabled={mattersLoading || paginateLoading || paginateSaveLoading}
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
                  value={paginateDocumentId}
                  onChange={event => { setPaginateDocumentId(event.target.value); setPaginateError(null); setPaginateSuccess(''); setPaginateSaveError(null); setPaginateSaveSuccess(''); }}
                  disabled={!paginateMatterId || paginateDocsLoading || paginateLoading || paginateSaveLoading}
                >
                  <option value="">
                    {!paginateMatterId ? 'Select a matter first' : paginateDocsLoading ? 'Loading documents...' : paginateDocuments.length === 0 ? 'No PDFs found' : '— Select a PDF —'}
                  </option>
                  {paginateDocuments.map(doc => (
                    <option key={doc.id} value={doc.id}>
                      {doc.displayName || doc.name || doc.id}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Starting number</span>
                <input
                  type="number"
                  min="1"
                  max="99999"
                  style={styles.input}
                  value={paginateStartNumber}
                  onChange={event => { setPaginateStartNumber(Number(event.target.value)); setPaginateError(null); setPaginateSuccess(''); setPaginateSaveError(null); setPaginateSaveSuccess(''); }}
                  disabled={paginateLoading || paginateSaveLoading}
                />
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Position</span>
                <select
                  style={styles.input}
                  value={paginatePosition}
                  onChange={event => { setPaginatePosition(event.target.value); setPaginateError(null); setPaginateSuccess(''); setPaginateSaveError(null); setPaginateSaveSuccess(''); }}
                  disabled={paginateLoading || paginateSaveLoading}
                >
                  <option value="bottom-center">Bottom center</option>
                  <option value="bottom-right">Bottom right</option>
                  <option value="bottom-left">Bottom left</option>
                </select>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Output filename</span>
                <input
                  style={styles.input}
                  value={paginateFilename}
                  onChange={event => setPaginateFilename(event.target.value)}
                  placeholder="paginated-document.pdf"
                  disabled={paginateLoading || paginateSaveLoading}
                />
              </label>

              <button
                type="button"
                style={{ ...styles.primaryButton, minHeight: 36, opacity: canPaginate ? 1 : 0.65, cursor: canPaginate ? 'pointer' : 'not-allowed' }}
                onClick={runPaginatePdf}
                disabled={!canPaginate}
              >
                {paginateLoading ? 'Adding numbers...' : 'Add numbers and Download'}
              </button>

              {paginateMatterId && (
                <button
                  type="button"
                  style={{ ...styles.ghostButton, minHeight: 36, opacity: canPaginateSave ? 1 : 0.65, cursor: canPaginateSave ? 'pointer' : 'not-allowed' }}
                  onClick={runPaginateSave}
                  disabled={!canPaginateSave}
                >
                  {paginateSaveLoading ? 'Saving...' : 'Save to matter documents'}
                </button>
              )}
            </div>

            {paginateDocsError && <Alert tone="danger">{paginateDocsError}</Alert>}
            {paginateError && <Alert tone="danger">{paginateError}</Alert>}
            {paginateSuccess && <Alert tone="success">{paginateSuccess}</Alert>}
            {paginateSaveError && <Alert tone="danger">{paginateSaveError}</Alert>}
            {paginateSaveSuccess && <Alert tone="success">{paginateSaveSuccess}</Alert>}

            <div style={{ border: `1px solid ${theme.line}`, borderRadius: 6, background: '#FAFAF9', padding: '8px 12px', fontSize: 12, color: theme.muted, lineHeight: 1.5 }}>
              Numbers are added to every page in the selected PDF. For formal court bundles, verify pagination before filing.
            </div>
          </div>
          )}

          {selectedTool === 'bundle' && (
          <div
            ref={bundlePanelRef}
            style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 16, display: 'grid', gap: 14, minWidth: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <strong style={{ fontSize: 14, color: theme.ink }}>Court bundle prep</strong>
                <span style={{ fontSize: 12, color: theme.muted }}>Combine selected matter PDFs into a single court-ready bundle</span>
              </div>
              <Badge tone="green">Available</Badge>
            </div>

            <div style={bundleHelperStyle}>
              Combine selected matter PDFs into a single court-ready bundle. Optional cover, index, dividers, page numbers, bookmarks, and a generation certificate are available under Bundle options below.
            </div>

            <label style={{ ...styles.field, minWidth: 0, maxWidth: 420 }}>
              <span style={{ fontSize: 12, color: theme.muted }}>Matter</span>
              <select
                style={styles.input}
                value={bundleMatterId}
                onChange={event => setBundleMatterId(event.target.value)}
                disabled={mattersLoading || bundleLoading || bundleSaveLoading}
              >
                <option value="">{mattersLoading ? 'Loading matters...' : 'Select a matter'}</option>
                {matters.map(m => (
                  <option key={m.id} value={m.id}>{matterLabel(m)}</option>
                ))}
              </select>
            </label>

            {bundleMatterId && (
              <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 12, minWidth: 0 }}>
                  <div style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#FAFAF9', padding: 12, display: 'grid', gap: 10, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13, color: theme.ink }}>Available PDFs</strong>
                      <span style={{ fontSize: 12, color: theme.muted }}>{bundleDocuments.length} PDF{bundleDocuments.length === 1 ? '' : 's'}</span>
                    </div>
                    {bundleDocsLoading ? (
                      <span style={{ fontSize: 13, color: theme.muted }}>Loading documents...</span>
                    ) : bundleDocuments.length === 0 ? (
                      <Empty title="No PDFs found" text="This matter has no existing PDF documents." />
                    ) : (
                      <div style={{ display: 'grid', gap: 8, maxHeight: 320, overflowY: 'auto', minWidth: 0 }}>
                        {bundleDocuments.map(doc => {
                          const selected = selectedBundleDocumentIds.includes(doc.id);
                          const disabled = !selected && selectedBundleDocumentIds.length >= 10;
                          return (
                            <label key={doc.id} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 10, alignItems: 'start', border: `1px solid ${selected ? theme.blue : theme.line}`, borderRadius: 8, background: selected ? theme.blueBg : '#fff', padding: 10, minWidth: 0 }}>
                              <input
                                type="checkbox"
                                checked={selected}
                                disabled={disabled || bundleLoading || bundleSaveLoading}
                                onChange={() => toggleBundleDocument(doc.id)}
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
                      <strong style={{ fontSize: 13, color: theme.ink }}>Bundle Order</strong>
                      <span style={{ fontSize: 12, color: theme.muted }}>{selectedBundleDocuments.length}/10 selected</span>
                    </div>
                    {selectedBundleDocuments.length === 0 ? (
                      <Empty title="No PDFs selected" text="Select PDF documents from this matter." />
                    ) : (
                      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
                        {selectedBundleDocuments.map((doc, index) => (
                          <div key={doc.id} style={{ display: 'grid', gap: 8, border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 10, minWidth: 0 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center', minWidth: 0 }}>
                              <span style={{ fontSize: 13, color: theme.ink, overflowWrap: 'anywhere' }}>{index + 1}. {doc.displayName || doc.name || doc.id}</span>
                              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                <button type="button" style={{ ...styles.tinyButton, opacity: index === 0 ? 0.55 : 1 }} onClick={() => moveBundleDocument(index, -1)} disabled={index === 0 || bundleLoading || bundleSaveLoading}>Up</button>
                                <button type="button" style={{ ...styles.tinyButton, opacity: index === selectedBundleDocuments.length - 1 ? 0.55 : 1 }} onClick={() => moveBundleDocument(index, 1)} disabled={index === selectedBundleDocuments.length - 1 || bundleLoading || bundleSaveLoading}>Down</button>
                                <button type="button" style={styles.dangerTinyButton} onClick={() => toggleBundleDocument(doc.id)} disabled={bundleLoading || bundleSaveLoading}>Remove</button>
                              </span>
                            </div>
                            {(bundleIncludeIndex || (!bundleIncludeIndex && bundleIncludeDividers)) && (
                              <label style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                                <span style={{ fontSize: 11, color: theme.muted }}>{bundleIncludeIndex ? 'Index label' : 'Divider label'} (optional)</span>
                                <input
                                  style={{ ...styles.input, fontSize: 13 }}
                                  value={bundleIncludeIndex ? (bundleDocumentLabels[doc.id] ?? '') : (bundleDividerLabels[doc.id] ?? '')}
                                  onChange={event => bundleIncludeIndex ? setBundleLabel(doc.id, event.target.value) : setBundleDividerLabel(doc.id, event.target.value)}
                                  placeholder={doc.displayName || doc.name || doc.id}
                                  maxLength={80}
                                  disabled={bundleLoading || bundleSaveLoading}
                                />
                              </label>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <label style={{ ...styles.field, minWidth: 0, maxWidth: 420 }}>
              <span style={{ fontSize: 12, color: theme.muted }}>Output filename</span>
              <input
                style={styles.input}
                value={bundleFilename}
                onChange={event => setBundleFilename(event.target.value)}
                placeholder="court-bundle.pdf"
                disabled={bundleLoading || bundleSaveLoading}
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12, minWidth: 0 }}>
              <button
                type="button"
                style={{ ...styles.primaryButton, minHeight: 36, opacity: canBundle ? 1 : 0.65, cursor: canBundle ? 'pointer' : 'not-allowed' }}
                onClick={runBundleDownload}
                disabled={!canBundle}
              >
                {bundleLoading ? 'Creating bundle...' : 'Bundle and Download'}
              </button>
              <button
                type="button"
                style={{ ...styles.ghostButton, minHeight: 36, opacity: canBundleSave ? 1 : 0.65, cursor: canBundleSave ? 'pointer' : 'not-allowed' }}
                onClick={runBundleSave}
                disabled={!canBundleSave}
              >
                {bundleSaveLoading ? 'Saving...' : 'Save to matter documents'}
              </button>
            </div>

            {bundleDocsError && <Alert tone="danger">{bundleDocsError}</Alert>}
            {bundleError && <Alert tone="danger">{bundleError}</Alert>}
            {bundleSuccess && <Alert tone="success">{bundleSuccess}</Alert>}
            {bundleSaveError && <Alert tone="danger">{bundleSaveError}</Alert>}
            {bundleSaveSuccess && <Alert tone="success">{bundleSaveSuccess}</Alert>}

            <div style={{ borderTop: `1px solid ${theme.line}`, paddingTop: 14, display: 'grid', gap: 12, minWidth: 0 }}>
              <button
                type="button"
                onClick={() => setBundleOptionsOpen(open => !open)}
                aria-expanded={bundleOptionsOpen}
                aria-controls="court-bundle-options"
                style={{ ...styles.ghostButton, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', minHeight: 40 }}
              >
                <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: theme.ink }}>Bundle options</span>
                    {activeBundleOptionCount > 0 && <Badge tone="blue">{activeBundleOptionCount} on</Badge>}
                  </span>
                  <span style={{ fontSize: 12, color: theme.muted, lineHeight: 1.45 }}>Configure cover, index, dividers, page numbers, bookmarks, and certificate.</span>
                </span>
                <span aria-hidden="true" style={{ fontSize: 11, color: theme.muted, flexShrink: 0 }}>{bundleOptionsOpen ? 'Hide ▲' : 'Show ▼'}</span>
              </button>

              {bundleOptionsOpen && (
                <div id="court-bundle-options" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
                  <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
                    <strong style={bundleSectionLabelStyle}>Front matter</strong>
                    <label style={{ ...styles.field, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                      <input
                        type="checkbox"
                        checked={bundleIncludeCover}
                        onChange={event => toggleBundleCover(event.target.checked)}
                        disabled={bundleLoading || bundleSaveLoading}
                        style={{ margin: 0 }}
                      />
                      <span style={{ fontSize: 12, color: theme.ink }}>Add cover page</span>
                    </label>
                    {bundleIncludeCover && (
                      <div style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#FAFAF9', padding: 12, display: 'grid', gap: 12, minWidth: 0 }}>
                        <span style={{ fontSize: 12, color: theme.muted, lineHeight: 1.5 }}>
                          A single A4 cover page is added before the {bundleIncludeIndex ? 'index and documents' : 'documents'}. Fields prefill from the matter and firm where available and stay editable — leave a field blank to omit it.
                        </span>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12, minWidth: 0 }}>
                          <label style={{ ...styles.field, minWidth: 0 }}>
                            <span style={{ fontSize: 12, color: theme.muted }}>Title</span>
                            <input style={styles.input} value={bundleCover.title} onChange={event => setBundleCoverField('title', event.target.value)} placeholder="COURT BUNDLE" maxLength={120} disabled={bundleLoading || bundleSaveLoading} />
                          </label>
                          <label style={{ ...styles.field, minWidth: 0 }}>
                            <span style={{ fontSize: 12, color: theme.muted }}>Court</span>
                            <input style={styles.input} value={bundleCover.court} onChange={event => setBundleCoverField('court', event.target.value)} placeholder="HIGH COURT OF KENYA AT NAIROBI" maxLength={120} disabled={bundleLoading || bundleSaveLoading} />
                          </label>
                          <label style={{ ...styles.field, minWidth: 0 }}>
                            <span style={{ fontSize: 12, color: theme.muted }}>Case number</span>
                            <input style={styles.input} value={bundleCover.caseNumber} onChange={event => setBundleCoverField('caseNumber', event.target.value)} placeholder="HCCC E000 OF 2026" maxLength={120} disabled={bundleLoading || bundleSaveLoading} />
                          </label>
                          <label style={{ ...styles.field, minWidth: 0 }}>
                            <span style={{ fontSize: 12, color: theme.muted }}>Parties / case title</span>
                            <input style={styles.input} value={bundleCover.caseTitle} onChange={event => setBundleCoverField('caseTitle', event.target.value)} placeholder="A v B" maxLength={200} disabled={bundleLoading || bundleSaveLoading} />
                          </label>
                          <label style={{ ...styles.field, minWidth: 0 }}>
                            <span style={{ fontSize: 12, color: theme.muted }}>Bundle title</span>
                            <input style={styles.input} value={bundleCover.bundleTitle} onChange={event => setBundleCoverField('bundleTitle', event.target.value)} placeholder="DEFENDANT'S BUNDLE OF DOCUMENTS" maxLength={120} disabled={bundleLoading || bundleSaveLoading} />
                          </label>
                          <label style={{ ...styles.field, minWidth: 0 }}>
                            <span style={{ fontSize: 12, color: theme.muted }}>Prepared by</span>
                            <input style={styles.input} value={bundleCover.preparedBy} onChange={event => setBundleCoverField('preparedBy', event.target.value)} placeholder="T.K. RUTTO & CO. ADVOCATES" maxLength={120} disabled={bundleLoading || bundleSaveLoading} />
                          </label>
                          <label style={{ ...styles.field, minWidth: 0 }}>
                            <span style={{ fontSize: 12, color: theme.muted }}>Date</span>
                            <input style={styles.input} value={bundleCover.date} onChange={event => setBundleCoverField('date', event.target.value)} placeholder="1 June 2026" maxLength={80} disabled={bundleLoading || bundleSaveLoading} />
                          </label>
                        </div>
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
                    <strong style={bundleSectionLabelStyle}>Organization</strong>
                    <label style={{ ...styles.field, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                      <input
                        type="checkbox"
                        checked={bundleIncludeIndex}
                        onChange={event => setBundleIncludeIndex(event.target.checked)}
                        disabled={bundleLoading || bundleSaveLoading}
                        style={{ margin: 0 }}
                      />
                      <span style={{ fontSize: 12, color: theme.ink }}>Add bundle index page</span>
                    </label>
                    {bundleIncludeIndex && (
                      <div style={bundleHelperStyle}>
                        Lists the selected documents and their starting pages on a "BUNDLE INDEX" page, added {bundleIncludeCover ? 'after the cover' : 'as the first page'}. Edit document labels in the Bundle Order list above; blank labels use the document name.
                      </div>
                    )}
                    <label style={{ ...styles.field, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                      <input
                        type="checkbox"
                        checked={bundleIncludeDividers}
                        onChange={event => setBundleIncludeDividers(event.target.checked)}
                        disabled={bundleLoading || bundleSaveLoading}
                        style={{ margin: 0 }}
                      />
                      <span style={{ fontSize: 12, color: theme.ink }}>Add section dividers</span>
                    </label>
                    {bundleIncludeDividers && (
                      <div style={bundleHelperStyle}>
                        A divider page is inserted before each selected PDF. Edit divider labels in the Bundle Order list above.
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
                    <strong style={bundleSectionLabelStyle}>Navigation</strong>
                    <label style={{ ...styles.field, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                      <input
                        type="checkbox"
                        checked={bundleIncludeBookmarks}
                        onChange={event => setBundleIncludeBookmarks(event.target.checked)}
                        disabled={bundleLoading || bundleSaveLoading}
                        style={{ margin: 0 }}
                      />
                      <span style={{ fontSize: 12, color: theme.ink }}>Add PDF bookmarks / outline</span>
                    </label>
                    {bundleIncludeBookmarks && (
                      <div style={bundleHelperStyle}>
                        Adds PDF navigation entries for the cover, index, and each section.
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
                    <strong style={bundleSectionLabelStyle}>Page numbering</strong>
                    <label style={{ ...styles.field, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                      <input
                        type="checkbox"
                        checked={bundlePaginate}
                        onChange={event => setBundlePaginate(event.target.checked)}
                        disabled={bundleLoading || bundleSaveLoading}
                        style={{ margin: 0 }}
                      />
                      <span style={{ fontSize: 12, color: theme.ink }}>Add continuous page numbers</span>
                    </label>
                    {bundlePaginate && (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12, alignItems: 'end', minWidth: 0 }}>
                          <label style={{ ...styles.field, minWidth: 0 }}>
                            <span style={{ fontSize: 12, color: theme.muted }}>Starting number</span>
                            <input
                              type="number"
                              min="1"
                              max="99999"
                              style={styles.input}
                              value={bundleStartNumber}
                              onChange={event => setBundleStartNumber(Number(event.target.value))}
                              disabled={bundleLoading || bundleSaveLoading}
                            />
                          </label>
                          <label style={{ ...styles.field, minWidth: 0 }}>
                            <span style={{ fontSize: 12, color: theme.muted }}>Position</span>
                            <select
                              style={styles.input}
                              value={bundlePosition}
                              onChange={event => setBundlePosition(event.target.value)}
                              disabled={bundleLoading || bundleSaveLoading}
                            >
                              <option value="bottom-center">Bottom center</option>
                              <option value="bottom-right">Bottom right</option>
                              <option value="bottom-left">Bottom left</option>
                            </select>
                          </label>
                        </div>
                        <div style={bundleHelperStyle}>
                          Numbers every page. The cover, index, and dividers are included in the count. Verify pagination before filing.
                        </div>
                      </>
                    )}
                  </div>

                  <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
                    <strong style={bundleSectionLabelStyle}>Filing record</strong>
                    <label style={{ ...styles.field, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                      <input
                        type="checkbox"
                        checked={bundleIncludeCertificate}
                        onChange={event => setBundleIncludeCertificate(event.target.checked)}
                        disabled={bundleLoading || bundleSaveLoading}
                        style={{ margin: 0 }}
                      />
                      <span style={{ fontSize: 12, color: theme.ink }}>Include bundle generation certificate</span>
                    </label>
                    {bundleIncludeCertificate && (
                      <div style={bundleHelperStyle}>
                        Adds a final certificate page recording how this bundle was generated.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          )}
          </div>
          )}
        </div>
      </Card>
    </div>
  );
}
