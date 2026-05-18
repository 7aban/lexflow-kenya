import { useEffect, useMemo, useState } from 'react';
import { api, createFolder, deleteFolder, downloadWithAuth, fileToDataUrl, generateDocumentFromTemplate, getMatterDocuments, getMatterFolders, listDocumentTemplates, moveDocument, updateDocument, updateFolder } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { ActionGroup, Badge, Card, ConfirmModal, Empty, Field, Table } from './ui.jsx';

function folderIcon(folder) {
  if (folder.id === 'all') return 'ALL';
  if (folder.id === 'uncategorised') return 'UNC';
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
  const client = doc.source === 'client';
  const generated = isGeneratedDocument(doc);
  return <Badge tone={client || generated ? 'amber' : 'blue'}>{documentSourceLabel(doc, clientMode)}</Badge>;
}

function documentLabel(doc) {
  return doc.displayName || doc.friendlyName || doc.name || 'Document';
}

export default function MatterDocuments({ matterId, clientMode = false, canManage = false, notify }) {
  const [folders, setFolders] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState('all');
  const [newFolderName, setNewFolderName] = useState('');
  const [uploadFolderId, setUploadFolderId] = useState('uncategorised');
  const [confirm, setConfirm] = useState(null);
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generationMessage, setGenerationMessage] = useState('');
  const [generationWarning, setGenerationWarning] = useState('');

  const showGenerateControls = canManage === true && clientMode === false && Boolean(matterId);

  useEffect(() => {
    if (matterId) load();
  }, [matterId, selectedFolder]);

  useEffect(() => {
    if (!showGenerateControls) {
      setTemplates([]);
      setSelectedTemplateId('');
      setTemplatesLoading(false);
      setTemplateError('');
      setGenerationMessage('');
      setGenerationWarning('');
      return;
    }
    loadTemplates();
  }, [showGenerateControls]);

  useEffect(() => {
    if (!clientMode && selectedFolder && selectedFolder !== 'all') setUploadFolderId(selectedFolder);
  }, [clientMode, selectedFolder]);

  async function load() {
    setLoading(true);
    try {
      const [nextFolders, docs] = await Promise.all([
        getMatterFolders(matterId),
        getMatterDocuments(matterId, selectedFolder),
      ]);
      setFolders(nextFolders);
      setDocuments(docs);
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

  async function renameFolder(folder) {
    const name = window.prompt('Rename folder', folder.name);
    if (!name || name === folder.name) return;
    try {
      await updateFolder(folder.id, { name });
      notify?.({ type: 'success', message: 'Folder renamed.' });
      await load();
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
  }

  async function removeFolder(folder) {
    try {
      await deleteFolder(folder.id);
      setSelectedFolder('all');
      notify?.({ type: 'success', message: 'Folder deleted.' });
      await load();
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
  }

  async function uploadDoc(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await api(`/matters/${matterId}/documents`, {
        method: 'POST',
        body: {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          data: await fileToDataUrl(file),
          folderId: clientMode ? undefined : uploadFolderId,
        },
      });
      event.target.value = '';
      notify?.({ type: 'success', message: clientMode ? 'Document shared with the firm.' : 'Document uploaded.' });
      await load();
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
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
        message: 'This document was generated as a draft. Confirm it has been reviewed before making it visible to the client.',
        onConfirm: () => updateClientVisible(doc, nextVisible),
      });
      return;
    }
    await updateClientVisible(doc, nextVisible);
  }

  async function deleteDoc(doc) {
    try {
      await api(`/documents/${doc.id}`, { method: 'DELETE' });
      notify?.({ type: 'success', message: 'Document deleted.' });
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

  const realFolders = folders.filter(folder => !folder.virtual);
  const folderOptions = useMemo(() => [{ id: 'uncategorised', name: 'Uncategorised' }, ...realFolders], [realFolders]);
  const selectedName = folders.find(folder => folder.id === selectedFolder)?.name || 'All Documents';
  const showUploadControls = clientMode || canManage;
  const documentCardHint = clientMode
    ? 'Client uploads are placed in Client Uploads automatically.'
    : canManage ? 'Upload, move and manage matter documents.' : 'View matter documents.';

  return (
    <div className="lf-doc-grid" style={{ display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', gap: 16 }}>
      <Card title="Folders" hint="Matter document categories">
        <div style={{ display: 'grid', gap: 6 }}>
          {folders.map(folder => (
            <div key={folder.id} style={{ display: 'grid', gridTemplateColumns: canManage && !folder.virtual ? '1fr auto' : '1fr', gap: 6, alignItems: 'center' }}>
              <button type="button" style={{ ...styles.matterButton, ...(selectedFolder === folder.id ? styles.matterActive : {}), padding: '9px 8px' }} onClick={() => setSelectedFolder(folder.id)}>
                <strong>{folderIcon(folder)} {folder.name}</strong>
                {folder.documentCount !== undefined && <small>{folder.documentCount} document(s)</small>}
              </button>
              {canManage && !folder.virtual && (
                <ActionGroup actions={[
                  ['Rename', () => renameFolder(folder)],
                  ['Delete', () => setConfirm({ title: 'Delete folder?', message: 'Delete this folder? It must be empty.', onConfirm: () => removeFolder(folder) })],
                ]} />
              )}
            </div>
          ))}
        </div>
        {canManage && (
          <form onSubmit={addFolder} style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            <Field label="New Folder"><input style={styles.input} value={newFolderName} onChange={e => setNewFolderName(e.target.value)} placeholder="Pleadings" /></Field>
            <button style={styles.ghostButton}>+ New Folder</button>
          </form>
        )}
      </Card>

      <Card title={selectedName} hint={documentCardHint}>
        {showUploadControls && (
          <div style={{ ...styles.formGrid, marginBottom: 14 }}>
            {!clientMode && (
              <Field label="Upload Folder">
                <select style={styles.input} value={uploadFolderId} onChange={e => setUploadFolderId(e.target.value)}>
                  {folderOptions.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                </select>
              </Field>
            )}
            <Field label={clientMode ? 'Upload to Client Uploads' : 'Upload Document'}>
              <input style={styles.input} type="file" accept=".pdf,.doc,.docx,image/*" onChange={uploadDoc} />
            </Field>
          </div>
        )}
        {showGenerateControls && (
          <form onSubmit={generateDraft} style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
            <div style={{ ...styles.formGrid, alignItems: 'end' }}>
              <Field label="Generate Draft">
                <select style={styles.input} value={selectedTemplateId} onChange={e => setSelectedTemplateId(e.target.value)} disabled={templatesLoading || generating || !templates.length}>
                  {templates.length ? templates.map(template => (
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
        )}
        {loading ? <div style={styles.alert}>Loading documents...</div> : documents.length ? (
          <div className={canManage ? "lf-doc-cards-staff" : "lf-doc-cards-client"}>
          <Table
            columns={canManage ? ['Name', 'Folder', 'Date', 'Size', 'Source', 'Client Access', 'Move', 'Actions'] : ['Name', 'Folder', 'Date', 'Size', 'Source', 'Download']}
            rows={documents.map(doc => {
              const download = <button key={`${doc.id}-download`} type="button" style={{ ...styles.link, border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }} onClick={() => downloadDoc(doc)}>Download</button>;
              if (!canManage) return [documentLabel(doc), doc.folderName || 'Uncategorised', doc.date || '-', doc.size || '-', sourceBadge(doc, clientMode), download];
              return [
                documentLabel(doc),
                doc.folderName || 'Uncategorised',
                doc.date || '-',
                doc.size || '-',
                sourceBadge(doc, clientMode),
                doc.source === 'client'
                  ? <Badge key={`${doc.id}-own`} tone="green">Client upload</Badge>
                  : <button key={`${doc.id}-share`} type="button" style={styles.tinyButton} onClick={() => toggleClientVisible(doc)}>{doc.clientVisible ? 'Shared' : 'Internal'}</button>,
                <select key={`${doc.id}-move`} style={styles.tableSelect} value={doc.folderId || 'uncategorised'} onChange={e => moveDoc(doc, e.target.value)}>
                  {folderOptions.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                </select>,
                <ActionGroup key={`${doc.id}-actions`} actions={[['Download', () => downloadDoc(doc)], ['Delete', () => setConfirm({ title: 'Delete document?', message: 'Delete this document?', onConfirm: () => deleteDoc(doc) })]]} />,
              ];
            })}
            empty="No documents."
          />
          </div>
        ) : <Empty title="This folder is empty" text="Documents uploaded or moved here will appear in this folder." />}
      </Card>
      <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
