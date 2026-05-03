import { useEffect, useMemo, useState } from 'react';
import { API_BASE, api, createFolder, deleteFolder, fileToDataUrl, getMatterDocuments, getMatterFolders, moveDocument, readSession, updateDocument, updateFolder } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { ActionGroup, Badge, Card, ConfirmModal, Empty, Field, Table } from './ui.jsx';

function tokenQuery() {
  return encodeURIComponent(readSession()?.token || '');
}

function folderIcon(folder) {
  if (folder.id === 'all') return 'ALL';
  if (folder.id === 'uncategorised') return 'UNC';
  if ((folder.name || '').toLowerCase() === 'client uploads') return 'UP';
  return 'DIR';
}

function sourceBadge(doc, clientMode) {
  const client = doc.source === 'client';
  return <Badge tone={client ? 'amber' : 'blue'}>{clientMode && client ? 'Shared by you' : client ? 'Client' : 'Firm'}</Badge>;
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

  useEffect(() => {
    if (matterId) load();
  }, [matterId, selectedFolder]);

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

  async function toggleClientVisible(doc) {
    try {
      await updateDocument(doc.id, { clientVisible: !doc.clientVisible });
      notify?.({ type: 'success', message: doc.clientVisible ? 'Document hidden from client.' : 'Document shared with client.' });
      await load();
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
  }

  async function deleteDoc(doc) {
    try {
      await api(`/documents/${doc.id}`, { method: 'DELETE' });
      notify?.({ type: 'success', message: 'Document deleted.' });
      await load();
    } catch (err) { notify?.({ type: 'danger', message: err.message }); }
  }

  const realFolders = folders.filter(folder => !folder.virtual);
  const folderOptions = useMemo(() => [{ id: 'uncategorised', name: 'Uncategorised' }, ...realFolders], [realFolders]);
  const selectedName = folders.find(folder => folder.id === selectedFolder)?.name || 'All Documents';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', gap: 16 }}>
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

      <Card title={selectedName} hint={clientMode ? 'Client uploads are placed in Client Uploads automatically.' : 'Upload, move and manage matter documents.'}>
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
        {loading ? <div style={styles.alert}>Loading documents...</div> : documents.length ? (
          <Table
            columns={canManage ? ['Name', 'Folder', 'Date', 'Size', 'Source', 'Client Access', 'Move', 'Actions'] : ['Name', 'Folder', 'Date', 'Size', 'Source', 'Download']}
            rows={documents.map(doc => {
              const download = <a key={`${doc.id}-download`} style={styles.link} href={`${API_BASE}/documents/${doc.id}/download?token=${tokenQuery()}`}>Download</a>;
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
                <ActionGroup key={`${doc.id}-actions`} actions={[['Download', () => window.open(`${API_BASE}/documents/${doc.id}/download?token=${tokenQuery()}`, '_blank')], ['Delete', () => setConfirm({ title: 'Delete document?', message: 'Delete this document?', onConfirm: () => deleteDoc(doc) })]]} />,
              ];
            })}
            empty="No documents."
          />
        ) : <Empty title="This folder is empty" text="Documents uploaded or moved here will appear in this folder." />}
      </Card>
      <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
