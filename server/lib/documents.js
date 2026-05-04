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

const MAX_NOTICE_ATTACHMENTS = 10;
const MAX_NOTICE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const allowedNoticeMimeTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'text/plain',
]);

function noticeMimeTypeFor(name = '', mimeType = '') {
  const lowerName = String(name || '').toLowerCase();
  const lowerMime = String(mimeType || '').toLowerCase();
  if (allowedNoticeMimeTypes.has(lowerMime)) return lowerMime;
  if (lowerName.endsWith('.pdf')) return 'application/pdf';
  if (lowerName.endsWith('.doc')) return 'application/msword';
  if (lowerName.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  if (lowerName.endsWith('.txt')) return 'text/plain';
  return lowerMime || 'application/octet-stream';
}

function decodeAttachmentData(attachment) {
  const raw = String(attachment?.data || '');
  const payload = (raw.includes(',') ? raw.split(',').pop() : raw).replace(/\s/g, '');
  if (!payload) {
    const err = new Error('Attachment data is required');
    err.statusCode = 400;
    throw err;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 === 1) {
    const err = new Error('Attachment data is not valid base64');
    err.statusCode = 400;
    throw err;
  }
  const buffer = Buffer.from(payload, 'base64');
  if (!buffer.length) {
    const err = new Error('Attachment is empty');
    err.statusCode = 400;
    throw err;
  }
  return buffer;
}

function prepareNoticeAttachments(input = []) {
  const attachments = Array.isArray(input) ? input.filter(Boolean) : [];
  if (attachments.length > MAX_NOTICE_ATTACHMENTS) {
    const err = new Error(`A notice can include up to ${MAX_NOTICE_ATTACHMENTS} attachments`);
    err.statusCode = 400;
    throw err;
  }
  return attachments.map(attachment => {
    if (!attachment?.name || !attachment?.data) {
      const err = new Error('Each attachment requires a name and data');
      err.statusCode = 400;
      throw err;
    }
    const cleanName = cleanDocumentName(attachment.name);
    const displayName = cleanDocumentName(attachment.displayName || attachment.name);
    const mimeType = noticeMimeTypeFor(cleanName, attachment.mimeType);
    if (!allowedNoticeMimeTypes.has(mimeType)) {
      const err = new Error('Notice attachments must be PDF, Word, image, or text files');
      err.statusCode = 400;
      throw err;
    }
    const buffer = decodeAttachmentData(attachment);
    if (buffer.length > MAX_NOTICE_ATTACHMENT_BYTES) {
      const err = new Error(`${displayName} is too large. Maximum notice attachment size is 10 MB`);
      err.statusCode = 400;
      throw err;
    }
    return {
      cleanName,
      displayName,
      mimeType,
      buffer,
      type: fileTypeFor(cleanName, mimeType),
      size: `${Math.max(1, Math.round(buffer.length / 1024))} KB`,
    };
  });
}

module.exports = {
  cleanDocumentName,
  fileTypeFor,
  documentListColumns,
  clientDocumentVisibilitySql,
  publicDocument,
  publicNotice,
  MAX_NOTICE_ATTACHMENTS,
  MAX_NOTICE_ATTACHMENT_BYTES,
  allowedNoticeMimeTypes,
  noticeMimeTypeFor,
  decodeAttachmentData,
  prepareNoticeAttachments,
};
