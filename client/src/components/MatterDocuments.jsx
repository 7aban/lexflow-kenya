import { useEffect, useMemo, useRef, useState } from 'react';
import { api, archiveFolder, createFolder, deleteFolder, downloadWithAuth, fetchDocumentArrayBuffer, fileToDataUrl, generateDocumentFromTemplate, getArchivedMatterFolders, getMatterDocuments, getMatterFolders, listDocumentTemplates, moveDocument, restoreDocument, restoreFolder, updateDocument, updateFolder } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { ActionGroup, Badge, Card, ConfirmModal, Field, Skeleton, Table } from './ui.jsx';

const DOCUMENT_DRAG_TYPE = 'application/x-lexflow-document-id';
const INTERACTIVE_DRAG_SELECTOR = 'a, button, input, select, textarea, [contenteditable="true"], [role="button"]';

function folderIcon(folder) {
  if (folder.id === 'all') return 'ALL';
  if (folder.id === 'uncategorised') return 'UNC';
  if (folder.id === 'archived') return 'ARC';
  if (isClientUploadsFolder(folder)) return 'UP';
  return 'DIR';
}

function isGeneratedDocument(doc) {
  return doc.source === 'generated';
}

function documentSourceLabel(doc, clientMode) {
  if (isGeneratedDocument(doc)) return clientMode ? 'Firm' : 'Generated Draft';
  if (doc.source === 'client') return clientMode ? 'Shared by you' : 'Client';
  return 'Firm';
}

function sourceBadge(doc, clientMode) {
  const generated = isGeneratedDocument(doc);
  const client = doc.source === 'client';
  let bg, color, label;
  if (generated) {
    bg = '#FFFBEB'; color = '#B45309';
    label = clientMode ? 'Firm' : 'Generated Draft';
  } else if (client) {
    bg = '#FEF8EE'; color = '#8B7A4A';
    label = clientMode ? 'Shared by you' : 'Client';
  } else {
    bg = '#ECFDF5'; color = '#047857';
    label = 'Firm';
  }
  return <span style={{ ...styles.badge, background: bg, color }}>{label}</span>;
}

function documentLabel(doc) {
  return doc.displayName || doc.friendlyName || doc.name || 'Document';
}

function documentExtension(name = '') {
  return String(name).trim().match(/\.([^.\s]+)$/)?.[1]?.toLowerCase() || '';
}

function isClientUploadsFolder(folder) {
  return (folder?.name || '').trim().toLowerCase() === 'client uploads';
}

function normalizeFolderId(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function isFolderRecordActive(folder) {
  const status = String(folder?.status || '').trim().toLowerCase();
  return Boolean(folder)
    && !folder.archivedAt
    && folder.active !== false
    && folder.isActive !== false
    && status !== 'archived'
    && status !== 'inactive';
}

function compareFolders(left, right) {
  if (isClientUploadsFolder(left) !== isClientUploadsFolder(right)) {
    return isClientUploadsFolder(left) ? -1 : 1;
  }
  const byName = String(left?.name || '').localeCompare(String(right?.name || ''), undefined, { sensitivity: 'base' });
  return byName || normalizeFolderId(left?.id).localeCompare(normalizeFolderId(right?.id));
}

function deriveActiveFolderHierarchy(folders) {
  const persistentFolders = (Array.isArray(folders) ? folders : [])
    .filter(folder => folder && !folder.virtual && normalizeFolderId(folder.id));
  const folderById = new Map();
  persistentFolders.forEach(folder => {
    const id = normalizeFolderId(folder.id);
    if (!folderById.has(id)) folderById.set(id, folder);
  });

  const activeMemo = new Map();
  const visiting = new Set();
  function isEffectivelyActive(folderId) {
    const id = normalizeFolderId(folderId);
    if (activeMemo.has(id)) return activeMemo.get(id);
    const folder = folderById.get(id);
    if (!isFolderRecordActive(folder) || visiting.has(id)) {
      activeMemo.set(id, false);
      return false;
    }

    visiting.add(id);
    const parentId = normalizeFolderId(folder.parentId);
    let active = true;
    if (isClientUploadsFolder(folder)) {
      active = !parentId;
    } else if (parentId) {
      const parent = folderById.get(parentId);
      active = Boolean(parent)
        && !isClientUploadsFolder(parent)
        && isEffectivelyActive(parentId);
    }
    visiting.delete(id);
    activeMemo.set(id, active);
    return active;
  }

  const activeFolders = persistentFolders.filter(folder => isEffectivelyActive(folder.id));
  const activeFolderById = new Map(activeFolders.map(folder => [normalizeFolderId(folder.id), folder]));
  const childrenByParentId = new Map([['', []]]);
  activeFolders.forEach(folder => {
    const parentId = normalizeFolderId(folder.parentId);
    if (!childrenByParentId.has(parentId)) childrenByParentId.set(parentId, []);
    childrenByParentId.get(parentId).push(folder);
    if (!childrenByParentId.has(normalizeFolderId(folder.id))) {
      childrenByParentId.set(normalizeFolderId(folder.id), []);
    }
  });
  childrenByParentId.forEach(children => children.sort(compareFolders));

  const orderedFolders = [];
  const pathById = new Map();
  const depthById = new Map();
  function visit(parentId, ancestors) {
    (childrenByParentId.get(parentId) || []).forEach(folder => {
      const id = normalizeFolderId(folder.id);
      const path = [...ancestors, folder];
      orderedFolders.push(folder);
      pathById.set(id, path);
      depthById.set(id, path.length);
      visit(id, path);
    });
  }
  visit('', []);

  return {
    folders: orderedFolders,
    folderById: activeFolderById,
    childrenByParentId,
    pathById,
    depthById,
    inactiveFolderIds: new Set(
      persistentFolders
        .map(folder => normalizeFolderId(folder.id))
        .filter(id => !activeFolderById.has(id)),
    ),
  };
}

function folderPathLabel(hierarchy, folderOrId) {
  const id = normalizeFolderId(typeof folderOrId === 'object' ? folderOrId?.id : folderOrId);
  const path = hierarchy.pathById.get(id);
  return path?.length ? path.map(folder => folder.name).join(' / ') : '';
}

function visibleHierarchyFolders(hierarchy, expandedFolderIds) {
  const visible = [];
  function visit(parentId) {
    (hierarchy.childrenByParentId.get(parentId) || []).forEach(folder => {
      const id = normalizeFolderId(folder.id);
      visible.push(folder);
      if (expandedFolderIds.has(id)) visit(id);
    });
  }
  visit('');
  return visible;
}

function formatArchivedFolderDate(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function documentPreviewKind(doc) {
  const mimeType = String(doc.mimeType || doc.type || '').toLowerCase();
  const name = documentLabel(doc).toLowerCase();
  if (mimeType.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (mimeType.startsWith('image/') || /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(name)) return 'image';
  return '';
}

function documentTypeLabel(doc) {
  const mimeType = String(doc.mimeType || doc.type || '').trim();
  if (mimeType) return mimeType;
  const extension = documentLabel(doc).match(/\.([^.]+)$/)?.[1];
  return extension ? extension.toUpperCase() : 'File type unavailable';
}

function previewMimeType(doc, kind) {
  if (kind === 'pdf') return 'application/pdf';
  const mimeType = String(doc.mimeType || doc.type || '').toLowerCase();
  if (mimeType.startsWith('image/')) return mimeType;
  const extension = documentLabel(doc).match(/\.([^.]+)$/)?.[1]?.toLowerCase();
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

function documentsForView(activeDocuments, archivedDocuments, selectedFolder) {
  if (selectedFolder === 'archived') return archivedDocuments;
  if (selectedFolder === 'all') return activeDocuments;
  return activeDocuments.filter(doc => {
    if (selectedFolder === 'uncategorised') {
      return !doc.folderId || doc.folderId === 'uncategorised';
    }
    return String(doc.folderId || '') === String(selectedFolder);
  });
}

function filterDocumentsBySearch(documents, documentSearch, clientMode) {
  const query = documentSearch.trim().toLowerCase();
  if (!query) return documents;
  return documents.filter(doc => [
    doc.displayName,
    doc.friendlyName,
    doc.name,
    doc.mimeType,
    doc.type,
    documentTypeLabel(doc),
    doc.folderName || 'Uncategorised',
    doc.source,
    documentSourceLabel(doc, clientMode),
    doc.date,
  ].some(value => String(value || '').toLowerCase().includes(query)));
}

export default function MatterDocuments({ matterId, clientMode = false, canManage = false, notify, onChooseAction, onOpenDocumentStudio }) {
  const [folders, setFolders] = useState([]);
  const [archivedFolders, setArchivedFolders] = useState([]);
  const [archivedFoldersOpen, setArchivedFoldersOpen] = useState(false);
  const [archivedFoldersRequested, setArchivedFoldersRequested] = useState(false);
  const [archivedFoldersLoading, setArchivedFoldersLoading] = useState(false);
  const [archivedFoldersError, setArchivedFoldersError] = useState('');
  const [archiveConfirmTarget, setArchiveConfirmTarget] = useState(null);
  const [archiveRequestPending, setArchiveRequestPending] = useState(false);
  const [restoreRequestPendingFolderId, setRestoreRequestPendingFolderId] = useState('');
  const [folderMutationError, setFolderMutationError] = useState(null);
  const [activeDocuments, setActiveDocuments] = useState([]);
  const [archivedDocuments, setArchivedDocuments] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState('all');
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParentId, setNewFolderParentId] = useState('');
  const [expandedFolderIds, setExpandedFolderIds] = useState(() => new Set());
  const [treeFocusId, setTreeFocusId] = useState('');
  const [compactFolderBrowser, setCompactFolderBrowser] = useState(false);
  const [mobileBrowseParentId, setMobileBrowseParentId] = useState('');
  const [renameFolderId, setRenameFolderId] = useState('');
  const [renameFolderName, setRenameFolderName] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameDocument, setRenameDocument] = useState(null);
  const [renameDocumentName, setRenameDocumentName] = useState('');
  const [renameDocumentError, setRenameDocumentError] = useState('');
  const [renameDocumentSaving, setRenameDocumentSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generationMessage, setGenerationMessage] = useState('');
  const [generationWarning, setGenerationWarning] = useState('');
  const [templateSearch, setTemplateSearch] = useState('');
  const [documentSearch, setDocumentSearch] = useState('');
  const [uploadStatus, setUploadStatus] = useState({ fileName: '', state: '' });
  const [preview, setPreview] = useState(null);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState([]);
  const [bulkMoveDestination, setBulkMoveDestination] = useState('uncategorised');
  const [bulkMoving, setBulkMoving] = useState(false);
  const [bulkMoveProgress, setBulkMoveProgress] = useState({ current: 0, total: 0 });
  const [bulkMoveResult, setBulkMoveResult] = useState(null);
  const [nativeDragEnabled, setNativeDragEnabled] = useState(false);
  const [draggedDocumentId, setDraggedDocumentId] = useState('');
  const [dragOverFolderId, setDragOverFolderId] = useState('');
  const previewUrlRef = useRef('');
  const previewRequestRef = useRef(0);
  const archivedFoldersRequestRef = useRef(0);
  const archivedFoldersLoadingRef = useRef(false);
  const archiveFolderRequestRef = useRef(false);
  const restoreFolderRequestRef = useRef('');
  const folderTreeRef = useRef(null);

  const showGenerateControls = canManage === true && clientMode === false && Boolean(matterId);
  const documents = useMemo(
    () => documentsForView(activeDocuments, archivedDocuments, selectedFolder),
    [activeDocuments, archivedDocuments, selectedFolder],
  );

  useEffect(() => {
    if (matterId) load();
  }, [matterId]);

  useEffect(() => {
    archivedFoldersRequestRef.current += 1;
    archivedFoldersLoadingRef.current = false;
    archiveFolderRequestRef.current = false;
    restoreFolderRequestRef.current = '';
    setArchivedFolders([]);
    setArchivedFoldersOpen(false);
    setArchivedFoldersRequested(false);
    setArchivedFoldersLoading(false);
    setArchivedFoldersError('');
    setArchiveConfirmTarget(null);
    setArchiveRequestPending(false);
    setRestoreRequestPendingFolderId('');
    setFolderMutationError(null);
    setNewFolderName('');
    setNewFolderParentId('');
    setExpandedFolderIds(new Set());
    setTreeFocusId('');
    setMobileBrowseParentId('');
  }, [matterId, canManage, clientMode]);

  useEffect(() => {
    setSelectedDocumentIds([]);
    setBulkMoveResult(null);
    clearDocumentDrag();
  }, [matterId, selectedFolder, documentSearch]);

  useEffect(() => {
    setBulkMoveDestination('uncategorised');
  }, [matterId]);

  useEffect(() => {
    if (canManage !== true || clientMode !== false) {
      setSelectedDocumentIds([]);
      setBulkMoveResult(null);
    }
    clearDocumentDrag();
  }, [canManage, clientMode]);

  useEffect(() => {
    const dragMedia = window.matchMedia('(min-width: 641px) and (pointer: fine) and (hover: hover)');
    const updateNativeDragEnabled = () => {
      const touchContext = Number(navigator.maxTouchPoints || 0) > 0;
      setNativeDragEnabled(dragMedia.matches && !touchContext);
      if (!dragMedia.matches || touchContext) clearDocumentDrag();
    };
    updateNativeDragEnabled();
    dragMedia.addEventListener?.('change', updateNativeDragEnabled);
    return () => dragMedia.removeEventListener?.('change', updateNativeDragEnabled);
  }, []);

  useEffect(() => {
    const compactMedia = window.matchMedia('(max-width: 640px)');
    const updateCompactFolderBrowser = () => setCompactFolderBrowser(compactMedia.matches);
    updateCompactFolderBrowser();
    compactMedia.addEventListener?.('change', updateCompactFolderBrowser);
    return () => compactMedia.removeEventListener?.('change', updateCompactFolderBrowser);
  }, []);

  useEffect(() => {
    setRenameFolderId('');
    setRenameFolderName('');
    setRenameError('');
    setRenameSaving(false);
  }, [selectedFolder]);

  useEffect(() => {
    if (!showGenerateControls) {
      setTemplates([]);
      setSelectedTemplateId('');
      setTemplatesLoading(false);
      setTemplateError('');
      setGenerationMessage('');
      setGenerationWarning('');
      setTemplateSearch('');
      return;
    }
    loadTemplates();
  }, [showGenerateControls]);

  useEffect(() => () => {
    previewRequestRef.current += 1;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [nextFolders, activeDocs, archivedDocs] = await Promise.all([
        getMatterFolders(matterId),
        getMatterDocuments(matterId, 'all', 'active'),
        clientMode ? Promise.resolve([]) : getMatterDocuments(matterId, 'all', 'archived'),
      ]);
      setFolders(nextFolders);
      setActiveDocuments(activeDocs);
      setArchivedDocuments(archivedDocs);
      const nextVisibleIds = new Set(
        selectedFolder === 'archived'
          ? []
          : filterDocumentsBySearch(
            documentsForView(activeDocs, [], selectedFolder),
            documentSearch,
            clientMode,
          ).map(doc => String(doc.id)),
      );
      setSelectedDocumentIds(current => current.filter(id => nextVisibleIds.has(String(id))));
      return { folders: nextFolders, activeDocuments: activeDocs, archivedDocuments: archivedDocs };
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
    finally { setLoading(false); }
  }

  async function loadArchivedFolders({ force = false } = {}) {
    if (!matterId || canManage !== true || clientMode !== false) return;
    if (archivedFoldersLoadingRef.current && !force) return;

    const requestId = archivedFoldersRequestRef.current + 1;
    archivedFoldersRequestRef.current = requestId;
    archivedFoldersLoadingRef.current = true;
    setArchivedFoldersRequested(true);
    setArchivedFoldersLoading(true);
    setArchivedFoldersError('');
    try {
      const rows = await getArchivedMatterFolders(matterId);
      if (archivedFoldersRequestRef.current !== requestId) return;
      setArchivedFolders(Array.isArray(rows) ? rows : []);
    } catch (err) {
      if (archivedFoldersRequestRef.current !== requestId) return;
      setArchivedFoldersError(err.message || 'Unable to load archived folders.');
    } finally {
      if (archivedFoldersRequestRef.current === requestId) {
        archivedFoldersLoadingRef.current = false;
        setArchivedFoldersLoading(false);
      }
    }
  }

  function toggleArchivedFolders(event) {
    const open = event.currentTarget.open;
    setArchivedFoldersOpen(open);
    if (open && !archivedFoldersRequested) loadArchivedFolders();
  }

  async function loadTemplates() {
    setTemplatesLoading(true);
    setTemplateError('');
    try {
      const nextTemplates = await listDocumentTemplates();
      const templateList = Array.isArray(nextTemplates) ? nextTemplates : [];
      const activeTemplates = templateList.filter(template => template.active !== false && template.isActive !== false && template.status !== 'inactive');
      setTemplates(activeTemplates);
      setSelectedTemplateId(current => activeTemplates.some(template => String(template.id) === String(current)) ? current : (activeTemplates[0]?.id || ''));
    } catch (err) {
      setTemplateError(err.message);
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setTemplatesLoading(false);
    }
  }

  async function generateDraft(event) {
    event.preventDefault();
    if (!selectedTemplateId || generating) return;
    setGenerating(true);
    setGenerationMessage('');
    setGenerationWarning('');
    try {
      const result = await generateDocumentFromTemplate(matterId, selectedTemplateId);
      const unresolvedTokens = Array.isArray(result?.unresolvedTokens) ? result.unresolvedTokens.map(token => String(token)) : [];
      setGenerationMessage('Draft generated.');
      if (unresolvedTokens.length) {
        setGenerationWarning(`Draft generated with unresolved fields: ${unresolvedTokens.join(', ')}`);
      }
      notify?.({ type: 'success', message: 'Draft generated.' });
      await load();
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
    } finally {
      setGenerating(false);
    }
  }

  async function addFolder(event) {
    event.preventDefault();
    const name = newFolderName.trim();
    const parentId = normalizeFolderId(newFolderParentId);
    if (!name || canManage !== true || clientMode !== false) return;
    const parent = parentId ? folderHierarchy.folderById.get(parentId) : null;
    if (parentId && (!parent || isClientUploadsFolder(parent))) {
      notify?.({ type: 'danger', message: 'Choose an active custom parent folder.' });
      return;
    }
    try {
      const folder = await createFolder(matterId, { name, parentId: parentId || null });
      setNewFolderName('');
      notify?.({ type: 'success', message: 'Folder created.' });
      await load();
      setSelectedFolder(folder.id);
      if (parentId) {
        setExpandedFolderIds(current => new Set([...current, parentId]));
      }
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
  }

  function beginRenameFolder(folder) {
    if (!folder?.id) return;
    setRenameFolderId(folder.id);
    setRenameFolderName(folder.name || '');
    setRenameError('');
  }

  function cancelRenameFolder() {
    setRenameFolderId('');
    setRenameFolderName('');
    setRenameError('');
    setRenameSaving(false);
  }

  async function saveRenamedFolder(event) {
    event.preventDefault();
    const folder = realFolders.find(item => item.id === renameFolderId);
    const name = renameFolderName.trim();
    if (!folder) {
      setRenameError('Select a custom folder to rename.');
      return;
    }
    if (!name) {
      setRenameError('Folder name is required.');
      return;
    }
    if (name === folder.name) {
      cancelRenameFolder();
      return;
    }
    setRenameSaving(true);
    setRenameError('');
    try {
      await updateFolder(folder.id, { name });
      notify?.({ type: 'success', message: 'Folder renamed.' });
      await load();
      cancelRenameFolder();
    } catch (err) {
      setRenameError(err.message || 'Unable to rename this folder.');
      setRenameSaving(false);
    }
  }

  async function removeFolder(folder) {
    if ((folderHierarchy.childrenByParentId.get(normalizeFolderId(folder?.id)) || []).length) {
      notify?.({ type: 'danger', message: 'Remove child folders before deleting this folder.' });
      return;
    }
    try {
      await deleteFolder(folder.id);
      setSelectedFolder('all');
      notify?.({ type: 'success', message: 'Folder deleted.' });
      await load();
    } catch (err) {
      const message = /not empty|contains documents|documents in this folder/i.test(String(err.message || ''))
        ? 'Move or archive documents in this folder before deleting it.'
        : err.message;
      notify?.({ type: 'danger', message });
    }
  }

  function beginArchiveFolder(folder) {
    const activeFolder = realFolders.find(item => String(item.id) === String(folder?.id || ''));
    if (
      canManage !== true
      || clientMode !== false
      || selectedFolder === 'archived'
      || !activeFolder
      || activeFolder.virtual
      || isClientUploadsFolder(activeFolder)
      || (folderHierarchy.childrenByParentId.get(normalizeFolderId(activeFolder.id)) || []).length > 0
      || archiveFolderRequestRef.current
      || restoreFolderRequestRef.current
      || renameSaving
    ) return;
    setFolderMutationError(null);
    setArchiveConfirmTarget(activeFolder);
  }

  async function submitArchiveFolder() {
    const folder = archiveConfirmTarget;
    const activeFolder = realFolders.find(item => String(item.id) === String(folder?.id || ''));
    if (
      archiveFolderRequestRef.current
      || canManage !== true
      || clientMode !== false
      || selectedFolder === 'archived'
      || !activeFolder
      || activeFolder.virtual
      || isClientUploadsFolder(activeFolder)
      || (folderHierarchy.childrenByParentId.get(normalizeFolderId(activeFolder.id)) || []).length > 0
    ) return;

    archiveFolderRequestRef.current = true;
    setArchiveRequestPending(true);
    setFolderMutationError(null);
    try {
      await archiveFolder(activeFolder.id);
      setFolders(current => current.filter(item => String(item.id) !== String(activeFolder.id)));
      setSelectedFolder(current => String(current) === String(activeFolder.id) ? 'all' : current);
      setSelectedDocumentIds([]);
      setBulkMoveProgress({ current: 0, total: 0 });
      setBulkMoveResult(null);
      if (String(renameFolderId) === String(activeFolder.id)) cancelRenameFolder();
      if (String(renameDocument?.folderId || '') === String(activeFolder.id)) cancelRenameDocument();
      clearDocumentDrag();
      setArchiveConfirmTarget(null);
      notify?.({ type: 'success', message: 'Folder archived. Its documents remain active in All Documents.' });
      await load();
      if (archivedFoldersRequested || archivedFoldersOpen) await loadArchivedFolders({ force: true });
    } catch (err) {
      const message = err.message || 'Unable to archive this folder.';
      setFolderMutationError({ action: 'archive', folderId: String(activeFolder.id), message });
      notify?.({ type: 'danger', message });
    } finally {
      archiveFolderRequestRef.current = false;
      setArchiveRequestPending(false);
    }
  }

  async function submitRestoreFolder(folder) {
    const folderId = String(folder?.id || '');
    if (
      !folderId
      || restoreFolderRequestRef.current
      || archiveFolderRequestRef.current
      || canManage !== true
      || clientMode !== false
      || !archivedFolders.some(item => String(item.id) === folderId)
    ) return;

    restoreFolderRequestRef.current = folderId;
    setRestoreRequestPendingFolderId(folderId);
    setFolderMutationError(null);
    try {
      await restoreFolder(folder.id);
      setArchivedFolders(current => current.filter(item => String(item.id) !== folderId));
      notify?.({ type: 'success', message: 'Folder restored to active folders.' });
      await load();
      await loadArchivedFolders({ force: true });
    } catch (err) {
      const message = err.message || 'Unable to restore this folder.';
      setFolderMutationError({ action: 'restore', folderId, message });
      notify?.({ type: 'danger', message });
    } finally {
      restoreFolderRequestRef.current = '';
      setRestoreRequestPendingFolderId('');
    }
  }

  function closeConfirm() {
    if (archiveConfirmTarget) {
      if (archiveFolderRequestRef.current) return;
      setArchiveConfirmTarget(null);
      return;
    }
    setConfirm(null);
  }

  async function uploadDoc(event) {
    const file = event.target.files?.[0];
    if (!file) {
      setUploadStatus({ fileName: '', state: '' });
      return;
    }
    setUploadStatus({ fileName: file.name, state: 'Uploading' });
    try {
      const targetFolderId = folderHierarchy.folderById.has(normalizeFolderId(selectedFolder))
        ? normalizeFolderId(selectedFolder)
        : 'uncategorised';
      await api(`/matters/${matterId}/documents`, {
        method: 'POST',
        body: {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          data: await fileToDataUrl(file),
          folderId: clientMode ? undefined : targetFolderId,
        },
      });
      event.target.value = '';
      setUploadStatus({ fileName: file.name, state: 'Uploaded' });
      notify?.({ type: 'success', message: clientMode ? 'Document shared with the firm.' : 'Document uploaded.' });
      await load();
    } catch (err) {
      setUploadStatus({ fileName: file.name, state: 'Upload failed' });
      notify?.({ type: 'danger', message: err.message });
    }
  }

  async function moveDoc(doc, folderId) {
    try {
      await moveDocument(doc.id, folderId);
      notify?.({ type: 'success', message: 'Document moved.' });
      await load();
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
  }

  async function updateClientVisible(doc, clientVisible) {
    try {
      await updateDocument(doc.id, { clientVisible });
      notify?.({ type: 'success', message: doc.clientVisible ? 'Document hidden from client.' : 'Document shared with client.' });
      await load();
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
  }

  async function toggleClientVisible(doc) {
    const nextVisible = !doc.clientVisible;
    if (isGeneratedDocument(doc) && nextVisible) {
      setConfirm({
        title: 'Share generated draft with client?',
        message: (
          <div style={{ background: '#FFFBEB', borderLeft: '3px solid #D4A34A', borderRadius: 6, padding: '10px 12px', margin: '4px 0', display: 'grid', gap: 4 }}>
            <strong style={{ color: '#92400E', fontSize: 13 }}>Draft not yet reviewed</strong>
            <span style={{ color: '#92400E', fontSize: 12, lineHeight: 1.5 }}>
              This document was generated as a draft. Confirm it has been thoroughly reviewed before making it visible to the client.
            </span>
          </div>
        ),
        onConfirm: () => updateClientVisible(doc, nextVisible),
      });
      return;
    }
    await updateClientVisible(doc, nextVisible);
  }

  async function archiveDoc(doc) {
    try {
      await api(`/documents/${doc.id}`, { method: 'DELETE' });
      notify?.({ type: 'success', message: 'Document archived.' });
      await load();
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
  }

  function beginRenameDocument(doc) {
    if (!doc?.id || !canManage || clientMode) return;
    setRenameDocument(doc);
    setRenameDocumentName(documentLabel(doc));
    setRenameDocumentError('');
    setRenameDocumentSaving(false);
  }

  function cancelRenameDocument() {
    setRenameDocument(null);
    setRenameDocumentName('');
    setRenameDocumentError('');
    setRenameDocumentSaving(false);
  }

  async function saveRenamedDocument(event) {
    event.preventDefault();
    if (!renameDocument || renameDocumentSaving) return;
    const displayName = renameDocumentName.trim();
    if (!displayName) {
      setRenameDocumentError('Document name is required.');
      return;
    }
    if (displayName.length > 180) {
      setRenameDocumentError('Document name must be 180 characters or fewer.');
      return;
    }
    if (displayName === documentLabel(renameDocument).trim()) {
      cancelRenameDocument();
      return;
    }
    setRenameDocumentSaving(true);
    setRenameDocumentError('');
    try {
      await updateDocument(renameDocument.id, { displayName });
      await load();
      notify?.({ type: 'success', message: 'Document renamed.' });
      cancelRenameDocument();
    } catch (err) {
      setRenameDocumentError(err.message || 'Unable to rename this document.');
      setRenameDocumentSaving(false);
    }
  }

  function toggleDocumentSelection(documentId) {
    if (bulkMoving) return;
    const id = String(documentId);
    setSelectedDocumentIds(current => current.includes(id)
      ? current.filter(item => item !== id)
      : [...current, id]);
    setBulkMoveResult(null);
  }

  function selectVisibleDocuments() {
    if (bulkMoving) return;
    setSelectedDocumentIds(visibleDocuments.map(doc => String(doc.id)));
    setBulkMoveResult(null);
  }

  function clearDocumentSelection() {
    if (bulkMoving) return;
    setSelectedDocumentIds([]);
    setBulkMoveResult(null);
  }

  function clearDocumentDrag() {
    setDraggedDocumentId('');
    setDragOverFolderId('');
  }

  function visibleDragDocuments(documentId) {
    if (selectedFolder === 'archived' || canManage !== true || clientMode !== false) return [];
    const id = String(documentId || '');
    const draggedDocument = visibleDocuments.find(doc => String(doc.id) === id);
    if (!draggedDocument) return [];
    const selectedIds = new Set(selectedDocumentIds.map(String));
    return selectedIds.has(id)
      ? visibleDocuments.filter(doc => selectedIds.has(String(doc.id)))
      : [draggedDocument];
  }

  function supportedDropFolder(folder) {
    if (!folder || folder.id === 'all' || folder.id === 'archived') return false;
    return folder.id === 'uncategorised'
      || realFolders.some(realFolder => String(realFolder.id) === String(folder.id));
  }

  async function moveDocumentSnapshot(documentSnapshot, destinationFolderId) {
    if (bulkMoving || selectedFolder === 'archived' || canManage !== true || clientMode !== false || !documentSnapshot.length) return;

    const visibleActiveIds = new Set(visibleDocuments.map(doc => String(doc.id)));
    const safeSnapshot = documentSnapshot.filter(doc => visibleActiveIds.has(String(doc.id)));
    if (!safeSnapshot.length) return;
    const destinationLabel = folderOptions.find(folder => String(folder.id) === String(destinationFolderId))?.label || 'Uncategorised';
    const failures = [];
    let movedCount = 0;
    let skippedCount = 0;

    setBulkMoving(true);
    setBulkMoveResult(null);
    setBulkMoveProgress({ current: 0, total: safeSnapshot.length });

    try {
      for (let index = 0; index < safeSnapshot.length; index += 1) {
        const doc = safeSnapshot[index];
        setBulkMoveProgress({ current: index + 1, total: safeSnapshot.length });
        const currentFolderId = doc.folderId || 'uncategorised';
        if (String(currentFolderId) === String(destinationFolderId)) {
          skippedCount += 1;
          continue;
        }
        try {
          await moveDocument(doc.id, destinationFolderId);
          movedCount += 1;
        } catch (err) {
          failures.push({
            id: String(doc.id),
            name: documentLabel(doc),
            message: err.message || 'Unable to move this document.',
          });
        }
      }

      const reloaded = await load();
      const reloadedVisibleIds = new Set(
        reloaded
          ? filterDocumentsBySearch(
            documentsForView(reloaded.activeDocuments, [], selectedFolder),
            documentSearch,
            clientMode,
          ).map(doc => String(doc.id))
          : visibleActiveIds,
      );
      setSelectedDocumentIds(
        failures.length
          ? failures.map(failure => failure.id).filter(id => reloadedVisibleIds.has(id))
          : [],
      );
      setBulkMoveResult({
        destinationLabel,
        movedCount,
        skippedCount,
        failures,
      });
    } finally {
      setBulkMoving(false);
    }
  }

  async function moveSelectedDocuments(event) {
    event.preventDefault();
    if (bulkMoving || selectedFolder === 'archived' || canManage !== true || clientMode !== false) return;

    const selectedIds = new Set(selectedDocumentIds.map(String));
    const selectedSnapshot = visibleDocuments.filter(doc => selectedIds.has(String(doc.id)));
    if (!selectedSnapshot.length) {
      setSelectedDocumentIds([]);
      return;
    }

    await moveDocumentSnapshot(selectedSnapshot, bulkMoveDestination || 'uncategorised');
  }

  function startDocumentDrag(event, doc) {
    if (!nativeDragEnabled || bulkMoving || selectedFolder === 'archived' || canManage !== true || clientMode !== false) {
      event.preventDefault();
      clearDocumentDrag();
      return;
    }
    if (event.target instanceof Element && event.target.closest(INTERACTIVE_DRAG_SELECTOR)) {
      event.preventDefault();
      clearDocumentDrag();
      return;
    }
    const documentId = String(doc.id);
    if (!visibleDragDocuments(documentId).length) {
      event.preventDefault();
      clearDocumentDrag();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, documentId);
    setDraggedDocumentId(documentId);
    setDragOverFolderId('');
    setBulkMoveResult(null);
  }

  function dragOverFolder(event, folder) {
    if (!nativeDragEnabled || bulkMoving || !draggedDocumentId || !supportedDropFolder(folder)) return;
    if (!visibleDragDocuments(draggedDocumentId).length) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverFolderId(String(folder.id));
  }

  function leaveDropFolder(event, folder) {
    if (String(dragOverFolderId) !== String(folder.id)) return;
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDragOverFolderId('');
  }

  async function dropDocumentsOnFolder(event, folder) {
    const transferredDocumentId = event.dataTransfer.getData(DOCUMENT_DRAG_TYPE);
    const documentSnapshot = visibleDragDocuments(transferredDocumentId);
    const validDrop = nativeDragEnabled
      && !bulkMoving
      && supportedDropFolder(folder)
      && transferredDocumentId
      && String(transferredDocumentId) === String(draggedDocumentId)
      && documentSnapshot.length > 0;
    if (validDrop) {
      event.preventDefault();
      event.stopPropagation();
    }
    clearDocumentDrag();
    if (!validDrop) return;
    await moveDocumentSnapshot(documentSnapshot, folder.id || 'uncategorised');
  }

  async function restoreDoc(doc) {
    try {
      await restoreDocument(doc.id);
      notify?.({ type: 'success', message: 'Document restored to active matter documents.' });
      await load();
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
  }

  async function downloadDoc(doc) {
    try {
      await downloadWithAuth(`/api/documents/${doc.id}/download`, documentLabel(doc));
    } catch (err) {
      notify?.({ type: 'danger', message: err.message });
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

  async function openPreview(doc) {
    const kind = documentPreviewKind(doc);
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    revokePreviewUrl();
    setPreview({
      doc,
      kind,
      status: kind ? 'loading' : 'unsupported',
      url: '',
      error: '',
    });
    if (!kind) return;

    try {
      const bytes = await fetchDocumentArrayBuffer(doc.id);
      if (previewRequestRef.current !== requestId) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: previewMimeType(doc, kind) }));
      if (previewRequestRef.current !== requestId) {
        URL.revokeObjectURL(url);
        return;
      }
      previewUrlRef.current = url;
      setPreview(current => current?.doc.id === doc.id
        ? { ...current, status: 'ready', url }
        : current);
    } catch (err) {
      if (previewRequestRef.current !== requestId) return;
      setPreview(current => current?.doc.id === doc.id
        ? { ...current, status: 'error', error: err.message || 'Unable to preview this document.' }
        : current);
    }
  }

  const folderHierarchy = useMemo(
    () => deriveActiveFolderHierarchy(folders),
    [folders],
  );
  const realFolders = folderHierarchy.folders;
  const clientUploadsFolder = realFolders.find(isClientUploadsFolder);
  const customFolders = realFolders.filter(folder => !isClientUploadsFolder(folder));
  const allFolder = folders.find(folder => folder.id === 'all') || {
    id: 'all',
    name: 'All Documents',
    virtual: true,
  };
  const uncategorisedFolder = folders.find(folder => folder.id === 'uncategorised') || {
    id: 'uncategorised',
    name: 'Uncategorised',
    virtual: true,
  };
  const archivedFolder = {
    id: 'archived',
    name: 'Archived documents',
    virtual: true,
  };
  const virtualFolders = [
    allFolder,
    ...(!clientMode ? [uncategorisedFolder] : []),
    ...(canManage && !clientMode ? [archivedFolder] : []),
  ];
  const explorerFolders = [...virtualFolders, ...realFolders];
  const folderOptions = useMemo(() => [
    { id: 'uncategorised', name: 'Uncategorised', label: 'Uncategorised' },
    ...folderHierarchy.folders.map(folder => ({
      ...folder,
      label: folderPathLabel(folderHierarchy, folder),
    })),
  ], [folderHierarchy]);
  const creationParentOptions = useMemo(
    () => customFolders.map(folder => ({
      id: normalizeFolderId(folder.id),
      label: folderPathLabel(folderHierarchy, folder),
    })),
    [customFolders, folderHierarchy],
  );
  const visibleTreeFolders = useMemo(
    () => visibleHierarchyFolders(folderHierarchy, expandedFolderIds),
    [folderHierarchy, expandedFolderIds],
  );
  const selectedFolderInfo = explorerFolders.find(folder => String(folder.id) === String(selectedFolder)) || allFolder;
  const selectedName = selectedFolderInfo?.name || 'All documents';
  const folderCount = folder => {
    if (folder?.id === 'all') return activeDocuments.length;
    if (folder?.id === 'archived') return archivedDocuments.length;
    if (folder?.id === 'uncategorised') return activeDocuments.filter(doc => !doc.folderId || doc.folderId === 'uncategorised').length;
    return activeDocuments.filter(doc => String(doc.folderId || '') === String(folder?.id || '')).length;
  };
  const selectedCount = folderCount(selectedFolderInfo);
  const selectedIsClientUploads = isClientUploadsFolder(selectedFolderInfo);
  const selectedIsCustom = Boolean(
    selectedFolderInfo
    && !selectedFolderInfo.virtual
    && !selectedIsClientUploads
    && folderHierarchy.folderById.has(normalizeFolderId(selectedFolderInfo.id)),
  );
  const selectedCustomCount = selectedIsCustom ? folderCount(selectedFolderInfo) : 0;
  const selectedHasChildren = selectedIsCustom
    && (folderHierarchy.childrenByParentId.get(normalizeFolderId(selectedFolderInfo.id)) || []).length > 0;
  const selectedPath = selectedFolderInfo?.virtual
    ? []
    : (folderHierarchy.pathById.get(normalizeFolderId(selectedFolderInfo?.id)) || []);
  const selectedPathLabel = selectedPath.length ? selectedPath.map(folder => folder.name).join(' / ') : selectedName;
  const selectedBreadcrumb = selectedFolderInfo?.id === 'all'
    ? [allFolder]
    : selectedPath.length
      ? [allFolder, ...selectedPath]
      : [allFolder, selectedFolderInfo];
  const mobileBrowseParent = folderHierarchy.folderById.get(normalizeFolderId(mobileBrowseParentId));
  const mobileBrowsePath = mobileBrowseParent
    ? (folderHierarchy.pathById.get(normalizeFolderId(mobileBrowseParent.id)) || [])
    : [];
  const mobileLevelFolders = folderHierarchy.childrenByParentId.get(normalizeFolderId(mobileBrowseParentId)) || [];

  useEffect(() => {
    const allowedVirtual = new Set(virtualFolders.map(folder => String(folder.id)));
    if (!allowedVirtual.has(String(selectedFolder)) && !folderHierarchy.folderById.has(normalizeFolderId(selectedFolder))) {
      setSelectedFolder('all');
    }
  }, [selectedFolder, folderHierarchy, clientMode, canManage]);

  useEffect(() => {
    const selectedId = normalizeFolderId(selectedFolder);
    const path = folderHierarchy.pathById.get(selectedId);
    if (!path?.length) {
      if (compactFolderBrowser) setMobileBrowseParentId('');
      return;
    }
    const ancestorIds = path.slice(0, -1).map(folder => normalizeFolderId(folder.id));
    setExpandedFolderIds(current => {
      if (ancestorIds.every(id => current.has(id))) return current;
      return new Set([...current, ...ancestorIds]);
    });
    setTreeFocusId(selectedId);
    if (compactFolderBrowser) {
      setMobileBrowseParentId(normalizeFolderId(path.at(-2)?.id));
    }
  }, [selectedFolder, folderHierarchy, compactFolderBrowser]);

  useEffect(() => {
    const selected = folderHierarchy.folderById.get(normalizeFolderId(selectedFolder));
    setNewFolderParentId(selected && !isClientUploadsFolder(selected) ? normalizeFolderId(selected.id) : '');
  }, [selectedFolder, matterId, folderHierarchy]);

  useEffect(() => {
    if (mobileBrowseParentId && !folderHierarchy.folderById.has(normalizeFolderId(mobileBrowseParentId))) {
      setMobileBrowseParentId('');
    }
  }, [mobileBrowseParentId, folderHierarchy]);

  useEffect(() => {
    const visibleIds = new Set(visibleTreeFolders.map(folder => normalizeFolderId(folder.id)));
    if (!treeFocusId || !visibleIds.has(normalizeFolderId(treeFocusId))) {
      setTreeFocusId(normalizeFolderId(visibleTreeFolders[0]?.id));
    }
  }, [treeFocusId, visibleTreeFolders]);

  function toggleFolderExpansion(folderId, force) {
    const id = normalizeFolderId(folderId);
    if (!(folderHierarchy.childrenByParentId.get(id) || []).length) return;
    const shouldExpand = force === undefined ? !expandedFolderIds.has(id) : force;
    if (!shouldExpand) {
      const selectedPathIds = selectedPath.map(folder => normalizeFolderId(folder.id));
      if (normalizeFolderId(selectedFolder) !== id && selectedPathIds.includes(id)) {
        setSelectedFolder(id);
      }
    }
    setExpandedFolderIds(current => {
      const next = new Set(current);
      if (shouldExpand) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function focusTreeFolder(folderId) {
    const id = normalizeFolderId(folderId);
    if (!id) return;
    setTreeFocusId(id);
    requestAnimationFrame(() => {
      const item = Array.from(folderTreeRef.current?.querySelectorAll('[role="treeitem"]') || [])
        .find(node => node.dataset.folderId === id);
      item?.focus();
    });
  }

  function handleFolderTreeKeyDown(event, folder) {
    const id = normalizeFolderId(folder.id);
    const index = visibleTreeFolders.findIndex(item => normalizeFolderId(item.id) === id);
    const children = folderHierarchy.childrenByParentId.get(id) || [];
    const parentId = normalizeFolderId(folder.parentId);
    let target;
    if (event.key === 'ArrowDown') target = visibleTreeFolders[Math.min(index + 1, visibleTreeFolders.length - 1)];
    if (event.key === 'ArrowUp') target = visibleTreeFolders[Math.max(index - 1, 0)];
    if (event.key === 'Home') target = visibleTreeFolders[0];
    if (event.key === 'End') target = visibleTreeFolders.at(-1);
    if (event.key === 'ArrowRight' && children.length) {
      if (!expandedFolderIds.has(id)) toggleFolderExpansion(id, true);
      else target = children[0];
    }
    if (event.key === 'ArrowLeft') {
      if (children.length && expandedFolderIds.has(id)) toggleFolderExpansion(id, false);
      else if (parentId) target = folderHierarchy.folderById.get(parentId);
    }
    if (event.key === 'Enter' || event.key === ' ') {
      setSelectedFolder(id);
    }
    if (target || ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (target) focusTreeFolder(target.id);
    }
  }
  const visibleDocuments = useMemo(
    () => filterDocumentsBySearch(documents, documentSearch, clientMode),
    [documents, documentSearch, clientMode],
  );

  const filteredTemplates = useMemo(() => {
    const q = templateSearch.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(t => (t.name || t.title || '').toLowerCase().includes(q));
  }, [templates, templateSearch]);

  const selectTemplates = useMemo(() => {
    if (!templateSearch.trim() || !templates.length) return templates;
    const hasSelected = filteredTemplates.some(t => String(t.id) === String(selectedTemplateId));
    if (hasSelected) return filteredTemplates;
    const sel = templates.find(t => String(t.id) === String(selectedTemplateId));
    return sel ? [sel, ...filteredTemplates] : filteredTemplates;
  }, [filteredTemplates, templates, selectedTemplateId, templateSearch]);
  const archivedView = selectedFolder === 'archived';
  const folderLifecycleMutationPending = archiveRequestPending || Boolean(restoreRequestPendingFolderId);
  const showArchiveFolderAction = canManage === true
    && clientMode === false
    && selectedIsCustom
    && !archivedView
    && !renameSaving
    && !folderLifecycleMutationPending;
  const showBulkControls = canManage === true && clientMode === false && !archivedView;
  const visibleDocumentIds = useMemo(() => new Set(visibleDocuments.map(doc => String(doc.id))), [visibleDocuments]);
  const selectedVisibleCount = selectedDocumentIds.filter(id => visibleDocumentIds.has(String(id))).length;
  const showUploadControls = !archivedView && (clientMode || canManage);
  const showFolderControls = true;
  const documentCardHint = clientMode
    ? 'Client uploads are placed in Client Uploads automatically.'
    : archivedView ? 'Restore archived files to active matter documents.' : 'Browse, upload, move, and manage matter files.';
  const uploadDestination = clientMode
    ? (folderPathLabel(folderHierarchy, clientUploadsFolder) || 'Client Uploads')
    : selectedFolder === 'all' || selectedFolder === 'archived'
      ? 'Uncategorised'
      : selectedFolderInfo?.virtual ? selectedName : selectedPathLabel;
  const folderDescription = archivedView
    ? 'Archived records are retained safely and can be restored.'
    : selectedFolder === 'all'
      ? 'Every active document linked to this matter.'
      : selectedFolder === 'uncategorised'
        ? 'Active documents that have not been assigned to a custom folder.'
        : selectedIsClientUploads
          ? 'Documents supplied through the client upload workflow.'
          : 'Documents filed in this custom matter folder.';
  const archiveConfirmation = archiveConfirmTarget ? {
    title: 'Archive folder',
    message: (
      <span>
        Archive “{archiveConfirmTarget.name}”? The folder will leave the active folder list. Its documents will not be archived, moved, or deleted and will remain visible in All Documents under this folder name. Document access and client visibility remain unchanged. You can restore the folder later from Archived folders.
        {archiveRequestPending && <strong style={{ display: 'block', marginTop: 8 }}>Archiving…</strong>}
      </span>
    ),
    onConfirm: submitArchiveFolder,
  } : null;

  return (
    <>
    <style>{`
      .lf-doc-grid section { border-color: #DDD8CE !important; }
      .lf-doc-grid .lf-doc-table-wrap > div { border-color: #DDD8CE !important; }
      .lf-doc-upload-area, .lf-doc-generate-area { background: #FAF8F4; border: 1px solid #DDD8CE; border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
      .lf-doc-upload-area { border-style: dashed; border-color: #C9BFAF; box-shadow: 0 1px 2px rgba(17,34,25,.04); }
      .lf-doc-upload-area:focus-within { border-color: #C5973C; box-shadow: 0 0 0 3px rgba(197,151,60,.14); }
      .lf-doc-secondary-tools > summary { cursor: pointer; color: #234936; font-size: 13px; font-weight: 700; padding: 11px 0; }
      .lf-doc-secondary-tools[open] > summary { margin-bottom: 8px; }
      .lf-doc-folder-button { width: 100%; text-align: left; }
      .lf-doc-folder-button:focus-visible { outline: 2px solid #C5973C; outline-offset: 2px; }
      .lf-doc-folder-button[data-document-drop-target="true"] { outline: 1px dashed #C5973C; outline-offset: 2px; }
      .lf-doc-folder-button[data-document-drop-active="true"] { background: #FFF7E6 !important; border-color: #C5973C !important; box-shadow: 0 0 0 3px rgba(197,151,60,.18); }
      .lf-doc-system-views { display: grid; gap: 6px; padding-bottom: 10px; border-bottom: 1px solid #DDD8CE; }
      .lf-doc-persistent-tree { display: grid; gap: 4px; margin-top: 10px; }
      .lf-doc-tree-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 7px; min-width: 0; }
      .lf-doc-tree-toggle { width: 16px; flex: 0 0 16px; text-align: center; color: #5F6B63; }
      .lf-doc-tree-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .lf-doc-mobile-browser { display: grid; gap: 8px; margin-top: 10px; }
      .lf-doc-mobile-location, .lf-doc-breadcrumb { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-width: 0; }
      .lf-doc-mobile-folder-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: stretch; min-width: 0; }
      .lf-doc-breadcrumb { margin-bottom: 10px; color: #69746C; font-size: 12px; }
      .lf-doc-breadcrumb button, .lf-doc-mobile-location button { border: 0; background: transparent; color: #234936; cursor: pointer; padding: 3px 2px; font: inherit; text-decoration: underline; text-underline-offset: 2px; }
      .lf-doc-breadcrumb [aria-current="page"] { color: #111827; font-weight: 700; overflow-wrap: anywhere; }
      .lf-doc-draggable-row { cursor: grab; }
      .lf-doc-dragging-row { opacity: .58; }
      .lf-doc-explorer { align-items: start; }
      .lf-doc-folder-pane { position: sticky; top: 12px; }
      .lf-doc-file-toolbar { background: #F7F5F0; border: 1px solid #DDD8CE; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
      .lf-doc-bulk-toolbar { background: #FFFCF5; border: 1px solid #E4D7B8; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; display: grid; gap: 8px; }
      .lf-doc-archived-folders > summary { cursor: pointer; color: #234936; font-size: 12px; font-weight: 700; line-height: 1.4; padding: 10px 2px; overflow-wrap: anywhere; }
      .lf-doc-archived-folder-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; min-width: 0; }
      @media (max-width: 640px) {
        .lf-doc-grid { grid-template-columns: minmax(0, 1fr) !important; }
        .lf-doc-folder-pane { position: static; }
        .lf-doc-folder-archive-action, .lf-doc-archived-folder-restore, .lf-doc-mobile-folder-open, .lf-doc-mobile-back { min-height: 44px; }
        .lf-doc-breadcrumb button, .lf-doc-mobile-location button { min-height: 36px; }
      }
    `}</style>
    <div className="lf-doc-grid lf-doc-explorer" style={{ display: 'grid', gridTemplateColumns: showFolderControls ? '240px minmax(0,1fr)' : 'minmax(0,1fr)', gap: 16 }}>
      {showFolderControls && <div className="lf-doc-folder-pane"><Card title="Folders" hint="Matter file cabinet">
        <div className="lf-doc-system-views" aria-label="Document views">
          {virtualFolders.map(folder => (
            <div key={folder.id}>
              <button
                className="lf-doc-folder-button"
                type="button"
                aria-pressed={String(selectedFolder) === String(folder.id)}
                data-folder-kind="virtual"
                data-document-drop-target={draggedDocumentId && supportedDropFolder(folder) ? 'true' : undefined}
                data-document-drop-active={String(dragOverFolderId) === String(folder.id) ? 'true' : undefined}
                style={{ ...styles.matterButton, ...(String(selectedFolder) === String(folder.id) ? styles.matterActive : {}), padding: '9px 8px' }}
                onClick={() => setSelectedFolder(folder.id)}
                onDragEnter={event => dragOverFolder(event, folder)}
                onDragOver={event => dragOverFolder(event, folder)}
                onDragLeave={event => leaveDropFolder(event, folder)}
                onDrop={event => dropDocumentsOnFolder(event, folder)}
              >
                <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <strong>{folderIcon(folder)} {folder.name}</strong>
                  <span style={{ ...styles.badge, minWidth: 24, justifyContent: 'center', background: String(selectedFolder) === String(folder.id) ? '#fff' : '#F1EEE7', color: theme.ink }}>
                    {folderCount(folder)}
                  </span>
                </span>
              </button>
            </div>
          ))}
        </div>
        {!compactFolderBrowser ? (
          <div ref={folderTreeRef} className="lf-doc-persistent-tree" role="tree" aria-label="Matter folders">
            {visibleTreeFolders.map(folder => {
              const folderId = normalizeFolderId(folder.id);
              const children = folderHierarchy.childrenByParentId.get(folderId) || [];
              const siblings = folderHierarchy.childrenByParentId.get(normalizeFolderId(folder.parentId)) || [];
              const expanded = children.length > 0 && expandedFolderIds.has(folderId);
              const selected = normalizeFolderId(selectedFolder) === folderId;
              return (
                <button
                  key={folderId}
                  className="lf-doc-folder-button lf-doc-tree-item"
                  type="button"
                  role="treeitem"
                  aria-level={folderHierarchy.depthById.get(folderId) || 1}
                  aria-posinset={siblings.findIndex(item => normalizeFolderId(item.id) === folderId) + 1}
                  aria-setsize={siblings.length}
                  aria-selected={selected}
                  aria-expanded={children.length ? expanded : undefined}
                  data-folder-id={folderId}
                  data-folder-path={folderPathLabel(folderHierarchy, folder)}
                  data-document-drop-target={draggedDocumentId && supportedDropFolder(folder) ? 'true' : undefined}
                  data-document-drop-active={String(dragOverFolderId) === folderId ? 'true' : undefined}
                  tabIndex={normalizeFolderId(treeFocusId) === folderId ? 0 : -1}
                  title={folderPathLabel(folderHierarchy, folder)}
                  style={{
                    ...styles.matterButton,
                    ...(selected ? styles.matterActive : {}),
                    padding: `9px 8px 9px ${8 + Math.min((folderHierarchy.depthById.get(folderId) - 1) * 14, 56)}px`,
                  }}
                  onFocus={() => setTreeFocusId(folderId)}
                  onKeyDown={event => handleFolderTreeKeyDown(event, folder)}
                  onClick={event => {
                    if (event.target.closest?.('[data-tree-toggle="true"]')) {
                      toggleFolderExpansion(folderId);
                      return;
                    }
                    setSelectedFolder(folderId);
                  }}
                  onDragEnter={event => dragOverFolder(event, folder)}
                  onDragOver={event => dragOverFolder(event, folder)}
                  onDragLeave={event => leaveDropFolder(event, folder)}
                  onDrop={event => dropDocumentsOnFolder(event, folder)}
                >
                  <span style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0 }}>
                    <span className="lf-doc-tree-toggle" data-tree-toggle={children.length ? 'true' : undefined} aria-hidden="true">
                      {children.length ? (expanded ? '▾' : '▸') : ''}
                    </span>
                    <strong className="lf-doc-tree-label">{folderIcon(folder)} {folder.name}</strong>
                  </span>
                  <span style={{ ...styles.badge, minWidth: 24, justifyContent: 'center', background: selected ? '#fff' : '#F1EEE7', color: theme.ink }}>
                    {folderCount(folder)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="lf-doc-mobile-browser">
            <div style={{ display: 'grid', gap: 5 }}>
              {mobileBrowseParent && (
                <button
                  className="lf-doc-mobile-back"
                  type="button"
                  style={{ ...styles.ghostButton, justifySelf: 'start' }}
                  onClick={() => setMobileBrowseParentId(normalizeFolderId(mobileBrowseParent.parentId))}
                >
                  ← Back
                </button>
              )}
              <nav className="lf-doc-mobile-location" aria-label="Folder browser location">
                <button type="button" onClick={() => setMobileBrowseParentId('')}>Root</button>
                {mobileBrowsePath.map((folder, index) => (
                  <span key={folder.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                    <span aria-hidden="true">/</span>
                    {index === mobileBrowsePath.length - 1
                      ? <strong aria-current="page" style={{ overflowWrap: 'anywhere' }}>{folder.name}</strong>
                      : <button type="button" onClick={() => setMobileBrowseParentId(normalizeFolderId(folder.id))}>{folder.name}</button>}
                  </span>
                ))}
              </nav>
            </div>
            <div style={{ display: 'grid', gap: 6 }} aria-label={mobileBrowseParent ? `Folders in ${folderPathLabel(folderHierarchy, mobileBrowseParent)}` : 'Top-level folders'}>
              {mobileLevelFolders.map(folder => {
                const folderId = normalizeFolderId(folder.id);
                const children = folderHierarchy.childrenByParentId.get(folderId) || [];
                const selected = normalizeFolderId(selectedFolder) === folderId;
                return (
                  <div className="lf-doc-mobile-folder-row" key={folderId} data-folder-path={folderPathLabel(folderHierarchy, folder)}>
                    <button
                      className="lf-doc-folder-button"
                      type="button"
                      aria-pressed={selected}
                      title={folderPathLabel(folderHierarchy, folder)}
                      style={{ ...styles.matterButton, ...(selected ? styles.matterActive : {}), padding: '9px 8px', minWidth: 0 }}
                      onClick={() => setSelectedFolder(folderId)}
                    >
                      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 7, alignItems: 'center', minWidth: 0 }}>
                        <strong className="lf-doc-tree-label">{folderIcon(folder)} {folder.name}</strong>
                        <span style={{ ...styles.badge, minWidth: 24, justifyContent: 'center', background: selected ? '#fff' : '#F1EEE7', color: theme.ink }}>{folderCount(folder)}</span>
                      </span>
                    </button>
                    {children.length > 0 && (
                      <button
                        className="lf-doc-mobile-folder-open"
                        type="button"
                        style={{ ...styles.ghostButton, minWidth: 44, padding: '8px 10px' }}
                        aria-label={`Open ${folder.name}`}
                        onClick={() => setMobileBrowseParentId(folderId)}
                      >
                        ›
                      </button>
                    )}
                  </div>
                );
              })}
              {!mobileLevelFolders.length && <span style={{ color: theme.muted, fontSize: 12 }}>No child folders here.</span>}
            </div>
          </div>
        )}
        {!clientMode && !customFolders.length && (
          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ color: theme.muted, fontSize: 12, lineHeight: 1.45, padding: '4px 2px' }}>
              No custom folders yet.
            </span>
          </div>
        )}
        {canManage === true && clientMode === false && (
          <details
            className="lf-doc-archived-folders"
            open={archivedFoldersOpen}
            onToggle={toggleArchivedFolders}
            style={{ borderTop: `1px solid ${theme.line}`, marginTop: 10, minWidth: 0 }}
          >
            <summary>Archived folders</summary>
            <div style={{ display: 'grid', gap: 8, padding: '0 2px 4px', minWidth: 0 }}>
              {archivedFoldersLoading && <span role="status" style={{ color: theme.muted, fontSize: 12 }}>Loading archived folders…</span>}
              {!archivedFoldersLoading && archivedFoldersError && (
                <div role="alert" style={{ display: 'grid', gap: 7, color: theme.red, fontSize: 12 }}>
                  <span>Unable to load archived folders: {archivedFoldersError}</span>
                  <button type="button" style={styles.ghostButton} onClick={() => loadArchivedFolders({ force: true })}>Retry</button>
                </div>
              )}
              {!archivedFoldersLoading && !archivedFoldersError && archivedFoldersRequested && !archivedFolders.length && (
                <span style={{ color: theme.muted, fontSize: 12, lineHeight: 1.45 }}>No archived folders.</span>
              )}
              {!archivedFoldersLoading && !archivedFoldersError && archivedFolders.map(folder => {
                const activeDocumentCount = activeDocuments.filter(doc => doc.folderId === folder.id).length;
                const restorePending = restoreRequestPendingFolderId === String(folder.id);
                const restoreError = folderMutationError?.action === 'restore' && folderMutationError.folderId === String(folder.id);
                return (
                  <div
                    className="lf-doc-archived-folder-row"
                    key={folder.id}
                    data-archived-folder-id={String(folder.id)}
                    style={{ border: `1px solid ${theme.line}`, borderRadius: 7, padding: 8 }}
                  >
                    <div style={{ display: 'grid', gap: 3, minWidth: 0, overflowWrap: 'anywhere' }}>
                      <strong style={{ color: theme.ink, fontSize: 12 }}>{folder.name}</strong>
                      <span style={{ color: theme.muted, fontSize: 11 }}>Archived {formatArchivedFolderDate(folder.archivedAt)}</span>
                      <span style={{ color: theme.muted, fontSize: 11 }}>{activeDocumentCount} active document{activeDocumentCount === 1 ? '' : 's'}</span>
                    </div>
                    <button
                      className="lf-doc-archived-folder-restore"
                      type="button"
                      style={{ ...styles.ghostButton, minHeight: 44 }}
                      disabled={Boolean(restoreRequestPendingFolderId) || archiveRequestPending}
                      onClick={() => submitRestoreFolder(folder)}
                    >
                      {restorePending ? 'Restoring…' : 'Restore'}
                    </button>
                    {restoreError && <span role="alert" style={{ gridColumn: '1 / -1', color: theme.red, fontSize: 11 }}>{folderMutationError.message}</span>}
                  </div>
                );
              })}
            </div>
          </details>
        )}
        {canManage === true && clientMode === false && (
          <form onSubmit={addFolder} style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            <Field label="Name for new folder">
              <input style={styles.input} value={newFolderName} onChange={e => setNewFolderName(e.target.value)} placeholder="Pleadings" />
            </Field>
            <Field label="Create in">
              <select style={styles.input} value={newFolderParentId} onChange={event => setNewFolderParentId(event.target.value)}>
                <option value="">Root (top level)</option>
                {creationParentOptions.map(folder => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
              </select>
            </Field>
            <button type="submit" style={styles.ghostButton} disabled={!newFolderName.trim()}>+ New Folder</button>
          </form>
        )}
        {canManage && !clientMode && (
          <div style={{ borderTop: `1px solid ${theme.line}`, marginTop: 12, paddingTop: 12, display: 'grid', gap: 8 }}>
            <strong style={{ fontSize: 12, color: theme.ink }}>Selected folder actions</strong>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <button type="button" style={styles.ghostButton} disabled={!selectedIsCustom || renameSaving || folderLifecycleMutationPending} onClick={() => beginRenameFolder(selectedFolderInfo)}>Rename</button>
              <button
                type="button"
                style={styles.ghostButton}
                disabled={!selectedIsCustom || selectedCustomCount > 0 || selectedHasChildren || renameSaving || folderLifecycleMutationPending}
                onClick={() => setConfirm({
                  title: 'Delete empty folder?',
                  message: 'Delete this empty custom folder?',
                  onConfirm: () => removeFolder(selectedFolderInfo),
                })}
              >
                Delete
              </button>
              {showArchiveFolderAction && (
                <button
                  className="lf-doc-folder-archive-action"
                  type="button"
                  style={{ ...styles.dangerButton, gridColumn: '1 / -1' }}
                  disabled={selectedHasChildren}
                  onClick={() => beginArchiveFolder(selectedFolderInfo)}
                >
                  Archive
                </button>
              )}
            </div>
            {folderMutationError?.action === 'archive' && (
              <span role="alert" style={{ color: theme.red, fontSize: 11 }}>{folderMutationError.message}</span>
            )}
            {renameFolderId === selectedFolderInfo?.id && (
              <form onSubmit={saveRenamedFolder} style={{ border: `1px solid ${theme.line}`, borderRadius: 7, background: '#F8FAFC', padding: 8, display: 'grid', gap: 7 }}>
                <label style={{ display: 'grid', gap: 4, color: theme.ink, fontSize: 11, fontWeight: 700 }}>
                  Folder name
                  <input
                    autoFocus
                    style={styles.input}
                    value={renameFolderName}
                    disabled={renameSaving}
                    onChange={event => {
                      setRenameFolderName(event.target.value);
                      if (renameError) setRenameError('');
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelRenameFolder();
                      }
                    }}
                    aria-invalid={Boolean(renameError)}
                    aria-describedby={renameError ? 'matter-folder-rename-error' : undefined}
                  />
                </label>
                {renameError && <span id="matter-folder-rename-error" role="alert" style={{ color: theme.red, fontSize: 11 }}>{renameError}</span>}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="submit" style={styles.primaryButton} disabled={renameSaving}>{renameSaving ? 'Saving…' : 'Save'}</button>
                  <button type="button" style={styles.ghostButton} disabled={renameSaving} onClick={cancelRenameFolder}>Cancel</button>
                </div>
              </form>
            )}
            <span style={{ color: theme.muted, fontSize: 11, lineHeight: 1.4 }}>
              {!selectedIsCustom
                ? selectedFolderInfo?.virtual || selectedIsClientUploads ? 'System folder' : 'Select a custom folder to rename'
                : selectedHasChildren ? 'Remove child folders before archiving or deleting this folder.'
                  : selectedCustomCount > 0 ? 'Only empty custom folders can be removed' : 'This empty custom folder can be renamed, archived, or removed.'}
            </span>
          </div>
        )}
      </Card></div>}

      <Card title={selectedName} hint={documentCardHint}>
        <div className="lf-doc-file-toolbar">
          <nav className="lf-doc-breadcrumb" aria-label="Folder breadcrumb">
            {selectedBreadcrumb.map((folder, index) => {
              const current = index === selectedBreadcrumb.length - 1;
              return (
                <span key={`${folder.id}-${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  {index > 0 && <span aria-hidden="true">/</span>}
                  {current
                    ? <span aria-current="page">{folder.name}</span>
                    : <button type="button" onClick={() => setSelectedFolder(folder.id)}>{folder.name}</button>}
                </span>
              );
            })}
          </nav>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
              <strong style={{ fontSize: 15, color: theme.ink }}>{selectedName}</strong>
              <span style={{ fontSize: 12, color: theme.muted, lineHeight: 1.45 }}>{folderDescription}</span>
            </div>
            <Badge tone={archivedView ? 'amber' : 'blue'}>{selectedCount} document{selectedCount === 1 ? '' : 's'}</Badge>
          </div>
          {!archivedView && (
            <div style={{ borderTop: `1px solid ${theme.line}`, marginTop: 10, paddingTop: 10, fontSize: 12, color: theme.muted }}>
              Uploads will be saved to: <strong style={{ color: theme.ink }}>{uploadDestination}</strong>
            </div>
          )}
          <div style={{ borderTop: `1px solid ${theme.line}`, marginTop: 10, paddingTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="search"
              value={documentSearch}
              onChange={event => setDocumentSearch(event.target.value)}
              placeholder="Search documents…"
              aria-label="Search documents in the current view"
              style={{ ...styles.input, flex: '1 1 220px', minWidth: 0 }}
            />
            {documentSearch.trim() && (
              <>
                <span style={{ color: theme.muted, fontSize: 11, whiteSpace: 'nowrap' }}>
                  Showing {visibleDocuments.length} of {documents.length}
                </span>
                <button type="button" style={styles.ghostButton} onClick={() => setDocumentSearch('')}>Clear search</button>
              </>
            )}
          </div>
        </div>
        {showBulkControls && (
          <div className="lf-doc-bulk-toolbar" aria-busy={bulkMoving}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" style={styles.ghostButton} disabled={bulkMoving || visibleDocuments.length === 0} onClick={selectVisibleDocuments}>Select visible</button>
              {selectedDocumentIds.length > 0 && (
                <button type="button" style={styles.ghostButton} disabled={bulkMoving} onClick={clearDocumentSelection}>Clear selection</button>
              )}
              <strong style={{ color: theme.ink, fontSize: 12 }} aria-live="polite">
                {selectedVisibleCount} selected
              </strong>
            </div>
            {nativeDragEnabled && (
              <span style={{ color: theme.muted, fontSize: 11 }}>You can also drag an active document row to Uncategorised, Client Uploads, or a custom folder.</span>
            )}
            {selectedVisibleCount > 0 && (
              <form onSubmit={moveSelectedDocuments} style={{ display: 'flex', alignItems: 'end', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ display: 'grid', gap: 4, flex: '1 1 180px', minWidth: 0, color: theme.muted, fontSize: 11, fontWeight: 700 }}>
                  Move selected to
                  <select
                    style={{ ...styles.tableSelect, width: '100%', minWidth: 0 }}
                    value={bulkMoveDestination}
                    onChange={event => setBulkMoveDestination(event.target.value)}
                    disabled={bulkMoving}
                  >
                    {folderOptions.map(folder => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
                  </select>
                </label>
                <button type="submit" style={styles.primaryButton} disabled={bulkMoving || selectedVisibleCount === 0}>
                  {bulkMoving ? `Moving ${bulkMoveProgress.current} of ${bulkMoveProgress.total}` : 'Move selected'}
                </button>
              </form>
            )}
            {bulkMoving && (
              <span role="status" style={{ color: theme.muted, fontSize: 12 }}>
                Moving {bulkMoveProgress.current} of {bulkMoveProgress.total}. Completed moves will be kept if another document fails.
              </span>
            )}
            {bulkMoveResult && (
              <div role="status" style={{ display: 'grid', gap: 5, color: theme.ink, fontSize: 12 }}>
                <strong>Move to {bulkMoveResult.destinationLabel}: {bulkMoveResult.movedCount} moved, {bulkMoveResult.skippedCount} already in destination, {bulkMoveResult.failures.length} failed.</strong>
                {bulkMoveResult.failures.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18, color: theme.red }}>
                    {bulkMoveResult.failures.map(failure => <li key={failure.id}>{failure.name}: {failure.message}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
        {showUploadControls && (
          <div className="lf-doc-upload-area">
            <div style={{ display: 'grid', gap: 5, marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                  <strong style={{ fontSize: 14, color: theme.ink }}>Upload matter document</strong>
                  <span style={{ fontSize: 12, color: theme.muted, lineHeight: 1.5 }}>
                    Add pleadings, correspondence, evidence, or client documents to this matter.
                  </span>
                </div>
                <span style={{ ...styles.badge, background: theme.goldPale, color: theme.goldDark, border: '1px solid #EAD7A8' }}>
                  {clientMode ? 'Client upload' : 'Matter file'}
                </span>
              </div>
              <span id="matter-document-upload-help" style={{ fontSize: 12, color: theme.muted, lineHeight: 1.45 }}>
                PDF, Word, and image files are supported. Maximum 25 MB. Selecting a file uploads it immediately.
              </span>
            </div>
            <div style={{ ...styles.formGrid }}>
              <Field label={clientMode ? 'Upload to Client Uploads' : 'Upload Document'}>
                <input style={styles.input} type="file" accept=".pdf,.doc,.docx,image/*" onChange={uploadDoc} aria-describedby="matter-document-upload-help matter-document-upload-status" />
              </Field>
            </div>
            <div id="matter-document-upload-status" aria-live="polite" style={{ marginTop: 10, borderTop: `1px solid ${theme.line}`, paddingTop: 10, display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: theme.muted }}>
              <span>Destination: <strong style={{ color: theme.ink }}>{uploadDestination}</strong></span>
              <span>
                {uploadStatus.fileName
                  ? <><strong style={{ color: uploadStatus.state === 'Upload failed' ? theme.red : theme.ink }}>{uploadStatus.state}:</strong> {uploadStatus.fileName}</>
                  : 'No file selected yet.'}
              </span>
            </div>
          </div>
        )}
        {!archivedView && showGenerateControls && (
          <details className="lf-doc-secondary-tools" style={{ background: theme.amberBg, border: '1px solid #DDD8CE', borderLeft: `3px solid ${theme.amber}`, borderRadius: 8, padding: '0 14px', marginBottom: 12 }}>
            <summary>Generate a draft from a template</summary>
          <div style={{ paddingBottom: 12 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, color: theme.muted, lineHeight: 1.5 }}>Choose a template, review the matter details, then generate a draft document.</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '2px 0' }}>
                {['1. Pick template', '2. Confirm matter details', '3. Generate and review'].map(step => (
                  <span key={step} style={{ background: '#FEF3C7', color: '#92400E', borderRadius: 4, padding: '3px 8px', fontSize: 11, fontWeight: 600 }}>{step}</span>
                ))}
              </div>
              {!templatesLoading && !templates.length && (
                <span style={{ fontSize: 12, color: theme.muted }}>Templates will appear here once created.</span>
              )}
            </div>
          </div>
          <div className="lf-doc-generate-area">
            <form onSubmit={generateDraft} style={{ display: 'grid', gap: 8 }}>
              {templates.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    type="search"
                    style={{ ...styles.input, flex: '1 1 160px', minWidth: 0 }}
                    placeholder="Find template…"
                    value={templateSearch}
                    onChange={e => setTemplateSearch(e.target.value)}
                    disabled={templatesLoading || generating}
                    aria-label="Filter templates by name"
                  />
                  <span style={{ fontSize: 11, color: theme.muted, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {templateSearch.trim()
                      ? `Showing ${filteredTemplates.length} of ${templates.length}`
                      : `${templates.length} template${templates.length !== 1 ? 's' : ''}`}
                  </span>
                </div>
              )}
              {templateSearch.trim() && filteredTemplates.length === 0 && (
                <span style={{ fontSize: 12, color: theme.muted, fontStyle: 'italic' }}>No templates match that search.</span>
              )}
              {templateSearch.trim() && Boolean(selectedTemplateId) && !filteredTemplates.some(t => String(t.id) === String(selectedTemplateId)) && filteredTemplates.length > 0 && (
                <span style={{ fontSize: 11, color: theme.muted }}>Current selection retained above filter results.</span>
              )}
              <div style={{ ...styles.formGrid, alignItems: 'end' }}>
                <Field label="Generate Draft">
                  <select style={styles.input} value={selectedTemplateId} onChange={e => setSelectedTemplateId(e.target.value)} disabled={templatesLoading || generating || !templates.length}>
                    {templates.length ? selectTemplates.map(template => (
                      <option key={template.id} value={template.id}>{template.name || template.title || 'Document template'}</option>
                    )) : <option value="">{templatesLoading ? 'Loading templates...' : 'No active templates'}</option>}
                  </select>
                </Field>
                <button type="submit" style={styles.primaryButton} disabled={!selectedTemplateId || generating || templatesLoading}>
                  {generating ? 'Generating...' : 'Generate draft'}
                </button>
              </div>
              {templateError && <div style={styles.alert}>Templates unavailable: {templateError}</div>}
              {generationMessage && <small style={{ color: theme.green }}>{generationMessage}</small>}
              {generationWarning && <small style={{ color: theme.amber }}>{generationWarning}</small>}
            </form>
          </div>
          </details>
        )}
        {loading ? <Skeleton rows={2} /> : visibleDocuments.length ? (
          <div className={canManage ? "lf-doc-cards-staff" : "lf-doc-cards-client"}>
          <div className="lf-doc-table-wrap">
          <Table
            columns={archivedView
              ? ['Name', 'Type', 'Folder', 'Date', 'Size', 'Source', 'Actions']
              : canManage
                ? [...(showBulkControls ? ['Select'] : []), 'Name', 'Type', ...(selectedFolder === 'all' ? ['Folder'] : []), 'Date', 'Size', 'Source', 'Client Access', 'Move', 'Actions']
                : ['Name', 'Folder', 'Date', 'Size', 'Source', 'Actions']}
            rows={visibleDocuments.map(doc => {
              const metaStyle = { color: theme.muted, fontSize: 12 };
              const documentFolderId = normalizeFolderId(doc.folderId) || 'uncategorised';
              const documentFolderPath = documentFolderId === 'uncategorised'
                ? 'Uncategorised'
                : (folderPathLabel(folderHierarchy, documentFolderId) || doc.folderName || 'Unavailable folder');
              const documentFolderIsDestination = folderOptions.some(folder => String(folder.id) === documentFolderId);
              const download = <button key={`${doc.id}-download`} type="button" style={{ ...styles.link, border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }} onClick={() => downloadDoc(doc)}>Download</button>;
              const previewAction = <button key={`${doc.id}-preview`} type="button" style={{ ...styles.link, border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }} onClick={() => openPreview(doc)}>Preview</button>;
              if (archivedView) return [
                <strong key={`${doc.id}-n`} style={{ fontWeight: 600 }}>{documentLabel(doc)}</strong>,
                <span key={`${doc.id}-t`} style={metaStyle}>{documentTypeLabel(doc)}</span>,
                <span key={`${doc.id}-f`} style={metaStyle}>{documentFolderPath}</span>,
                <span key={`${doc.id}-d`} style={metaStyle}>{doc.date || '-'}</span>,
                <span key={`${doc.id}-s`} style={metaStyle}>{doc.size || '-'}</span>,
                sourceBadge(doc, clientMode),
                <ActionGroup key={`${doc.id}-actions`} actions={[['Restore', () => setConfirm({
                  title: 'Restore document?',
                  message: 'Restore this document to active matter documents?',
                  onConfirm: () => restoreDoc(doc),
                })]]} />,
              ];
              if (!canManage) return [
                <strong key={`${doc.id}-n`} style={{ fontWeight: 600 }}>{documentLabel(doc)}</strong>,
                <span key={`${doc.id}-f`} style={metaStyle}>{documentFolderPath}</span>,
                <span key={`${doc.id}-d`} style={metaStyle}>{doc.date || '-'}</span>,
                <span key={`${doc.id}-s`} style={metaStyle}>{doc.size || '-'}</span>,
                sourceBadge(doc, clientMode),
                <span key={`${doc.id}-file-actions`} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{previewAction}{download}</span>,
              ];
              return [
                ...(showBulkControls ? [
                  <input
                    key={`${doc.id}-select`}
                    type="checkbox"
                    checked={selectedDocumentIds.includes(String(doc.id))}
                    disabled={bulkMoving}
                    onChange={() => toggleDocumentSelection(doc.id)}
                    aria-label={`Select ${documentLabel(doc)}`}
                  />,
                ] : []),
                <strong key={`${doc.id}-n`} style={{ fontWeight: 600 }}>{documentLabel(doc)}</strong>,
                <span key={`${doc.id}-t`} style={metaStyle}>{documentTypeLabel(doc)}</span>,
                ...(selectedFolder === 'all' ? [<span key={`${doc.id}-f`} style={metaStyle}>{documentFolderPath}</span>] : []),
                <span key={`${doc.id}-d`} style={metaStyle}>{doc.date || '-'}</span>,
                <span key={`${doc.id}-sz`} style={metaStyle}>{doc.size || '-'}</span>,
                sourceBadge(doc, clientMode),
                doc.source === 'client'
                  ? <Badge key={`${doc.id}-own`} tone="green">Client upload</Badge>
                  : <button key={`${doc.id}-share`} type="button" style={styles.tinyButton} onClick={() => toggleClientVisible(doc)}>{doc.clientVisible ? 'Shared' : 'Internal'}</button>,
                <select
                  key={`${doc.id}-move`}
                  style={styles.tableSelect}
                  value={documentFolderIsDestination ? documentFolderId : ''}
                  aria-label={`Move ${documentLabel(doc)} to folder`}
                  onChange={e => moveDoc(doc, e.target.value)}
                >
                  {!documentFolderIsDestination && <option value="" disabled>Current folder unavailable</option>}
                  {folderOptions.map(folder => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
                </select>,
                <ActionGroup key={`${doc.id}-actions`} actions={[['Preview', () => openPreview(doc)], ['Download', () => downloadDoc(doc)], ['Rename', () => beginRenameDocument(doc)], ['Archive', () => setConfirm({
                  title: 'Archive document?',
                  message: 'Archive removes this document from active matter documents. It does not permanently delete the record, and you can restore it later from Archived documents.',
                  onConfirm: () => archiveDoc(doc),
                })]]} />,
              ];
            })}
            rowProps={visibleDocuments.map(doc => {
              const draggable = nativeDragEnabled && showBulkControls && !bulkMoving;
              const dragging = String(draggedDocumentId) === String(doc.id);
              return {
                draggable,
                className: draggable ? `lf-doc-draggable-row${dragging ? ' lf-doc-dragging-row' : ''}` : undefined,
                onDragStart: draggable ? event => startDocumentDrag(event, doc) : undefined,
                onDragEnd: draggable ? clearDocumentDrag : undefined,
                'data-document-id': String(doc.id),
                'data-document-draggable': draggable ? 'true' : undefined,
              };
            })}
            empty="No documents."
          />
          </div>
          </div>
        ) : documents.length && documentSearch.trim() ? (
          <div style={{ ...styles.empty, alignItems: 'flex-start', textAlign: 'left' }}>
            <div style={styles.emptyIcon}>LF</div>
            <strong>No documents match this search in the current view.</strong>
            <span>Try a different name, file type, folder, source, or date.</span>
            <button type="button" style={styles.ghostButton} onClick={() => setDocumentSearch('')}>Clear search</button>
          </div>
        ) : (
          <div style={{ ...styles.empty, alignItems: 'flex-start', textAlign: 'left' }}>
            <div style={styles.emptyIcon}>LF</div>
            <strong>
              {archivedView
                ? 'No archived documents.'
                : selectedFolder === 'all'
                ? 'No documents uploaded yet.'
                : selectedFolder === 'uncategorised'
                  ? 'No uncategorised documents.'
                : selectedFolder === clientUploadsFolder?.id
                  ? 'No client uploads yet.'
                  : 'This folder is empty. Upload or move documents here.'}
            </strong>
            <span>
              {archivedView
                ? 'Archived documents will appear here and can be restored to active matter documents.'
                : selectedFolder === 'all'
                ? 'Upload a file, request one from the client, or use Document Studio. Documents saved here stay linked to this matter.'
                : selectedFolder === 'uncategorised'
                  ? 'Choose another folder or upload a document without selecting a custom folder.'
                  : selectedFolder === clientUploadsFolder?.id
                    ? 'Documents supplied through the client upload workflow will appear here.'
                    : 'Upload a new file here or move an existing matter document into this folder.'}
            </span>
            {!archivedView && !clientMode && canManage && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                <button type="button" style={styles.primaryButton} onClick={() => onChooseAction?.('upload')}>Upload document</button>
                <button type="button" style={styles.ghostButton} onClick={() => onChooseAction?.('request')}>Request document</button>
                <button type="button" style={styles.ghostButton} onClick={onOpenDocumentStudio}>Open Document Studio</button>
              </div>
            )}
          </div>
        )}
      </Card>
      {renameDocument && canManage && !clientMode && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="matter-document-rename-title"
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(17, 34, 25, 0.62)', padding: 16, display: 'grid', placeItems: 'center' }}
          onMouseDown={event => {
            if (event.target === event.currentTarget && !renameDocumentSaving) cancelRenameDocument();
          }}
        >
          <form onSubmit={saveRenamedDocument} style={{ width: 'min(100%, 420px)', background: theme.paper || '#fff', borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,.28)', padding: 16, display: 'grid', gap: 12 }}>
            <div>
              <strong id="matter-document-rename-title" style={{ display: 'block', color: theme.ink }}>Rename document</strong>
              <small style={{ color: theme.muted }}>This changes the display name only.</small>
            </div>
            <label style={{ display: 'grid', gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: theme.muted }}>Document name</span>
              <input
                autoFocus
                style={{ ...styles.input, width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                value={renameDocumentName}
                disabled={renameDocumentSaving}
                onChange={event => {
                  setRenameDocumentName(event.target.value);
                  if (renameDocumentError) setRenameDocumentError('');
                }}
                onKeyDown={event => {
                  if (event.key === 'Escape' && !renameDocumentSaving) cancelRenameDocument();
                }}
                aria-invalid={Boolean(renameDocumentError)}
                aria-describedby={renameDocumentError ? 'matter-document-rename-error' : 'matter-document-rename-help'}
              />
            </label>
            {renameDocumentError && <span id="matter-document-rename-error" role="alert" style={{ color: theme.red, fontSize: 12 }}>{renameDocumentError}</span>}
            {!renameDocumentError && (
              <span id="matter-document-rename-help" style={{ color: documentExtension(documentLabel(renameDocument)) && documentExtension(renameDocumentName) !== documentExtension(documentLabel(renameDocument)) ? theme.amber : theme.muted, fontSize: 12 }}>
                {documentExtension(documentLabel(renameDocument)) && documentExtension(renameDocumentName) !== documentExtension(documentLabel(renameDocument))
                  ? 'The file extension will appear to change. The stored file and file type will not be changed.'
                  : 'Maximum 180 characters.'}
              </span>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" style={styles.ghostButton} disabled={renameDocumentSaving} onClick={cancelRenameDocument}>Cancel</button>
              <button type="submit" style={styles.primaryButton} disabled={renameDocumentSaving}>{renameDocumentSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}
      {preview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="matter-document-preview-title"
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(17, 34, 25, 0.62)', padding: 16, display: 'grid', placeItems: 'center' }}
          onMouseDown={event => {
            if (event.target === event.currentTarget) closePreview();
          }}
        >
          <section style={{ width: 'min(100%, 1080px)', height: 'min(90vh, 820px)', background: theme.paper || '#fff', borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,.28)', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', overflow: 'hidden' }}>
            <header style={{ borderBottom: `1px solid ${theme.line}`, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <strong id="matter-document-preview-title" style={{ display: 'block', overflowWrap: 'anywhere' }}>{documentLabel(preview.doc)}</strong>
                <small style={{ color: theme.muted }}>{documentTypeLabel(preview.doc)}</small>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" style={styles.ghostButton} onClick={() => downloadDoc(preview.doc)}>Download</button>
                <button type="button" style={styles.primaryButton} onClick={closePreview}>Close</button>
              </div>
            </header>
            <div style={{ minHeight: 0, padding: 16, background: '#F4F1EB', display: 'grid', placeItems: 'center', overflow: 'auto' }}>
              {preview.status === 'loading' && <div role="status">Loading preview…</div>}
              {preview.status === 'unsupported' && (
                <div style={{ ...styles.empty, background: '#fff', maxWidth: 480 }}>
                  <strong>Preview not available for this file type.</strong>
                  <span>You can download the document to open it instead.</span>
                  <button type="button" style={styles.primaryButton} onClick={() => downloadDoc(preview.doc)}>Download</button>
                </div>
              )}
              {preview.status === 'error' && (
                <div style={{ ...styles.empty, background: '#fff', maxWidth: 480 }}>
                  <strong>Unable to preview this document.</strong>
                  <span>{preview.error || 'Use download instead.'}</span>
                  <button type="button" style={styles.primaryButton} onClick={() => downloadDoc(preview.doc)}>Use download instead</button>
                </div>
              )}
              {preview.status === 'ready' && preview.kind === 'pdf' && (
                <iframe title={`Preview of ${documentLabel(preview.doc)}`} src={preview.url} style={{ width: '100%', height: '100%', minHeight: 420, border: 0, background: '#fff' }} />
              )}
              {preview.status === 'ready' && preview.kind === 'image' && (
                <img src={preview.url} alt={`Preview of ${documentLabel(preview.doc)}`} style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              )}
            </div>
          </section>
        </div>
      )}
      <ConfirmModal confirm={archiveConfirmation || confirm} onClose={closeConfirm} />
    </div>
    </>
  );
}
