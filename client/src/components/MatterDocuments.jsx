import { useEffect, useMemo, useRef, useState } from 'react';
import { api, createFolder, deleteFolder, downloadWithAuth, fetchDocumentArrayBuffer, fileToDataUrl, generateDocumentFromTemplate, getMatterDocuments, getMatterFolders, listDocumentTemplates, moveDocument, restoreDocument, updateDocument, updateFolder } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { ActionGroup, Badge, Card, ConfirmModal, Field, Skeleton, Table } from './ui.jsx';

function folderIcon(folder) {
  if (folder.id === 'all') return 'ALL';
  if (folder.id === 'uncategorised') return 'UNC';
  if (folder.id === 'archived') return 'ARC';
  if ((folder.name || '').toLowerCase() === 'client uploads') return 'UP';
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

export default function MatterDocuments({ matterId, clientMode = false, canManage = false, notify, onChooseAction, onOpenDocumentStudio }) {
  const [folders, setFolders] = useState([]);
  const [activeDocuments, setActiveDocuments] = useState([]);
  const [archivedDocuments, setArchivedDocuments] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState('all');
  const [newFolderName, setNewFolderName] = useState('');
  const [renameFolderId, setRenameFolderId] = useState('');
  const [renameFolderName, setRenameFolderName] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
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
  const [uploadStatus, setUploadStatus] = useState({ fileName: '', state: '' });
  const [preview, setPreview] = useState(null);
  const previewUrlRef = useRef('');
  const previewRequestRef = useRef(0);

  const showGenerateControls = canManage === true && clientMode === false && Boolean(matterId);
  const documents = useMemo(() => {
    if (selectedFolder === 'archived') return archivedDocuments;
    if (selectedFolder === 'all') return activeDocuments;
    return activeDocuments.filter(doc => {
      if (selectedFolder === 'uncategorised') {
        return !doc.folderId || doc.folderId === 'uncategorised';
      }
      return String(doc.folderId || '') === String(selectedFolder);
    });
  }, [activeDocuments, archivedDocuments, selectedFolder]);

  useEffect(() => {
    if (matterId) load();
  }, [matterId]);

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
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
    finally { setLoading(false); }
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
    if (!newFolderName.trim()) return;
    try {
      const folder = await createFolder(matterId, { name: newFolderName });
      setNewFolderName('');
      setSelectedFolder(folder.id);
      notify?.({ type: 'success', message: 'Folder created.' });
      await load();
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

  async function uploadDoc(event) {
    const file = event.target.files?.[0];
    if (!file) {
      setUploadStatus({ fileName: '', state: '' });
      return;
    }
    setUploadStatus({ fileName: file.name, state: 'Uploading' });
    try {
      const targetFolderId = realFolders.some(folder => folder.id === selectedFolder)
        ? selectedFolder
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

  const realFolders = folders.filter(folder => !folder.virtual);
  const clientUploadsFolder = realFolders.find(folder => (folder.name || '').trim().toLowerCase() === 'client uploads');
  const customFolders = realFolders.filter(folder => folder.id !== clientUploadsFolder?.id);
  const explorerFolders = useMemo(() => {
    const all = folders.find(folder => folder.id === 'all') || {
      id: 'all',
      name: 'All documents',
      virtual: true,
      ...(selectedFolder === 'all' ? { documentCount: documents.length } : {}),
    };
    const uncategorised = folders.find(folder => folder.id === 'uncategorised') || {
      id: 'uncategorised',
      name: 'Uncategorised',
      virtual: true,
      ...(selectedFolder === 'uncategorised' ? { documentCount: documents.length } : {}),
    };
    const archived = {
      id: 'archived',
      name: 'Archived documents',
      virtual: true,
      ...(selectedFolder === 'archived' ? { documentCount: documents.length } : {}),
    };
    return [all, uncategorised, ...(clientUploadsFolder ? [clientUploadsFolder] : []), ...customFolders, ...(canManage && !clientMode ? [archived] : [])];
  }, [folders, clientUploadsFolder, customFolders, selectedFolder, documents.length, canManage, clientMode]);
  const folderOptions = useMemo(() => [{ id: 'uncategorised', name: 'Uncategorised' }, ...realFolders], [realFolders]);
  const selectedFolderInfo = explorerFolders.find(folder => folder.id === selectedFolder) || explorerFolders[0];
  const selectedName = selectedFolderInfo?.name || 'All documents';
  const folderCount = folder => {
    if (folder?.id === 'all') return activeDocuments.length;
    if (folder?.id === 'archived') return archivedDocuments.length;
    if (folder?.id === 'uncategorised') return activeDocuments.filter(doc => !doc.folderId || doc.folderId === 'uncategorised').length;
    return activeDocuments.filter(doc => String(doc.folderId || '') === String(folder?.id || '')).length;
  };
  const selectedCount = folderCount(selectedFolderInfo);
  const selectedIsClientUploads = selectedFolder === clientUploadsFolder?.id;
  const selectedIsCustom = Boolean(selectedFolderInfo && !selectedFolderInfo.virtual && !selectedIsClientUploads);
  const selectedCustomCount = selectedIsCustom ? folderCount(selectedFolderInfo) : 0;

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
  const showUploadControls = !archivedView && (clientMode || canManage);
  const showFolderControls = true;
  const documentCardHint = clientMode
    ? 'Client uploads are placed in Client Uploads automatically.'
    : archivedView ? 'Restore archived files to active matter documents.' : 'Browse, upload, move, and manage matter files.';
  const uploadDestination = clientMode
    ? 'Client Uploads'
    : selectedFolder === 'all' ? 'Uncategorised' : selectedName;
  const folderDescription = archivedView
    ? 'Archived records are retained safely and can be restored.'
    : selectedFolder === 'all'
      ? 'Every active document linked to this matter.'
      : selectedFolder === 'uncategorised'
        ? 'Active documents that have not been assigned to a custom folder.'
        : selectedIsClientUploads
          ? 'Documents supplied through the client upload workflow.'
          : 'Documents filed in this custom matter folder.';

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
      .lf-doc-explorer { align-items: start; }
      .lf-doc-folder-pane { position: sticky; top: 12px; }
      .lf-doc-file-toolbar { background: #F7F5F0; border: 1px solid #DDD8CE; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
      @media (max-width: 640px) {
        .lf-doc-grid { grid-template-columns: minmax(0, 1fr) !important; }
        .lf-doc-folder-pane { position: static; }
      }
    `}</style>
    <div className="lf-doc-grid lf-doc-explorer" style={{ display: 'grid', gridTemplateColumns: showFolderControls ? '240px minmax(0,1fr)' : 'minmax(0,1fr)', gap: 16 }}>
      {showFolderControls && <div className="lf-doc-folder-pane"><Card title="Folders" hint="Matter file cabinet">
        <div style={{ display: 'grid', gap: 6 }}>
          {explorerFolders.map(folder => (
            <div key={folder.id}>
              <button className="lf-doc-folder-button" type="button" aria-pressed={selectedFolder === folder.id} style={{ ...styles.matterButton, ...(selectedFolder === folder.id ? styles.matterActive : {}), padding: '9px 8px' }} onClick={() => setSelectedFolder(folder.id)}>
                <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <strong>{folderIcon(folder)} {folder.name}</strong>
                  <span style={{ ...styles.badge, minWidth: 24, justifyContent: 'center', background: selectedFolder === folder.id ? '#fff' : '#F1EEE7', color: theme.ink }}>
                    {folderCount(folder)}
                  </span>
                </span>
              </button>
            </div>
          ))}
          {!customFolders.length && (
            <span style={{ color: theme.muted, fontSize: 12, lineHeight: 1.45, padding: '4px 2px' }}>
              No custom folders yet.
            </span>
          )}
        </div>
        {canManage && (
          <form onSubmit={addFolder} style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            <Field label="New Folder"><input style={styles.input} value={newFolderName} onChange={e => setNewFolderName(e.target.value)} placeholder="Pleadings" /></Field>
            <button style={styles.ghostButton}>+ New Folder</button>
          </form>
        )}
        {canManage && !clientMode && (
          <div style={{ borderTop: `1px solid ${theme.line}`, marginTop: 12, paddingTop: 12, display: 'grid', gap: 8 }}>
            <strong style={{ fontSize: 12, color: theme.ink }}>Selected folder actions</strong>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <button type="button" style={styles.ghostButton} disabled={!selectedIsCustom || renameSaving} onClick={() => beginRenameFolder(selectedFolderInfo)}>Rename</button>
              <button
                type="button"
                style={styles.ghostButton}
                disabled={!selectedIsCustom || selectedCustomCount > 0 || renameSaving}
                onClick={() => setConfirm({
                  title: 'Delete empty folder?',
                  message: 'Delete this empty custom folder?',
                  onConfirm: () => removeFolder(selectedFolderInfo),
                })}
              >
                Delete
              </button>
            </div>
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
                : selectedCustomCount > 0 ? 'Only empty custom folders can be removed' : 'This empty custom folder can be renamed or removed.'}
            </span>
          </div>
        )}
      </Card></div>}

      <Card title={selectedName} hint={documentCardHint}>
        <div className="lf-doc-file-toolbar">
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
        </div>
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
        {loading ? <Skeleton rows={2} /> : documents.length ? (
          <div className={canManage ? "lf-doc-cards-staff" : "lf-doc-cards-client"}>
          <div className="lf-doc-table-wrap">
          <Table
            columns={archivedView
              ? ['Name', 'Type', 'Folder', 'Date', 'Size', 'Source', 'Actions']
              : canManage
                ? ['Name', 'Type', ...(selectedFolder === 'all' ? ['Folder'] : []), 'Date', 'Size', 'Source', 'Client Access', 'Move', 'Actions']
                : ['Name', 'Folder', 'Date', 'Size', 'Source', 'Actions']}
            rows={documents.map(doc => {
              const metaStyle = { color: theme.muted, fontSize: 12 };
              const download = <button key={`${doc.id}-download`} type="button" style={{ ...styles.link, border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }} onClick={() => downloadDoc(doc)}>Download</button>;
              const previewAction = <button key={`${doc.id}-preview`} type="button" style={{ ...styles.link, border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }} onClick={() => openPreview(doc)}>Preview</button>;
              if (archivedView) return [
                <strong key={`${doc.id}-n`} style={{ fontWeight: 600 }}>{documentLabel(doc)}</strong>,
                <span key={`${doc.id}-t`} style={metaStyle}>{documentTypeLabel(doc)}</span>,
                <span key={`${doc.id}-f`} style={metaStyle}>{doc.folderName || 'Uncategorised'}</span>,
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
                <span key={`${doc.id}-f`} style={metaStyle}>{doc.folderName || 'Uncategorised'}</span>,
                <span key={`${doc.id}-d`} style={metaStyle}>{doc.date || '-'}</span>,
                <span key={`${doc.id}-s`} style={metaStyle}>{doc.size || '-'}</span>,
                sourceBadge(doc, clientMode),
                <span key={`${doc.id}-file-actions`} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{previewAction}{download}</span>,
              ];
              return [
                <strong key={`${doc.id}-n`} style={{ fontWeight: 600 }}>{documentLabel(doc)}</strong>,
                <span key={`${doc.id}-t`} style={metaStyle}>{documentTypeLabel(doc)}</span>,
                ...(selectedFolder === 'all' ? [<span key={`${doc.id}-f`} style={metaStyle}>{doc.folderName || 'Uncategorised'}</span>] : []),
                <span key={`${doc.id}-d`} style={metaStyle}>{doc.date || '-'}</span>,
                <span key={`${doc.id}-sz`} style={metaStyle}>{doc.size || '-'}</span>,
                sourceBadge(doc, clientMode),
                doc.source === 'client'
                  ? <Badge key={`${doc.id}-own`} tone="green">Client upload</Badge>
                  : <button key={`${doc.id}-share`} type="button" style={styles.tinyButton} onClick={() => toggleClientVisible(doc)}>{doc.clientVisible ? 'Shared' : 'Internal'}</button>,
                <select key={`${doc.id}-move`} style={styles.tableSelect} value={doc.folderId || 'uncategorised'} onChange={e => moveDoc(doc, e.target.value)}>
                  {folderOptions.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                </select>,
                <ActionGroup key={`${doc.id}-actions`} actions={[['Preview', () => openPreview(doc)], ['Download', () => downloadDoc(doc)], ['Archive', () => setConfirm({
                  title: 'Archive document?',
                  message: 'Archive removes this document from active matter documents. It does not permanently delete the record, and you can restore it later from Archived documents.',
                  onConfirm: () => archiveDoc(doc),
                })]]} />,
              ];
            })}
            empty="No documents."
          />
          </div>
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
      <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
    </>
  );
}
