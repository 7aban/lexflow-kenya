function cleanDocumentName(name = '') {
  return String(name || 'document').replace(/[^\w .-]/g, '_').slice(0, 180) || 'document';
}

function fileTypeFor(name = '', mimeType = '') {
  const lowerName = String(name || '').toLowerCase();
  const lowerMime = String(mimeType || '').toLowerCase();
  if (lowerMime.includes('pdf') || lowerName.endsWith('.pdf')) return 'PDF';
  if (lowerMime.includes('word') || lowerName.endsWith('.doc') || lowerName.endsWith('.docx')) return 'Word';
  if (lowerMime.startsWith('image/')) return 'Image';
  if (lowerMime === 'text/plain' || lowerName.endsWith('.txt')) return 'Text';
  return 'File';
}

function documentListColumns() {
  return `d.id,d.matterId,d.name,d.displayName,d.type,d.mimeType,d.date,d.size,d.source,d.folderId,d.messageId,d.noticeId,d.clientVisible,d.uploadedBy,f.name folderName`;
}

function clientDocumentVisibilitySql(alias = 'd') {
  return `(
    ${alias}.source='client'
    OR COALESCE(${alias}.clientVisible,0)=1
    OR EXISTS (
      SELECT 1
      FROM messages msg
      JOIN conversations conv ON conv.id=msg.conversationId
      WHERE msg.id=${alias}.messageId AND conv.clientId=?
    )
  )`;
}

function publicDocument(row = {}, options = {}) {
  const displayName = row.displayName || row.name || 'Document';
  if (options.client) {
    return {
      id: row.id,
      displayName,
      friendlyName: displayName,
      type: row.type || fileTypeFor(displayName, row.mimeType),
      mimeType: row.mimeType || 'application/octet-stream',
      date: row.date || '',
      size: row.size || '',
      sharedBy: row.source === 'client' ? 'Uploaded by you' : 'Shared by your advocate',
    };
  }
  return {
    ...row,
    displayName,
    friendlyName: displayName,
    sharedBy: row.source === 'client' ? 'Uploaded by you' : 'Shared by your advocate',
    content: undefined,
  };
}

function publicNotice(row = {}, attachments = [], req = {}) {
  const notice = {
    id: row.id,
    title: row.title || 'Notice',
    content: row.content || '',
    createdAt: row.createdAt || '',
    audience: row.clientId ? 'direct' : 'broadcast',
    attachments,
  };
  if (req.user?.role === 'client') return notice;
  return {
    ...row,
    clientName: row.clientName || '',
    audience: row.clientId ? 'direct' : 'broadcast',
    attachments,
  };
}

module.exports = {
  cleanDocumentName,
  fileTypeFor,
  documentListColumns,
  clientDocumentVisibilitySql,
  publicDocument,
  publicNotice,
};
