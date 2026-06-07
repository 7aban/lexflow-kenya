import { useEffect, useRef, useState } from 'react';
import { API_BASE, api, fileToDataUrl, fetchDocumentArrayBuffer, getMatterDocuments, listDocumentTemplates, mergePdfDocuments, readSession, saveMergedPdf, previewDocumentTemplate, rotatePdfDocument, saveRotatedPdf, extractPdfPages, saveExtractedPdf, splitPdfPages, saveSplitPdf, deletePdfPages, saveDeletedPdf, numberPdfPages, saveNumberedPdf, createCourtBundle, saveCourtBundle, stampPdf, saveStampedPdf, tenthLinePdf, saveTenthLinedPdf } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Alert, Badge, Card, Empty, Skeleton } from '../components/ui.jsx';
import DocumentToolCards from './document-studio/DocumentToolCards.jsx';
import TemplatePreviewPanel from './document-studio/TemplatePreviewPanel.jsx';
import StampPlacementHelper from './document-studio/StampPlacementHelper.jsx';

function matterLabel(matter = {}) {
  const base = matter.title || matter.reference || matter.caseNumber || `Matter ${matter.id}`;
  return matter.reference && matter.title ? `${matter.title} (${matter.reference})` : base;
}

const SIGNATURE_ASSET_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const SIGNATURE_ASSET_MAX_BYTES = 512 * 1024;

function formatAssetSize(size) {
  const bytes = Number(size || 0);
  if (!bytes) return '';
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function SignatureAssetPreview({ asset }) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setUrl('');
    if (!asset?.id) return () => {};
    const session = readSession();
    fetch(`${API_BASE}/signature-assets/${encodeURIComponent(asset.id)}/content`, {
      headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {},
    }).then(response => {
      if (!response.ok) throw new Error('Preview unavailable');
      return response.blob();
    }).then(blob => {
      objectUrl = URL.createObjectURL(blob);
      if (active) setUrl(objectUrl);
    }).catch(() => {
      if (active) setUrl('');
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset?.id]);

  return (
    <div style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#FAFAF9', minHeight: 96, display: 'grid', placeItems: 'center', padding: 12, overflow: 'hidden' }}>
      {url ? <img src={url} alt={`${asset.label || 'Signature asset'} preview`} style={{ maxWidth: '100%', maxHeight: 120, objectFit: 'contain' }} /> : <span style={{ fontSize: 12, color: theme.muted }}>No image selected</span>}
    </div>
  );
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

  const [splitMatterId, setSplitMatterId] = useState('');
  const [splitDocuments, setSplitDocuments] = useState([]);
  const [splitDocsLoading, setSplitDocsLoading] = useState(false);
  const [splitDocsError, setSplitDocsError] = useState(null);
  const [splitDocumentId, setSplitDocumentId] = useState('');
  const [splitOrder, setSplitOrder] = useState('');
  const [splitFilename, setSplitFilename] = useState('reordered-pages.pdf');
  const [splitLoading, setSplitLoading] = useState(false);
  const [splitError, setSplitError] = useState(null);
  const [splitSuccess, setSplitSuccess] = useState('');
  const [splitSaveLoading, setSplitSaveLoading] = useState(false);
  const [splitSaveError, setSplitSaveError] = useState(null);
  const [splitSaveSuccess, setSplitSaveSuccess] = useState('');

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

  const [stampMatterId, setStampMatterId] = useState('');
  const [stampDocuments, setStampDocuments] = useState([]);
  const [stampDocsLoading, setStampDocsLoading] = useState(false);
  const [stampDocsError, setStampDocsError] = useState(null);
  const [stampDocumentId, setStampDocumentId] = useState('');
  const [stampAssetId, setStampAssetId] = useState('');
  const [stampPageNumber, setStampPageNumber] = useState(1);
  const [stampX, setStampX] = useState(0);
  const [stampY, setStampY] = useState(0);
  const [stampWidth, setStampWidth] = useState(200);
  const [stampFilename, setStampFilename] = useState('stamped-document.pdf');
  const [stampLoading, setStampLoading] = useState(false);
  const [stampError, setStampError] = useState(null);
  const [stampSuccess, setStampSuccess] = useState('');
  const [stampSaveLoading, setStampSaveLoading] = useState(false);
  const [stampSaveError, setStampSaveError] = useState(null);
  const [stampSaveSuccess, setStampSaveSuccess] = useState('');

  const [stampSelectedAssetUrl, setStampSelectedAssetUrl] = useState('');
  // PRODUCT-27C: raw bytes of the selected PDF for client-side click-to-place preview.
  const [stampPdfData, setStampPdfData] = useState(null);

  const [tenthMatterId, setTenthMatterId] = useState('');
  const [tenthDocuments, setTenthDocuments] = useState([]);
  const [tenthDocsLoading, setTenthDocsLoading] = useState(false);
  const [tenthDocsError, setTenthDocsError] = useState(null);
  const [tenthDocumentId, setTenthDocumentId] = useState('');
  const [tenthStartNumber, setTenthStartNumber] = useState(10);
  const [tenthFilename, setTenthFilename] = useState('tenth-lined-document.pdf');
  const [tenthLoading, setTenthLoading] = useState(false);
  const [tenthError, setTenthError] = useState(null);
  const [tenthSuccess, setTenthSuccess] = useState('');
  const [tenthSaveLoading, setTenthSaveLoading] = useState(false);
  const [tenthSaveError, setTenthSaveError] = useState(null);
  const [tenthSaveSuccess, setTenthSaveSuccess] = useState('');

  const [toolsOpen, setToolsOpen] = useState(false);
  const [selectedTool, setSelectedTool] = useState(null);
  const [signatureAssets, setSignatureAssets] = useState([]);
  const [signatureAssetsLoading, setSignatureAssetsLoading] = useState(false);
  const [signatureAssetsError, setSignatureAssetsError] = useState(null);
  const [signatureAssetLabels, setSignatureAssetLabels] = useState({});
  const [signatureAssetBusy, setSignatureAssetBusy] = useState('');

  const panelRef = useRef(null);
  const mergePanelRef = useRef(null);
  const rotatePanelRef = useRef(null);
  const extractPanelRef = useRef(null);
  const splitPanelRef = useRef(null);
  const deletePanelRef = useRef(null);
  const paginatePanelRef = useRef(null);
  const bundlePanelRef = useRef(null);
  const stampPanelRef = useRef(null);
  const tenthPanelRef = useRef(null);

  useEffect(() => {
    load();
    loadMatters();
    loadSignatureAssets();
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
    if (splitMatterId) {
      loadSplitDocuments(splitMatterId);
    } else {
      setSplitDocuments([]);
      setSplitDocumentId('');
      setSplitDocsError(null);
      setSplitError(null);
      setSplitSuccess('');
      setSplitSaveError(null);
      setSplitSaveSuccess('');
    }
  }, [splitMatterId]);

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

  useEffect(() => {
    if (stampMatterId) {
      loadStampDocuments(stampMatterId);
    } else {
      setStampDocuments([]);
      setStampDocumentId('');
      setStampDocsError(null);
      setStampError(null);
      setStampSuccess('');
      setStampSaveError(null);
      setStampSaveSuccess('');
    }
  }, [stampMatterId]);

  // PRODUCT-27C: fetch the selected PDF's bytes for the click-to-place preview,
  // re-fetching only when the chosen document changes. Reset the page on change.
  useEffect(() => {
    if (!stampDocumentId) {
      setStampPdfData(null);
      return undefined;
    }
    let active = true;
    setStampPdfData(null);
    setStampPageNumber(1);
    fetchDocumentArrayBuffer(stampDocumentId)
      .then(buffer => { if (active) setStampPdfData(buffer); })
      .catch(() => { if (active) setStampPdfData(null); });
    return () => { active = false; };
  }, [stampDocumentId]);

  useEffect(() => {
    if (tenthMatterId) {
      loadTenthDocuments(tenthMatterId);
    } else {
      setTenthDocuments([]);
      setTenthDocumentId('');
      setTenthDocsError(null);
      setTenthError(null);
      setTenthSuccess('');
      setTenthSaveError(null);
      setTenthSaveSuccess('');
    }
  }, [tenthMatterId]);

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

  async function loadSignatureAssets() {
    setSignatureAssetsLoading(true);
    setSignatureAssetsError(null);
    try {
      const data = await api('/signature-assets');
      const rows = Array.isArray(data) ? data : [];
      setSignatureAssets(rows);
      setSignatureAssetLabels(current => {
        const next = { ...current };
        rows.forEach(asset => { next[asset.id] = next[asset.id] ?? asset.label ?? ''; });
        return next;
      });
    } catch (err) {
      const message = err.message || 'Could not load signature assets.';
      setSignatureAssetsError(message);
    } finally {
      setSignatureAssetsLoading(false);
    }
  }

  async function uploadSignatureAsset(kind, event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!SIGNATURE_ASSET_ALLOWED_MIME.includes(file.type)) {
      notify?.({ type: 'danger', message: 'Only PNG, JPEG, and WebP images are supported.' });
      return;
    }
    if (file.size > SIGNATURE_ASSET_MAX_BYTES) {
      notify?.({ type: 'danger', message: 'Image exceeds 512 KB limit.' });
      return;
    }
    const busyKey = `upload-${kind}`;
    setSignatureAssetBusy(busyKey);
    try {
      await api('/signature-assets', {
        method: 'POST',
        body: {
          ownerType: kind === 'stamp' ? 'firm' : 'user',
          assetType: kind === 'stamp' ? 'stamp' : 'signature',
          label: file.name.replace(/\.[^.]+$/, '').slice(0, 120) || (kind === 'stamp' ? 'Firm stamp image' : 'Visual signature image'),
          mimeType: file.type,
          data: await fileToDataUrl(file),
        },
      });
      notify?.({ type: 'success', message: kind === 'stamp' ? 'Firm stamp image uploaded.' : 'Visual signature image uploaded.' });
      await loadSignatureAssets();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message || 'Could not upload image.' });
    } finally {
      setSignatureAssetBusy('');
    }
  }

  async function renameSignatureAsset(asset) {
    const label = String(signatureAssetLabels[asset.id] ?? asset.label ?? '').trim();
    if (!label) {
      notify?.({ type: 'danger', message: 'Label is required.' });
      return;
    }
    setSignatureAssetBusy(`rename-${asset.id}`);
    try {
      await api(`/signature-assets/${asset.id}`, { method: 'PATCH', body: { label } });
      notify?.({ type: 'success', message: 'Asset renamed.' });
      await loadSignatureAssets();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message || 'Could not rename asset.' });
    } finally {
      setSignatureAssetBusy('');
    }
  }

  async function setDefaultSignatureAsset(asset) {
    setSignatureAssetBusy(`default-${asset.id}`);
    try {
      await api(`/signature-assets/${asset.id}`, { method: 'PATCH', body: { isDefault: true } });
      notify?.({ type: 'success', message: 'Default asset updated.' });
      await loadSignatureAssets();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message || 'Could not set default asset.' });
    } finally {
      setSignatureAssetBusy('');
    }
  }

  async function deleteSignatureAsset(asset) {
    if (!window.confirm(`Delete "${asset.label}"?`)) return;
    setSignatureAssetBusy(`delete-${asset.id}`);
    try {
      await api(`/signature-assets/${asset.id}`, { method: 'PATCH', body: { deleted: true } });
      notify?.({ type: 'success', message: 'Asset deleted.' });
      await loadSignatureAssets();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message || 'Could not delete asset.' });
    } finally {
      setSignatureAssetBusy('');
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

  async function loadSplitDocuments(matterId) {
    setSplitDocsLoading(true);
    setSplitDocsError(null);
    setSplitError(null);
    setSplitSuccess('');
    setSplitSaveError(null);
    setSplitSaveSuccess('');
    setSplitDocumentId('');
    try {
      const docs = await getMatterDocuments(matterId);
      setSplitDocuments((Array.isArray(docs) ? docs : []).filter(doc => doc.mimeType === 'application/pdf'));
    } catch (err) {
      setSplitDocuments([]);
      setSplitDocsError(err.message || 'Could not load matter documents.');
    } finally {
      setSplitDocsLoading(false);
    }
  }

  async function runSplitPdf() {
    setSplitError(null);
    setSplitSuccess('');
    setSplitSaveError(null);
    setSplitSaveSuccess('');
    if (!splitDocumentId) {
      setSplitError('Select a PDF document.');
      return;
    }
    if (!splitOrder.trim()) {
      setSplitError('Enter the new page order such as 3,1,2.');
      return;
    }
    setSplitLoading(true);
    try {
      await splitPdfPages(splitDocumentId, splitOrder.trim(), splitFilename);
      setSplitSuccess('Reordered PDF downloaded.');
      notify?.({ type: 'success', message: 'Reordered PDF downloaded.' });
    } catch (err) {
      const message = err.message || 'Could not reorder pages.';
      setSplitError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setSplitLoading(false);
    }
  }

  async function runSplitSave() {
    setSplitSaveError(null);
    setSplitSaveSuccess('');
    if (!splitDocumentId) {
      setSplitSaveError('Select a PDF document.');
      return;
    }
    if (!splitMatterId) {
      setSplitSaveError('Select a matter first.');
      return;
    }
    if (!splitOrder.trim()) {
      setSplitSaveError('Enter the new page order such as 3,1,2.');
      return;
    }
    setSplitSaveLoading(true);
    try {
      await saveSplitPdf(splitDocumentId, splitOrder.trim(), splitFilename, splitMatterId);
      setSplitSaveSuccess('Saved to matter documents. Open the matter Documents tab to view it.');
      notify?.({ type: 'success', message: 'Saved to matter documents. Open the matter Documents tab to view it.' });
    } catch (err) {
      const message = err.message || 'Could not save reordered PDF.';
      setSplitSaveError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setSplitSaveLoading(false);
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

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setStampSelectedAssetUrl('');
    if (!stampAssetId) return () => {};
    const asset = signatureAssets.find(a => a.id === stampAssetId);
    if (!asset) return () => {};
    const session = readSession();
    fetch(`${API_BASE}/signature-assets/${encodeURIComponent(asset.id)}/content`, {
      headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {},
    }).then(response => {
      if (!response.ok) throw new Error('Preview unavailable');
      return response.blob();
    }).then(blob => {
      objectUrl = URL.createObjectURL(blob);
      if (active) setStampSelectedAssetUrl(objectUrl);
    }).catch(() => {
      if (active) setStampSelectedAssetUrl('');
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [stampAssetId, signatureAssets]);

  async function loadStampDocuments(matterId) {
    setStampDocsLoading(true);
    setStampDocsError(null);
    setStampError(null);
    setStampSuccess('');
    setStampSaveError(null);
    setStampSaveSuccess('');
    setStampDocumentId('');
    try {
      const docs = await getMatterDocuments(matterId);
      setStampDocuments((Array.isArray(docs) ? docs : []).filter(doc => doc.mimeType === 'application/pdf'));
    } catch (err) {
      setStampDocuments([]);
      setStampDocsError(err.message || 'Could not load matter documents.');
    } finally {
      setStampDocsLoading(false);
    }
  }

  async function runStampPdf() {
    setStampError(null);
    setStampSuccess('');
    setStampSaveError(null);
    setStampSaveSuccess('');
    if (!stampDocumentId) {
      setStampError('Select a PDF document.');
      return;
    }
    if (!stampAssetId) {
      setStampError('Select a signature or stamp asset.');
      return;
    }
    setStampLoading(true);
    try {
      await stampPdf(stampDocumentId, stampAssetId, stampPageNumber, stampX, stampY, stampWidth, stampFilename);
      setStampSuccess('Stamped PDF downloaded.');
      notify?.({ type: 'success', message: 'Stamped PDF downloaded.' });
    } catch (err) {
      const message = err.message || 'Could not stamp PDF.';
      setStampError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setStampLoading(false);
    }
  }

  async function runStampSave() {
    setStampSaveError(null);
    setStampSaveSuccess('');
    if (!stampDocumentId) {
      setStampSaveError('Select a PDF document.');
      return;
    }
    if (!stampAssetId) {
      setStampSaveError('Select a signature or stamp asset.');
      return;
    }
    if (!stampMatterId) {
      setStampSaveError('Select a matter first.');
      return;
    }
    setStampSaveLoading(true);
    try {
      await saveStampedPdf(stampMatterId, stampDocumentId, stampAssetId, stampPageNumber, stampX, stampY, stampWidth, stampFilename);
      setStampSaveSuccess('Saved to matter documents. Open the matter Documents tab to view it.');
      notify?.({ type: 'success', message: 'Saved to matter documents. Open the matter Documents tab to view it.' });
    } catch (err) {
      const message = err.message || 'Could not save stamped PDF.';
      setStampSaveError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setStampSaveLoading(false);
    }
  }

  async function loadTenthDocuments(matterId) {
    setTenthDocsLoading(true);
    setTenthDocsError(null);
    setTenthError(null);
    setTenthSuccess('');
    setTenthSaveError(null);
    setTenthSaveSuccess('');
    setTenthDocumentId('');
    try {
      const docs = await getMatterDocuments(matterId);
      setTenthDocuments((Array.isArray(docs) ? docs : []).filter(doc => doc.mimeType === 'application/pdf'));
    } catch (err) {
      setTenthDocuments([]);
      setTenthDocsError(err.message || 'Could not load matter documents.');
    } finally {
      setTenthDocsLoading(false);
    }
  }

  async function runTenthLinePdf() {
    setTenthError(null);
    setTenthSuccess('');
    setTenthSaveError(null);
    setTenthSaveSuccess('');
    if (!tenthDocumentId) {
      setTenthError('Select a PDF document.');
      return;
    }
    setTenthLoading(true);
    try {
      await tenthLinePdf(tenthDocumentId, tenthStartNumber, tenthFilename);
      setTenthSuccess('Tenth-lined PDF downloaded.');
      notify?.({ type: 'success', message: 'Tenth-lined PDF downloaded.' });
    } catch (err) {
      const message = err.message || 'Could not add tenth-line numbering.';
      setTenthError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setTenthLoading(false);
    }
  }

  async function runTenthLineSave() {
    setTenthSaveError(null);
    setTenthSaveSuccess('');
    if (!tenthDocumentId) {
      setTenthSaveError('Select a PDF document.');
      return;
    }
    if (!tenthMatterId) {
      setTenthSaveError('Select a matter first.');
      return;
    }
    setTenthSaveLoading(true);
    try {
      await saveTenthLinedPdf(tenthDocumentId, tenthStartNumber, tenthFilename, tenthMatterId);
      setTenthSaveSuccess('Saved to matter documents. Open the matter Documents tab to view it.');
      notify?.({ type: 'success', message: 'Saved to matter documents. Open the matter Documents tab to view it.' });
    } catch (err) {
      const message = err.message || 'Could not save tenth-lined PDF.';
      setTenthSaveError(message);
      notify?.({ type: 'danger', message });
    } finally {
      setTenthSaveLoading(false);
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
  const canSplit = !!splitDocumentId && !!splitOrder.trim() && !splitLoading && !splitDocsLoading;
  const canSplitSave = !!splitDocumentId && !!splitOrder.trim() && !splitSaveLoading && !splitDocsLoading && !!splitMatterId;
  const canDelete = !!deleteDocumentId && !!deletePages.trim() && !deleteLoading && !deleteDocsLoading;
  const canDeleteSave = !!deleteDocumentId && !!deletePages.trim() && !deleteSaveLoading && !deleteDocsLoading && !!deleteMatterId;
  const canPaginate = !!paginateDocumentId && !paginateLoading && !paginateDocsLoading;
  const canPaginateSave = !!paginateDocumentId && !paginateSaveLoading && !paginateDocsLoading && !!paginateMatterId;
  const canTenth = !!tenthDocumentId && !tenthLoading && !tenthDocsLoading;
  const canTenthSave = !!tenthDocumentId && !tenthSaveLoading && !tenthDocsLoading && !!tenthMatterId;
  const selectedBundleDocuments = selectedBundleDocumentIds
    .map(id => bundleDocuments.find(doc => doc.id === id))
    .filter(Boolean);
  const canBundle = selectedBundleDocumentIds.length >= 2 && selectedBundleDocumentIds.length <= 10 && !bundleLoading && !bundleDocsLoading && !!bundleMatterId;
  const canBundleSave = selectedBundleDocumentIds.length >= 2 && selectedBundleDocumentIds.length <= 10 && !bundleSaveLoading && !bundleDocsLoading && !!bundleMatterId;
  const activeBundleOptionCount = [bundlePaginate, bundleIncludeIndex, bundleIncludeCover, bundleIncludeDividers, bundleIncludeBookmarks, bundleIncludeCertificate].filter(Boolean).length;
  const bundleSectionLabelStyle = { fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.muted };
  const bundleHelperStyle = { border: `1px solid ${theme.line}`, borderRadius: 6, background: '#FAFAF9', padding: '8px 12px', fontSize: 12, color: theme.muted, lineHeight: 1.5 };
  const session = readSession();
  const currentRole = session?.user?.role || '';
  const currentUserId = session?.user?.id || session?.user?.userId || '';
  const isAdmin = currentRole === 'admin';
  const personalSignatureAssets = signatureAssets.filter(asset => asset.ownerType === 'user' && asset.assetType === 'signature' && (!currentUserId || asset.ownerId === currentUserId));
  const firmStampAssets = signatureAssets.filter(asset => asset.ownerType === 'firm' && asset.assetType === 'stamp');
  const signaturePanelStyle = { border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 14, display: 'grid', gap: 12, minWidth: 0 };

  function renderSignatureAssetRows(assets, canManage) {
    if (signatureAssetsLoading) return <Skeleton />;
    if (!assets.length) return <Empty title="No image stored" text="Upload a PNG, JPEG, or WebP image." />;
    return (
      <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
        {assets.map(asset => (
          <div key={asset.id} style={{ border: `1px solid ${theme.line}`, borderRadius: 8, padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 12, alignItems: 'start', minWidth: 0 }}>
            <SignatureAssetPreview asset={asset} />
            <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <strong style={{ fontSize: 13, color: theme.ink, overflowWrap: 'anywhere' }}>{asset.label}</strong>
                {asset.isDefault && <Badge tone="green">Default</Badge>}
                <span style={{ fontSize: 12, color: theme.muted }}>{asset.mimeType}{asset.size ? ` / ${formatAssetSize(asset.size)}` : ''}</span>
              </div>
              {canManage ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    aria-label={`Rename ${asset.label}`}
                    value={signatureAssetLabels[asset.id] ?? asset.label ?? ''}
                    onChange={event => setSignatureAssetLabels(current => ({ ...current, [asset.id]: event.target.value }))}
                    maxLength={120}
                    style={{ ...styles.input, minWidth: 160, flex: '1 1 180px' }}
                    disabled={Boolean(signatureAssetBusy)}
                  />
                  <button type="button" style={styles.ghostButton} onClick={() => renameSignatureAsset(asset)} disabled={Boolean(signatureAssetBusy)}>
                    {signatureAssetBusy === `rename-${asset.id}` ? 'Saving...' : 'Rename'}
                  </button>
                  {!asset.isDefault && (
                    <button type="button" style={styles.tinyButton} onClick={() => setDefaultSignatureAsset(asset)} disabled={Boolean(signatureAssetBusy)}>
                      {signatureAssetBusy === `default-${asset.id}` ? 'Saving...' : 'Set default'}
                    </button>
                  )}
                  <button type="button" style={styles.dangerTinyButton} onClick={() => deleteSignatureAsset(asset)} disabled={Boolean(signatureAssetBusy)}>
                    {signatureAssetBusy === `delete-${asset.id}` ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              ) : (
                <span style={{ fontSize: 12, color: theme.muted }}>Managed by firm administrators.</span>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <Card title="Signatures & stamps" hint="This stores an image for later placement on documents. It is not a certified electronic signature.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 14, minWidth: 0 }}>
          <div style={signaturePanelStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <strong style={{ fontSize: 14, color: theme.ink }}>Visual signature image</strong>
                <span style={{ fontSize: 12, color: theme.muted }}>Personal reusable image asset</span>
              </div>
              <label style={{ ...styles.primaryButton, opacity: signatureAssetBusy === 'upload-signature' ? 0.65 : 1, cursor: signatureAssetBusy === 'upload-signature' ? 'not-allowed' : 'pointer' }}>
                {signatureAssetBusy === 'upload-signature' ? 'Uploading...' : 'Upload signature image'}
                <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} disabled={Boolean(signatureAssetBusy)} onChange={event => uploadSignatureAsset('signature', event)} />
              </label>
            </div>
            {renderSignatureAssetRows(personalSignatureAssets, true)}
          </div>

          <div style={signaturePanelStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <strong style={{ fontSize: 14, color: theme.ink }}>Firm stamp image</strong>
                <span style={{ fontSize: 12, color: theme.muted }}>Firm reusable image asset</span>
              </div>
              {isAdmin && (
                <label style={{ ...styles.primaryButton, opacity: signatureAssetBusy === 'upload-stamp' ? 0.65 : 1, cursor: signatureAssetBusy === 'upload-stamp' ? 'not-allowed' : 'pointer' }}>
                  {signatureAssetBusy === 'upload-stamp' ? 'Uploading...' : 'Upload stamp image'}
                  <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} disabled={Boolean(signatureAssetBusy)} onChange={event => uploadSignatureAsset('stamp', event)} />
                </label>
              )}
            </div>
            {renderSignatureAssetRows(firmStampAssets, isAdmin)}
          </div>
        </div>
        {signatureAssetsError && <Alert tone="danger">{signatureAssetsError}</Alert>}
      </Card>

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
              onOpenSplit={() => handleSelectTool('split')}
              onOpenDelete={() => handleSelectTool('delete')}
              onOpenPaginate={() => handleSelectTool('paginate')}
               onOpenBundle={() => handleSelectTool('bundle')}
               onOpenStamp={() => handleSelectTool('stamp')}
               onOpenTenth={() => handleSelectTool('tenth')}
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

          {selectedTool === 'split' && (
          <div
            ref={splitPanelRef}
            style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 16, display: 'grid', gap: 14, minWidth: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <strong style={{ fontSize: 14, color: theme.ink }}>Split / reorder pages</strong>
                <span style={{ fontSize: 12, color: theme.muted }}>Copy pages into a new order then download or save</span>
              </div>
              <Badge tone="green">Available</Badge>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12, alignItems: 'end', minWidth: 0 }}>
              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Matter</span>
                <select
                  style={styles.input}
                  value={splitMatterId}
                  onChange={event => { setSplitMatterId(event.target.value); setSplitError(null); setSplitSuccess(''); setSplitSaveError(null); setSplitSaveSuccess(''); }}
                  disabled={mattersLoading || splitLoading || splitSaveLoading}
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
                  value={splitDocumentId}
                  onChange={event => { setSplitDocumentId(event.target.value); setSplitError(null); setSplitSuccess(''); setSplitSaveError(null); setSplitSaveSuccess(''); }}
                  disabled={!splitMatterId || splitDocsLoading || splitLoading || splitSaveLoading}
                >
                  <option value="">
                    {!splitMatterId ? 'Select a matter first' : splitDocsLoading ? 'Loading documents...' : splitDocuments.length === 0 ? 'No PDFs found' : '— Select a PDF —'}
                  </option>
                  {splitDocuments.map(doc => (
                    <option key={doc.id} value={doc.id}>
                      {doc.displayName || doc.name || doc.id}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Page order</span>
                <input
                  style={styles.input}
                  value={splitOrder}
                  onChange={event => { setSplitOrder(event.target.value); setSplitError(null); setSplitSuccess(''); setSplitSaveError(null); setSplitSaveSuccess(''); }}
                  placeholder="3,1,2"
                  disabled={splitLoading || splitSaveLoading}
                />
                <span style={{ fontSize: 11, color: theme.muted, marginTop: 4 }}>Enter the new page order, for example 3,1,2 or 1-3,5.</span>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Output filename</span>
                <input
                  style={styles.input}
                  value={splitFilename}
                  onChange={event => setSplitFilename(event.target.value)}
                  placeholder="reordered-pages.pdf"
                  disabled={splitLoading || splitSaveLoading}
                />
              </label>

              <button
                type="button"
                style={{ ...styles.primaryButton, minHeight: 36, opacity: canSplit ? 1 : 0.65, cursor: canSplit ? 'pointer' : 'not-allowed' }}
                onClick={runSplitPdf}
                disabled={!canSplit}
              >
                {splitLoading ? 'Reordering...' : 'Apply and Download'}
              </button>

              {splitMatterId && (
                <button
                  type="button"
                  style={{ ...styles.ghostButton, minHeight: 36, opacity: canSplitSave ? 1 : 0.65, cursor: canSplitSave ? 'pointer' : 'not-allowed' }}
                  onClick={runSplitSave}
                  disabled={!canSplitSave}
                >
                  {splitSaveLoading ? 'Saving...' : 'Save to matter documents'}
                </button>
              )}
            </div>

            {splitDocsError && <Alert tone="danger">{splitDocsError}</Alert>}
            {splitError && <Alert tone="danger">{splitError}</Alert>}
            {splitSuccess && <Alert tone="success">{splitSuccess}</Alert>}
            {splitSaveError && <Alert tone="danger">{splitSaveError}</Alert>}
            {splitSaveSuccess && <Alert tone="success">{splitSaveSuccess}</Alert>}
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

          {selectedTool === 'stamp' && (
          <div
            ref={stampPanelRef}
            style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 16, display: 'grid', gap: 14, minWidth: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <strong style={{ fontSize: 14, color: theme.ink }}>Sign / stamp PDF</strong>
                <span style={{ fontSize: 12, color: theme.muted }}>Place a stored signature or stamp image onto a PDF page</span>
              </div>
              <Badge tone="green">Available</Badge>
            </div>

            <div style={{ border: `1px solid ${theme.line}`, borderRadius: 6, background: '#FAFAF9', padding: '8px 12px', fontSize: 12, color: theme.muted, lineHeight: 1.5 }}>
              This places a stored signature/stamp image onto a PDF. It is not a certified electronic signature.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12, alignItems: 'end', minWidth: 0 }}>
              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Matter</span>
                <select
                  style={styles.input}
                  value={stampMatterId}
                  onChange={event => { setStampMatterId(event.target.value); setStampError(null); setStampSuccess(''); setStampSaveError(null); setStampSaveSuccess(''); }}
                  disabled={mattersLoading || stampLoading || stampSaveLoading}
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
                  value={stampDocumentId}
                  onChange={event => { setStampDocumentId(event.target.value); setStampError(null); setStampSuccess(''); setStampSaveError(null); setStampSaveSuccess(''); }}
                  disabled={!stampMatterId || stampDocsLoading || stampLoading || stampSaveLoading}
                >
                  <option value="">
                    {!stampMatterId ? 'Select a matter first' : stampDocsLoading ? 'Loading documents...' : stampDocuments.length === 0 ? 'No PDFs found' : '— Select a PDF —'}
                  </option>
                  {stampDocuments.map(doc => (
                    <option key={doc.id} value={doc.id}>
                      {doc.displayName || doc.name || doc.id}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Signature / stamp asset</span>
                <select
                  style={styles.input}
                  value={stampAssetId}
                  onChange={event => { setStampAssetId(event.target.value); setStampError(null); setStampSuccess(''); setStampSaveError(null); setStampSaveSuccess(''); }}
                  disabled={stampLoading || stampSaveLoading}
                >
                  <option value="">{signatureAssets.length === 0 ? 'No assets available' : '— Select an asset —'}</option>
                  {signatureAssets.map(asset => (
                    <option key={asset.id} value={asset.id}>
                      {asset.label || asset.id} ({asset.assetType === 'stamp' ? 'stamp' : 'signature'})
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Page number</span>
                <input
                  type="number"
                  min="1"
                  max="99999"
                  style={styles.input}
                  value={stampPageNumber}
                  onChange={event => { setStampPageNumber(Number(event.target.value)); setStampError(null); setStampSuccess(''); setStampSaveError(null); setStampSaveSuccess(''); }}
                  disabled={stampLoading || stampSaveLoading}
                />
              </label>

              <StampPlacementHelper
                stampX={stampX}
                stampY={stampY}
                stampWidth={stampWidth}
                onXChange={event => { setStampX(Number(event.target.value)); setStampError(null); setStampSuccess(''); setStampSaveError(null); setStampSaveSuccess(''); }}
                onYChange={event => { setStampY(Number(event.target.value)); setStampError(null); setStampSuccess(''); setStampSaveError(null); setStampSaveSuccess(''); }}
                onWidthChange={event => { setStampWidth(Number(event.target.value)); setStampError(null); setStampSuccess(''); setStampSaveError(null); setStampSaveSuccess(''); }}
                selectedAssetUrl={stampSelectedAssetUrl}
                disabled={stampLoading || stampSaveLoading}
                pdfData={stampPdfData}
                pageNumber={stampPageNumber}
                onPageChange={page => { setStampPageNumber(page); setStampError(null); setStampSuccess(''); setStampSaveError(null); setStampSaveSuccess(''); }}
              />

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Output filename</span>
                <input
                  style={styles.input}
                  value={stampFilename}
                  onChange={event => setStampFilename(event.target.value)}
                  placeholder="stamped-document.pdf"
                  disabled={stampLoading || stampSaveLoading}
                />
              </label>

              <button
                type="button"
                style={{ ...styles.primaryButton, minHeight: 36, opacity: stampDocumentId && stampAssetId && !stampLoading ? 1 : 0.65, cursor: stampDocumentId && stampAssetId && !stampLoading ? 'pointer' : 'not-allowed' }}
                onClick={runStampPdf}
                disabled={!stampDocumentId || !stampAssetId || stampLoading}
              >
                {stampLoading ? 'Stamping...' : 'Stamp and Download'}
              </button>

              {stampMatterId && (
                <button
                  type="button"
                  style={{ ...styles.ghostButton, minHeight: 36, opacity: stampDocumentId && stampAssetId && !stampSaveLoading && stampMatterId ? 1 : 0.65, cursor: stampDocumentId && stampAssetId && !stampSaveLoading && stampMatterId ? 'pointer' : 'not-allowed' }}
                  onClick={runStampSave}
                  disabled={!stampDocumentId || !stampAssetId || !stampMatterId || stampSaveLoading}
                >
                  {stampSaveLoading ? 'Saving...' : 'Save to matter documents'}
                </button>
              )}
            </div>

            {stampDocsError && <Alert tone="danger">{stampDocsError}</Alert>}
            {stampError && <Alert tone="danger">{stampError}</Alert>}
            {stampSuccess && <Alert tone="success">{stampSuccess}</Alert>}
            {stampSaveError && <Alert tone="danger">{stampSaveError}</Alert>}
            {stampSaveSuccess && <Alert tone="success">{stampSaveSuccess}</Alert>}
          </div>
          )}

          {selectedTool === 'tenth' && (
          <div
            ref={tenthPanelRef}
            style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', padding: 16, display: 'grid', gap: 14, minWidth: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <strong style={{ fontSize: 14, color: theme.ink }}>Tenth-lining / appellate formatting</strong>
                <span style={{ fontSize: 12, color: theme.muted }}>Add right-margin line markers at every tenth line</span>
              </div>
              <Badge tone="green">Available</Badge>
            </div>

            <div style={{ border: `1px solid ${theme.line}`, borderRadius: 6, background: '#FAFAF9', padding: '8px 12px', fontSize: 12, color: theme.muted, lineHeight: 1.5 }}>
              Adds appellate-style right-margin markers at every tenth line. This overlays visual markers on the PDF and does not reflow or alter the original document.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12, alignItems: 'end', minWidth: 0 }}>
              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Matter</span>
                <select
                  style={styles.input}
                  value={tenthMatterId}
                  onChange={event => { setTenthMatterId(event.target.value); setTenthError(null); setTenthSuccess(''); setTenthSaveError(null); setTenthSaveSuccess(''); }}
                  disabled={mattersLoading || tenthLoading || tenthSaveLoading}
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
                  value={tenthDocumentId}
                  onChange={event => { setTenthDocumentId(event.target.value); setTenthError(null); setTenthSuccess(''); setTenthSaveError(null); setTenthSaveSuccess(''); }}
                  disabled={!tenthMatterId || tenthDocsLoading || tenthLoading || tenthSaveLoading}
                >
                  <option value="">
                    {!tenthMatterId ? 'Select a matter first' : tenthDocsLoading ? 'Loading documents...' : tenthDocuments.length === 0 ? 'No PDFs found' : '— Select a PDF —'}
                  </option>
                  {tenthDocuments.map(doc => (
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
                  value={tenthStartNumber}
                  onChange={event => { setTenthStartNumber(Number(event.target.value)); setTenthError(null); setTenthSuccess(''); setTenthSaveError(null); setTenthSaveSuccess(''); }}
                  disabled={tenthLoading || tenthSaveLoading}
                />
              </label>

              <label style={{ ...styles.field, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: theme.muted }}>Output filename</span>
                <input
                  style={styles.input}
                  value={tenthFilename}
                  onChange={event => setTenthFilename(event.target.value)}
                  placeholder="tenth-lined-document.pdf"
                  disabled={tenthLoading || tenthSaveLoading}
                />
              </label>

              <button
                type="button"
                style={{ ...styles.primaryButton, minHeight: 36, opacity: canTenth ? 1 : 0.65, cursor: canTenth ? 'pointer' : 'not-allowed' }}
                onClick={runTenthLinePdf}
                disabled={!canTenth}
              >
                {tenthLoading ? 'Applying markers...' : 'Apply and Download'}
              </button>

              {tenthMatterId && (
                <button
                  type="button"
                  style={{ ...styles.ghostButton, minHeight: 36, opacity: canTenthSave ? 1 : 0.65, cursor: canTenthSave ? 'pointer' : 'not-allowed' }}
                  onClick={runTenthLineSave}
                  disabled={!canTenthSave}
                >
                  {tenthSaveLoading ? 'Saving...' : 'Save to matter documents'}
                </button>
              )}
            </div>

            {tenthDocsError && <Alert tone="danger">{tenthDocsError}</Alert>}
            {tenthError && <Alert tone="danger">{tenthError}</Alert>}
            {tenthSuccess && <Alert tone="success">{tenthSuccess}</Alert>}
            {tenthSaveError && <Alert tone="danger">{tenthSaveError}</Alert>}
            {tenthSaveSuccess && <Alert tone="success">{tenthSaveSuccess}</Alert>}
          </div>
          )}
          </div>
          )}
        </div>
      </Card>
    </div>
  );
}
